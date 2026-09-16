# dsh-semantica-graph

在 DSH 里把**当前对话**变成一张知识图谱，用 [Semantica](https://github.com/semantica-agi/semantica) 自带的 Knowledge Explorer 浏览，还能一键开条新对话让 AI 来读这张图。

---

## 这个插件建立在什么之上

[Semantica](https://github.com/semantica-agi/semantica) 是一个 Python 知识图谱平台。插件真正 `import` 它、调它的类，不是另写一个像它的东西：用它的 `NamedEntityRecognizer` 和 `RelationExtractor` 抽实体与关系，用它的 `ContextGraph` 建图，再把它自己的 Explorer 拉起来给你看。

**界面是 Semantica 的原版，插件一帧都不画。** Explorer 直接嵌在侧边栏的 iframe 里，所以上游有多少能力你就有多少：

| Semantica 提供 | 数量 |
| --- | --- |
| 顶层命令组 | 22 个（ingest / kg / reason / ontology / provenance / export…） |
| Explorer REST 接口 | 78 个 |
| Web workspace | 6 个 |

早期版本用 cytoscape 自己画过一张图，那等于把 Semantica 当成一个 spaCy 包装来用，能力上限被自己锁死。现在插件只做三件事：**读会话 → 建图 → 把上游界面拉起来**。

---

## 它能做什么

**把对话画成图。** 点会话标题右边的图谱按钮，右侧栏展开面板：上面是工具栏，下面是 Explorer。轮次、消息、工具调用、实体、关系都在图里。

```
┌──────────────────────────────────────────────┐
│ ⬡ 2186 节点 2737 边 226 实体 253 关系  ↻ ⤢ ↗ │ ← 左：图的基本信息
│ [复盘这次对话][理解图数据][检验抽取质量][建议] │ ← 四个 AI 分析按钮
├──────────────────────────────────────────────┤
│        Semantica Knowledge Explorer          │
│               （上游原版界面）                 │
└──────────────────────────────────────────────┘
```

工具栏右边一排：「重新抽取」是文字按钮，其余收成图标——`↻` 刷新、`⤢` 重新打开（在独立标签页里放大）、`↗` 在浏览器打开。图标的中文全称在鼠标悬停时有提示。

**决策链。** Explorer 左侧有个 Decisions 区。插件会把对话里的提问工具（`ask_user_question`）解析成决策节点——你当时问了什么、每个选项什么意思、你最终选了什么、被放弃的选项有哪些——在 Explorer 里连成因果链。这是对话里唯一结构化的决策记录，别的决策都埋在自然语言里，抽出来不可靠，所以不做。

**让 AI 分析这张图。** 工具栏第二行四个按钮，每个对应一种提问：

- 复盘这次对话
- 理解图数据
- 检验抽取质量
- 给当前任务的建议

点下去会**新开一条对话**（出现在侧边栏会话列表里，可以继续追问），把抽好的图数据注入进去当背景，然后跳过去。不塞进当前对话，是因为图数据有几 KB，留在上下文里之后每一轮都得背着它。

**中英混聊不用管。** 插件按 CJK 字符占比给每一段自动选抽取器：中文段走 `zh_core_web_sm`，其余走 `en_core_web_sm`。

---

## 相比直接用 Semantica，插件补了什么

Semantica 不认识 DSH，这些都得插件来做：

- **读 DSH 会话日志**。多帧 zstd 的 `session.jsonl.zstd`，从里面还原轮次、消息、工具调用。
- **只抽真人说的话**。系统注入的内容（运行时上下文快照、后台任务通知、技能目录）动辄几千字，放进来会把真实对话淹没，默认跳过。
- **不抽模型的思考过程**。assistant 消息里 `reasoning` 块的体量远大于正文——实测一段 1.5 小时的会话是 33,831 字符对 544,010 字符，相差 16 倍。喂进去的话图基本是照着思考过程画的，而且思考是英文自我对话，spaCy 会把 `Let` / `Hmm` / `first` 当实体。排除之后喂给 NER 的正文从 42 万字符降到 5.5 万，建图 25s → 12.6s。
- **markdown 先清洗**。代码块整块丢弃，行内代码只去反引号保留内容——否则会抽出 `` `conversation `` 这种带反引号的脏实体。
- **工具调用不进语义抽取**。它们的文本是 "Check working directory contents" 这种界面标签，spaCy 会把开头的动词当实体，实体榜前几名全是 `Read` / `Verify` / `Find`。丢掉后实体数 525 → 123，剩下的基本全是真实概念。
- **决策层**（见上一节）。
- **AI 分析用的 digest**：把图压成一份带摘要和钻取接口清单的文本。新对话自己带 bash，可以按清单用 `curl` 查更细的数据。

每条取舍的实测数字、踩过的坑，写在 [`docs/internals.md`](docs/internals.md)。

---

## 安装

### 前置条件

| 需要 | 说明 |
| --- | --- |
| DSH Desktop | 需要能跑 web profile。CLI 版（`dsh web`）同样可用 |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Python 3 | Semantica 声明 `>=3.8`；实测跑通的是 3.12.7 |
| `dsh-better-sidebar` | 侧边栏容器，**必须装** |

### 第 1 步：装 Semantica 和 Explorer

**装进独立 venv，别装进 conda base。** Semantica 会拉 numpy / spacy / transformers / torch，塞进共用环境会和既有包的版本约束打架——实测装进 anaconda base 后 numpy 被升到 2.0.2，sklearn / gensim / spacy 全部 `numpy.core.multiarray failed to import`。

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

两处容易漏，都会**不报错但结果不对**：

- **`[explorer]` 不能省。** Explorer 是可选 extra，裸装不会带 fastapi / uvicorn，`semantica-explorer` 一起来就退出。插件在 `/api-semantica/status` 里会探这几个依赖，缺了直接告诉你该跑哪条命令。
- **两个 spaCy 模型都得装。** Semantica 内部把模型名硬编码成 `en_core_web_lg/md/sm`，缺模型时它**静默退化成正则兜底**，抽出来的实体 label 全是 `UNKNOWN`。中文尤其明显：用英文模型跑中文，spaCy 会把整句话当成一个实体。

插件按这个顺序找解释器：环境变量 `DSH_SEMANTICA_PYTHON`（或 `DSH_SEMANTICA_PYTHON3`）→ `$DSH_HOME/semantica-venv/bin/python` → `$DSH_HOME/.dsh/semantica-venv/bin/python` → 插件目录旁的 `.venv/bin/python` → `python3`。

### 第 2 步：装插件本体

```bash
cd /path/to/dsh-semantica-graph
npm install              # 只装 fzstd，用来解 DSH 的多帧 zstd 会话日志
node scripts/install.mjs
```

`install.mjs` 会备份原 manifest，往 `$DSH_HOME/profiles/web/package.json` 里加一条 `link:` 依赖和一条同样的 `pnpm.overrides`，把插件加进 `dsh.profile.bundles`，然后跑一次 pnpm。脚本幂等，可以从任何目录执行。

```bash
node scripts/install.mjs --dry-run   # 只打印将要做的事
node scripts/install.mjs --remove    # 从 profile 移除
```

> 这是 `link:` 安装，DSH 直接引用插件目录。**别移动或删除这个目录。**

### 第 3 步：重启 DSH Desktop

**完全退出再启动，不能只刷新页面。** 客户端半侧（按钮 + 面板）是热加载的，硬刷新（Cmd/Ctrl+Shift+R）就能生效；host 半侧（`/api-semantica/*` 路由）只有重启才会注册。

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

**② Python 侧就绪**（端口换成你的实际 GUI 地址）

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

打开任意会话 → 点标题右边的图谱按钮 → 面板出现，几秒到半分钟后 Explorer 显示出来。

---

## 用法

点会话标题右边的图谱按钮，侧边栏出现面板。图的构建结果会缓存：第二次点只要 1.4s 左右，重新抽取一次约 12.6s。会话在图上一次构建之后又有新内容时，工具栏会出现「图已过期」标记，点「重新抽取」重建。

想放大看图，点 `⤢` 开一个独立标签页。

---

## 卸载

```bash
cd /path/to/dsh-semantica-graph
node scripts/install.mjs --remove     # 从 profile 摘掉，并跑一次 pnpm
```

然后重启 DSH Desktop。这只移除插件引用，不会删插件目录，也不会动 venv。要连 Python 侧一起清掉：

```bash
rm -rf "$DSH_HOME/semantica-venv"
rm -rf "$DSH_HOME/dsh-semantica-graph"   # 落盘的图
```

---

## 常见问题

**启动时弹出「Failed to load plugins / cannot get property "x" without inject」**

插件加载失败，不是运行时报错。成因是某一半侧的 `apply(ctx)` 访问了没写进 `inject` 数组的服务属性——Cordis 的 ctx 是服务代理，未声明的服务属性直接抛。

改完插件后先跑 `node scripts/check-inject.mjs`，它用 Proxy 模拟 Cordis 的取值语义。

反方向也有个坑：客户端 fiber 会**等待** inject 里的服务就绪，声明一个永远不存在的服务会让插件永远不 apply，而且**不报错**。

⚠️ **加载失败后 DSH 会把这个插件静默卸载**——从 `dsh.profile.bundles` 摘掉条目并跑一次 pnpm，于是依赖声明和 `node_modules` 软链也一起没了。表现是「文件都在，但插件像是没装过」。修好后必须重新 `node scripts/install.mjs`。

**按钮点了没反应**

没装 `dsh-better-sidebar`。插件本身仍会正常加载（它是可选的晚挂载服务，用 `ctx.inject` 延迟注册），只是没有容器可以显示。

**界面全是英文（中文环境下）**

`locale` 服务没有 `current()` 方法，快照上的字段也不叫 `language` / `locale`——它叫 `active`。正确的读法是 `ctx.get("locale").getLocale().active`。服务整个取不到时会退到 `navigator.language`。

**实体全是 `UNKNOWN`，或者中文整句被当成一个实体**

spaCy 模型没装全，回到第 1 步把两个都装上。建图结果里的 `engine.zhModelInstalled` 会告诉你中文模型到底在不在。

**图是空的 / 只有几个节点**

插件只抽真人发的消息（`source.kind === "user"`），系统注入的内容默认全部跳过。这个会话本身几乎没有真人输入的话，图自然就小。纯 markdown 代码块占比很高的对话同理。

**面板上统计数字都在，但下面的 Explorer 一片空白**

`127.0.0.1:<端口>` 上那个进程已经退出了（空闲 10 分钟自动回收）。点工具栏的 `↻`（刷新）重挂 iframe，或点「重新抽取」另起一个。

面板显示「还没有图」是另一回事——这个会话还没建过图。

**面板报 `explorer-unavailable`**

缺 Explorer 组件。按面板里给的命令装：`<venv>/bin/pip install "semantica[explorer]"`。

**`/api-semantica/status` 返回 404**

没重启 DSH Desktop。

**时间轴显示 `1970 → 2030`**

这俩是 Explorer 前端在拿不到时间边界时的硬编码兜底值（`r?.minDate ?? "1970"`）。真出这个值说明图里一个 `valid_from` 都没有。

如果时间整体偏移 8 小时，那是时区约定问题——插件必须写**不带时区偏移的本地时间**，写了偏移会前后端差 8 小时。自查：

```bash
curl -s http://127.0.0.1:<explorer端口>/api/temporal/bounds
```

**Explorer 里「语义相似度」报 no node embeddings**

已知限制，不是故障。Explorer 不自己算 embedding，只从节点属性里读，而本插件建图时没写这些字段。没做的原因是性价比：为这一个特性要在首次使用时下载约 80MB 的 sentence-transformers 模型，并给每次建图加一轮 embedding 计算。图搜索、查重、连接预测、出处、本体、决策链都正常。

**Explorer 里显示「Something went wrong in this view.」**

这句是 Semantica Explorer 自己的错误边界，不是 DSH 也不是本插件的。真正的报错在浏览器控制台里（**Cmd+Option+I**），通常长这样：

```
Sigma: Coordinates of node ent:北京 are invalid.
```

原因是 Explorer 前端拿 `→`(U+2192) 当内部边键分隔符拼字符串再拆回来，节点 id 或边端点里带 `→` 就会拆错位、补出一个没有坐标的节点。`→` 很容易混进来，因为实体名直接取自对话文本（比如你在对话里写过「张三→PERSON」）。本插件从 **0.3.1** 起把 id 里的 `→` 换成 `_`（只清 id，label / content 保留原样），建图结果里的 `renamedIds` 会告诉你有几个被改名。

碰到这个错误：先点「重新抽取」重建图谱（Explorer 只在启动时读一次图，正在跑的实例内存里还是坏数据），还不行就硬刷新（**Cmd+Shift+R**）再看控制台。

---

## 依赖的插件

侧边栏由 [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) 提供，插件用它注册两个标签类型（控制面板、Explorer 界面）并打开标签。没装的话按钮还在，点了会在控制台给提示，什么都不显示。

不需要配「浏览器本地回环允许清单」：插件在自己的标签里直接写 iframe，`allow-same-origin` 由插件自己加（不加 SPA 会白屏），并刻意不含 `allow-top-navigation`，页面因此无法把主窗口导航走。Explorer 跑在另一个端口上，与 GUI 仍是跨源。

---

## 更多

- [`docs/internals.md`](docs/internals.md) —— 抽取层的每条取舍与实测数字、决策层因果链、时区约定、性能
- [`docs/2026-09-16-ai-analysis-new-conversation-design.md`](docs/2026-09-16-ai-analysis-new-conversation-design.md) —— AI 分析功能的设计（为什么开新对话、走 sessionController、注入怎么拆两条消息）

开发时：

```bash
npm run check     # 语法 + inject 契约自检
npm run visual    # 真 Chromium 量排版（溢出 / 重叠 / 高度）
```
