// src/session-reader.js
//
// 读取 DSH 会话日志并抽取出「当前对话」的结构化内容。
//
// DSH 落盘是 zstd 压缩的 JSONL（session.jsonl.zstd），而且是**多帧** zstd：
// 每次 append 一批事件就往文件尾追加一个独立帧。这一点很关键——
// node:zlib 的 zstdDecompressSync / createZstdDecompress 只解第一帧，
// 只会拿到开头那行 session header（实测 197 字节），把整个会话读成空的。
// fzstd 会连续解完所有帧，因此用它做主路径；node:zlib 仅作单帧兜底。
//
// 读取路径优先走 host 服务 ctx.sessionPersistence（list + locate 拿绝对产物路径），
// 服务缺席时回退到直接扫描 $DSH_HOME/sessions。
//
// ── 为什么读取路径只有「读文件」这一条 ──
//
// 先说 id 形态，这是最容易搞错的地方（我在这里栽过一次）：
// 持久化层认的会话 id **就是磁盘上的目录名**，顶层会话是 `session-<uuid>`，
// 多数子会话（origin=subagent）是裸 `<uuid>`。实测依据：48 个子会话目录全是裸 uuid
// 且 header 里 origin 均为 subagent，而 header 的 parentSession 写的是
// `session-<父 uuid>`（带前缀）。
// 但插件从 DSH 客户端拿到的是**裸 uuid** —— 所以 resolveSessionFile 必须两种都试。
//
// load() 不能用：它会 commitPrepared，在有 torn tail 时**截断并改写会话文件**。
//
// 这里曾经写着「load()/inspect() 对仍绑定活动回合的会拒绝」。那条**查源码对不上**：
// inspect() 对活跃会话走 `inspectLive(live)` 直接返回内存视图，没有「开放回合就拒绝」
// 的判定；它的 closers 来自 `interruptedTurnClosers()`，补的是崩溃留下的**被中断**
// 回合，不是正在进行的回合。
//
// inspect() / readFrom() 是 DSH 自己给「轨迹」供数用的宿主接口（客户端
// ctx.uiConversation → ctx.sessions.binding(id).eventSource，窗口化 + hasMore 分页），
// 语义上完全够我们用。但换成它们要额外解决一件事：必须传**目录名形态**的 id，
// 而不是客户端给的裸 uuid。我没有验证成功过 —— 两次离线尝试都不成立（第一次传了
// 裸 uuid，第二次 stub 的 sessions registry 让 inspect 的 for(;;) 重试空转），
// 所以**「inspect 能不能用」目前是未验证状态**，不要引用任何一方的结论。
//
// 当前选择就一条路：locate() 拿路径 → 读文件。它对两种 id 形态、两种目录命名都工作
// （实测 4/4），而「优先 inspect、失败回退文件」会把一条可靠的路径变成两条都要维护的
// 路径。要真换，先离线把目录名形态的 id 验证通，再整条替换。

import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** fzstd 是唯一能正确解多帧的选择；缺席时降级（只对单帧文件有效）。 */
let fzstd = null
try {
  fzstd = require('fzstd')
} catch {
  fzstd = null
}

/** zstd 魔数；带它或 .zstd 后缀的文件需要解压。 */
const ZSTD_MAGIC = 0x28b52ffd

/** 会话日志的可能文件名。 */
const SESSION_FILENAMES = ['session.jsonl.zstd', 'session.jsonl']

/**
 * 送入抽取的正文**字符**预算（不是段数）。
 *
 * 为什么不用段数：实测同一段会话平均 156 字/段，段数和文本量根本不成比例 ——
 * 一段 1300 段的会话正文总共才 20.5 万字符，而原来 1200 段的硬上限会白白裁掉
 * 98 段（最前面 19 分钟）。真正决定抽取耗时的是字符数（实测约 2.2 万字符/秒，
 * 600 段/9 秒），所以预算该按字符给。
 *
 * 40 万字符 ≈ 18 秒 NER。正常会话远够用（实测 1.5 小时会话只有 5.5 万字符），
 * 这个上限只用来兜住极端超长会话。
 */
export const DEFAULT_MAX_CHARS = 400_000

/** 解析 DSH_HOME：环境变量优先，其次 desktop 默认位置，最后 ~/.dsh。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const desktop = join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
  if (existsSync(desktop)) return desktop
  return join(homedir(), '.dsh')
}

/** 读取会话日志文本；自动识别 zstd（按魔数而不是只看后缀）。 */
export function readSessionText(path) {
  const buf = readFileSync(path)
  const magic = buf.length >= 4 ? buf.readUInt32LE(0) : 0
  if (magic !== ZSTD_MAGIC && !/\.zstd$/i.test(path)) {
    return buf.toString('utf8')
  }
  if (fzstd && typeof fzstd.decompress === 'function') {
    // 多帧：fzstd 会一路解到文件尾
    return Buffer.from(fzstd.decompress(buf)).toString('utf8')
  }
  // 兜底：只解得出第一帧，长会话会缺内容——好过整个插件不可用
  return zstdDecompressSync(buf).toString('utf8')
}

/** 把一个会话日志解析成事件数组；坏行跳过而不整体失败。 */
export function parseEvents(text) {
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      // 撕裂的尾行（正在写入）——跳过
    }
  }
  return out
}

/**
 * 定位会话日志文件。
 * 先用 sessionPersistence 的 list()+locate()（权威且无需知道 slug 编码），
 * 失败则回退到按 sessionId 递归扫描 sessions 目录。
 * @returns 绝对路径，未找到返回 null
 */
export async function resolveSessionFile(ctx, sessionId) {
  // 1) 首选：sessionPersistence.list() → locate()
  try {
    const persistence = ctx.get('sessionPersistence')
    if (persistence && typeof persistence.list === 'function') {
      const headers = await persistence.list()
      const list = Array.isArray(headers) ? headers : (headers?.sessions ?? [])
      for (const meta of list) {
        const id = meta?.id ?? meta?.sessionId
        if (id !== sessionId) continue
        if (typeof persistence.locate === 'function') {
          const located = await persistence.locate(meta)
          const p = typeof located === 'string' ? located : (located?.path ?? located?.displayPath)
          if (p && existsSync(p)) return p
        }
      }
    }
  } catch {
    // 服务不可用 / locate 未实现——继续回退
  }

  // 2) 回退：扫描 $DSH_HOME/sessions/<slug>/<目录名>/session.jsonl[.zstd]
  //
  // 目录名不一定就是 sessionId —— DSH 用的是 `session-<id>` 这种形式
  // （实测 .../sessions/<slug>/session-22f6449a-…/session.jsonl.zstd）。
  // 只按 id 找会一路 404，所以两种命名都试。
  const home = resolveDshHome()
  const root = join(home, 'sessions')
  if (!existsSync(root)) return null
  const dirNames = [sessionId, `session-${sessionId}`]
  try {
    for (const slug of readdirSync(root)) {
      for (const name of dirNames) {
        const dir = join(root, slug, name)
        if (!existsSync(dir)) continue
        for (const file of SESSION_FILENAMES) {
          const p = join(dir, file)
          if (existsSync(p) && statSync(p).isFile()) return p
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * 从 content blocks 里拼出「对话正文」。
 *
 * 只认 `type === 'text'` 的块 —— 这一条过滤很关键，assistant 的 content 里
 * 除了正文还有 `reasoning`（模型的思考过程）和 `tool-call`。
 *
 * reasoning 必须排除，实测数据（本仓库作者的一次真实会话）：
 *   text 块 320 个 /  33,831 字符   ← 用户真正看到的回复
 *   reasoning 块 457 个 / 544,010 字符  ← 模型的内部思考，是正文的 16 倍
 *
 * 不排除的后果有三个：
 *   1. 图基本是照着思考过程画的，真实对话被淹没；
 *   2. 思考是英文散文式的自我对话（"Let me fetch…", "Hmm", "first"），
 *      spaCy 会把 Let / Hmm / first / one / objective 当成实体，
 *      实测噪声实体霸榜（cy 241 次、first 89 次、Let 50 次…）；
 *   3. 思考是模型的私有内容，把它画进用户能浏览的图里也不合适。
 *
 * 没有 `type` 字段的块按旧格式保留（纯文本块此前就靠 `.text` 取值）。
 */
function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (typeof b === 'string') {
      parts.push(b)
      continue
    }
    if (!b || typeof b.text !== 'string') continue
    if (b.type !== undefined && b.type !== 'text') continue
    parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/** 工具结果的文本（tool-result 嵌一层 content 数组）。 */
function toolResultText(data) {
  const blocks = data?.message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (b && b.type === 'tool-result') {
      if (typeof b.content === 'string') parts.push(b.content)
      else if (Array.isArray(b.content)) {
        for (const c of b.content) if (c && typeof c.text === 'string') parts.push(c.text)
      }
    }
  }
  return parts.join('\n').trim()
}

/** 单行摘要，用于节点 label / tooltip。 */
function clip(s, n) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/**
 * 把事件流抽成「当前对话」的结构化表示。
 *
 * 输出既是喂给 Semantica 的文本来源（每个发言/调用一段，带来源坐标），
 * 也是图谱骨架本身（轮次 → 步骤 → 消息 / 工具调用）。
 *
 * @param events 会话事件数组
 * @param opts.maxToolResult 工具结果保留的最大字符数（超长结果会撑爆 NER）
 * @param opts.maxSegments 送入抽取的文本段数上限（默认不限；配额交给 maxChars）
 * @param opts.maxChars 送入抽取的正文总字符预算（保留最新的，默认 DEFAULT_MAX_CHARS）
 */
/**
 * 提问工具的名字。DSH 里用户做「选择」几乎都走它，所以这是对话中
 * 结构化决策的唯一可靠来源 —— 选项、选项说明、用户最终选择全都在事件里。
 */
const ASK_TOOL = 'ask_user_question'

/**
 * 从提问工具的 `arguments` 里取出 questions。
 *
 * 事件里 `arguments` 是**字符串**（JSON 文本），不是对象，所以要自己 parse。
 * 解析失败返回空数组 —— 决策是锦上添花，不能因为它让整条链路挂掉。
 */
function parseAskArgs(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(o?.questions) ? o.questions : []
  } catch {
    return []
  }
}

/**
 * 从提问工具的结果里取出用户的答案。
 *
 * 结果是 `{"answers":[{"id","selected":[...],"custom":"..."}]}`。它可能被包在
 * 别的文本里（前端会加提示语），所以退一步用首尾大括号截取再试一次。
 */
function parseAnswers(raw) {
  if (typeof raw !== 'string' || !raw) return null
  const tryParse = (s) => {
    try {
      const o = JSON.parse(s)
      return Array.isArray(o?.answers) ? o.answers : null
    } catch {
      return null
    }
  }
  const direct = tryParse(raw)
  if (direct) return direct
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  return a >= 0 && b > a ? tryParse(raw.slice(a, b + 1)) : null
}

/**
 * 把一次「提问 → 回答」折成图里的决策节点（字段按 Explorer 的 decisions 路由对齐）。
 *
 * Explorer 那条路由（`explorer/routes/decisions.py`）只认 `type == "decision"` 的
 * 节点，并从 properties 里读这 7 个字段：
 *   category / scenario / reasoning / outcome / confidence / timestamp
 * 一个不写的话决策区就是空的 —— 但节点类型对不上也同样是空的，
 * 所以这里必须严格照它的字段名来。
 */
function decisionOf(call, q, ans) {
  const selected = Array.isArray(ans?.selected) ? ans.selected : []
  const custom = typeof ans?.custom === 'string' ? ans.custom.trim() : ''
  // 用户既可以点选项也可以自己打字；自己打字的优先，那是最明确的一次表态。
  const outcome = custom || selected[0] || ''
  if (!outcome) return null

  const options = Array.isArray(q?.options) ? q.options : []
  // 选中项自己的 description 就是「为什么这么选」——Explorer 的 reasoning 字段要的正是这个。
  const chosen = options.find((o) => o && o.label === outcome)
  const reasoning = (chosen && chosen.description) || ''
  const alternatives = options
    .filter((o) => o && o.label && o.label !== outcome)
    .map((o) => o.label)

  return {
    // 一个提问里可能有好几个问题，各自成为一个决策节点。
    id: `${call.callId ?? call.id}:${q?.id ?? 'q'}`,
    callId: call.callId,
    seq: call.seq,
    time: call.time,
    turn: call.turn,
    step: call.step,
    questionId: q?.id ?? null,
    // 自由输入 vs 点选项：界面上值得区分（点选项是有界选择，打字是开放表态）。
    kind: custom ? 'custom' : 'selected',
    category: q?.header ?? '',
    scenario: q?.question ?? '',
    reasoning,
    outcome,
    alternatives,
    optionCount: options.length,
  }
}

export function buildConversation(events, opts = {}) {
  const maxToolResult = opts.maxToolResult ?? 1500
  // 段数默认**不限** —— 配额改由下面的字符预算决定，段数只是调用方想硬压时的开关
  const maxSegments = opts.maxSegments ?? Infinity
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  // 默认只看真实对话；打开则连运行时上下文/技能目录这类系统注入文本一起抽
  const includeInjected = opts.includeInjected === true

  const turns = []
  const messages = []
  const toolCalls = []
  const segments = []
  const decisions = []
  let title = null

  // 当前轮次游标。
  //
  // 为什么需要它：`user/message` 事件的 data 里**没有 `turn` 字段**（顶层键只有
  // content / source / role / id），assistant/message、tool/call、step/start 都有。
  // 所以 `d.turn ?? null` 对用户消息永远是 null，graph_worker 那句
  // `if m.get("turn") is not None` 就不建 `turn --contains--> msg` 边 ——
  // 用户消息成了孤儿节点。
  //
  // 实测后果（223 节点 / 4 轮的会话）：4 条用户消息全部脱链，它们提到的实体跟着
  // 一起被拖进独立连通分量，`component_sizes=[216,5,1,1]`。孤岛里恰好是「构建失败
  // 退出码 1」这条关键证据，而讲这件事的 assistant 消息在主分量里 —— AI 分析时会
  // 报告「孤岛承载的证据是主结论的核心，却没被连上」，看着像图坏了，实际是这里漏了。
  //
  // 修法：轮次由 `turn/start` 开启，往后的事件都归它，直到下一个 `turn/start`。
  // 有显式 `turn` 的以显式为准，没有的用游标兜底。
  let currentTurn = null

  const callIndex = new Map()

  for (const e of events) {
    if (!e || typeof e.type !== 'string') continue
    const d = e.data ?? {}
    switch (e.type) {
      case 'session/title':
        if (typeof d.title === 'string') title = d.title
        break

      case 'turn/start': {
        const t = d.turn ?? turns.length + 1
        currentTurn = t
        turns.push({ turn: t, seq: e.seq, time: e.time, steps: 0 })
        break
      }

      case 'step/start': {
        const t = turns.find((x) => x.turn === d.turn)
        if (t) t.steps += 1
        break
      }

      case 'user/message': {
        // 只认真正的人类输入。
        //
        // user/message 有三种 source.kind：'user'（真人）、'plugin'（运行时上下文
        // 快照、后台任务完成通知）、'skill-catalog'（系统注入的技能目录）。
        // 后两者是系统塞进对话流的机器文本，动辄几千字，让它们进图会把真实对话
        // 彻底淹没（实测技能目录里的 "arkcli agent：管理 ARK Managed Agents"
        // 被当成实体，还连出一堆 related_to）。
        const kind = d.source?.kind
        if (kind && kind !== 'user' && !includeInjected) break
        const text = textOf(d.content)
        if (!text) break
        messages.push({
          id: `user:${e.seq}`,
          role: 'user',
          seq: e.seq,
          time: e.time,
          turn: d.turn ?? currentTurn,
          text,
          excerpt: clip(text, 160),
        })
        segments.push({ source: `user:${e.seq}`, role: 'user', seq: e.seq, time: e.time, turn: d.turn ?? currentTurn, text })
        break
      }

      case 'assistant/message': {
        const blocks = d.message?.content ?? d.content
        const text = textOf(blocks)
        if (!text) break
        // 这条消息调了哪些工具 —— 块的 id 就是 tool/call 的 callId，两边能直接对上。
        //
        // 为什么要单独记：图里原本只有 `turn --contains--> tool`，没有
        // `msg --calls--> tool`，于是「这条结论是跑哪几条命令得出的」在图上是断的。
        // 实测这段信息在日志里 100% 齐全（90 条 assistant 消息带 129 个 tool-call 块，
        // callId 与 tool/call 事件 129/129 全部匹配），只是没被用。
        const toolCallIds = (Array.isArray(blocks) ? blocks : [])
          .filter((b) => b && b.type === 'tool-call' && typeof b.id === 'string')
          .map((b) => b.id)
        messages.push({
          id: `assistant:${e.seq}`,
          role: 'assistant',
          seq: e.seq,
          time: e.time,
          turn: d.turn ?? currentTurn,
          step: d.step ?? null,
          toolCallIds,
          text,
          excerpt: clip(text, 160),
        })
        segments.push({
          source: `assistant:${e.seq}`,
          role: 'assistant',
          seq: e.seq,
          time: e.time,
          turn: d.turn ?? currentTurn,
          text,
        })
        break
      }

      case 'tool/call': {
        const call = {
          // 裸 id，不加 tool: 前缀 —— 前缀由 graph_worker 统一加。
          // 两边都加会得到 "tool:tool:call_xxx" 这种双前缀 id。
          id: d.callId ?? `seq:${e.seq}`,
          callId: d.callId ?? null,
          name: d.name ?? 'tool',
          seq: e.seq,
          time: e.time,
          turn: d.turn ?? currentTurn,
          step: d.step ?? null,
          args: d.arguments ?? '',
          resultText: '',
        }
        // 提问工具带上它问了什么 —— 答案是后面 tool/result 才到的，
        // 两半都齐了才能折成一条决策。
        if (call.name === ASK_TOOL) call.questions = parseAskArgs(d.arguments)
        toolCalls.push(call)
        if (call.callId) callIndex.set(call.callId, call)
        break
      }

      case 'tool/result': {
        const callId = d.message?.source?.callId ?? d.callId
        const full = toolResultText(d)
        const call = callId ? callIndex.get(callId) : null
        if (call) call.resultText = full.length > maxToolResult ? full.slice(0, maxToolResult) : full
        // 一次提问的答案到了 —— 现在才可能知道用户选了什么。
        if (call && call.name === ASK_TOOL && Array.isArray(call.questions)) {
          const answers = parseAnswers(full) ?? []
          for (const q of call.questions) {
            const ans = answers.find((a) => a && a.id === q?.id) ?? null
            const dec = decisionOf(call, q, ans)
            // 没作答的问题（用户跳过/取消）不产生决策节点。
            if (dec) decisions.push(dec)
          }
        }
        break
      }

      default:
        break
    }
  }

  // 工具调用**不进**语义抽取的输入 —— 这条是实测出来的结论，不是想当然。
  //
  // 曾经把它们拼成「工具名 + 描述」喂给 NER，理由是「命令/路径是实体密度最高的
  // 地方」。实测恰恰相反：DSH 的工具段文本是 `<动词> <名词短语>` 形式的界面标签
  // （"Check working directory contents"、"Find SlotMap declaration merge sites"），
  // spaCy 会把开头那个动词当实体抽出来，于是实体榜被 Read / Verify / Find /
  // Check / Inspect / Locate 这些动词霸占 —— 实测它们各出现 31~48 次，
  // 而同样的词在对话正文里只出现 3~5 次，来源一目了然。
  //
  // 工具调用的结构价值已经由 toolCalls 单独承载（→ 图里的 tool 节点），
  // 所以这里整段丢掉不会丢失任何东西，反而让实体层全是真实对话概念。

  // 选段：按**字符预算**裁剪，不按段数。
  //
  // 这里曾经按角色分配额（给工具段单独设 35% 上限）。那是在工具段还在喂 NER 时
  // 加的保护：当时用 `slice(-400)` 取最新，在编码类会话里尾部 400 段 100% 是工具
  // 段，只带进来 12.8K 字符的工具名碎片，而同期被丢掉的助手正文有 343K 字符，
  // 结果实体全是命令行片段、关系几乎为零。
  //
  // 现在工具段已不参与抽取、reasoning 也已排除，剩下的全是对话正文 —— 每段都是
  // 等价的正文，所以「留下哪些」没有取舍空间，只有「留多少」的问题。
  // 而「留多少」按段数算是错的：段长差异很大，段数不反映成本也不反映信息量。
  // 实测本会话 1319 段只有 20.5 万字符，旧的 1200 段上限白白裁掉了最前面 98 段。
  //
  // 从最新往旧累加，超预算就停：宁可丢掉时间上更远的开头，也要保住最近的上下文。
  const cap = Number.isFinite(maxSegments) && maxSegments > 0 ? maxSegments : Infinity
  let trimmed = segments.length > cap ? segments.slice(-cap) : segments
  if (Number.isFinite(maxChars) && maxChars > 0) {
    let used = 0
    let from = trimmed.length
    while (from > 0) {
      const len = trimmed[from - 1].text?.length ?? 0
      // 至少留一段：单段就超预算时不能裁成空
      if (used + len > maxChars && from < trimmed.length) break
      used += len
      from--
    }
    trimmed = trimmed.slice(from)
  }

  return {
    title,
    turns,
    messages,
    toolCalls: toolCalls.map((c) => ({
      id: c.id,
      callId: c.callId,
      name: c.name,
      // 图里 tool 节点的显示名（人类可读），不是喂给 NER 的文本
      title: toolTitle(c),
      seq: c.seq,
      time: c.time,
      turn: c.turn,
      step: c.step,
      argsSummary: clipArgs(c.args),
      resultSummary: clip(c.resultText, 200),
    })),
    segments: trimmed,
    // 对话里结构化的「选择」记录 —— 图里 decision 节点的来源。
    decisions,
    stats: {
      events: events.length,
      turns: turns.length,
      messages: messages.length,
      toolCalls: toolCalls.length,
      decisions: decisions.length,
      segments: trimmed.length,
      // 字符用量：预算是否吃紧、有没有真的裁掉东西，看这两个数就够了
      segmentChars: trimmed.reduce((n, seg) => n + (seg.text?.length ?? 0), 0),
      segmentCharsBudget: DEFAULT_MAX_CHARS,
    },
  }
}

/**
 * 工具调用的「一句话标题」，用作图里 tool 节点的显示名。
 *
 * 注意这与「喂给 NER 的文本」是两件事，别混：工具描述做 NER 输入是垃圾
 * （spaCy 会把开头那个动词当成实体，详见 buildConversation 里的说明），
 * 但作为节点标签它是最好的选择 —— 因为 DSH 界面上给用户看的就是它。
 *
 * 不用工具名（bash / read / edit）当标签：实测 677 个 tool 节点里 398 个都叫
 * "bash"，在 Explorer 里就是 398 个一模一样的节点，等于没有信息。
 */
function toolTitle(call) {
  if (typeof call.args === 'string' && call.args) {
    try {
      const p = JSON.parse(call.args)
      if (p && typeof p === 'object') {
        // 提问工具的参数是 `{"questions":[{header, question, options}]}` ——
        // 下面那串顶层 key 一个都命中不了，会直接掉到 `call.name`，
        // 于是图里的节点名和决策因果链的每一步都显示成光秃秃的 "ask_user_question"。
        // 用各问题的 header 拼一行，一眼能看出这次问了什么。
        if (Array.isArray(p.questions) && p.questions.length) {
          const heads = p.questions
            .map((q) => (q && (q.header || q.question)) || '')
            .filter((s) => typeof s === 'string' && s.trim())
          if (heads.length) return clip(heads.join(' · '), 120)
        }
        for (const k of ['description', 'prompt', 'query', 'question', 'task', 'summary', 'title']) {
          const v = p[k]
          if (typeof v === 'string' && v.trim()) return clip(v.trim(), 120)
        }
        // 读写类工具没有 description，退而取文件的基名（整条路径会被当成节点名）
        for (const k of ['file_path', 'filePath', 'path', 'notebook_path', 'url']) {
          const v = p[k]
          if (typeof v === 'string' && v.trim()) {
            return clip(v.split(/[\\/]/).filter(Boolean).pop() || v.trim(), 120)
          }
        }
      }
    } catch {
      // 参数不是 JSON：截一段当标题
      return clip(call.args, 120)
    }
  }
  return call.name || 'tool'
}

/** 把工具参数 JSON 压成一行人类可读的摘要（保留最有信息量的值）。 */
function clipArgs(raw) {
  if (typeof raw !== 'string' || !raw) return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return clip(raw, 300)
  }
  if (!parsed || typeof parsed !== 'object') return clip(String(parsed), 300)
  const parts = []
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'object') {
      const json = JSON.stringify(v)
      parts.push(`${k}=${clip(json, 200)}`)
    } else {
      parts.push(`${k}=${clip(String(v), 200)}`)
    }
  }
  return clip(parts.join(' '), 600)
}
