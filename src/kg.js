// src/kg.js
//
// 图数据的读、切、算 —— 都在这一层，全是纯函数，不碰进程也不碰网络。
//
// ## 数据从哪来
//
// MCP（`mcp__semantica__*`）写出来的**共享图**：一个 JSON 文件，形状是
// semantica 的 `ContextGraph.save_to_file()` 产物：
//
//   { graph_id, nodes: [{id, type, properties:{label?, metadata?, content?, ...}}],
//     edges: [{source_id, target_id, type, weight, properties}], links }
//
// 模型按插件注入的规则在 `properties.metadata.conversation` 里打了会话标识，
// 所以「本对话」这一刀是**按标切**，不是按文件切。取舍理由见 README。
//
// ## 为什么分析在这里自己算，而不是问 semantica
//
// 上游有 `get_graph_analytics`（MCP 工具）和一堆 Python 分析器。但 MCP 工具插件调不到
// （插件不是 MCP 客户端），Python 分析器要走一趟解释器冷启动；而面板上这些指标
// （度数、PageRank、连通分量、社区、决策清单）在一张几千节点的图上用 JS 算是毫秒级的。
// 展示交给上游 Explorer，分析归插件自己 —— 分工干净。

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** 归档节点不进视图（MCP 的 delete_node 是软删，标记 status=archived）。 */
const ARCHIVED = 'archived'

/** record_decision 自己建的节点类型：它们是决策的附属，不算「实体」。 */
const DECISION_TYPES = new Set(['decision', 'category', 'decision_maker'])

/** record_decision 自己建的边：不算「关系」，是决策的挂载边。 */
const PLUMBING_EDGE_TYPES = new Set(['involves', 'belongs_to', 'made_by'])

/** 决策挂载边的用途：顺着它把决策认领回会话。 */
const INVOLVES = 'involves'

/** 顶层字段长得对不对。 */
function isGraph(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		Array.isArray(value.nodes) &&
		Array.isArray(value.edges)
	)
}

/**
 * 读一份图文件。
 *
 * @param path 图文件路径（MCP 的 SEMANTICA_KG_PATH）。
 * @returns `{ graph_id, nodes, edges, bytes }`；文件不存在返回 null —— 这是「还没写过」
 *   的正常状态，不是错误（用户第一次打开面板时就长这样）。
 */
export function readGraph(path) {
	let raw
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		if (err && err.code === 'ENOENT') return null
		throw err
	}
	const parsed = JSON.parse(raw)
	if (!isGraph(parsed)) throw new Error(`图文件结构不对：${path}`)
	return {
		graph_id: parsed.graph_id ?? 'kg',
		nodes: parsed.nodes,
		edges: parsed.edges,
		bytes: Buffer.byteLength(raw),
	}
}

/**
 * 节点属性里的会话标识。
 *
 * 支持字符串与数组两种写法：指令里写的是字符串，但模型偶尔给一组，两种都认。
 */
function tagOf(node) {
	const meta = node?.properties?.metadata
	if (!meta || typeof meta !== 'object') return null
	return meta.conversation ?? meta.session ?? null
}

/** 边自己的会话标（add_relationship 也带 metadata）。 */
function edgeTagOf(edge) {
	const meta = edge?.properties?.metadata
	if (!meta || typeof meta !== 'object') return null
	return meta.conversation ?? meta.session ?? null
}

/** 标里有没有这个会话。 */
function tagMatches(tag, sessionId) {
	if (!tag) return false
	if (typeof tag === 'string') return tag === sessionId
	if (Array.isArray(tag)) return tag.some((t) => typeof t === 'string' && t === sessionId)
	return false
}

/**
 * 这个节点身上有没有**任何**会话标。
 *
 * 和上面那个是两件事，别混：`tagMatches` 问的是「属不属于本会话」，
 * 这里问的是「它到底有没有被归属过」。面板上那句「图里还有 N 个节点没打会话标」
 * 说的是后者 —— 别的会话写进去的节点是有主的，只是不归你，不算「没打标」。
 */
function hasAnyTag(node) {
	const tag = tagOf(node)
	if (typeof tag === 'string') return tag.trim().length > 0
	if (Array.isArray(tag)) return tag.some((t) => typeof t === 'string' && t.trim().length > 0)
	return false
}

/**
 * 决策的时间（毫秒）。
 *
 * `timestamp` 是 epoch **秒**（浮点，上游 record_decision 写的就是这个），
 * `recorded_at` 是 ISO 串，`valid_from` 也可能有。
 */
function decisionTime(node) {
	const p = node?.properties ?? {}
	if (typeof p.timestamp === 'number' && Number.isFinite(p.timestamp)) {
		return p.timestamp > 1e11 ? p.timestamp : p.timestamp * 1000
	}
	for (const key of ['recorded_at', 'valid_from']) {
		if (typeof p[key] === 'string') {
			const t = Date.parse(p[key])
			if (Number.isFinite(t)) return t
		}
	}
	return null
}

/** 人类可读的节点标题。 */
export function labelOf(node) {
	const p = node?.properties ?? {}
	const s = p.label ?? p.name ?? p.content ?? node?.id
	return typeof s === 'string' && s.trim() ? s.trim() : String(node?.id ?? '')
}

/** 去掉悬空边与重复边 —— Explorer 拿到指向不存在节点的边时行为不可控。 */
function cleanEdges(edges, byId) {
	const out = []
	const seen = new Set()
	for (const e of edges ?? []) {
		const s = String(e?.source_id ?? '')
		const t = String(e?.target_id ?? '')
		if (!s || !t || s === t) continue
		if (!byId.has(s) || !byId.has(t)) continue
		const key = `${s}\u0000${t}\u0000${String(e?.type)}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({
			source_id: s,
			target_id: t,
			type: e.type,
			weight: e.weight ?? 1,
			properties: e.properties ?? {},
		})
	}
	return out
}

/**
 * 切出要展示的那张图。
 *
 * `mode: 'all'` 就是整张图（去掉归档节点）；`mode: 'conversation'` 只留本会话的：
 *
 *   1. 打标的节点与边（模型写入时带的 `metadata.conversation`）；
 *   2. 决策 —— 它没有 metadata 可打标（`record_decision` 不收这个参数），所以靠两条路
 *      认领：顺着 `involves` 边连到留下来的实体，或者时间落在会话的活动窗口里
 *      （`createdAt` → 日志最后修改时间）；
 *   3. 决策的附属节点（category / decision_maker），否则 Explorer 里那条决策会缺一块。
 *
 * @param graph readGraph() 的结果。
 * @param opts.sessionId 会话 id。
 * @param opts.mode 'conversation' | 'all'。
 * 认领规则只有一条：**明确的会话标**（含由已打标实体通过 involves 边认领的决策）。
 * 曾经还有一条「时间窗兜底」—— 决策时间落在这个会话的活动时间段里就认领它。那条规则是错的：
 * 一天里连着聊几个会话时，同一个没打标的决策会被**每一个**时间覆盖它的会话同时认领，
 * 于是「我根本没提取过的对话」里冒出了别人的 6 个节点。宁可少认，不能认错。
 */
/**
 * 切图规则的版本号。**改了认领规则就 +1。**
 *
 * 为什么要有这么个东西：Explorer 是启动时读一次图，出好的图还会被前端沿用（切标签
 * 回来不重新出图）。于是「规则的改动」在界面上生效不了 —— 用户重新点开面板，看到的
 * 还是按**旧规则**切出来的那张图，会以为 bug 没修。
 *
 * 这个版本号进视图的 key，所以规则一变，旧的视图文件与 Explorer 实例自然失效，
 * 面板下次打开必然重新出图。v2 = 删掉时间窗兜底认领的那一版。
 */
export const SCOPE_VERSION = 2

export function scopeGraph(graph, opts) {
	const sessionId = String(opts.sessionId ?? '')
	const mode = opts.mode === 'all' ? 'all' : 'conversation'
	const live = graph.nodes.filter((n) => n?.properties?.status !== ARCHIVED)
	const byId = new Map(live.map((n) => [String(n.id), n]))

	if (mode === 'all') {
		const semantic = live.filter((n) => !DECISION_TYPES.has(String(n.type)))
		return {
			mode,
			nodes: live,
			edges: cleanEdges(graph.edges, byId),
			claim: {
				tagged: semantic.filter(hasAnyTag).length,
				byEntity: 0,
				untagged: semantic.filter((n) => !hasAnyTag(n)).length,
				totalSemantic: semantic.length,
			},
		}
	}

	// 1) 打标的节点
	const kept = new Set()
	for (const n of live) {
		if (tagMatches(tagOf(n), sessionId)) kept.add(String(n.id))
	}
	const taggedNodes = kept.size

	// 2) 决策认领：只认「挂在本会话实体上」的那种（record_decision 没有 metadata，
	//    entities 边是它唯一的会话归属信号）
	let byEntity = 0
	for (const d of live) {
		if (String(d.type) !== 'decision') continue
		const id = String(d.id)
		if (kept.has(id)) continue
		const linked = graph.edges.some(
			(e) =>
				String(e?.type) === INVOLVES &&
				String(e?.source_id) === id &&
				kept.has(String(e?.target_id)),
		)
		if (linked) {
			kept.add(id)
			byEntity += 1
		}
	}

	// 3) 决策的附属节点（category / decision_maker）
	for (const e of graph.edges) {
		const s = String(e?.source_id)
		const t = String(e?.target_id)
		if (!kept.has(s)) continue
		const target = byId.get(t)
		if (target && DECISION_TYPES.has(String(target.type))) kept.add(t)
	}

	const nodes = live.filter((n) => kept.has(String(n.id)))
	const keptById = new Map(nodes.map((n) => [String(n.id), n]))
	const edges = cleanEdges(graph.edges, keptById)

	// 边自带本会话标的也算 —— 两个端点被别的会话标着、但这条边是本会话写的时候要留下，
	// 否则会出现「节点看得见、边却没了」。
	for (const e of graph.edges) {
		if (!tagMatches(edgeTagOf(e), sessionId)) continue
		const s = String(e?.source_id)
		const t = String(e?.target_id)
		if (!byId.has(s) || !byId.has(t)) continue
		if (edges.some((x) => x.source_id === s && x.target_id === t && x.type === e.type)) continue
		edges.push({
			source_id: s,
			target_id: t,
			type: e.type,
			weight: e.weight ?? 1,
			properties: e.properties ?? {},
		})
	}

	const totalSemantic = live.filter((n) => !DECISION_TYPES.has(String(n.type))).length
	return {
		mode,
		nodes,
		edges,
		claim: {
			tagged: taggedNodes,
			byEntity,
			untaggedDecisions: live.filter((n) => String(n.type) === 'decision' && !kept.has(String(n.id))).length,
			// 没打任何会话标的语义节点 —— 它们只可能出现在「全部」里
			untagged: live.filter((n) => !DECISION_TYPES.has(String(n.type)) && !hasAnyTag(n)).length,
			totalSemantic,
		},
	}
}

/**
 * 工具栏上那几个数字。
 *
 * 「实体」= 非决策附属的节点，「关系」= 非决策挂载的边。刻意按**语义**分，而不是按
 * add_entity/add_relationship 调用分 —— 模型可能用 add_entity 建了别的东西。
 */
export function summarize(nodes, edges) {
	let entities = 0
	let decisions = 0
	const byType = new Map()
	for (const n of nodes) {
		const type = String(n.type ?? 'Unknown')
		byType.set(type, (byType.get(type) ?? 0) + 1)
		if (type === 'decision') decisions += 1
		if (!DECISION_TYPES.has(type)) entities += 1
	}
	let relations = 0
	for (const e of edges) {
		if (!PLUMBING_EDGE_TYPES.has(String(e.type))) relations += 1
	}
	return {
		nodes: nodes.length,
		edges: edges.length,
		entities,
		relations,
		decisions,
		byType: [...byType.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([type, count]) => ({ type, count })),
	}
}

/**
 * 插件自己的分析：全部在这张图上直接算。
 *
 * 返回的每一块对应面板分析抽屉里的一个标签页。算法都是最朴素的那种，理由是这里要的是
 * 「一眼看出哪些实体是枢纽、有几个社区」，不需要论文级精度，但必须**可解释**
 * （度数就是度数、PageRank 就是 PageRank），也必须在几千节点上是毫秒级。
 *
 * @param nodes 已经切好的节点。
 * @param edges 已经切好的边。
 */
export function analyze(nodes, edges) {
	const ids = nodes.map((n) => String(n.id))
	const index = new Map(ids.map((id, i) => [id, i]))
	const n = ids.length
	const adj = Array.from({ length: n }, () => [])
	const undirected = Array.from({ length: n }, () => new Set())
	for (const e of edges) {
		const a = index.get(String(e.source_id))
		const b = index.get(String(e.target_id))
		if (a === undefined || b === undefined) continue
		adj[a].push(b)
		undirected[a].add(b)
		undirected[b].add(a)
	}
	const degree = undirected.map((s) => s.size)
	const nodeOf = (i) => nodes[i]
	const title = (i) => labelOf(nodeOf(i))
	const semantic = (i) => !DECISION_TYPES.has(String(nodeOf(i)?.type))

	// ── PageRank（幂迭代，20 轮足够收敛到三位有效数字） ──
	const rank = new Array(n).fill(n > 0 ? 1 / n : 0)
	const dangling = []
	for (let i = 0; i < n; i += 1) if (adj[i].length === 0) dangling.push(i)
	const damping = 0.85
	for (let iter = 0; iter < 20; iter += 1) {
		let leaked = 0
		for (const i of dangling) leaked += rank[i]
		const base = (1 - damping) / Math.max(1, n) + (damping * leaked) / Math.max(1, n)
		const next = new Array(n).fill(base)
		for (let i = 0; i < n; i += 1) {
			const out = adj[i].length
			if (out === 0) continue
			const share = (damping * rank[i]) / out
			for (const j of adj[i]) next[j] += share
		}
		for (let i = 0; i < n; i += 1) rank[i] = next[i]
	}

	// ── 连通分量（并查集） ──
	const parent = Array.from({ length: n }, (_, i) => i)
	const find = (x) => {
		let r = x
		while (parent[r] !== r) r = parent[r]
		let cur = x
		while (parent[cur] !== r) {
			const next = parent[cur]
			parent[cur] = r
			cur = next
		}
		return r
	}
	for (const e of edges) {
		const a = index.get(String(e.source_id))
		const b = index.get(String(e.target_id))
		if (a === undefined || b === undefined) continue
		const ra = find(a)
		const rb = find(b)
		if (ra !== rb) parent[ra] = rb
	}
	const components = new Map()
	for (let i = 0; i < n; i += 1) {
		const r = find(i)
		components.set(r, (components.get(r) ?? 0) + 1)
	}
	const componentSizes = [...components.values()].sort((a, b) => b - a)

	// ── 社区（标签传播，10 轮；遍历顺序固定，保证多次运行结果一致） ──
	const label = Array.from({ length: n }, (_, i) => i)
	for (let iter = 0; iter < 10; iter += 1) {
		let changed = false
		for (let i = 0; i < n; i += 1) {
			const counts = new Map()
			for (const j of undirected[i]) counts.set(label[j], (counts.get(label[j]) ?? 0) + 1)
			if (counts.size === 0) continue
			let best = label[i]
			let bestCount = counts.get(best) ?? 0
			// 平票取较小的标签，不靠随机
			for (const [lab, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
				if (count > bestCount) {
					best = lab
					bestCount = count
				}
			}
			if (best !== label[i]) {
				label[i] = best
				changed = true
			}
		}
		if (!changed) break
	}
	const communityMap = new Map()
	for (let i = 0; i < n; i += 1) {
		const key = label[i]
		if (!communityMap.has(key)) communityMap.set(key, [])
		communityMap.get(key).push(i)
	}
	const communities = [...communityMap.values()]
		.filter((members) => members.length > 1)
		.sort((a, b) => b.length - a.length)
		.slice(0, 12)
		.map((members) => ({
			size: members.length,
			members: members
				.filter((i) => semantic(i))
				.sort((a, b) => degree[b] - degree[a])
				.slice(0, 10)
				.map((i) => ({ label: title(i), type: String(nodeOf(i)?.type ?? ''), degree: degree[i] })),
		}))

	// ── 枢纽：度数榜 & PageRank 榜 ──
	const order = ids.map((_, i) => i).filter((i) => semantic(i))
	const rankTop = (list, score) =>
		list
			.slice()
			.sort((a, b) => score(b) - score(a) || title(a).localeCompare(title(b)))
			.slice(0, 15)
			.map((i) => ({
				id: ids[i],
				label: title(i),
				type: String(nodeOf(i)?.type ?? ''),
				degree: degree[i],
				score: Number(score(i).toFixed(6)),
			}))
	const hubs = { byDegree: rankTop(order, (i) => degree[i]), byRank: rankTop(order, (i) => rank[i]) }

	// ── 决策：清单 + 关联实体 ──
	const involves = new Map()
	for (const e of edges) {
		if (String(e.type) !== INVOLVES) continue
		const d = String(e.source_id)
		const target = index.get(String(e.target_id))
		if (target === undefined) continue
		if (!involves.has(d)) involves.set(d, [])
		involves.get(d).push({ id: ids[target], label: title(target), type: String(nodeOf(target)?.type ?? '') })
	}
	const decisions = nodes
		.filter((node) => String(node.type) === 'decision')
		.map((node) => {
			const p = node.properties ?? {}
			const t = decisionTime(node)
			return {
				id: String(node.id),
				category: String(p.category ?? '未分类'),
				outcome: String(p.outcome ?? ''),
				scenario: String(p.scenario ?? ''),
				reasoning: String(p.reasoning ?? ''),
				confidence: typeof p.confidence === 'number' ? p.confidence : null,
				maker: String(p.decision_maker ?? ''),
				at: t === null ? null : new Date(t).toISOString(),
				entities: involves.get(String(node.id)) ?? [],
			}
		})
		.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))

	// ── 决策时间线（按天） ──
	const buckets = new Map()
	for (const d of decisions) {
		if (!d.at) continue
		const day = d.at.slice(0, 10)
		buckets.set(day, (buckets.get(day) ?? 0) + 1)
	}
	const timeline = [...buckets.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([day, count]) => ({ day, count }))

	// ── 概览 ──
	const summary = summarize(nodes, edges)
	const isolated = order.filter((i) => degree[i] === 0)
	return {
		overview: {
			...summary,
			components: componentSizes.length,
			largestComponent: componentSizes[0] ?? 0,
			isolated: isolated.length,
			communities: [...communityMap.values()].filter((m) => m.length > 1).length,
		},
		hubs,
		communities,
		decisions,
		timeline,
	}
}

/**
 * 把切好的图写成 Explorer 能读的文件。
 *
 * 必须写成 `{graph_id, nodes, edges}`：`ContextGraph.load_from_file` 读的就是这个形状，
 * 少一个字段它就拿不到东西。
 */
export function writeGraphFile(path, graphId, nodes, edges) {
	mkdirSync(dirname(path), { recursive: true })
	const payload = { graph_id: graphId || 'kg', nodes, edges, links: [] }
	writeFileSync(path, JSON.stringify(payload), 'utf8')
	return { path, bytes: statSync(path).size }
}

/** 图文件最后被写过的时间（毫秒）；不存在返回 null。 */
export function graphMtime(path) {
	try {
		return statSync(path).mtimeMs
	} catch {
		return null
	}
}

/** 删掉视图图文件（回收时用）。 */
export function removeFile(path) {
	try {
		rmSync(path, { force: true })
	} catch {
		// 删不掉就算了：它只是缓存产物，下次会覆盖
	}
}
