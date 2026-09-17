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

## 怎么用（日常）

一次性动作做完之后（第 5 节装了、重启了 DSH），日常就是聊天 + 看一眼。

**1. 正常聊天。** 插件在后台只做一件事：让每个会话的系统提示词里带上「本会话标识 +
写入规则」。所以模型随时知道自己在哪个会话、该往 `metadata.conversation` 里写什么。
你不需要为它改变说话方式。

**2. 想让模型每轮都写，就把「每轮提取」开关打开。**
插件在对话里只占**两处**：顶部标签里的「知识图谱」，和**输入框那一排右侧**的
`图谱提取 关 / 开` 开关（就在你打字的地方）。面板工具栏里还有一个同名开关，那是面板
自己的工具栏，切到图谱标签时（输入框被藏起来）用它。

**想让「每条新对话」一开始就自动提取**：面板工具栏里点一下 `新对话默认：关 → 开`
（它紧挨着 `每轮提取`，因为这两个是一对：前者管这个对话，后者管以后新开的对话）。
这一条是必需的，不是锦上添花 —— 新建对话在**发出第一条消息之前根本没有会话**，核心那排
标题/标签是会话级槽，那时候整排都不渲染，任何按会话的开关都点不到，只有默认值能提前设好。
默认值只影响「没被单独设过」的会话；在某个会话里点开关只改那个会话。

开关关着（默认）时，模型只在它自己判断值得记的时候写。打开之后：每一轮回复结束前，
模型都必须把这一轮的新知识写进图谱。**代价是每轮都会多几次 MCP 工具调用（多花 token）**，
所以默认不开；查资料、闲聊这种不产生知识的轮次它会跳过，插件也不会替它判断。

机制：它改的是**下一轮**的系统提示词（`semantica_directive` 这个变量每次组装提示词时
重新求值），所以点完立刻生效，不用重启、也不用再往对话里粘指令。**它替代的就是以前
那个「复制提取指令 → 粘进对话」的动作** —— 那个按钮还在（补写历史对话时还用得上），
但日常不需要了。

状态存在 `<harness>/dsh-semantica-graph/auto-extract.json`，两层：
`{ "default": false, "sessions": { "<会话 id>": { "on": true } } }`，
解析规则是 `sessions[id] ?? default`。

**图不是聊天记录的转录**，只是「值得以后复用的知识」。没说过、模型也没判断值得记的
对话，图里就是没有 —— 这是设计，不是故障。

**3. 看。** 对话顶部标签里的「**知识图谱**」—— 插件在对话里唯一的面板入口就是它。
进去以后：

| 界面元素 | 干什么用的 |
| --- | --- |
| 左侧大区 | 上游 semantica 的 Knowledge Explorer 本体：图/表/时间线等 workspace 都在里面 |
| `本对话` / `全部` | 默认只看这场对话写进去的；「全部」是这台机器上所有会话的合图，跨会话找关联用它 |
| 工具栏数字 | 节点/边/实体/关系/决策。注意是**切完之后**的数字 |
| `图谱提取 关/开` | 输入框那一排右侧的紧凑开关，开了之后每轮都写图（见上面第 2 条） |
| `每轮提取：关/开` | 同一个开关，出现在面板工具栏里 |
| `新对话默认：关/开` | 工具栏里的小开关，挨着 `每轮提取`：让**以后每条新对话一开始就**自动提取 |
| 图文件路径（等宽字样，如 `…/dsh-semantica-graph/kg.json`） | **点一下复制完整路径**（鼠标是 copy 光标，悬停 tooltip 里有全文） |

界面形状是定下来的（都有自检盯着，别顺手改回去）：

- 面板内容 16px 内边距；工具栏和 iframe 都是「1px 边框 + 8px 圆角」的卡片；
- **工具栏只有一行**：`图+统计  →  说明+路径  ┊  写图开关  ┊  操作`。
  路径属于「信息」那一组，和归属说明待在一起，不跟按钮混；两处小竖线分开的是
  「说明/路径」「开关」「操作」。
- 说明+路径那一组的基准宽度是 0（`flex:1 1 0`），空间不够时它先被压成省略号 ——
  带 `wrap` 的 flex 容器是先决定换行再压缩的，所以如果按内容尺寸参与排版，
  这一行会被顶成两行；
- 工具栏卡片到 iframe 的间距就是 root 那个 10px，中间不夹别的行。
| 数字下面那行 | 归属说明：本对话有多少节点、多少决策是按实体边认领的、图里还有多少节点没打标 |
| `刷新` | 重新读图并重建 Explorer（图变了才需要点，1～2 秒） |
| `分析` | 右侧抽屉：概览 / 枢纽 / 社区 / 决策 / 时间线。插件自己算的，不调 AI、不开新对话 |
| `在浏览器打开` | 把 Explorer 单独开一个标签页用（大屏或双屏时更舒服） |
| `复制提取指令` | 把这 4 条写入规则复制出来，粘进对话让模型补一次 |

**4. 常用话术**（直接对模型说）：

```text
把这对话写进知识图谱                          # 通用入口
把刚才定的方案记进图谱，决策也记一条          # 明确要决策
先查一下图谱里关于 vite 的内容，别重复建节点  # 让它先 query_graph
把图谱里过时的 vite 节点归档掉                # delete_node 是软删，可恢复
这场对话在图谱里记过了吗？                    # 让它查一下
```

模型能调的图谱工具不止「写」：`add_entity` / `add_relationship` / `update_node` /
`delete_node`（软删）/ `record_decision` / `query_graph` / `find_precedents` /
`get_causal_chain` / `get_graph_analytics` / `export_graph`。所以改、查、导都能直接说。
每次写操作立刻落盘，回面板点一下「刷新」就看得见。

**5. 出问题时对着这张表看**（面板上会把原因直接写出来）：

| 面板上看到 | 意思 / 怎么办 |
| --- | --- |
| 插件的 host 半侧还没加载 | 改过 host 代码（`src/index.js` 等）→ 实测 harness 一般会自动热重载；要是一直 404 就重启 DSH Desktop |
| 这台机器上还没有写过任何知识图谱 | 图还没建过 → 点「复制提取指令」粘给模型 |
| 本对话在图里还没有节点 | 这次对话还没被提取过 → 点输入框那一排的「图谱提取 关」，或者点「复制提取指令」当场补一次 |
| 图没打开：Explorer 没有响应 | 那个 Explorer 子进程已经死了或刚被回收（15 秒没加载出来就会这么写）→ 点「重试」 |
| 图里还是老内容 | Explorer 启动时只读一次图、前端还会沿用已有 iframe → 点「刷新」重建；改了切图规则的话 key 会变，重开面板就是新的 |
| 黄色横幅：MCP 工具没挂上 | profile 里那条 `mcp-semantica` 丢了 → `node scripts/install.mjs` 后重启 |
| Explorer 依赖不可用 | venv 里缺 `fastapi`/`uvicorn`，按提示装的路径检查 |

**6. 想要跨会话看东西**，切「全部」；想知道「这台机器一共记了什么」，也是「全部」。
图是**一台机器一份**（`<harness>/dsh-semantica-graph/kg.json`），不是每个会话一份 ——
删掉老会话不会删图里的内容。

**7. 嫌提示词占位置**：插件配置里 `{ "injectPrompt": false }` 可以关掉那段系统提示词，
之后就只能靠「复制提取指令」手动触发，或者干脆不用。这时「每轮提取」开关也不起作用
（它改的就是那段提示词）。

**8. 插件不碰会话标题那一排。** 标题旁边没有插件的按钮（曾经放过「打开知识图谱」和
同名开关，已经按用户要求去掉）—— 打开面板就点标签本身。

**9. 只想让某几个会话开着**：开关是**按会话**存的，新会话跟着「新对话默认」。
注意第一条消息之前没有会话，所以那时候看到的只能是默认值的行为 —— 想让新对话一开始
就自动提取，先把「新对话默认」设成开。

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
2. **决策**再认领一层：顺着 `involves` 边连到留下来的实体（`record_decision` 不收
   metadata，`entities` 是它唯一的归属信号）；
3. 决策的附属节点（`category_*` / `maker_*`）跟着进来，否则 Explorer 里那条决策缺一块；
4. 归档节点（`properties.status === 'archived'`，`delete_node` 是软删）一律不进来。

**这里曾经还有一条「时间窗兜底」：决策的写入时间落在这个会话的活动时间段里就认领它。
它已经删掉了 —— 因为它会认错人。** 一天里连着聊几个会话时，同一个没打标的决策会被
每一个「时间覆盖它」的会话同时认领，于是用户会看到「我根本没提取过的对话里，冒出了
别人的 6 个节点」。现在的取舍很明确：**宁可不认，不能认错** —— 认不出来的决策仍然在
「全部」里看得到，不会被藏起来。

切不干净的部分**如实报出来**，不假装没有：工具栏底下那行会写「本对话 N 个节点 ·
按实体边认领 N 条决策 · 图里还有 N 个节点没打会话标」。
`mode: 'all'` 就是整张图，什么都不切。

每张切好的图写成 `<harness>/dsh-semantica-graph/views/view-<key>.json`，再交给 Explorer。
`semantica.explorer --graph` 是**启动时读一次**，所以图变了就得重启那个子进程 ——
`ExplorerHost` 按 key 管实例（最多 3 个，闲置 10 分钟回收），点「刷新」就是重建一个。

**`<key>` 末尾带着切图规则的版本号**（`kg.js` 里的 `SCOPE_VERSION`）。这不是装饰：Explorer
只在启动时读图，前端切标签回来还会**沿用**已经建好的那个 iframe —— 所以「改了认领规则」
如果不换 key，用户重新点开面板看到的还是按旧规则切的图，会以为 bug 没修。规则一改就
把版本号 +1，旧视图与旧实例自然失效，下次打开必然是新的。（views 目录只留最近 12 份。）

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
  打标 + 一个没打标的实体 + 一条靠实体边归属的决策 + 一条**没有 entities、谁都不该认领**
  的决策 + 一条 30 天前的决策），然后直接调 `src/index.js` 注册出来的真路由 handler。
- `visual` 把 `src/client.js` 原样塞进一个真 Chromium 页面（配假的
  `window.__ModuleLoader__` 和三个假接口），**量**计算样式而不是看截图。

## 七、已知边界

- **没带 `entities` 的决策进不了「本对话」**（只出现在「全部」里）。这是刻意的：另一种
  做法（按时间猜）会把别的会话的决策算进来，用户已经踩过一次。模型按提示词传
  `entities` 时不受影响。
- **新建对话在发出第一条消息之前没有会话**（核心的标题/标签/输入框工具行都是会话级槽），
  所以那一刻任何按会话的开关都渲染不出来 —— 「每条新对话都自动提取」必须提前用
  「新对话默认」设好。
- **开关只能让模型「被要求」每轮写，不能强制它写。** 插件改不了模型的执行 —— 它能做的
  是把「每轮必须写」写进系统提示词。模型偶尔偷懒时，界面上表现为某一轮没写，而不是
  插件假造内容。
- **没打标的节点**只出现在「全部」里，界面上会报数量。这类节点多半是老版本或没读提示词
  的模型写进去的。
- **MCP 的 resources / prompts 拿不到**（`dsh-mcp-client` 只桥工具），所以 `query_graph`
  之类只能由模型调，插件不能主动查图 —— 插件读的是图文件。
- **Explorer 是独立子进程**：同一个视图重复出图会重启它（`--graph` 只在启动时读一次）。
- 面板工具栏的统计是**切完图之后**的数字，「全部」模式看到的是整张图。

## 许可

MIT
