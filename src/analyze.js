// src/analyze.js
//
// 「让 AI 分析这张图」的宿主半侧。
//
// 做法不是把图塞进当前对话（那会永久占住上下文，之后每一轮都背着它），而是
// **新开一条对话**，把 Semantica 抽好的数据注入进去。用户能读、能继续追问，
// 而且不会污染当前这一轮。
//
// ## 走 sessionController，不走 agents.create
//
// 这里用 `ctx.get('sessionController')` —— 也就是 GUI 自己「新建对话」用的那条
// 路径（`SessionController` 的服务名就是 `sessionController`）：
//
//   create({ workspaceId | cwd })      → 建一个空会话，返回 { sessionId }
//   selectModel({ sessionId, ... })    → 给它选上模型
//   prompt({ sessionId, content })     → 发第一条用户消息（内部 agent.followup）
//
// **为什么不用 `agents.create()`**：那是子代理（subagent）的接缝。用它必须传
// `meta.origin:'subagent'` + `parentSession`，建出来的东西会出现在侧边栏「子会话」
// 页签里、被 SubagentView 按父子关系归类，而且得自己造 seed（`subagent/descriptor`
// 事件，还带一个钉死的描述符版本号）。用户要的是「直接开新对话」，所以换成
// sessionController —— 它建出来的就是一条普通会话，出现在会话列表里。
//
// workspace 那一步不能省：`create()` 只在传了 `workspaceId` 时才 `attachSession()`，
// 而 GUI 的会话列表是**按 workspace 分组**的（客户端就是
// `workspaces.find(w => w.sessionIds.includes(id))`）。不挂进去，新对话建了也找不到。
//
// ## 注入为什么是两条消息
//
// `agent.inject()` 送到的是**排队中的模型可见上下文**，它不唤醒驱动；
// `prompt()` 走的是 `agent.followup()`，那才是唤醒驱动的一条。
//
// 拆开是为了让日志里留下两条 `user/message`：注入那条 source 标 `kind:'plugin'`，
// UI 把它折叠成一行 context；提问才是正常的用户气泡。合成一条的话，几 KB 的图
// 数据会整个糊在用户气泡里。

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 把一次失败**完整**落盘（message + stack + cause 链），返回文件路径。
 *
 * 为什么需要它：`sessionController.prompt()` 抛出来的错误只有一行 message
 * （实测：「Cannot read properties of undefined (reading 'throwIfAborted')」），
 * 光看这行根本不知道是哪一层 —— 调用栈才有答案。而错误穿过几层 catch 之后栈就
 * 丢了，DSH 自己的进程日志里也翻不到。
 *
 * 所以直接把栈写到图文件旁边。出问题读这个文件就行，不用去翻进程日志。
 *
 * @param graphPath 图文件路径（借它的目录；顺手也记下是哪个会话）
 */
export function dumpFailure(graphPath, sessionId, kind, err) {
  if (!graphPath) return null
  try {
    // 目录不一定在（图是该会话第一次建时才生成的）。不 mkdir 的话 writeFileSync
    // 会失败、被下面的 catch 吞掉、静默返回 null —— 诊断本身失效是最糟的情况。
    const dir = dirname(graphPath)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'last-analyze-error.txt')
    const lines = [
      `when      : ${new Date().toISOString()}`,
      `sessionId : ${sessionId}`,
      `kind      : ${kind}`,
      '',
    ]
    // cause 链也要走完：TypertRemoteFailure 常常把真错误塞在 cause 里
    let e = err
    for (let depth = 0; e && depth < 8; depth++) {
      lines.push(`[${depth}] ${e.name || 'Error'}: ${e.message}`)
      if (e.code !== undefined) lines.push(`      code    : ${String(e.code)}`)
      if (e.details !== undefined) {
        let d
        try {
          d = JSON.stringify(e.details)
        } catch {
          d = String(e.details)
        }
        lines.push(`      details : ${d}`)
      }
      if (typeof e.stack === 'string') {
        for (const row of e.stack.split('\n').slice(0, 25)) lines.push(`      ${row}`)
      }
      e = e.cause
    }
    writeFileSync(file, lines.join('\n') + '\n')
    return file
  } catch {
    return null
  }
}

// ## 为什么不 import `@deepseek-ai/dsh-llm`
//
// `createUserMessage` 上游是这么实现的：
//     createMessage(input) = deepFreeze(structuredClone({...input, id: MessageId(randomUUID())}))
//     MessageId(id) { return id }          // 品牌函数，零校验
// 纯函数，手写完全等价，所以下面直接构造那个对象。
//
// 之所以不 import，是因为**我们插件是 link: 安装的**：真实路径在
// ~/Downloads/dsh-semantica-graph，而 `profiles/web/node_modules/dsh-semantica-graph`
// 只是个相对软链。Node 的 ESM 解析会先把软链折成真实路径（实测报错里就是
// ~/Downloads/.../analyze.js），于是父级向上走根本够不到
// `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`。
//
// 这个失败模式极不对称：import 解析不了 = 整个插件加载失败，`apply` 压根不执行，
// 用户的图谱功能会一起挂掉。而手写对象最坏只是消息少个字段，不影响主功能。

/**
 * 造一条 user 消息。等价于 `@deepseek-ai/dsh-llm` 的 `createUserMessage` ——
 * 只是加一个稳定 id 并深冻结。这里不做深冻结：消息马上交给 agent，之后不再改。
 */
function userMessage({ content, source }) {
  return { id: randomUUID(), role: 'user', content, source }
}

/** 新对话的标签前缀（只用于面板上那行提示）。 */
export const ANALYSIS_LABEL_PREFIX = 'Semantica: '

/** digest 的长度上限。图可以很大，但注入的文本必须有天花板。 */
const MAX_DIGEST_CHARS = 24000

/** 决策全量注入的上限（正常对话不会到）。 */
const MAX_DECISIONS = 60

/** 高频实体 / 关系的条数。 */
const TOP_ENTITIES = 40
const TOP_RELATIONS = 30

/**
 * 四个按钮，每个一种分析。
 *
 * `prompt` 是要注入的**提问**（走 followup，是用户气泡）；图数据走 inject。
 * prompt 里刻意写「不要泛泛而谈，要指到具体节点」—— 否则模型很容易回一段
 * 放之四海皆准的套话，那这个功能就白做了。
 */
export const ANALYSIS_KINDS = {
  retro: {
    label: '复盘这次对话',
    hint: '我做了哪些选择、哪些走了弯路',
    prompt: [
      '请复盘这次对话，依据是上面注入的知识图谱数据（尤其是决策记录那一段）。',
      '',
      '按顺序回答：',
      '1. **我在这次对话里一共做了哪些选择？** 按时间顺序列成一张表，每条一句话说清「面对什么 / 选了什么 / 放弃了什么」。',
      '2. **哪些选择后来被推翻了？** 判据是决策链里后面出现了与前面相反或修正性的选择。指出具体是哪两条、为什么要改。',
      '3. **哪几个选择代价最大？** 代价指返工、重做、方向调整。按代价从大到小排序，说明依据。',
      '4. **如果重来一次，哪几个节点的选择应该不同？** 给出具体建议，不要泛泛而谈。',
      '',
      '硬性要求：**每一条结论都必须指到具体的决策**（用 category + outcome 指认，可以带时间戳）。',
      '数据不足以下结论时就说「数据不足」，不要编。',
    ].join('\n'),
  },

  structure: {
    label: '理解图数据',
    hint: '这张图结构上有什么特点',
    prompt: [
      '请解读这张对话知识图谱的结构。上面注入了统计、高频实体、高频关系；',
      '更细的数据你可以按「钻取接口」那一节的端点，自己用 bash + curl 去查。',
      '',
      '按顺序回答：',
      '1. **最关键的节点是谁？** 用 `/api/analytics?metrics=centrality` 拿真实中心度，别只看频次。说明它们为什么关键。',
      '2. **实体聚成了哪几个主题群？** `/api/analytics?metrics=community` 有现成的社群划分，每群用一句话概括它在讲什么。',
      '3. **关系类型各自反映什么？** `mentions` / `related_to` / `contains` 的分布说明了什么，有没有异常。',
      '4. **从结构能看出这次工作流的什么特征？** 比如是不是高度集中在某一块、有没有明显的孤立区域。',
      '',
      '要求：引用真实数字，不要凭印象。查不到数据就说明查不到。',
    ].join('\n'),
  },

  quality: {
    label: '检验抽取质量',
    hint: '哪些是噪音、哪些漏抽了',
    prompt: [
      '请评估 Semantica 这次从对话里抽取实体与关系的质量。',
      '你可以按「钻取接口」自己用 bash + curl 拉样本对比。',
      '',
      '按顺序回答：',
      '1. **噪音**：抽出来的实体里，哪些明显不该是实体？典型嫌疑是工具名、代码片段、文件路径、纯数字、命令行参数。给出具体例子（实体名 + 你判断的理由）。',
      '2. **漏抽**：这段对话里明显重要、但图上没有的概念有哪些？',
      '3. **关系质量**：`related_to` 这类关系的方向与语义对不对？举几个好例子和坏例子。',
      '4. **总体判断**：给一个明确结论（能用 / 勉强能用 / 不能用），以及**最该改进的一两点**。',
      '',
      '要求：判断要有样本支撑，不要把「我不确定」写成结论。',
    ].join('\n'),
  },

  advice: {
    label: '给当前任务的建议',
    hint: '结合图里的信息给建议',
    prompt: [
      '请基于上面注入的知识图谱，对我当前手上的任务给出建议。',
      '',
      '按顺序回答：',
      '1. **从图上看我在做什么？** 用实体和关系来支撑这个判断。',
      '2. **有哪些信息是我可能忽略的？** 指到具体的实体或关系，说明为什么值得注意。',
      '3. **基于决策链，我接下来最该注意什么？** 特别是前面已经踩过的坑，别让我再踩一次。',
      '4. **具体可执行的下一步**，最多三条。',
      '',
      '要求：只基于图里已有的信息推断，不要脑补对话之外的背景。',
      '分不清的地方直接说不确定。',
    ].join('\n'),
  },
}

/** 判断一个 kind 是否受支持。 */
export function isAnalysisKind(kind) {
  return Object.prototype.hasOwnProperty.call(ANALYSIS_KINDS, kind)
}

/** 数字加千分位，纯粹为了 digest 里好读。 */
function num(n) {
  return Number(n || 0).toLocaleString('en-US')
}

/** 取一个对象里出现次数最高的前 n 项，返回 [[key, count]]。 */
function topEntries(obj, n) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

/** 把 ISO 时间压成 `MM-DD HH:mm` —— digest 里出现几十次，省地方。 */
function shortTime(iso) {
  if (typeof iso !== 'string' || iso.length < 16) return String(iso ?? '')
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
}

/**
 * 读图文件。
 *
 * 只读我们插件自己写的那份 `$DSH_HOME/dsh-semantica-graph/<sessionId>.json`，
 * 不碰 semantica 的任何东西。
 */
export function readGraph(graphPath) {
  try {
    const raw = readFileSync(graphPath, 'utf8')
    const parsed = JSON.parse(raw)
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : Object.values(parsed.nodes || {})
    const edges = Array.isArray(parsed.edges) ? parsed.edges : Object.values(parsed.edges || {})
    return { nodes, edges }
  } catch {
    return null
  }
}

/**
 * 从图里算出摘要。纯函数，方便单测。
 *
 * @param {{nodes: Array, edges: Array}} graph
 * @param {{sessionId?: string, title?: string|null, stats?: object|null, explorerUrl?: string|null, builtAt?: number}} meta
 * @returns {string} 要注入的 digest
 */
export function buildDigest(graph, meta = {}) {
  const { nodes, edges } = graph || { nodes: [], edges: [] }

  const nodeTypes = {}
  for (const n of nodes) nodeTypes[n.type || '?'] = (nodeTypes[n.type || '?'] || 0) + 1
  const edgeTypes = {}
  for (const e of edges) edgeTypes[e.type || '?'] = (edgeTypes[e.type || '?'] || 0) + 1

  const decisions = nodes
    .filter((n) => n.type === 'decision')
    .map((n) => n.properties || {})
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))

  // 实体按「被提及次数」排序 —— mentions 边的数量就是频次
  const mentions = new Map()
  for (const e of edges) {
    if (e.type !== 'mentions') continue
    mentions.set(e.target_id, (mentions.get(e.target_id) || 0) + 1)
  }
  const entityById = new Map(nodes.filter((n) => n.type === 'entity').map((n) => [n.id, n]))
  const topEntities = [...mentions.entries()]
    .filter(([id]) => entityById.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ENTITIES)

  // 关系：related_to 有方向，按 (source label, type, target label) 归并计数
  const relCount = new Map()
  for (const e of edges) {
    if (e.type === 'contains' || e.type === 'mentions') continue
    const s = entityById.get(e.source_id) || nodes.find((n) => n.id === e.source_id)
    const t = entityById.get(e.target_id) || nodes.find((n) => n.id === e.target_id)
    const sl = s?.properties?.label ?? e.source_id
    const tl = t?.properties?.label ?? e.target_id
    const key = `${sl} --${e.type}--> ${tl}`
    relCount.set(key, (relCount.get(key) || 0) + 1)
  }
  const topRelations = [...relCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_RELATIONS)

  // 时间线：所有带 valid_from 的节点，按小时分桶看密度
  const times = nodes
    .map((n) => n.properties?.valid_from || n.properties?.timestamp)
    .filter((t) => typeof t === 'string' && t.length >= 16)
    .sort()
  const byHour = new Map()
  for (const t of times) byHour.set(t.slice(0, 13), (byHour.get(t.slice(0, 13)) || 0) + 1)

  const L = []
  L.push('# 对话知识图谱（由 Semantica 从 DSH 会话抽取）')
  L.push('')
  L.push('这份数据是插件用 Semantica 的 NER + 关系抽取跑出来的原生 ContextGraph，')
  L.push('不是对话原文的复述。分析时请以它为准，不要凭想象补内容。')
  L.push('')
  if (meta.title) L.push(`- 会话标题：${meta.title}`)
  L.push(`- 会话 ID：${meta.sessionId ?? '(未知)'}`)
  L.push(`- 图规模：**${num(nodes.length)} 个节点 / ${num(edges.length)} 条边**`)
  if (meta.builtAt) {
    L.push(`- 抽取时间：${new Date(meta.builtAt).toISOString().replace('T', ' ').slice(0, 19)}`)
  }
  L.push('')

  L.push('## 节点类型分布')
  L.push('')
  for (const [k, v] of topEntries(nodeTypes, 12)) L.push(`- ${k}: ${num(v)}`)
  L.push('')
  L.push('## 边类型分布')
  L.push('')
  for (const [k, v] of topEntries(edgeTypes, 12)) L.push(`- ${k}: ${num(v)}`)
  L.push('')

  // —— 决策：信息密度最高的部分，全量给 ——
  L.push(`## 决策记录（共 ${decisions.length} 条，全部列出）`)
  L.push('')
  if (decisions.length === 0) {
    L.push('（这个会话里没有检测到结构化决策 —— 只有通过「提问-回答」产生的选择才会被记成决策。）')
    L.push('')
  } else {
    L.push('这是整张图信息密度最高的一段：每条都是用户在对话里做出的一个**明确选择**，')
    L.push('由提问工具的「问了什么 + 每个选项什么意思」和「用户最后选了什么」组成。')
    L.push('')
    decisions.slice(0, MAX_DECISIONS).forEach((d, i) => {
      L.push(`### ${i + 1}. [${d.category || '未分类'}] ${shortTime(d.timestamp)}`)
      if (d.choiceKind === 'custom') {
        L.push('（用户是自己打字的，不是选了现成选项）')
      }
      L.push(`- 问题：${String(d.scenario || '').trim()}`)
      L.push(`- **选择：${String(d.outcome || '').trim()}**`)
      if (String(d.reasoning || '').trim()) L.push(`- 理由：${String(d.reasoning).trim()}`)
      const alts = Array.isArray(d.alternatives) ? d.alternatives.filter(Boolean) : []
      if (alts.length) L.push(`- 放弃的选项：${alts.join(' ｜ ')}`)
      L.push('')
    })
    if (decisions.length > MAX_DECISIONS) {
      L.push(`（还有 ${decisions.length - MAX_DECISIONS} 条未列出，可用 /api/decisions 查全量。）`)
      L.push('')
    }
  }

  // —— 时间线 ——
  if (times.length) {
    L.push('## 时间线')
    L.push('')
    L.push(`- 起：${times[0].replace('T', ' ').slice(0, 19)}`)
    L.push(`- 止：${times[times.length - 1].replace('T', ' ').slice(0, 19)}`)
    const densest = [...byHour.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    L.push(`- 最密集的时段（按小时）：${densest.map(([h, c]) => `${h.slice(5)} (${c})`).join(' ｜ ')}`)
    L.push('')
  }

  // —— 高频实体 ——
  L.push(`## 高频实体（Top ${topEntities.length}，按被提及次数）`)
  L.push('')
  if (topEntities.length === 0) {
    L.push('（图上没有实体节点。）')
  } else {
    topEntities.forEach(([id, c], i) => {
      const label = entityById.get(id)?.properties?.label ?? id
      const type = entityById.get(id)?.properties?.entityType ?? entityById.get(id)?.properties?.type ?? ''
      L.push(`${i + 1}. **${label}**${type ? ` (${type})` : ''} — 提及 ${c} 次`)
    })
  }
  L.push('')

  // —— 高频关系 ——
  L.push(`## 关系（Top ${topRelations.length}）`)
  L.push('')
  if (topRelations.length === 0) {
    L.push('（图上没有实体间关系。）')
  } else {
    for (const [k, c] of topRelations) L.push(`- ${k}${c > 1 ? ` ×${c}` : ''}`)
  }
  L.push('')

  // —— 钻取 ——
  L.push('## 钻取接口')
  L.push('')
  if (meta.explorerUrl) {
    L.push(`Explorer 正在跑，基址 **${meta.explorerUrl}**。全是 JSON，可以直接 bash + curl。`)
    L.push('')
    // 这份清单曾经凭印象写错过 6 条路径，喂给模型后全是 404。所以把权威来源
    // 交给 openapi.json —— 上游加路由时这份清单不会跟着烂掉。
    L.push(`**路由的权威来源是 \`GET ${meta.explorerUrl}/openapi.json\`**（78 个 path / 82 个 operation）。`)
    L.push('下面这些是实测可用的常用端点；路径写错返回的是 `{"detail":"API route not found"}`，')
    L.push('拿不准就先拉 openapi.json 对一遍。')
  } else {
    L.push('⚠️ 图服务这次没有启动（Explorer 依赖可能没装），所以**只能基于上面的静态摘要分析**，')
    L.push('无法钻取。请在结论里说明这一点。')
  }
  L.push('')
  L.push('```')
  L.push('GET  /api/graph/stats                         图规模与类型分布')
  L.push('GET  /api/graph/nodes?limit=50&search=        列节点；search 填关键词（实测 Agent → 54 条）')
  L.push('POST /api/graph/search                        相关性搜索，body {"query":"...","limit":20}')
  L.push('GET  /api/graph/edges                         边列表（查「谁指向它」只能扫这个）')
  L.push('GET  /api/graph/node/<nodeId>                 单个节点详情')
  L.push('GET  /api/graph/node/<nodeId>/neighbors?depth=1   邻居，depth 范围 1-5')
  L.push('GET  /api/analytics?metrics=centrality,community,connectivity   中心度 / 社群 / 连通性')
  L.push('GET  /api/analytics/validation                图校验')
  L.push('GET  /api/decisions?limit=10                  决策列表（返回数组，不是 {decisions:[]}）')
  L.push('GET  /api/decisions/<decisionId>/chain        某条决策的因果链')
  L.push('GET  /api/provenance?node_id=<id>             出处血缘')
  L.push('GET  /api/temporal/bounds                     时间范围')
  L.push('GET  /api/temporal/snapshot?at=<ISO>          某一时刻的快照')
  L.push('GET  /api/temporal/diff?from_time=&to_time=   两个时刻之间新增/移除（两个参数都必填）')
  L.push('POST /api/reason                              Datalog 推理')
  L.push('POST /api/sparql                              SPARQL 查询')
  L.push('```')
  L.push('')
  L.push('上面这些是**逐个真实调用过**的（不是照 openapi 抄的）。两类特别说明：')
  L.push('')
  L.push('- `/api/graph/node/<nodeId>/path` 和 `/api/graph/path` **不可用** —— 对任何 id 都返回')  // check-endpoints: ignore
  L.push('  `Source node ... not found`，连 `/neighbors` 查得到的节点也一样。别用。')
  L.push('- `/api/graph/node/<id>/semantic-neighborhood` 返回 **503**，不是空数组。')  // check-endpoints: ignore,status=503
  L.push('')
  L.push('踩过的坑，别重复踩：')
  L.push('')
  L.push('- **邻居和因果链都只走出边**（`ContextGraph.get_neighbors` 只读 `_adjacency`）。')
  L.push('  实测 `/api/graph/node/ent:xxx/neighbors` 对纯被提及的实体返回 `[]` —— 不是接口坏了，')
  L.push('  是它只有入边。要查「谁引用了它」得自己扫 `/api/graph/edges`。')
  L.push('- `/api/temporal/snapshot` 的参数是 **`?at=<ISO>`**，不是 `?time=`。')
  L.push('  写成 `?time=` 会被静默忽略、按「当前时间」返回全部节点，看起来像"时间过滤没生效"。')
  L.push('- `/api/reason` 的 facts 要写成 `parent_of(a,b)` 这种形式（不是 `"a parent_of b"`），')
  L.push('  规则用 `IF parent_of(?x,?y) AND parent_of(?y,?z) THEN ...`，**结尾不加句号**。')
  L.push('- **两个 density 口径不同，别混着比**：`/api/graph/stats` 的 `density` 按有向算')
  L.push('  `E/(N(N-1))`，`/api/analytics` 里 `connectivity.density` 按无向算 `E/(N(N-1)/2)`，')
  L.push('  后者恒为前者的两倍（实测同一张 446 节点 / 519 边的图：0.002615 对 0.005230）。')
  L.push('- 实体层的边是**锚点局部**的：一个实体只连到字面包含它的那段文本。所以用户在对话里')
  L.push('  贴的关键证据（比如报错原文）不会连到讨论它的那些 assistant 消息上 —— 除非它们也')
  L.push('  字面提到了同一串词。这是 mention 式抽取的固有性质，不是图坏了。')
  L.push('')

  let digest = L.join('\n')
  if (digest.length > MAX_DIGEST_CHARS) {
    digest = digest.slice(0, MAX_DIGEST_CHARS) +
      `\n\n（摘要被截断，完整数据请走上面的钻取接口。）`
  }
  return digest
}

/**
 * 造子会话的 seed。
 *
 * 只有 `subagent/descriptor` 一个事件 —— 不继承父会话历史，理由见文件头。
 * 这个 descriptor 不是可选的：没有它的子会话会被宿主目录确定性地渲染成
 * `corrupt` 诊断行（Side Chat 的注释原文："a cold child without one is
 * deterministically rendered as a 'corrupt' diagnostic"）。
 *
 * `seq` 从 0 开始、不含任何未闭合 turn —— 满足 seed 的合法性约束。
 */
/**
 * 找到父会话所属的 workspace。
 *
 * 这一步不能省：`sessionController.create()` 只在传了 `workspaceId` 时才
 * `attachSession()`，而 GUI 的会话列表是**按 workspace 分组的**（客户端代码里
 * 就是 `workspaces.find(w => w.sessionIds.includes(id))`）。不挂进去，「新对话」
 * 建了也在侧边栏里找不到。
 *
 * 先按 sessionIds 精确找，退而求其次按 cwd 匹配 workspace 路径。
 */
function findWorkspace(ctx, parentSessionId, cwd) {
  const reg = ctx.get('workspaceRegistry')
  if (!reg) return undefined
  try {
    if (typeof reg.list === 'function') {
      for (const w of reg.list() || []) {
        if (Array.isArray(w?.sessionIds) && w.sessionIds.includes(parentSessionId)) return w
      }
    }
    if (cwd && typeof reg.resolveByPath === 'function') {
      return reg.resolveByPath(cwd) ?? undefined
    }
  } catch (err) {
    ctx.logger?.debug?.(`[semantica-graph] 找不到父会话的 workspace: ${err?.message ?? err}`)
  }
  return undefined
}

/**
 * 开一个**新的顶层对话**，把图数据注入进去。
 *
 * 走的是 `sessionController` —— 也就是 GUI 自己「新建对话」用的那套：
 *
 *   create({ workspaceId | cwd })  → 建一个空会话，返回 { sessionId }
 *   selectModel({ sessionId, provider, model })  → 给它选上模型
 *   prompt({ sessionId, content })  → 发第一条用户消息（内部 agent.followup）
 *
 * 早先这里用的是 `agents.create({ meta: { origin:'subagent', parentSession } })`，
 * 那建出来的是**子代理**：会出现在侧边栏「子会话」页签里、被 SubagentView 按
 * 父子关系归类。用户要的是「直接开新对话」，所以换成这条路径 ——
 * 它建出来的就是一条普通会话，出现在会话列表里。
 *
 * digest 仍然走 `agent.inject()`（source 标 plugin），这样它在 UI 里是折叠的
 * 背景行，而不是一条几 KB 的用户气泡；提问走 `prompt()`，是正常的用户消息。
 *
 * 全部依赖软获取（`ctx.get`），任何一环缺失都返回结构化错误而不是抛异常 ——
 * host 半侧的 inject 是空数组，硬依赖会让插件整个加载不起来。
 *
 * @returns {Promise<{ok: true, sessionId: string, label: string, digestChars: number, injected: boolean}
 *                 | {ok: false, code: string, error: string, sessionId?: string}>}
 */
export async function createAnalysisSession(ctx, { sessionId, kind, digest, label, graphPath }) {
  const spec = ANALYSIS_KINDS[kind]
  if (!spec) return { ok: false, code: 'unknown-kind', error: `未知的分析类型：${kind}` }

  const sc = ctx.get('sessionController')
  if (!sc || typeof sc.create !== 'function' || typeof sc.prompt !== 'function') {
    return {
      ok: false,
      code: 'session-controller-unavailable',
      error: '当前环境没有 sessionController 服务，无法新建对话',
    }
  }

  // 父会话：拿 cwd、preset 和模型选择。它必须活着 —— 我们靠它继承这些。
  const agents = ctx.get('agents')
  const parent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (!parent) {
    return {
      ok: false,
      code: 'parent-not-live',
      error: `会话 ${sessionId} 当前没有在运行，无法继承工作目录与模型`,
    }
  }

  const parentSession = parent.session
  const cwd = parentSession?.header?.cwd
  const provider = parent.options?.provider
  const model = parent.options?.model
  const reasoningEffort = parent.options?.reasoningEffort
  const agentPreset = parentSession?.header?.agentPreset
  const workspace = findWorkspace(ctx, sessionId, cwd)

  // 1) 建新对话。workspaceId 与 cwd 互斥（controller 会直接 bad-request）：
  //    能拿到 workspace 就优先用它，这样会话会挂进侧边栏的会话列表；
  //    拿不到才退回 cwd。
  //
  //    传 workspaceId 时 controller 会用 `workspace.path` 当 cwd，随后
  //    `attachSession()` 会拿它在磁盘上 realpath 校验一遍（必须存在、是目录、
  //    与 workspace 路径一致）。校验不过就会抛错，那样**一条对话都建不出来** ——
  //    所以这里退回 cwd 再试一次：会话仍然可用，只是不会出现在侧边栏列表里，
  //    比整个失败强。
  const workspaceId = workspace?.id ?? workspace?.workspaceId
  const targets = []
  if (typeof workspaceId === 'string' && workspaceId) {
    targets.push({ workspaceId })
    if (cwd !== undefined) targets.push({ cwd })
  } else if (cwd !== undefined) {
    targets.push({ cwd })
  } else {
    targets.push({})
  }

  let newId
  let lastError
  for (const target of targets) {
    try {
      const created = await sc.create({
        ...target,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      })
      newId = created?.sessionId
      if (typeof newId === 'string' && newId) {
        if (target.workspaceId === undefined && targets.length > 1) {
          ctx.logger?.warn?.(
            '[semantica-graph] 挂到 workspace 失败，新对话已建在 cwd 上但不会出现在侧边栏列表里',
          )
        }
        break
      }
      lastError = 'sessionController.create 没有返回 sessionId'
    } catch (err) {
      lastError = err?.message ?? err
    }
  }

  if (typeof newId !== 'string' || !newId) {
    return { ok: false, code: 'create-failed', error: `新对话创建失败：${lastError}` }
  }

  // 2) 选模型。新会话还没有任何模型选择，不选的话 prompt 会以
  //    `model-unavailable: no adapter serves provider "..."` 直接拒绝。
  if (provider && model && typeof sc.selectModel === 'function') {
    try {
      await sc.selectModel({
        sessionId: newId,
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
    } catch (err) {
      // 选不上不致命：会话本身可能是从设置里继承了默认模型
      ctx.logger?.warn?.(`[semantica-graph] 给新对话选模型失败，用默认值: ${err?.message ?? err}`)
    }
  }

  // 3) 背景数据走 inject —— 不唤醒驱动，且 UI 把它折叠成一行 context。
  //    拿不到 agent 也不致命，只是图数据会缺席。
  let injected = false
  try {
    const agent = agents && typeof agents.get === 'function' ? agents.get(newId) : undefined
    if (agent && typeof agent.inject === 'function') {
      agent.inject(
        userMessage({
          content: [{ type: 'text', text: digest }],
          source: { kind: 'plugin', plugin: 'dsh-semantica-graph' },
        }),
      )
      injected = true
    } else {
      ctx.logger?.warn?.('[semantica-graph] 新对话的 agent 还不可用，图数据没有注入')
    }
  } catch (err) {
    ctx.logger?.warn?.(`[semantica-graph] 注入图数据失败: ${err?.message ?? err}`)
  }

  // 4) 提问走 prompt —— 这条才是唤醒驱动的用户消息。
  try {
    await sc.prompt({
      sessionId: newId,
      content: [{ type: 'text', text: spec.prompt }],
      // GUI 走 RPC 时会带上 requestId，它会进 source.rpcId。裸调时补一个，
      // 免得落一条 rpcId 为 undefined 的用户消息。
      requestId: randomUUID(),
    })
  } catch (err) {
    // 兜底：`prompt()` 内部真正做的最后一步就是 `agent.followup(message)`，
    // 也就是唤醒驱动。它前面还有 resolveAgent / selectionFor / routeServed，
    // 那几行**不在 admit() 的 try 里**，抛出来的错是裸的、不会被包成
    // `agent-busy`。实测就是这个：
    //     Cannot read properties of undefined (reading 'throwIfAborted')
    // 其中 resolveAgent 返回的是 `{ agent }` 包装对象（对照 typert 那边的
    // `return found.agent` 可以确认它是要解包的），而 prompt() 直接当 agent 用。
    // 与其猜，不如自己走最后那一步 —— 效果一样，还绕开了会抛错的前半段。
    const fallback = ctx.get('agents')?.get(newId)
    if (fallback && typeof fallback.followup === 'function') {
      try {
        fallback.followup(
          userMessage({
            content: [{ type: 'text', text: spec.prompt }],
            source: { kind: 'plugin', plugin: 'dsh-semantica-graph' },
          }),
        )
        ctx.logger?.info?.('[semantica-graph] prompt 失败，已用 agent.followup 兜底唤醒')
        return {
          ok: true,
          sessionId: newId,
          label,
          digestChars: digest.length,
          injected,
          viaFollowup: true,
        }
      } catch (err2) {
        return {
          ok: false,
          code: 'prompt-failed',
          error: `对话已建好但提问失败：${err?.message ?? err}`,
          sessionId: newId,
          detail: `prompt: ${err?.message ?? err} / followup: ${err2?.message ?? err2}`,
          stackFile: dumpFailure(graphPath, sessionId, kind, err) ?? undefined,
        }
      }
    }
    return {
      ok: false,
      code: 'prompt-failed',
      // 「对话已建好但提问失败」这句必须留着 —— 用户得知道那条空对话是真的建出来了。
      error: `对话已建好但提问失败：${err?.message ?? err}`,
      sessionId: newId,
      detail: err?.code !== undefined ? String(err.code) : undefined,
      stackFile: dumpFailure(graphPath, sessionId, kind, err) ?? undefined,
    }
  }

  return { ok: true, sessionId: newId, label, digestChars: digest.length, injected }
}
