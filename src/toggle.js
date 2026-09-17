// src/toggle.js
//
// 「每轮自动提取」开关的**持久状态**。
//
// ## 两层状态，因为「第一次输入」这个场景拿不到会话
//
// 用户报过一次很实在的问题：新建对话在**发出第一条消息之前根本没有会话**（核心那排
// 标签/标题是会话级槽，没有 session 就不渲染），所以任何「按会话」的按钮在那一刻都
// 点不到 —— 而恰恰是那一刻用户最想开这个开关。
//
// 所以状态分两层：
//
//   · `default`：新会话的默认值。设一次，之后每个新会话一开始就是它；
//   · `sessions`：某个会话被单独改过时的值（覆盖 default）。
//
// 解析规则就一句：`sessions[id] ?? default`。用户在某个会话里点开关，只影响那个会话；
// 想让以后所有新会话都开着，改 default。
//
// ## 为什么状态得放在 host 侧，而且要落盘
//
// 开关影响的东西在两边：前端按钮要显示状态；系统提示词里那段「写入准则」要跟着变
// （变量 provider 在每次组装提示词时求值）。变量 provider 是**同步**的
// （dsh-system-prompt 直接把 `variables[name]` 取出来插值），所以状态必须在内存里能
// 同步读到；同时它得跨重启活着（用户开了一整个下午的会话，不该因为重启 DSH 就悄悄
// 关掉）。所以：内存里一份，写的时候同步落一个小 JSON。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 只保留最近这么多个会话的单独设置，免得这个文件无限长下去。 */
const MAX_ENTRIES = 400

/**
 * 建一个开关存储。
 *
 * @param file 落盘位置（flat JSON）。
 */
export function createToggleStore(file) {
	/** @type {boolean} 新会话的默认值 */
	let def = false
	/** @type {Map<string, { on: boolean, updatedAt: string }>} */
	const sessions = new Map()
	let loaded = false

	function load() {
		if (loaded) return
		loaded = true
		let raw = null
		try {
			raw = JSON.parse(readFileSync(file, 'utf8'))
		} catch {
			// 文件不存在 / 坏了都当「全关」—— 开关读不出来时最安全的默认是别自动写图
			return
		}
		if (!raw || typeof raw !== 'object') return
		if (raw.default === true) def = true
		const bag = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : null
		if (bag) {
			for (const [id, v] of Object.entries(bag)) {
				if (id && v && typeof v === 'object') {
					sessions.set(id, { on: v.on === true, updatedAt: String(v.updatedAt ?? '') })
				}
			}
			return
		}
		// 兼容第一版格式（`{ "<sessionId>": { on: true } }`）：那时候只会存「开」
		for (const [id, v] of Object.entries(raw)) {
			if (id && v && typeof v === 'object' && v.on === true) {
				sessions.set(id, { on: true, updatedAt: String(v.updatedAt ?? '') })
			}
		}
	}

	function persist() {
		try {
			// 超量时丢最旧的（updatedAt 是 ISO 串，字典序即时间序）
			if (sessions.size > MAX_ENTRIES) {
				const sorted = [...sessions.entries()].sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
				for (const [id] of sorted.slice(0, sessions.size - MAX_ENTRIES)) sessions.delete(id)
			}
			mkdirSync(dirname(file), { recursive: true })
			writeFileSync(file, JSON.stringify({ default: def, sessions: Object.fromEntries(sessions) }, null, 1))
		} catch {
			// 写不进去只影响下次重启后的状态，不影响这一轮的行为
		}
	}

	return {
		/** 这个会话开着吗。**同步** —— 提示词变量 provider 需要它。 */
		isOn(sessionId) {
			if (!sessionId) return def
			load()
			const own = sessions.get(String(sessionId))
			return own ? own.on === true : def
		},

		/** 这个会话是不是被单独改过（界面据此区分「跟着默认」和「单独设过」）。 */
		isExplicit(sessionId) {
			load()
			return Boolean(sessionId) && sessions.has(String(sessionId))
		},

		/** 新会话的默认值。 */
		getDefault() {
			load()
			return def
		},

		/** 改某个会话（覆盖默认值），落盘。 */
		set(sessionId, on) {
			const id = String(sessionId ?? '')
			if (!id) return false
			load()
			sessions.set(id, { on: on === true, updatedAt: new Date().toISOString() })
			persist()
			return on === true
		},

		/** 改新会话的默认值（不影响已经单独设过的会话），落盘。 */
		setDefault(on) {
			load()
			def = on === true
			persist()
			return def
		},

		/** 诊断用。 */
		snapshot() {
			load()
			return { file, default: def, sessions: Object.fromEntries(sessions), count: sessions.size }
		},
	}
}
