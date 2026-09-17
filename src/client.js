// src/client.js
//
// dsh-semantica-graph 的浏览器半侧。
//
// 两个贡献点：
//   1. 「会话头部动作区」的图表按钮（与官方 jobs 插件同槽位，order 控制并列顺序）
//   2. 两个 BetterSidebar tab：控制面板（进度/统计/错误）与 Explorer 界面本身
//
// 图的界面**不在这里**。它由 semantica 自带的 Knowledge Explorer 提供，
// 本插件只负责把它拉起来、然后内嵌进侧边栏。
// 这样功能上限就等于上游（6 个 workspace、78 个 /api 路由），而不是自绘一个子集。
//
// 内嵌走的是插件自己渲染的 iframe（ExplorerFrame），
// 而不是 better-sidebar 的 'browser' tab —— 后者壳里有一条删不掉的状态行。
// 详见 EXPLORER_IFRAME_SANDBOX 的注释。
//
// 因此客户端只依赖 react（在基座冻结表里），不需要内联任何第三方库，
// 也就不需要构建步骤 —— 这个文件就是实际加载的产物。

window.__ModuleLoader__.load({
	id: "dsh-semantica-graph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useRef, useCallback } = react;

		/** 控制面板的 tab 类型。 */
		const TAB_TYPE = "semantica:launcher";
		const NS = "semantica-graph";

		/**
		 * 内嵌 Explorer 用的 iframe sandbox。
		 *
		 * 为什么不用 better-sidebar 的 browser tab（它的壳里有一条删不掉的
		 * 「沙箱模式：已启用」状态行 —— SandboxStatusBar 是无条件渲染的，
		 * 且没有任何隐藏设置；关掉沙箱只是把绿杠换成红杠）：
		 * 自己渲染 iframe 就没有那层壳，也不再需要用户去配
		 * browserAllowedLoopback 允许清单。
		 *
		 * 这一串就是 better-sidebar 给「已放行的回环地址」用的那串，逐字相同：
		 *   - allow-same-origin 必须有：没有它 iframe 是 opaque origin，
		 *     Explorer 这种 React SPA 的模块脚本与 fetch 会跑不起来（实测白屏：
		 *     非白像素 0.1%，而带它时是 100%）。
		 *   - 刻意**不含** allow-top-navigation：页面因此无法把主窗口导航走。
		 *   - 也不含 allow-popups-to-escape-sandbox 之外的放宽项。
		 *
		 * 安全性说明：Explorer 跑在 127.0.0.1:<另一个端口>，与 GUI 端口不同，
		 * 所以它**仍是跨源**的 —— 拿不到 GUI 的 DOM、Cookie 与内部接口。
		 * 不配允许清单不代表没有隔离。
		 */
		const EXPLORER_IFRAME_SANDBOX =
			"allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox allow-same-origin";

		// ───────────────────────────── 文案 ─────────────────────────────

		const zh = {
			"action.title": "对话知识图谱",
			"action.label": "知识图谱",
			"action.aria": "用 Semantica 查看当前对话的知识图谱",
			"tab.title": "知识图谱",
			"state.working": "正在用 Semantica 抽取实体与关系…",
			"state.workingHint": "首次运行要加载模型，大约十几秒到半分钟。",
			"state.empty": "这个对话还没有可抽取的内容。",
			"error.title": "无法生成图谱",
			"error.retry": "重试",
			"error.detail": "详情",
			"action.refresh": "重新抽取",
			"stat.nodes": "节点",
			"stat.edges": "边",
			"stat.entities": "实体",
			"stat.relations": "关系",
			"stat.took": "耗时",
			"engine.label": "引擎",
			"note.stale": "会话此后又有新内容，这张图是旧的。",
			"note.staleShort": "图已过期",
			"path.tip": "点击复制完整路径（这张图落盘的 JSON 文件）",
			"path.copied": "已复制",
			"path.failed": "复制失败，请手动选中",
			"action.dismiss": "关掉这条提示",
			"state.emptyHint": "还没有图。点「重新抽取」开始。",
			"action.external": "在浏览器打开",
			"state.loading": "正在载入 Explorer…",
						"note.api": "Explorer 的 REST API",
			"note.explorer": "上游 Explorer",
			// 四个按钮只有 title 提示，所以「会新开一个对话」这件事必须写进 tooltip，
			// 否则用户点下去才发现跳到别处了。
			"analyze.tip": "会新开一个对话，先把这张图的数据注入进去，再让 AI 分析。",
			"analyze.retro": "复盘这次对话",
			"analyze.structure": "理解图数据",
			"analyze.quality": "检验抽取质量",
			"analyze.advice": "给当前任务的建议",
			"analyze.working": "正在开新对话…",
			"analyze.done": "已开新对话：",
			"analyze.manual": "没能自动切过去，去会话列表里找它就行。",
			"analyze.noDigest": "图数据没能注入，这个对话只有提问。",
			"analyze.noDrill": "图服务没起来，这次只能基于静态摘要分析。",
			"analyze.needPrepare": "请先点「重新抽取」把图建出来。",
		};

		const en = {
			"action.title": "Conversation knowledge graph",
			"action.label": "Knowledge graph",
			"action.aria": "Explore this conversation's knowledge graph with Semantica",
			"tab.title": "Knowledge graph",
			"state.working": "Extracting entities and relations with Semantica…",
			"state.workingHint": "The first run loads the models; expect up to half a minute.",
			"state.empty": "Nothing extractable in this conversation yet.",
			"error.title": "Could not build the graph",
			"error.retry": "Retry",
			"error.detail": "Details",
			"action.refresh": "Re-extract",
			"stat.nodes": "Nodes",
			"stat.edges": "Edges",
			"stat.entities": "Entities",
			"stat.relations": "Relations",
			"stat.took": "Took",
			"engine.label": "Engine",
			"note.stale": "The conversation has grown since; this graph is stale.",
			"note.staleShort": "Stale",
			"path.tip": "Click to copy the full path of the graph file on disk",
			"path.copied": "Copied",
			"path.failed": "Copy failed — select it manually",
			"action.dismiss": "Dismiss this notice",
			"state.emptyHint": "No graph yet — press “Re-extract” on the right to build one.",
			"action.external": "Open in browser",
			"state.loading": "Loading the Explorer…",
			"note.api": "Explorer REST API",
			"note.explorer": "Upstream Explorer",
			"analyze.tip": "Opens a new conversation, seeds it with this graph, then asks the AI to analyse it.",
			"analyze.retro": "Review this conversation",
			"analyze.structure": "Understand the graph",
			"analyze.quality": "Check extraction quality",
			"analyze.advice": "Advise on my current task",
			"analyze.working": "Opening a new conversation…",
			"analyze.done": "New conversation created:",
			"analyze.manual": "Could not switch to it automatically — find it in the session list.",
			"analyze.noDigest": "The graph data could not be injected; this conversation has only the question.",
			"analyze.noDrill": "The graph service is not running, so this run is summary-only.",
			"analyze.needPrepare": "Press “Re-extract” first to build the graph.",
		};

		/** 当前语言对应的字典；ctx.locale 变化时由 rebind() 换掉。 */
		let dict = zh;
		function T(key) {
			return dict[key] ?? zh[key] ?? key;
		}

		// ───────────────────────────── 样式 ─────────────────────────────

		const CSS = `
.semg-panel{display:flex;flex-direction:column;gap:12px;padding:14px;font-size:12px;line-height:1.6;height:100%;box-sizing:border-box;overflow:auto}
.semg-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px}
/* 进行中的面板：spinner、标题、提示竖排，整块在面板里垂直+水平居中。
   text-align 是给换行的提示文案用的 —— 不写它居中只对行盒生效，
   第二行提示会左对齐，看着像没居中。 */
.semg-busy{justify-content:center;align-items:center;text-align:center}
.semg-busy-title{font-weight:600;font-size:13px}
.semg-muted{color:var(--dsw-alias-label-secondary,#888)}
.semg-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.semg-card{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04))}
.semg-card b{display:block;font-size:17px;font-weight:600;line-height:1.3}
.semg-card span{font-size:10px;color:var(--dsw-alias-label-secondary,#888)}
.semg-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.semg-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.semg-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.semg-btn[data-primary="1"]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.semg-btn:disabled{opacity:.45;cursor:default}
.semg-spin{width:18px;height:18px;border:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);border-radius:50%;animation:semg-spin .8s linear infinite;flex:0 0 auto}
@keyframes semg-spin{to{transform:rotate(360deg)}}
.semg-err{color:var(--dsw-alias-state-error-primary,#d33);font-weight:600}
.semg-box{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));border-left:3px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}
.semg-box[data-kind="error"]{border-left-color:var(--dsw-alias-state-error-primary,#d33)}
.semg-box[data-kind="warn"]{border-left-color:#e8a33d}
.semg-box[data-kind="ok"]{border-left-color:#3aa76d}
/* ── 控制面板：工具栏 + 内嵌 Explorer 拼成一页 ── */
.semg-split{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;box-sizing:border-box}
.semg-toolbar{display:flex;flex-direction:column;gap:6px;padding:8px 10px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}
.semg-toolbar-top{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap}
.semg-toolbar-info{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;flex:0 1 auto}
/* flex:0 0 auto 在这里是安全的：它只放几个图标按钮，宽度不会超过容器 */
.semg-toolbar-util{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:0 0 auto;margin-left:auto}
/* 这一行**必须**能收缩：flex-basis 取 auto 会让它按内容宽度（约 380px）撑开，
   于是内部的 flex-wrap 永远不触发，窄面板里直接横向溢出。 */
/* 第二行：左边四个分析按钮，右边图谱/视图控制。 */
.semg-toolbar-bottom{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;min-width:0}
.semg-toolbar-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:0 1 auto;min-width:0}
.semg-mini{display:inline-flex;align-items:baseline;gap:3px;white-space:nowrap}
.semg-mini b{font-weight:600;font-size:12px;font-variant-numeric:tabular-nums}
.semg-mini span{font-size:10px;color:var(--dsw-alias-label-secondary,#888)}
.semg-tag{font-size:12px;line-height:18px;padding:0 7px;border-radius:999px;background:rgba(232,163,61,.16);color:#b57517;white-space:nowrap}
/* 图文件路径。整条路径约 100 字符，工具栏放不下，所以显示的是省略形式（完整值在
   title 里，复制的也是完整值）。min-width:0 + overflow:hidden 让它能被压缩 ——
   否则它自己不收缩，会把 .semg-toolbar-info 顶出容器。 */
.semg-path{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:inherit;font:inherit;cursor:pointer;overflow:hidden}
.semg-path:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.semg-path code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.semg-path[data-state="copied"]{border-color:#3aa76d;color:#3aa76d}
.semg-path[data-state="failed"]{border-color:var(--dsw-alias-state-error-primary,#d33);color:var(--dsw-alias-state-error-primary,#d33)}
.semg-sep{width:1px;height:16px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));margin:0 2px}
.semg-spin-sm{width:11px;height:11px;border-width:1.5px}
.semg-banner{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03))}
.semg-banner[data-kind="error"]{background:rgba(221,51,51,.07)}
.semg-banner[data-kind="ok"]{background:rgba(58,167,109,.07)}
.semg-banner-text{flex:1 1 auto;min-width:0}
.semg-banner-x{flex:0 0 auto;border:none;background:transparent;color:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:.5;padding:0 2px}
.semg-banner-x:hover{opacity:1}
.semg-empty{display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:var(--dsw-alias-label-secondary,#888)}
.semg-code{margin-top:6px;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-word;text-align:left}
/* 头部入口按钮。尺寸整套抄 DSH 自己在这个 slot 里的带字元素
   （@deepseek-ai/dsh-client-ui-agent-preset 的 AgentPresetLabel）：
   height 22 / radius 6 / fill-tsp-secondary / font-size 12 / gap 4 / 图标 14 且 opacity .7。
   照抄是为了它坐在 .headerActions 里不像个外来物 —— 那一排是 flex:none，
   宽度由内容决定，样式不统一就会一眼看出来。
   注意这里能带文案的余量是有限的：.headerActions 是 flex:none，而 .titleCluster
   是 flex:1;min-width:0 —— 也就是说这个按钮每宽 1px，标题就少 1px（标题会走省略号）。
   所以文案取短、给 max-width，不用「对话知识图谱」那种全称（那个留给 title）。 */
.semg-action{display:inline-flex;align-items:center;gap:4px;height:22px;max-width:180px;padding:0 8px;border-radius:6px;border:none;background:var(--dsw-alias-fill-tsp-secondary,rgba(0,0,0,.045));color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;line-height:22px;white-space:nowrap;cursor:pointer;overflow:hidden}
.semg-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07));color:var(--dsw-alias-label-primary,#222)}
.semg-action-icon{opacity:.7;flex:none}
.semg-action-text{overflow:hidden;text-overflow:ellipsis}
.semg-viewbody{position:relative;flex:1 1 auto;min-height:0}
.semg-viewbody iframe{display:block;width:100%;height:100%;border:0}
.semg-viewload{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;pointer-events:none;color:var(--dsw-alias-label-secondary,#888);font-size:12px}
`;

		let styleInjected = false;
		function ensureStyles() {
			if (styleInjected || typeof document === "undefined") return;
			styleInjected = true;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-semantica-graph";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ───────────────────────────── 图标 ─────────────────────────────

		function IconGraph(props) {
			const size = (props && props.size) || 16;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					className: props && props.className,
				},
				h("circle", { cx: 8, cy: 2.6, r: 1.9, fill: "currentColor" }),
				h("circle", { cx: 2.7, cy: 12.4, r: 1.9, fill: "currentColor" }),
				h("circle", { cx: 13.3, cy: 12.4, r: 1.9, fill: "currentColor" }),
				h("path", {
					d: "M8 4.5 3.4 10.7M8 4.5l4.6 6.2M4.4 12.9h7.2",
					stroke: "currentColor",
					// React 要求 SVG 属性用 camelCase；写成 kebab-case 每次渲染
					// 都会刷 "Invalid DOM property `stroke-width`" 警告。
					strokeWidth: "1.2",
					strokeLinecap: "round",
					opacity: "0.75",
				}),
			);
		}

		/**
		 * 复制图标（两个错位的方框）。
		 *
		 * 用它而不是文件图标：这个 chip 的**动作**是复制，不是"打开文件" ——
		 * 图标要提示点击之后会发生什么。
		 */
		function IconCopy(props) {
			const size = (props && props.size) || 16;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					className: props && props.className,
				},
				h("rect", {
					x: 5.6, y: 5.6, width: 8.2, height: 8.2, rx: 1.6,
					stroke: "currentColor", strokeWidth: "1.3",
				}),
				h("path", {
					d: "M10.4 5.4V3.8c0-.9-.7-1.6-1.6-1.6H3.8c-.9 0-1.6.7-1.6 1.6v5c0 .9.7 1.6 1.6 1.6h1.6",
					stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round",
				}),
			);
		}

		/**
		 * 外链图标：一个开口的方框，一支箭头从右上角射出去。
		 *
		 * 换掉了原来的「↗」。单独一个斜箭头在 UI 里至少有四种读法（分享 / 上传 /
		 * 跳转 / 放大），配上「重新打开」「在浏览器打开」两个只有 hover 才出提示的图标，
		 * 根本猜不出哪个是哪个。「方框 + 外射箭头」是「开去别处」的通用画法，不用猜。
		 */
		function IconExternal(props) {
			const size = (props && props.size) || 16;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					className: props && props.className,
				},
				h("path", {
					d: "M9.8 3.2H4A1.7 1.7 0 0 0 2.3 4.9v7A1.7 1.7 0 0 0 4 13.6h7a1.7 1.7 0 0 0 1.7-1.7V6.2",
					stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round",
				}),
				h("path", {
					d: "M6.9 9.1 13.5 2.5",
					stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round",
				}),
				h("path", {
					d: "M9.9 2.5h3.6v3.6",
					stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round",
				}),
			);
		}

		/** 复制成功的对勾。 */
		function IconCheck(props) {
			const size = (props && props.size) || 16;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					className: props && props.className,
				},
				h("path", {
					d: "M3 8.4 6.3 11.7 13 5",
					stroke: "currentColor", strokeWidth: "1.7",
					strokeLinecap: "round", strokeLinejoin: "round",
				}),
			);
		}

		// ─────────────────────────── 与宿主通信 ───────────────────────────

		async function postJson(path, body) {
			const resp = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const text = await resp.text();
			try {
				return JSON.parse(text);
			} catch {
				return { ok: false, error: `响应不是 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}` };
			}
		}

		/**
		 * 让宿主把图建好、把 Explorer 拉起来，返回它的 URL。
		 * @param refresh 为 true 时忽略缓存，强制重新抽取
		 */
		function prepare(sessionId, refresh) {
			return postJson("/api-semantica/prepare", { sessionId, refresh: refresh === true });
		}

		/**
		 * 让宿主新开一个子会话，把图数据注进去让 AI 分析。
		 *
		 * kind 是四种分析之一：retro / structure / quality / advice。
		 * 返回 `{ ok:true, sessionId, label, digestChars, injected, drillable }`，
		 * 失败时 `ok:false` 且带 code —— 宿主侧的 code 有
		 * session-controller-unavailable / parent-not-live / create-failed
		 * / prompt-failed / graph-missing / unknown-kind，以及 prepare 那一串。
		 */
		function analyze(sessionId, kind) {
			return postJson("/api-semantica/analyze", { sessionId, kind });
		}

		/** 四个分析按钮的 kind 与文案 key。 */
		const ANALYZE_KINDS = [
			["retro", "analyze.retro"],
			["structure", "analyze.structure"],
			["quality", "analyze.quality"],
			["advice", "analyze.advice"],
		];

		// ─────────────────────── 侧边栏（better-sidebar） ───────────────────────


		// ─────────────────── 跳到某个会话（新对话用） ───────────────────

		/**
		 * sessions 服务句柄。走延迟注入（`ctx.inject(["sessions"], …)`）而不是
		 * 写进 `inject` 数组 —— 后者是硬依赖，服务缺席时整个插件加载不起来。
		 * 参考 `dsh-client-ui-workflow-run` 的用法，官方就是 `ctx.sessions.open(id)`。
		 */
		let sessionsSvc = null;

		/**
		 * 把界面切到某个会话。成功返回 true。
		 * 失败只是不跳转，不影响已经建好的对话 —— 用户自己在列表里也能找到。
		 */
		function openSession(id) {
			if (!sessionsSvc || typeof sessionsSvc.open !== "function") return false;
			try {
				sessionsSvc.open(id);
				return true;
			} catch (e) {
				console.warn("[semantica-graph] sessions.open 失败", e);
				return false;
			}
		}



		// ───────────────────────── 头部动作按钮 ─────────────────────────

		function GraphButton(props) {
			ensureStyles();
			const sessionId = props.sessionId;
			const open = props.openPanel;
			const onClick = useCallback(() => {
				if (typeof open === "function") open(sessionId);
			}, [open, sessionId]);
			return h(
				"button",
				{
					type: "button",
					className: "semg-action",
					title: T("action.title"),
					"aria-label": T("action.aria"),
					onClick,
				},
				h(IconGraph, { size: 14, className: "semg-action-icon" }),
				h("span", { className: "semg-action-text" }, T("action.label")),
			);
		}

		// ───────────────────────── 控制面板 tab ─────────────────────────

		/**
		 * 工具栏里的一个统计项，例如「2186 节点」。
		 *
		 * 以前是 2×2 的大卡片（`semg-card`），挪进工具栏之后必须紧凑 ——
		 * 数字用等宽数字（tabular-nums）以免位数变化时左右跳。
		 */
		function MiniStat(labelKey, value) {
			return h(
				"span",
				{ className: "semg-mini", key: labelKey },
				h("b", null, String(value ?? "—")),
				h("span", null, T(labelKey)),
			);
		}

		/** 中间省略：`session-c4f2f73e-08ac-…-f5b740.json` 这种，两头都保留。 */
		function elideMiddle(text, max) {
			if (!text || text.length <= max) return text || "";
			const keep = max - 1;
			const head = Math.ceil(keep / 2);
			const tail = keep - head;
			return text.slice(0, head) + "\u2026" + (tail > 0 ? text.slice(text.length - tail) : "");
		}

		/** 目录只留最后一级 + 中间省略的文件名 —— 完整路径放不进工具栏。 */
		function shortenGraphPath(p) {
			if (!p) return "";
			const i = p.lastIndexOf("/");
			if (i < 0) return elideMiddle(p, 48);
			const dirTail = p.slice(0, i).split("/").filter(Boolean).slice(-1)[0] || "";
			return "\u2026/" + dirTail + "/" + elideMiddle(p.slice(i + 1), 30);
		}

		/**
		 * 图文件的落盘路径，点一下复制完整路径。
		 *
		 * 为什么要显示：这张图就是插件写到磁盘上的一个普通 JSON 文件。用户想自己拿去看
		 * （编辑器打开、丢给别的工具、备份、对比两次抽取）是很自然的事，但之前路径在界面上
		 * 完全不可见，只能去翻文档猜。
		 *
		 * 复制的是完整值，显示的才是省略值 —— 点一下拿到的必须是能直接 cd 过去的那种。
		 */
		function PathChip(props) {
			const graphPath = props.path;
			const [state, setState] = useState("idle"); // idle | copied | failed
			const timer = useRef(0);

			const flash = useCallback((next) => {
				setState(next);
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => setState("idle"), 1600);
			}, []);

			const copy = useCallback(() => {
				const fallback = () => {
					// navigator.clipboard 在非安全上下文里是 undefined；127.0.0.1 算安全上下文，
					// 但 GUI 有可能被挂到别的 host 上，所以留一条退路。
					try {
						const ta = document.createElement("textarea");
						ta.value = graphPath;
						ta.setAttribute("readonly", "");
						ta.style.position = "fixed";
						ta.style.top = "-1000px";
						ta.style.opacity = "0";
						document.body.appendChild(ta);
						ta.select();
						const ok = document.execCommand("copy");
						document.body.removeChild(ta);
						flash(ok ? "copied" : "failed");
					} catch (e) {
						flash("failed");
					}
				};
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(graphPath).then(
							() => flash("copied"),
							() => fallback(),
						);
						return;
					}
				} catch (e) {
					/* 落到 fallback */
				}
				fallback();
			}, [graphPath, flash]);

			useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

			if (!graphPath) return null;
			const label =
				state === "copied" ? T("path.copied") : state === "failed" ? T("path.failed") : null;
			return h(
				"button",
				{
					type: "button",
					className: "semg-path",
					"data-state": state,
					title: T("path.tip") + "\n" + graphPath,
					onClick: copy,
				},
				h(state === "copied" ? IconCheck : IconCopy, { size: 12 }),
				h("code", null, label || shortenGraphPath(graphPath)),
			);
		}

		// ────────────────────────── 侧边栏宽度 ──────────────────────────
		//
		// 图谱视图是个完整的 web app（Explorer 自己还有一条左侧栏），在
		// better-sidebar 的出厂宽度下根本铺不开 —— 出厂值是「窗口宽度的 35%」，
		// 1380px 的窗口就是 483px，而 Explorer 的左栏就吃掉约 240px。
		//
		// 这几个常量是 better-sidebar 的契约值，抄过来照原样用：
		//   PANEL_MIN        = 280   （约束下限）
		//   NARROW_MAX_WIDTH = 768   （低于它就是全屏抽屉模式，见 breakpoints.ts）
		// 另外别被 state.ts 里的 PANEL_MAX = 640 骗了 —— 它只在 window 不存在的
		// 时候当兜底；真正生效的上限是 window.innerWidth。
		const PANEL_FLOOR = 280;
		const PANEL_NARROW = 768;
		/**
		 * 我们想要的宽度：够 Explorer 铺开，又不至于把对话区挤没。
		 *
		 * 640 不是拍脑袋来的，是实测的临界值：路径 chip 宽约 359px，只有面板到 640px
		 * 它才能和四个统计数字挤在同一行。600px 差 40px 落在换行那一侧 —— chip 一换行，
		 * 工具栏从 68px 涨到 94px，图区白白少 26px。代价是对话区从 780px 减到 740px。
		 */
		const PANEL_COMFORT = 640;

		/**
		 * 目标宽度；窄到进抽屉模式时返回 null（那种情况面板铺满窗口，
		 * 动 width 没有意义，反而会把持久化的值改坏）。
		 */
		function comfortPanelWidth() {
			const vw =
				typeof window !== "undefined" && Number.isFinite(window.innerWidth)
					? window.innerWidth
					: 0;
			if (vw < PANEL_NARROW) return null;
			// 镜像 better-sidebar 的 setWidth 钳制：下限贴 PANEL_MIN，上限贴视口。
			return Math.min(Math.max(PANEL_FLOOR, vw), Math.max(PANEL_FLOOR, PANEL_COMFORT));
		}

		/**
		 * 把侧边栏拉到能看的宽度。**只加宽，绝不回缩** —— 用户自己拖宽过就尊重他。
		 *
		 * 走的是 tab 组件拿到的 better-sidebar store（Sidebar.tsx 把它作为 prop
		 * 传给每个 tab 组件），因为公开的 `ctx.betterSidebar` 服务没有宽度方法，
		 * `OpenTabSeed` 里也没有宽度字段。`store.reduce` 会一并写
		 * `dsh-sidebar:v1:width`，所以这个宽度对所有对话生效。
		 *
		 * 加宽纯粹是体验优化，任何一步不成立就直接放弃 —— 绝不能因为这个把面板搞崩。
		 */
		function widenPanel(store) {
			try {
				if (
					!store ||
					typeof store.getSnapshot !== "function" ||
					typeof store.reduce !== "function"
				) {
					return false;
				}
				const target = comfortPanelWidth();
				if (target === null) return false;
				const snap = store.getSnapshot();
				const state = snap && snap.state;
				if (!state || typeof state.width !== "number") return false;
				if (state.width >= target) return false;
				const before = state.width;
				store.reduce((prev) => ({ ...prev, width: target }));
				console.info(
					"[semantica-graph] 侧边栏 " + before + "px → " + target + "px（图谱视图需要更宽）",
				);
				return true;
			} catch (e) {
				console.warn("[semantica-graph] 加宽侧边栏失败", e);
				return false;
			}
		}

		function LauncherView(props) {
			ensureStyles();
			const ctx = props.ctx;
			const store = props.store;
			const visible = props.visible !== false;
			const sessionId =
				props.sessionId || (props.scope && props.scope.sessionId) || null;

			const [phase, setPhase] = useState("idle"); // idle | working | ready | error
			const [stats, setStats] = useState(null);
			const [url, setUrl] = useState(null);
			const [err, setErr] = useState(null);
			const [stale, setStale] = useState(false);
			// AI 分析：哪个按钮在跑（null = 没跑），以及上一次的结果
			const [busyKind, setBusyKind] = useState(null);
			const [analysis, setAnalysis] = useState(null);
			const startedFor = useRef(null);
			// 每次「收起 → 展开」只检查一次宽度。收起时重置，所以下次打开会再看一眼；
			// 展开期间不重复触发，用户拖到哪儿就是哪儿，不会跟他抢。
			const widthChecked = useRef(false);

			const run = useCallback(
				async (refresh) => {
					if (!sessionId) {
						setErr({ error: "拿不到 sessionId" });
						setPhase("error");
						return;
					}
					setPhase("working");
					setErr(null);
					try {
						const data = await prepare(sessionId, refresh);
						if (!data || data.ok !== true) {
							setErr(data || { error: "宿主没有返回结果" });
							setPhase("error");
							return;
						}
						setStats(data.stats || null);
						setUrl(data.url || null);
						setStale(data.stale === true);
						setPhase("ready");
						// 刻意**不自动打开 Explorer 标签**。
						//
						// 更早的版本在这里直接切到 Explorer 界面，理由是「用户点按钮就是为了看图」。
						// 但那会把刚打开的控制面板顶掉：
						// 第一次点头部图标 → 面板刚出现就被 Explorer 替换 → 用户看到
						// 的是 semantica 的界面，面板底部的四个分析按钮压根没机会被看到
						// （得再点一次图标才回得来）。
						//
						// 现在面板留在原处，要看图点「打开完整 Explorer」那个主按钮。
					} catch (e) {
						setErr({ error: String((e && e.message) || e) });
						setPhase("error");
					}
				},
				[ctx, sessionId],
			);

			// 面板可见时才干活（隐藏时不浪费 CPU），每个会话只自动跑一次
			// 图谱面板一展开，就把侧边栏拉到一个能看的宽度。放在这里而不是启动流程里，
			// 是因为「打开图谱」既可能是点标题旁的按钮，也可能是切回这个 tab ——
			// 两者都会让 visible 变 true，而用户要的是「看到图的时候宽度是够的」。
			useEffect(() => {
				if (!visible) {
					widthChecked.current = false;
					return;
				}
				if (widthChecked.current) return;
				widthChecked.current = true;
				widenPanel(store);
			}, [visible, store]);

			useEffect(() => {
				if (!visible) return;
				if (startedFor.current === sessionId) return;
				startedFor.current = sessionId;
				run(false);
				return;
			}, [visible, sessionId, run]);

			// 收起时清掉「这个会话已经 prepare 过」的标记，下次展开重来一次。
			//
			// 这不是多余的一次 IPC：Semantica 的 Explorer 闲置约 10 分钟会自己死掉，
			// 那时面板里的 iframe 就一直是一张连不上的页面。重新 prepare 会让宿主
			// 发现 worker 没了、重拉一个，拿到新端口 → url 变了 → iframe 重挂，自愈。
			//
			// 不会闪：渲染里 `phase === "working" && !url` 才显示加载态，已经有 url
			// 时旧的图留在原地（见 LauncherView 的 return）。
			//
			// 以前这件事靠工具栏那个「刷新」按钮，按钮删了，改成本地自动做。
			useEffect(() => {
				if (!visible) startedFor.current = null;
			}, [visible]);

			// — 开子会话让 AI 分析 —
			//
			// 刻意**不复用 phase**：分析失败不该把整个面板打成错误页（图还好好的），
			// 所以结果单独放 analysis，内联显示在按钮下面。
			const runAnalyze = useCallback(
				async (kind) => {
					if (!sessionId) return;
					setBusyKind(kind);
					setAnalysis(null);
					try {
						const data = await analyze(sessionId, kind);
						const result = data || { ok: false, error: "宿主没有返回结果" };
						// 成功就直接切过去。用户要的是「开新对话」，不是留在原地面板
						// 上看一行「已创建」——那样还得自己去列表里找。
						if (result.ok === true && result.sessionId) {
							result.navigated = openSession(result.sessionId);
						}
						setAnalysis(result);
					} catch (e) {
						setAnalysis({ ok: false, error: String((e && e.message) || e) });
					} finally {
						setBusyKind(null);
					}
				},
				[sessionId],
			);

			// — 全屏的进行中 / 出错 —
			//
			// **只在还没有图的时候**占满整块。已经画出图之后再点「重新抽取」，
			// 不该把图换成一块 spinner —— 工具栏里转个小圈就够了（见下面）。
			if (phase === "working" && !url) {
				return h(
					"div",
					{ className: "semg-panel semg-busy" },
					h("div", { className: "semg-spin" }),
					h("div", { className: "semg-busy-title" }, T("state.working")),
					h("div", { className: "semg-muted" }, T("state.workingHint")),
				);
			}

			if (phase === "error" && !url) {
				const hint = err && err.hint;
				const code = err && err.code;
				return h(
					"div",
					{ className: "semg-panel" },
					h("div", { className: "semg-head semg-err" }, T("error.title")),
					h(
						"div",
						{ className: "semg-box", "data-kind": "error" },
						h("div", null, (err && err.error) || "未知错误"),
						code ? h("div", { className: "semg-muted" }, `code: ${code}`) : null,
					),
					hint ? h("div", { className: "semg-code" }, hint) : null,
					h(
						"div",
						{ className: "semg-row" },
						h(
							"button",
							{ type: "button", className: "semg-btn", onClick: () => run(true) },
							T("error.retry"),
						),
					),
				);
			}

			// — 就绪（或还没开始）—
			//
			// **一个页面**：上面是工具栏（左边基本信息、右边按钮），下面是整块
			// Explorer。以前这里是两个标签页 —— 先看信息页，再手动点开图 ——
			// 反馈是「太粗暴了」，确实：信息和图本来就该一起看。
			//
			// 布局靠 semg-split：工具栏 flex:0 0 auto（高度自适应），
			// ExplorerFrame 的 semg-viewbody 是 flex:1 1 auto 吃掉剩下的高度，
			// 所以图总是撑满、不会被工具栏挤没。
			const engineLine =
				stats && stats.elapsed != null
					? `${T("stat.took")} ${Number(stats.elapsed).toFixed(1)}s · ` +
						`semantica ${stats.engine && stats.engine.semantica ? stats.engine.semantica : "?"} / ` +
						`Python ${stats.engine && stats.engine.python ? stats.engine.python : "?"}`
					: null;

			// 结果提示条。成功且已经跳过去了就没什么好说的 —— 用户已经在新对话里。
			let banner = null;
			if (analysis && !(analysis.ok === true && analysis.navigated === true)) {
				const good = analysis.ok === true;
				let body;
				if (good) {
					body = [
						T("analyze.done") + " ",
						h("b", { key: "label" }, analysis.label || analysis.sessionId || ""),
						analysis.navigated === false
							? h("div", { key: "manual", className: "semg-muted" }, T("analyze.manual"))
							: null,
						analysis.injected === false
							? h("div", { key: "nodigest", className: "semg-muted" }, T("analyze.noDigest"))
							: null,
						analysis.drillable === false
							? h("div", { key: "nodrill", className: "semg-muted" }, T("analyze.noDrill"))
							: null,
					];
				} else {
					body = analysis.code === "graph-missing" ? T("analyze.needPrepare") : analysis.error || "未知错误";
				}
				banner = h(
					"div",
					{ className: "semg-banner", "data-kind": good ? "ok" : "error" },
					h("span", { className: "semg-banner-text" }, body),
					h(
						"button",
						{
							type: "button",
							className: "semg-banner-x",
							title: T("action.dismiss"),
							onClick: () => setAnalysis(null),
						},
						"×",
					),
				);
			}

			return h(
				"div",
				{ className: "semg-split" },

				// ————————————— 工具栏 —————————————
				//
				// 明确分成两行，不靠 flex-wrap 碰运气：
				//   第一行 —— 左边基本信息，右边工具按钮
				//   第二行 —— 四个分析按钮
				//
				// 一开始把八个按钮塞进同一个 flex-wrap 容器，实测在 320px 面板里横向
				// 溢出 315px：`.semg-toolbar-actions` 是 flex:0 0 auto，flex-basis 取的
				// 是内容宽度（625px），它自己不收缩，内部的 wrap 就永远不会触发。
				// 拆成两行、并让分析按钮那行撑满容器宽度，才不会溢出。
				h(
					"div",
					{ className: "semg-toolbar" },

					h(
						"div",
						{ className: "semg-toolbar-top" },

						// 第一行：只有基本信息。控制按钮全在第二行，所以这一行整行留给
					// 统计数字和路径 chip（完整路径有 55 字符，之前和按钮抢宽度会换行）。
						h(
							"div",
							{ className: "semg-toolbar-info", title: engineLine || undefined },
							h(IconGraph, { size: 14 }),
							stats
								? [
										MiniStat("stat.nodes", stats.nodes),
										MiniStat("stat.edges", stats.edges),
										MiniStat("stat.entities", stats.entities),
										MiniStat("stat.relations", stats.relations),
									]
								: h("span", { className: "semg-muted" }, T("state.empty")),
							stale
								? h("span", { className: "semg-tag", title: T("note.stale") }, T("note.staleShort"))
								: null,
							// 重新抽取：紧跟在过期标记右边。这两者是「同一条消息」的「症状 + 处理」——
							// 分开在两行里，看到「图已过期」的人还得自己去找补救按钮。
							// 它不看 stale 状态，永远显示：没有图的时候也靠它建第一张。
							h(
								"button",
								{
									type: "button",
									className: "semg-btn",
									title: T("action.refresh"),
									disabled: phase === "working",
									onClick: () => run(true),
								},
								phase === "working"
									? h("span", { className: "semg-spin semg-spin-sm" })
									: T("action.refresh"),
							),
							// 落盘路径。放在统计数字之后 —— 它和那几个数字一样是「这张图的元信息」，
							// 而不是操作。点一下复制完整路径。
							stats && stats.graphPath
								? h(PathChip, { key: "path", path: stats.graphPath })
								: null,
						),
					),

					// 第二行：左边四个分析按钮，右边图谱/视图控制。
					// 两组都是「操作」，用右对齐而不是竖线分隔 —— 加线反而像两个区块。
					h(
						"div",
						{ className: "semg-toolbar-bottom" },


						// 四个分析按钮
						h(
							"div",
							{ className: "semg-toolbar-actions" },
							ANALYZE_KINDS.map(([kind, key]) =>
								h(
									"button",
									{
										key,
										type: "button",
										className: "semg-btn",
										title: `${T(key)} — ${T("analyze.tip")}`,
										disabled: busyKind !== null || phase === "working",
										onClick: () => runAnalyze(kind),
									},
									busyKind === kind ? h("span", { className: "semg-spin semg-spin-sm" }) : T(key),
								),
							),
						),

						// 只剩一个「在浏览器打开」。
						//
						// 这里原本还有「刷新」（重挂 iframe、不重跑抽取）和「重新打开」。刷新删掉后
						// 面板内就没有手动重载入口了 —— 但那不是能力丢失：面板改成每次「收起 → 展开」
						// 都重新 prepare 一次，Explorer 挂掉时宿主会重拉 worker、换新端口，url 变了
						// iframe 自然重挂（见 LauncherView 里 startedFor 的注释）。
						//
						// 原本还有「重新打开」，在侧边栏另开一个整屏标签看图。那个按钮是它唯一的入口，
						// 删掉之后 ExplorerView / openExplorerTab 那套就彻底到不了了，一并删了 ——
						// 想恢复的话 git revert 这个提交就有，看大图用 ↗ 去浏览器。
						h(
							"div",
							{ className: "semg-toolbar-util" },
							url
								? h(
									"a",
									{
										className: "semg-btn",
										href: url,
										target: "_blank",
										rel: "noreferrer",
										title: T("action.external"),
									},
									h(IconExternal, { size: 14 }),
									T("action.external"),
								)
								: null,
						),
					),
				),

				banner,

				// ————————————— 图 —————————————
				url
					? h(ExplorerFrame, { url })
					: h(
							"div",
							{ className: "semg-viewbody semg-empty" },
							h("span", null, T("state.emptyHint")),
						),
			);
		}

		// ─────────────────── 内嵌的 Explorer（iframe） ───────────────────

		/**
		 * 把 Semantica 的 Explorer 界面装进一个 iframe，自带加载遮罩。
		 *
		 * 控制面板用它把「工具栏 + 图」拼成同一个页面 —— 以前这是两个标签页，
		 * 用户得先看信息页、再手动点开图。
		 *
		 * iframe 的 `key` 就是 url：换会话时 url 变了就重挂载。
		 * Explorer 是个 SPA，从外部没法调它的路由，只能整块重来。
		 * 重挂载后 onLoad 会再触发一次，所以加载遮罩也要跟着复位。
		 *
		 * @param props.url  Explorer 基址（空串则不渲染）
		 */
		function ExplorerFrame(props) {
			const url = props.url || "";
			const [loaded, setLoaded] = useState(false);

			// url 变了就把遮罩放回去，否则会一直显示上一张图
			useEffect(() => {
				setLoaded(false);
			}, [url]);

			return h(
				"div",
				{ className: "semg-viewbody" },
				loaded
					? null
					: h(
							"div",
							{ className: "semg-viewload" },
							h("div", { className: "semg-spin" }),
							h("span", null, T("state.loading")),
						),
				h("iframe", {
					key: url,
					src: url,
					title: T("tab.title"),
					sandbox: EXPLORER_IFRAME_SANDBOX,
					referrerPolicy: "no-referrer",
					onLoad: () => setLoaded(true),
				}),
			);
		}


		// ───────────────────────────── apply ─────────────────────────────

		/**
		 * 本插件依赖的服务。
		 *
		 * 这个数组**不能省**：Cordis 的 ctx 是服务代理，访问未在 inject 里声明的
		 * 服务属性会直接抛 `cannot get property "x" without inject` —— 插件根本
		 * 加载不起来（不是降级，是整个条目 apply 失败）。
		 *
		 * 这里需要的两个：
		 *   slots  —— ctx.slots.inject / register，向会话头部动作区注册按钮
		 *   locale —— 取当前语言决定用中文还是英文字典。注意快照上的字段是
		 *             **active**（不是 language/locale），详见下面 rebind 的注释
		 *
		 * 注：betterSidebar 刻意**不写进来**。它是可选且可能晚挂载的服务，
		 * 所以走 ctx.inject(["betterSidebar"], cb) 延迟注入 + ctx.get() 安全读取，
		 * 缺席时不阻塞插件激活。
		 */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			// 绑定语言：locale 变化时换字典并重渲染
			//
			// 这里踩过一个坑，值得写清楚：locale 服务**没有 current() 方法**，
			// 快照上的字段也不叫 language / locale —— 它叫 **active**：
			//   dsh-client-locale 的 publish() → Object.freeze({ active, locales, revision })
			// 早先按 current()/language 去读，两处都取不到，lang 恒为 undefined，
			// 于是字典永远落到 en —— 中文界面下控制面板一直显示英文。
			// `locale/change` 事件本身是存在的（同一个 publish 里 ctx.emit），
			// 所以监听那行没问题，只有取值方式错了。
			let bound = false;
			function currentLangId() {
				try {
					const loc = ctx.get("locale");
					if (loc) {
						// getLocale() / getSnapshot() 给快照；兼容直接给字符串的实现
						const snap =
							typeof loc.getLocale === "function"
								? loc.getLocale()
								: typeof loc.getSnapshot === "function"
									? loc.getSnapshot()
									: loc;
						if (typeof snap === "string") return snap;
						// active 是官方字段；其余几个只是不同版本的兜底
						const id = snap && (snap.active ?? snap.language ?? snap.locale ?? snap.id);
						if (typeof id === "string" && id) return id;
					}
				} catch {
					// 落到下面的浏览器兜底
				}
				// 服务取不到时按浏览器语言猜 —— 总比把中文用户送进英文字典强
				try {
					if (typeof navigator !== "undefined" && navigator.language) {
						return navigator.language;
					}
				} catch {
					// 忽略
				}
				return "";
			}
			function rebind() {
				const id = String(currentLangId()).toLowerCase();
				dict = id.startsWith("zh") ? zh : en;
				bound = true;
			}
			rebind();
			ctx.on("locale/change", rebind);

			// —— 侧边栏服务桥：betterSidebar 可选且可能晚挂载 ——
			const bridge = {
				sidebar: null,
				open(sessionId) {
					const sb = bridge.sidebar;
					if (!sb || typeof sb.openTab !== "function") return false;
					try {
						// 带 path 作为「内容 seed」——better-sidebar 对 content open
						// 会自动展开承载它的面板，而纯 type open 不会。
						// path 只是个不透明标记，tab 组件不读它。
						sb.openTab(
							{ type: TAB_TYPE, title: T("tab.title"), path: `semantica:${sessionId}` },
							{ sessionId },
						);
						return true;
					} catch (err) {
						console.warn("[semantica-graph] openTab 失败", err);
						return false;
					}
				},
			};

			// 1) 头部动作按钮
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: "semantica-graph",
						order: 30,
						locale: NS,
						inject: () => ({
							openPanel: (sessionId) => bridge.open(sessionId),
						}),
					},
					GraphButton,
				),
			);

			// 2) sessions（只用来在新对话建好后跳过去）
			//
			// 和 betterSidebar 一样走延迟注入：它是可选服务，缺席时不应该拦下
			// 整个插件。拿不到就只是不自动跳转。
			ctx.inject(["sessions"], (sctx) => {
				const svc = sctx.get("sessions");
				if (svc && typeof svc.open === "function") sessionsSvc = svc;
			});

			// 3) 控制面板 tab
			ctx.inject(["betterSidebar"], (sctx) => {
				// 用 get() 而不是 sctx.betterSidebar —— 后者是服务属性访问，
				// 正是「cannot get property "x" without inject」的触发方式。
				// 回调只在服务就绪时执行，所以这里必然能取到。
				const sidebar = sctx.get("betterSidebar");
				if (!sidebar || typeof sidebar.registerTab !== "function") return;
				bridge.sidebar = sidebar;
				ctx.effect(() => {
					const disposeLauncher = sidebar.registerTab({
						id: TAB_TYPE,
						title: () => T("tab.title"),
						icon: (size) => h(IconGraph, { size: size || 16 }),
						order: 60,
						single: true,
						component: LauncherView,
					});
					return () => {
						bridge.sidebar = null;
						disposeLauncher();
					};
				}, "semantica-graph: sidebar tab");
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
