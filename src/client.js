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
// 内嵌走的是插件自己的 tab 类型（ExplorerView 自己渲染 iframe），
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
		/** 承载 Explorer 界面的 tab 类型（自己渲染 iframe，见 ExplorerView）。 */
		const EXPLORER_TAB_TYPE = "semantica:explorer";
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
			"action.aria": "用 Semantica 查看当前对话的知识图谱",
			"tab.title": "知识图谱",
			"state.working": "正在用 Semantica 抽取实体与关系…",
			"state.workingHint": "首次运行要加载模型，大约十几秒到半分钟。",
			"state.ready": "已就绪",
			"state.readyHint": "Explorer 已在「知识图谱」标签里打开。",
			"state.empty": "这个对话还没有可抽取的内容。",
			"error.title": "无法生成图谱",
			"error.retry": "重试",
			"error.detail": "详情",
			"action.open": "打开完整 Explorer",
			"action.refresh": "重新抽取",
			"action.reopen": "重新打开",
			"stat.nodes": "节点",
			"stat.edges": "边",
			"stat.entities": "实体",
			"stat.relations": "关系",
			"stat.took": "耗时",
			"engine.label": "引擎",
			"note.stale": "会话此后又有新内容，这张图是旧的。",
			"action.reload": "刷新",
			"action.external": "在浏览器打开",
			"state.loading": "正在载入 Explorer…",
			"view.noUrl": "这个标签没有拿到 Explorer 地址。关掉它，回到「知识图谱」面板点「重新打开」。",
			"note.api": "Explorer 的 REST API",
			"note.explorer": "上游 Explorer",
			"analyze.title": "让 AI 分析",
			"analyze.hint":
				"新开一个对话，把这张图的数据注入进去让 AI 分析。新对话会出现在会话列表里，可以继续追问。",
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
			"action.aria": "Explore this conversation's knowledge graph with Semantica",
			"tab.title": "Knowledge graph",
			"state.working": "Extracting entities and relations with Semantica…",
			"state.workingHint": "The first run loads the models; expect up to half a minute.",
			"state.ready": "Ready",
			"state.readyHint": "The Explorer is open in the “Knowledge graph” tab.",
			"state.empty": "Nothing extractable in this conversation yet.",
			"error.title": "Could not build the graph",
			"error.retry": "Retry",
			"error.detail": "Details",
			"action.open": "Open the full Explorer",
			"action.refresh": "Re-extract",
			"action.reopen": "Reopen",
			"stat.nodes": "Nodes",
			"stat.edges": "Edges",
			"stat.entities": "Entities",
			"stat.relations": "Relations",
			"stat.took": "Took",
			"engine.label": "Engine",
			"note.stale": "The conversation has grown since; this graph is stale.",
			"action.reload": "Reload",
			"action.external": "Open in browser",
			"state.loading": "Loading the Explorer…",
			"view.noUrl":
				"This tab has no Explorer address. Close it and press “Reopen” in the Knowledge graph panel.",
			"note.api": "Explorer REST API",
			"note.explorer": "Upstream Explorer",
			"analyze.title": "Ask an AI to analyse",
			"analyze.hint":
				"Opens a new conversation seeded with this graph, so an AI can analyse it. It shows up in the session list and accepts follow-ups.",
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
/* 「让 AI 分析」那一块：跟上面的统计/按钮拉开距离，免得看着像同一组操作 */
.semg-analyze{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.semg-code{margin-top:6px;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-word;text-align:left}
.semg-action{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer}
.semg-action:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#222)}
.semg-view{display:flex;flex-direction:column;height:100%;min-height:0}
.semg-viewbar{display:flex;align-items:center;gap:8px;padding:7px 10px;flex:0 0 auto;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12))}
.semg-viewtitle{font-weight:600;flex:0 0 auto}
.semg-viewurl{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#888);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}
.semg-viewbar a.semg-btn{text-decoration:none}
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

		/** 每个会话上一次给出的 Explorer 标签，好在端口变化时替换掉旧标签。 */
		const lastTabBySession = new Map();

		/**
		 * meta.scope 的值：会话 + 端口。
		 *
		 * 端口进了去重键，是因为 Explorer 进程空闲回收后重启会换一个端口 ——
		 * 那时旧标签指向的是已经死掉的地址，必须换成新标签。
		 */
		function explorerScope(sessionId, url) {
			let port = "";
			try {
				port = new URL(url).port || "";
			} catch {
				// 畸形 url：退化成只按会话去重，至少不会每次都新开标签
			}
			return `${sessionId}@${port}`;
		}

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

		/** 在侧边栏里打开承载 Explorer 界面的标签。 */
		function openExplorerTab(ctx, url, sessionId) {
			const sb = ctx && typeof ctx.get === "function" ? ctx.get("betterSidebar") : null;
			if (!sb || typeof sb.openTab !== "function") {
				console.warn("[semantica-graph] betterSidebar 不可用，无法打开 Explorer 标签");
				return false;
			}
			const scope = explorerScope(sessionId, url);
			// openTab 会把 url 落到 tab.path 上（service.ts: path: seed.url），
			// ExplorerView 从那里读回来。
			const tabId = `${EXPLORER_TAB_TYPE}:${scope}`;
			const prev = lastTabBySession.get(sessionId);
			try {
				// 换了端口：旧标签只会显示「连不上」，顺手关掉。
				if (prev && prev.scope !== scope && typeof sb.closeTab === "function") {
					try {
						sb.closeTab(prev.tabId, { sessionId });
					} catch {
						// 关不掉不影响新标签，忽略
					}
				}
				sb.openTab(
					{
						type: EXPLORER_TAB_TYPE,
						id: tabId,
						url,
						title: T("tab.title"),
						meta: { scope },
					},
					{ sessionId },
				);
				lastTabBySession.set(sessionId, { tabId, scope });
				return true;
			} catch (err) {
				console.warn("[semantica-graph] 打开 Explorer 标签失败", err);
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
				h(IconGraph, { size: 16 }),
			);
		}

		// ───────────────────────── 控制面板 tab ─────────────────────────

		function StatCard(labelKey, value) {
			return h(
				"div",
				{ className: "semg-card", key: labelKey },
				h("b", null, String(value ?? "—")),
				h("span", null, T(labelKey)),
			);
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
						// 以前这里是 `if (data.url) openExplorerTab(...)`，理由是
						// 「用户点按钮就是为了看图」。但那会把刚打开的控制面板顶掉：
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
			useEffect(() => {
				if (!visible) return;
				if (startedFor.current === sessionId) return;
				startedFor.current = sessionId;
				run(false);
			}, [visible, sessionId, run]);

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

			// — 进行中 —
			//
			// spinner 放在文案**上方**，整块在面板里垂直+水平居中。
			// 之前是横排一行（`semg-head`：spinner 在文字左边、整体顶对齐）——
			// 抽取要等十几秒到半分钟，期间面板里就这一行字，贴在顶上显得空。
			if (phase === "working") {
				return h(
					"div",
					{ className: "semg-panel semg-busy" },
					h("div", { className: "semg-spin" }),
					h("div", { className: "semg-busy-title" }, T("state.working")),
					h("div", { className: "semg-muted" }, T("state.workingHint")),
				);
			}

			// — 出错 —
			if (phase === "error") {
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
			return h(
				"div",
				{ className: "semg-panel" },
				h(
					"div",
					{ className: "semg-head" },
					h(IconGraph, { size: 16 }),
					h("span", null, T("tab.title")),
				),

				phase === "ready"
					? h(
							"div",
							{ className: "semg-box", "data-kind": "ok" },
							h("div", null, T("state.ready")),
							h("div", { className: "semg-muted" }, T("state.readyHint")),
						)
					: null,

				stale
					? h("div", { className: "semg-box", "data-kind": "warn" }, T("note.stale"))
					: null,

				stats
					? h(
							"div",
							{ className: "semg-grid" },
							StatCard("stat.nodes", stats.nodes),
							StatCard("stat.edges", stats.edges),
							StatCard("stat.entities", stats.entities),
							StatCard("stat.relations", stats.relations),
						)
					: null,

				stats && stats.elapsed != null
					? h(
							"div",
							{ className: "semg-muted" },
							`${T("stat.took")} ${Number(stats.elapsed).toFixed(1)}s · ` +
								`${T("engine.label")} semantica ${stats.engine?.semantica || "?"} / ` +
								`Python ${stats.engine?.python || "?"}`,
						)
					: null,

				h(
					"div",
					{ className: "semg-row" },
					url
						? h(
								"button",
								{
									type: "button",
									className: "semg-btn",
									"data-primary": "1",
									onClick: () => openExplorerTab(ctx, url, sessionId),
								},
								T("action.reopen"),
							)
						: null,
					h(
						"button",
						{
							type: "button",
							className: "semg-btn",
							disabled: phase === "working",
							onClick: () => run(true),
						},
						T("action.refresh"),
					),
				),

				url
					? h(
							"div",
							{ className: "semg-muted" },
							`${T("note.explorer")} · `,
							h(
								"a",
								{ href: url, target: "_blank", rel: "noreferrer" },
								`${url}/docs`,
							),
						)
					: null,

				// —— 让 AI 分析：开一个子会话，把图数据注入进去 ——
				//
				// 不用 phase 管状态：分析失败不该把面板打成错误页（图还在、
				// 还能用），所以结果单独存 analysis，内联在按钮下面显示。
				h(
					"div",
					{ className: "semg-analyze" },
					h("div", { className: "semg-head" }, T("analyze.title")),
					h("div", { className: "semg-muted" }, T("analyze.hint")),
					h(
						"div",
						{ className: "semg-row" },
						ANALYZE_KINDS.map(([kind, key]) =>
							h(
								"button",
								{
									key,
									type: "button",
									className: "semg-btn",
									disabled: busyKind !== null || phase === "working",
									onClick: () => runAnalyze(kind),
								},
								busyKind === kind ? T("analyze.working") : T(key),
							),
						),
					),
					analysis
						? h(
								"div",
								{
									className: "semg-box",
									"data-kind": analysis.ok === true ? "ok" : "error",
								},
								analysis.ok === true
									? [
											T("analyze.done") + " ",
											h("b", { key: "label" }, analysis.label || analysis.sessionId || ""),
											// 自动跳转失败时不装作没事 —— 告诉用户去哪儿找
											analysis.navigated === false
												? h("div", { key: "manual", className: "semg-muted" }, T("analyze.manual"))
												: null,
											// 图数据没注进去的话这个对话等于没用，必须说清楚
											analysis.injected === false
												? h("div", { key: "nodigest", className: "semg-muted" }, T("analyze.noDigest"))
												: null,
											analysis.drillable === false
												? h(
														"div",
														{ key: "nodrill", className: "semg-muted" },
														T("analyze.noDrill"),
													)
												: null,
										]
									: analysis.code === "graph-missing"
										? T("analyze.needPrepare")
										: analysis.error || "未知错误",
							)
						: null,
				),
			);
		}

		// ───────────────────── Explorer 界面 tab ─────────────────────

		/**
		 * 承载 Semantica Knowledge Explorer 界面的 tab。
		 *
		 * 这里自己渲染 iframe，而不是交给 better-sidebar 的 browser tab。
		 * 原因是它的 browser 视图里有一条**删不掉**的状态行：
		 * `SandboxStatusBar` 是无条件渲染的（BrowserView.tsx），整个插件没有任何
		 * 隐藏它的设置，只有「沙箱开＝绿杠」和「沙箱关＝红杠」两种状态。
		 * 自己渲染就没有那层壳，顺带也不再需要用户去配 browserAllowedLoopback。
		 *
		 * URL 从 tab.path 读 —— openTab 会把 seed.url 落到这个字段上。
		 */
		function ExplorerView(props) {
			ensureStyles();
			const tab = props.tab || {};
			const url = typeof tab.path === "string" ? tab.path : "";
			const [reloadKey, setReloadKey] = useState(0);
			const [loaded, setLoaded] = useState(false);

			if (!url) {
				return h(
					"div",
					{ className: "semg-panel" },
					h("div", { className: "semg-box", "data-kind": "warn" }, T("view.noUrl")),
				);
			}

			return h(
				"div",
				{ className: "semg-view" },
				h(
					"div",
					{ className: "semg-viewbar" },
					h(IconGraph, { size: 14 }),
					h("span", { className: "semg-viewtitle" }, T("tab.title")),
					h("span", { className: "semg-viewurl", title: url }, url),
					h(
						"button",
						{
							type: "button",
							className: "semg-btn",
							onClick: () => {
								setLoaded(false);
								setReloadKey((k) => k + 1);
							},
						},
						T("action.reload"),
					),
					h(
						"a",
						{ className: "semg-btn", href: url, target: "_blank", rel: "noreferrer" },
						T("action.external"),
					),
				),
				h(
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
					// key 变化即重挂载，等于刷新（Explorer 是 SPA，无法从外部调它的刷新）
					h("iframe", {
						key: reloadKey,
						src: url,
						title: T("tab.title"),
						sandbox: EXPLORER_IFRAME_SANDBOX,
						referrerPolicy: "no-referrer",
						onLoad: () => setLoaded(true),
					}),
				),
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

			// 3) 控制面板 tab + Explorer 界面 tab
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
					// Explorer 界面单独一个 tab 类型。它不出现在 tab 选择器里
					// （没有 openTab 就没人会打开它），只是给 openExplorerTab 一个
					// 不套 better-sidebar 浏览器壳的落点。
					//
					// 刻意**不用 single:true**：它的去重键是「描述符 id」这个常量，
					// 与标签内容无关 —— 结果是把所有会话的 Explorer 合并成同一个
					// 标签，而且 applyDedupe 命中已有标签时只做 activateTabReducer，
					// **新的 url 会被直接丢弃**，于是切换会话后看到的还是上一个会话
					// 的图。改用 meta.scope（会话+端口）作去重键。
					const disposeExplorer = sidebar.registerTab({
						id: EXPLORER_TAB_TYPE,
						title: () => T("tab.title"),
						icon: (size) => h(IconGraph, { size: size || 16 }),
						order: 61,
						// hidden 只影响「+」菜单（Sidebar 里是 .filter(d => !d.hidden ...)）,
						// openTab 不检查它，所以按钮照常能打开。
						// 不设的话「+」里会多一个重复的「知识图谱」入口，
						// 点开是一个没有地址的空标签。
						hidden: true,
						dedupeKey: (tab) => {
							const scope =
								tab && tab.meta && typeof tab.meta === "object" ? tab.meta.scope : undefined;
							return typeof scope === "string" ? scope : tab && tab.id;
						},
						component: ExplorerView,
					});
					return () => {
						bridge.sidebar = null;
						disposeLauncher();
						disposeExplorer();
					};
				}, "semantica-graph: sidebar tab");
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
