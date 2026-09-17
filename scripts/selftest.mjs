#!/usr/bin/env node
// scripts/selftest.mjs — 离线自检：不启动 DSH，直接把整条链路跑一遍。
//
// 覆盖的东西（每一块都断言，失败就报出来）：
//
//   1. 造图      —— 用插件 venv 里真的 semantica 建一张图，模拟模型通过 MCP 写进去的
//                   样子：两个会话打标 + 一个没打标的实体 + 两条决策（一条靠实体边归属、
//                   一条只能靠时间窗口认领）。
//   2. 切图      —— src/kg.js 的 scopeGraph：本对话这一刀切得对不对（含决策的两条认领路）。
//   3. 分析      —— src/kg.js 的 analyze：枢纽/社区/决策清单/时间线算得出来。
//   4. 展示      —— src/explorer.js 真的起一个 semantica Explorer，探它的接口，
//                   并断言**图里的内容真的到了 Explorer 那边**（找得到我们建的实体名）。
//
// 用法：node scripts/selftest.mjs

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
	SCOPE_VERSION,
	analyze,
	readGraph,
	removeFile,
	scopeGraph,
	sessionGraphPath,
	summarize,
	writeGraphFile,
} from '../src/kg.js'
import { ExplorerHost, probeExplorer, resolvePython } from '../src/explorer.js'
import {
	DIRECTIVE_VARIABLE,
	SECTION_NAME,
	SECTION_TEXT,
	SESSION_VARIABLE,
	directiveFor,
	instructionFor,
} from '../src/prompt.js'
import { createToggleStore } from '../src/toggle.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SESSION_A = 'session-aaaa-1111'
const SESSION_B = 'session-bbbb-2222'
const DECISION_WINDOW = { from: Date.now() - 3600_000, to: Date.now() + 60_000 }

let failures = 0
function check(label, ok, detail) {
	const mark = ok ? '✓' : '✗'
	if (!ok) failures += 1
	console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

// 先把插件自己会用的解释器钉下来：下面第 6 段会把 DSH_HOME 指到临时目录，
// 而 explorer.js 找解释器时也顺着 DSH_HOME 走（正常情况下 DSH_HOME 就是 harness 根，
// 两者一致；测试里不一致，所以这里显式固定，免得测试把自己绊倒）。
const PYTHON = resolvePython()

const work = mkdtempSync(join(tmpdir(), 'semantica-selftest-'))
const kgFile = join(work, 'kg.json')
const viewFile = join(work, 'view.json')

// ── 1. 造图：直接用 semantica 的 API，形状和 MCP 写出来的完全一致 ──
//
// （record_decision 的 timestamp 就是"现在"，所以它落在 DECISION_WINDOW 里。）

const buildScript = `
import json
from semantica.context import ContextGraph
g = ContextGraph(advanced_analytics=True)
tag = lambda s: {"conversation": s}
g.add_node(node_id="vite", label="Vite", node_type="PRODUCT", metadata=tag(${JSON.stringify(SESSION_A)}))
g.add_node(node_id="react", label="React", node_type="ORG", metadata=tag(${JSON.stringify(SESSION_A)}))
g.add_node(node_id="esbuild", label="esbuild", node_type="PRODUCT", metadata=tag(${JSON.stringify(SESSION_A)}))
g.add_node(node_id="vue", label="Vue", node_type="PRODUCT", metadata=tag(${JSON.stringify(SESSION_B)}))
g.add_node(node_id="loose", label="没打标的实体", node_type="CONCEPT", metadata={})
g.add_edge(source_id="vite", target_id="esbuild", edge_type="uses", metadata=tag(${JSON.stringify(SESSION_A)}))
g.add_edge(source_id="vite", target_id="react", edge_type="supports", metadata=tag(${JSON.stringify(SESSION_A)}))
g.add_edge(source_id="vue", target_id="esbuild", edge_type="uses", metadata=tag(${JSON.stringify(SESSION_B)}))
# 决策一：带 entities → 靠实体边归属到会话 A
g.record_decision(category="构建工具", scenario="选 vite 还是 webpack", reasoning="冷启动快",
                  outcome="用 vite", confidence=1.0, entities=["vite", "esbuild"], decision_maker="user")
# 决策二：不带 entities → 只能靠时间窗口认领
g.record_decision(category="测试框架", scenario="选 vitest", reasoning="和 vite 同源",
                  outcome="用 vitest", confidence=1.0, decision_maker="user")
# 超长的旧图：插一个和本会话无关、时间上也很远的决策，确认它不会跑进本对话视图
g.record_decision(category="无关决策", scenario="很久以前", reasoning="不该被认领",
                  outcome="nope", confidence=1.0, decision_maker="user",
                  valid_from="2020-01-01T00:00:00")
g.save_to_file(${JSON.stringify(kgFile)})
print("built")
`

console.log('• 用 semantica 造一张测试图…')
const py = resolvePython()
const built = spawnSync(py, ['-c', buildScript], { encoding: 'utf8' })
if (built.status !== 0) {
	console.error(built.stderr || built.stdout)
	console.error(`✗ 造图失败（解释器：${py}）`)
	process.exit(1)
}
check('造图成功', built.stdout.includes('built'), kgFile)

// record_decision 的 timestamp 永远是「现在」，所以「时间上远在窗口外」这件事只能事后
// 改 JSON 才能造出来。不改的话那条远古决策会被时间窗口正常认领 —— 那是**对的**行为，
// 测不出窗口边界。
{
	const raw = JSON.parse(readFileSync(kgFile, 'utf8'))
	const old = raw.nodes.find((n) => (n.properties ?? {}).category === '无关决策')
	if (old) {
		old.properties.timestamp = (Date.now() - 30 * 24 * 3600_000) / 1000
		writeFileSync(kgFile, JSON.stringify(raw), 'utf8')
	}
	check('远古决策的时间已改到 30 天前', Boolean(old), old ? String(old.properties.timestamp) : '没找到')
}

// ── 2. 切图 ──

const graph = readGraph(kgFile)
check('readGraph 读到图', Boolean(graph && graph.nodes.length >= 5), `nodes=${graph?.nodes.length}`)

const scopedA = scopeGraph(graph, { sessionId: SESSION_A, mode: 'conversation', window: DECISION_WINDOW })
const idsA = scopedA.nodes.map((n) => n.id).sort()
check('本对话视图只留本会话的实体', idsA.includes('vite') && idsA.includes('react') && !idsA.includes('vue'), idsA.join(','))
check('没打标的实体不进本对话视图', !idsA.includes('loose'))
check('按实体边认领到 1 条决策', scopedA.claim.byEntity === 1, `byEntity=${scopedA.claim.byEntity}`)
check('时间窗兜底认领已经拆掉（不再有时段猜归属这条路）', scopedA.claim.byTime === undefined, `byTime=${scopedA.claim.byTime}`)
check(
	'只有挂在本会话实体上的决策进本对话视图',
	scopedA.nodes.filter((n) => n.type === 'decision').length === 1 &&
		!scopedA.nodes.some((n) => (n.properties ?? {}).category === '测试框架'),
	`decisions=${scopedA.nodes.filter((n) => n.type === 'decision').length}`,
)
// 这条是用户当场发现的那个 bug：一个**从没提取过**的会话，打开面板却看到了别人的 6 个节点 ——
// 就是因为没打标的决策被「时间窗」认领了。现在它只能出现在「全部」里。
const scopedB2 = scopeGraph(graph, { sessionId: SESSION_B, mode: 'conversation' })
check(
	'不带 entities 的决策：A 和 B 都不认领它（宁可不认，不能认错）',
	!scopedA.nodes.some((n) => (n.properties ?? {}).category === '测试框架') &&
		!scopedB2.nodes.some((n) => (n.properties ?? {}).category === '测试框架'),
	`A=${scopedA.nodes.length} 节点 / B=${scopedB2.nodes.length} 节点`,
)
check(
	'未打标只数「压根没打标」的（别的会话写的不算）',
	scopedA.claim.untagged === 1,
	`untagged=${scopedA.claim.untagged}, tagged(本会话)=${scopedA.claim.tagged}`,
)
check(
	'跨会话的边被切掉（vue→esbuild 不在）',
	!scopedA.edges.some((e) => e.source_id === 'vue' || e.target_id === 'vue'),
	`edges=${scopedA.edges.length}`,
)

// 视图里不能有悬空边：边的两端必须都在视图节点里。
// 真发生过（用户机器上那张图）：会话 A 建的 `guangzhou` 被会话 B 用同一个 id 复用，
// add_entity 是整体覆盖的 upsert，节点上的 metadata（含会话标）被整个换掉 → A 亲手建的
// 节点从 A 的视图里消失，而 A 写的那条边还在，于是视图里留下一条指向不存在节点的边。
const danglingOf = (sc) => {
	const ids = new Set(sc.nodes.map((n) => String(n.id)))
	return sc.edges.filter((e) => !ids.has(String(e.source_id)) || !ids.has(String(e.target_id)))
}
check(
	'视图里没有悬空边（边两端都在视图节点里）',
	danglingOf(scopedA).length === 0,
	JSON.stringify(danglingOf(scopedA).map((e) => `${e.source_id}->${e.target_id}`)),
)
check(
	'本会话写过的边，两端也进视图（B 写了 vue→esbuild，esbuild 就跟着进来）',
	scopedB2.nodes.some((n) => n.id === 'esbuild') &&
		scopedB2.edges.some((e) => e.source_id === 'vue' && e.target_id === 'esbuild') &&
		danglingOf(scopedB2).length === 0,
	`B=${scopedB2.nodes.map((n) => n.id).join(',')} claim.byEdge=${scopedB2.claim.byEdge}`,
)
check(
	'本会话写的边数记在 claim.byEdge 里（界面上说得清这节点是怎么进来的）',
	scopedB2.claim.byEdge === 1 && scopedA.claim.byEdge === 0,
	`A.byEdge=${scopedA.claim.byEdge} B.byEdge=${scopedB2.claim.byEdge}`,
)
// 复现用户机器上那个覆盖：把 esbuild 的会话标改成 B（等于 B 复用同一 id 把它抢走）
{
	const stolen = JSON.parse(JSON.stringify(graph))
	const esbuild = stolen.nodes.find((n) => n.id === 'esbuild')
	esbuild.properties.metadata = { conversation: SESSION_B }
	const scopedAfterTheft = scopeGraph(stolen, { sessionId: SESSION_A, mode: 'conversation' })
	check(
		'节点被别的会话抢走标之后，A 仍然看得到它（因为 A 写过连它的边）',
		scopedAfterTheft.nodes.some((n) => n.id === 'esbuild') && scopedAfterTheft.claim.byEdge === 1,
		`nodes=${scopedAfterTheft.nodes.map((n) => n.id).join(',')}`,
	)
	check(
		'被抢走之后视图里也不出现悬空边',
		danglingOf(scopedAfterTheft).length === 0,
		JSON.stringify(danglingOf(scopedAfterTheft).map((e) => `${e.source_id}->${e.target_id}`)),
	)
}

const scopedAll = scopeGraph(graph, { sessionId: SESSION_A, mode: 'all', window: DECISION_WINDOW })
check('「全部」模式不切图', scopedAll.nodes.length === graph.nodes.length, `nodes=${scopedAll.nodes.length}`)
check(
	'它仍然在「全部」里看得到（不是被藏起来）',
	scopedAll.nodes.some((n) => (n.properties ?? {}).category === '测试框架'),
	`全部=${scopedAll.nodes.length} 节点`,
)

const statsA = summarize(scopedA.nodes, scopedA.edges)
check(
	'统计口径：实体/关系不算决策附属',
	statsA.entities === 3 && statsA.decisions === 1 && statsA.relations >= 2,
	JSON.stringify({ e: statsA.entities, d: statsA.decisions, r: statsA.relations }),
)

// ── 3. 分析 ──

const a = analyze(scopedA.nodes, scopedA.edges)
check('枢纽榜有内容', a.hubs.byDegree.length > 0 && a.hubs.byRank.length > 0, `top=${a.hubs.byDegree[0]?.label}`)
check('概览连通分量为 1', a.overview.components === 1, `components=${a.overview.components}`)
check('决策清单只列本会话的（1 条）', a.decisions.length === 1)
check(
	'决策带上了关联实体',
	a.decisions.some((d) => d.entities.some((e) => e.id === 'vite')),
	JSON.stringify(a.decisions.map((d) => d.entities.map((e) => e.id))),
)
check('时间线按天分桶', a.timeline.length >= 1, JSON.stringify(a.timeline))
check('社区检测能跑（允许 0 个，但不能抛）', Array.isArray(a.communities), `communities=${a.communities.length}`)

// ── 4. 提示词 ──

check('提示词段引用了会话变量', SECTION_TEXT.includes(`{{${SESSION_VARIABLE}}}`), SECTION_NAME)
check('可复制指令带上了具体会话 id', instructionFor(SESSION_A).includes(SESSION_A))

// ── 5. 展示：真的起一个 Explorer，并确认图内容到了那边 ──

const probe = await probeExplorer()
check('Explorer 依赖可用', probe.ok, probe.ok ? `semantica ${probe.version}` : `${probe.error} / ${probe.hint}`)

if (probe.ok) {
	writeGraphFile(viewFile, 'selftest', scopedA.nodes, scopedA.edges)
	const host = new ExplorerHost()
	try {
		const started = await host.start('selftest', viewFile)
		check('Explorer 起来了', Boolean(started.url), started.url)

		const health = await fetch(`${started.url}/api/health`)
		check('/api/health 正常', health.ok, String(health.status))

		// 内容真的过去了没有 —— 找得到我们建的实体名才算数。
		const spec = await (await fetch(`${started.url}/openapi.json`)).json()
		const paths = Object.keys(spec.paths ?? {})
		check('Explorer 暴露了接口', paths.length > 10, `${paths.length} 个路径`)

		const candidates = paths.filter(
			(p) => /(graph|stats|summary|entit|node|search|metrics)/i.test(p) && !p.includes('{'),
		)
		let found = null
		for (const p of candidates.slice(0, 14)) {
			try {
				const r = await fetch(`${started.url}${p}`)
				if (!r.ok) continue
				const text = await r.text()
				if (text.includes('vite') || text.includes('Vite')) {
					found = p
					break
				}
			} catch {
				// 单个接口失败就试下一个
			}
		}
		check('图内容真的到了 Explorer（找得到 vite）', Boolean(found), found ? `命中 ${found}` : `试过：${candidates.slice(0, 14).join(', ')}`)
	} catch (err) {
		check('Explorer 起来了', false, String(err?.message ?? err))
	} finally {
		host.dispose()
	}
}


// ── 6. host 半侧：用假 ctx 把 apply() 真跑一遍 ──
//
// 这一块以前是测不到的（要重启 DSH 才能验），但改 host 就得重启，代价太大。所以这里
// 造一个最小的 Cordis 形状：ctx.inject 立刻回调、ctx.effect 收下清理函数、
// ctx.get('sessionPersistence') 给个假的 —— 然后拿真路由的 handler 直接发请求。

process.env.DSH_HOME = work
process.env.DSH_SEMANTICA_PYTHON = PYTHON
const { apply } = await import('../src/index.js')

const routes = new Map()
const sections = []
const variables = []
const disposers = []
const fakePersistence = {
	async list() {
		return [{ id: SESSION_A, createdAt: Date.now() - 600_000 }]
	},
	locate() {
		return kgFile
	},
}
const hostCtx = {
	effect(fn) {
		const d = fn()
		if (typeof d === 'function') disposers.push(d)
	},
	on() {},
	get(name) {
		return name === 'sessionPersistence' ? fakePersistence : undefined
	},
	inject(names, cb) {
		if (names.includes('systemPrompt')) {
			cb({
				effect: hostCtx.effect,
				systemPrompt: {
					section(spec) {
						sections.push(spec)
						return () => {}
					},
					variable(name, fn) {
						variables.push({ name, fn })
						return () => {}
					},
				},
			})
		}
		if (names.includes('webServer')) {
			cb({
				effect: hostCtx.effect,
				webServer: {
					register(def) {
						routes.set(def.path, def)
					},
				},
			})
		}
	},
}

apply(hostCtx, {})

check('注册了提示词段（名字/顺序）', sections.length === 1 && sections[0].name === SECTION_NAME && sections[0].order === 700, JSON.stringify(sections.map((s) => [s.name, s.order])))
check('提示词段正文带会话变量占位', Boolean(sections[0]) && sections[0].text.includes(`{{${SESSION_VARIABLE}}}`))
check(
	'注册了两个变量：会话标识 + 写入准则',
	variables.length === 2 &&
		variables.some((v) => v.name === SESSION_VARIABLE) &&
		variables.some((v) => v.name === DIRECTIVE_VARIABLE),
	JSON.stringify(variables.map((v) => v.name)),
)
check(
	'会话变量取的是当前会话 id（模型据此打标）',
	variables[0]?.fn({ agent: { session: { header: { id: SESSION_A } } } }) === SESSION_A,
	String(variables[0]?.fn({ agent: { session: { header: { id: SESSION_A } } } })),
)
check(
	'上下文里没有会话时给空串（不是 undefined）',
	variables[0]?.fn({}) === '',
	JSON.stringify(variables[0]?.fn({})),
)

// 变量注册失败时的防线。
//
// dsh-system-prompt 的 interpolate() 遇到没注册的 `{{x}}` 会**直接抛异常**。段落里
// 引用了会话变量，所以「段落留下、变量没留下」是最坏的组合：之后每一次组装提示词都炸。
// 这里让 variable() 抛，断言段落一个都没留下。
{
	const sections2 = []
	const ctx2 = {
		effect(fn) {
			fn()
		},
		on() {},
		get() {
			return undefined
		},
		inject(names, cb) {
			if (names.includes('systemPrompt')) {
				cb({
					effect: ctx2.effect,
					systemPrompt: {
						variable() {
							throw new Error('占位：注册失败')
						},
						section(spec) {
							sections2.push(spec)
							return () => {}
						},
					},
				})
			}
		},
	}
	apply(ctx2, {})
	check('变量没注册上时不留段落（否则每次提示词组装都会抛）', sections2.length === 0, `sections=${sections2.length}`)
}

const wantPaths = [
	'/api-semantica/status',
	'/api-semantica/view',
	'/api-semantica/analysis',
	'/api-semantica/diag',
]
check('四个路由都注册了', wantPaths.every((p) => routes.has(p)), [...routes.keys()].join(', '))

/** 假的 req / res，够 readBody 与 send 用。 */
function fakeReq(url, body) {
	const listeners = {}
	const req = {
		url,
		on(ev, fn) {
			;(listeners[ev] ??= []).push(fn)
			return req
		},
		destroy() {},
	}
	setImmediate(() => {
		if (body !== undefined) for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify(body)))
		for (const fn of listeners.end ?? []) fn()
	})
	return req
}
function fakeRes() {
	return {
		status: 0,
		headers: null,
		body: null,
		writeHead(status, headers) {
			this.status = status
			this.headers = headers
		},
		end(body) {
			this.body = body
		},
	}
}
async function call(path, { query = '', body } = {}) {
	const res = fakeRes()
	await routes.get(path).handler(fakeReq(path + query, body), res)
	return { status: res.status, json: JSON.parse(res.body) }
}

// 图文件还不存在时，三个接口都不该崩
// —— 「每轮自动提取」开关 ——
//
// 它代替的是「把提取指令粘进对话」这个动作：打开之后，每次组装提示词时
// DIRECTIVE_VARIABLE 会给模型一段「本轮回复结束前必须写进图谱」的强制要求。

const autoOff = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
// 用户明确要求：新对话默认**开**。理由是他报的那句「打开知识图谱，里面跟我这个对话
// 完全没关系」—— 查下来那个对话一个字都没写进去，而默认关意味着「打开面板什么都看不到」。
check(
	'新装（还没有配置文件）时默认就是「开」',
	autoOff.json.auto?.on === true && autoOff.json.auto?.default === true,
	JSON.stringify(autoOff.json.auto),
)
check(
	'status 报出切图规则版本（前端拿它当视图键的一部分）',
	autoOff.json.scope?.version === SCOPE_VERSION,
	JSON.stringify(autoOff.json.scope),
)

const autoOn = await call('/api-semantica/auto', { body: { sessionId: SESSION_A, on: true } })
check('开关能打开', autoOn.json.ok === true && autoOn.json.on === true, JSON.stringify(autoOn.json))

const autoStatus = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
check('打开之后 status 读得到', autoStatus.json.auto?.on === true, JSON.stringify(autoStatus.json.auto))

// 把默认显式关掉，再看别的会话 —— 这一步同时验证「默认能被关」和「开关是按会话的」
const defOff = await call('/api-semantica/auto', { body: { default: false } })
check('能把新会话默认值显式关掉', defOff.json.ok === true && defOff.json.default === false, JSON.stringify(defOff.json))
const autoOther = await call('/api-semantica/status', { query: `?sessionId=${SESSION_B}` })
check(
	'开关是**按会话**的：显式关掉默认后，没单独设过的会话跟着默认（关）',
	autoOther.json.auto?.on === false && autoOther.json.auto?.default === false,
	JSON.stringify(autoOther.json.auto),
)

const directiveVariable = variables.find((v) => v.name === DIRECTIVE_VARIABLE)
const directiveOn = directiveVariable?.fn({ agent: { session: { header: { id: SESSION_A } } } }) ?? ''
// 此刻 SESSION_A 是显式打开、SESSION_B 跟着「关」的默认值 —— 正好一个强制、一个轻量
const directiveOff = directiveVariable?.fn({ agent: { session: { header: { id: SESSION_B } } } }) ?? ''
check('开着时会话拿到的准则是「每轮必写」', directiveOn.includes('每一轮回复结束前都必须'), directiveOn.slice(0, 40))
check('关着时同一段落给的是轻量准则', directiveOff.includes('顺手写一条') && !directiveOff.includes('每一轮回复结束前都必须'), directiveOff.slice(0, 40))
check('两种准则都要求带 metadata 和 entities', directiveOn.includes('metadata={"conversation"') && directiveOn.includes('entities'), directiveOn.length + ' 字')

const autoOffAgain = await call('/api-semantica/auto', { body: { sessionId: SESSION_A, on: false } })
const autoStatus2 = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
check('开关能关掉', autoOffAgain.json.on === false && autoStatus2.json.auto?.on === false, JSON.stringify(autoStatus2.json.auto))

const autoNoId = await call('/api-semantica/auto', { body: { on: true } })
check('缺 sessionId 时开关不写入，并回一个明确错误', autoNoId.json.ok === false && String(autoNoId.json.error).includes('sessionId'), JSON.stringify(autoNoId.json))

// 落盘 + 重启后还在（内存里同步读得到，是因为它在 load() 里读回来）
const autoFile = join(work, 'dsh-semantica-graph', 'auto-extract.json')
await call('/api-semantica/auto', { body: { sessionId: SESSION_A, on: true } })
{
	const onDisk = existsSync(autoFile) ? JSON.parse(readFileSync(autoFile, 'utf8')) : null
	check(
		'开关落盘了（格式带版本号 v + default + sessions）',
		onDisk?.v === 1 && onDisk?.sessions?.[SESSION_A]?.on === true,
		JSON.stringify({ v: onDisk?.v, sessions: Object.keys(onDisk?.sessions ?? {}) }),
	)
}

// —— 旧格式文件的升级 ——
//
// 老版本写的文件里没有 v 字段，那个 `default: false` 是**旧代码的默认值**，不是用户的选择。
// 新策略（默认开）必须能把它升上来，否则用户改了代码却看不到任何变化 —— 他的机器上就是
// 这种情况：文件里写着 default: false，从没被谁点过。
{
	const legacyFile = join(work, 'legacy-auto.json')
	writeFileSync(
		legacyFile,
		JSON.stringify({ default: false, sessions: { [SESSION_A]: { on: true, updatedAt: '2026-01-01T00:00:00.000Z' } } }),
	)
	const legacy = createToggleStore(legacyFile)
	const LEGACY_NEW = 'session-legacy-untouched'
	check(
		'旧格式文件（没有 v）按新默认升级：没设过的新会话是「开」',
		legacy.getDefault() === true && legacy.isOn(LEGACY_NEW) === true,
		JSON.stringify({ def: legacy.getDefault(), on: legacy.isOn(LEGACY_NEW) }),
	)
	check('旧文件里单独设过的会话照旧保留', legacy.isOn(SESSION_A) === true, String(legacy.isOn(SESSION_A)))
	// 再显式关一次默认 —— 这次带 v 了，必须被当真（不能又升回开）
	legacy.setDefault(false)
	const legacy2 = createToggleStore(legacyFile)
	check(
		'显式关掉的默认值不会再被升级覆盖（v 字段生效）',
		JSON.parse(readFileSync(legacyFile, 'utf8')).v === 1 && legacy2.getDefault() === false,
		JSON.stringify({ def: legacy2.getDefault() }),
	)
}
const reopened = createToggleStore(autoFile)
check('换一个 store 重新读（等价于重启）状态还在', reopened.isOn(SESSION_A) === true && reopened.isOn(SESSION_B) === false)

// —— 「新会话默认」 ——
//
// 这一条是为用户那句「第一次输入不渲染上面的部分啊，我怎么点」加的：新建对话在发出
// 第一条消息之前**根本没有会话**，核心那排标签/标题是会话级槽，那时整排都不渲染，
// 任何「按会话」的开关都够不着。所以「以后每条新对话都自动提取」只能靠默认值提前设好。
const SESSION_NEW = 'session-brand-new-9999'
const defFollower = await call('/api-semantica/status', { query: `?sessionId=${SESSION_NEW}` })
check(
	'没有单独设过的新会话跟着默认值（此刻默认被显式关成 false）',
	defFollower.json.auto?.on === false && defFollower.json.auto?.default === false,
	JSON.stringify(defFollower.json.auto),
)

const defSet = await call('/api-semantica/auto', { body: { default: true } })
check('能把新会话默认值设成「开」', defSet.json.ok === true && defSet.json.default === true, JSON.stringify(defSet.json))

const defOn = await call('/api-semantica/status', { query: `?sessionId=${SESSION_NEW}` })
check('之后新会话一上来就是「开」（第一条消息就已经自动提取）', defOn.json.auto?.on === true && defOn.json.auto?.default === true, JSON.stringify(defOn.json.auto))
check('默认值不影响被单独设过的会话', autoStatus2.json.auto?.on === false && defOn.json.auto?.explicit === false, JSON.stringify({ a: autoStatus2.json.auto, n: defOn.json.auto }))

const directiveNew = directiveVariable?.fn({ agent: { session: { header: { id: SESSION_NEW } } } }) ?? ''
check('新会话拿到的提示词准则也是「每轮必写」', directiveNew.includes('每一轮回复结束前都必须'), directiveNew.slice(0, 30))

// 单独关掉一个会话：即使默认是开，这个会话也关着
await call('/api-semantica/auto', { body: { sessionId: SESSION_NEW, on: false } })
const defOverride = await call('/api-semantica/status', { query: `?sessionId=${SESSION_NEW}` })
check('默认开着时也能单独关掉某个会话', defOverride.json.auto?.on === false && defOverride.json.auto?.explicit === true, JSON.stringify(defOverride.json.auto))

await call('/api-semantica/auto', { body: { default: false } })
await call('/api-semantica/auto', { body: { sessionId: SESSION_A, on: false } })

const statusNoKg = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
check('status 能干跑（还没有图文件时）', statusNoKg.status === 200 && statusNoKg.json.ok === true, JSON.stringify(statusNoKg.json.kg))
check('status 报出「图文件不存在」', statusNoKg.json.kg.exists === false, String(statusNoKg.json.kg.exists))
check('status 带上可复制的提取指令', String(statusNoKg.json.instruction).includes(SESSION_A))

// 把测试图放到「harness 家目录」下，三个接口就都有数据了
const kgDir = join(work, 'dsh-semantica-graph')
mkdirSync(kgDir, { recursive: true })
copyFileSync(kgFile, join(kgDir, 'kg.json'))

const statusOk = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
check('status 读到图（节点/边计数）', statusOk.json.kg.exists === true && statusOk.json.kg.nodes > 0, JSON.stringify({ n: statusOk.json.kg.nodes, e: statusOk.json.kg.edges }))

const viewRes = await call('/api-semantica/view', { body: { sessionId: SESSION_A, mode: 'conversation' } })
check('view 出图成功并给了 URL', viewRes.status === 200 && viewRes.json.ok === true, JSON.stringify({ ok: viewRes.json.ok, err: viewRes.json.error, url: viewRes.json.url }))
check('view 的统计是切过的图（不含别的会话）', viewRes.json.stats?.nodes === scopedA.nodes.length, JSON.stringify(viewRes.json.stats && { n: viewRes.json.stats.nodes, d: viewRes.json.stats.decisions }))
check('view 视图文件写到了 views/ 下', Boolean(viewRes.json.viewPath && viewRes.json.viewPath.includes('views')), String(viewRes.json.viewPath))
// 视图键里带规则版本 —— 规则改了，旧的视图文件与 Explorer 实例就不再被沿用
check(
	'视图键里带切图规则版本',
	String(viewRes.json.key ?? '').endsWith(`:v${SCOPE_VERSION}`),
	String(viewRes.json.key),
)
check(
	'视图文件名里也带版本（旧规则那份不会顶上来）',
	String(viewRes.json.viewPath ?? '').includes(`v${SCOPE_VERSION}.json`),
	String(viewRes.json.viewPath ?? '').split('/').pop(),
)
if (viewRes.json.viewPath) {
	const written = JSON.parse(readFileSync(viewRes.json.viewPath, 'utf8'))
	check('视图文件形状对（graph_id/nodes/edges）', written.graph_id.startsWith('semantica-graph:') && Array.isArray(written.nodes) && Array.isArray(written.edges), `${written.nodes.length} 节点`)
}

// —— 本会话自己的物理图文件（C：写入按会话分文件）——
//
// 包装层 mcp/server.py 会把每次写入同时落到 <图目录>/sessions/<会话>.json。插件在「本对话」
// 模式下**优先读这个文件**：它里面只有本会话写的东西，所以不需要按标认领，也不可能出现
// 「节点被别的会话覆盖标、于是本会话视图里少一个」。
const sessDir = join(kgDir, 'sessions')
const sessFile = sessionGraphPath(join(kgDir, 'kg.json'), SESSION_A)
check(
	'会话文件路径 = 图目录/sessions/<会话>.json',
	sessFile === join(sessDir, `${SESSION_A}.json`),
	String(sessFile),
)
check(
	'会话 id 里的路径成分被净化掉（id 来自模型可写的 metadata，不能当路径用）',
	sessionGraphPath('/x/kg.json', '../../evil/id') === '/x/sessions/evil_id.json' &&
		sessionGraphPath('/x/kg.json', '') === null,
	String(sessionGraphPath('/x/kg.json', '../../evil/id')),
)

mkdirSync(sessDir, { recursive: true })
// 故意让 esbuild 在会话文件里是 A 的版本，而合并图里它是 B 的（真实事故的形状）
writeFileSync(
	sessFile,
	JSON.stringify({
		graph_id: 'semantica-graph:own:A',
		nodes: [
			{ id: 'only-a', type: 'Own', properties: { label: 'A 自己的节点', content: 'only-a' } },
			{ id: 'esbuild', type: 'BundleA', properties: { label: 'A 的 esbuild 写法', content: 'esbuild' } },
			{ id: 'a-decision', type: 'decision', properties: { category: 'A 的决策', outcome: 'done' } },
		],
		edges: [
			{ source_id: 'only-a', target_id: 'esbuild', type: 'USES' },
			// 悬空边：端点只有合并图里有 —— 视图必须把它清掉（同一类 bug 犯过一次就够）
			{ source_id: 'only-a', target_id: 'not-here', type: 'BROKEN' },
		],
		links: [],
	}),
)

const ownStatus = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
check(
	'status 报出本会话文件的路径 + 存在 + 计数',
	ownStatus.json.session?.path === sessFile &&
		ownStatus.json.session?.exists === true &&
		ownStatus.json.session?.nodes === 3 &&
		ownStatus.json.session?.edges === 2,
	JSON.stringify(ownStatus.json.session),
)

const ownView = await call('/api-semantica/view', { body: { sessionId: SESSION_A, mode: 'conversation' } })
check('有会话文件时，「本对话」直接读它', ownView.json.source === 'session-file', String(ownView.json.source))
check(
	'读到的是这个会话自己的 3 个节点（不是合并图里挑出来的）',
	ownView.json.stats?.nodes === 3 && ownView.json.stats?.edges === 1,
	JSON.stringify({ n: ownView.json.stats?.nodes, e: ownView.json.stats?.edges }),
)
check(
	'悬空边被清掉，但计数留给诊断（claim.droppedEdges）',
	ownView.json.claim?.droppedEdges === 1,
	JSON.stringify(ownView.json.claim),
)
{
	const written = JSON.parse(readFileSync(ownView.json.viewPath, 'utf8'))
	const esb = written.nodes.find((n) => n.id === 'esbuild')
	check(
		'★ A 的视图里 esbuild 是 A 的版本（合并图里它已经被 B 覆盖）',
		esb?.type === 'BundleA',
		JSON.stringify(written.nodes.map((n) => [n.id, n.type])),
	)
	check(
		'视图里没有合并图独有的节点（物理隔离，不是筛出来的）',
		!written.nodes.some((n) => n.id === 'vue' || n.id === 'loose'),
		JSON.stringify(written.nodes.map((n) => n.id)),
	)
	check(
		'视图里也没有那条悬空边',
		!written.edges.some((e) => e.target_id === 'not-here'),
		JSON.stringify(written.edges.map((e) => [e.source_id, e.target_id])),
	)
}

// 把会话文件删掉 → 退回「在合并图上按标筛」，行为与接通前一致（包装层没装也不能崩）
removeFile(sessFile)
const fallbackStatus = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
check(
	'没有会话文件时 status 明说「不存在」（界面才能解释为什么是筛出来的）',
	fallbackStatus.json.session?.path === sessFile && fallbackStatus.json.session?.exists === false,
	JSON.stringify(fallbackStatus.json.session),
)
const fallbackView = await call('/api-semantica/view', { body: { sessionId: SESSION_A, mode: 'conversation' } })
check(
	'退回按标筛，节点数回到切图结果',
	fallbackView.json.source === 'merged-scope' && fallbackView.json.stats?.nodes === scopedA.nodes.length,
	JSON.stringify({ source: fallbackView.json.source, n: fallbackView.json.stats?.nodes, want: scopedA.nodes.length }),
)
const allView = await call('/api-semantica/view', { body: { sessionId: SESSION_A, mode: 'all' } })
check(
	'「全部」永远不读会话文件（它就是整张合并图）',
	allView.json.source === 'merged-scope' && allView.json.session === null,
	JSON.stringify({ source: allView.json.source, session: allView.json.session }),
)

const anaRes = await call('/api-semantica/analysis', { body: { sessionId: SESSION_A, mode: 'conversation' } })
check('analysis 返回分析结果', anaRes.json.ok === true && anaRes.json.analysis?.decisions?.length === 1, JSON.stringify({ ok: anaRes.json.ok, d: anaRes.json.analysis?.decisions?.length }))
check('analysis 里有枢纽与时间线', (anaRes.json.analysis?.hubs?.byDegree?.length ?? 0) > 0 && (anaRes.json.analysis?.timeline?.length ?? 0) > 0)

// 界面诊断：前端回传的真 DOM 几何要落盘（我看不见那个窗口，只能靠这条通道）
const diagRes = await call('/api-semantica/diag', {
	body: {
		sessionId: SESSION_A,
		reason: 'mount',
		diag: { reason: 'mount', cssLoaded: true, chain: [{ tag: 'div' }, { tag: 'body' }], inner: { bar: { rect: [0, 0, 900, 34] } } },
	},
})
check('诊断回传被接受', diagRes.status === 200 && diagRes.json.ok === true, JSON.stringify(diagRes.json))
const diagFile = join(work, 'dsh-semantica-graph', 'last-diag.json')
const diagDisk = existsSync(diagFile) ? JSON.parse(readFileSync(diagFile, 'utf8')) : null
check(
	'诊断落盘了（host 写文件，之后我读文件就有证据）',
	diagDisk?.sessionId === SESSION_A && diagDisk?.diag?.chain?.length === 2 && typeof diagDisk.receivedAt === 'string',
	JSON.stringify(diagDisk && { sessionId: diagDisk.sessionId, chain: diagDisk.diag?.chain?.length, receivedAt: diagDisk.receivedAt }),
)

const allRes = await call('/api-semantica/analysis', { body: { sessionId: SESSION_A, mode: 'all' } })
check('「全部」模式看到整张图', allRes.json.stats?.nodes === graph.nodes.length, `${allRes.json.stats?.nodes} vs ${graph.nodes.length}`)

const badRes = await call('/api-semantica/analysis', { body: {} })
check('没给会话 id 时明确报错（不是静默）', badRes.json.ok === false && badRes.json.code === 'no-session', JSON.stringify(badRes.json))

// 收尾：走一遍清理函数，把 Explorer 子进程收掉
// ── 图文件路径：以 profile 里写死的 SEMANTICA_KG_PATH 为准 ──
//
// 这条是给一个真会咬人的场景兜底的：MCP 子进程读写的图文件由 profile 里的
// SEMANTICA_KG_PATH 决定，插件以前却自己按约定拼路径。用户改过那里（或装到别的目录）
// 时，面板显示的路径就与实际用的不是同一个 —— 而面板还让你点它复制。
{
	const profilesDir = join(work, 'profiles', 'web')
	mkdirSync(profilesDir, { recursive: true })
	const customDir = join(work, 'elsewhere')
	mkdirSync(customDir, { recursive: true })
	const customKg = join(customDir, 'my-graph.json')
	// 写一张「一眼认得出」的图：只有一个节点，和约定位置那张完全不同
	writeFileSync(
		customKg,
		JSON.stringify({ graph_id: 'custom', nodes: [{ id: 'only-here', label: '只有这个文件里才有' }], edges: [] }),
	)
	writeFileSync(
		join(profilesDir, 'cordis.patch.yml'),
		[
			'- id: mcp-semantica',
			'  config:',
			'    servers:',
			'      semantica:',
			'        command: semantica-mcp',
			'        env:',
			`          SEMANTICA_KG_PATH: '${customKg}'`,
			'',
		].join('\n'),
	)

	const custom = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
	check(
		'MCP 配了自定义图路径时，status 报的是 profile 里那一个（不是插件自己拼的）',
		custom.json.kg?.path === customKg,
		JSON.stringify({ got: custom.json.kg?.path, want: customKg }),
	)
	check(
		'读的也确实是那个文件（节点数来自自定义图）',
		custom.json.kg?.exists === true && custom.json.kg?.nodes === 1,
		JSON.stringify({ exists: custom.json.kg?.exists, nodes: custom.json.kg?.nodes }),
	)
	check(
		'status 说出了这个路径是哪来的（profile 名）',
		custom.json.kg?.source === 'profile:web' && custom.json.kg?.nonDefault === true,
		JSON.stringify({ source: custom.json.kg?.source, nonDefault: custom.json.kg?.nonDefault }),
	)
	check('配了 MCP 就算 configured（文件在别的目录也算）', custom.json.mcp?.configured === true, JSON.stringify(custom.json.mcp))

	// 出图也必须用那一张：切出来的节点是自定义图里的那个
	const customView = await call('/api-semantica/view', {
		body: { sessionId: SESSION_A, mode: 'all' },
	})
	const viewFile = customView.json.viewPath
	const customGraphOk =
		customView.json.ok === true &&
		typeof viewFile === 'string' &&
		existsSync(viewFile) &&
		JSON.stringify(JSON.parse(readFileSync(viewFile, 'utf8')).nodes).includes('only-here')
	check('出图用的是 profile 指的那张图', customGraphOk, JSON.stringify({ ok: customView.json.ok, viewFile }))

	// profile 里没写 SEMANTICA_KG_PATH 时退回约定路径
	writeFileSync(join(profilesDir, 'cordis.patch.yml'), '- id: mcp-semantica\n  config:\n')
	const fallback = await call('/api-semantica/status', { query: `?sessionId=${SESSION_A}` })
	check(
		'profile 里没写路径时退回安装脚本的默认约定',
		fallback.json.kg?.path === join(work, 'dsh-semantica-graph', 'kg.json') &&
			fallback.json.kg?.source === 'default' &&
			fallback.json.kg?.nonDefault === false,
		JSON.stringify({ path: fallback.json.kg?.path, source: fallback.json.kg?.source }),
	)
	check('退回约定路径后读到的还是原来那张图', fallback.json.kg?.nodes > 1, String(fallback.json.kg?.nodes))
}

for (const d of disposers) {
	try {
		d()
	} catch {
		// 清理失败不影响结论
	}
}
check('清理函数不抛异常', true, `${disposers.length} 个 disposer`)

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\n自检全部通过' : `\n自检有 ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
