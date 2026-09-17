// src/toggle.js
//
// 「每轮自动提取」开关的**持久状态** —— 一个会话一个格子。
//
// ## 为什么状态得放在 host 侧，而且要落盘
//
// 开关影响的东西在两边：
//   · 前端按钮要显示开关状态（所以要有地方查）；
//   · 系统提示词里那段「写入准则」要跟着变（变量 provider 在每次组装提示词时求值）。
//
// 变量 provider 是**同步**的（dsh-system-prompt 直接把 `variables[name]` 取出来插值），
// 所以状态必须在内存里能同步读到；同时它得跨重启活着（用户开了一整个下午的会话，
// 不该因为重启 DSH 就悄悄关掉）。所以：内存里一份 Map，写的时候同步落一个小 JSON。
//
// 存的是 `{ [sessionId]: { on, updatedAt } }`。图文件是全局一张，这个状态是每会话一份，
// 两者别混。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 只保留最近这么多个会话的开关，免得这个文件无限长下去。 */
const MAX_ENTRIES = 400

/**
 * 建一个开关存储。
 *
 * @param file 落盘位置（flat JSON）。
 */
export function createToggleStore(file) {
	/** @type {Map<string, { on: boolean, updatedAt: string }>} */
	const state = new Map()
	let loaded = false

	function load() {
		if (loaded) return
		loaded = true
		try {
			const raw = JSON.parse(readFileSync(file, 'utf8'))
			for (const [id, v] of Object.entries(raw ?? {})) {
				if (id && v && typeof v === 'object' && v.on === true) {
					state.set(id, { on: true, updatedAt: String(v.updatedAt ?? '') })
				}
			}
		} catch {
			// 文件不存在 / 坏了都当「全关」—— 开关读不出来时最安全的默认是别自动写图
		}
	}

	function persist() {
		try {
			// 超量时丢最旧的（updatedAt 是 ISO 串，字典序即时间序）
			if (state.size > MAX_ENTRIES) {
				const sorted = [...state.entries()].sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
				for (const [id] of sorted.slice(0, state.size - MAX_ENTRIES)) state.delete(id)
			}
			mkdirSync(dirname(file), { recursive: true })
			writeFileSync(file, JSON.stringify(Object.fromEntries(state), null, 1))
		} catch {
			// 写不进去只影响下次重启后的状态，不影响这一轮的行为
		}
	}

	return {
		/** 这个会话开着吗。**同步** —— 提示词变量 provider 需要它。 */
		isOn(sessionId) {
			if (!sessionId) return false
			load()
			return state.get(String(sessionId))?.on === true
		},

		/** 打开/关闭，落盘。 */
		set(sessionId, on) {
			const id = String(sessionId ?? '')
			if (!id) return false
			load()
			if (on) state.set(id, { on: true, updatedAt: new Date().toISOString() })
			else state.delete(id)
			persist()
			return on === true
		},

		/** 诊断用：当前开着的会话数与文件位置。 */
		snapshot() {
			load()
			return { file, on: [...state.keys()], count: state.size }
		},
	}
}
