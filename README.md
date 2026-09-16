# dsh-semantica-graph

把 **当前对话** 交给 [Semantica](https://github.com/semantica-agi/semantica) 抽成知识图谱，然后在 DSH 的侧边栏里用 **Semantica 自带的 Knowledge Explorer** 浏览。

会话标题右侧多一个图谱按钮 —— 点它，右侧栏展开插件的控制面板，同时在新标签里打开上游的完整 Explorer：6 个 workspace、78 个 REST 接口，检索 / 分析 / 路径 / 决策链 / 出处 / 本体全都在。

```
会话头部  [⋯ 后台任务]  [◉ 图谱]   ← 点这里
                             ↓
        右侧边栏：① 控制面板（进度 · 统计 · 报错与修复指引）
                  ② Explorer 标签（Semantica 自带的完整 Web UI）
```

## 为什么是内嵌而不是自己画

早期版本用 cytoscape 自己渲染了一张图。那是个**窄读**：把 semantica 当成了抽取库，
只调了它两个类（`NamedEntityRecognizer` / `RelationExtractor`），完全没碰平台层。

| | semantica 提供 | 自绘版本覆盖到的 |
| --- | --- | --- |
| 顶层命令组 | 22 个（ingest / kg / reason / ontology / provenance / export…） | — |
| Explorer REST 接口 | 78 个 | — |
| Web workspace | 6 个 | 1 个（画张图） |
| 抽取能力 | NER、关系、三元组、事件 | NER + 关系 |

自绘等于把它当成了一个 spaCy 包装，再手搓一个查看器 —— 功能上限被自己锁死。
现在插件只做三件事：**读会话 → 建图 → 把上游的 UI 拉起来**，界面完全交给 semantica，
所以上游有什么能力，插件就有什么能力。

---

## 快速开始

```bash
cd /path/to/dsh-semantica-graph
npm install
node scripts/install.mjs
```

然后完成下面两件 Python 侧的前置事项，再**完全退出并重启 DSH Desktop**。

---

## 前置条件

| 需要 | 说明 |
| --- | --- |
| DSH Desktop | 需要能跑 web profile。CLI 版（`dsh web`）同样可用 |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Python 3 | Semantica 声明 `>=3.8`；本插件实测跑通的是 3.12.7 |
| `dsh-better-sidebar` | 侧边栏容器，**必须装**。Explorer 开在插件自己的侧边栏标签里 |

---

## 安装

### 第 1 步：Python 侧装 Semantica + Explorer

**务必装进独立 venv，不要装进 conda base。** Semantica 会拉 numpy / spacy /
transformers / torch，塞进共用环境会和既有包（gradio、streamlit…）的版本约束打架。
这一点是实测踩出来的：装进 anaconda base 后 numpy 被升到 2.0.2，直接让
sklearn / gensim / spacy 全部 `numpy.core.multiarray failed to import`。

```bash
# 定位 harness 根：Desktop 版在 Application Support，CLI 版在 ~/.dsh
DSH_HOME="${DSH_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}"
[ -d "$DSH_HOME" ] || DSH_HOME="$HOME/.dsh"

python3 -m venv "$DSH_HOME/semantica-venv"
"$DSH_HOME/semantica-venv/bin/pip" install -U pip

# 注意是 semantica[explorer]，不是光秃秃的 semantica
"$DSH_HOME/semantica-venv/bin/pip" install "semantica[explorer]"

# 两个 spaCy 模型都要装：一个英文、一个中文
"$DSH_HOME/semantica-venv/bin/python" -m spacy download en_core_web_sm
"$DSH_HOME/semantica-venv/bin/python" -m spacy download zh_core_web_sm
```

#### 为什么必须带 `[explorer]`

Explorer 是 semantica 的**可选 extra**。裸装 `semantica` 不会带 `fastapi` / `uvicorn`，
`semantica-explorer` 一起来就直接退出，报错还很晦涩。带上 extra 才会装上：

```
fastapi 0.141.1 / uvicorn 0.53.0 / starlette 1.6.0
```

插件在 `/api-semantica/status` 里会探一次这几个依赖，缺了会直接告诉你该跑哪条命令。

#### 为什么两个 spaCy 模型都必须装

不是可选项。Semantica 内部把模型名硬编码成 `en_core_web_lg/md/sm`，**缺模型时它会
静默退化成正则兜底**（`last_resort_pattern`），抽出来的实体 label 全是 `UNKNOWN`，
图基本没有信息量 —— 而且不报错，很容易以为是插件坏了。

中文尤其明显：用英文模型跑中文，spaCy 会把**整句话**当成一个实体
（「Semantica 是一个知识图谱开源项目，作者是」→ 一个 PRODUCT）；换上
`zh_core_web_sm` 后同一段文本正确给出 Semantica/ORG、北京/GPE、张三/PERSON。

插件按 CJK 字符占比给每一段自动选抽取器：中文段走 `zh_core_web_sm`，其余走
`en_core_web_sm`，中英混着聊不用手动切。建图结果里的
`engine.zhModelInstalled` 会如实反映中文模型在不在。

#### 解释器怎么找的

1. 环境变量 `DSH_SEMANTICA_PYTHON`（或 `DSH_SEMANTICA_PYTHON3`）
2. `$DSH_HOME/semantica-venv/bin/python` ← 上面的装法
3. `$DSH_HOME/.dsh/semantica-venv/bin/python`
4. 插件目录旁的 `.venv/bin/python`
5. 回退 `python3`

### 第 2 步：装插件本体

```bash
cd /path/to/dsh-semantica-graph
npm install              # 只装 fzstd（解 DSH 的多帧 zstd 会话日志）
node scripts/install.mjs
```

`scripts/install.mjs` 会对 `$DSH_HOME/profiles/web/package.json` 做四件事：

1. 先备份原 manifest（`package.json.bak.semantica-<时间戳>`）
2. `dependencies` 加 `"dsh-semantica-graph": "link:<本插件目录>"`
3. `pnpm.overrides` 加同一条 link
4. `dsh.profile.bundles` 追加 `dsh-semantica-graph`

然后调用 desktop 自带的 pnpm 跑一次 install。脚本幂等，可以从任何目录执行。

> **不需要配「浏览器本地回环允许清单」。** 早先的版本把 Explorer 开在
> better-sidebar 的 browser 标签里，那条路必须放行 `127.0.0.1` 否则白屏。
> 现在插件在自己的标签里直接内嵌 iframe，sandbox 属性由插件自己写，
> 那条设置与本插件无关了（详见下方「几个刻意的取舍」）。

```bash
node scripts/install.mjs --dry-run   # 只打印将要做的事
node scripts/install.mjs --remove    # 从 profile 移除
```

> **注意**：这是 `link:` 安装 —— DSH 直接引用插件目录。**别移动或删除这个目录**。

### 第 3 步：重启 DSH Desktop

**必须完全退出再重新启动**，不能只刷新页面：

- **客户端半侧**（按钮 + 控制面板）是热加载的，硬刷新（Cmd/Ctrl+Shift+R）就能生效
- **host 半侧**（`/api-semantica/*` 路由）是新代码，只有重启才会注册

插件树是在启动时组合的，运行期改配置不会触发重新组合（实测过）。

### 第 4 步：验证

**① 插件进了插件树**

```bash
export DSH_HOME="${DSH_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}"
dsh --profile web --dump-config | grep -A 1 semantica
```

应该看到：

```yaml
# == dsh-semantica-graph
- id: semantica-graph
  name: dsh-semantica-graph
```

**② Python 侧就绪**（重启之后，端口换成你的实际 GUI 地址）

```bash
curl -s http://127.0.0.1:56020/api-semantica/status
```

```json
{
  "ok": true,
  "ready": true,
  "semantica": "0.6.8",
  "explorer": { "ok": true, "missing": null, "running": [] }
}
```

`explorer.ok: false` 时看 `explorer.missing`（缺哪个模块）和 `explorer.hint`（该跑什么命令）。

**③ 在 GUI 里点一下**

打开任意会话 → 点标题右侧图谱按钮 → 侧边栏出现控制面板，几秒到半分钟后
Explorer 标签自动打开。

---

## 它做了什么

1. **读当前对话**：从 `session.jsonl.zstd`（多帧 zstd 日志）解析出轮次、用户/助手消息、工具调用。
2. **真调用 Semantica**：把每个文本段送进 `NamedEntityRecognizer` 与 `RelationExtractor`
   抽实体与关系三元组。不是"借鉴风格"，是真的 `import semantica`。
3. **建 Semantica 原生图**：用 `semantica.context.context_graph.ContextGraph` 组装
   对话骨架（轮次 → 消息 / 工具调用）+ 语义层（实体 + 关系）+ 决策层（见下），落盘成 JSON。
4. **拉起上游 UI**：`python -m semantica.explorer --graph <json>`，然后在侧边栏
   自己的标签里内嵌它的界面。

---

## 决策层：把「你做的选择」也画进图里

Semantica Explorer 左侧有个 **Decisions** 区（决策链 + 因果链）。它只认
`type == "decision"` 的节点，并从 properties 里读这几个字段：

```
category / scenario / reasoning / outcome / confidence / timestamp
```

类型对不上、或字段名不对，那个区就是**空的**。

数据来源是对话里的提问工具（`ask_user_question`）。这是对话中**唯一**结构化的决策记录 ——
它的事件同时带着「问了什么 + 每个选项什么意思」和「用户最后选了什么」，
别的决策都埋在自然语言里，抽出来不可靠，所以不做。

字段这样映射：

| Explorer 字段 | 来源 |
| --- | --- |
| `category` | 问题的 `header`（如「按钮位置」） |
| `scenario` | 问题原文 |
| `reasoning` | **选中那个选项的 `description`** —— 就是「为什么这么选」 |
| `outcome` | 你的选择（自己打字的优先于点选项） |
| `confidence` | `1.0` —— 你明确做了选择，不像 NER 有不确定性 |
| `timestamp` | 提问发生的时间 |

被放弃的选项也存进 `alternatives`：决策记录比普通节点多的价值，就在于
「当时还有哪些别的路可以走」。

### 因果链：为什么决策必须有出边

`/api/decisions/{id}/chain` 走的是 `ContextGraph.get_neighbors`，而它**只走出边**：

```python
outgoing_edges = self._adjacency.get(current_id, [])
```

决策节点天然只有入边（`turn → dec`，谁提出了这个问题），所以不补出边的话
那个接口永远返回 `{"chain": []}`。

**这一点为什么是要命的**：Explorer 的决策详情面板里**唯一的实质内容就是那张
标题为 "Causal Chain" 的卡片**。翻它的 bundle（`DecisionWorkspace-*.js`）可以看到
详情只渲染四样东西 —— `decision_id`、`outcome` 徽章、`category` 药丸，再加这张卡片：

```js
"Decision Record"  →  h2 = decision_id  →  outcome 徽章  →  category 药丸
<div class="ws-card">  ● "Causal Chain"  [N steps]  <链列表> </div>
```

`reasoning` / `scenario` / `confidence` 在 bundle 里各出现 **0 次** —— 写了也不显示。
所以卡片一空，整页就只剩一个长 id 和两个小标签，用户看到的就是「点进去空白」。

### 补出边时踩的两个坑

**坑一：别连到 turn。** 最初加的是 `dec --led_to--> turn:N+1`（决策的后果），
链从 0 个节点暴涨到 **412 个** —— turn 是所有消息和工具调用的父节点，
一进 turn 就扇出到整轮内容，再经实体扩散到全图。而前端是 `t.map(...)` 直接渲染、
**没有任何截断**，412 步就是一堵墙。

各类节点的平均出边数（实测）：

| 节点类型 | 平均出边 | 最大出边 |
| --- | --- | --- |
| `turn` | **128.6** | 517 |
| `entity` | 1.1 | 19 |
| `message` | 0.8 | 15 |
| `tool` | **0.0** | 0 |

**坑二：只连 `next_decision` 不够。** 它只在下一条决策存在时才连，
所以**最后一条决策**（以及只有一个提问的短会话）链依然是空的 ——
这种会话打开就是一片空白。实测 12 条决策的链长是 `[5,5,5,4,3,5,2,0,1,5,5,5]`，
第 8 条那个 `0` 就是它。

所以现在连**两条**出边：

| 边 | 指向 | 作用 |
| --- | --- | --- |
| `decided_at` | 提问工具节点 `tool:<callId>` | **必然存在**且出边为 0，一个人就能保证链非空 |
| `next_decision` | 下一条决策 | 串成决策链 |

实测 13 条决策的链长变成 `[1,9,8,8,8,8,9,6,3,4,8,9,9]`，**为空 0 条**。

注意 `next_decision` 是**时序相邻**，不是证明出来的因果：隔了十轮的决策之间未必有因果关系。
这里刻意用一个自解释的边名，免得读图的人误以为那是推理出来的依赖。

### 提问工具的节点标签

`toolTitle()` 在参数**顶层**找 `description` / `prompt` / `question` 等 key，
而提问工具的参数是 `{"questions":[{header, question, options}]}` —— 顶层一个都没有，
于是回退成工具名。图里的节点名和因果链的每一步都显示成光秃秃的 `ask_user_question`。

现在专门处理了这个形状，用各问题的 `header` 拼一行：

```
图的内容 · Semantica 集成深度 · 按钮位置
选方向 · 顺带
定位崩溃 · 重启
```

链里那一步显示的就是这个（前端渲染的是 `t.content || t.id`，`content` 由
`ContextGraph` 从 properties 里挑，挑到的就是 label）。

---

## 让 AI 分析这张图（子会话）

控制面板底部有四个按钮：

```
复盘这次对话 · 理解图数据 · 检验抽取质量 · 给当前任务的建议
```

点下去不是把图塞进当前对话，而是**新开一个子会话**，把 Semantica 抽好的数据注入
进去让 AI 分析。子会话出现在侧边栏的「子会话」页签里，可以读、可以继续追问，
而且不污染当前这一轮。

### 为什么开子会话而不是直接注入当前对话

图数据是几 KB 的文本。直接塞进当前对话会把它永久留在上下文里，之后每一轮都要
背着它；而且分析结果和你正在做的事混在一条时间线上，回头很难找。开子会话则把
「分析」这件事隔离成一条独立的、可回溯的线。

这个接缝是 DSH 官方的 —— `dsh-better-sidebar` 的 `context-types.ts` 里写着：

> Create a session + agent with a custom seed — the Side Chat thread-creation seam:
> the SAME public seam api-proxy's session.fork and the subagent fork provider use.

也就是 `ctx.get('agents').create(options)`。

### 注入为什么分成两条消息

```js
agent.inject(digest)    // source: { kind: 'plugin' }  —— 背景数据
agent.followup(prompt)  // source: { kind: 'user' }    —— 提问
```

`inject` 送的是**排队中的模型可见上下文**，它不唤醒驱动；`followup` 才是唤醒的那条。
分成两条是为了让日志里留下两条 `user/message`：注入那条 source 是 `plugin`，
UI 把它折叠成一行 context；提问才是正常的用户气泡。合并成一条的话，
几 KB 的图数据会整个糊在用户气泡里。

### seed 为什么只有一个事件

Side Chat 的 seed 是**父会话的完整事件日志**，所以它必须处理「父会话正在跑、
turn 没闭合」—— 要合成 `step/end` + `turn/end{reason:'interrupted'}` 把半轮冻住，
还要处理「工具调用没有配对的 result」这种连冻都冻不干净的情况。

我们**不继承历史**。用户是在对话进行到一半时点按钮的，父会话必然是 mid-turn；
而 digest 里已经带了决策、轮次、时间线。所以 seed 只放一个
`subagent/descriptor` 事件就够 —— 整个 open-turn 问题不复存在。

那个 descriptor 不能省：没有它的子会话会被宿主目录确定性地渲染成 `corrupt` 诊断行。

代价是子会话不知道对话原文，只知道图。对「分析图」这个目的足够。

### `src/analyze.js` 为什么不 import `@deepseek-ai/*`

上游那两处都是纯函数，可以照着手写：

```js
createUserMessage(input) = {...input, role:'user', id: MessageId(randomUUID())}
MessageId(id) { return id }            // 品牌函数，零校验
snapshotSubagentDescriptor(x) = {version:3, mode, provider, label, ...}
```

之所以不 import，是因为**这个插件是 `link:` 安装的**：真实路径在
`~/Downloads/dsh-semantica-graph`，而
`profiles/web/node_modules/dsh-semantica-graph` 只是个相对软链。Node 的 ESM 解析
会先把软链折成真实路径（实测报错里就是 `~/Downloads/.../analyze.js`），于是父级
向上走够不到 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`。

这个失败模式极不对称：

| 做法 | 最坏结果 |
|---|---|
| import | 解析不了 → **整个插件加载失败**，`apply` 压根不执行，图谱功能一起挂 |
| 手写 | 描述符版本对不上 → 子会话被标 `corrupt`，主功能不受影响 |

所以选零依赖。代价是 `DESCRIPTOR_VERSION = 3` 是钉死的，DSH 升级若改了描述符
版本需要同步改。

### digest 里有什么

`buildDigest()` 是纯函数，输出约 6-7KB（≈2600 token）：

- 图规模 + 节点/边类型分布
- **决策全量**（category / scenario / outcome / alternatives）—— 信息密度最高的一段
- 时间线（起止 + 按小时密度）
- 高频实体 Top 40、关系 Top 30
- **钻取接口清单**：Explorer 基址 + 实测可用的端点 + 两个踩过的坑
  （`/api/temporal/snapshot` 的参数是 `?at=` 不是 `?time=`；`/api/reason` 的
  facts 要写成 `parent_of(a,b)` 且规则结尾不加句号）

所以是**摘要打底 + 可钻取**：子会话自己带了 bash，可以按清单用 `curl` 去查更细的数据。
Explorer 没起来时降级成纯摘要，并在 digest 里标注「无法钻取」，让模型知道别硬编。

---

## 架构

```
浏览器                                        宿主进程                          Python
┌────────────────────┐                ┌──────────────────────────┐    ┌────────────────────┐
│ 头部按钮            │                │ /api-semantica/prepare   │    │ graph_worker.py    │
│  └ 打开控制面板     │─── POST ─────▶│ /api-semantica/analyze   │───▶│  ├ NER             │
│ 控制面板 tab        │                │   ├ session-reader       │    │  ├ RelationExtract │
│  └ 进度/统计/报错   │                │   ├ bridge（常驻 worker）  │NDJSON│ └ ContextGraph     │
│  └ 四个分析按钮      │◀── URL/childId│   ├ explorer（进程管理）   │    │ └ ContextGraph     │
│ Explorer tab       │                │   └ analyze（建子会话+注入）│    └────────────────────┘
│  └ iframe: 上游 UI  │◀─── iframe ────│  127.0.0.1:<动态端口>      │◀─── semantica-explorer
└────────────────────┘                └───────────┬──────────────┘
                                                  │ agents.create(seed)
                                        ┌─────────▼──────────┐
                                        │ 子会话（侧边栏页签） │
                                        └────────────────────┘
```

| 文件 | 职责 |
| --- | --- |
| `src/index.js` | host 半侧：注册 `/api-semantica/{status,prepare,analyze}`，编排「读会话 → 建图 → 起 Explorer」 |
| `src/session-reader.js` | 解多帧 zstd 日志、解析事件、抽对话结构；走 `sessionPersistence.list/locate`，回退扫 `$DSH_HOME/sessions` |
| `src/semantica-bridge.js` | 常驻 Python worker 的 NDJSON 桥；懒启动、空闲 10 分钟回收、超时与错误传播 |
| `src/explorer.js` | `semantica-explorer` 子进程管理：空闲端口分配、健康检查、就绪超时、按会话缓存、总量上限、空闲与 LRU 回收，以及依赖探测 |
| `src/analyze.js` | 四段分析提问 + digest 组装 + 开子会话并注入。零外部依赖（原因见上） |
| `src/graph_worker.py` | Python 侧：markdown 归一化、逐段抽实体/关系、组装 ContextGraph 并落盘 |
| `src/client.js` | 浏览器半侧：头部按钮 + 控制面板 tab（进度、统计、报错与修复指引、四个分析按钮）+ Explorer tab（自己渲染的 iframe） |
| `scripts/install.mjs` | 装/卸 profile，自动备份 manifest |

### 几个刻意的取舍

- **界面不自绘，直接嵌上游**：这是这个插件最重要的一条。自绘只能覆盖上游的一个视图，
  而且会随着上游演进而落后。现在插件不碰渲染，Explorer 长什么样就是什么样。
  代价是多一个常驻进程，以及依赖 `dsh-better-sidebar` 提供侧边栏容器。
- **内嵌用插件自己的标签，不用 better-sidebar 的 browser 标签**：后者的壳里有一条
  **删不掉**的状态行 —— `SandboxStatusBar` 在 `BrowserView` 里是无条件渲染的，
  整个插件没有任何隐藏它的设置，只有「沙箱开＝绿杠」和「沙箱关＝红杠」两种状态，
  而关掉沙箱会把 Explorer 页面变成与 GUI 同源、拿到完整会话权限（更糟）。
  自己渲染 iframe 就没有那层壳，顺带也不再需要用户去配 `browserAllowedLoopback`。
  sandbox 令牌由插件自己写，与 better-sidebar 给「已放行回环地址」的那串逐字相同：
  `allow-same-origin` 必须有（否则 SPA 白屏），而刻意不含 `allow-top-navigation`
  （页面因此无法把主窗口导航走）。Explorer 在 `127.0.0.1:<另一个端口>`，
  与 GUI 端口不同，因此**仍是跨源** —— 拿不到 GUI 的 DOM、Cookie 与内部接口。
  代价是失去 URL 栏与前进后退，所以插件自己补了刷新与「在浏览器打开」。
- **常驻 Python worker 而不是每请求 spawn**：Semantica 会拉起 spaCy/thinc，冷导入是秒级。
  进程常驻、空闲自动退出，插件加载 3 秒后还会主动预热一次。
- **已在跑的 Explorer 直接复用**：会话是活的，事件数几乎每次点击都在变，但重抽一张图要
  20s+。所以只要进程还在就先把 URL 给出去，只在响应里标注这张图是否已落后于会话
  （`stale`），要不要重抽交给用户点「重新抽取」。实测第二次点击只要 1.4s，
  而重新抽取一次约 12.6s。
- **一个会话一个 Explorer 进程**：`--graph` 只在启动时读一次，换会话就得换进程。
  所以按会话缓存、空闲回收，并设 3 个实例的上限防泄漏。
- **匿名访问开关**：Explorer 默认要求 `SEMANTICA_API_KEY`，否则所有受保护路由返回 503。
  它只绑在 127.0.0.1，喂进去的是用户自己的对话图，所以插件起进程时带上
  `SEMANTICA_ALLOW_ANONYMOUS=true`（上游为此提供的显式开发开关）。
- **排除模型的思考过程（reasoning）**：这是影响最大的一条。assistant 消息的 content
  里除了 `text`（用户看到的回复）还有 `reasoning`（模型的内部思考），而后者体量碾压
  前者 —— 实测一段 1.5 小时的会话：`text` 块 320 个 / **33,831 字符**，`reasoning`
  块 457 个 / **544,010 字符**，是正文的 16 倍。

  不排除的后果有三个：图基本是照着思考过程画的、真实对话被淹没；思考是英文散文式的
  自我对话（"Let me fetch…", "Hmm", "first"），spaCy 会把 `Let` / `Hmm` / `first` /
  `one` / `objective` 当成实体，实测噪声实体霸榜；以及把模型的私有思考画进用户能
  浏览的图里本来也不合适。

  修法是 `textOf()` 只认 `type === 'text'` 的块。效果：喂进 NER 的正文从 42 万字符
  降到 **5.5 万**，构建耗时 25s → **12.6s**。
- **markdown 先归一化再抽取**：助手正文是 markdown，直接喂 spaCy 会出两类脏实体 ——
  行内代码的反引号被吃进实体名（抽出 `` `conversation `` 这种标签），代码块里成片的
  标识符被当成实体（`Side` / `openDetails` / `bar\``）。现在代码块整块丢弃，行内代码
  只去反引号保留内容（`` `numpy` `` 这类术语本身有价值）。实测带反引号的实体降到 **0**。
- **工具调用不进语义抽取**：工具调用的结构价值由 `toolCalls` 单独承载（→ 图里的
  tool 节点），而它们的文本是 `<动词> <名词短语>` 形式的界面标签（"Check working
  directory contents"、"Find SlotMap declaration merge sites"）。spaCy 会把开头那个
  动词当实体抽出来，实体榜于是被 `Read` / `Verify` / `Find` / `Check` / `Inspect` /
  `Locate` 霸占 —— 实测它们各出现 31~48 次，而同样的词在对话正文里只出现 3~5 次。
  丢掉工具段后实体数从 525 降到 **123**，剩下的基本全是真实对话概念
  （Semantica / ContextGraph / NamedEntityRecognizer / browserAllowedLoopback…）。
- **段的锚点必须与节点 id 对齐**：段的 `source` 是裸 id（`user:123` / `<call.id>`），
  而节点 id 带 `msg:` / `tool:` 前缀，不建对照表就永远匹配不上，每段都会 fallback 成
  一个 `seg:<seq>` 影子节点 —— 实测 400 段全部如此，结果是同一批内容既有 message 节点
  又有一套 seg 节点，而实体边全挂在影子上，从实体点进去走不到真正的消息。
  对齐之后影子节点 400 → **0**，边数反而从 1391 涨到 1767。
- **关系抽取限规模**：共现关系是 O(实体对)。实测关系抽取曾吃掉 103.8s，实体抽取
  只要 6.9s。现在每段最多送 12 个实体、1200 字符。
- **不用 `sessionPersistence.load()`**：对仍在跑的会话，`load` 会先刷新快照并在回合
  开放时拒绝 —— 而正在进行的对话恰恰就是要画的那个。改走 `locate` + 自己解压。
- **只抽取真实对话**：`user/message` 有三种 `source.kind` —— `user`（真人）、
  `plugin`（运行时上下文快照、后台任务通知）、`skill-catalog`（系统注入的技能目录）。
  后两者动辄几千字，放进来会把真实对话彻底淹没。默认只取 `user`。
- **多帧 zstd**：DSH 每 append 一批事件就往文件尾加一个独立 zstd 帧，
  `node:zlib` 的解压 API 只解第一帧（实测 2MB 日志只读出 197 字节），所以必须用 `fzstd`。
- **客户端不需要构建步骤**：只依赖 `react`（在基座冻结表里），没有第三方库要内联。
  早期为了 cytoscape 搞了一个 458KB 的构建产物，现在 `src/client.js` 就是加载的成品。
- **时间写成「不带时区偏移的本地时间」**：这一条极容易写反，而且写反了就是整体差 8 小时
  （实测踩过）。Explorer 前后端对无时区时间的处理是**约定式**而非真换算：

  | 输入 | 后端 `_parse_flexible_dt` | 前端 `new Date(...)` | 结果 |
  |---|---|---|---|
  | `15:38:41+08:00` | 折成 UTC 并抹掉标记 → `07:38:41` | 裸值当本地 → `07:38` | ✗ 差 8 小时 |
  | `15:38:41` | 无 tzinfo → 原样透传 | 按本地解释 → `15:38` | ✓ 一致 |

  所以 `_iso_local()` 故意用 `datetime.fromtimestamp(ts)`（不带 tzinfo）而不是
  `.astimezone().isoformat()`。画出来对不上时间时，先查这一条。
  每个节点都带 `valid_from`（实体另外带提及跨度的 `valid_until`），因为前端的
  时间轴过滤 `xc()` 对**没有任何时间字段的节点直接判定为永不活跃**；一个都不写的话
  时间轴上下界还会退化成写死的兜底值 `1970 → 2030`。

### 性能

以一段真实会话为例（1.5 小时、336 条助手回复、5 条真人消息、631 次工具调用，
正文约 3.6 万字符）：

| 阶段 | 耗时 |
| --- | --- |
| Python 冷启动 + `import semantica` | ~2–3s（仅首次） |
| spaCy 模型加载 | ~1–3s（仅首次） |
| 实体抽取（341 段正文） | ~3–4s |
| 关系抽取 | ~1–2s |
| 写 ContextGraph + Explorer 启动就绪 | ~4–5s |
| **合计（首次）** | **~12.6s** |
| **再次点击（复用已跑的实例）** | **~1.4s** |

早期版本要 25s，因为那时把模型的 reasoning（54 万字符）也喂进了 NER；
排除之后输入降到 5.5 万字符，耗时随之腰斩。

---

## 卸载

```bash
cd /path/to/dsh-semantica-graph
node scripts/install.mjs --remove     # 从 profile 摘掉，并跑一次 pnpm
```

然后重启 DSH Desktop。这只移除插件引用，不会删插件目录，也不会动 venv。
要连 Python 侧一起清掉：

```bash
rm -rf "$DSH_HOME/semantica-venv"
rm -rf "$DSH_HOME/dsh-semantica-graph"   # 落盘的图
```

---

## 常见问题

**启动时弹出「Failed to load plugins / cannot get property "x" without inject」**

这是插件**加载失败**，不是运行时报错。成因是某一半侧的 `apply(ctx)` 访问了没写进
`inject` 数组的服务属性。Cordis 的 ctx 是服务代理，未声明的服务属性直接抛，
整个条目 apply 失败。

改完插件后先跑这个自检，它用 Proxy 精确模拟 Cordis 的取值语义：

```bash
node scripts/check-inject.mjs
```

还有一个**反方向**的坑要注意：客户端 fiber 会**等待** inject 里的服务就绪，
所以声明了一个永远不存在的服务，插件会永远不 apply，而且**不报错**。只声明
真正用到的服务。

⚠️ **失败后 DSH 会把这个插件静默卸载**：它从 `dsh.profile.bundles` 摘掉条目，
并跑一次 `pnpm install`，于是 `dependencies` 里的声明和 `node_modules` 软链也一起
没了（`pnpm.overrides` 里的那条会残留）。表现是「文件都在，但插件像是没装过」。
修好之后**必须重新安装**：

```bash
node scripts/install.mjs
```

**按钮点了没反应 / 控制台提示 betterSidebar 缺席**
没装 `dsh-better-sidebar`。插件本身仍会正常加载（`betterSidebar` 是可选的晚挂载服务，
用 `ctx.inject` 延迟注册，缺席时不阻塞激活），只是没有容器可以显示。

**界面全是英文（中文环境下）**
语言判断踩过一个坑：`locale` 服务**没有 `current()` 方法**，快照上的字段也不叫
`language` / `locale` —— 它叫 **`active`**（`dsh-client-locale` 的 `publish()`
里是 `Object.freeze({ active, locales, revision })`）。按 `current()`/`language`
去读会两处都取不到，判断恒为假，字典永远落到英文。

正确的读法是 `ctx.get("locale").getLocale().active`；`locale/change` 事件本身
是存在的（同一个 `publish()` 里 `ctx.emit`），可以照常监听。服务整个取不到时
会退到 `navigator.language` 兜底。`/tmp/test_locale.mjs` 把几种服务形态都锁住了。

**Explorer 标签一片空白**
先看控制面板：如果它显示「无法生成图谱」或还在转圈，说明 Explorer 进程没起来，
问题在 Python 侧（见上一条）。控制面板显示「已就绪」却空白时，多半是
`127.0.0.1:<端口>` 上那个进程已经退出（空闲 10 分钟会自动回收）——
点标签栏里的「刷新」重挂载 iframe，或在控制面板点「重新打开」。

> 内嵌不再经过 better-sidebar 的浏览器标签，所以「站点拒绝嵌入」这类拦截
> 与本插件无关：`allow-same-origin` 由插件自己写在 iframe 上。

**以前标签顶部那条「沙箱模式：已启用」哪去了？**

早先版本把 Explorer 开在 better-sidebar 的 browser 标签里，那里有一条删不掉的
状态行；现在改用插件自己的标签内嵌 iframe，那层壳连同状态行一起不存在了。
隔离没有变弱：iframe 仍是跨源的，且插件的 sandbox 令牌不含 `allow-top-navigation`。

**时间轴显示 `1970 → 2030`，或者时间对不上**

`1970`/`2030` 是 Explorer 前端在拿不到时间边界时的**硬编码兜底值**
（`r?.minDate ?? "1970"`）；真出这个值说明图里一个 `valid_from` 都没有。

时间整体偏移则是时区约定问题，见上面「几个刻意的取舍」里那条 ——
必须写不带偏移的本地时间。可以用这条命令自查，结果应当接近本机当前时间：

```bash
curl -s http://127.0.0.1:<explorer端口>/api/temporal/bounds
```

**控制面板报 `explorer-unavailable`**
缺 Explorer 组件。按面板里给的命令装：
`<venv>/bin/pip install "semantica[explorer]"`。

**`/api-semantica/status` 返回 404**
没重启 DSH Desktop。见第 4 步。

**实体全是 `UNKNOWN`，或者中文整句被当成一个实体**
spaCy 模型没装全。回到第 1 步把两个模型都装上。建图结果里的
`engine.zhModelInstalled` 会告诉你中文模型到底在不在。

**图是空的 / 只有几个节点**
插件只抽**真人发的消息**（`source.kind === "user"`）。系统注入的内容
（运行时上下文快照、后台任务通知、技能目录）默认全部跳过，因为它们动辄几千字。
如果这个会话本身几乎没有真人输入，图自然就小。

**面板显示「这张图是旧的」**
会话在图上一次构建之后又有新内容。点「重新抽取」重建（约 13s）。

**Explorer 里「语义相似度」报 no node embeddings**

这是**已知限制，不是故障**。Explorer 的语义相似度（`/api/graph/semantic-neighborhood`、
搜索结果里的 `semantic_similarity` 字段）不自己算 embedding，只从节点属性里读
（`embedding` / `node2vec_embedding` / `vector` 等键），而本插件构建 ContextGraph 时
没有写入这些字段。

没有一并做的原因是性价比：为了这一个特性要在首次使用时下载 sentence-transformers
模型（约 80MB），并给每次建图都加一轮 embedding 计算；而**图搜索、查重、连接预测、
出处、本体、决策链都是正常的** —— 实测 Explorer 的 78 个接口里，18 个无参可直接返回，
另有 30 多个带上参数即正常，受影响的只有语义相似度这一项。

要自己补上的话：`semantica.embeddings.EmbeddingGenerator` 可用，给实体节点写一个
`embedding` 属性即可（`sentence_transformers` 与 `torch` 已随 semantica 一并装好）。

**Explorer 标签里显示「Something went wrong in this view. / An unexpected problem
occurred while rendering this workspace. Your data is safe, but this view cannot be
displayed.」**

这句话**不是 DSH 的、也不是本插件的** —— 它是 Semantica Explorer 自己的
per-workspace 错误边界（在 `semantica/static/assets/index-*.js` 里）。真正的报错在
浏览器控制台里（**Cmd+Option+I**），通常长这样：

```
Sigma: Coordinates of node ent:北京 are invalid.
       A node must have a numeric 'x' and 'y' attribute.
```

原因是 Explorer 前端拿 **`→`(U+2192) 当自己的内部边键分隔符**：

```js
const a = `${source}→${target}`            // 拼边键
const [o, s] = i.split("→")                // 再拆回来恢复端点
e.mergeDirectedEdgeWithKey(f, o, s, …)     // graphology 给不存在的端点自动补节点
```

所以节点 id 或边端点里只要带 `→`，拆回来就会错位：
`turn:1→ent:北京→g`.split(`→`) → `["turn:1", "ent:北京", "g"]`，末尾的 `g` 被丢掉，
于是凭空多出一个 `ent:北京` 节点，而它是补出来的、**没有坐标** → sigma 直接抛错。

`→` 很容易混进来，因为实体名直接取自对话文本，而你很可能在对话里写过
「张三→PERSON」这类测试结论。本插件从 **0.3.1** 起在 `_norm_key` 和落盘前的
`_sanitize_ids` 里把 `→` 换成 `_`（**只清 id，label/content 保留原样**，显示信息不丢），
建图结果里的 `renamedIds` 会告诉你有几个 id 被改名。

碰到这个错误时的处理顺序：

1. **点「重新抽取」重建图谱** —— Explorer 只在启动时读一次图，正在跑的那个实例
   内存里还是坏数据。插件按「会话事件数」判断图是否变化，重建后会**另起一个
   新端口的 Explorer**，标签会自动指过去（新的正常，旧的可以关掉）。
2. 还不行就硬刷新一次（**Cmd+Shift+R**）再看控制台的真实报错。

---

## 依赖的插件

侧边栏由 [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) 提供。
插件用到它的两件事：

- `registerTab` —— 注册两个 tab 类型：控制面板（`single:true`，一个就够）与
  Explorer 界面。后者用 `dedupeKey` 按「会话+端口」去重，而不是 `single:true`
  —— 详见「几个刻意的取舍」里那条说明
- `openTab({ type: 'semantica:explorer', id, url, meta: { scope } })` —— 打开承载
  Explorer 的标签；`closeTab` 用于 Explorer 换端口后关掉指向死地址的旧标签

没有装它的话：按钮还在，点了会在控制台给出提示，什么都不会显示。
