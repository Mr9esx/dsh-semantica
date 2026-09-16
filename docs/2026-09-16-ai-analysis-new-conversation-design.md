# 设计：AI 分析新对话

日期：2026-09-16
状态：已实现（v0.7.0）
修订：第一版做成「子代理」后被否，改为「新对话」——见 §1.5；第二版把界面拆成
「信息页 → 手动开图」两步也被否，改成工具栏 + 内嵌 iframe 的一页式布局 —— 见 §6

## 需求

用户原话：

> 我们这个插件能加一个能力吗，就是新开一个子对话，注入让 semantica 解析完的数据，让 AI 去分析

后续澄清与修订：

1. **入口形态**：「分别做几个按钮：复盘对话、理解图数据等」—— 一个分析目的一个按钮。
2. **注入深度**：「两者结合：摘要打底 + 可钻取」—— 既注入压缩摘要，也给新对话 Explorer 地址和端点清单让它自己钻。
3. **形态修正**（试用后）：「点击了分析，怎么是开子代理去跑的，直接开新对话吧」—— 不要 subagent，要普通会话。
4. **发现性修正**（试用后）：「没看到按钮啊」—— 第一次点击被自动跳转的 Explorer 顶掉了控制面板。
5. **布局修正**（试用后）：「太粗暴了，你现在就是直接跳到一个信息页面，然后让用户手动点 Explorer？为什么不能套 iframe 呢？然后上面做成一个类似工具栏一样，左边是基础信息、右边是按钮」——
   一页式：工具栏（左信息 / 右按钮）+ 内嵌 iframe。见 §6。

## 交互

四个按钮，加在**插件自己的控制面板 tab**（`LauncherView`）的工具栏第二行。不往
semantica 的 SPA 里塞，那是上游打包好的界面，改不了。

按钮的 `title` 里带一句 `analyze.tip`（「会新开一个对话，先把这张图的数据注入进去」）——
按钮本身只写了分析目的，不说明会跳到别处，用户点下去才发现就太晚了。

| 按钮 | kind | 新对话要回答的 |
|---|---|---|
| 复盘这次对话 | `retro` | 做了哪些选择、哪些走了弯路、代价在哪 |
| 理解图数据 | `structure` | 图结构解读：关键节点、社群、关系类型分布 |
| 检验抽取质量 | `quality` | 哪些是噪音、哪些漏抽了、关系方向对不对 |
| 给当前任务的建议 | `advice` | 结合图里的实体关系对手上的活给建议 |

按钮状态**不复用面板的 `phase`**：分析失败不该把整个面板打成错误页（图还好好的），
结果单独存 `analysis` 状态，内联显示在按钮下方。

## 数据流

```
LauncherView 点按钮
  → POST /api-semantica/analyze { sessionId, kind }
  → 宿主：
      ① 图在缓存里就用，不在就 prepareGraph() 补一次
      ② readGraph() 读图 JSON → buildDigest() 组装摘要
      ③ 找父会话所属 workspace
      ④ sessionController.create({ workspaceId })   → 新对话
      ⑤ sessionController.selectModel({ 继承父的 provider/model })
      ⑥ agent.inject(digest)      source:{kind:'plugin'}
      ⑦ sessionController.prompt({ content:[提问] })
  → 返回 { ok, sessionId, label, digestChars, injected, drillable }
  → 客户端 ctx.sessions.open(sessionId) 直接切过去
```

## 关键决策

### 1. 开新对话，不注入当前对话

图数据 6-7KB。直接塞进当前对话会永久占住上下文，之后每轮都背着它；分析结果也会
和正在做的事混在一条时间线上。

### 2. 走 sessionController，不走 agents.create

`ctx.get('sessionController')` 就是 GUI「新建对话」用的路径：

```js
create({ workspaceId | cwd })      // 空会话 → { sessionId }
selectModel({ sessionId, ... })    // 选模型
prompt({ sessionId, content })     // 第一条用户消息（内部 agent.followup）
```

`agents.create()` 是 subagent 的接缝：必须传 `meta.origin:'subagent'` +
`parentSession`，产物进「子会话」页签、受父子关系约束，还要自造 seed。第一版用的
就是这个，用户实测后否掉。

### 3. workspace 必须挂

`create()` 只在传了 `workspaceId` 时才 `attachSession()`，而 GUI 的会话列表**按
workspace 分组**（`workspaces.find(w => w.sessionIds.includes(id))`）。不挂进去，
新对话建了也找不到。

定位方式：`workspaceRegistry.list()` 里找 `sessionIds.includes(parentSessionId)` 的
那个（`WorkspaceEntity.id` 是类字段，不是 getter）；退化方案是 `resolveByPath(cwd)`。

`attachSession()` 会 realpath 校验会话的 cwd（存在、是目录、与 workspace 路径一致），
不过就抛错 —— 那会**一条对话都建不出来**。所以 `create()` 失败时退回 `cwd` 重试：
会话仍可用，只是不出现在侧边栏列表，比整个失败强。

### 4. 两条消息：inject 背景 + prompt 提问

`inject` = 排队中的模型可见上下文，不唤醒驱动；`prompt` = `agent.followup()`，唤醒。

拆开是为了日志里留两条 `user/message`：plugin 来源那条被 UI 折叠成 context 行，
提问才是正常用户气泡。合并会让几 KB 数据糊在用户气泡里。

`selectModel` 不能跳过：新会话没有任何模型选择，不选的话 `prompt` 会以
`model-unavailable: no adapter serves provider "..."` 拒绝。从父会话继承
provider / model / reasoningEffort。选模型失败不致命，只记 warn。

### 5. `src/analyze.js` 零外部依赖

`createUserMessage` 上游是纯函数（`MessageId(id){return id}` 零校验），可手写。

不 import 的原因：**插件是 `link:` 安装的**，真实路径在 `~/Downloads/`，
`profiles/web/node_modules/dsh-semantica-graph` 只是相对软链。Node 的 ESM 解析会先
把软链折成真实路径（实测报错里就是 `~/Downloads/.../analyze.js`），父级向上走够不到
`$DSH_HOME/profiles/node_modules/@deepseek-ai/*`。

| 做法 | 最坏结果 |
|---|---|
| import | 解析不了 → 整个插件加载失败，`apply` 不执行，图谱功能一起挂 |
| 手写 | 消息少个字段 → 主功能不受影响 |

### 6. 界面：工具栏 + 内嵌 iframe，一页搞定（两次修订）

**第一版：两个标签页。** 点按钮 → 控制面板显示信息 → 再手动点「打开完整 Explorer」
才看到图。

**第二版：去掉手动那一步，但引入了新问题。** 图建好后自动打开 Explorer 标签，
理由是「用户点按钮就是为了看图」。结果它把刚打开的控制面板顶掉：

```
第一次点头部图标 → 控制面板刚出现 → 立刻被 Explorer 标签替换
                → 用户看到 semantica 界面，四个分析按钮压根没机会被看到
                → 得再点一次图标才回得来
```

**第三版（现在）：合成一页。**

```
┌──────────────────────────────────────────────┐
│ ⬡ 2186 节点 2737 边 226 实体 253 关系   […]  │ ← 第 1 行：左信息、右工具按钮
│ [复盘这次对话][理解图数据][检验抽取质量][建议] │ ← 第 2 行：四个分析按钮
├──────────────────────────────────────────────┤
│        Semantica Knowledge Explorer          │ ← iframe，flex:1 吃掉剩余高度
└──────────────────────────────────────────────┘
```

为什么工具栏分两行而不是一行：四个分析按钮合计约 380px，加上信息区约 233px、
工具按钮约 180px，一行在 320-420px 的侧边栏里放不下。硬塞进一个 `flex-wrap`
容器反而出了 bug（见下）。

#### 一个只有真浏览器才能发现的 CSS 坑

```css
/* 错的 */
.semg-toolbar-actions{display:flex;flex-wrap:wrap;flex:0 0 auto}
```

`flex:0 0 auto` 的第三个值是 flex-basis，`auto` = **内容宽度**（八个按钮约 625px）。
容器自己不收缩，内部的 `flex-wrap` 就永远不触发 —— 它以为宽度够，实际溢出 315px，
按钮在 320px 侧边栏里被裁掉一半。改成 `flex:0 1 auto` + `min-width:0` 才会换行。

**所有单元测试当时都是绿的**：`renderToString` 只吐 HTML 字符串，不含任何几何信息。
于是加了 `scripts/visual-check.mjs` —— 真 Chromium 在 300/320/420/520/640/720 六个宽度
下量溢出、量重叠、量「工具栏 + 图 = 面板高度」，并确认 iframe 里真的渲染出了
Explorer（跨源 + sandbox 下会不会白屏）。

### 7. digest 的结构

`buildDigest()` 纯函数，约 6-7KB（≈2600 token）：

1. 头部：说明这是 Semantica 抽的原生 ContextGraph，不是对话复述
2. 图规模 + 节点/边类型分布
3. **决策全量**（category / scenario / reasoning / outcome / alternatives / choiceKind）
4. 时间线（起止 + 按小时密度 Top 5）
5. 高频实体 Top 40、关系 Top 30
6. **钻取接口清单**：Explorer 基址 + 17 个实测可用端点 + 5 条踩过的坑。
   清单里还写了「路由的权威来源是 `GET <base>/openapi.json`」——这份清单曾经凭印象
   写错过 6 条路径（`/api/analytics/centrality`、`/api/analytics/communities`、
   `/api/search?q=`、`/api/graph/nodes/<id>`、`/api/graph/neighbors/<id>`、`?hops=`
   参数名），喂给模型全是 404，所以现在把权威来源交出去，让模型自己核对。
   用 `node scripts/check-endpoints.mjs` 对账（拿真实 openapi.json 逐条比）。

Explorer 没起来时降级成纯摘要，digest 里标注「无法钻取」。

## 错误处理

全部返回结构化 `code`，不抛异常。宿主 `inject = []`，硬依赖会让插件整个加载不起来。

| code | 触发 |
|---|---|
| `session-controller-unavailable` | `ctx.get('sessionController')` 缺失 |
| `parent-not-live` | 父会话没有在运行，拿不到 cwd / preset / 模型 |
| `create-failed` | 所有 create 尝试都失败 |
| `prompt-failed` | 对话建好了但提问失败（仍回报 `sessionId`） |
| `graph-missing` | 读不到图文件 |
| `unknown-kind` | 未知的分析类型 |

## 测试

`/tmp/test_analyze.mjs`，60+ 项断言，两半：

- **UI**：真 React 渲染 `LauncherView`，中英各一次，断言 `semg-analyze` 区块、
  四段文案、恰好 4 个按钮、初始可用
- **宿主**：mock ctx 跑 `createAnalysisSession`，断言
  - 走 `sessionController`，且 **`agents.create` 调用次数为 0**（防退回子代理）
  - 调用顺序 `create → selectModel → 取 agent → inject → prompt`
  - `workspaceId` 优先、退回 `cwd`、workspace 挂载失败时重试
  - 两条消息的来源标记（`plugin` / 提问内容）
  - 模型继承（provider / model / reasoningEffort）
  - 拿不到 agent 时不阻断，但 `injected:false`
  - 五条失败路径都返回正确 code 且不抛

`/tmp/test_digest.mjs` 覆盖 digest 组装（真实 2186 节点图）。

`scripts/visual-check.mjs`（`npm run visual`）是真浏览器排版检查，见 §6。

## 未做

- ②本体（`ClassInferencer` → `OWLGenerator` → `POST /api/ontology/load`）
- ③词表（`POST /api/vocabulary/import`）
- ④记忆（用户明确「不需要 / 先不做」）

## 端点清单的维护

digest 和「理解图数据」的提问里都直接写了端点路径。这些路径写错的后果很隐蔽：
上游返回的是 `{"detail":"API route not found"}`，模型多半会把它当成「这张图没数据」，
而不是「路径写错了」——分析质量静默变差，没人会发现。

所以加了两道防线：

1. digest 里明确写出**权威来源是 `GET <base>/openapi.json`**（78 个 path / 82 个 operation），
   并提示写错时返回的是那个 detail 字符串。
2. `node scripts/check-endpoints.mjs` 拿真节点 id 把每个端点**实际调一次**。只查路由存在
   是不够的——实测 `/api/graph/node/<id>/path` 在 openapi 里**存在**、路由检查会通过，但对
   任何 id 都返回 404 `Source node ... not found`。实调这一步又抓出两个：`?limit=` 空值会被
   FastAPI 判 **422**（`Input should be a valid integer`），digest 里照抄那个字面量就会拿到 422。
   digest 里刻意写成「别用」的两条（不可用的 `/path`、会 503 的 `semantic-neighborhood`）
   用行尾 `// check-endpoints: ignore` 排除，免得把警告当成推荐用法。

实测（446 节点 / 519 边的真实图）确认过的几个事实：

- 邻居和因果链**都只走出边**。`/api/graph/node/ent:xxx/neighbors` 对纯被提及的实体返回
  `[]` —— 因为它只有入边，不是接口坏了。decision 节点则能正常返回 `decided_at` /
  `next_decision` 两条邻居。
- `/api/graph/stats` 的 `density` 按有向算 `E/(N(N-1))`，`/api/analytics` 的
  `connectivity.density` 按无向算 `E/(N(N-1)/2)`，后者恒为前者的两倍
  （同一张图：0.002615 对 0.005230）。两个都对，别混着比。
- 搜索有两条路：`GET /api/graph/nodes?search=` 会给全部命中（实测 54 条），
  `POST /api/graph/search` 走相关性排序、默认 limit 20。
- **实体层的边是锚点局部的**：一个实体只连到字面包含它的那段文本。所以用户贴的关键证据
  （报错原文）不会连到讨论它的 assistant 消息上，除非那些消息也字面提到了同一串词。
  实测：讲「构建失败」的 3 条 assistant 消息各带 7/6/5 个实体，但没有一个是那条证据。
  这是 mention 式抽取的固有性质，不是图坏了——模型分不清「抽样损失」和「抽取缺陷」，
  所以 digest 里现在把这句话直接写给它。

## 已知限制

- **宿主半侧改动需要重启 DSH**。实测：改完后 `POST /api-semantica/prepare` 仍 200
  （插件活着），但 `POST /api-semantica/analyze` 返回 405、`GET` 返回 404 —— 新路由
  没注册。客户端半侧是热加载的（硬刷新即可），宿主侧不是。
- 若 workspace 挂载失败退化到 `cwd`，新对话不会出现在侧边栏列表里，只能在
  返回的 `sessionId` 上找到。
