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

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { analyze, readGraph, scopeGraph, summarize, writeGraphFile } from '../src/kg.js'
import { ExplorerHost, probeExplorer, resolvePython } from '../src/explorer.js'
import { SECTION_TEXT, SESSION_VARIABLE, instructionFor, SECTION_NAME } from '../src/prompt.js'

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
check('按时间窗口认领到 1 条决策', scopedA.claim.byTime === 1, `byTime=${scopedA.claim.byTime}`)
check(
	'同会话的两条决策都在视图里，远古决策不在',
	scopedA.nodes.filter((n) => n.type === 'decision').length === 2 &&
		!scopedA.nodes.some((n) => (n.properties ?? {}).category === '无关决策'),
	`decisions=${scopedA.nodes.filter((n) => n.type === 'decision').length}`,
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

const scopedAll = scopeGraph(graph, { sessionId: SESSION_A, mode: 'all', window: DECISION_WINDOW })
check('「全部」模式不切图', scopedAll.nodes.length === graph.nodes.length, `nodes=${scopedAll.nodes.length}`)

const statsA = summarize(scopedA.nodes, scopedA.edges)
check(
	'统计口径：实体/关系不算决策附属',
	statsA.entities === 3 && statsA.decisions === 2 && statsA.relations >= 2,
	JSON.stringify({ e: statsA.entities, d: statsA.decisions, r: statsA.relations }),
)

// ── 3. 分析 ──

const a = analyze(scopedA.nodes, scopedA.edges)
check('枢纽榜有内容', a.hubs.byDegree.length > 0 && a.hubs.byRank.length > 0, `top=${a.hubs.byDegree[0]?.label}`)
check('概览连通分量为 1', a.overview.components === 1, `components=${a.overview.components}`)
check('决策清单两条、按时间倒序', a.decisions.length === 2 && a.decisions[0].at >= a.decisions[1].at)
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
check('注册了会话变量', variables.length === 1 && variables[0].name === SESSION_VARIABLE, JSON.stringify(variables.map((v) => v.name)))
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

const wantPaths = ['/api-semantica/status', '/api-semantica/view', '/api-semantica/analysis']
check('三个路由都注册了', wantPaths.every((p) => routes.has(p)), [...routes.keys()].join(', '))

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
if (viewRes.json.viewPath) {
	const written = JSON.parse(readFileSync(viewRes.json.viewPath, 'utf8'))
	check('视图文件形状对（graph_id/nodes/edges）', written.graph_id.startsWith('semantica-graph:') && Array.isArray(written.nodes) && Array.isArray(written.edges), `${written.nodes.length} 节点`)
}

const anaRes = await call('/api-semantica/analysis', { body: { sessionId: SESSION_A, mode: 'conversation' } })
check('analysis 返回分析结果', anaRes.json.ok === true && anaRes.json.analysis?.decisions?.length === 2, JSON.stringify({ ok: anaRes.json.ok, d: anaRes.json.analysis?.decisions?.length }))
check('analysis 里有枢纽与时间线', (anaRes.json.analysis?.hubs?.byDegree?.length ?? 0) > 0 && (anaRes.json.analysis?.timeline?.length ?? 0) > 0)

const allRes = await call('/api-semantica/analysis', { body: { sessionId: SESSION_A, mode: 'all' } })
check('「全部」模式看到整张图', allRes.json.stats?.nodes === graph.nodes.length, `${allRes.json.stats?.nodes} vs ${graph.nodes.length}`)

const badRes = await call('/api-semantica/analysis', { body: {} })
check('没给会话 id 时明确报错（不是静默）', badRes.json.ok === false && badRes.json.code === 'no-session', JSON.stringify(badRes.json))

// 收尾：走一遍清理函数，把 Explorer 子进程收掉
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
