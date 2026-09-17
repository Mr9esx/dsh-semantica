// src/prompt.js
//
// 交给模型的指令：怎么把这场对话写进 Semantica 图。
//
// ## 为什么要有这个文件
//
// 提取这件事现在**不由插件做**，而是模型在做 —— 模型手里才有对话内容，插件只能在
// 旁边看着。插件能做的是「把规则告诉模型」，靠的是 DSH 的 systemPrompt 服务：
//
//   ctx.systemPrompt.section({ name, order, text })
//   ctx.systemPrompt.variable(name, (context) => value)
//
// 段落文本里可以用 `{{变量}}` 插值，变量由 provider 在**每次组装提示词时**求值。
// 会话 id 就是这么一个变量：`context.agent?.session.header.id`
// （dsh-agent-loop 里 provider/model/cwd 三个变量用的就是这个 context）。
//
// 这就是「每个会话各写各的」能成立的唯一原因：MCP 那边是一张全局图、一个固定路径
// （SEMANTICA_KG_PATH，dsh-mcp-client 还会把子进程环境里的 DSH_* 全删掉，所以配置里
// 没法按会话插值），图的会话归属只能靠**写进去的时候打的标**。打标要模型知道
// 自己在哪个会话里，而这件事插件能告诉它。
//
// ## 写入规则的两条硬约束（都是上游接口决定的，不是偏好）
//
//   · add_entity / add_relationship 收 metadata，record_decision **不收** ——
//     所以决策的归属不能靠标，只能靠它 involves 的实体（插件会顺着这条边走）。
//     指令里因此明确要求 record_decision 传 entities=[...]。
//   · 中文文本必须显式传 model="zh_core_web_sm"，否则 spaCy 的英文模型会把整句
//     当成一个实体（实测），图会废掉。

/** 提示词段落名。取插件名前缀，避免和核心/别人的段落撞名。 */
export const SECTION_NAME = 'plugin:semantica-graph'

/**
 * 段落排序位置。核心那段注释说得很明白：
 * 「External plugins may use any finite order; equal orders are deterministic by
 * section name.」所以这里挑 700 —— 在 TEAM_POLICY(600) 之后、PTC_ONLY(800) 之前，
 * 属于「行为准则」那一带，不会插到工具说明中间。
 */
export const SECTION_ORDER = 700

/** 变量名。必须匹配 /^[a-z][a-z0-9_]*$/（dsh-system-prompt 的 VARIABLE_NAME）。 */
export const SESSION_VARIABLE = 'semantica_conversation'

/**
 * 「写入准则」这个变量。
 *
 * 为什么写入准则要是个**变量**而不是写死在段落里：面板上那个「每轮自动提取」开关是
 * **按会话**的，而且用户随时能改。段落正文是注册一次就固定的，变量则是**每次组装
 * 提示词时求值** —— 于是开关一翻，下一轮模型看到的规则就变了，不需要重启、也不需要
 * 重新注册任何东西。
 *
 * 关掉时这里给的是轻量规则（值得记的时候顺手记一条），打开时是「每轮必写」。
 */
export const DIRECTIVE_VARIABLE = 'semantica_directive'

/**
 * 段落正文。两个变量由 provider 每次组装时求值。
 *
 * 刻意写得短：这段进的是**每一个**会话的系统提示词，长一句就多一句的开销。
 * 规则本体放在 DIRECTIVE_VARIABLE 里（因为它要跟着开关变），这里只留固定的壳。
 */
export const SECTION_TEXT = [
	'【Semantica 知识图谱（本机 MCP 工具）】',
	'本会话挂着一张本机知识图谱，工具名以 `mcp__semantica__` 开头，用户可以在「知识图谱」面板里看到它。',
	`本会话的标识是 \`{{${SESSION_VARIABLE}}}\`。`,
	`{{${DIRECTIVE_VARIABLE}}}`,
].join('\n')

/**
 * 两个模式共用的硬约束 —— 都是上游接口决定的，不是偏好：
 *
 *   · add_entity / add_relationship 收 metadata，record_decision **不收**，所以决策的
 *     归属只能靠它 involves 的实体（插件顺着这条边走）；
 *   · 中文正文必须显式传 model="zh_core_web_sm"，否则 spaCy 的英文模型会把整句当成
 *     一个实体（实测过），图会废掉。
 *
 * @param sessionId 当前会话 id。
 */
function rules(sessionId) {
	return [
		`写入时必须带上会话标识：add_entity(id, label, type, metadata={"conversation": "${sessionId}"})、`,
		`add_relationship(source, target, type, metadata={"conversation": "${sessionId}"})。`,
		'抽取用 extract_entities / extract_relations（中文正文要传 model="zh_core_web_sm"，否则中文会被切错），',
		'再把结果用 add_entity / add_relationship 写进去；id 用可读且稳定的字符串，不要随机串。',
		'用户确认过的选择用 record_decision 记录：category 填问题标题、scenario 填背景、reasoning 填依据、',
		'outcome 填用户选了什么、confidence=1.0、decision_maker="user"，并且**必须**把相关节点 id 放进 entities',
		'—— 决策没有 metadata，它靠这些实体边归属到本会话。',
	]
}

/**
 * 写入准则正文。这是「每轮自动提取」开关真正作用的地方。
 *
 * @param sessionId 当前会话 id。
 * @param auto 该会话的开关状态。
 */
export function directiveFor(sessionId, auto) {
	return [
		auto
			? '【本会话已开启「每轮写入」】**每一轮回复结束前都必须**把这一轮新产生的知识写进图谱 ——' +
					'至少一条 add_entity 或 record_decision，不要等用户要求，也不要攒到最后一起写。' +
					'本轮没有新知识时（纯闲聊、纯查询）可以不写，但不要因为「看起来不重要」就跳过。'
			: '这场对话里产生的、以后还要复用的知识，应该写进这张图，而不是只留在聊天记录里。' +
					'什么时候写：用户明确要求时立刻写；得出可复用的结论、定下方案或约定时顺手写一条。',
		...rules(sessionId),
		'琐碎内容不要建节点，写之前可以先用 query_graph 查一下是不是已经有了。',
	].join('\n')
}

/**
 * 渲染好的指令正文（给面板上「复制提取指令」按钮用）。
 *
 * 和系统提示词里那段是同一件事，只是把变量替换成了具体会话 id —— 用户可以把这段
 * 直接粘进对话里，让模型当场把这场对话抽一遍，不必等它自己想起来。
 *
 * @param sessionId 当前会话 id。
 */
export function instructionFor(sessionId) {
	return [
		'把这次对话的知识写进 Semantica 知识图谱（用 mcp__semantica__ 开头的工具）：',
		`1. 本会话标识是 ${sessionId}，add_entity / add_relationship 都要带上 metadata={"conversation": "${sessionId}"}。`,
		'2. 先 extract_entities / extract_relations 抽（中文传 model="zh_core_web_sm"），再用 add_entity / add_relationship 写入；id 用可读稳定的字符串。',
		'3. 我确认过的选择用 record_decision 记录（category/scenario/reasoning/outcome/confidence=1.0/decision_maker="user"），entities 里放相关节点 id。',
		'4. 只写值得以后复用的东西，不要为琐碎内容建节点。',
	].join('\n')
}
