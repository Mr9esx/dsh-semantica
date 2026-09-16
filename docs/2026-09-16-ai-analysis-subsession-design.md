# 设计：AI 分析子会话

日期：2026-09-16
状态：已实现（v0.5.0）

## 需求

用户原话：

> 我们这个插件能加一个能力吗，就是新开一个子对话，注入让 semantica 解析完的数据，让 AI 去分析

两轮澄清的结论：

1. **入口形态**：「分别做几个按钮：复盘对话、理解图数据等」—— 一个分析目的一个按钮，不是单一入口。
2. **注入深度**：「两者结合：摘要打底 + 可钻取」—— 既注入压缩摘要，也给子会话 Explorer 地址和端点清单让它自己钻。

## 交互

四个按钮，加在**插件自己的控制面板 tab**（`LauncherView`）底部。不往 semantica 的
SPA 里塞，那是上游打包好的界面，改不了。

| 按钮 | kind | 子会话要回答的 |
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
      ③ ctx.get('agents').create({ sessionId, meta, seed, agentOptions, setup })
      ④ agent.inject(digest)      source:{kind:'plugin'}
         agent.followup(prompt)   source:{kind:'user'}
  → 返回 { ok, childId, label, digestChars, nodes, edges, drillable }
  → 客户端提示去侧边栏「子会话」页签看
```

## 关键决策

### 1. 开子会话，不注入当前对话

图数据 6-7KB。直接塞进当前对话会永久占住上下文，之后每轮都背着它；分析结果也和
正在做的事混在一条时间线上。

`ctx.get('agents').create()` 是 DSH 官方的接缝，`dsh-better-sidebar` 的
`context-types.ts` 原文：

> Create a session + agent with a custom seed — the Side Chat thread-creation seam:
> the SAME public seam api-proxy's session.fork and the subagent fork provider use.

### 2. 注入拆成两条消息

`inject` = 排队中的模型可见上下文，不唤醒驱动；`followup` = 唤醒驱动的那条。

拆开是为了日志里留两条 `user/message`：plugin 来源那条被 UI 折叠成 context 行，
提问才是正常用户气泡。合并会让几 KB 数据糊在用户气泡里。

### 3. 用最小 seed，不继承父会话历史

Side Chat 继承完整事件日志，因此要处理「父会话 mid-turn」——合成 `step/end` +
`turn/end{interrupted}`，还要处理工具调用无配对 result。那套逻辑长且易出边界 bug。

我们只放一个 `subagent/descriptor` 事件（`seq:0`，满足「从 0 连续、不含未闭合 turn」）。
用户点按钮时父会话必然 mid-turn，而 digest 已带决策和轮次 —— 不继承就没有 open-turn 问题。

descriptor 不能省：没有它的子会话会被宿主目录确定性地渲染成 `corrupt` 诊断行。

代价：子会话不知道对话原文，只知道图。对「分析图」够用。

### 4. `src/analyze.js` 零外部依赖

上游两处都是纯函数，可手写：

```js
createUserMessage(input) = {...input, role:'user', id: MessageId(randomUUID())}
MessageId(id) { return id }        // 品牌函数，零校验
snapshotSubagentDescriptor(x) = {version:3, mode, provider, label, ...}
```

不 import 的原因：**本插件是 `link:` 安装的**，真实路径在 `~/Downloads/`，
`profiles/web/node_modules/dsh-semantica-graph` 只是相对软链。Node 的 ESM 解析会先把
软链折成真实路径（实测报错里就是 `~/Downloads/.../analyze.js`），父级向上走够不到
`$DSH_HOME/profiles/node_modules/@deepseek-ai/*`。

失败模式不对称：

| 做法 | 最坏结果 |
|---|---|
| import | 解析不了 → 整个插件加载失败，`apply` 不执行，图谱功能一起挂 |
| 手写 | 描述符版本对不上 → 子会话被标 `corrupt`，主功能不受影响 |

代价：`DESCRIPTOR_VERSION = 3` 钉死，DSH 升级若改版本需同步改。

### 5. digest 的结构

`buildDigest()` 纯函数，约 6-7KB（≈2600 token）：

1. 头部：说明这是 Semantica 抽的原生 ContextGraph，不是对话复述
2. 图规模 + 节点/边类型分布
3. **决策全量**（category / scenario / reasoning / outcome / alternatives / choiceKind）
4. 时间线（起止 + 按小时密度 Top 5）
5. 高频实体 Top 40、关系 Top 30
6. **钻取接口清单**：Explorer 基址 + 11 个实测可用端点 + 两个踩过的坑

坑写在 digest 里，因为子会话会真的去 curl：

- `/api/temporal/snapshot` 参数是 `?at=<ISO>` 不是 `?time=`
- `/api/reason` 的 facts 要写 `parent_of(a,b)`，规则 `IF...THEN...` 结尾不加句号

Explorer 没起来时降级成纯摘要，digest 里标注「无法钻取」，让模型知道别硬编。

## 错误处理

全部返回结构化 `code`，不抛异常。宿主 `inject = []`，硬依赖会让插件整个加载不起来。

| code | 触发 |
|---|---|
| `agents-unavailable` | `ctx.get('agents')` 缺失 |
| `parent-not-live` | 父会话没有在运行，拿不到 provider/model |
| `create-failed` | `agents.create()` 抛错 |
| `inject-failed` | 会话建好了但注入失败（仍回报 `childId`） |
| `graph-missing` | 读不到图文件 |
| `unknown-kind` | 未知的分析类型 |

preset 解析失败不阻断 —— 退化成空 setup，子会话用默认工具集。

## 测试

`/tmp/test_analyze.mjs`，44 项断言，两半：

- **UI**：真 React 渲染 `LauncherView`，中英各一次，断言 `semg-analyze` 区块、
  四段文案、恰好 4 个按钮、初始可用
- **宿主**：mock ctx 跑 `createAnalysisSession`，断言
  - `meta` 的 `origin/parentSession/delegationDepth/seedLength/cwd/agentPreset`
  - seed 形状（1 个事件、`subagent/descriptor`、`seq:0`、descriptor 字段）
  - `inject` 与 `followup` 各一次、source 分别是 `plugin`/`user`、内容是 digest / 提问
  - 四种 kind 的提问互不相同
  - 五条失败路径都返回正确 code 且不抛

## 未做

- ②本体（`ClassInferencer` → `OWLGenerator` → `POST /api/ontology/load`）
- ③词表（`POST /api/vocabulary/import`）
- ④记忆（用户明确「不需要 / 先不做」）

## 已知限制

- **宿主半侧改动需要重启 DSH**。实测：改完后 `POST /api-semantica/prepare` 仍 200
  （插件活着），但 `POST /api-semantica/analyze` 返回 405、`GET` 返回 404 —— 新路由
  没注册。客户端半侧是热加载的（硬刷新即可），宿主侧不是。
