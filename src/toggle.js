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
 * 落到磁盘上的格式版本。存在两个理由：
 *
 *   · 第一版没有这个字段（那时候的默认值是**关**）；
 *   · 加字段时得能区分「用户自己设成关」和「旧版本的默认值恰好是关」。
 *
 * 用户报过的问题：「打开知识图谱，里面跟我这个对话完全没关系」—— 查下来是那个对话
 * **一个字都没写进去**（模型没写），而新对话默认又是关的。默认关的代价是「打开面板
 * 什么都看不到」，默认开的代价是「每轮都可能写入、更费 token」。用户选了后者，
 * 所以新装的默认值改成开，并且把旧文件（没有 v 字段的）也升上来。
 *
 * 诚实的代价：如果有人在旧版本里**特意**把默认改成关，这次升级会把它改回开。旧格式
 * 里没记「这是不是用户显式设的」，无从区分；代价是一下点击（工具栏那个开关就能改回去）。
 */
const FORMAT_VERSION = 1

/** 没设过任何东西时的默认值（= 新装默认）。 */
const DEFAULT_ON = true

/**
 * 建一个开关存储。
 *
 * @param file 落盘位置（flat JSON）。
 */
export function createToggleStore(file) {
	/** @type {boolean} 新会话的默认值 */
	let def = DEFAULT_ON
	/** 磁盘上的格式版本（0 = 第一版，没有这个字段） */
	let fmt = 0
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
			// 文件不存在（新装）→ 保持 DEFAULT_ON。坏了也一样：读不出来就当默认值，
			// 用户随时能在界面上改。
			return
		}
		if (!raw || typeof raw !== 'object') return
		fmt = Number(raw.v) || 0
		// 旧格式文件里那个 default 是**旧版本的默认值**写下来的，不是用户的选择
		// （用户设过就带 v 字段了）。所以旧文件一律采用新默认，然后按新格式落一次盘。
		def = fmt >= FORMAT_VERSION ? raw.default === true : DEFAULT_ON
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
			writeFileSync(
				file,
				JSON.stringify({ v: FORMAT_VERSION, default: def, sessions: Object.fromEntries(sessions) }, null, 1),
			)
			fmt = FORMAT_VERSION
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
			return { file, format: fmt, default: def, sessions: Object.fromEntries(sessions), count: sessions.size }
		},
	}
}
