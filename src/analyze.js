// src/analyze.js
//
// 「让 AI 分析这张图」的宿主半侧。
//
// 做法不是把图塞进当前对话，而是**新开一个子会话** —— 相当于 DSH 的 Side Chat
// 那一套：插件自己调 `ctx.get('agents').create()` 建一个带自定义 seed 的子会话，
// 再把 Semantica 抽好的数据注入进去。子会话出现在侧边栏「子会话」页签里，
// 用户能读、能继续追问，而且不会污染当前这轮对话。
//
// 这个接缝是 DSH 官方的（`context-types.ts` 原文）：
//   "Create a session + agent with a custom seed — the Side Chat thread-creation
//    seam: the SAME public seam api-proxy's session.fork and the subagent fork
//    provider use."
//
// ## 为什么不继承父会话历史（和 Side Chat 的关键差别）
//
// Side Chat 的 seed 是**父会话的完整事件日志**，因此必须处理「父会话正在跑、
// turn 没闭合」—— 它要合成 `step/end` + `turn/end{reason:'interrupted'}` 把
// 那半轮冻住，还要处理「工具调用没有配对 result」这种连冻都冻不干净的情况。
// 那套逻辑很长，而且很容易出边界 bug。
//
// 我们**不继承历史**：用户是在对话进行到一半时点按钮的，父会话必然是 mid-turn，
// 而 digest 里已经带了决策、轮次、时间线。所以 seed 只放一个
// `subagent/descriptor` 事件就够了 —— 整个 open-turn 问题不复存在。
//
// 代价：子会话不知道对话原文，只知道图。这对「分析图」这个目的足够了。
//
// ## 注入为什么是两条消息
//
// `agent.inject()` 送到的是**排队中的模型可见上下文**，它不唤醒驱动；
// `agent.followup()` 才是唤醒驱动的那条。Side Chat 用这个组合是为了让日志里
// 留下两条 `user/message`：注入那条 source 标 `kind:'plugin'`，UI 把它折叠成
// 一行 context，用户的问题才是正常气泡。合成一条的话，几 KB 的图数据会整个
// 糊在用户气泡里。

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

// ## 为什么不 import `@deepseek-ai/dsh-llm` / `dsh-subagent`
//
// 上游这两处是这样的：
//     createUserMessage(input) = deepFreeze(structuredClone({...input, role:'user', id: MessageId(randomUUID())}))
//     MessageId(id) { return id }          // 品牌函数，零校验
//     snapshotSubagentDescriptor(x) = snapshotJsonValue({version:3, mode, provider, label, ...})
// 都是纯函数，手写完全等价，所以下面直接构造。
//
// 之所以不 import，是因为**我们插件是 link: 安装的**：真实路径在
// ~/Downloads/dsh-semantica-graph，而 `profiles/web/node_modules/dsh-semantica-graph`
// 只是个相对软链。Node 的 ESM 解析会先把软链折成真实路径（实测报错里就是
// ~/Downloads/.../analyze.js），于是父级向上走根本够不到
// `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`。
//
// 这个失败模式极不对称：import 解析不了 = 整个插件加载失败，`apply` 压根不执行，
// 用户的图谱功能会一起挂掉。而手写对象最坏只是描述符版本对不上（子会话被标成
// `corrupt`），不影响主功能。所以这里选零依赖。
//
// 代价：`DESCRIPTOR_VERSION` 是钉死的。DSH 升级如果改了描述符版本，需要同步改这里。
// 上游定义在 `@deepseek-ai/dsh-subagent` 的 `snapshotSubagentDescriptor`。

/** 子会话描述符的版本号（对应上游 `SUBAGENT_DESCRIPTOR_VERSION`）。 */
const DESCRIPTOR_VERSION = 3

/**
 * 造一条 user 消息。等价于 `@deepseek-ai/dsh-llm` 的 `createUserMessage` ——
 * 只是加一个稳定 id 并深冻结。这里不做深冻结：消息马上交给 agent，之后不再改。
 */
function userMessage({ content, source }) {
  return { id: randomUUID(), role: 'user', content, source }
}

/** 子会话在侧边栏「子会话」页签里的标签前缀。 */
export const ANALYSIS_LABEL_PREFIX = 'Semantica: '

/** digest 的长度上限。图可以很大，但注入的文本必须有天花板。 */
const MAX_DIGEST_CHARS = 24000

/** 子会话创建的等待上限。和 Side Chat 一样给足，冷启动要挂 preset。 */
const CREATE_TIMEOUT_MS = 20000

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
      '1. **最关键的节点是谁？** 优先用 `/api/analytics/centrality` 的真实中心度数据，别只看频次。说明它们为什么关键。',
      '2. **实体聚成了哪几个主题群？** 每群用一句话概括它在讲什么。',
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
    L.push(`Explorer 正在跑，基址 **${meta.explorerUrl}**。下面是实测可用的端点，`)
    L.push('都是 JSON，你可以直接用 bash + curl 查更细的数据：')
  } else {
    L.push('⚠️ 图服务这次没有启动（Explorer 依赖可能没装），所以**只能基于上面的静态摘要分析**，')
    L.push('无法钻取。请在结论里说明这一点。')
  }
  L.push('')
  L.push('```')
  L.push('GET  /api/graph/stats                    图规模与类型分布')
  L.push('GET  /api/graph/nodes/<nodeId>           单个节点详情')
  L.push('GET  /api/graph/neighbors/<nodeId>?hops=1  邻居（注意：只走出边）')
  L.push('GET  /api/search?q=<关键词>               全文搜索节点')
  L.push('GET  /api/decisions                      决策列表')
  L.push('GET  /api/decisions/<decisionId>/chain   某条决策的因果链')
  L.push('GET  /api/analytics/centrality           中心度')
  L.push('GET  /api/analytics/communities          社群划分')
  L.push('GET  /api/temporal/bounds                时间范围')
  L.push('GET  /api/temporal/diff?from_time=&to_time=   两个时刻之间新增/移除的节点')
  L.push('POST /api/sparql                         SPARQL 查询，body {"query": "..."}')
  L.push('```')
  L.push('')
  L.push('两个已经踩过的坑，别重复踩：')
  L.push('')
  L.push('- `/api/temporal/snapshot` 的参数是 **`?at=<ISO>`**，不是 `?time=`。')
  L.push('  写成 `?time=` 会被静默忽略、按「当前时间」返回全部节点，看起来像"时间过滤没生效"。')
  L.push('- `/api/reason` 的 facts 要写成 `parent_of(a,b)` 这种形式（不是 `"a parent_of b"`），')
  L.push('  规则用 `IF parent_of(?x,?y) AND parent_of(?y,?z) THEN ...`，**结尾不加句号**。')
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
export function buildSeed({ provider, label, agentProvider, agentModel }) {
  // 与上游 `snapshotSubagentDescriptor` 的输出逐字段一致。
  // `one-shot` 模式下不带 label，我们是 `continuable`，label 必填。
  const descriptor = {
    version: DESCRIPTOR_VERSION,
    mode: 'continuable',
    provider,
    label,
    ...(agentProvider === undefined ? {} : { agentProvider }),
    ...(agentModel === undefined ? {} : { agentModel }),
  }
  return [
    {
      type: 'subagent/descriptor',
      seq: 0,
      time: Date.now(),
      data: descriptor,
    },
  ]
}

/**
 * 建子会话并把图数据注入进去。
 *
 * 全部依赖软获取（`ctx.get`），任何一环缺失都返回结构化错误而不是抛异常 ——
 * host 半侧的 inject 是空数组，硬依赖会让插件整个加载不起来。
 *
 * @returns {Promise<{ok: true, childId: string, label: string, digestChars: number}
 *                 | {ok: false, code: string, error: string}>}
 */
export async function createAnalysisSession(ctx, { sessionId, kind, digest, label, provider = 'semantica-graph' }) {
  const spec = ANALYSIS_KINDS[kind]
  if (!spec) return { ok: false, code: 'unknown-kind', error: `未知的分析类型：${kind}` }

  const agents = ctx.get('agents')
  if (!agents || typeof agents.create !== 'function') {
    return {
      ok: false,
      code: 'agents-unavailable',
      error: '当前环境没有 agents 服务，无法创建子会话',
    }
  }

  // 父会话必须活着：agentOptions 要从它身上继承 provider / model，
  // 而且 preset 也要按它的来挂 —— 否则子会话会缺工具。
  const parent = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (!parent) {
    return {
      ok: false,
      code: 'parent-not-live',
      error: `会话 ${sessionId} 当前没有在运行，无法继承模型与工具配置`,
    }
  }

  const parentSession = parent.session
  const childId = `session-${randomUUID()}`

  // preset：解析父会话用的那个，挂到子会话上。拿不到就退化成空 setup ——
  // 子会话仍然能建起来，只是工具集是默认的。
  let agentPreset
  let setup = () => Promise.resolve()
  const presets = ctx.get('agentPresets')
  if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
    try {
      const resolved = await presets.resolve(parentSession?.header?.agentPreset)
      agentPreset = resolved?.id
      if (agentPreset !== undefined) {
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, agentPreset)
        }
      }
    } catch (err) {
      ctx.logger?.warn?.(`[semantica-graph] preset 解析失败，子会话用默认工具集: ${err?.message ?? err}`)
    }
  }

  const seed = buildSeed({
    provider,
    label,
    agentProvider: parent.options?.provider,
    agentModel: parent.options?.model,
  })

  let handle
  try {
    handle = await agents.create({
      sessionId: childId,
      meta: {
        ...(parentSession?.header?.cwd === undefined ? {} : { cwd: parentSession.header.cwd }),
        parentSession: parentSession?.id ?? sessionId,
        seedLength: seed.length,
        origin: 'subagent',
        delegationDepth: (parentSession?.header?.delegationDepth ?? 0) + 1,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
      seed,
      agentOptions: { ...(parent.options || {}) },
      setup,
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    })
  } catch (err) {
    return {
      ok: false,
      code: 'create-failed',
      error: `子会话创建失败：${err?.message ?? err}`,
    }
  }

  // 两条消息，顺序不能反：先 inject 背景，再 followup 提问。
  // inject 不唤醒驱动、排在下一步最先被取走，所以模型看到的是「背景 → 问题」。
  try {
    handle.agent.inject(
      userMessage({
        content: [{ type: 'text', text: digest }],
        source: { kind: 'plugin', plugin: 'dsh-semantica-graph' },
      }),
    )
    handle.agent.followup(
      userMessage({
        content: [{ type: 'text', text: spec.prompt }],
        source: { kind: 'user' },
      }),
    )
  } catch (err) {
    return {
      ok: false,
      code: 'inject-failed',
      error: `子会话已创建（${childId}），但注入失败：${err?.message ?? err}`,
      childId,
    }
  }

  return { ok: true, childId, label, digestChars: digest.length }
}
