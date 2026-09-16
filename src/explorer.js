// src/explorer.js — 常驻管理 semantica 自带的 Knowledge Explorer 子进程。
//
// 为什么用它而不是自绘：semantica 自带的 Explorer 是一条完整的 Web 应用
// （6 个 workspace、78 个 /api 路由：分析、检索、路径、决策链、语义邻域、
// 距离矩阵、出处、本体…）。插件自己画图只能覆盖其中一个视图，所以这边只负责
// 「把图喂给它 + 把它拉起来 + 告诉宿主 URL」，界面完全交给上游。
//
// 一个会话一个进程：`semantica-explorer` 的 `--graph` 只在启动时读一次，
// 换会话就得换进程。进程按会话缓存、空闲回收，并设总量上限防止泄漏。

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { resolvePython } from './semantica-bridge.js'

/** 找操作系统要一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000
const MAX_INSTANCES = 3
const READY_TIMEOUT_MS = 60_000
const LAST_LOG_LINES = 40

/** 缓存的依赖探测结果。 */
let explorerProbe = null

/**
 * 探测 Explorer 的依赖是否就绪。
 *
 * Explorer 是 semantica 的可选 extra —— 裸 `pip install semantica` 不会带
 * fastapi / uvicorn。缺了的话 `semantica-explorer` 会直接退出，报错也晦涩，
 * 所以在 status 里先探一次，好给用户一句明确的话。
 *
 * @returns {Promise<{ok, python, missing, error}>}
 */
export function probeExplorer({ force = false } = {}) {
  if (!force && explorerProbe) return explorerProbe
  explorerProbe = new Promise((resolve) => {
    const python = resolvePython()
    const child = spawn(
      python,
      ['-c', 'import uvicorn, fastapi, semantica.explorer; print("ok")'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
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
        /* ignore */
      }
    }, 30_000)
    timer.unref?.()
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, python, missing: null, error: String(e?.message ?? e) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.includes('ok')) {
        resolve({ ok: true, python, missing: null, error: null })
        return
      }
      const m = /No module named ['"]?([\w.]+)/.exec(err)
      resolve({
        ok: false,
        python,
        missing: m ? m[1] : null,
        error: err.trim().split('\n').slice(-1)[0] || `退出码 ${code}`,
      })
    })
  })
  return explorerProbe
}

export class ExplorerHost {
  /**
   * @param opts.idleMs 空闲多久回收进程
   * @param opts.maxInstances 同时保留的进程上限（按最近使用淘汰）
   * @param opts.onLog 诊断日志回调
   */
  constructor(opts = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.maxInstances = opts.maxInstances ?? MAX_INSTANCES
    this.onLog = opts.onLog ?? (() => {})
    /** @type {Map<string, {child, port, url, signature, graphPath, lastUsed, log}>} */
    this.instances = new Map()
    this.disposed = false
  }

  /**
   * 确保某个会话的 Explorer 可用。
   *
   * @param sessionId 会话 id
   * @param graphPath ContextGraph JSON 的落盘路径
   * @param signature 图内容的签名（会话事件数）：变了就重启进程重新载图
   * @returns {Promise<{url, port, reused, log}>}
   */
  async ensure(sessionId, graphPath, signature) {
    if (this.disposed) throw new Error('ExplorerHost 已释放')

    const existing = this.instances.get(sessionId)
    if (existing && existing.signature === signature && existing.graphPath === graphPath) {
      if (await this.#healthy(existing.url)) {
        existing.lastUsed = Date.now()
        return { url: existing.url, port: existing.port, reused: true, log: existing.log }
      }
      // 进程还活着但服务没了 —— 当成坏的，下面重起
      this.#kill(sessionId)
    } else if (existing) {
      this.#kill(sessionId)
    }

    this.#reap()
    const inst = await this.#spawn(graphPath)

    // 图换了、或本来就没起来：登记进来
    this.instances.set(sessionId, {
      ...inst,
      signature,
      graphPath,
      lastUsed: Date.now(),
      log: inst.log,
    })
    this.#reap()
    return { url: inst.url, port: inst.port, reused: false, log: inst.log }
  }

  /** 起一个 semantica-explorer 子进程并等它可服务。 */
  async #spawn(graphPath) {
    if (!existsSync(graphPath)) {
      throw new Error(`图文件不存在：${graphPath}`)
    }
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
          // Explorer 默认要求 SEMANTICA_API_KEY，否则所有受保护路由返回 503。
          // 它只绑在 127.0.0.1，且喂进去的是用户自己的对话图，所以走上游给
          // 的「显式选择无需认证」开关（开发用途）。绑非回环地址时不会这么做。
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
          `semantica-explorer 启动即退出（code=${exitInfo.code} signal=${exitInfo.signal}）。` +
            `${this.#diagnose(log)}`,
        )
      }
      if (await this.#healthy(url)) {
        return { child, port, url, log }
      }
      await new Promise((r) => setTimeout(r, 300))
    }

    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经死了 */
    }
    throw new Error(`semantica-explorer 在 ${READY_TIMEOUT_MS / 1000}s 内没有就绪。`)
  }

  /** 把子进程的输出翻译成一句人话。 */
  #diagnose(log) {
    const joined = log.join('\n')
    if (/No module named ['"]?uvicorn|No module named ['"]?fastapi/.test(joined)) {
      return (
        '看起来缺 Explorer 依赖。用插件 venv 装一次：' +
        '`pip install "semantica[explorer]"`（需要 fastapi + uvicorn）。'
      )
    }
    if (/No module named ['"]?semantica/.test(joined)) {
      return '这个解释器里没有 semantica —— 检查 DSH_SEMANTICA_PYTHON 或 venv 路径。'
    }
    const tail = log.slice(-6).join(' | ')
    return tail ? `最近输出：${tail}` : '（子进程没有输出任何日志）'
  }

  /** 探测 /api/health。 */
  async #healthy(url) {
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

  /** 杀掉某个会话的实例。 */
  #kill(sessionId) {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    this.instances.delete(sessionId)
    try {
      inst.child.kill('SIGTERM')
      // 给它一点时间自己退；不退就强杀，避免留下孤儿进程
      const t = setTimeout(() => {
        try {
          inst.child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 4000)
      t.unref?.()
    } catch {
      /* ignore */
    }
  }

  /** 总量上限 + 空闲回收。 */
  #reap() {
    const now = Date.now()
    for (const [sid, inst] of this.instances) {
      if (now - inst.lastUsed > this.idleMs) this.#kill(sid)
    }
    if (this.instances.size < this.maxInstances) return
    // 超上限：淘汰最久未用的（保留刚好 maxInstances 个）
    const byAge = [...this.instances.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    while (byAge.length >= this.maxInstances) {
      const [sid] = byAge.shift()
      this.#kill(sid)
      this.onLog(`explorer: 淘汰长时间未用的实例 ${sid}`)
    }
  }

  /** 当前活着的实例快照，给 status 用。 */
  snapshot() {
    return [...this.instances.entries()].map(([sessionId, inst]) => ({
      sessionId,
      url: inst.url,
      port: inst.port,
      idleMs: Date.now() - inst.lastUsed,
    }))
  }

  /**
   * 取某个会话正在跑的实例（不校验签名）。
   *
   * 用途是快路径：会话一直在增长，签名几乎每次点击都不同，但重抽一张图要 20s+。
   * 所以只要进程还活着就先复用它、把 URL 直接给出去，过期与否交给调用方标注，
   * 由用户显式刷新决定要不要重抽。
   *
   * @returns {{url, port, signature}|null}
   */
  running(sessionId) {
    const inst = this.instances.get(sessionId)
    if (!inst) return null
    inst.lastUsed = Date.now()
    return { url: inst.url, port: inst.port, signature: inst.signature }
  }

  /** 关掉全部实例。 */
  dispose() {
    this.disposed = true
    for (const sid of [...this.instances.keys()]) this.#kill(sid)
  }
}
