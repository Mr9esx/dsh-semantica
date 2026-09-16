# 实现细节与取舍

README 讲怎么用，这里讲为什么这么做、以及踩过什么坑。每条都带着实测数字——没有数字的取舍，下次改代码的人没法判断能不能动。

---

## 决策层

Semantica Explorer 左侧有个 **Decisions** 区（决策链 + 因果链）。它只认 `type == "decision"` 的节点，并从 properties 里读这几个字段：

```
category / scenario / reasoning / outcome / confidence / timestamp
```

类型对不上、或字段名不对，那个区就是**空的**。

数据来源是对话里的提问工具（`ask_user_question`）。这是对话中**唯一**结构化的决策记录——它的事件同时带着「问了什么 + 每个选项什么意思」和「用户最后选了什么」。别的决策都埋在自然语言里，抽出来不可靠，所以不做。

| Explorer 字段 | 来源 |
| --- | --- |
| `category` | 问题的 `header`（如「按钮位置」） |
| `scenario` | 问题原文 |
| `reasoning` | **选中那个选项的 `description`** —— 就是「为什么这么选」 |
| `outcome` | 用户的选择（自己打字的优先于点选项） |
| `confidence` | `1.0` —— 用户明确做了选择，不像 NER 有不确定性 |
| `timestamp` | 提问发生的时间 |

被放弃的选项也存进 `alternatives`：决策记录比普通节点多的价值，就在于「当时还有哪些别的路可以走」。

### 因果链：为什么决策必须有出边

`/api/decisions/{id}/chain` 走的是 `ContextGraph.get_neighbors`，而它**只走出边**：

```python
outgoing_edges = self._adjacency.get(current_id, [])
```

决策节点天然只有入边（`turn → dec`，谁提出了这个问题），所以不补出边的话那个接口永远返回 `{"chain": []}`。

**后果为什么严重**：Explorer 的决策详情面板里**唯一的实质内容就是那张标题为 "Causal Chain" 的卡片**。翻它的 bundle（`DecisionWorkspace-*.js`）可以看到详情只渲染四样东西——`decision_id`、`outcome` 徽章、`category` 药丸，再加这张卡片：

```js
"Decision Record"  →  h2 = decision_id  →  outcome 徽章  →  category 药丸
<div class="ws-card">  ● "Causal Chain"  [N steps]  <链列表> </div>
```

`reasoning` / `scenario` / `confidence` 在 bundle 里各出现 **0 次**——写了也不显示。所以卡片一空，整页就只剩一个长 id 和两个小标签，用户看到的就是「点进去空白」。

### 补出边时踩的两个坑

**坑一：别连到 turn。** 最初加的是 `dec --led_to--> turn:N+1`（决策的后果），链从 0 个节点涨到 **412 个**——turn 是所有消息和工具调用的父节点，一进 turn 就扇出到整轮内容，再经实体扩散到全图。而前端是 `t.map(...)` 直接渲染、**没有任何截断**，412 步铺满一屏，没人看得下去。

各类节点的平均出边数（实测）：

| 节点类型 | 平均出边 | 最大出边 |
| --- | --- | --- |
| `turn` | **128.6** | 517 |
| `entity` | 1.1 | 19 |
| `message` | 0.8 | 15 |
| `tool` | **0.0** | 0 |

**坑二：只连 `next_decision` 不够。** 它只在下一条决策存在时才连，所以**最后一条决策**（以及只有一个提问的短会话）链依然是空的——这种会话打开就是一片空白。实测 12 条决策的链长是 `[5,5,5,4,3,5,2,0,1,5,5,5]`，第 8 条那个 `0` 就是它。

所以现在连**两条**出边：

| 边 | 指向 | 作用 |
| --- | --- | --- |
| `decided_at` | 提问工具节点 `tool:<callId>` | **必然存在**且出边为 0，一个人就能保证链非空 |
| `next_decision` | 下一条决策 | 串成决策链 |

实测 13 条决策的链长变成 `[1,9,8,8,8,8,9,6,3,4,8,9,9]`，**为空 0 条**。

注意 `next_decision` 是**时序相邻**，不是证明出来的因果：隔了十轮的决策之间未必有因果关系。这里刻意用一个自解释的边名，免得读图的人误以为那是推理出来的依赖。

### 提问工具的节点标签

`toolTitle()` 在参数**顶层**找 `description` / `prompt` / `question` 等 key，而提问工具的参数是 `{"questions":[{header, question, options}]}`——顶层一个都没有，于是回退成工具名。图里的节点名和因果链的每一步都显示成光秃秃的 `ask_user_question`。

现在专门处理了这个形状，用各问题的 `header` 拼一行：

```
图的内容 · Semantica 集成深度 · 按钮位置
选方向 · 顺带
定位崩溃 · 重启
```

链里那一步显示的就是这个（前端渲染的是 `t.content || t.id`，`content` 由 `ContextGraph` 从 properties 里挑，挑到的就是 label）。

---

## 抽取层

### 排除模型的思考过程（reasoning）

影响最大的一条。assistant 消息的 content 里除了 `text`（用户看到的回复）还有 `reasoning`（模型的内部思考），而后者体量远大于前者——实测一段 1.5 小时的会话：`text` 块 320 个 / **33,831 字符**，`reasoning` 块 457 个 / **544,010 字符**，是正文的 16 倍。

不排除的后果有三个：图基本是照着思考过程画的、真实对话被淹没；思考是英文散文式的自我对话（"Let me fetch…", "Hmm", "first"），spaCy 会把 `Let` / `Hmm` / `first` / `one` / `objective` 当成实体，实测噪声实体霸榜；以及把模型的私有思考画进用户能浏览的图里本来也不合适。

修法是 `textOf()` 只认 `type === 'text'` 的块。效果：喂进 NER 的正文从 42 万字符降到 **5.5 万**，构建耗时 25s → **12.6s**。

### markdown 先归一化再抽取

助手正文是 markdown，直接喂 spaCy 会出两类脏实体——行内代码的反引号被吃进实体名（抽出 `` `conversation `` 这种标签），代码块里成片的标识符被当成实体（`Side` / `openDetails` / `bar\``）。

现在代码块整块丢弃，行内代码只去反引号保留内容（`` `numpy` `` 这类术语本身有价值）。实测带反引号的实体降到 **0**。

### 工具调用不进语义抽取

工具调用的结构价值由 `toolCalls` 单独承载（→ 图里的 tool 节点），而它们的文本是 `<动词> <名词短语>` 形式的界面标签（"Check working directory contents"、"Find SlotMap declaration merge sites"）。spaCy 会把开头那个动词当实体抽出来，实体榜于是被 `Read` / `Verify` / `Find` / `Check` / `Inspect` / `Locate` 占满——实测它们各出现 31~48 次，而同样的词在对话正文里只出现 3~5 次。

丢掉工具段后实体数从 525 降到 **123**，剩下的基本全是真实对话概念（Semantica / ContextGraph / NamedEntityRecognizer / browserAllowedLoopback…）。

### 段的锚点必须与节点 id 对齐

段的 `source` 是裸 id（`user:123` / `<call.id>`），而节点 id 带 `msg:` / `tool:` 前缀，不建对照表就永远匹配不上，每段都会 fallback 成一个 `seg:<seq>` 影子节点——实测 400 段全部如此。结果是同一批内容既有 message 节点又有一套 seg 节点，而实体边全挂在影子上，从实体点进去走不到真正的消息。

对齐之后影子节点 400 → **0**，边数反而从 1391 涨到 1767。

### 关系抽取限规模

共现关系是 O(实体对)。实测关系抽取曾吃掉 **103.8s**，实体抽取只要 6.9s。现在每段最多送 12 个实体、1200 字符。

### 只抽取真实对话

`user/message` 有三种 `source.kind`——`user`（真人）、`plugin`（运行时上下文快照、后台任务通知）、`skill-catalog`（系统注入的技能目录）。后两者动辄几千字，放进来会把真实对话彻底淹没。默认只取 `user`。

### 不用 `sessionPersistence.load()`

对仍在跑的会话，`load` 会先刷新快照并在回合开放时拒绝——而正在进行的对话恰恰就是要画的那个。改走 `locate` + 自己解压。

### 多帧 zstd

DSH 每 append 一批事件就往文件尾加一个独立 zstd 帧，`node:zlib` 的解压 API 只解第一帧（实测 2MB 日志只读出 197 字节），所以必须用 `fzstd`。

### 中文分段选模型

插件按 CJK 字符占比给每一段自动选抽取器：中文段走 `zh_core_web_sm`，其余走 `en_core_web_sm`，中英混着聊不用手动切。建图结果里的 `engine.zhModelInstalled` 会如实反映中文模型在不在。

不装中文模型的后果很具体：用英文模型跑中文，spaCy 会把**整句话**当成一个实体（「Semantica 是一个知识图谱开源项目，作者是」→ 一个 PRODUCT）；换上 `zh_core_web_sm` 后同一段文本正确给出 Semantica/ORG、北京/GPE、张三/PERSON。

### 时间写成「不带时区偏移的本地时间」

这一条极容易写反，而且写反了就是整体差 8 小时（实测踩过）。Explorer 前后端对无时区时间的处理是**约定式**而非真换算：

| 输入 | 后端 `_parse_flexible_dt` | 前端 `new Date(...)` | 结果 |
|---|---|---|---|
| `15:38:41+08:00` | 折成 UTC 并抹掉标记 → `07:38:41` | 裸值当本地 → `07:38` | ✗ 差 8 小时 |
| `15:38:41` | 无 tzinfo → 原样透传 | 按本地解释 → `15:38` | ✓ 一致 |

所以 `_iso_local()` 故意用 `datetime.fromtimestamp(ts)`（不带 tzinfo）而不是 `.astimezone().isoformat()`。画出来对不上时间时，先查这一条。

每个节点都带 `valid_from`（实体另外带提及跨度的 `valid_until`），因为前端的时间轴过滤 `xc()` 对**没有任何时间字段的节点直接判定为永不活跃**；一个都不写的话时间轴上下界还会退化成写死的兜底值 `1970 → 2030`。

### `→` 会打崩 Explorer 的渲染

Explorer 前端拿 `→`(U+2192) 当自己的内部边键分隔符：

```js
const a = `${source}→${target}`            // 拼边键
const [o, s] = i.split("→")                // 再拆回来恢复端点
e.mergeDirectedEdgeWithKey(f, o, s, …)     // graphology 给不存在的端点自动补节点
```

节点 id 或边端点里只要带 `→`，拆回来就会错位：`turn:1→ent:北京→g`.split(`→`) → `["turn:1", "ent:北京", "g"]`，末尾的 `g` 被丢掉，于是凭空多出一个 `ent:北京` 节点，而它是补出来的、**没有坐标** → sigma 直接抛错。

`→` 很容易混进来，因为实体名直接取自对话文本，而用户很可能在对话里写过「张三→PERSON」这类测试结论。插件从 **0.3.1** 起在 `_norm_key` 和落盘前的 `_sanitize_ids` 里把 `→` 换成 `_`（**只清 id，label / content 保留原样**），`renamedIds` 会告诉你有几个 id 被改名。

---

## 运行期行为

### 怎么把 Explorer 拉起来

一句话：

```bash
<venv>/bin/python -m semantica.explorer --graph <图.json>
```

图由 `semantica.context.context_graph.ContextGraph` 组装后落盘，`--graph` 只在进程启动时读一次。

Explorer 自己的前端资源在 `semantica/static/assets/index-*.js` 里——包括那个 per-workspace 错误边界（页面上显示「Something went wrong in this view.」的那句就是它）。

### 常驻 Python worker，不是每请求 spawn

Semantica 会拉起 spaCy / thinc，冷导入是秒级。进程常驻、空闲自动退出，插件加载 3 秒后还会主动预热一次。

### 已在跑的 Explorer 直接复用

会话是活的，事件数几乎每次点击都在变，但重抽一张图要 20s+。所以只要进程还在就先把 URL 给出去，只在响应里标注这张图是否已落后于会话（`stale`），要不要重抽交给用户点「重新抽取」。

实测第二次点击只要 **1.4s**，而重新抽取一次约 **12.6s**。

### 一个会话一个 Explorer 进程

`--graph` 只在启动时读一次，换会话就得换进程。所以按会话缓存、空闲回收，并设 3 个实例的上限防泄漏。

### 匿名访问开关

Explorer 默认要求 `SEMANTICA_API_KEY`，否则所有受保护路由返回 503。它只绑在 `127.0.0.1`，喂进去的是用户自己的对话图，所以插件起进程时带上 `SEMANTICA_ALLOW_ANONYMOUS=true`（上游为此提供的显式开发开关）。

---

## 界面

### 为什么内嵌 iframe，不用 better-sidebar 的 browser 标签

后者的壳里有一条**删不掉**的状态行——`SandboxStatusBar` 在 `BrowserView` 里是无条件渲染的，整个插件没有任何隐藏它的设置，只有「沙箱开＝绿杠」和「沙箱关＝红杠」两种状态，而关掉沙箱会把 Explorer 页面变成与 GUI 同源、拿到完整会话权限（更糟）。

自己渲染 iframe 就没有那层壳，顺带也不再需要用户去配 `browserAllowedLoopback`。sandbox 令牌由插件自己写，与 better-sidebar 给「已放行回环地址」的那串逐字相同：`allow-same-origin` 必须有（否则 SPA 白屏），而刻意不含 `allow-top-navigation`（页面因此无法把主窗口导航走）。Explorer 在 `127.0.0.1:<另一个端口>`，与 GUI 端口不同，因此**仍是跨源**——拿不到 GUI 的 DOM、Cookie 与内部接口。

代价是失去 URL 栏与前进后退，所以插件自己补了「重新抽取」文字按钮和 `↻` 刷新、`⤢` 重新打开、`↗` 在浏览器打开三个图标。

### 布局演进（两次返工）

**第一版**：控制面板和信息页是两个标签。点按钮 → 看到信息 → 再手动点「打开完整 Explorer」才看到图。反馈是「太粗暴了，为什么不能套 iframe，上面做个工具栏」。信息和图本来就该一起看。

**第二版之前**：图建好后**自动打开 Explorer 标签**，理由是「用户点按钮就是为了看图」。但它把刚打开的控制面板顶掉——第一次点头部图标，面板刚出现就被 Explorer 替换，用户看到的是 semantica 界面，四个分析按钮压根没机会被看到，得再点一次图标才回得来。

**现在**：合成一页。工具栏（左信息 / 右按钮）+ 内嵌 iframe。工具栏分两行，因为四个分析按钮合计约 380px，和 233px 的信息区放不进 320–420px 的侧边栏。

### 一个只有真浏览器才能发现的 CSS 坑

第一版工具栏把八个按钮塞进同一个 `flex-wrap` 容器：

```css
/* 错的 */
.semg-toolbar-actions{display:flex;flex-wrap:wrap;flex:0 0 auto}
```

`flex:0 0 auto` 的第三个值是 flex-basis，`auto` = **内容宽度**（八个按钮约 625px）。容器自己不收缩，内部的 `flex-wrap` 就永远不触发——它以为宽度够，实测在 320px 侧边栏里横向溢出 **315px**，按钮被裁掉一半。改成 `flex:0 1 auto` + `min-width:0` 才会换行。

**七个单元测试当时全是绿的**：`renderToString` 只吐 HTML 字符串，不含任何几何信息。所以加了 `scripts/visual-check.mjs`（`npm run visual`）——真 Chromium 在 300/320/420/520/640/720 六个宽度下量溢出、量重叠、量「工具栏 + 图 = 面板高度」，并确认 iframe 里真的渲染出了 Explorer（跨源 + sandbox 下会不会白屏）。

### 客户端不需要构建步骤

只依赖 `react`（在基座冻结表里），没有第三方库要内联。早期为了 cytoscape 搞了一个 458KB 的构建产物，现在 `src/client.js` 就是加载的成品。

---

## 性能

以一段真实会话为例（1.5 小时、336 条助手回复、5 条真人消息、631 次工具调用，正文约 3.6 万字符）：

| 阶段 | 耗时 |
| --- | --- |
| Python 冷启动 + `import semantica` | ~2–3s（仅首次） |
| spaCy 模型加载 | ~1–3s（仅首次） |
| 实体抽取（341 段正文） | ~3–4s |
| 关系抽取 | ~1–2s |
| 写 ContextGraph + Explorer 启动就绪 | ~4–5s |
| **合计（首次）** | **~12.6s** |
| **再次点击（复用已跑的实例）** | **~1.4s** |

早期版本要 25s，因为那时把模型的 reasoning（54 万字符）也喂进了 NER；排除之后输入降到 5.5 万字符，耗时随之腰斩。

---

## 已知限制：语义相似度

Explorer 里「语义相似度」会报 no node embeddings。这是**已知限制，不是故障**。Explorer 的语义相似度（`/api/graph/semantic-neighborhood`、搜索结果里的 `semantic_similarity` 字段）不自己算 embedding，只从节点属性里读（`embedding` / `node2vec_embedding` / `vector` 等键），而本插件构建 ContextGraph 时没有写入这些字段。

没有一并做的原因是性价比：为了这一个特性要在首次使用时下载 sentence-transformers 模型（约 80MB），并给每次建图都加一轮 embedding 计算；而**图搜索、查重、连接预测、出处、本体、决策链都是正常的**——实测 Explorer 的 78 个接口里，18 个无参可直接返回，另有 30 多个带上参数即正常，受影响的只有语义相似度这一项。

要自己补上的话：`semantica.embeddings.EmbeddingGenerator` 可用，给实体节点写一个 `embedding` 属性即可（`sentence_transformers` 与 `torch` 已随 semantica 一并装好）。

---

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `src/index.js` | host 半侧：注册 `/api-semantica/{status,prepare,analyze}`，编排「读会话 → 建图 → 起 Explorer」与「建新对话」 |
| `src/session-reader.js` | 解多帧 zstd 日志、解析事件、抽对话结构；走 `sessionPersistence.list/locate`，回退扫 `$DSH_HOME/sessions` |
| `src/semantica-bridge.js` | 常驻 Python worker 的 NDJSON 桥；懒启动、空闲 10 分钟回收、超时与错误传播 |
| `src/explorer.js` | `semantica-explorer` 子进程管理：空闲端口分配、健康检查、就绪超时、按会话缓存、总量上限、空闲与 LRU 回收，以及依赖探测 |
| `src/analyze.js` | 四段分析提问 + digest 组装 + 开新对话并注入。零外部依赖（原因见 [`2026-09-16-ai-analysis-new-conversation-design.md`](2026-09-16-ai-analysis-new-conversation-design.md)） |
| `src/graph_worker.py` | Python 侧：markdown 归一化、逐段抽实体/关系、组装 ContextGraph 并落盘 |
| `src/client.js` | 浏览器半侧：头部按钮 + 控制面板（工具栏 + 内嵌 Explorer 的 iframe）+ 独立的 Explorer 标签（放大用） |
| `scripts/install.mjs` | 装/卸 profile，自动备份 manifest |
| `scripts/check-inject.mjs` | 用 Proxy 模拟 Cordis 的取值语义，检查两半侧没有访问未注入的服务 |
| `scripts/visual-check.mjs` | 真 Chromium 下量排版并确认 iframe 里渲染出了 Explorer |

架构：

```
浏览器                                        宿主进程                          Python
┌────────────────────┐                ┌──────────────────────────┐    ┌────────────────────┐
│ 头部按钮            │                │ /api-semantica/prepare   │    │ graph_worker.py    │
│  └ 打开控制面板     │─── POST ─────▶│ /api-semantica/analyze   │───▶│  ├ NER             │
│ 控制面板 tab        │                │   ├ session-reader       │    │  ├ RelationExtract │
│  ├ 工具栏第1行      │                │   ├ bridge（常驻 worker）  │NDJSON│ └ ContextGraph     │
│  │  ├ 左：基本信息  │◀── URL+stats ──│   ├ explorer（进程管理）   │    │ └ ContextGraph     │
│  │  └ 右：工具按钮  │                │   └ analyze（建新对话+注入）│    └────────────────────┘
│  ├ 工具栏第2行      │◀── sessionId ──│  127.0.0.1:<动态端口>      │◀─── semantica-explorer
│  │  └ 四个分析按钮  │                └───────────┬──────────────┘
│  └ iframe: 上游 UI  │◀─── iframe ────────────────┘
└────────────────────┘                            │ sessionController.create
                                        ┌─────────▼──────────┐
                                        │ 新对话（会话列表）   │
                                        └────────────────────┘
```
