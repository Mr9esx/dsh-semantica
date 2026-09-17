// src/session.js
//
// 会话元信息 —— 只有一件事：这个会话**活着的时间段**是哪一段。
//
// 为什么需要它：MCP 那边 `record_decision` **不接受 metadata**（上游接口就是这样），
// 所以决策节点没法像实体那样打上 `conversation` 标。插件认领决策有两条路，
// 一条是顺着 `involves` 边连到本会话的实体（首选），另一条就是时间 ——
// 决策的写入时间落在会话的活动窗口里。
//
// 这个窗口拿得很便宜：`sessionPersistence.list()` 只读会话日志**第一行**（header，
// 里面有 createdAt），最后写入时间用文件 mtime。**不解析整份日志** —— 老的实现为了
// 反推实体要读完整个 zstd 日志（大会话 20MB+），现在这条链路整个不需要了。

import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** harness 根目录：先看环境变量，再按平台惯例兜底。 */
export function resolveDshHome() {
	const env = process.env.DSH_HOME
	if (env && env.trim()) return env
	const home = process.env.HOME || process.env.USERPROFILE || ''
	const mac = join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness')
	try {
		if (existsSync(mac)) return mac
	} catch {
		// 落到下一个候选
	}
	return join(home, '.dsh')
}

/**
 * 会话的活动窗口。
 *
 * @param ctx 宿主上下文（要有 sessionPersistence）。
 * @param sessionId 会话 id。
 * @returns `{ found, createdAt, updatedAt, from, to }`；找不到会话时 `found:false`，
 *   `from/to` 为 null（调用方据此退化成「只按实体边认领决策」）。
 */
export async function sessionWindow(ctx, sessionId) {
	const empty = { found: false, createdAt: null, updatedAt: null, from: null, to: null }
	let sp = null
	try {
		sp = ctx.get('sessionPersistence')
	} catch {
		sp = null
	}
	if (!sp || typeof sp.list !== 'function' || !sessionId) return empty

	let metas = []
	try {
		metas = (await sp.list()) ?? []
	} catch {
		return empty
	}
	const meta = metas.find((m) => m && m.id === sessionId)
	if (!meta) return empty

	const createdAt = Number.isFinite(meta.createdAt) ? meta.createdAt : null
	let updatedAt = null
	try {
		const path = typeof sp.locate === 'function' ? sp.locate(meta) : null
		if (path) updatedAt = statSync(path).mtimeMs
	} catch {
		updatedAt = null
	}
	// 窗口两边各放开 60 秒：header 的 createdAt 是**会话建立**的时刻，
	// 而 record_decision 的 timestamp 取的是调用那一刻，两者本来就有先后差。
	const pad = 60_000
	return {
		found: true,
		createdAt,
		updatedAt,
		from: createdAt === null ? null : createdAt - pad,
		to: updatedAt === null ? Date.now() + pad : updatedAt + pad,
	}
}
