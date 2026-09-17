// src/session.js
//
// 只剩一件事：找到 harness 根目录（图文件、视图文件都放它下面）。
//
// 这里以前还有一个 `sessionWindow()` —— 读会话日志 header 的 createdAt 和文件 mtime，
// 拿这个时间段去**兜底认领**没打标的决策。它已经被删掉了：那条规则是错的。一天里连着
// 聊几个会话时，同一个没打标的决策会被每一个「时间覆盖它」的会话同时认领，于是用户看到
// 「我根本没提取过的对话里冒出了别人的 6 个节点」。
// 现在认领只有一条依据：明确的会话标（含由已打标实体通过 involves 边认领的决策）。
// 副作用是插件连 sessionPersistence 都不再需要 —— 少一个依赖，少一处能出错的地方。

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
