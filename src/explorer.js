// src/explorer.js
//
// semantica 自带的 Knowledge Explorer —— 插件用它来**展示**图。
//
// 面板里那张图不是插件画的，是上游一个完整的 Web 应用（FastAPI + React，多个
// workspace + 几十个 /api 路由）。插件只负责把它拉起来、把 URL 交给浏览器半侧去
// 内嵌。所以这里要做的事情很具体：
//
//   · 找到能 `python -m semantica.explorer` 的解释器（插件 venv）
//   · 分配一个空闲端口、把图文件喂给它、等它真的能服务
//   · 起不来的时候说清是哪一步坏了（缺 fastapi/uvicorn、缺 semantica、还是解释器
//     不对）—— 这三种在面板上给的提示完全不同
//
// 一个视图一个进程：`--graph` 只在启动时读一次，所以图变了必须重启进程，「刷新」
// 就是这个语义。进程按空闲时间回收，不会越开越多。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 起进程到能服务的最长等待。冷启动要拉 spaCy，实测 1–3s，给足余量。 */
const READY_TIMEOUT_MS = 30_000

/** 空闲多久回收一个 Explorer 进程。 */
const IDLE_MS = 10 * 60 * 1000

/** 同时最多留几个进程。 */
const MAX_INSTANCES = 3

/** 子进程日志最多留几行（出错时拼进提示）。 */
const LAST_LOG_LINES = 40

/** 本文件所在的插件目录。 */
const HERE = new URL('.', import.meta.url).pathname

/**
 * 找到带 semantica 的解释器。
 *
 * 顺序：显式环境变量 → harness 下的插件 venv（安装脚本建的那个）→ 插件目录里的
 * .venv → 系统 python3。前两个是设计路径，后两个是兜底。
 */
export function resolvePython() {
	const explicit = process.env.DSH_SEMANTICA_PYTHON || process.env.DSH_SEMANTICA_PYTHON3
	if (explicit) return explicit

	const home =
		process.env.DSH_HOME || join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
	const candidates = [
		join(home, 'semantica-venv', 'bin', 'python'),
		join(home, '.dsh', 'semantica-venv', 'bin', 'python'),
		join(HERE, '..', '.venv', 'bin', 'python'),
	]
	for (const c of candidates) {
		try {
			if (existsSync(c)) return c
		} catch {
			// 候选路径不存在就是没装，看下一个
		}
	}
	return 'python3'
}

/**
 * 探测解释器里有没有 semantica、有没有 Explorer 那套依赖。
 *
 * 结果缓存 —— 面板每次打开都跑一遍 `import semantica` 要好几秒，没必要。
 *
 * @param opts.force 忽略缓存重探。
 * @returns `{ ok, python, version, missing, error, hint }`
 */
export function probeExplorer({ force = false } = {}) {
	if (!force && probeCache) return probeCache
	const python = resolvePython()
	probeCache = new Promise((resolve) => {
		const script = [
			'import json,sys',
			'out={"semantica":None,"explorer":None}',
			'try:',
			'    import semantica; out["semantica"]=getattr(semantica,"__version__","unknown")',
			'except Exception as e: out["semantica"]="ERR:"+repr(e)',
			'try:',
			'    import fastapi, uvicorn; out["explorer"]="ok"',
			'except Exception as e: out["explorer"]="ERR:"+repr(e)',
			'sys.stdout.write(json.dumps(out))',
		].join('\n')
		let child
		try {
			child = spawn(python, ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] })
		} catch (err) {
			resolve({
				ok: false,
				python,
				error: String(err?.message ?? err),
				hint: '解释器都起不来，检查 DSH_SEMANTICA_PYTHON。',
			})
			return
		}
		let out = ''
		let err = ''
		child.stdout.on('data', (b) => {
			out += String(b)
		})
		child.stderr.on('data', (b) => {
			err += String(b)
		})
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL')
			} catch {
				// 已经结束
			}
		}, 20_000)
		child.on('error', (e) => {
			clearTimeout(timer)
			resolve({
				ok: false,
				python,
				error: String(e?.message ?? e),
				hint: '解释器路径不对，或者没有执行权限。',
			})
		})
		child.on('close', () => {
			clearTimeout(timer)
			let parsed = null
			try {
				parsed = JSON.parse(out.trim())
			} catch {
				parsed = null
			}
			if (!parsed) {
				resolve({
					ok: false,
					python,
					error: err.trim() || '解释器没有返回预期结果',
					hint: `用这个解释器装一次 semantica：${python} -m pip install semantica`,
				})
				return
			}
			const hasSemantica = typeof parsed.semantica === 'string' && !parsed.semantica.startsWith('ERR:')
			const hasExplorer = parsed.explorer === 'ok'
			resolve({
				ok: hasSemantica && hasExplorer,
				python,
				version: hasSemantica ? parsed.semantica : null,
				missing: [!hasSemantica ? 'semantica' : null, !hasExplorer ? 'explorer 依赖' : null].filter(Boolean),
				error: hasSemantica ? (hasExplorer ? null : parsed.explorer) : parsed.semantica,
				hint: hasSemantica
					? hasExplorer
						? null
						: `缺 Explorer 依赖，用插件那个解释器装一次：${python} -m pip install "semantica[explorer]"`
					: `这个解释器里没有 semantica：${python}`,
			})
		})
	})
	return probeCache
}

/** 探测结果缓存（probeExplorer 用）。 */
let probeCache = null

/** 要一个空闲端口。交给系统分配，避免自己猜端口撞车。 */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer()
		srv.unref()
		srv.on('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address()
			const port = typeof addr === 'object' && addr ? addr.port : 0
			srv.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))))
		})
	})
}

/** 探一下 Explorer 的 health。 */
async function healthy(url) {
	try {
		const ctrl = new AbortController()
		const timer = setTimeout(() => ctrl.abort(), 3000)
		const res = await fetch(`${url}/api/health`, { signal: ctrl.signal })
		clearTimeout(timer)
		return res.ok
	} catch {
		return false
	}
}

/** 把子进程日志翻译成一句人话。 */
function diagnose(log) {
	const joined = log.join('\n')
	if (/No module named ['"]?uvicorn|No module named ['"]?fastapi/.test(joined)) {
		return '看起来缺 Explorer 依赖：pip install "semantica[explorer]"。'
	}
	if (/No module named ['"]?semantica/.test(joined)) {
		return '这个解释器里没有 semantica。'
	}
	const tail = log.slice(-6).join(' | ')
	return tail ? `最近输出：${tail}` : '（子进程没有任何输出）'
}

/**
 * 管着一堆 Explorer 子进程，一个「视图 key」一个。
 *
 * key 由调用方给（`conversation:<会话id>` / `all`）：同一个 key 再打开时旧进程会被
 * 换掉，因为图文件重写了、而 `--graph` 只在启动时读一次。
 */
export class ExplorerHost {
	/** @param opts.logger 宿主日志（可选）。 */
	constructor(opts = {}) {
		this.instances = new Map()
		this.logger = opts.logger ?? null
		this.timer = setInterval(() => this.#reap(), 30_000)
		this.timer.unref?.()
	}

	/**
	 * 给某个 key 起（或重启）一个 Explorer。
	 *
	 * @param key 视图标识。
	 * @param graphPath 图文件路径。
	 * @returns `{ url, port }`
	 */
	async start(key, graphPath) {
		if (!existsSync(graphPath)) throw new Error(`图文件不存在：${graphPath}`)
		if (this.instances.has(key)) this.#kill(key)

		const python = resolvePython()
		const port = await freePort()
		const child = spawn(
			python,
			[
				'-m', 'semantica.explorer',
				'--graph', graphPath,
				'--port', String(port),
				'--host', '127.0.0.1',
				'--no-browser',
			],
			{
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					// Explorer 默认要 SEMANTICA_API_KEY，否则受保护路由返回 503。
					// 它只绑 127.0.0.1，喂进去的是用户自己的图，所以开上游给的那个
					// 「显式选择无需认证」开关。
					SEMANTICA_ALLOW_ANONYMOUS: 'true',
				},
			},
		)
		child.unref?.()

		const log = []
		const capture = (buf) => {
			for (const line of String(buf).split('\n')) {
				const t = line.trim()
				if (!t) continue
				log.push(t)
				if (log.length > LAST_LOG_LINES) log.shift()
			}
		}
		child.stdout.on('data', capture)
		child.stderr.on('data', capture)

		let exitInfo = null
		child.on('exit', (code, signal) => {
			exitInfo = { code, signal }
		})

		const url = `http://127.0.0.1:${port}`
		const deadline = Date.now() + READY_TIMEOUT_MS
		while (Date.now() < deadline) {
			if (exitInfo) {
				throw new Error(
					`Explorer 启动即退出（code=${exitInfo.code} signal=${exitInfo.signal}）。${diagnose(log)}`,
				)
			}
			if (await healthy(url)) {
				this.instances.set(key, { child, url, port, log, lastUsed: Date.now(), graphPath })
				this.#enforceCap()
				return { url, port }
			}
			await new Promise((r) => setTimeout(r, 300))
		}
		try {
			child.kill('SIGKILL')
		} catch {
			// 已经死了
		}
		throw new Error(`Explorer 在 ${READY_TIMEOUT_MS / 1000}s 内没有就绪。${diagnose(log)}`)
	}

	/** 某个 key 的进程还活着吗（面板用它决定要不要重新拉）。 */
	isLive(key) {
		return this.instances.has(key)
	}

	/** 当前跑着哪些（诊断用）。 */
	snapshot() {
		return [...this.instances.entries()].map(([key, inst]) => ({
			key,
			url: inst.url,
			port: inst.port,
			idleMs: Date.now() - inst.lastUsed,
		}))
	}

	/** 全部收掉（插件卸载时调）。 */
	dispose() {
		clearInterval(this.timer)
		for (const key of [...this.instances.keys()]) this.#kill(key)
	}

	/** 超量的先杀最久没用的。 */
	#enforceCap() {
		if (this.instances.size <= MAX_INSTANCES) return
		const byAge = [...this.instances.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
		for (const [key] of byAge.slice(0, this.instances.size - MAX_INSTANCES)) this.#kill(key)
	}

	/** 空闲回收。 */
	#reap() {
		const now = Date.now()
		for (const [key, inst] of [...this.instances.entries()]) {
			if (now - inst.lastUsed > IDLE_MS) this.#kill(key)
		}
	}

	/** 杀进程（SIGTERM → 3s 后 SIGKILL）。 */
	#kill(key) {
		const inst = this.instances.get(key)
		if (!inst) return
		this.instances.delete(key)
		try {
			inst.child.kill('SIGTERM')
		} catch {
			// 已经不在了
		}
		const t = setTimeout(() => {
			try {
				inst.child.kill('SIGKILL')
			} catch {
				// 同上
			}
		}, 3000)
		t.unref?.()
		this.logger?.debug?.(`semantica-graph: 回收 Explorer ${key}`)
	}
}
