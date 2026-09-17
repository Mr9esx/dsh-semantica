// src/client.js
//
// dsh-semantica-graph 的浏览器半侧。
//
// 两个贡献点，都注册在**核心包**的槽上，因此不依赖任何第三方插件：
//   1. conversation.view —— 对话顶部标签里的「知识图谱」（打开面板的唯一入口）
//   2. conversation.input.right —— 输入框那一排右侧的「每轮提取 关/开」开关
//
// 只有这两处。会话标题右侧原来还挂过「打开知识图谱」和同名开关两个按钮 —— 用户明确
// 要求去掉（「插件只需要 tab 和 input 的开关」），所以标题那一排现在完全归核心。
//
// ## 界面分三块，来源各不相同
//
//   · 图本身   —— semantica 的 Knowledge Explorer（上游完整的 Web 应用），内嵌 iframe。
//                 插件不自己画图：Explorer 有多个 workspace、几十个 /api 路由，自绘只能
//                 覆盖其中一个视图，功能上限会掉一大截。
//   · 工具栏   —— 本插件自己画：统计数字、本对话/全部切换、刷新、分析、复制提取指令。
//   · 分析抽屉 —— 本插件自己画，数据来自 /api-semantica/analysis，指标在插件里算
//                 （src/kg.js），不调 AI、不开新对话。
//
// 客户端只依赖 react（基座冻结表里有），不需要构建步骤 —— 这个文件就是加载的产物。

window.__ModuleLoader__.load({
	id: "dsh-semantica-graph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useRef, useCallback } = react;

		/** 语言包命名空间 / 视图 id。 */
		const NS = "semantica-graph";

		/**
		 * 内嵌 Explorer 用的 iframe sandbox。
		 *
		 * 这一串是「放行的回环地址」那一档，逐字沿用既有实现（实测过的组合）：
		 *   · allow-same-origin **必须有**：没有它 iframe 是 opaque origin，
		 *     Explorer 这种 React SPA 的模块脚本与 fetch 跑不起来（实测白屏）。
		 *   · 刻意**不含** allow-top-navigation：Explorer 因此无法把主窗口导航走。
		 *   · 安全性：Explorer 在 127.0.0.1 的另一个端口上，仍是跨源 —— 拿不到 GUI 的
		 *     DOM、Cookie 与内部接口。
		 */
		const EXPLORER_IFRAME_SANDBOX =
			"allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox allow-same-origin";

		// ───────────────────────────── 语言包 ─────────────────────────────

		const zh = {
			"tab.title": "知识图谱",
			"action.refresh": "刷新",
			"action.analysis": "分析",
			"action.external": "在浏览器打开",
			"action.copy": "复制提取指令",
			"action.copied": "已复制",
			"mode.conversation": "本对话",
			"mode.all": "全部",
			"stat.nodes": "节点",
			"stat.edges": "边",
			"stat.entities": "实体",
			"stat.relations": "关系",
			"stat.decisions": "决策",
			"state.loading": "正在打开图…",
			"state.loadSlow": "图没打开：Explorer 没有响应",
			"state.loadSlowHint": "多半是它已经被回收或者刚被重启过。点「重试」重新拉起一个；如果总是这样，去面板里看 Explorer 依赖是否齐全。",
			"action.retry": "重试",
			"auto.off": "每轮提取：关",
			"auto.compactOff": "图谱提取 关",
			"auto.compactOn": "图谱提取 开",
			"auto.defaultOff": "新会话默认：关",
			"auto.defaultOn": "新会话默认：开",
			"auto.defaultHint": "新建的对话在发出第一条消息之前还没有会话，那时候任何按会话的开关都点不到 —— 所以「每条新对话一开始就自动提取」要靠这个默认值。点一下切换。",
			"auto.on": "每轮提取：开",
			"auto.offHint": "关着的时候，模型只在它觉得值得记的时候写图。点一下改成「每轮都写」。",
			"auto.onHint": "开着的时候，模型每一轮回复结束前都要把这一轮的新知识写进图（会多花一些 token）。点一下关掉。",
			"auto.ctaOn": "开启每轮自动提取",
			"auto.ctaHint": "开这个开关，比每次粘指令省事：模型每一轮都会自己把新知识写进图。",
			"auto.turnedOn": "已开启「每轮自动提取」—— 从下一轮对话开始生效。",
			"state.emptyHint": "还没有可显示的内容",
			"state.noKg": "这台机器上还没有写过任何知识图谱",
			"state.noKgHint": "图由模型通过 mcp__semantica__ 工具写入。把下面这段指令粘进对话，让它把这次对话抽进去：",
			"state.noNodes": "本对话在图里还没有节点",
			"state.noNodesHint":
				"图里有别的会话写入的内容。开下面这个开关，模型从下一轮开始就会自己写进来；也可以点「复制提取指令」当场补一次，或者切到「全部」看整张图。",
			"state.taggedOnly": "本对话 {n} 个节点",
			"state.claimByEntity": "按实体边认领 {n} 条决策",
			// 曾经有「按时间认领」这句 —— 那条兜底规则会把别的会话的决策算进来，已删除
			"state.untaggedNote": "图里还有 {n} 个节点没打会话标，只出现在「全部」里",
			"state.hostMissing": "插件的 host 半侧还没加载",
			"state.hostMissingHint":
				"/api-semantica 没有任何路由响应。改过 host 代码（src/index.js 等）时 harness 一般会自动热重载；要是一直这样，重启 DSH Desktop。只改浏览器半侧刷新页面即可。",
			"state.explorerMissing": "Explorer 依赖不可用",
			"state.mcpMissing": "MCP 工具没挂上：profile 里看不到 mcp-semantica 条目，模型写不进图。",
			"analysis.title": "分析",
			"analysis.close": "收起",
			"analysis.overview": "概览",
			"analysis.hubs": "枢纽",
			"analysis.communities": "社区",
			"analysis.decisions": "决策",
			"analysis.timeline": "时间线",
			"analysis.byDegree": "按度数",
			"analysis.byRank": "按 PageRank",
			"analysis.noDecisions": "这张图里还没有决策",
			"analysis.maker": "决策人",
			"analysis.confidence": "置信度",
			"analysis.members": "成员",
			"analysis.byType": "节点类型",
			"analysis.isolated": "孤立节点",
			"analysis.components": "连通分量",
			"analysis.untaggedNote": "图里还有 {n} 个节点没打会话标，只出现在「全部」里",
			"analysis.failed": "分析失败",
		};

		const en = {
			"tab.title": "Knowledge graph",
			"action.refresh": "Refresh",
			"action.analysis": "Analysis",
			"action.external": "Open in browser",
			"action.copy": "Copy extract prompt",
			"action.copied": "Copied",
			"mode.conversation": "This chat",
			"mode.all": "All",
			"stat.nodes": "nodes",
			"stat.edges": "edges",
			"stat.entities": "entities",
			"stat.relations": "relations",
			"stat.decisions": "decisions",
			"state.loading": "Opening graph…",
			"state.loadSlow": "The graph did not open: Explorer is not responding",
			"state.loadSlowHint": "It was probably reaped or just restarted. Retry to start a fresh one.",
			"action.retry": "Retry",
			"auto.off": "Per-turn extract: off",
			"auto.compactOff": "Graph extract: off",
			"auto.compactOn": "Graph extract: on",
			"auto.defaultOff": "New chats default: off",
			"auto.defaultOn": "New chats default: on",
			"auto.defaultHint": "A brand-new chat has no session until the first message, so no per-session switch can be clicked yet — use this default to make every new chat extract from the start. Click to toggle.",
			"auto.on": "Per-turn extract: on",
			"auto.offHint": "When off, the model only writes when it judges something worth keeping. Click to write every turn.",
			"auto.onHint": "When on, the model must write this turn's new knowledge before finishing (costs extra tokens). Click to turn off.",
			"auto.ctaOn": "Turn on per-turn extraction",
			"auto.ctaHint": "Cheaper than pasting the instruction every time: the model writes each turn by itself.",
			"auto.turnedOn": "Per-turn extraction is on — effective from the next turn.",
			"state.emptyHint": "Nothing to show yet",
			"state.noKg": "No knowledge graph has been written on this machine yet",
			"state.noKgHint":
				"The graph is written by the model through the mcp__semantica__ tools. Paste this prompt into the chat:",
			"state.noNodes": "This chat has no nodes in the graph yet",
			"state.noNodesHint":
				"The graph holds other chats' content. Turn on the switch below and the model writes from the next turn on; you can also copy the prompt to backfill now, or switch to “All”.",
			"state.taggedOnly": "{n} nodes in this chat",
			"state.claimByEntity": "{n} decisions claimed by entity edges",
			"state.claimByTime": "{n} decisions claimed by time",
			"state.untaggedNote": "{n} nodes carry no conversation tag (visible under “All”)",
			"state.hostMissing": "The plugin's host half is not loaded",
			"state.hostMissingHint":
				"Nothing answers /api-semantica. Host-side changes (src/index.js etc.) are usually hot-reloaded by the harness; if it stays like this, restart DSH Desktop. Browser-side changes only need a refresh.",
			"state.explorerMissing": "Explorer dependencies unavailable",
			"state.mcpMissing": "MCP tools are not attached: no mcp-semantica row in the profile.",
			"analysis.title": "Analysis",
			"analysis.close": "Hide",
			"analysis.overview": "Overview",
			"analysis.hubs": "Hubs",
			"analysis.communities": "Communities",
			"analysis.decisions": "Decisions",
			"analysis.timeline": "Timeline",
			"analysis.byDegree": "by degree",
			"analysis.byRank": "by PageRank",
			"analysis.noDecisions": "No decisions in this graph",
			"analysis.maker": "Maker",
			"analysis.confidence": "Confidence",
			"analysis.members": "Members",
			"analysis.byType": "Node types",
			"analysis.isolated": "Isolated",
			"analysis.components": "Components",
			"analysis.untaggedNote": "{n} nodes carry no conversation tag (visible under “All”)",
			"analysis.failed": "Analysis failed",
		};

		let dict = zh;
		function T(key) {
			return dict[key] ?? key;
		}
		/** 带一个数字的文案。 */
		function Tn(key, n) {
			return String(T(key)).replace("{n}", String(n));
		}

		// ───────────────────────────── 样式 ─────────────────────────────
		//
		// 字号统一 12px：工具栏统计、按钮文案、分析抽屉正文都是 12px，
		// 统计数字与它后面的单位同号（只有字重不同），免得数字和单位大小不一。
		// 等宽只给路径那一处 —— 路径要能一眼看出层级。
		const CSS = `
[data-semgp-root]{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px}
[data-semgp-bar]{display:flex;align-items:center;flex-wrap:wrap;gap:8px;box-sizing:border-box;min-height:34px;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.22)}
[data-semgp-sub]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid rgba(128,128,128,.14);color:rgba(128,128,128,.95)}
[data-semgp-spacer]{flex:1 1 auto}
[data-semgp-seg]{display:inline-flex;border:1px solid rgba(128,128,128,.35);border-radius:7px;overflow:hidden}
[data-semgp-seg] button{font-size:12px;line-height:18px;padding:2px 10px;border:0;background:transparent;color:inherit;cursor:pointer}
[data-semgp-seg] button[aria-pressed="true"]{background:rgba(128,128,128,.22);font-weight:600}
[data-semgp-stats]{display:inline-flex;gap:10px;color:rgba(128,128,128,.95)}
[data-semgp-stats] b{font-weight:600;font-size:12px}
[data-semgp-btn]{font-size:12px;line-height:18px;padding:3px 10px;border:1px solid rgba(128,128,128,.35);border-radius:7px;background:transparent;color:inherit;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:5px;font-family:inherit}
[data-semgp-btn]:hover{background:rgba(128,128,128,.14)}
/* 每轮自动提取的开关：开着要一眼看得出来，不然用户不知道自己有没有点开 */
[data-semgp-auto="on"]{background:rgba(46,160,67,.16);border-color:rgba(46,160,67,.55);font-weight:600}
[data-semgp-auto="on"]:hover{background:rgba(46,160,67,.24)}
[data-semgp-auto="off"]{opacity:.72}
/* 输入框那一排是「compact controls」，所以那里用短文案 + 更小的内边距，别把行撑开 */
[data-semgp-compact]{padding:2px 8px;line-height:20px;border-radius:6px}
[data-semgp-btn][disabled]{opacity:.5;cursor:default}
[data-semgp-path]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52ch}
[data-semgp-body]{position:relative;flex:1 1 auto;min-height:0;display:flex}
/* min-height 是保命的：这根画布的高度原本全靠 height:100% 一路传下来，只要任一层祖先
   给不出确定高度（.viewArea 是 flex:1 0 auto; min-height:auto，属于会变的那种），
   画布就会塌成 0，图直接看不见。给个下限，链子断了也只是矮一点。*/
[data-semgp-canvas]{position:relative;flex:1 1 auto;min-width:0;min-height:280px}
[data-semgp-holder]{position:absolute;inset:0}
[data-semgp-center]{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:rgba(128,128,128,.95);overflow:auto}
[data-semgp-center] strong{font-size:13px;color:inherit}
[data-semgp-center] p{margin:0;max-width:60ch;line-height:1.7}
[data-semgp-center] pre{margin:0;max-width:64ch;text-align:left;font-size:12px;line-height:1.6;padding:10px 12px;border:1px solid rgba(128,128,128,.28);border-radius:8px;background:rgba(128,128,128,.08);white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
[data-semgp-warn]{padding:6px 12px;border-bottom:1px solid rgba(128,128,128,.14);color:#c98a00}
[data-semgp-spin]{width:18px;height:18px;border:2px solid rgba(128,128,128,.35);border-top-color:rgba(128,128,128,.9);border-radius:50%;animation:semgp-spin 900ms linear infinite}
@keyframes semgp-spin{to{transform:rotate(360deg)}}
[data-semgp-drawer]{width:380px;flex:0 0 380px;border-left:1px solid rgba(128,128,128,.22);display:flex;flex-direction:column;min-height:0}
[data-semgp-drawer] header{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.14)}
[data-semgp-drawer] header strong{font-size:12px}
[data-semgp-tabs]{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.14)}
[data-semgp-tabs] button{font-size:12px;padding:2px 9px;border:1px solid rgba(128,128,128,.3);border-radius:999px;background:transparent;color:inherit;cursor:pointer;font-family:inherit}
[data-semgp-tabs] button[aria-pressed="true"]{background:rgba(128,128,128,.22)}
[data-semgp-pane]{flex:1 1 auto;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:12px}
[data-semgp-grid]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
[data-semgp-card]{border:1px solid rgba(128,128,128,.22);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
[data-semgp-card] .k{color:rgba(128,128,128,.95)}
[data-semgp-card] .v{font-weight:600;font-size:13px}
[data-semgp-row]{display:flex;align-items:baseline;gap:8px}
[data-semgp-row] .n{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-semgp-row] .t{color:rgba(128,128,128,.95)}
[data-semgp-row] .d{font-variant-numeric:tabular-nums;color:rgba(128,128,128,.95)}
[data-semgp-chip]{display:inline-block;font-size:12px;padding:1px 7px;border:1px solid rgba(128,128,128,.3);border-radius:999px;margin:0 4px 4px 0}
/* 注意：data-semgp-bar 是工具栏专属，别再拿去当别的用途 —— 这里曾经有一版把图表条
   也叫 data-semgp-bar，两条规则撞在一起，后写的 height:5px 把工具栏压成一根 5px 灰条。
   CSS 在模板字符串里，注释里不要出现反引号。*/
[data-semgp-chartbar]{height:5px;border-radius:3px;background:rgba(128,128,128,.28)}
[data-semgp-chart]{display:flex;flex-direction:column;gap:3px}
[data-semgp-muted]{color:rgba(128,128,128,.95)}
[data-semgp-frame-host]{position:fixed;z-index:5;padding:0;box-sizing:border-box;display:none;background:var(--dsw-alias-bg-base,transparent)}
[data-semgp-frame-host] iframe{width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-base,transparent)}
[data-semgp-hide-composer] [data-composer-seat]{display:none}
`;

		/** 注入样式（只注一次）。 */
		function ensureStyles() {
			const id = "dsh-semantica-graph-style";
			if (document.getElementById(id)) return;
			const el = document.createElement("style");
			el.id = id;
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		// ───────────────────────────── HTTP ─────────────────────────────

		/**
		 * 读一个 JSON 响应，并分清两种失败。
		 *
		 * 这里有个真实场景必须区分开：**host 半侧还没加载**（改了 src/index.js 但还没重启
		 * DSH Desktop）时，`/api-semantica/*` 没有任何路由接管，Web 服务器会回一个 404 的
		 * HTML 页面。直接 `res.json()` 的话报出来是「Unexpected token '<'」—— 用户看不懂，
		 * 也不知道该干什么。所以这里按 content-type 判一下，给一个能照着做的错误码。
		 */
		async function readJson(res) {
			const type = res.headers.get("content-type") ?? "";
			if (!type.includes("application/json")) {
				const err = new Error(`/api-semantica 没有响应（HTTP ${res.status}）`);
				err.code = "host-missing";
				throw err;
			}
			return res.json();
		}

		async function getJson(path) {
			const res = await fetch(path, { headers: { accept: "application/json" } });
			return readJson(res);
		}

		async function postJson(path, body) {
			const res = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {}),
			});
			return readJson(res);
		}

		// ─────────────────── 内嵌的 Explorer（iframe） ───────────────────
		//
		// ## 为什么这段这么绕：iframe 必须活过组件卸载
		//
		// conversation.view 槽对非激活视图是**过滤掉**的，所以切走标签会真的卸载我们的
		// 组件 —— 连带销毁里面的 iframe。而 Explorer 是个 SPA，每次重载都要从头启动，
		// 于是每次切回来看起来都像「又在打开」。
		//
		// 实测过两条路，第一条是死的：
		//
		//   1. 「卸载前把 iframe 抢救到别处、回来再搬回去」—— 不行。在 DOM 里
		//      appendChild 搬动一个 iframe 会让它**重新加载**（搬 4 次 = 加载 5 次）。
		//      iframe 一旦脱离文档，它的浏览上下文就被丢弃了。
		//   2. 「iframe 从头到尾待在同一个父节点里，宿主挂在 body 上、只改 CSS」—— 行。
		//      只改宿主的 display / 尺寸，累计 load 次数恒为 1。
		//
		// 所以宿主常驻 document.body（不随视图卸载），靠 position:fixed 摆到视图里那个
		// 占位元素的位置上。没用 createPortal —— 客户端半侧只能 require("react")，
		// 拿不到 react-dom。
		//
		// 代价：位置得自己同步（ResizeObserver + resize/scroll），而且必须保证
		// **不在图谱标签时一定隐藏**，否则这块 fixed 会盖住别的界面。
		const frameHost = {
			el: null,
			iframe: null,
			/** 当前 iframe 指向的 url。 */
			url: null,
			/** 这个 url 属于哪个视图（mode:sessionId）。 */
			key: null,
			/** 已经加载完成的 url；组件后挂载时据此决定要不要显示加载遮罩。 */
			loadedUrl: null,
			onLoad: null,
		};

		/** 拿到（必要时创建）常驻宿主。宿主被外力摘掉时会把记录一并清空。 */
		function ensureFrameHost() {
			if (frameHost.el && frameHost.el.isConnected) return frameHost.el;
			const el = document.createElement("div");
			el.setAttribute("data-semgp-frame-host", "");
			document.body.appendChild(el);
			frameHost.el = el;
			frameHost.iframe = null;
			frameHost.url = null;
			frameHost.key = null;
			frameHost.loadedUrl = null;
			return el;
		}

		/**
		 * 让宿主的 iframe 指向 url。
		 *
		 * **只在 url 真的变了时才换 iframe** —— 换一次就是一次完整重载。
		 *
		 * @param key 这个 url 属于哪个视图，用于「切回来直接沿用」的判断。
		 * @param onLoad 加载完成回调。记进 frameHost，让**后挂载**的组件也能知道
		 *   「这个 url 早就加载好了」；否则切回来会一直卡在加载遮罩上（不会再触发 load）。
		 */
		function pointFrameHostAt(url, key, onLoad) {
			frameHost.onLoad = onLoad;
			// 「已经是这个 url 了」不能只看记录：宿主有可能被外力摘掉（GUI 重挂载、
			// 别的插件清理 DOM、热更新）。记录说「已经有 iframe 了」而 DOM 里其实没有，
			// 就会走进这条捷径、空手而归 —— 界面上表现为图永远不出来。所以这里连
			// 连通性一起验，断了就重建。
			const alive = Boolean(frameHost.el && frameHost.el.isConnected && frameHost.iframe && frameHost.iframe.isConnected);
			if (alive && frameHost.url === url) {
				frameHost.key = key;
				return;
			}
			const host = ensureFrameHost();
			if (frameHost.iframe) frameHost.iframe.remove();
			const f = document.createElement("iframe");
			f.setAttribute("title", T("tab.title"));
			f.setAttribute("sandbox", EXPLORER_IFRAME_SANDBOX);
			f.setAttribute("referrerpolicy", "no-referrer");
			f.addEventListener("load", () => {
				frameHost.loadedUrl = url;
				if (typeof frameHost.onLoad === "function") frameHost.onLoad();
			});
			f.src = url;
			host.appendChild(f);
			frameHost.iframe = f;
			frameHost.url = url;
			frameHost.key = key;
			frameHost.loadedUrl = null;
		}

		/** 隐藏宿主。离开图谱标签时**必须**调到，否则这块 fixed 会盖住别的界面。 */
		function hideFrameHost() {
			if (frameHost.el) frameHost.el.style.display = "none";
		}

		/** 把宿主摆到占位元素的矩形上。 */
		function syncFrameHostRect(placeholder) {
			const host = frameHost.el;
			if (!host || !placeholder) return;
			const r = placeholder.getBoundingClientRect();
			if (r.width < 1 || r.height < 1) {
				hideFrameHost();
				return;
			}
			host.style.display = "block";
			host.style.left = Math.round(r.left) + "px";
			host.style.top = Math.round(r.top) + "px";
			host.style.width = Math.round(r.width) + "px";
			host.style.height = Math.round(r.height) + "px";
		}

		/**
		 * 图谱视图是个整屏画布，下面压着的那条对话输入框既用不上、又吃掉一百多像素。
		 * 挂载时给滚动容器打个标记，由 CSS 隐藏输入框：
		 *   `[data-semgp-hide-composer] [data-composer-seat]{display:none}`
		 *
		 * 用 `data-composer-seat` 这个**稳定属性**定位（它在核心的 JSX 里显式写死），
		 * 不用哈希类名 —— 那是 module CSS 生成的，DSH 一升级就变。
		 *
		 * 用 display:none 而不是卸载它：输入框连同草稿一起留着，切回「对话」标签草稿还在。
		 */
		function setComposerHidden(hidden) {
			try {
				const anchor = document.querySelector('[data-slot="conversation.view"]');
				const scroll =
					anchor && typeof anchor.closest === "function"
						? anchor.closest("[data-conversation-scroll]")
						: null;
				if (!scroll) return false;
				if (hidden) scroll.setAttribute("data-semgp-hide-composer", "");
				else scroll.removeAttribute("data-semgp-hide-composer");
				return true;
			} catch {
				return false;
			}
		}

		/** 把一个元素压成「够我看懂布局」的一小段描述。 */
		function describeNode(el) {
			if (!el) return null;
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return {
				tag: el.tagName.toLowerCase(),
				cls: typeof el.className === "string" ? el.className.slice(0, 90) : "",
				data: [...el.attributes]
					.filter((a) => a.name.startsWith("data-"))
					.map((a) => a.name)
					.slice(0, 8),
				rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
				style: {
					display: cs.display,
					position: cs.position,
					flex: cs.flex,
					flexDirection: cs.flexDirection,
					height: cs.height,
					minHeight: cs.minHeight,
					width: cs.width,
					overflow: cs.overflow,
					boxSizing: cs.boxSizing,
					zIndex: cs.zIndex,
					pointerEvents: cs.pointerEvents,
					background: cs.backgroundColor,
					opacity: cs.opacity,
					transformed: cs.transform !== "none",
				},
			};
		}

		/**
		 * 量一遍真 DOM 并回报给 host。
		 *
		 * 存在的理由：插件活在一个我看不见的窗口里 —— 没有截图、没有 CDP、没有 DevTools。
		 * 布局问题一旦只能靠猜，就会修错地方（这一版真踩过：工具栏被自己写的另一条同名
		 * 规则压成了 5px 灰条，而我离线那套假 DOM 的祖先链跟真界面不一样，测不出来）。
		 * 所以让面板把它**自己**量到的东西回传，落成文件，我读文件就有证据。
		 */
		function collectDiag(reason, extra) {
			try {
				const one = (sel) => document.querySelector(sel);
				const chain = [];
				let node = one("[data-semgp-root]");
				while (node && chain.length < 16) {
					chain.push(describeNode(node));
					node = node.parentElement;
				}
				const inner = {};
				for (const key of ["root", "bar", "sub", "body", "canvas", "holder", "frame-host"]) {
					inner[key] = describeNode(one(`[data-semgp-${key}]`));
				}
				const scroll = one("[data-conversation-scroll]");
				const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => ({
					text: (t.textContent || "").slice(0, 24),
					selected: t.getAttribute("aria-selected"),
					rect: describeNode(t)?.rect ?? null,
				}));

				// 「面板正上方那条盖着别的东西的色块」是谁 —— 灰条类问题的直接答案
				const root = one("[data-semgp-root]");
				const band = root ? root.getBoundingClientRect().top : null;
				const opaqueAbove = [];
				if (band !== null) {
					const scope = scroll?.parentElement ?? document.body;
					for (const el of scope.querySelectorAll("*")) {
						if (opaqueAbove.length >= 12) break;
						const cs = getComputedStyle(el);
						if (cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent") continue;
						const r = el.getBoundingClientRect();
						if (r.height < 2 || r.width < 40) continue;
						if (r.bottom < band - 80 || r.top > band + 10) continue;
						opaqueAbove.push({ ...describeNode(el), area: Math.round(r.width * r.height) });
					}
				}

				return {
					reason,
					url: String(location.href).slice(0, 140),
					viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
					cssLoaded: [...document.querySelectorAll("style")].some((st) =>
						(st.textContent || "").includes("data-semgp-canvas"),
					),
					chain,
					inner,
					tabs,
					scroll: scroll
						? {
								...describeNode(scroll),
								scrollTop: scroll.scrollTop,
								scrollHeight: scroll.scrollHeight,
								clientHeight: scroll.clientHeight,
								hideComposerAttr: scroll.hasAttribute("data-semgp-hide-composer"),
							}
						: null,
					seat: describeNode(one("[data-composer-seat]")),
					opaqueAbove,
					extra: extra ?? null,
				};
			} catch (err) {
				return { reason, error: String(err?.message ?? err) };
			}
		}

		/**
		 * iframe 加载的上限。超过它还没 load，就认定「Explorer 没起来」而不是继续转圈 ——
		 * 死掉的端口不会有任何事件回调，只能靠时间兜。
		 */
		const LOAD_TIMEOUT_MS = 15_000;

		/**
		 * 图谱画布的占位元素 —— 真正渲染 iframe 的是 frameHost，这里只报告自己占哪儿。
		 *
		 * 组件卸载时 iframe **不动**（还在宿主里），只把宿主藏起来，所以切标签回来是
		 * 秒开、不会重载。
		 */
		function ExplorerFrame(props) {
			const url = props.url || "";
			const viewKey = props.viewKey || "";
			// 已经加载过的 url 直接算「加载好了」，否则切回来会卡在遮罩上
			// （复用的 iframe 不会再触发一次 load 事件）。
			const [loaded, setLoaded] = useState(() => Boolean(url) && frameHost.loadedUrl === url);
			const holder = useRef(null);
			// iframe 指向的 Explorer 如果已经死了（进程被回收/插件刚热重载过），
			// load 事件永远不来，面板就会一直停在「正在打开图…」。所以给它一个上限。
			const [slow, setSlow] = useState(false);

			useEffect(() => {
				if (loaded || !url) {
					setSlow(false);
					return undefined;
				}
				const timer = setTimeout(() => setSlow(true), LOAD_TIMEOUT_MS);
				return () => clearTimeout(timer);
			}, [loaded, url]);

			useEffect(() => {
				const node = holder.current;
				if (!url || !node) {
					hideFrameHost();
					return;
				}
				pointFrameHostAt(url, viewKey, () => setLoaded(true));
				syncFrameHostRect(node);

				// 位置跟着占位元素走。ResizeObserver 抓尺寸变化（工具栏换行、窗口变化），
				// resize/scroll 兜住 observer 覆盖不到的位移（对话区滚动）。
				let ro = null;
				try {
					if (typeof ResizeObserver === "function") {
						ro = new ResizeObserver(() => syncFrameHostRect(node));
						ro.observe(node);
					}
				} catch {
					ro = null;
				}
				const follow = () => syncFrameHostRect(node);
				window.addEventListener("resize", follow);
				window.addEventListener("scroll", follow, true);

				return () => {
					if (ro) {
						try {
							ro.disconnect();
						} catch {
							/* ignore */
						}
					}
					window.removeEventListener("resize", follow);
					window.removeEventListener("scroll", follow, true);
					frameHost.onLoad = null;
					hideFrameHost();
				};
			}, [url, viewKey]);

			// 返回的是**两个兄弟节点**，不再套一层：外面 GraphView 里那个
			// [data-semgp-canvas] 已经是定位容器了，这里再套一层同名容器的话，
			// 内层是个普通 block —— 而它的内容（遮罩 + 占位）全是绝对定位、脱离文档流，
			// 于是内层高度塌成 0，iframe 宿主跟着变成 0×0，**图根本显示不出来**。
			// （这个坑是真被 scripts/visual-check.mjs 量出来的，不是推理出来的。）
			return h(
				react.Fragment,
				null,
				loaded
					? null
					: h(
							"div",
							{ "data-semgp-center": "" },
							h("div", { "data-semgp-spin": "" }),
							h("span", null, slow ? T("state.loadSlow") : T("state.loading")),
							slow ? h("p", null, T("state.loadSlowHint")) : null,
							slow
								? h(
										"button",
										{
											type: "button",
											"data-semgp-btn": "",
											onClick: () => {
												setSlow(false);
												if (typeof props.onRetry === "function") props.onRetry();
											},
										},
										T("action.retry"),
									)
								: null,
						),
				// iframe 不在这里 —— 它在 frameHost 里，这里只是它要覆盖的占位。
				h("div", { ref: holder, "data-semgp-holder": "" }),
			);
		}

		// ───────────────────────────── 小组件 ─────────────────────────────

		/** 工具栏上的一个数字。数字和单位同字号，靠字重区分。 */
		function Stat(props) {
			return h("span", null, h("b", null, String(props.value)), " ", props.label);
		}

		/** 一个按钮（或链接样式的按钮）。 */
		function Btn(props) {
			const { children, onClick, disabled, title, href } = props;
			if (href) {
				return h(
					"a",
					{ "data-semgp-btn": "", href, target: "_blank", rel: "noreferrer", title: title ?? undefined },
					children,
				);
			}
			return h(
				"button",
				{
					type: "button",
					"data-semgp-btn": "",
					onClick,
					disabled: disabled === true,
					title: title ?? undefined,
				},
				children,
			);
		}

		/** 一行「标签 + 数值 + 条形」。 */
		function CountRow(props) {
			const { label, value, max, hint } = props;
			const pct = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;
			return h(
				"div",
				{ "data-semgp-chart": "" },
				h(
					"div",
					{ "data-semgp-row": "" },
					h("span", { className: "n" }, label),
					h("span", { className: "d" }, hint ?? String(value)),
				),
				h("div", { "data-semgp-chartbar": "", style: { width: pct + "%" } }),
			);
		}

		// ───────────────────────────── 分析抽屉 ─────────────────────────────

		const TABS = [
			["overview", "analysis.overview"],
			["hubs", "analysis.hubs"],
			["communities", "analysis.communities"],
			["decisions", "analysis.decisions"],
			["timeline", "analysis.timeline"],
		];

		function AnalysisPane(props) {
			const { data, tab } = props;
			if (!data || !data.analysis) {
				return h("div", { "data-semgp-pane": "" }, h("span", { "data-semgp-muted": "" }, T("state.loading")));
			}
			const a = data.analysis;

			if (tab === "overview") {
				const maxType = Math.max(1, ...a.overview.byType.map((t) => t.count));
				const card = (key, value) =>
					h(
						"div",
						{ "data-semgp-card": "", key },
						h("span", { className: "k" }, key),
						h("span", { className: "v" }, String(value)),
					);
				return h(
					"div",
					{ "data-semgp-pane": "" },
					h(
						"div",
						{ "data-semgp-grid": "" },
						card(T("stat.nodes"), a.overview.nodes),
						card(T("stat.edges"), a.overview.edges),
						card(T("analysis.components"), a.overview.components),
						card(T("analysis.isolated"), a.overview.isolated),
					),
					h("strong", null, T("analysis.byType")),
					h(
						"div",
						{ "data-semgp-chart": "" },
						a.overview.byType
							.slice(0, 12)
							.map((t) => h(CountRow, { key: t.type, label: t.type, value: t.count, max: maxType })),
					),
				);
			}

			if (tab === "hubs") {
				const list = (title, rows) =>
					h(
						"div",
						{ "data-semgp-chart": "", key: title },
						h("strong", null, title),
						rows.length === 0
							? h("span", { "data-semgp-muted": "" }, "—")
							: rows.map((r) =>
									h(
										"div",
										{ key: title + r.id, "data-semgp-row": "" },
										h("span", { className: "n" }, r.label),
										h("span", { className: "t" }, r.type),
										h("span", { className: "d" }, String(r.degree)),
									),
								),
					);
				return h(
					"div",
					{ "data-semgp-pane": "" },
					list(T("analysis.byDegree"), a.hubs.byDegree),
					list(T("analysis.byRank"), a.hubs.byRank),
				);
			}

			if (tab === "communities") {
				if (a.communities.length === 0) {
					return h("div", { "data-semgp-pane": "" }, h("span", { "data-semgp-muted": "" }, "—"));
				}
				return h(
					"div",
					{ "data-semgp-pane": "" },
					a.communities.map((c, i) =>
						h(
							"div",
							{ key: "c" + i, "data-semgp-card": "" },
							h("span", { className: "k" }, `${T("analysis.members")} · ${c.size}`),
							h(
								"div",
								null,
								c.members.map((m) =>
									h("span", { key: m.label, "data-semgp-chip": "" }, `${m.label} · ${m.degree}`),
								),
							),
						),
					),
				);
			}

			if (tab === "decisions") {
				if (a.decisions.length === 0) {
					return h(
						"div",
						{ "data-semgp-pane": "" },
						h("span", { "data-semgp-muted": "" }, T("analysis.noDecisions")),
					);
				}
				return h(
					"div",
					{ "data-semgp-pane": "" },
					a.decisions.map((d) =>
						h(
							"div",
							{ key: d.id, "data-semgp-card": "" },
							h("span", { className: "v" }, d.category),
							h("span", null, d.outcome),
							d.scenario ? h("span", { "data-semgp-muted": "" }, d.scenario) : null,
							d.reasoning ? h("span", { "data-semgp-muted": "" }, d.reasoning) : null,
							h(
								"span",
								{ "data-semgp-muted": "" },
								[
									d.maker ? `${T("analysis.maker")}: ${d.maker}` : null,
									d.confidence === null ? null : `${T("analysis.confidence")}: ${d.confidence}`,
									d.at ? d.at.slice(0, 16).replace("T", " ") : null,
								]
									.filter(Boolean)
									.join(" · "),
							),
							d.entities.length > 0
								? h(
										"div",
										null,
										d.entities.map((e) => h("span", { key: e.id, "data-semgp-chip": "" }, e.label)),
									)
								: null,
						),
					),
				);
			}

			// 时间线（决策的写入时间，按天）
			if (a.timeline.length === 0) {
				return h("div", { "data-semgp-pane": "" }, h("span", { "data-semgp-muted": "" }, T("analysis.noDecisions")));
			}
			const max = Math.max(...a.timeline.map((t) => t.count));
			return h(
				"div",
				{ "data-semgp-pane": "" },
				h(
					"div",
					{ "data-semgp-chart": "" },
					a.timeline.map((t) => h(CountRow, { key: t.day, label: t.day, value: t.count, max })),
				),
			);
		}

		// ───────────────────────────── 面板 ─────────────────────────────

		/**
		 * 「知识图谱」视图。
		 *
		 * @param props.sessionId 当前会话 id（核心直接给，见 conversation.view 的 slot 契约）。
		 */
		function GraphView(props) {
			const sessionId = props.sessionId || "";
			const [status, setStatus] = useState(null);
			const [mode, setMode] = useState("conversation");
			const [view, setView] = useState(null);
			const [busy, setBusy] = useState(false);
			const [err, setErr] = useState(null);
			const [drawer, setDrawer] = useState(false);
			const [tab, setTab] = useState("overview");
			const [analysis, setAnalysis] = useState(null);
			const [analysisErr, setAnalysisErr] = useState(null);
			// 走「采用已有 iframe」那条路时没有出图响应，统计数字就从这里补。
			const [fallbackStats, setFallbackStats] = useState(null);
			const [copied, setCopied] = useState(false);

			// 视图键要和 host 那边算的一致（`/view` 里同一个字符串），它决定「沿用已有
			// iframe」还是「重新出图」。末尾的 `v<规则版本>` 是关键：切图规则一变，旧视图
			// 立刻不再匹配，用户重新点开面板就会拿到新图，而不是被沿用下来的旧图骗了。
			const scopeVersion = status && status.scope ? status.scope.version : null;
			const viewKey = mode + ":" + sessionId + ":v" + (scopeVersion ?? "?");

			// —— 状态：图在哪、MCP 配没配、Explorer 依赖齐不齐、可复制的指令 ——
			const [statusDone, setStatusDone] = useState(false);
			useEffect(() => {
				let alive = true;
				setStatusDone(false);
				(async () => {
					try {
						const data = await getJson(
							"/api-semantica/status" + (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""),
						);
						if (alive) setStatus(data);
					} catch (e) {
						if (alive) setStatus({ ok: false, code: e?.code ?? "request-failed", error: String(e?.message ?? e) });
					} finally {
						// 成功失败都算「落地了」——失败时也要放行出图请求，否则面板会卡在空白上，
						// 连「host 半侧没加载」这种提示都出不来。
						if (alive) setStatusDone(true);
					}
				})();
				return () => {
					alive = false;
				};
			}, [sessionId]);

			/**
			 * 出图。
			 *
			 * 宿主里的 iframe 已经指着**同一个视图**时直接沿用，不再请求一次：切标签回来
			 * 不该重新拉一遍 Explorer（那样又要等一两秒）。要重来就点「刷新」。
			 */
			const open = useCallback(
				async (force) => {
					if (!sessionId) {
						setErr({ code: "no-session", error: "拿不到会话 id" });
						return;
					}
					if (!force && frameHost.key === viewKey && frameHost.url) {
						setView((prev) => prev ?? { url: frameHost.url, mode, adopted: true });
						// 采用路径下没调过出图接口，所以没有统计数字 —— 不补的话切回来工具栏
						// 会是一片「—」，看起来像坏了。这里补一次轻量的分析请求（不重启
						// Explorer，也就不影响那个已经活着的 iframe）。
						try {
							const data = await postJson("/api-semantica/analysis", { sessionId, mode });
							if (data.ok === true) setFallbackStats({ stats: data.stats, claim: data.claim });
						} catch {
							// 补不到就保持「—」，不打断已经显示出来的图
						}
						return;
					}
					setBusy(true);
					setErr(null);
					try {
						const data = await postJson("/api-semantica/view", { sessionId, mode });
						if (data.ok === true) {
							setView(data);
							setAnalysis(null);
							setAnalysisErr(null);
						} else {
							setView(null);
							setErr(data);
						}
					} catch (e) {
						setView(null);
						setErr({ ok: false, code: e?.code ?? "request-failed", error: String(e?.message ?? e) });
					} finally {
						setBusy(false);
					}
				},
				[sessionId, mode, viewKey],
			);

			useEffect(() => {
				if (!sessionId) return;
				// 等 status 落地再出图：视图键里的规则版本来自它，不等的话会先按 "?" 出一次、
				// 拿到版本号再出第二次（白启一个 Explorer）。status 失败也算落地（要走错误态）。
				if (!statusDone) return;
				open(false);
			}, [sessionId, viewKey, open, statusDone]);

			// —— 分析：抽屉打开时算一次，切模式/重新出图后重算 ——
			useEffect(() => {
				if (!drawer || !sessionId) return;
				let alive = true;
				(async () => {
					try {
						const data = await postJson("/api-semantica/analysis", { sessionId, mode });
						if (!alive) return;
						if (data.ok === true) {
							setAnalysis(data);
							setAnalysisErr(null);
						} else {
							setAnalysis(null);
							setAnalysisErr(data);
						}
					} catch (e) {
						if (alive) {
							setAnalysis(null);
							setAnalysisErr({ error: String(e?.message ?? e) });
						}
					}
				})();
				return () => {
					alive = false;
				};
			}, [drawer, sessionId, mode, view]);

			// —— 图谱标签里隐藏对话输入框；离开时恢复并藏掉 iframe 宿主 ——
			useEffect(() => {
				setComposerHidden(true);
				return () => {
					setComposerHidden(false);
					hideFrameHost();
				};
			}, []);

			// —— 量一次真 DOM 回报给 host（等布局落定；失败就静默，绝不影响面板）——
			useEffect(() => {
				if (!sessionId) return undefined;
				const timer = setTimeout(() => {
					const diag = collectDiag("mount", { mode, stats, hasView: Boolean(view && view.url) });
					void postJson("/api-semantica/diag", { sessionId, mode, reason: "mount", diag }).catch(() => {});
				}, 600);
				return () => clearTimeout(timer);
			}, [sessionId, mode, Boolean(view && view.url)]);

			const copy = useCallback(async () => {
				const text = (status && status.instruction) || "";
				if (!text) return;
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 1600);
				} catch {
					// 剪贴板不可用（非安全上下文）时把文本留在下面那块 pre 里让用户自己选
					setCopied(false);
				}
			}, [status]);

			const stats = (view && view.stats) || (analysis && analysis.stats) || (fallbackStats && fallbackStats.stats) || null;
			const claim = (view && view.claim) || (analysis && analysis.claim) || (fallbackStats && fallbackStats.claim) || null;
			const kgPath = (status && status.kg && status.kg.path) || "";
			const instruction = (status && status.instruction) || "";
			const mcpMissing = Boolean(status && status.mcp && status.mcp.configured === false);
			const noNodes = Boolean(view && stats && stats.nodes === 0);

			// —— 「每轮自动提取」开关 ——
			//
			// 和会话标题右边那个按钮**共用同一个 hook**：状态从 host 读，翻的时候互相广播，
			// 所以从任何一处点开，两处显示的都是同一个状态。
			const auto = useAutoToggle(
				sessionId,
				status && status.auto ? status.auto.on === true : undefined,
			);
			const autoOn = auto.on === true;
			const autoBusy = auto.busy;
			const flipAuto = auto.flip;
			const statItems = [
				["stat.nodes", stats ? stats.nodes : null],
				["stat.edges", stats ? stats.edges : null],
				["stat.entities", stats ? stats.entities : null],
				["stat.relations", stats ? stats.relations : null],
				["stat.decisions", stats ? stats.decisions : null],
			];

			return h(
				"div",
				{ "data-semgp-root": "" },

				// —— 工具栏 ——
				h(
					"div",
					{ "data-semgp-bar": "" },
					h(
						"div",
						{ "data-semgp-seg": "" },
						h(
							"button",
							{ type: "button", "aria-pressed": mode === "conversation", onClick: () => setMode("conversation") },
							T("mode.conversation"),
						),
						h("button", { type: "button", "aria-pressed": mode === "all", onClick: () => setMode("all") }, T("mode.all")),
					),
					h(
						"span",
						{ "data-semgp-stats": "" },
						statItems.map(([key, value]) => h(Stat, { key, label: T(key), value: value === null ? "—" : value })),
					),
					h("span", { "data-semgp-spacer": "" }),
					h(
						"button",
						{
							type: "button",
							"data-semgp-btn": "",
							"data-semgp-auto": autoOn ? "on" : "off",
							"aria-pressed": autoOn ? "true" : "false",
							title: autoOn ? T("auto.onHint") : T("auto.offHint"),
							disabled: !sessionId || autoBusy,
							onClick: flipAuto,
						},
						autoOn ? `● ${T("auto.on")}` : T("auto.off"),
					),
					h(Btn, { onClick: () => open(true), disabled: busy }, T("action.refresh")),
					h(Btn, { onClick: () => setDrawer((v) => !v) }, drawer ? T("analysis.close") : T("action.analysis")),
					view && view.url ? h(Btn, { href: view.url }, T("action.external")) : null,
					h(Btn, { onClick: copy, disabled: !instruction }, copied ? T("action.copied") : T("action.copy")),
				),

				// —— 路径与归属说明 ——
				h(
					"div",
					{ "data-semgp-sub": "" },
					kgPath ? h("code", { "data-semgp-path": "", title: kgPath }, kgPath) : null,
					claim
						? h(
								"span",
								{ "data-semgp-muted": "" },
								[
									mode === "conversation" ? Tn("state.taggedOnly", claim.tagged) : null,
									claim.byEntity ? Tn("state.claimByEntity", claim.byEntity) : null,
									claim.untagged ? Tn("analysis.untaggedNote", claim.untagged) : null,
								]
									.filter(Boolean)
									.join(" · "),
							)
						: null,
					view && view.ms ? h("span", { "data-semgp-muted": "" }, `${view.ms}ms`) : null,
					// 「新会话默认」：新对话在第一条消息之前没有会话，那时点不到任何按会话的开关，
					// 所以「以后每条新对话都自动提取」只能靠这个默认值 —— 放在这里点一次就够。
					h(
						"button",
						{
							type: "button",
							"data-semgp-btn": "",
							"data-semgp-compact": "",
							title: T("auto.defaultHint"),
							disabled: auto.busy || auto.isDefault === null,
							onClick: auto.flipDefault,
						},
						auto.isDefault === true ? T("auto.defaultOn") : T("auto.defaultOff"),
					),
				),

				mcpMissing ? h("div", { "data-semgp-warn": "" }, T("state.mcpMissing")) : null,

				// —— 主体 ——
				h(
					"div",
					{ "data-semgp-body": "" },
					h(
						"div",
						{ "data-semgp-canvas": "" },
						// 有一张空图时**不**渲染 Explorer —— 一个空画布什么也不解释，
						// 而下面那段提示（本对话还没节点 + 怎么让模型写 + 切到全部）
						// 才是有用的。硬把 iframe 顶上来会把提示盖掉。
						view && view.url && !noNodes
							? h(ExplorerFrame, { url: view.url, viewKey, onRetry: () => open(true) })
							: h(
									"div",
									{ "data-semgp-center": "" },
									busy ? h("div", { "data-semgp-spin": "" }) : null,
									busy ? h("span", null, T("state.loading")) : null,
									!busy && err && err.code === "kg-missing" ? h("strong", null, T("state.noKg")) : null,
									!busy && err && err.code === "kg-missing" ? h("p", null, T("state.noKgHint")) : null,
									!busy && err && err.code === "kg-missing" && instruction ? h("pre", null, instruction) : null,
									!busy && err && err.code === "kg-missing"
										? h(Btn, { onClick: copy }, copied ? T("action.copied") : T("action.copy"))
										: null,
									!busy && err && err.code === "host-missing" ? h("strong", null, T("state.hostMissing")) : null,
									!busy && err && err.code === "host-missing" ? h("p", null, T("state.hostMissingHint")) : null,
									!busy && err && err.code === "explorer-unavailable"
										? h("strong", null, T("state.explorerMissing"))
										: null,
									!busy && err && err.code === "explorer-unavailable" && err.hint
										? h("p", null, err.hint)
										: null,
									!busy && err && !["kg-missing", "explorer-unavailable"].includes(err.code)
										? h("strong", null, err.error || T("state.emptyHint"))
										: null,
									// 「图里有内容、但本对话一个字都没有」——最容易被误读成「图坏了」，
									// 所以单独给一条不同的提示，并直接给一条出路。
									// 「图里有内容、但本对话一个字都没有」—— 最容易被误读成「图坏了」。
									// 主出路是**开那个开关**（开了下一轮模型自己就会写），次要是「全部」。
									!busy && !err && noNodes ? h("strong", null, T("state.noNodes")) : null,
									!busy && !err && noNodes ? h("p", null, T("state.noNodesHint")) : null,
									!busy && !err && noNodes
										? h(
												"div",
												{ "data-semgp-row": "" },
												autoOn
													? h("strong", null, T("auto.turnedOn"))
													: h(
															"button",
															{
																type: "button",
																"data-semgp-btn": "",
																"data-semgp-auto": "off",
																disabled: autoBusy || !sessionId,
																onClick: flipAuto,
															},
															T("auto.ctaOn"),
														),
												h(Btn, { onClick: () => setMode("all") }, T("mode.all")),
											)
										: null,
									!busy && !err && noNodes && !autoOn ? h("p", null, T("auto.ctaHint")) : null,
									!busy && !err && noNodes && instruction ? h("pre", null, instruction) : null,
								),
					),

					drawer
						? h(
								"aside",
								{ "data-semgp-drawer": "" },
								h(
									"header",
									null,
									h("strong", null, T("analysis.title")),
									h("span", { "data-semgp-spacer": "" }),
									analysis && analysis.ms ? h("span", { "data-semgp-muted": "" }, `${analysis.ms}ms`) : null,
									h(Btn, { onClick: () => setDrawer(false) }, T("analysis.close")),
								),
								h(
									"div",
									{ "data-semgp-tabs": "" },
									TABS.map(([id, key]) =>
										h("button", { key: id, type: "button", "aria-pressed": tab === id, onClick: () => setTab(id) }, T(key)),
									),
								),
								analysisErr
									? h(
											"div",
											{ "data-semgp-pane": "" },
											h(
												"span",
												{ "data-semgp-muted": "" },
												`${T("analysis.failed")}：${analysisErr.error ?? ""}`,
											),
										)
									: h(AnalysisPane, { data: analysis, tab }),
							)
						: null,
				),
			);
		}

		// ───────────────────────── 头部入口按钮 ─────────────────────────

		/**
		 * 会话标题右侧的「知识图谱」按钮：切到上面那个视图。
		 *
		 * 核心**没有**程序化切换视图的 API：`openView` 只作为 conversation.view 组件的
		 * prop 传给视图自己，别处拿不到；tab 按钮的 DOM 上也没有 data-id，只有 role=tab
		 * 和文字。要切视图只能按文字找到那个按钮再 click
		 * （已装插件 dsh-context 的「跳转到上下文」用的就是同一招）。
		 *
		 * 这段知识现在没有调用方了 —— 头部那个「打开知识图谱」按钮已经按用户要求去掉，
		 * 用户直接点标签就行。留在注释里，免得以后又要重新踩一遍。
		 */		/** 开关变化时在窗口里广播的事件名（两处入口都在同一个窗口里）。 */
		const AUTO_EVENT = "semgp-auto";

		/**
		 * 读/改「每轮自动提取」开关 —— **两处入口共用这一个 hook**。
		 *
		 * 为什么要共享而不是各管一份：头部按钮和面板工具栏里那个按钮是**同一个开关**。
		 * 各存一份本地 state 的话，从头部点开之后面板里还显示「关」，两个地方自相矛盾。
		 * 所以：状态从 host 读，翻的时候 POST，然后广播一个事件让另一个入口跟着变。
		 *
		 * @param sessionId 会话 id（null 时不发请求，按钮表现为不可用）。
		 * @param fallback 面板已经有 status 时把它带进来，免得等自己的请求回来前先闪一下「关」。
		 */
		function useAutoToggle(sessionId, fallback) {
			const [on, setOn] = useState(typeof fallback === "boolean" ? fallback : null);
			const [isDefault, setIsDefault] = useState(null);
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				if (!sessionId) return undefined;
				let alive = true;
				(async () => {
					try {
						const res = await fetch(`/api-semantica/status?sessionId=${encodeURIComponent(sessionId)}`, {
							headers: { accept: "application/json" },
						});
						const data = await readJson(res);
						// 拿不到就维持「未知」，不装作是关 —— 免得按钮显示的状态是假的
						if (alive && data && data.ok === true && data.auto) {
							setOn(data.auto.on === true);
							setIsDefault(data.auto.default === true);
						}
					} catch {
						// 静默：host 半侧没起来时这个开关本来也用不了
					}
				})();
				const onEvent = (e) => {
					if (!e || !e.detail) return;
					if (e.detail.sessionId === sessionId) setOn(e.detail.on === true);
					// "*" = 默认值变了：没被单独设过的会话跟着变
					if (e.detail.sessionId === "*") setIsDefault(e.detail.on === true);
				};
				window.addEventListener(AUTO_EVENT, onEvent);
				return () => {
					alive = false;
					window.removeEventListener(AUTO_EVENT, onEvent);
				};
			}, [sessionId]);

			const flip = useCallback(async () => {
				if (busy || on === null || !sessionId) return;
				const next = on !== true;
				setBusy(true);
				setOn(next); // 乐观：按钮立刻反映用户意图，失败再翻回来
				try {
					const data = await postJson("/api-semantica/auto", { sessionId, on: next });
					if (data.ok !== true) setOn(!next);
					else announceAuto(sessionId, next);
				} catch {
					setOn(!next);
				} finally {
					setBusy(false);
				}
			}, [busy, on, sessionId]);

			/** 改「新会话默认值」—— 新建对话在第一条消息之前没有会话，只能靠它。 */
			const flipDefault = useCallback(async () => {
				if (busy) return;
				const next = isDefault !== true;
				setBusy(true);
				setIsDefault(next);
				try {
					const data = await postJson("/api-semantica/auto", { default: next });
					if (data.ok !== true) setIsDefault(!next);
					else announceAuto("*", next);
				} catch {
					setIsDefault(!next);
				} finally {
					setBusy(false);
				}
			}, [busy, isDefault]);

			return { on, busy, flip, isDefault, flipDefault };
		}

		/** 广播开关变化（同一个窗口里的另一个入口据此同步）。 */
		function announceAuto(sessionId, on) {
			try {
				window.dispatchEvent(new CustomEvent(AUTO_EVENT, { detail: { sessionId, on } }));
			} catch {
				// 广播不出去只影响另一个入口的即时同步
			}
		}

		/**
		 * 「每轮自动提取」开关。
		 *
		 * 它不做提取（那只能由模型调 MCP 工具完成）—— 它改的是**规则**：打开之后，每次
		 * 组装提示词时 `semantica_directive` 会给模型一段「本轮回复结束前必须写进图谱」的
		 * 强制要求。所以按钮按下去就生效，不需要重启，也不用再往对话里粘指令。
		 *
		 * 会话 id 同样是注册项的 inject 给的（头部槽是 session 作用域）。
		 */
		function AutoButton(props) {
			const sessionId = props.sessionId || "";
			const { on, busy, flip } = useAutoToggle(sessionId);
			const compact = props.compact === true;

			// 输入框那一排这个按钮到底有没有被真界面渲染出来、多大、在哪 —— 我自己看不见
			// 那个窗口，所以让它挂载时自报一次（走已有的诊断通道落盘）。用户报过一次
			// 「按钮在标题那排我够不着」，这条通道就是用来确认新位置真的在的。
			const btnRef = useRef(null);
			useEffect(() => {
				if (!compact) return undefined;
				const timer = setTimeout(() => {
					const el = btnRef.current;
					if (!el) return;
					const r = el.getBoundingClientRect();
					// 注意：collectDiag 只**构造**报告，发请求得调用方自己来（这是上一版的坑：
					// 我只调了它、没发，于是这条自报永远到不了磁盘）。
					const diag = collectDiag("composer-toggle", {
						rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
						visible: r.width > 0 && r.height > 0,
						inComposerSeat: Boolean(el.closest("[data-composer-seat]")),
						seatDisplay: el.closest("[data-composer-seat]")
							? getComputedStyle(el.closest("[data-composer-seat]")).display
							: null,
						text: (el.textContent || "").trim(),
						// 头部有没有残留的插件按钮：既不在面板里、也不在输入框那一排的，
						// 就只可能挂在标题那一排。用户要求那儿一个都不留，所以期望是 []。
						strayButtons: [...document.querySelectorAll("[data-semgp-btn]")]
							.filter((b) => !b.closest("[data-semgp-root]") && !b.closest("[data-composer-seat]"))
							.map((b) => (b.textContent || "").trim()),
					});
					void postJson("/api-semantica/diag", {
						sessionId,
						mode: "composer-toggle",
						reason: "composer-toggle",
						diag,
					}).catch(() => {});
				}, 700);
				return () => clearTimeout(timer);
			}, [compact]);

			const label = compact
				? on === true
					? T("auto.compactOn")
					: T("auto.compactOff")
				: on === true
					? T("auto.on")
					: T("auto.off");
			return h(
				"button",
				{
					type: "button",
					ref: btnRef,
					"data-semgp-btn": "",
					"data-semgp-auto": on === true ? "on" : "off",
					"data-semgp-compact": compact ? "" : undefined,
					"aria-pressed": on === true ? "true" : "false",
					title: on === true ? T("auto.onHint") : T("auto.offHint"),
					disabled: on === null || busy || !sessionId,
					onClick: flip,
				},
				on === true ? `● ${label}` : label,
			);
		}

		// ───────────────────────────── apply ─────────────────────────────

		/**
		 * 本插件依赖的服务。
		 *
		 * 这个数组**不能省**：Cordis 的 ctx 是服务代理，访问未在 inject 里声明的服务属性
		 * 会直接抛 `cannot get property "x" without inject` —— 插件根本加载不起来
		 * （不是降级，是整个条目 apply 失败）。
		 *
		 *   slots  —— ctx.slots.inject / register，注册对话视图 tab 与头部按钮
		 *   locale —— 取当前语言决定用中文还是英文字典。注意快照上的字段是 **active**
		 */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			// 绑定语言：locale 变化时换字典并重渲染。
			//
			// 这里踩过一个坑：locale 服务**没有 current() 方法**，快照上的字段也不叫
			// language / locale —— 它叫 **active**
			// （dsh-client-locale 的 publish() → Object.freeze({ active, locales, revision })）。
			// 早先按 current()/language 去读，两处都取不到，lang 恒为 undefined，
			// 于是字典永远落到 en —— 中文界面下一直显示英文。
			function currentLangId() {
				try {
					const loc = ctx.get("locale");
					if (loc) {
						const snap =
							typeof loc.getLocale === "function"
								? loc.getLocale()
								: typeof loc.getSnapshot === "function"
									? loc.getSnapshot()
									: loc;
						if (typeof snap === "string") return snap;
						const id = snap && (snap.active ?? snap.language ?? snap.locale ?? snap.id);
						if (typeof id === "string" && id) return id;
					}
				} catch {
					// 落到浏览器兜底
				}
				try {
					if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
				} catch {
					// 忽略
				}
				return "";
			}
			function rebind() {
				const id = String(currentLangId()).toLowerCase();
				dict = id.startsWith("zh") ? zh : en;
			}
			rebind();
			ctx.on("locale/change", rebind);

			ensureStyles();

			const VIEW_ID = "semantica-graph";

			// 1) 对话视图 tab —— 本插件的主界面
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: VIEW_ID,
						order: 30,
						locale: NS,
						// thunk：resolveSlotLabel 每次投影都重新求值，所以切语言时 tab 文字跟着变
						label: () => T("tab.title"),
						// 会话 id 从**这里**来，不是从 props 里来。
						//
						// conversation.view 在核心那边声明成 { kind: "list", scope: "session" }，
						// 核心渲染它时只传 { viewRequest, openView, completeViewRequest } 三个
						// props —— 没有 sessionId。会话 id 是走注册项的 inject 下发的：
						// dsh-client-ui-renderer 的 runInject(entry, binding, actions) 会把
						// binding.key（也就是会话 id）当第一个参数传进来。所以这里收回它、
						// 再以 props 的形式交给组件。
						inject: (sessionId) => ({ sessionId }),
					},
					GraphView,
				),
			);

			// 2a) 「每轮自动提取」开关，放在**输入框那一排**右侧。
			//
			// 为什么放这儿：核心那排「上面的部分」（标题 + 标签）是会话级槽，新建对话在
			// 发出第一条消息之前根本没有会话，于是整排都不渲染 —— 用户的原话是「第一次
			// 输入不渲染上面的部分啊，我怎么点」。而输入框这一排就在他打字的地方。
			// 槽位契约见 ui-conversation 的 slots：`conversation.input.right` 是
			// 「Compact controls before the composer submit action」，list/session。
			ctx.slots.inject("conversation.input.right", () =>
				ctx.slots.register(
					{
						name: "conversation.input.right",
						id: "semantica-auto-input",
						order: 40,
						locale: NS,
						inject: (sessionId) => ({ sessionId, compact: true }),
					},
					AutoButton,
				),
			);

			// 这里曾经还注册了会话标题右侧的两个按钮（一个切到上面这个 tab，一个同名开关）。
			// 用户的判词是「上面 header 的按钮都去掉吧……插件只需要 tab 和 input 的开关」，
			// 所以那两处去掉了。少一点侵入是对的：标题那一排是核心的地盘。
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
