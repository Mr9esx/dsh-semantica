// scripts/check-quota.mjs — 校验送入抽取的「正文配额」按字符算，而不是按段数
//
// 为什么需要这个检查：
//   配额决定「图谱能看到多早的对话」。旧的实现是 `slice(-1200)`（段数硬上限），
//   而段长差异很大 —— 实测同一段会话平均 156 字/段，于是 1200 段的硬上限在
//   一段 1319 段的会话上白白裁掉了最前面 98 段（19 分钟），而总字符才 20.5 万，
//   远低于该有的预算。段数既不反映抽取成本，也不反映信息量。
//
//   这不是那种「坏了会报错」的逻辑 —— 裁多了不报错，只是图里的实体悄悄变少。
//   所以把边界钉在这里：真实会话不该被裁、超预算必须裁、且永远不能裁成空。
//
// 只需要 node，不需要 spaCy 也不需要 semantica。

import { readSessionText, parseEvents, buildConversation, resolveSessionFile, DEFAULT_MAX_CHARS } from '../src/session-reader.js'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src')

let failures = 0
const check = (name, ok, detail) => {
	if (!ok) failures++
	console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && !ok ? `  ← ${detail}` : ''}`)
}

// 用真实日志里的事件当模板，保证合成数据的事件结构和线上完全一致
const { readdirSync } = await import('node:fs')
const { resolveDshHome } = await import(`${src}/session-reader.js`)
const roots = join(resolveDshHome(), 'sessions')
let template = null
let realId = null
try {
	for (const proj of readdirSync(roots)) {
		for (const dir of readdirSync(join(roots, proj))) {
			if (!/^(session-)?[0-9a-f]{8}-/.test(dir)) continue
			const id = dir.replace(/^session-/, '')
			const file = await resolveSessionFile({ get: () => null }, id)
			if (!file) continue
			const events = parseEvents(readSessionText(file))
			const hit = events.find((e) => e.type === 'assistant/message' && JSON.stringify(e).includes('"text"'))
			if (hit) {
				template = hit
				realId = id
				break
			}
		}
		if (template) break
	}
} catch {
	// 没有 DSH_HOME 也能跑下面的合成用例
}

console.log(`── 常量 ──`)
check('字符预算是个正整数', Number.isSafeInteger(DEFAULT_MAX_CHARS) && DEFAULT_MAX_CHARS > 0, String(DEFAULT_MAX_CHARS))

// 造一条指定正文长度的 assistant/message 事件（沿用真实模板的结构）
const makeEvent = (i, text) => {
	const e = structuredClone(template)
	e.seq = 900000 + i
	e.time = 1_758_000_000_000 + i * 60_000
	const walk = (o) => {
		if (Array.isArray(o)) o.forEach(walk)
		else if (o && typeof o === 'object') {
			for (const k of Object.keys(o)) {
				if (k === 'text' && typeof o[k] === 'string') o[k] = text
				else walk(o[k])
			}
		}
	}
	walk(e.data)
	return e
}

if (template) {
	console.log(`── 合成数据（模板取自真实会话 ${realId?.slice(0, 8)}）──`)
	const big = Array.from({ length: 500 }, (_, i) => makeEvent(i, `第${i}段 ` + 'x'.repeat(2000)))
	const r = buildConversation(big)
	check('超预算时裁到预算以内', r.stats.segmentChars <= DEFAULT_MAX_CHARS, `实际 ${r.stats.segmentChars}`)
	check('超预算时确实裁掉了东西', r.stats.segments < big.length, `${r.stats.segments} / ${big.length}`)
	check('保留的是最新那段（从尾部累加）', String(r.segments.at(-1)?.text).startsWith('第499段'), String(r.segments.at(-1)?.text).slice(0, 12))
	check('被裁掉的是最旧的', !String(r.segments[0]?.text).startsWith('第0段'), String(r.segments[0]?.text).slice(0, 12))
	check('stats 里带上了字符用量', Number.isSafeInteger(r.stats.segmentChars) && r.stats.segmentChars > 0)

	const one = buildConversation([makeEvent(0, 'y'.repeat(DEFAULT_MAX_CHARS + 5000))])
	check('单段就超预算时也留一段（不裁成空）', one.stats.segments === 1, `${one.stats.segments} 段`)

	const tiny = buildConversation(Array.from({ length: 10 }, (_, i) => makeEvent(i, `短${i}`)))
	check('远低于预算时不裁', tiny.stats.segments === 10, `${tiny.stats.segments} 段`)

	const capped = buildConversation(big, { maxSegments: 50 })
	check('显式 maxSegments 仍然生效', capped.stats.segments === 50, `${capped.stats.segments} 段`)

	const small = buildConversation(big, { maxChars: 10_000 })
	check('显式 maxChars 仍然生效', small.stats.segmentChars <= 10_000 && small.stats.segments > 0, `${small.stats.segments} 段 / ${small.stats.segmentChars} 字符`)
} else {
	console.log('  ! 找不到真实日志当模板，跳过合成用例')
}

if (realId) {
	console.log(`── 真实会话（${realId.slice(0, 8)}）──`)
	const file = await resolveSessionFile({ get: () => null }, realId)
	const events = parseEvents(readSessionText(file))
	const full = buildConversation(events, { maxSegments: 10_000_000 })
	const dflt = buildConversation(events)
	const fits = full.stats.segmentChars <= DEFAULT_MAX_CHARS
	check(`默认配额下 ${fits ? '不裁' : '按预算裁'}`, fits ? dflt.stats.segments === full.stats.segments : dflt.stats.segmentChars <= DEFAULT_MAX_CHARS,
		`默认 ${dflt.stats.segments} 段 / 全量 ${full.stats.segments} 段（${full.stats.segmentChars} 字符）`)
	console.log(`    全量 ${full.stats.segments} 段 / ${full.stats.segmentChars.toLocaleString()} 字符，默认配额下保留 ${dflt.stats.segments} 段`)
}

console.log('')
if (failures > 0) {
	console.log(`✗ ${failures} 项失败`)
	process.exit(1)
}
console.log('✓ 正文配额行为正确')
