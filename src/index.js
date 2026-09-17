// src/index.js
//
// dsh-semantica-graph 的 host 半侧。
//
// 职责：
//   1. 读当前会话日志（session.jsonl.zstd）→ 结构化对话
//   2. 交给常驻 Python 进程，用 Semantica 抽取实体与关系，产出 **Semantica 原生
//      的 ContextGraph** 并落盘
//   3. 起 semantica 自带的 Knowledge Explorer 子进程载入这张图，把 URL 交给
//      浏览器半侧 —— 界面完全由上游提供，插件不自己画图
//
// 这条链路的意义在于：Explorer 是 semantica 的完整 Web 应用（6 个 workspace、
// 78 个 /api 路由），插件自己渲染只能覆盖其中一个视图。所以这边只做
// 「读会话 → 建图 → 拉起上游 UI」，功能上限就等于上游。
//
// webServer 是可选且晚挂载的 host 服务，因此路由用 ctx.inject(['webServer'], …)
// 延迟注册：headless / 无 Web 的 profile 下回调不执行，插件照常激活。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SemanticaWorker, probeSemantica, resolvePython } from './semantica-bridge.js'
import {
  resolveDshHome,
  readSessionEvents,
  buildConversation,
} from './session-reader.js'
import { ExplorerHost, probeExplorer } from './explorer.js'
import {
  ANALYSIS_KINDS,
  ANALYSIS_LABEL_PREFIX,
  buildDigest,
  createAnalysisSession,
  dumpFailure,
  isAnalysisKind,
  readGraph,
} from './analyze.js'

const name = 'semantica-graph'

/** host 半侧不硬依赖任何服务：全部经 ctx.get / ctx.inject 软获取。 */
const inject = []

/** 单条路由的请求体上限。 */
const MAX_BODY = 4 * 1024 * 1024

/**
 * 会话 → 已建好的图。
 * value = { sig, graphPath, stats, builtAt }
 * sig 用「事件条数」当签名：会话一有新事件就重抽，没变就直接复用。
 */
const graphCache = new Map()

/** 读取并解析 JSON 请求体。 */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error(`请求体过大（> ${Math.round(limit / 1024)}KB）`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON: ${e.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** 统一 JSON 响应。 */
function send(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 图文件的落盘位置。sessionId 来自客户端，必须清洗掉路径分隔符。 */
function graphPathFor(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  const dir = join(resolveDshHome(), 'dsh-semantica-graph')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${safe}.json`)
}

function apply(ctx) {
  const worker = new SemanticaWorker()
  const explorers = new ExplorerHost({
    onLog: (m) => ctx.logger?.debug?.(m),
  })

  // 插件卸载 / HMR 时回收常驻子进程，不在用户机器上留孤儿
  ctx.effect(() => () => worker.dispose(), 'semantica-graph: worker lifecycle')
  ctx.effect(() => () => explorers.dispose(), 'semantica-graph: explorer lifecycle')

  // 预热：插件加载几秒后就把 Python 子进程唤起来。
  // Semantica 要拉 spaCy/thinc，冷启动是秒级；不预热的话用户第一次点按钮
  // 得干等这段时间。失败静默——真的没装 semantica 时，点按钮会给出明确提示。
  const warmTimer = setTimeout(() => {
    worker.request('ping').catch(() => {})
  }, 3000)
  warmTimer.unref?.()
  ctx.effect(() => () => clearTimeout(warmTimer), 'semantica-graph: warmup')

  ctx.inject(['webServer'], (webCtx) => {
    const ws = webCtx.webServer

    // —— 状态：Python / semantica / Explorer 依赖是否就绪 ——
    ws.register({
      kind: 'exact',
      path: '/api-semantica/status',
      handler: async (req, res) => {
        try {
          const [probe, explorer] = await Promise.all([probeSemantica(), probeExplorer()])
          send(res, 200, {
            ok: true,
            ready: probe.ok && explorer.ok,
            python: probe.python,
            semantica: probe.version ?? null,
            error: probe.error ?? null,
            hint: probe.hint ?? null,
            workerAlive: worker.alive,
            resolvedPython: resolvePython(),
            explorer: {
              ok: explorer.ok,
              missing: explorer.missing,
              error: explorer.error,
              hint: explorer.ok
                ? null
                : `需要 Explorer 依赖，用插件那个解释器装一次：` +
                  `${explorer.python} -m pip install "semantica[explorer]"`,
              running: explorers.snapshot(),
            },
          })
        } catch (err) {
          send(res, 200, { ok: true, ready: false, error: String(err?.message ?? err) })
        }
      },
    })

    // —— 内部：读会话 → 建 ContextGraph → 起 Explorer ——
    //
    // 抽成函数是因为「打开 Explorer」和「开 AI 分析新对话」两条路都要这张图，
    // 而且都要能复用缓存。返回 `{ code, payload }`：code 是要发的 HTTP 状态码，
    // payload 就是原来的响应体，行为与重构前逐字节一致。
    async function prepareGraph(sessionId, { refresh = false, maxSegments } = {}) {
      const probe = await probeSemantica()
      if (!probe.ok) {
        return {
          code: 200,
          payload: {
            ok: false,
            code: 'semantica-unavailable',
            error: probe.error ?? 'semantica 不可用',
            hint: probe.hint ?? `请安装：${resolvePython()} -m pip install semantica`,
            python: probe.python,
          },
        }
      }

      const explorerProbe = await probeExplorer()
      if (!explorerProbe.ok) {
        return {
          code: 200,
          payload: {
            ok: false,
            code: 'explorer-unavailable',
            error: explorerProbe.error ?? 'Explorer 依赖不可用',
            missing: explorerProbe.missing,
            hint:
              `Explorer 是 semantica 的可选组件，需要单独装：\n` +
              `${explorerProbe.python} -m pip install "semantica[explorer]"`,
          },
        }
      }

      // 1) 用官方服务读会话事件，并按「事件条数」做签名
      //
      // 走 sessionPersistence 的 list() + inspect() —— 这是 DSH 内部给「轨迹」供数的
      // 同一个接口，返回结构化事件，不用我们自己解多帧 zstd、解打包的 chunk-run、
      // 也不用处理 torn tail。实测同一会话：API 1.0s / 过滤后 11,910 个事件，
      // 读文件 7.9s / 61,108 行，而两条路产出的对话结构逐项一致。
      let read
      try {
        read = await readSessionEvents(ctx, sessionId)
      } catch (error) {
        return {
          code: 200,
          payload: {
            ok: false,
            code: 'session-not-found',
            error: String(error?.message ?? error),
          },
        }
      }
      const events = read.events
      const sig = `${events.length}`
      const graphPath = graphPathFor(sessionId)

      // 2) 已经在跑的实例 → 直接复用，不重抽
      //
      // 会话是活的，事件数几乎每次点击都在变；而重抽一张图要 20s+（NER 是
      // 大头）。所以只要进程还在就先把 URL 给出去，只在响应里标注这张图是否
      // 已经落后于会话（stale），要不要重抽交给用户显式 refresh 决定。
      const cached = graphCache.get(sessionId)
      const live = cached ? explorers.running(sessionId) : null
      if (!refresh && live) {
        return {
          code: 200,
          payload: {
            ok: true,
            cached: true,
            stale: live.signature !== sig,
            url: live.url,
            stats: cached.stats,
            source: read.persistedId,
          },
        }
      }

      // 3) 抽对话结构（骨架 + 喂给 NER 的文本段）
      //
      // 配额交给 session-reader 的**字符预算**（DEFAULT_MAX_CHARS，40 万字符），
      // 这里不再写死段数。原来写死 1200 段是错的尺度：段长差异很大，段数既不反映
      // 成本也不反映信息量 —— 实测本会话 1319 段只有 20.5 万字符，1200 段的硬上限
      // 白白裁掉了最前面 98 段，而 40 万字符的预算完全装得下。
      // 调用方（/prepare 的 body）显式传了 maxSegments 时仍然照办。
      const conversation = buildConversation(events, {
        ...(Number.isFinite(maxSegments) ? { maxSegments } : {}),
      })

      if (conversation.segments.length === 0) {
        return {
          code: 200,
          payload: { ok: false, code: 'empty-conversation', error: '这个会话还没有可抽取的内容' },
        }
      }

      // 4) 交给常驻 Python 进程产出 Semantica 原生 ContextGraph 并落盘
      const t0 = Date.now()
      const out = await worker.request('build_context_graph', {
        segments: conversation.segments,
        messages: conversation.messages,
        toolCalls: conversation.toolCalls,
        turns: conversation.turns,
        // 提问工具里的「选择」——worker 据此产出 type=decision 的节点，
        // 填满 Explorer 的 Decisions 区。
        decisions: conversation.decisions ?? [],
        title: conversation.title,
        outPath: graphPath,
      })

      if (!out.ok || !out.stats) {
        return {
          code: 200,
          payload: {
            ok: false,
            code: 'extract-failed',
            error: out.error ?? 'semantica 没有返回建图结果',
            trace: out.trace ?? null,
          },
        }
      }

      // 5) 起 Explorer 载入这张图
      const inst = await explorers.ensure(sessionId, graphPath, sig)

      const stats = {
        ...out.stats,
        graphPath,
        buildMs: Date.now() - t0,
        session: {
          id: sessionId,
          persistedId: read.persistedId,
          title: conversation.title ?? null,
          events: events.length,
          rawEvents: read.totalEvents,
        },
        conversation: { stats: conversation.stats },
      }
      graphCache.set(sessionId, { sig, graphPath, stats, builtAt: Date.now() })

      return {
        code: 200,
        payload: { ok: true, cached: false, url: inst.url, stats, source: read.persistedId },
      }
    }

    // —— 准备：读会话 → 建 ContextGraph → 起 Explorer → 返回 URL ——
    //
    // 客户端拿到 url 后用 better-sidebar 的 browser tab 打开它，界面就是
    // semantica 自带的完整 Explorer。
    ws.register({
      kind: 'exact',
      path: '/api-semantica/prepare',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (!sessionId) {
            send(res, 400, { ok: false, error: '缺少 sessionId' })
            return
          }
          const { code, payload } = await prepareGraph(sessionId, {
            refresh: Boolean(body.refresh),
            maxSegments: body.maxSegments,
          })
          send(res, code, payload)
        } catch (err) {
          send(res, 200, {
            ok: false,
            code: 'error',
            error: String(err?.message ?? err),
          })
        }
      },
    })

    // —— 分析：开一个**新对话**，把图数据注入进去让 AI 分析 ——
    //
    // 不把图塞进当前对话（会永久占住上下文），而是走 sessionController 新建
    // 一条普通会话 —— 和 GUI「新建对话」是同一条路径，所以它会出现在侧边栏的
    // 会话列表里，能读、能继续追问，不污染当前这一轮。
    //
    // 注意别改用 agents.create({ meta:{ origin:'subagent' } })：那建出来的是
    // 子代理，会被归到「子会话」页签。试过了，用户要的是真·新对话。
    //
    // 具体做法与设计理由见 src/analyze.js 的文件头。
    ws.register({
      kind: 'exact',
      path: '/api-semantica/analyze',
      handler: async (req, res) => {
        // 声明提到 try 外面：catch 里要用它当落盘目录，而 readBody/prepareGraph
        // 都可能先抛错 —— 那时 `const` 还在 TDZ，catch 里引用它会再炸一次。
        let graphPath
        try {
          const body = await readBody(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const kind = typeof body.kind === 'string' ? body.kind : ''
          if (!sessionId) {
            send(res, 400, { ok: false, error: '缺少 sessionId' })
            return
          }
          if (!isAnalysisKind(kind)) {
            send(res, 400, { ok: false, error: `未知的分析类型：${kind}` })
            return
          }

          // 图必须先在。客户端点分析时通常已经 prepare 过（图在缓存里），
          // 没有的话在这里补一次 —— 用户不该因为「还没点过打开 Explorer」
          // 就吃一个错误。
          let prepared = graphCache.get(sessionId)
          if (!prepared) {
            const { payload } = await prepareGraph(sessionId, {})
            if (!payload.ok) {
              send(res, 200, payload)
              return
            }
            prepared = graphCache.get(sessionId)
          }

          graphPath = prepared?.stats?.graphPath ?? graphPathFor(sessionId)
          const graph = readGraph(graphPath)
          if (!graph) {
            send(res, 200, {
              ok: false,
              code: 'graph-missing',
              error: `读不到图文件：${graphPath}`,
            })
            return
          }

          // Explorer 可能已经退了（空闲回收）；拿不到 url 也能分析，
          // digest 里会标注「无法钻取」。
          const running = explorers.running(sessionId)
          const digest = buildDigest(graph, {
            sessionId,
            title: prepared?.stats?.session?.title ?? null,
            builtAt: prepared?.builtAt ?? Date.now(),
            explorerUrl: running?.url ?? null,
          })

          const label = ANALYSIS_LABEL_PREFIX + ANALYSIS_KINDS[kind].label
          const out = await createAnalysisSession(ctx, { sessionId, kind, digest, label, graphPath })
          if (!out.ok) {
            send(res, 200, out)
            return
          }

          send(res, 200, {
            ok: true,
            sessionId: out.sessionId,
            label,
            digestChars: out.digestChars,
            // 图数据有没有真的注进去。false 时前端会提示「只有提问、没有背景数据」。
            injected: out.injected,
            // prompt 抛错时走了 agent.followup 兜底。对话照样开工了，
            // 但记一笔，出问题好查。
            viaFollowup: out.viaFollowup === true,
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            drillable: Boolean(running?.url),
          })
        } catch (err) {
          // 兜底：`createAnalysisSession` 之外的失败（读图、buildDigest…）也落一份栈，
          // 免得又出现「只有一行 message、不知道哪一层」的情况。
          send(res, 200, {
            ok: false,
            code: 'error',
            error: String(err?.message ?? err),
            stackFile: dumpFailure(graphPath, sessionId, kind, err) ?? undefined,
          })
        }
      },
    })
  })
}

export { apply, inject, name }
