// scripts/rebuild-graph.mjs — 用一个真实 DSH 会话重跑建图，用来量数据质量
//
// 用法：
//   node scripts/rebuild-graph.mjs <sessionId> <输出 json 路径> [maxSegments]
//
// 存在的理由：图谱的噪声规则只能靠**量真实数据**来验证和调参 —— 光看代码看不出
// `cy` 是全图度数第五的「实体」。这个脚本走的是和插件完全相同的路径
// （session-reader 读日志 → buildConversation → graph_worker.build_context_graph），
// 所以量出来的分布就是界面上看到的那份。
//
// ⚠️ 输出路径务必写成临时文件。它**不做任何保护**，会直接覆盖你给的那个路径 ——
// 而 DSH 正在用的图谱在 <DSH_HOME>/dsh-semantica-graph/session-<id>.json，
// 覆盖它会让当前打开的 Explorer 读到一半的图。
//
// 需要插件自己的 semantica 虚拟环境（scripts/install.mjs 建的那个）。

import { readSessionText, parseEvents, buildConversation, resolveSessionFile } from '../src/session-reader.js'
import { SemanticaWorker } from '../src/semantica-bridge.js'

const [sessionId, outPath, maxSegArg] = process.argv.slice(2)
if (!sessionId || !outPath) {
	console.error('用法: node scripts/rebuild-graph.mjs <sessionId> <输出 json 路径> [maxSegments]')
	process.exit(1)
}
const maxSegments = Number(maxSegArg || 1200)

const file = await resolveSessionFile({ get: () => null }, sessionId)
if (!file) {
	console.error(`找不到会话 ${sessionId} 的日志文件`)
	process.exit(1)
}
console.log(`  会话文件: ${file}`)

const t0 = Date.now()
const events = parseEvents(readSessionText(file))
console.log(`  事件 ${events.length} 条，读取 + 解析 ${Date.now() - t0}ms`)

const conversation = buildConversation(events, { maxSegments })
console.log(`  对话统计: ${JSON.stringify(conversation.stats)}`)

const worker = new SemanticaWorker({ timeoutMs: 900_000 })
const t1 = Date.now()
const out = await worker.request('build_context_graph', {
	segments: conversation.segments,
	messages: conversation.messages,
	toolCalls: conversation.toolCalls,
	turns: conversation.turns,
	decisions: conversation.decisions ?? [],
	title: conversation.title,
	outPath,
})
console.log(`  建图 ${Date.now() - t1}ms  ok=${out.ok}`)
console.log(`  统计: ${JSON.stringify(out.stats)}`)
if (!out.ok) {
	console.error(`  失败: ${out.error}`)
	if (out.trace) console.error(out.trace)
	process.exit(1)
}
console.log(`  已写入 ${outPath}`)
process.exit(0)
