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
┌────────────────────────────────────────────────────────────────┐
│ ⬡ 2186 节点 2737 边 226 实体 253 关系 [图已过期] [重新抽取] [⧉ …json] │ ← 第 1 行
│ [复盘这次对话][理解图数据][检验抽取质量][建议]   [⧉ 在浏览器打开] │ ← 第 2 行
├────────────────────────────────────────────────────────────────┤
│                Semantica Knowledge Explorer                    │ ← iframe，flex:1
└────────────────────────────────────────────────────────────────┘
```

**两行的分工**

第 1 行：图标 / 四个统计 / 过期标记（12px）/ **重新抽取** / 路径 chip —— 都是「这张图是什么、
它现在怎么样、以及最直接的补救动作」。

第 2 行：左边四个分析按钮（都是「新开一个对话去做 XX」），右边「在浏览器打开」。

右侧原本还有 `↻` 刷新和 `⤢` 重新打开（在侧边栏另开一个整屏标签）。两个都删了：

- **`↻` 刷新**（重挂 iframe、不重跑抽取）删掉后，面板内没有手动重载入口了。但那不是
  能力丢失 —— 面板改成每次「收起 → 展开」都重新 prepare 一次，Explorer 挂掉时宿主会
  重拉 worker、换新端口，url 变了 iframe 自然重挂。比一个要用户自己去点的按钮更省事。
- **`⤢` 重新打开**是 `ExplorerView` 唯一的入口，删掉之后那套（`ExplorerView` /
  `openExplorerTab` / 第二个 tab 注册 / `dedupeKey`）就彻底到不了了，所以一并删除。
  想看大图用「在浏览器打开」，视口更大还能用 devtools。

留下的那个从字符 `↗` 换成了「开口方框 + 从角上射出的箭头」，并且**带上文字**。
单个斜箭头在 UI 里至少有四种读法（分享 / 上传 / 跳转 / 放大），当初三个纯图标并排、
各自只有 hover 提示，主人的反应就是「这两个按钮是干嘛用的」—— 那本身就是设计问题。

第 2 行两块用 `margin-left:auto` 右对齐而不是竖线分隔：它们都是「操作」，加分隔线反而
像两个区块。

（**两次修订**。最初是「第 1 行左信息右全部控制按钮、第 2 行四个分析按钮」；反馈
「重新抽取那些按钮，放在下面那行吧」后搬到第 2 行；再反馈「重新抽取放在图已过期 tag
右边」后，它又回到第 1 行、紧跟标记。

来回搬是有道理的：`重新抽取` 和「图已过期」是**同一条消息的「症状 + 处理」**——分开在
两行里，看到「图已过期」的人还得自己去找补救按钮。它是唯一一个和第 1 行信息强绑定的
操作，其余那些（视野调整）留在第 2 行。

代价见下面那张表：第 1 行多一个 66px 的按钮，路径 chip 的同行门槛从 640 涨到 700。）


宽度不够时控制按钮会换到下一个视觉行（**仍在分析按钮下方，永远不会跑到上面**）。
实测：

| 面板宽 | 信息高 | 路径 chip | 分析按钮 | 控制按钮 | 工具栏高 |
|---|---|---|---|---|---|
| 300px | 79（三行） | y71 换行 | y93 | y157 换行 | 194 |
| 420px | 52（两行） | y44 换行 | y66 | y98 换行 | 135 |
| 520px | 52（两行） | y44 换行 | y67 | y66 **同行** | 103 |
| **600px** | 52（两行） | y44 换行 | y67 | y66 **同行** | 103 |
| **640px** | 52（两行） | y44 换行 | y67 | y66 **同行** | 103 |
| 720px | **26（一行）** | y13 **同行** | y41 | y40 同行 | **77** |

两组按钮的同行门槛是 **600px**；路径 chip 和统计数字同行的门槛是 **700px**。

**这个门槛会跟着第 1 行的内容走，改第 1 行就得重量**：

| 「图已过期」标记 | chip 同行门槛 | 门槛处工具栏高 | 640px 处工具栏高 |
|---|---|---|---|
| 无 | 700px | 77px | 103px |
| 有（62px 宽） | **780px** | 77px | 103px |

标记本身只有 62px，却把门槛推高 80px —— 因为第一行本来就在临界点上，多任何一点都会
溢出到第二行。**用户的面板默认 640px，所以实际看到的是 103px 的工具栏**（比搬动之前的
68px 高 35px）。这个取舍见 §6.5。

第 1 行末尾那个 `⧉ …/dsh-…json` 是图谱文件的落盘路径（`PathChip`），点一下复制完整
路径。加它的原因：这张图就是插件写到磁盘上的一个普通 JSON 文件，用户想自己拿去看
（编辑器打开、交给别的工具、备份、对比两次抽取）是很自然的事，但路径在界面上完全
不可见，只能去翻文档猜。

显示的是省略形式（完整路径约 100 字符，工具栏放不下），`title` 和**剪贴板里都是完整
值** —— 点一下拿到的必须是能直接 `cd` 过去的那种。`…/dsh-semantica-graph/` 这级目录要留
（否则看不出文件在哪），于是 chip 宽约 359px。

它对工具栏高度的影响（A/B 实测，chip 有/无）：**640px 以下一律 +26px，640px 及以上 0px**。
临界点就是 chip 能不能和统计数字挤在同一行。

| 面板宽 | 无 chip | 有 chip | 代价 |
|---|---|---|---|
| 300px | 168px | 194px | +26px |
| 420px | 109px | 135px | +26px |
| 640px | 77px | 103px | +26px |
| 720px | 51px | 77px | +26px |

为什么工具栏分两行而不是一行：四个分析按钮合计约 380px，控制按钮约 180px，
一行在 320-420px 的侧边栏里放不下。硬塞进一个 `flex-wrap` 容器反而出了 bug（见下）。

### 6.1 侧边栏宽度：出厂 483px 放不下 Explorer

> **⚠️ 已废弃（2026-09 重构）**：面板已从 better-sidebar 的侧边栏搬到对话自己的标签栏，
> 宽度不再是侧边栏的百分比，而是整个对话视图区（1380px 窗口下约 1380px）。
> 下面这一节连同 §6.3 §6.4 §6.5 记录的是一段**已经结束的历史** —— 保留是因为
> 「出厂比目标窄 157px」这个坑真实发生过，但它现在不构成问题：前提没了。
> 新的架构见 §6.6。

**起因**：试用后反馈「打开宽度现在是多少，感觉有点窄了」。

**查出来的事实**（不是猜的）：

better-sidebar 的面板初始宽度是**窗口宽度的百分比**，出厂 `defaultWidthPercent = 35`
（可调范围 20–60）。当前值存在 localStorage 的 `dsh-sidebar:v1:width` 里 —— 它是
Electron 应用，这一条落在 `~/Library/Application Support/dsh-desktop/Local Storage/leveldb`
的 LevelDB 里，键后面紧跟一个 Latin-1 前缀字节再接值，二进制里能直接读出来：

```
键: dsh-sidebar:v1:width      值: 483
```

483 正好等于 `max(280, round(1380 × 35%))` —— 1380px 的窗口。也就是说这个宽度**从来
没被调过**，它一直是出厂默认值，从没为"看图谱"这件事优化过。而 Explorer 自带一条约
240px 的左侧栏，483px 里只剩 240px 给画布。

范围上有两个容易看错的地方：
- **下限 280**（`PANEL_MIN`）。
- **上限是窗口宽度，不是 640**。源码里有个 `PANEL_MAX = 640`，但它只在 `window`
  不存在时当兜底；`clampWidth` 实际用的是 `Math.max(PANEL_MIN, window.innerWidth)`。
  所以能拖到接近全屏。

**插件怎么改宽度**：公开路走不通 —— `ctx.betterSidebar` 服务 14 个方法里没有一个碰宽度，
`OpenTabSeed` 也没有宽度字段。但 `Sidebar.tsx` 会把 better-sidebar **自己的
`SidebarStore`** 作为 prop 传给每个 tab 组件，而它有公开的 `reduce(reducer)`；
`setWidth` 是 `state.ts` 导出的纯函数。`reduce → schedulePersist → writeGlobalWidth`
会一并写 `dsh-sidebar:v1:width`，所以改完之后**所有对话共用**这个宽度。

**行为**：面板展开时如果宽度 < 640px 就拉到 640px。

为什么是 640 而不是一开始定的 600：600 是凭感觉定的，实测发现它正好落在路径 chip
换行的临界点上（见 §6.4）—— 差 40px，工具栏就差 26px。640 是量出来的。

- **只加宽，绝不回缩** —— 用户自己拖到 700px 就尊重他，不"纠正"回去。
- **每次「收起 → 展开」只检查一次**，展开期间不重复触发，不跟用户的拖动抢。
- **视口 < 768px 时不做** —— better-sidebar 的 `NARROW_MAX_WIDTH = 768`，低于它面板是
  铺满窗口的全屏抽屉，这时候改 width 没有意义，反而会把持久化的值写坏。
- 纯体验优化，任何一步不成立就放弃并 `console.warn`，绝不因为加宽把面板搞崩。

`scripts/visual-check.mjs` 里用真 store 的形状（`getSnapshot().state.width` +
`reduce(fn)`）验了四条，其中两条是反向用例：会加宽到 600、只写一次、
**已经 700px 时一个字都不写**、**窄视口下不写**。

### 6.2 入口按钮：从纯图标改成图标 + 文案

**起因**：反馈「入口按钮加个文案吧，只有一个 icon 看不明白」。

**约束先查清楚**。这个按钮注册在 DSH 的 `conversation.session.header.actions`，那一行的
三段式布局是（抄自 `dsh-client-ui-conversation` 的 CSS）：

```css
.titleRow       { display:flex; align-items:center; min-height:32px }
.titleCluster   { flex:1; min-width:0 }   /* 会被压缩，标题走省略号 */
.headerActions  { flex:none }             /* 宽度由内容决定，自己不收缩 ← 我们在这里 */
.headerUtilities{ flex:none; margin-left:20px }
```

`.headerActions` 是 `flex:none`，所以**加宽不会溢出整行** —— 但它会让左边
`.titleCluster` 缩小，也就是**按钮每宽 1px，对话标题就少 1px**。所以「加个文案」不是
随便加，得先知道要付多少标题宽度。

**样式对齐 DSH 原生**，不自己发明。同一个 slot 里已经有带字的先例：
`dsh-client-ui-agent-preset` 注册的 `AgentPresetLabel`。直接抄它的形状：

```css
height:22px; border-radius:6px; background:var(--dsw-alias-fill-tsp-secondary);
font-size:12px; gap:4px; padding:0 8px; max-width:180px; overflow:hidden;
/* 图标 14 且 opacity:.7 */
```

照抄的理由很实际：那一排是 `flex:none`、宽度随内容走，样式不统一会一眼看出来是个外来物。

**文案取短**：按钮上写「知识图谱」，全称「对话知识图谱」留给 `title`，
无障碍说明「用 Semantica 查看当前对话的知识图谱」留给 `aria-label`。

**实测代价**（`scripts/visual-check.mjs` 把它塞进仿真的三段式头部里量的，不是估的）：

| 视口 | 按钮 | 标题区剩余 | 标题被截断 |
|---|---|---|---|
| 1380px | 82×22 | 1204px | 否 |
| 1100px | 82×22 | 924px | 否 |
| 900px | 82×22 | 724px | 否 |

原来是 26×26 的纯图标，所以代价是 **+56px**，三档视口下标题都还有充足空间。

### 6.3 一次量错了的教训：几何要在改变状态的交互**之前**量

路径 chip 加进来时，`visual-check` 里顺手加了一段「点一下、读剪贴板」的复制测试。
问题出在顺序：**点击写在量几何之前**。

chip 点下去文案会从 `…/dsh-semantica-graph/session-c4f2f73…f4917b740.json` 变成
「已复制」，宽度从 **359px 缩到 62px**。于是：

- 62px 的 chip 当然塞得进第一行 → `info` 量到 17px（一行）
- 反过来在真实静止状态下 chip 是 359px，600px 面板里放不下 → `info` 实际是 43px（两行）
- 结论就是**报出去的所有工具栏高度都比真实值小 26px**（600px 处报 70，实际 94）

抓出来的方式是把两个脚本的同一项数字对到一起：一个报 chip 宽 62px，另一个报 359px。
同一个组件、同样的 props，数字不该不同 —— 不同就说明有一边测的不是同一时刻的状态。

修法：先算好一个 `geom` 对象把所有几何存下来，再点 chip 验复制，最后 `return {...geom, ...复制结果}`。
测试里凡是「断言 + 会改状态的交互」同时存在，都要先量后动。

### 6.4 自动加宽目标：600px → 640px（已定）

> **⚠️ 已废弃**：`PANEL_COMFORT` / `comfortPanelWidth()` / `widenPanel()` 整套已删除。
> 面板不再有「宽度」这个概念要管 —— 它铺满对话视图区。见 §6.6。

按 §6.3 修正后的实测，路径 chip 和统计数字同处第一行的门槛是 **640px**，而插件最初把面板
自动加宽到 **600px** —— 刚好差 40px 落在换行那一侧：

| | 600px | 640px |
|---|---|---|
| 路径 chip | 换到第二行 | 和统计同行 |
| `info` 高度 | 43px | 17px |
| 工具栏高 | 94px | **68px** |
| 图区高度（720 面板） | 626px | **652px** |
| 对话区宽度 | 780px | 740px |

也就是拿 40px 的对话区宽度，换 26px 的图区高度，同时路径能一行看完。

**结论：提到 640px。** `PANEL_COMFORT = 640`。于是「自动加宽的宽度」和「chip 不换行的
宽度」正好重合 —— 只要用户没手动拖窄，看到的就永远是 chip 一行、工具栏 68px 那个状态。

（用户如果自己把面板拖到 640 以下，chip 会重新换行。这是有意不干预的：自动加宽只在
「收起 → 展开」时检查一次，拖过之后不再跟他抢。）

### 6.5 第 1 行装不下时的取舍

按需求把 `重新抽取` 放进第 1 行之后，第 1 行集齐五项：
图标、4 个统计、标记、`重新抽取`、路径 chip。640px 面板的可用宽度是 620px，实测占用：

```
图标 14 + 间距 10 + 统计 234 + 间距 10 + 标记 62 + 间距 10 + 重新抽取 66 + 间距 10 + chip 359
= 775px   >   620px
```

超出 155px，所以 chip 换到第二行，`info` 从 26px 涨到 52px，工具栏 77 → 103px。
代价是 26px 的图区高度。

**顺序是有讲究的**：`重新抽取` 紧跟标记，chip 放最后。这样溢出时被挤下去的是 chip
（一张「附属信息」），而不是把「症状 + 处理」这一对拆开。

想把这 26px 拿回来，可选（都还没做）：

1. **缩短 chip 到只显示文件名** —— 去掉 `…/dsh-semantica-graph/` 前缀（这个目录永远一样，
   信息量低），把文件名省略到 24 字符约 145px。第 1 行合计 571px，640px 下就能一行装完，
   工具栏回到 77px。完整路径仍在 `title` 和剪贴板里。
2. **自动加宽目标提到 780px** —— 那是「有标记时 chip 回得来」的门槛。但 780/1380 = 57%，
   对话区只剩 540px，偏狠。
3. **接受 103px** —— 图区仍有 617/720 = 86%，且第 1 行的内容一眼看完。

**待用户定。** 文档先记着这三个选项。

#### 一个只有真浏览器才能发现的 CSS 坑

```css
/* 错的 */
.semg-toolbar-actions{display:flex;flex-wrap:wrap;flex:0 0 auto}
```

`flex:0 0 auto` 的第三个值是 flex-basis，`auto` = **内容宽度**（八个按钮约 625px）。
容器自己不收缩，内部的 `flex-wrap` 就永远不触发 —— 它以为宽度够，实际溢出 315px，
按钮在 320px 侧边栏里被裁掉一半。改成 `flex:0 1 auto` + `min-width:0` 才会换行。

`PathChip` 的复制也用真浏览器验：授 `clipboard-read` 权限，点一下再读剪贴板，
断言拿到的**等于完整路径**。这里有个坑——测试页原本是 `page.setContent` 出来的，
而 `navigator.clipboard` 只在**安全上下文**里存在，`about:blank` 不是，于是在测试里
它永远是 undefined，测出来的是"API 不存在"而不是"复制对不对"。改成用一个临时
`http://127.0.0.1:<随机端口>` 托管测试页（和真实 GUI 同源形态）才测得准。

**所有单元测试当时都是绿的**：`renderToString` 只吐 HTML 字符串，不含任何几何信息。
于是加了 `scripts/visual-check.mjs` —— 真 Chromium 在 300/320/420/520/640/720 六个宽度
下量溢出、量重叠、量「工具栏 + 图 = 面板高度」，并确认 iframe 里真的渲染出了
Explorer（跨源 + sandbox 下会不会白屏）。

### 6.6 从 better-sidebar 搬到对话标签栏（2026-09 重构）

**起因**：主人问「如果没有 better side，我们这个还能用吗」。

查下来的答案是**很不堪**：插件装得上、宿主照跑（图数据照样生成），但界面**一个入口都没有**。
更糟的是，会话标题旁那个「知识图谱」按钮**照常显示、点下去什么都不发生** —— 不报错、
不提示，连 `console.warn` 都没有。因为 `bridge.open()` 老老实实返回了 `false`，而
`GraphButton` 的 onClick 把返回值丢掉了：

```js
const onClick = useCallback(() => {
  if (typeof open === "function") open(sessionId);   // ← 返回值没人看
}, [open, sessionId]);
```

一个点不动的按钮比没有按钮更糟 —— 用户会以为插件坏了。

**关键发现**：对话顶部那一排标签（对话 / 轨迹 / 上下文）是**核心包**提供的
`conversation.view` 槽，`scope: session`、`kind: list`：

- `@deepseek-ai/dsh-client-ui-chat` 注册「对话」：`{ id: "chat", order: 0, label: () => t("view.chat") }`
- `@deepseek-ai/dsh-client-ui-trajectory` 注册「轨迹」：`{ id: "trajectory", order: 10 }`
- 已装插件 `dsh-context` 注册「上下文」：`{ id: "context", order: 20, label: () => t("tab") }`

也就是说**插件本来就能往那一排里加标签**，而且 `dsh-context` 已经这么干了 —— 它是个完美的
参考实现。于是面板从 better-sidebar 的 tab 搬到了这里：

```js
ctx.slots.inject("conversation.view", () =>
  ctx.slots.register(
    { name: "conversation.view", id: "semantica-graph", order: 30, locale: NS,
      label: () => T("tab.title") },
    LauncherView,
  ),
);
```

**顺带把三样东西一起删了**：

| 删掉 | 为什么 |
|---|---|
| `betterSidebar` 注入 + `registerTab` | 不再需要，插件现在零第三方依赖 |
| `PANEL_FLOOR/NARROW/COMFORT` + `comfortPanelWidth()` + `widenPanel()` | 面板不再是侧边栏，没有「加宽」这回事 |
| `props.ctx / store / scope / visible` | 槽只给 `sessionId`；`visible` 尤其多余 —— 切走标签会**卸载**组件 |

**`visible` 消失带来的一个意外好处**：原来「收起 → 展开」要手动清 `startedFor` ref 才能让
Explorer 自愈（它闲置约 10 分钟会自己死）。现在切走就卸载、切回来重新挂载，ref 自然是新的
—— 那三个 effect 合并成了一个。

**头部按钮怎么切标签**：核心**没有**程序化切换视图的 API。`openView` 只作为
`conversation.view` 组件的 prop 传给视图自己，头部动作槽拿不到；标签按钮的 DOM 上也
没有 `data-id`，只有 `role=tab` 和文字。所以只能按文字找再 `click()` —— 这不是偷懒，
`dsh-context` 的「跳转到上下文」按钮用的就是同一招。找不到就返回 `false` 静默退出
（空会话的 hero 态没有标签栏，那时点了本来就无处可去）。

**效果**（1380px 窗口）：

| | 旧（640px 侧边栏） | 新（全宽视图区） |
|---|---|---|
| 面板宽 | 640px | ~1380px |
| 工具栏高 | 103px | **77px**（第一行装得下，不再换行） |
| 图区 | 640×617 | **1380×643** |

§6.5 那个「第 1 行装不下」的取舍**自动消失了**：第 1 行在 780px 以上就不再换行。

**还有一个细节**：槽渲染时会给组件包一层 `<div data-slot="...">`，但它的 style 是
`display: contents` —— 不生成盒子。所以面板根元素就是 `.viewArea`（
`display:flex; flex-direction:column; flex:1; min-height:0`）的直接 flex item，
`flex:1 1 auto` 就能铺满，不依赖父元素有确定高度。

### 6.7 搬到标签栏之后暴露的三个问题（2026-09 二次修正）

搬进对话标签栏解决了「没有 better-sidebar 就没有入口」的问题，但暴露了三件事：

1. **下面压着对话输入框。** 整屏画布下面那条输入框既用不上、又吃掉一百多像素。
   修法：挂载时给滚动容器打 `data-semg-hide-composer`，由 CSS 隐藏
   `[data-composer-seat]`。用稳定属性定位，不用哈希类名；用 `display:none` 而不是
   卸载，草稿得以保留。

2. **每次切 tab 都在「提取」。** 槽对非激活视图是 `filter` 掉的，切走真的卸载组件，
   于是 iframe 被销毁、`stats`/`url` 状态全丢。宿主那边其实有缓存、不会真重抽
   （`if (!refresh && live)` 直接复用），但客户端这一下照样白屏 → 看起来就像在提取。
   修法两层：
   - iframe 常驻 `body` 上的宿主，**活过卸载**（实测：搬动 iframe 会重载，
     只改宿主 CSS 不会），所以 Explorer SPA 不用重启；
   - prepare 结果按会话缓存在组件外，切回来直接有画面、连请求都不发。
   自愈改由「缓存超过 20s 后的静默复查」兜底。

3. **画布没有卡片感。** 加上 16px 留白 + 8px 圆角 + 1px 边框。这一条顺手暴露了一个
   自己的错误：为了让那 16px 是「真实留白」而给 `.semg-viewbody` 加的负 margin，
   抵消的是**另一个状态**的 padding，反而把画布推出容器外被裁掉。
   随后工具栏也做成同规格的卡片（原来它只贴了一条 `border-bottom`、还直接顶到面板
   边缘），16px 内缩和 16px 行距统一提到容器 `.semg-split` 上给一次。
   最后把工具栏的两行合成一行（信息 + 四个分析按钮 + 在浏览器打开，`ONE_ROW_MIN=1280`），
   控件尺寸收到一组 CSS 变量里定义一次 —— 此前是三种高度配三种内边距。

三件事都补了真 DOM 的验证（`scripts/visual-check.mjs`）。其中最硬的一条是
**服务端计数 iframe 的文档加载次数**：卸载再挂载之后必须仍然是 1 次。

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
