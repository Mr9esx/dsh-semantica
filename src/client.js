// src/client.js
//
// dsh-semantica-graph 的浏览器半侧。
//
// 两个贡献点，都注册在**核心包**的槽上，因此不依赖任何第三方插件：
//   1. conversation.view —— 对话顶部标签里的「知识图谱」
//   2. conversation.session.header.actions —— 会话标题右侧的入口按钮，点了切到上面那个标签
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
			"action.open": "打开知识图谱",
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
			"state.emptyHint": "还没有可显示的内容",
			"state.noKg": "这台机器上还没有写过任何知识图谱",
			"state.noKgHint": "图由模型通过 mcp__semantica__ 工具写入。把下面这段指令粘进对话，让它把这次对话抽进去：",
			"state.noNodes": "本对话在图里还没有节点",
			"state.noNodesHint": "图里有别的会话写入的内容。点「复制提取指令」让模型把这次对话也写进去，或者切到「全部」看整张图。",
			"state.taggedOnly": "本对话 {n} 个节点",
			"state.claimByEntity": "按实体边认领 {n} 条决策",
			"state.claimByTime": "按时间认领 {n} 条决策",
			"state.untaggedNote": "图里还有 {n} 个节点没打会话标，只出现在「全部」里",
			"state.hostMissing": "插件的 host 半侧还没加载",
			"state.hostMissingHint":
				"/api-semantica 没有任何路由响应。改过 host 代码（src/index.js 等）需要重启 DSH Desktop；只改浏览器半侧刷新页面即可。",
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
			"action.open": "Open knowledge graph",
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
			"state.emptyHint": "Nothing to show yet",
			"state.noKg": "No knowledge graph has been written on this machine yet",
			"state.noKgHint":
				"The graph is written by the model through the mcp__semantica__ tools. Paste this prompt into the chat:",
			"state.noNodes": "This chat has no nodes in the graph yet",
			"state.noNodesHint":
				"The graph holds other chats' content. Use “Copy extract prompt” to have the model write this one, or switch to “All”.",
			"state.taggedOnly": "{n} nodes in this chat",
			"state.claimByEntity": "{n} decisions claimed by entity edges",
			"state.claimByTime": "{n} decisions claimed by time",
			"state.untaggedNote": "{n} nodes carry no conversation tag (visible under “All”)",
			"state.hostMissing": "The plugin's host half is not loaded",
			"state.hostMissingHint":
				"Nothing answers /api-semantica. Host-side changes (src/index.js etc.) need a DSH Desktop restart; browser-side changes only need a refresh.",
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
[data-semgp-bar]{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.22)}
[data-semgp-sub]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid rgba(128,128,128,.14);color:rgba(128,128,128,.95)}
[data-semgp-spacer]{flex:1 1 auto}
[data-semgp-seg]{display:inline-flex;border:1px solid rgba(128,128,128,.35);border-radius:7px;overflow:hidden}
[data-semgp-seg] button{font-size:12px;line-height:18px;padding:2px 10px;border:0;background:transparent;color:inherit;cursor:pointer}
[data-semgp-seg] button[aria-pressed="true"]{background:rgba(128,128,128,.22);font-weight:600}
[data-semgp-stats]{display:inline-flex;gap:10px;color:rgba(128,128,128,.95)}
[data-semgp-stats] b{font-weight:600;font-size:12px}
[data-semgp-btn]{font-size:12px;line-height:18px;padding:3px 10px;border:1px solid rgba(128,128,128,.35);border-radius:7px;background:transparent;color:inherit;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:5px;font-family:inherit}
[data-semgp-btn]:hover{background:rgba(128,128,128,.14)}
[data-semgp-btn][disabled]{opacity:.5;cursor:default}
[data-semgp-path]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52ch}
[data-semgp-body]{position:relative;flex:1 1 auto;min-height:0;display:flex}
[data-semgp-canvas]{position:relative;flex:1 1 auto;min-width:0;min-height:0}
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
[data-semgp-bar]{height:5px;border-radius:3px;background:rgba(128,128,128,.28)}
[data-semgp-barwrap]{display:flex;flex-direction:column;gap:3px}
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
							h("span", null, T("state.loading")),
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
				{ "data-semgp-barwrap": "" },
				h(
					"div",
					{ "data-semgp-row": "" },
					h("span", { className: "n" }, label),
					h("span", { className: "d" }, hint ?? String(value)),
				),
				h("div", { "data-semgp-bar": "", style: { width: pct + "%" } }),
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
						{ "data-semgp-barwrap": "" },
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
						{ "data-semgp-barwrap": "", key: title },
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
					{ "data-semgp-barwrap": "" },
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

			const viewKey = mode + ":" + sessionId;

			// —— 状态：图在哪、MCP 配没配、Explorer 依赖齐不齐、可复制的指令 ——
			useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const data = await getJson(
							"/api-semantica/status" + (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""),
						);
						if (alive) setStatus(data);
					} catch (e) {
						if (alive) setStatus({ ok: false, code: e?.code ?? "request-failed", error: String(e?.message ?? e) });
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
				open(false);
			}, [sessionId, viewKey, open]);

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
									claim.byTime ? Tn("state.claimByTime", claim.byTime) : null,
									claim.untagged ? Tn("analysis.untaggedNote", claim.untagged) : null,
								]
									.filter(Boolean)
									.join(" · "),
							)
						: null,
					view && view.ms ? h("span", { "data-semgp-muted": "" }, `${view.ms}ms`) : null,
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
							? h(ExplorerFrame, { url: view.url, viewKey })
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
									!busy && !err && noNodes ? h("strong", null, T("state.noNodes")) : null,
									!busy && !err && noNodes ? h("p", null, T("state.noNodesHint")) : null,
									!busy && !err && noNodes ? h(Btn, { onClick: () => setMode("all") }, T("mode.all")) : null,
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
		 * prop 传给视图自己，头部动作槽拿不到；tab 按钮的 DOM 上也没有 data-id，
		 * 只有 role=tab 和文字。所以按文字找那个按钮再 click —— 已装插件
		 * dsh-context 的「跳转到上下文」用的就是同一招。
		 */
		function activateViewTab(label) {
			const tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
			for (const t of tabs) {
				if (t.textContent.trim() !== label) continue;
				if (t.getAttribute("aria-selected") !== "true") t.click();
				return true;
			}
			return false;
		}

		function GraphButton(props) {
			const open = props.openPanel;
			return h(
				"button",
				{
					type: "button",
					"data-semgp-btn": "",
					title: T("action.open"),
					onClick: () => {
						if (typeof open === "function") open();
					},
				},
				T("tab.title"),
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

			// 2) 头部动作按钮：切到上面那个 tab
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: VIEW_ID,
						order: 30,
						locale: NS,
						inject: () => ({
							openPanel: () => activateViewTab(T("tab.title")),
						}),
					},
					GraphButton,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
