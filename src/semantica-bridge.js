// src/semantica-bridge.js
//
// 与 Python `semantica` 包之间的常驻子进程桥。
//
// 为什么常驻而不是每次 spawn：semantica 会拉起 spaCy / thinc，冷导入是秒级
// （实测 3-10 秒，取决于机器与模型缓存）。每次点击按钮都等这么久不可接受，
// 因此这里按需启动一个常驻进程，之后用 NDJSON（一行一个 JSON）走 stdin/stdout
// 通信。空闲超过 idleMs 自动退出，不在用户机器上留常驻负担。
//
// 协议：
//   请求  {"id":<int>, "cmd":"build_graph", "payload":{...}}\n
//   响应  {"id":<int>, "ok":true, "graph":{...}}\n
//   响应  {"id":<int>, "ok":false, "error":"..."}\n
//   进程启动后先发一行 {"ready":true, "semantica":"0.6.8"}\n（用于区分“启动失败”与“请求失败”）

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'graph_worker.py')

/** 默认空闲多久后回收子进程。 */
const DEFAULT_IDLE_MS = 10 * 60 * 1000

/** 单次建图请求的超时（首次含导入，给足）。 */
const DEFAULT_TIMEOUT_MS = 180 * 1000

/**
 * 解析要用的 Python 解释器。按以下顺序探测：
 *   1. DSH_SEMANTICA_PYTHON / DSH_SEMANTICA_PYTHON3 环境变量（显式指定，最高优先级）
 *   2. $DSH_HOME/semantica-venv/bin/python（本插件推荐装法：独立 venv，
 *      不把 spacy/transformers 这一大坨依赖塞进系统或 conda 基础环境）
 *   3. 插件目录旁的 .venv/bin/python
 *   4. 回退 `python3`
 *
 * 之所以优先 venv：semantica 依赖 numpy/spacy/transformers，直接装进共用的
 * conda base 会和既有包（gradio、streamlit 等）的版本约束打架，实测会出现
 * `numpy.dtype size changed` 这种 C 扩展 ABI 崩。
 */
export function resolvePython() {
  const explicit = process.env.DSH_SEMANTICA_PYTHON || process.env.DSH_SEMANTICA_PYTHON3
  if (explicit) return explicit

  const home = process.env.DSH_HOME || join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
  const candidates = [
    join(home, 'semantica-venv', 'bin', 'python'),
    join(home, '.dsh', 'semantica-venv', 'bin', 'python'),
    join(HERE, '..', '.venv', 'bin', 'python'),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  return 'python3'
}

/** 一次探测的结果缓存：{ ok, version?, error? } */
let probeCache = null

/**
 * 探测 `python3 -c "import semantica"` 是否可用。
 * 结果缓存，避免每次打开面板都花几秒去验证。
 */
export async function probeSemantica({ force = false } = {}) {
  if (!force && probeCache) return probeCache

  const python = resolvePython()
  probeCache = await new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    let child
    try {
      child = spawn(python, ['-c', 'import semantica,sys;sys.stdout.write(getattr(semantica,"__version__","unknown"))'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return done({ ok: false, python, error: `无法启动 ${python}: ${err?.message ?? err}` })
    }
    let out = ''
    let err = ''
    child.stdout?.on('data', (b) => { out += b.toString() })
    child.stderr?.on('data', (b) => { err += b.toString() })
    child.on('error', (e) => done({ ok: false, python, error: `无法启动 ${python}: ${e?.message ?? e}` }))
    child.on('close', (code) => {
      if (code === 0) done({ ok: true, python, version: out.trim() || 'unknown' })
      else {
        const last = (err.trim().split('\n').pop() || '').trim()
        done({
          ok: false,
          python,
          error: last || `python 退出码 ${code}`,
          hint: /No module named 'semantica'/.test(err)
            ? `未安装 semantica。请执行：${python} -m pip install semantica`
            : undefined,
        })
      }
    })
  })
  return probeCache
}

/** 一次在途请求。 */
class Pending {
  constructor(id, resolve, reject, timer) {
    this.id = id
    this.resolve = resolve
    this.reject = reject
    this.timer = timer
  }
}

/**
 * 常驻 semantica 工作进程。
 * 一个实例服务多次请求；进程死亡后下次请求会重新拉起。
 */
export class SemanticaWorker {
  #child = null
  #pending = new Map()
  #nextId = 1
  #buf = ''
  #idleTimer = null
  #idleMs
  #timeoutMs
  #ready = null
  #stderrTail = []

  constructor(opts = {}) {
    this.#idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 当前是否已有活着的子进程。 */
  get alive() {
    return this.#child !== null && this.#child.exitCode === null && !this.#child.killed
  }

  /** 启动（或复用）工作进程，resolve 时表示 ready 行已收到。 */
  async #ensure() {
    if (this.alive) return
    if (this.#ready) {
      // 正在启动中——复用同一个 promise
      return this.#ready
    }

    const python = resolvePython()
    const child = spawn(python, ['-u', WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    })
    this.#child = child
    this.#buf = ''
    this.#stderrTail = []

    this.#ready = new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, v) => {
        if (!settled) {
          settled = true
          fn(v)
        }
      }

      const bootTimer = setTimeout(() => {
        finish(reject, new Error(`semantica 工作进程启动超时（${Math.round(this.#timeoutMs / 1000)}s）`))
        this.#kill()
      }, this.#timeoutMs)

      child.stdout.on('data', (b) => {
        this.#buf += b.toString('utf8')
        let nl
        while ((nl = this.#buf.indexOf('\n')) >= 0) {
          const line = this.#buf.slice(0, nl).trim()
          this.#buf = this.#buf.slice(nl + 1)
          if (!line) continue
          let msg
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg && msg.ready) {
            clearTimeout(bootTimer)
            finish(resolve, msg)
            continue
          }
          this.#settle(msg)
        }
      })

      child.stderr.on('data', (b) => {
        const s = b.toString('utf8')
        this.#stderrTail.push(s)
        if (this.#stderrTail.length > 40) this.#stderrTail.shift()
      })

      child.on('error', (e) => {
        clearTimeout(bootTimer)
        finish(reject, new Error(`无法启动 ${python}: ${e?.message ?? e}`))
        this.#failAll(new Error(`semantica 工作进程错误: ${e?.message ?? e}`))
      })

      child.on('close', (code) => {
        clearTimeout(bootTimer)
        const tail = this.#stderrTail.join('').trim().split('\n').slice(-6).join('\n')
        const err = new Error(
          `semantica 工作进程退出（code=${code}）${tail ? '\n' + tail : ''}`,
        )
        finish(reject, err)
        this.#failAll(err)
        this.#child = null
        this.#ready = null
      })
    })

    return this.#ready
  }

  /** 收到一行响应，唤醒对应请求。 */
  #settle(msg) {
    const id = msg?.id
    if (typeof id !== 'number') return
    const p = this.#pending.get(id)
    if (!p) return
    this.#pending.delete(id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg)
    else p.reject(Object.assign(new Error(msg.error || 'semantica 调用失败'), { detail: msg }))
  }

  /** 进程死亡：所有在途请求一起失败。 */
  #failAll(err) {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.#pending.clear()
  }

  /** 发一条请求并等响应。 */
  async request(cmd, payload) {
    await this.#ensure()
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = null
    }

    const id = this.#nextId++
    const child = this.#child
    if (!child || child.exitCode !== null) throw new Error('semantica 工作进程不可用')

    const line = JSON.stringify({ id, cmd, payload }) + '\n'

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`semantica 请求超时（${Math.round(this.#timeoutMs / 1000)}s）`))
      }, this.#timeoutMs)
      this.#pending.set(id, new Pending(id, resolve, reject, timer))
      try {
        child.stdin.write(line)
      } catch (e) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(e)
      }
    })

    this.#armIdle()
    return result
  }

  /** 空闲计时：到期回收子进程。 */
  #armIdle() {
    if (this.#idleMs <= 0) return
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      if (this.#pending.size === 0) this.#kill()
    }, this.#idleMs)
    this.#idleTimer.unref?.()
  }

  /** 关闭子进程（插件卸载 / 空闲回收）。 */
  #kill() {
    const child = this.#child
    this.#child = null
    this.#ready = null
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      // ignore
    }
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }

  /** 外部显式关闭。 */
  dispose() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = null
    }
    this.#failAll(new Error('semantica 工作进程已关闭'))
    this.#kill()
  }
}
