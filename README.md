# dsh-semantica-graph

在 DSH Desktop 里看当前对话的**知识图谱**。

三件事各归各家，这一版是围绕这个分工重写的：

| 环节 | 谁做 | 怎么做的 |
| --- | --- | --- |
| **提取** | 模型 | 调用上游 `mcp__semantica__*` MCP 工具，把对话抽成实体/关系/决策写进图 |
| **展示** | 上游 semantica | 自带的 Knowledge Explorer（完整 Web 应用），插件把它内嵌在对话标签页里 |
| **分析** | 这个插件 | `src/kg.js` 里直接算：枢纽、社区、决策清单、时间线；不调 AI、不开新对话 |

为什么必须这么分：**对话内容只有模型手里有**，插件拿不到（去读会话日志也只是二手转录，
而且插件改不了 DSH 的 LLM 代码 —— 它就是个插件）。所以提取只能由模型按规则调 MCP 工具
完成；插件负责的是「告诉模型怎么写」，以及「把写出来的东西展示好、分析好」。

---

## 一、写入通道：一条 profile 配置 + 一段系统提示词

### 1.1 MCP 配置

`scripts/install.mjs` 会往 `profiles/web/cordis.patch.yml` 里幂等写入这一条（哨兵标记
圈定，标记之外一个字都不动）：

```yaml
- insert:
    - id: mcp-semantica
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: semantica
        transport: stdio
        command: '<harness>/semantica-venv/bin/semantica-mcp'
        env:
          SEMANTICA_KG_PATH: '<harness>/dsh-semantica-graph/kg.json'
        failOnStartupError: false
```

两个来自 `dsh-mcp-client` 的硬约束（不是这里的偏好）：

- 子进程环境**先被清洗**（删掉含 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 的变量和所有
  `DSH_*`），所以 `SEMANTICA_KG_PATH` 只能写死绝对路径，别指望继承父进程环境；
- 只桥接**工具**能力，MCP 的 resources / prompts 不会出现在 DSH 里。

没有这条配置，模型就没有 `mcp__semantica__*` 工具，图永远是空的 —— 面板会直接把这件事
写在脸上（黄色横幅）。`/api-semantica/status` 会扫 profile 判断配没配。

### 1.2 提示词：让每一次写入都带上「我在哪个会话」

MCP 那边是**一张全局图**、一个固定路径，`ctx` 里也拿不到按会话插值的环境变量。所以
「本对话」这一刀不可能按文件切 —— 只能按**写入时打的标**切。而打标要求模型知道自己在
哪个会话里：

```js
ctx.systemPrompt.section({ name: 'plugin:semantica-graph', order: 700, text: SECTION_TEXT })
ctx.systemPrompt.variable('semantica_conversation', (context) => context?.agent?.session?.header?.id)
```

段落正文里写 `{{semantica_conversation}}`，provider 每次组装提示词时求值成当前会话 id。
于是模型写图时照做：

```jsonc
add_entity(id, label, type, metadata = { "conversation": "<sessionId>" })
add_relationship(source, target, type, metadata = { "conversation": "<sessionId>" })
```

三件工具行为上的坑，都在提示词里明说了：

- **`record_decision` 不接受 `metadata`** —— 决策节点没法打标。所以指令要求它必须传
  `entities=[...]`，插件顺着 `involves` 边把决策认领回会话；
- **中文必须显式传 `model="zh_core_web_sm"`**，否则 spaCy 的英文模型会把整句当成一个实体；
- 图的归属靠标，标错了就切不出来，所以 `metadata` 的形状写得很死。

不想让每个会话都带这段提示词，可以在插件配置里关：`{ "injectPrompt": false }`
（面板上的「复制提取指令」按钮仍然可用，那段是渲染好的、带具体会话 id 的指令正文）。

---

## 二、怎么切出「本对话」这张图

`src/kg.js` 的 `scopeGraph()`，`mode: 'conversation'` 时：

1. 留下**打了本会话标**的节点和边；
2. **决策**走两条认领路：顺着 `involves` 边连到留下来的实体（首选），或者写入时间落在
   会话的活动窗口里（`createdAt` − 60s → 日志文件 mtime + 60s）；
3. 决策的附属节点（`category_*` / `maker_*`）跟着进来，否则 Explorer 里那条决策缺一块；
4. 归档节点（`properties.status === 'archived'`，`delete_node` 是软删）一律不进来。

切不干净的部分**如实报出来**，不假装没有：工具栏底下那行会写「本对话 N 个节点 ·
按实体边认领 N 条决策 · 按时间认领 N 条决策 · 图里还有 N 个节点没打会话标」。
`mode: 'all'` 就是整张图，什么都不切。

每张切好的图写成 `<harness>/dsh-semantica-graph/views/view-<key>.json`，再交给 Explorer。
`semantica.explorer --graph` 是**启动时读一次**，所以图变了就得重启那个子进程 ——
`ExplorerHost` 按 key 管实例（最多 3 个，闲置 10 分钟回收），点「刷新」就是重建一个。

---

## 三、展示：为什么内嵌上游 Explorer 而不是自己画

Explorer 有多个 workspace、78 个 `/api` 路由。自己画一张图画得出来，但功能上限会低一大截，
而且上游一升级就得跟着改。所以直接把它嵌进来：

- 子进程 `python -m semantica.explorer --graph <视图文件> --port <随机> --host 127.0.0.1 --no-browser`，
  只绑回环地址；依赖探测（`import semantica` + `fastapi`/`uvicorn`）失败时给一句人话，不猜；
- iframe 的 `sandbox` 是 `allow-scripts allow-forms allow-popups allow-downloads
  allow-modals allow-popups-to-escape-sandbox allow-same-origin`：
  - `allow-same-origin` **必须有**，否则 iframe 是 opaque origin，React SPA 起不来（白屏）；
  - 刻意**不含** `allow-top-navigation`，所以 Explorer 没法把主窗口导航走；
  - Explorer 在另一个端口上，跨源，拿不到 GUI 的 DOM / Cookie / 内部接口。

### iframe 为什么挂在 `document.body` 上

`conversation.view` 对非激活视图是**过滤掉**的，切走标签会真的卸载组件、连带销毁 iframe；
而 Explorer 每次重载都要从头启动。实测过两条路：

1. 「卸载前把 iframe 抢救到别处、回来再搬回去」—— **不行**。在 DOM 里 `appendChild` 搬动
   iframe 会让它**重新加载**（搬 4 次 = 加载 5 次），脱离文档就丢浏览上下文；
2. 「iframe 从头到尾待在同一个父节点里，宿主挂 `document.body`、只改 CSS」—— 行。累计
   load 次数恒为 1。

所以宿主常驻 `body`，靠 `position:fixed` 摆到视图里那个占位元素的位置上（没用 portal：
客户端半侧只能 `require("react")`，拿不到 react-dom）。代价是位置要自己同步
（`ResizeObserver` + `resize`/`scroll`），而且**不在图谱标签时必须隐藏**，否则这块 fixed
会盖住别的界面。

> 这套机制有回归测试：`scripts/visual-check.mjs` 里会卸载再挂载组件，断言 iframe 还是
> **同一个元素**（挂了个 `data-mark` 认身份）、宿主隐藏又恢复、并且整棵树只有一个 canvas
> 容器。**那个「只有一个 canvas」的断言是真抓出过 bug 的** —— 原来的写法里
> ExplorerFrame 又套了一层同名容器，内层是普通 block、内容全绝对定位，高度塌成 0，
> iframe 宿主跟着变成 0×0，图根本显示不出来。

---

## 四、分析：插件自己算

`analyze(nodes, edges)` 全部是朴素算法，因为这里要的是「一眼看出哪个实体是枢纽、有几个
社区」，不需要论文级精度，但必须**可解释**、必须毫秒级：

- **枢纽**：度数 + PageRank（幂迭代 20 轮，阻尼 0.85，悬空节点按均匀分配处理）
- **社区**：标签传播 10 轮（遍历顺序固定 → 多次运行结果一致）
- **连通分量**：并查集
- **决策**：清单（按时间倒序）+ 每条决策的关联实体（顺着 `involves` 边）
- **时间线**：决策按天分桶
- **概览**：节点/边/实体/关系/决策 + 类型分布 + 孤立节点

「实体」= 非决策附属的节点，「关系」= 非决策挂载的边 —— 按**语义**分，不按
`add_entity`/`add_relationship` 调用分。

面板上的分析抽屉是插件渲染的，数据来自 `/api-semantica/analysis`。

---

## 五、装上 / 卸下

```bash
node scripts/install.mjs            # 安装（改 profile 前会备份）
node scripts/install.mjs --dry-run  # 只打印要做什么
node scripts/install.mjs --remove   # 移除
```

前置：`<harness>/semantica-venv` 里装了 `semantica`（含 `semantica-mcp` 与
`semantica.explorer` 需要的 `fastapi`/`uvicorn`）。脚本找不到那个解释器会直说。
解释器位置也可以用 `DSH_SEMANTICA_PYTHON` 覆盖。

**改完 host 半侧（`src/index.js` 等）必须重启 DSH Desktop 才生效**；浏览器半侧
（`src/client.js`）是从源码加载的，改完刷新页面即可。

## 六、自检

```bash
npm run check      # 六个源文件过一遍 node --check
npm run selftest   # 离线全链路：造图 → 切图 → 分析 → 起真 Explorer → 假 ctx 跑真路由
npm run visual     # 真 Chromium：12px、iframe 宿主、窄窗口溢出、抽屉、空态
```

- `selftest` 不启动 DSH，也不需要真会话：用插件 venv 里的 semantica 造一张图（两个会话
  打标 + 一个没打标的实体 + 一条靠实体边归属的决策 + 一条只能靠时间认领的决策 + 一条
  30 天前的决策用来验窗口边界），然后直接调 `src/index.js` 注册出来的真路由 handler。
- `visual` 把 `src/client.js` 原样塞进一个真 Chromium 页面（配假的
  `window.__ModuleLoader__` 和三个假接口），**量**计算样式而不是看截图。

## 七、已知边界

- **决策靠时间窗口认领**时，同一时间窗里别的会话的决策可能被带进来 —— 所以认领数量
  在界面上明写，不藏着；模型按提示词传 `entities` 时走的是更准的实体边那条路。
- **没打标的节点**只出现在「全部」里，界面上会报数量。这类节点多半是老版本或没读提示词
  的模型写进去的。
- **MCP 的 resources / prompts 拿不到**（`dsh-mcp-client` 只桥工具），所以 `query_graph`
  之类只能由模型调，插件不能主动查图 —— 插件读的是图文件。
- **Explorer 是独立子进程**：同一个视图重复出图会重启它（`--graph` 只在启动时读一次）。
- 面板工具栏的统计是**切完图之后**的数字，「全部」模式看到的是整张图。

## 许可

MIT
