// src/index.js
//
// dsh-semantica-graph 的 host 半侧。
//
// ## 三条链路，各归各家
//
//   提取  → 上游 MCP（`mcp__semantica__*`）。**不在这个插件里**：模型手里才有
//           对话内容，它按插件注入的规则调用 extract_*/add_entity/add_relationship/
//           record_decision，写进 semantica 的共享图（SEMANTICA_KG_PATH）。
//           插件做的只有一件事：把「本会话标识 + 写入规则」告诉模型
//           （ctx.systemPrompt.section + variable，见 src/prompt.js）。
//   展示  → semantica 自带的 Knowledge Explorer（子进程 + iframe，见 src/explorer.js）。
//   分析  → 插件自己算（src/kg.js）。不调 AI、不开新对话、不用 MCP。
//
// 所以这个文件只剩下胶水：读图文件 → 按会话切一刀 → 喂给 Explorer；顺带把
// 原始图上的统计与分析直接算出来给面板。
//
// webServer 是可选且晚挂载的 host 服务，因此路由用 ctx.inject(['webServer'], …)
// 延迟注册：headless / 无 Web 的 profile 下回调不执行，插件照常激活。

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { ExplorerHost, probeExplorer, resolvePython } from './explorer.js'
import { analyze, graphMtime, readGraph, scopeGraph, summarize, writeGraphFile } from './kg.js'
import { SECTION_NAME, SECTION_ORDER, SECTION_TEXT, SESSION_VARIABLE, instructionFor } from './prompt.js'
import { resolveDshHome, sessionWindow } from './session.js'

const name = 'semantica-graph'

/** 不强依赖任何服务：提示词与 Web 路由都走 ctx.inject 延迟挂载。 */
const inject = []

/** 单条路由的请求体上限。 */
const MAX_BODY = 1 * 1024 * 1024

/** 图文件与视图文件放在 harness 下的同一个目录里。 */
const DATA_DIR = 'dsh-semantica-graph'

/** 一个 Explorer 实例，全插件共用。 */
const explorers = new ExplorerHost()

/**
 * 记一条日志。
 *
 * 包在 try 里，而且**不**把 logger 写进 inject：Cordis 的 ctx 是服务代理，读一个没声明
 * 注入的服务属性会直接抛异常。logger 在有些 profile 里有、有些里没有，为一句话的日志
 * 把插件启动搞挂不值当 —— 拿不到就当没这回事。
 */
function note(ctx, level, message) {
	try {
		ctx.logger?.[level]?.(message)
	} catch {
		// 没有 logger 就算了
	}
}

/** 读并解析 JSON 请求体。 */
function readBody(req, limit = MAX_BODY) {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks = []
		req.on('data', (c) => {
			size += c.length
			if (size > limit) {
				reject(new Error('请求体过大'))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8')
			if (!raw.trim()) {
				resolve({})
				return
			}
			try {
				resolve(JSON.parse(raw))
			} catch (err) {
				reject(new Error(`请求体不是合法 JSON：${err?.message ?? err}`))
			}
		})
		req.on('error', reject)
	})
}

/** 回一个 JSON。 */
function send(res, code, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(code, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
	})
	res.end(body)
}

/** MCP 那条配置在不在这台机器的 profile 里（没配的话工具根本不会出现，值得提醒）。 */
function mcpConfigured(home) {
	const dir = join(home, 'profiles')
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const patch = join(dir, entry.name, 'cordis.patch.yml')
			if (!existsSync(patch)) continue
			const text = readFileSync(patch, 'utf8')
			if (text.includes('mcp-semantica') || text.includes('semantica-mcp')) return true
		}
	} catch {
		return false
	}
	return false
}

/** MCP 的图文件路径（安装脚本写进 SEMANTICA_KG_PATH 的就是它）。 */
function kgPath(home) {
	return join(home, DATA_DIR, 'kg.json')
}

/** 界面诊断落盘的位置。 */
function diagPath(home) {
	return join(home, DATA_DIR, 'last-diag.json')
}

/** 视图图文件。按 key 分开 —— 一个会话一张，'all' 一张。 */
function viewPath(home, key) {
	const safe = key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)
	return join(home, DATA_DIR, 'views', `view-${safe}.json`)
}

/**
 * 读图 + 切图。所有路由都从这里拿数据，保证「面板看到的」和「分析算的」是同一张图。
 *
 * @returns `{ graph, scoped, home, kg, mtime }`
 */
async function loadScoped(ctx, sessionId, mode) {
	const home = resolveDshHome()
	const path = kgPath(home)
	const graph = readGraph(path)
	if (!graph) {
		const err = new Error('图文件还不存在')
		err.code = 'kg-missing'
		err.kgPath = path
		throw err
	}
	const win = await sessionWindow(ctx, sessionId)
	const scoped = scopeGraph(graph, { sessionId, mode, window: win })
	return { graph, scoped, home, kg: { path, mtime: graphMtime(path), bytes: graph.bytes }, window: win }
}

function apply(ctx, config) {
	const home = resolveDshHome()
	const cfg = config ?? {}
	const wantsPrompt = cfg.injectPrompt !== false

	// ── 1) 把「本会话标识 + 写入规则」交给模型 ───────────────────────────────
	//
	// 这一段是整个 MCP 方案能按会话切图的前提，理由写在 src/prompt.js 顶部。
	// injectPrompt:false 可以关掉（比如不想让每个会话都带这段提示词）。
	if (wantsPrompt) {
		ctx.inject(['systemPrompt'], (pctx) => {
			const sp = pctx.systemPrompt

			// 顺序要紧：**先注册变量，再注册引用了它的段落**。
			//
			// dsh-system-prompt 的 interpolate() 遇到没注册的 `{{x}}` 是**直接抛异常**
			// （"unknown prompt variable"）。段落里写着 `{{semantica_conversation}}`，
			// 所以只要出现「段落注册成功、变量没注册上」这种半吊子状态，之后**每一次**
			// 组装提示词都会炸 —— 那是把用户整个会话搞挂，比没有知识图谱严重得多。
			// 所以两步各自兜住，变量没成就不注册段落。
			let variableReady = false
			try {
				pctx.effect(
					() =>
						sp.variable(
							SESSION_VARIABLE,
							// 值不能是 undefined：interpolate() 对 undefined 也会抛
							// （"has no value for this assembly"），所以兜到空串。
							(context) => context?.agent?.session?.header?.id ?? '',
						),
					'semantica-graph.variable()',
				)
				variableReady = true
			} catch (err) {
				note(ctx, 'warn', `semantica-graph: 会话变量注册失败，已跳过提示词段：${err?.message ?? err}`)
			}

			if (!variableReady) return
			try {
				pctx.effect(
					() => sp.section({ name: SECTION_NAME, order: cfg.sectionOrder ?? SECTION_ORDER, text: SECTION_TEXT }),
					'semantica-graph.section()',
				)
				note(ctx, 'debug', 'semantica-graph: 已注入知识图谱提示词段')
			} catch (err) {
				// 名字被占了（重复加载 / 热重载）之类：少一段提示词而已，别把插件拖下水
				note(ctx, 'warn', `semantica-graph: 提示词段注册失败：${err?.message ?? err}`)
			}
		})
	}

	// ── 2) Explorer 生命周期跟着插件走 ───────────────────────────────────────
	ctx.effect(() => () => explorers.dispose(), 'semantica-graph.explorer')

	// ── 3) 路由 ──────────────────────────────────────────────────────────────
	ctx.inject(['webServer'], (webCtx) => {
		const ws = webCtx.webServer

		// —— 状态：图在不在、MCP 配没配、Explorer 依赖齐不齐 ——
		ws.register({
			kind: 'exact',
			path: '/api-semantica/status',
			handler: async (req, res) => {
				try {
					const url = new URL(req.url ?? '/', 'http://x')
					const sessionId = url.searchParams.get('sessionId') ?? ''
					const probe = await probeExplorer()
					const path = kgPath(home)
					const exists = existsSync(path)
					let nodes = 0
					let edges = 0
					if (exists) {
						try {
							const g = readGraph(path)
							nodes = g?.nodes?.length ?? 0
							edges = g?.edges?.length ?? 0
						} catch {
							// 图坏了也不该让 status 挂掉：面板只需要知道「读不出来」
						}
					}
					send(res, 200, {
						ok: true,
						kg: { path, exists, mtime: graphMtime(path), nodes, edges },
						mcp: { configured: mcpConfigured(home) },
						explorer: {
							ok: probe.ok,
							version: probe.version ?? null,
							python: probe.python ?? resolvePython(),
							missing: probe.missing ?? [],
							hint: probe.hint ?? null,
							running: explorers.snapshot(),
						},
						prompt: { injected: wantsPrompt, section: SECTION_NAME },
						instruction: sessionId ? instructionFor(sessionId) : null,
					})
				} catch (err) {
					send(res, 200, { ok: false, error: String(err?.message ?? err) })
				}
			},
		})

		// —— 界面诊断：把前端量到的真 DOM 几何落到磁盘 ——
		//
		// 为什么要有这条：插件改的是宿主里的一个真实窗口，而我看不见那个窗口（没有截图、
		// 没有 CDP）。布局类问题只能靠猜，猜错就是修错地方。所以让前端把它**自己**量到的
		// 祖先链、计算样式、各块矩形回传，host 写成一个 JSON —— 之后我读文件就有证据了。
		ws.register({
			kind: 'exact',
			path: '/api-semantica/diag',
			handler: async (req, res) => {
				try {
					const body = await readBody(req)
					const payload = { ...body, receivedAt: new Date().toISOString() }
					const file = diagPath(home)
					mkdirSync(join(home, DATA_DIR), { recursive: true })
					writeFileSync(file, JSON.stringify(payload, null, 1))
					note(ctx, 'debug', `semantica-graph: 收到界面诊断（${body?.reason ?? '?'}）→ ${file}`)
					send(res, 200, { ok: true, file })
				} catch (err) {
					send(res, 200, { ok: false, error: String(err?.message ?? err) })
				}
			},
		})

		// —— 出图：读 → 切 → 写视图文件 → 起 Explorer → 给 URL ——
		ws.register({
			kind: 'exact',
			path: '/api-semantica/view',
			handler: async (req, res) => {
				const started = Date.now()
				try {
					const body = await readBody(req)
					const sessionId = String(body.sessionId ?? '')
					const mode = body.mode === 'all' ? 'all' : 'conversation'
					if (!sessionId) {
						send(res, 200, { ok: false, code: 'no-session', error: '没拿到会话 id' })
						return
					}
					const probe = await probeExplorer()
					if (!probe.ok) {
						send(res, 200, {
							ok: false,
							code: 'explorer-unavailable',
							error: probe.error ?? 'Explorer 依赖不可用',
							hint: probe.hint ?? null,
						})
						return
					}

					const { scoped, kg } = await loadScoped(ctx, sessionId, mode)
					const key = mode === 'all' ? 'all' : `conversation:${sessionId}`
					const out = viewPath(home, key)
					writeGraphFile(out, `semantica-graph:${key}`, scoped.nodes, scoped.edges)
					const { url } = await explorers.start(key, out)

					send(res, 200, {
						ok: true,
						url,
						mode,
						key,
						stats: summarize(scoped.nodes, scoped.edges),
						claim: scoped.claim,
						kg: { path: kg.path, mtime: kg.mtime, bytes: kg.bytes },
						viewPath: out,
						ms: Date.now() - started,
					})
				} catch (err) {
					if (err?.code === 'kg-missing') {
						send(res, 200, {
							ok: false,
							code: 'kg-missing',
							error: '这台机器上还没有写过任何知识图谱',
							kgPath: err.kgPath,
						})
						return
					}
					note(ctx, 'warn', `semantica-graph: 出图失败 ${err?.stack ?? err}`)
					send(res, 200, { ok: false, code: 'view-failed', error: String(err?.message ?? err) })
				}
			},
		})

		// —— 分析：同一张图上直接算，不碰 Explorer、不碰 AI ——
		ws.register({
			kind: 'exact',
			path: '/api-semantica/analysis',
			handler: async (req, res) => {
				const started = Date.now()
				try {
					const body = await readBody(req)
					const sessionId = String(body.sessionId ?? '')
					const mode = body.mode === 'all' ? 'all' : 'conversation'
					if (!sessionId) {
						send(res, 200, { ok: false, code: 'no-session', error: '没拿到会话 id' })
						return
					}
					const { scoped } = await loadScoped(ctx, sessionId, mode)
					send(res, 200, {
						ok: true,
						mode,
						stats: summarize(scoped.nodes, scoped.edges),
						claim: scoped.claim,
						analysis: analyze(scoped.nodes, scoped.edges),
						ms: Date.now() - started,
					})
				} catch (err) {
					if (err?.code === 'kg-missing') {
						send(res, 200, { ok: false, code: 'kg-missing', error: '还没有写过任何知识图谱' })
						return
					}
					note(ctx, 'warn', `semantica-graph: 分析失败 ${err?.stack ?? err}`)
					send(res, 200, { ok: false, code: 'analysis-failed', error: String(err?.message ?? err) })
				}
			},
		})

		note(ctx, 'debug', 'semantica-graph: 已注册 /api-semantica/{status,view,analysis}')
	})
}

export { apply, inject, name }
