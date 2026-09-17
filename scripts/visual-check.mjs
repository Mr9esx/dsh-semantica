#!/usr/bin/env node
// scripts/visual-check.mjs — 用真浏览器把面板跑起来量一遍（不启动 DSH）。
//
// 为什么要有这个：这个插件最要紧的几件事都是**运行时行为**，读代码看不出来 ——
//
//   · 工具栏文案到底几 px（需求就是 12px，而且是量出来的 12px，不是「设了 12px」）
//   · iframe 宿主能不能活过组件卸载（切标签不重载，这是这块代码唯一真正的难点）
//   · 窄窗口会不会撑出横向滚动条（工具栏是 flex-wrap 的，没量过不算数）
//
// 做法：把 src/client.js 原样塞进一个真 Chromium 页面，配一个假的
// `window.__ModuleLoader__` 和一个假 fetch（三个接口都回固定数据），然后自己渲染。
// 断言全部走 DOM 计算值 —— 不截图、不看图（这个模型读不了图，只能量）。

import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')

const APP = '/Applications/DSH Desktop.app/Contents/Resources/app'
const REACT = join(APP, 'node_modules/react/umd/react.development.js')
const REACT_DOM = join(APP, 'node_modules/react-dom/umd/react-dom.development.js')

let failures = 0
function check(label, ok, detail) {
	if (!ok) failures += 1
	console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── 三份假数据：面板要的就是这三个接口 ──

const STATS = { nodes: 42, edges: 51, entities: 30, relations: 38, decisions: 4, byType: [{ type: 'PRODUCT', count: 20 }] }
// byTime 已经不在了：时间窗兜底认领被删掉（它会把别人的决策算进本对话）
const CLAIM = { tagged: 30, byEntity: 2, untagged: 3, totalSemantic: 33, untaggedDecisions: 2 }
const KG = { path: '/tmp/harness/dsh-semantica-graph/kg.json', mtime: Date.now(), bytes: 4096 }
const VIEW_PATH = '/graph-view'

const ANALYSIS = {
	overview: { ...STATS, components: 2, largestComponent: 40, isolated: 1, communities: 3 },
	hubs: {
		byDegree: [{ id: 'vite', label: 'Vite', type: 'PRODUCT', degree: 9, score: 9 }],
		byRank: [{ id: 'vite', label: 'Vite', type: 'PRODUCT', degree: 9, score: 0.42 }],
	},
	communities: [{ size: 3, members: [{ label: 'Vite', type: 'PRODUCT', degree: 9 }] }],
	decisions: [
		{
			id: 'd1',
			category: '构建工具',
			outcome: '用 vite',
			scenario: '选 vite 还是 webpack',
			reasoning: '冷启动快',
			confidence: 1,
			maker: 'user',
			at: '2026-09-17T10:00:00.000Z',
			entities: [{ id: 'vite', label: 'Vite', type: 'PRODUCT' }],
		},
	],
	timeline: [{ day: '2026-09-17', count: 2 }],
}

const STATUS = {
	ok: true,
	kg: { path: KG.path, exists: true, mtime: KG.mtime, nodes: 42, edges: 51 },
	mcp: { configured: true },
	explorer: { ok: true, version: '0.6.8', python: '/x/python', missing: [], hint: null, running: [] },
	prompt: { injected: true, section: 'plugin:semantica-graph', directive: 'semantica_directive' },
	// 切图规则版本：它进视图键，规则一变旧图就不再被沿用
	scope: { version: 2 },
	instruction: '把这次对话的知识写进 Semantica 知识图谱…',
}

// ── 加载 playwright ──

async function loadPlaywright() {
	const candidates = ['playwright', '/opt/homebrew/lib/node_modules/playwright/index.js']
	for (const c of candidates) {
		try {
			return await import(c)
		} catch {
			// 试下一个
		}
	}
	throw new Error('找不到 playwright（试试 npm i -g playwright）')
}

for (const f of [REACT, REACT_DOM]) {
	if (!existsSync(f)) {
		console.error(`✗ 找不到 ${f} —— 需要 DSH Desktop 的安装路径`)
		process.exit(1)
	}
}

const clientSource = readFileSync(join(PLUGIN, 'src/client.js'), 'utf8')
const pw = await loadPlaywright()
// 全局装的是 CJS 包，ESM import 时导出挂在 default 上 —— 两种形状都接住。
const chromium = pw.chromium ?? pw.default?.chromium
if (!chromium) throw new Error('playwright 里没有 chromium 导出')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1380, height: 820 } })

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)))
page.on('console', (m) => {
	if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`)
})

// 页面得有个真 origin —— 在 about:blank 上 fetch('/api/...') 连 URL 都拼不出来，
// 面板会静默停在空状态（第一版就是栽在这，量出来一片「—」）。
const shell = createServer((req, res) => {
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
	res.end('<!doctype html><html><body style="margin:0"><div id="root" style="height:820px"></div></body></html>')
})
await new Promise((r) => shell.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${shell.address().port}`
// 用真能加载的地址（shell 服务器会回一个文档），这样 iframe 的 load 事件真的会触发 ——
// about:blank#... 上量出来的「加载好了没」不算数。
const VIEW_URL = `${ORIGIN}${VIEW_PATH}`

// 三个接口的假实现。空态那一条靠 Node 侧的 `emptyMode` 切 —— 不在 route 回调里
// 调 page.evaluate（在请求处理中间反过来问页面，容易把自己绕死）。
let emptyMode = false
// hostMissing：模拟「改了 host 代码还没重启」—— 路由不存在，Web 服务器回 404 的 HTML。
let hostMissing = false
// 「每轮自动提取」开关的假后端：/auto 改它，/status 读它
let autoOn = false
// 切图规则版本（假 host 侧的），用来验「规则变了，旧图还能不能被沿用」
let stubScopeVersion = 2
// 开关请求的原始 body（要验「改默认」那一发里没有 sessionId）
const autoBodies = []
let autoDefault = false
// hangMode：/view 给一个「连得上但永远不回应」的地址 —— 用来验「iframe 永远不 load」时
// 面板会不会一直转圈（用户报的就是这个症状）
let hangMode = false
const hangServer = createServer(() => {
	/* 故意不回应：连接挂着 */
})
await new Promise((r) => hangServer.listen(0, '127.0.0.1', r))
const HANG_URL = `http://127.0.0.1:${hangServer.address().port}/`
const requestLog = []
// 面板挂载后会回传一份真 DOM 几何（诊断用），这里收下来顺便当断言素材
const diagBodies = []
await page.route('**/api-semantica/**', async (route, request) => {
	if (hostMissing) {
		return route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>404</title>not found' })
	}
	const url = request.url()
	requestLog.push(`${request.method()} ${url.split('/api-semantica')[1]} empty=${emptyMode}`)
	const body = JSON.parse(request.postData() || '{}')
	if (url.includes('/diag')) {
		diagBodies.push(body)
		return route.fulfill({ json: { ok: true, file: '/tmp/harness/last-diag.json' } })
	}
	if (url.includes('/status'))
		return route.fulfill({
			json: {
				...STATUS,
				scope: { version: stubScopeVersion },
				auto: { on: autoOn, default: autoDefault, explicit: false },
			},
		})
	if (url.includes('/auto')) {
		autoBodies.push(body)
		if (body.default !== undefined) {
			autoDefault = body.default === true
			return route.fulfill({ json: { ok: true, default: autoDefault } })
		}
		autoOn = body.on === true
		return route.fulfill({ json: { ok: true, on: autoOn } })
	}
	if (url.includes('/view')) {
		if (hangMode) {
			return route.fulfill({ json: { ok: true, url: HANG_URL, mode: body.mode, key: `${body.mode}:${body.sessionId}:v${stubScopeVersion}`, stats: STATS, claim: CLAIM, kg: KG, ms: 9 } })
		}
		if (emptyMode) {
			return route.fulfill({
				json: {
					ok: true,
					url: VIEW_URL,
					mode: body.mode,
					key: `${body.mode}:${body.sessionId}:v${stubScopeVersion}`,
					stats: { ...STATS, nodes: 0, edges: 0, entities: 0, relations: 0, decisions: 0 },
					claim: { tagged: 0, byEntity: 0, untagged: 3, totalSemantic: 33, untaggedDecisions: 2 },
					kg: KG,
					ms: 12,
				},
			})
		}
		return route.fulfill({
			json: {
				ok: true,
				url: VIEW_URL,
				mode: body.mode,
				key: `${body.mode}:${body.sessionId}:v${stubScopeVersion}`,
				stats: STATS,
				claim: CLAIM,
				kg: KG,
				ms: 37,
			},
		})
	}
	if (url.includes('/analysis')) return route.fulfill({ json: { ok: true, mode: body.mode, stats: STATS, claim: CLAIM, analysis: ANALYSIS, ms: 21 } })
	return route.fulfill({ json: { ok: false, error: 'unexpected' } })
})

await page.goto(ORIGIN)

// 1) React（UMD，直接从 DSH 的安装目录读进来 —— 和线上同一个版本）
await page.addScriptTag({ content: readFileSync(REACT, 'utf8') })
await page.addScriptTag({ content: readFileSync(REACT_DOM, 'utf8') })

// 2) 假的模块加载器：把 client.js 的 factory 跑起来，exports 挂到 window 上
await page.addScriptTag({
	content: `
window.__view = null;
window.__frameHostLoads = 0;
window.__ModuleLoader__ = {
  load(entry) {
    const shim = (name) => {
      if (name === 'react') return window.React;
      throw new Error('客户端半侧只允许 require("react")，被要求：' + name);
    };
    window.__plugin = entry.factory(shim);
  },
};
`,
})

// 3) 插件本体（原样，未打包）
// 剪贴板桩：navigator.clipboard 在 headless 里没权限，而且它是只读 getter（直接赋值
// 不生效），所以 defineProperty 顶掉它，把写进来的内容记在 window.__copied。
await page.addScriptTag({
  content: `
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__copied = t; } },
    });
  `,
})
await page.addScriptTag({ content: clientSource })

// 4) 造一个假 ctx，走真的 apply()，把注册到槽里的视图组件捞出来
await page.addScriptTag({
	content: `
window.__specs = {};
window.__mount = (sessionId) => {
  const registered = {};
  const specs = {};
  const ctx = {
    logger: { debug() {}, warn() {}, info() {} },
    on() {},
    get: (name) => (name === 'locale' ? { getSnapshot: () => ({ active: 'zh' }) } : undefined),
    slots: {
      inject(name, fn) { fn(); },
      register(meta, component) {
        // 一个槽可以注册多个（插件现在只在 input.right 注册一个，但契约本身是 list）
        (registered[meta.name] ||= []).push(component);
        (specs[meta.name] ||= []).push(meta);
      },
    },
  };
  window.__plugin.apply(ctx);
  window.__view = registered['conversation.view'][0];
  // 头部现在**应该是空的**（用户要求插件别碰标题那一排），所以这里不再假设有注册项
  window.__headers = registered['conversation.session.header.actions'] || [];
  window.__inputRights = registered['conversation.input.right'] || [];
  window.__header = window.__headers[window.__headers.length - 1] ?? null;
  window.__specs = specs;
  window.__specsOf = (name) => specs[name] || [];
  // 照核心的真实契约组 props：conversation.view 的注册项 inject 会收到会话 id
  // （dsh-client-ui-renderer 的 runInject(entry, binding, actions) → binding.key），
  // 核心自己只额外传 viewRequest / openView / completeViewRequest。
  // **核心不传 sessionId** —— 这里也不传，否则测不出「忘了 inject」这类错。
  const meta = (specs['conversation.view'] || [])[0] || {};
  const injected = typeof meta.inject === 'function' ? meta.inject(sessionId) : {};
  const coreProps = { viewRequest: null, openView: () => {}, completeViewRequest: () => {} };
  // 每次都换一个**新的容器**挂：对着同一个 container 反复 createRoot 会报
  // 「container has already been passed to createRoot()」，那噪音会污染「本轮不该有别的报错」。
  const host = document.getElementById('root');
  host.innerHTML = '';
  const el = document.createElement('div');
  host.appendChild(el);
  window.__root = ReactDOM.createRoot(el);
  window.__root.render(React.createElement(window.__view, Object.assign({}, coreProps, injected)));
  return Boolean(window.__view);
};

// 照**真界面**的祖先链挂载。
//
// 为什么非要这一步：原来那个 #root 是 height:820px 的确定高度，百分比链当然传得下去 ——
// 等于把「祖先一定有高度」这个假设抄进了测试，真界面里恰恰不是这样。核心的类是
// Sbj43W_viewArea{flex:1 0 auto;min-height:auto}，而 fake 模式再给它套一层没有确定
// 高度的祖先，就能复现「画布塌成 0、图看不见」。
window.__resetTree = () => {
  try { window.__root?.unmount(); } catch {}
  try { window.__headerRoot?.unmount(); } catch {}
  const host = document.getElementById('root');
  if (host) host.innerHTML = '';
  document.querySelectorAll('[data-semgp-frame-host]').forEach((n) => n.remove());
};

window.__mountReal = (sessionId, options) => {
  const opts = options || {};
  document.getElementById('root').innerHTML = '';
  const div = (style, attrs, kids) => {
    const el = document.createElement('div');
    el.setAttribute('style', style);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const kid of kids || []) el.appendChild(kid);
    return el;
  };
  const tabStrip = div('display:flex;gap:36px;margin-top:4px;padding-left:8px', {}, []);
  tabStrip.setAttribute('role', 'tablist');
  for (const [id, label] of [['chat', '对话'], ['semantica-graph', '知识图谱']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', id === 'chat' ? 'true' : 'false');
    b.textContent = label;
    b.addEventListener('click', () => {
      for (const other of tabStrip.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', String(other === b));
      window.__setActiveView?.(id);
    });
    tabStrip.appendChild(b);
  }
  const headerBtnHost = document.createElement('div');
  const header = div('flex:none;padding:12px 28px 0 20px;border-bottom:1px solid rgba(128,128,128,.2)', {}, [tabStrip, headerBtnHost]);

  const viewArea = div(
    opts.hostile
      ? 'display:block'                       // 祖先给不出确定高度：百分比链断在这里
      : 'display:flex;flex-direction:column;flex:1 0 auto;min-height:auto',
    {},
    [],
  );
  const viewOutlet = div('display:contents', { 'data-slot': 'conversation.view' }, []);
  viewArea.appendChild(viewOutlet);
  const sessionSlot = div('display:contents', { 'data-slot': 'conversation.session' }, [viewArea]);

  // 输入框那一排：核心把 conversation.input.right 渲染在 composer 里（ui-conversation 里是
  // rightItems: renderSlot("conversation.input.right", zone)，zone 没会话时为 undefined）。
  // 这里要照同一个形状造，不然「按钮在输入框那一排」这件事离线根本测不到。
  // 注意：这个文件整段是模板字符串，注释里**不能出现反引号**（会被当成字符串结束）。
  const composerRow = div('display:flex;align-items:center;gap:6px', { 'data-composer-row': '' }, [
    Object.assign(document.createElement('div'), { textContent: '输入框（假）' }),
  ]);
  const inputRightHost = div('display:flex;align-items:center;gap:4px', { 'data-composer-input-right': '' });
  composerRow.appendChild(inputRightHost);
  const seat = div('flex:none;position:sticky;bottom:0;height:120px', { 'data-composer-seat': '' }, [composerRow]);
  const scrollBody = div(
    'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden auto',
    { 'data-conversation-scroll': '' },
    [sessionSlot, seat],
  );
  const rootEl = div('height:100%;display:flex;flex-direction:column;overflow:hidden', { 'data-phase': 'active' }, [header, scrollBody]);
  document.getElementById('root').appendChild(rootEl);

  const specs = window.__specs || {};
  const meta = (specs['conversation.view'] || [])[0] || {};
  const injected = typeof meta.inject === 'function' ? meta.inject(sessionId) : {};
  const coreProps = { viewRequest: null, openView: () => {}, completeViewRequest: () => {} };
  window.__chain = { rootEl, scrollBody, seat, viewArea, viewOutlet, tabStrip };
  // 只有激活的那个视图才渲染（核心传 only: active.id）。默认是「对话」标签，
  // 所以面板默认不挂载 —— 和真界面一致。
  window.__viewRoot = ReactDOM.createRoot(viewOutlet);
  window.__setActiveView = (id) => {
    const wantPanel = id === 'semantica-graph';
    window.__viewRoot.render(
      wantPanel ? React.createElement(window.__view, Object.assign({}, coreProps, injected)) : null,
    );
  };
  window.__setActiveView(opts.panel === true ? 'semantica-graph' : 'chat');
  // 输入框那一排的注册项（每项各自的 inject）
  const inputRightRoot = ReactDOM.createRoot(inputRightHost);
  inputRightRoot.render(
    React.createElement(
      React.Fragment,
      null,
      (window.__specsOf('conversation.input.right') || []).map((m, i) => {
        const Comp = (window.__inputRights || [])[i];
        if (!Comp) return null;
        const rProps = typeof m.inject === 'function' ? m.inject(sessionId) : {};
        return React.createElement(Comp, Object.assign({ key: i }, rProps));
      }),
    ),
  );
  // 头部按钮也照真实契约渲染：每个注册项各自拿到自己的 inject 结果
  // （openPanel 走 inject，开关按钮的 sessionId 也走 inject）
  window.__headerRoot = ReactDOM.createRoot(headerBtnHost);
  window.__headerRoot.render(
    React.createElement(
      React.Fragment,
      null,
      window.__headers.map((Comp, i) => {
        const hMeta = (specs['conversation.session.header.actions'] || [])[i] || {};
        const hProps = typeof hMeta.inject === 'function' ? hMeta.inject(sessionId) : {};
        return React.createElement(Comp, Object.assign({ key: i }, hProps));
      }),
    ),
  );
  return true;
};

// 点标签条上的某个 tab（真的 tab 按钮，不再是我们造的入口）
window.__clickTab = (label) => {
  const t = [...document.querySelectorAll('[role="tablist"] [role="tab"]')].find(
    (x) => (x.textContent || '').trim() === label,
  );
  if (!t) return false;
  t.click();
  return true;
};

// 按文字找按钮并点（开关按钮的文字会随状态变）
window.__clickText = (text) => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes(text));
  if (!btn) return false;
  btn.click();
  return true;
};

// 头部入口按钮：点它应该就等于点标签条上「知识图谱」那个 tab
window.__clickHeaderButton = () => {
  const btn = [...document.querySelectorAll('button')].find(
    (b) => !b.getAttribute('role') && (b.textContent || '').trim() === '知识图谱',
  );
  if (!btn) return false;
  btn.click();
  return true;
};
`,
})

const applied = await page.evaluate(() => window.__mount('session-visual-1'))
check('插件 apply() 注册出了 conversation.view', applied === true)

const viewMeta = await page.evaluate(() => {
  const m = ((window.__specs || {})['conversation.view'] || [])[0] || {}
  return { id: m.id, order: m.order, label: typeof m.label === 'function' ? m.label() : m.label, hasInject: typeof m.inject === 'function' }
})
check('视图注册项 id/顺序/文案对', viewMeta.id === 'semantica-graph' && viewMeta.order === 30 && viewMeta.label === '知识图谱', JSON.stringify(viewMeta))
check('视图注册项声明了 inject（核心不会把 sessionId 传成 props）', viewMeta.hasInject === true)

// 用户要求：「上面 header 的按钮都去掉吧……插件只需要 tab 和 input 的开关」。
// 所以这条断言的是**一个都没注册** —— 插件不碰核心的标题那一排。
const headerMeta = await page.evaluate(() =>
	((window.__specsOf || (() => []))('conversation.session.header.actions') || []).map((m) => m.id),
)
const inputRightMeta = await page.evaluate(() =>
	((window.__specsOf || (() => []))('conversation.input.right') || []).map((m) => ({ id: m.id, inject: typeof m.inject === 'function' })),
)
check('会话标题那一排：插件一个按钮都不注册（用户要求）', headerMeta.length === 0, JSON.stringify(headerMeta))
check('头部没有任何插件按钮可渲染（注册数 0）', (await page.evaluate(() => (window.__headers || []).length)) === 0)

await page.waitForTimeout(400)

// ── 工具栏文案与字号 ──

const toolbarText = await page.textContent('[data-semgp-stats]')
check('统计文案出来了', toolbarText.includes('节点') && toolbarText.includes('42'), toolbarText.replace(/\s+/g, ' ').trim())

const sizes = await page.evaluate(() => {
	const out = {}
	const px = (el) => (el ? getComputedStyle(el).fontSize : null)
	const all = (sel) => [...document.querySelectorAll(sel)]
	const uniq = (arr) => [...new Set(arr.filter(Boolean))]
	out.stats = uniq(all('[data-semgp-stats] span').map(px))
	out.statsNumbers = uniq(all('[data-semgp-stats] b').map(px))
	out.buttons = uniq(all('[data-semgp-btn]').map(px))
	out.segments = uniq(all('[data-semgp-seg] button').map(px))
	out.path = uniq(all('[data-semgp-path]').map(px))
	out.buttonCount = all('[data-semgp-btn]').length
	out.segmentCount = all('[data-semgp-seg] button').length
	return out
})
const twelve = (v) => v.length > 0 && v.every((x) => x === '12px')
check('统计文案 12px（数字与单位同号）', twelve(sizes.stats) && twelve(sizes.statsNumbers), JSON.stringify(sizes.statsNumbers))
check(`按钮文案 12px（${sizes.buttonCount} 个）`, twelve(sizes.buttons), JSON.stringify(sizes.buttons))
check(`分段控件 12px（${sizes.segmentCount} 个）`, twelve(sizes.segments), JSON.stringify(sizes.segments))
check('路径那行 12px 等宽', twelve(sizes.path), JSON.stringify(sizes.path))

// ── iframe 宿主 ──

const frameState = () =>
	page.evaluate(() => {
		const host = document.querySelector('[data-semgp-frame-host]')
		const iframes = document.querySelectorAll('iframe')
		return {
			hostExists: Boolean(host),
			hostDisplay: host ? getComputedStyle(host).display : null,
			hostIn: host && iframes[0] ? host.contains(iframes[0]) : false,
			iframeCount: iframes.length,
			iframeSrc: iframes[0] ? iframes[0].getAttribute('src') : null,
			iframeSandbox: iframes[0] ? iframes[0].getAttribute('sandbox') : null,
			iframeMark: iframes[0] ? iframes[0].getAttribute('data-mark') : null,
			hostRect: host ? host.getBoundingClientRect().width + 'x' + Math.round(host.getBoundingClientRect().height) : null,
			placeholderRect: (() => {
				const p = document.querySelector('[data-semgp-holder]')
				if (!p) return null
				const r = p.getBoundingClientRect()
				return Math.round(r.width) + 'x' + Math.round(r.height)
			})(),
		}
	})

const chain = await page.evaluate(() => {
	const rect = (sel) => {
		const el = document.querySelector(sel)
		if (!el) return null
		const r = el.getBoundingClientRect()
		return `${Math.round(r.width)}x${Math.round(r.height)}`
	}
	const holderEl = document.querySelector('[data-semgp-holder]')
	const hcs = holderEl ? getComputedStyle(holderEl) : null
	return {
		canvasCount: document.querySelectorAll('[data-semgp-canvas]').length,
		holderPosition: hcs ? `${hcs.position} inset=${hcs.inset}` : null,
		root: rect('#root'),
		pluginRoot: rect('[data-semgp-root]'),
		bar: rect('[data-semgp-bar]'),
		info: rect('[data-semgp-info]'),
		body: rect('[data-semgp-body]'),
		canvas: rect('[data-semgp-canvas]'),
		holder: rect('[data-semgp-holder]'),
	}
})
check('高度一路传到了画布（占位元素不是 0 高）', /\d+x[1-9]\d*/.test(chain.holder ?? ''), JSON.stringify(chain))
check(
	'画布容器只有一个（套两层会让 iframe 宿主塌成 0×0，图就看不见了）',
	chain.canvasCount === 1,
	`count=${chain.canvasCount}, holder=${chain.holderPosition}`,
)

const before = await frameState()
check('iframe 宿主在 body 上', before.hostExists && before.hostIn, JSON.stringify({ in: before.hostIn, n: before.iframeCount }))
check('iframe 指向出图接口给的 url', before.iframeSrc === VIEW_URL, String(before.iframeSrc))
check(
	'sandbox 里没有 allow-top-navigation',
	(before.iframeSandbox ?? '').includes('allow-same-origin') && !(before.iframeSandbox ?? '').includes('top-navigation'),
	String(before.iframeSandbox),
)
check('宿主尺寸贴着占位元素', before.hostRect === before.placeholderRect, `${before.hostRect} vs ${before.placeholderRect}`)

// 卸载组件（等价于切到别的标签）—— iframe 必须原地活着，宿主必须隐藏
await page.evaluate(() => {
	document.querySelector('iframe')?.setAttribute('data-mark', 'same-node')
	window.__root.unmount()
})
await page.waitForTimeout(150)
const unmounted = await frameState()
check('卸载后 iframe 还在 DOM 里（没被销毁）', unmounted.iframeCount === 1, `count=${unmounted.iframeCount}`)
check('卸载后宿主被隐藏（不盖住别的界面）', unmounted.hostDisplay === 'none', String(unmounted.hostDisplay))

await page.evaluate(() => window.__mount('session-visual-1'))
await page.waitForTimeout(300)
const remounted = await frameState()
check('切回来还是同一个 iframe 元素（没重载）', remounted.iframeMark === 'same-node' && remounted.iframeCount === 1, `mark=${remounted.iframeMark}, count=${remounted.iframeCount}`)
check('切回来后宿主重新显示', remounted.hostDisplay === 'block', String(remounted.hostDisplay))
await page.waitForTimeout(300)
const statsAfterReturn = (await page.textContent('[data-semgp-stats]')).replace(/\s+/g, ' ')
check(
	'切回来工具栏仍有数字（采用路径要靠补的那次请求填）',
	statsAfterReturn.includes('42') && !statsAfterReturn.includes('—'),
	statsAfterReturn,
)

// ── 横向溢出（工具栏是 flex-wrap 的，窄窗口必须不撑） ──

for (const width of [1380, 1100, 900]) {
	await page.setViewportSize({ width, height: 820 })
	await page.waitForTimeout(120)
	const over = await page.evaluate(() => {
		const el = document.scrollingElement
		const root = document.querySelector('[data-semgp-root]')
		return {
			page: el.scrollWidth - el.clientWidth,
			root: root ? root.scrollWidth - root.clientWidth : 0,
			visibleButtons: [...document.querySelectorAll('[data-semgp-btn]')].filter((b) => b.getBoundingClientRect().width > 0).length,
		}
	})
	check(`宽度 ${width}px 不横向溢出`, over.page <= 1 && over.root <= 1, JSON.stringify(over))
}

// ── 分析抽屉 ──

await page.setViewportSize({ width: 1380, height: 820 })
await page.evaluate(() => {
	const btn = [...document.querySelectorAll('[data-semgp-btn]')].find((b) => b.textContent.trim() === '分析')
	btn.click()
})
await page.waitForTimeout(300)
const drawer = await page.evaluate(() => {
	const aside = document.querySelector('[data-semgp-drawer]')
	if (!aside) return null
	const px = (el) => getComputedStyle(el).fontSize
	return {
		exists: true,
		text: aside.textContent.replace(/\s+/g, ' ').slice(0, 200),
		tabs: [...aside.querySelectorAll('[data-semgp-tabs] button')].map((b) => b.textContent.trim()),
		fontSizes: [...new Set([...aside.querySelectorAll('*')].map(px))],
	}
})
const chartBar = await page.evaluate(() => {
	const el = document.querySelector('[data-semgp-chartbar]')
	return el ? { h: getComputedStyle(el).height, w: Math.round(el.getBoundingClientRect().width) } : null
})
check(
	'图表条还是 5px 细条（和工具栏解耦后那条规则仍然生效）',
	chartBar?.h === '5px' && chartBar.w > 0,
	JSON.stringify(chartBar),
)

check('分析抽屉打得开', Boolean(drawer && drawer.exists))
check('五个标签页都在', Boolean(drawer && drawer.tabs.length === 5), drawer ? drawer.tabs.join('/') : '')
check('概览里算出来的数字进了界面', Boolean(drawer && drawer.text.includes('连通分量')), drawer ? drawer.text.slice(0, 90) : '')
check('抽屉正文字号统一 12px（卡片大数字 13px）', Boolean(drawer && drawer.fontSizes.every((s) => s === '12px' || s === '13px')), drawer ? drawer.fontSizes.join(',') : '')

await page.evaluate(() => {
	const btn = [...document.querySelectorAll('[data-semgp-drawer] [data-semgp-tabs] button')].find((b) => b.textContent.trim() === '决策')
	btn.click()
})
await page.waitForTimeout(200)
const decisionsText = await page.textContent('[data-semgp-drawer] [data-semgp-pane]')
check('决策页签显示了决策内容与关联实体', decisionsText.includes('构建工具') && decisionsText.includes('Vite'), decisionsText.replace(/\s+/g, ' ').slice(0, 80))

// ── 「每轮自动提取」开关 ──
//
// 用户要的是「对话里有个按钮，开了之后每轮都调 MCP」，而且他明确说了位置：
//   「按钮放在 input，第一次输入不渲染上面的部分啊，我怎么点？」
// 所以这里照**真实的两步**验：
//   1. 聊天标签下（此时面板不挂载、输入框可见）：输入框那一排 + 标题右侧两处开关，
//      默认都关，输入框那个是真的被布局出来的（不是 0 高度）；
//   2. 从输入框那一排点开 → 真的 POST /auto → 两处一起变「开」；
//   3. 切到图谱标签（面板这时才挂载）→ 面板工具栏那个读到的也是「开」；顺便验
//      「新会话默认」这个开关 —— 新对话在第一条消息之前没有会话，只能靠它。

await page.evaluate(() => window.__resetTree())
await page.evaluate(() => window.__mountReal('session-visual-1'))
await page.waitForTimeout(900)

const probeToggles = () =>
	page.evaluate(() => ({
		items: [...document.querySelectorAll('[data-semgp-auto]')].map((b) => ({
			where: b.closest('[data-semgp-bar]')
				? 'panel'
				: b.closest('[data-composer-seat]')
					? 'composer'
					: 'unknown',
			state: b.getAttribute('data-semgp-auto'),
			pressed: b.getAttribute('aria-pressed'),
			compact: b.hasAttribute('data-semgp-compact'),
			h: Math.round(b.getBoundingClientRect().height),
			text: (b.textContent || '').trim(),
		})),
	}))

const autoBefore = (await probeToggles()).items
check(
	'聊天标签下只有**输入框那一排**一处开关（头部已经没有了），默认「关」',
	autoBefore.length === 1 &&
		autoBefore[0].where === 'composer' &&
		autoBefore[0].state === 'off' &&
		autoBefore[0].pressed === 'false',
)
{
	const composerBtn = autoBefore.find((b) => b.where === 'composer')
	check(
		'输入框那一排那个真的被布局出来了（有高度，不是 0）',
		composerBtn?.compact === true && composerBtn.h >= 20 && composerBtn.h <= 30,
		JSON.stringify(composerBtn),
	)
}
{
	// 它挂载后会自己报一次几何（我看不见真窗口，只能靠这条通道确认位置）
	const report = diagBodies.find((b) => b?.diag?.reason === 'composer-toggle')
	const extra = report?.diag?.extra
	check(
		'输入框那个开关自报了真几何（在 composer seat 里、可见）',
		Boolean(extra) &&
		extra.visible === true &&
		extra.inComposerSeat === true &&
		extra.rect[3] >= 20 &&
		// 头部一处残留都没有（用户要求）
		Array.isArray(extra.strayButtons) &&
		extra.strayButtons.length === 0,
		JSON.stringify(extra ?? null),
	)
}

// 从**输入框那一排**点（用户报的就是「按钮在标题那排我够不着」）
const autoClicked = await page.evaluate(() => window.__clickText('图谱提取 关'))
await page.waitForTimeout(300)
const autoAfter = (await probeToggles()).items
const autoPosts = requestLog.filter((r) => r.includes('/auto'))
check('点输入框那一排的开关会打开它', autoClicked === true && autoAfter.every((b) => b.state === 'on'), JSON.stringify(autoAfter.map((b) => b.text)))
check(
	'开这一下真的写进了 host（POST /auto，带 sessionId）',
	autoPosts.length === 1 && autoPosts[0].startsWith('POST /auto') && autoBodies[0].sessionId === 'session-visual-1',
	JSON.stringify(autoBodies[0] ?? null),
)
check(
	'点开之后没有冒出别处的按钮（插件只有 tab + 输入框开关这两个面）',
	autoAfter.length === 1 && autoAfter[0].where === 'composer',
	JSON.stringify(autoAfter.map((b) => [b.where, b.text])),
)

// 切到知识图谱标签：面板这时才挂载（核心只渲染激活的视图），它读的是同一个状态
await page.evaluate(() => window.__setActiveView('semantica-graph'))
await page.waitForTimeout(900)
const inPanel = await probeToggles()
const panelBtn = inPanel.items.find((b) => b.where === 'panel')
check(
	'切到图谱标签后面板里那个开关显示的是同一个状态（开）',
	panelBtn?.state === 'on' && panelBtn.pressed === 'true',
	JSON.stringify(panelBtn ?? null),
)

// 「新会话默认」：新对话在第一条消息之前没有会话，那时点不到任何按会话的开关，
// 只能提前把默认设好 —— 这是「第一次输入也能自动提取」的唯一办法。
// 用户问过「新会话默认：关 是啥玩意？」—— 所以文案改成「新对话默认」，并且搬进工具栏
// 挨着「每轮提取」，让它一眼看出是一对。
const defaultInfo = await page.evaluate(() => {
	const b = document.querySelector('[data-semgp-default]');
	if (!b) return null;
	return {
		text: (b.textContent || '').trim(),
		inBar: Boolean(b.closest('[data-semgp-bar]')),
		inInfo: Boolean(b.closest('[data-semgp-info]')),
		hint: b.getAttribute('title') || '',
	};
})
check(
	'「新对话默认」开关在工具栏那一行里，文案说人话',
	defaultInfo?.text === '新对话默认：关' && defaultInfo.inBar === true && defaultInfo.inInfo === false,
	JSON.stringify(defaultInfo),
)
check(
	'它有解释自己是什么的 tooltip（用户问过「这是啥玩意」）',
	(defaultInfo?.hint || '').includes('新对话') && (defaultInfo?.hint || '').includes('第一条消息'),
	(defaultInfo?.hint || '').slice(0, 40),
)
await page.evaluate(() => document.querySelector('[data-semgp-default]').click())
await page.waitForTimeout(300)
const defaultAfter = {
	label: await page.evaluate(() => (document.querySelector('[data-semgp-default]')?.textContent || '').trim()),
	// requestLog 在 Node 侧，不能在 page.evaluate 里读（那边没有这个变量）
	posted: requestLog.filter((r) => r.includes('/auto')).length,
}
check(
	'点默认开关会写成 POST /auto {default:true}，并变成「开」',
	defaultAfter.label === '新对话默认：开' && defaultAfter.posted === 2,
	JSON.stringify(defaultAfter),
)
check(
	'「改默认」那一发的请求体只有 default（不带 sessionId）',
	autoBodies.length === 2 && autoBodies[1].default === true && autoBodies[1].sessionId === undefined,
	JSON.stringify(autoBodies),
)
await page.evaluate(() => document.querySelector('[data-semgp-default]').click())
await page.waitForTimeout(200)

// ── 路径：点击复制，而且不许单独占一行 ──
const pathInfo = await page.evaluate(() => {
	const b = document.querySelector('[data-semgp-path]');
	if (!b) return null;
	const r = b.getBoundingClientRect();
	return {
		tag: b.tagName,
		inBar: Boolean(b.closest('[data-semgp-bar]')),
		inInfo: Boolean(b.closest('[data-semgp-info]')),
		title: b.getAttribute('title') || '',
		h: Math.round(r.height),
		cursor: getComputedStyle(b).cursor,
	};
})
check(
	'图文件路径在工具栏里、和说明同一组（不是单独一行），是个可点的按钮',
	pathInfo?.tag === 'BUTTON' && pathInfo.inBar === true && pathInfo.inInfo === true && pathInfo.h >= 18,
	JSON.stringify(pathInfo),
)
check(
	'路径按钮的 tooltip 里有完整路径和「点击复制」',
	pathInfo.title.includes('/') && pathInfo.title.includes('复制'),
	pathInfo.title,
)
check('路径按钮的鼠标光标是 copy（一眼看得出能复制）', pathInfo.cursor === 'copy', String(pathInfo.cursor))

await page.evaluate(() => document.querySelector('[data-semgp-path]').click())
await page.waitForTimeout(250)
const copied = await page.evaluate(() => ({
	text: window.__copied,
	label: (document.querySelector('[data-semgp-path]')?.textContent || '').trim(),
}))
check(
	'点路径真的把完整路径复制到剪贴板了',
	typeof copied.text === 'string' && copied.text.endsWith('/kg.json') && copied.text.includes('dsh-semantica-graph'),
	String(copied.text),
)
check('复制成功后按钮上出现「已复制」', copied.label === '已复制', copied.label)

// ── 样式：工具栏 + iframe 都是卡片（边框 + 8px 圆角），面板内容 16px 内边距 ──
const panelStyle = await page.evaluate(() => {
	const cs = (el) => (el ? getComputedStyle(el) : null);
	const root = cs(document.querySelector('[data-semgp-root]'));
	const bar = cs(document.querySelector('[data-semgp-bar]'));
	const host = cs(document.querySelector('[data-semgp-frame-host]'));
	return {
		rootPad: root?.padding,
		barBorder: bar ? [bar.borderTopWidth, bar.borderTopStyle].join(' ') : null,
		barRadius: bar?.borderRadius,
		hostBorder: host ? [host.borderTopWidth, host.borderTopStyle].join(' ') : null,
		hostRadius: host?.borderRadius,
		hostOverflow: host?.overflow,
	};
})
check('面板内容 padding 是 16px', panelStyle.rootPad === '16px', String(panelStyle.rootPad))

// 布局体检：我看不了图（当前模型不吃图），所以把「难不难看」里能量化的都量掉 ——
// 工具栏有没有挤成两行、子元素有没有溢出、内容有没有真的从 16px 内边距开始。
const layout = await page.evaluate(() => {
	const root = document.querySelector('[data-semgp-root]');
	const bar = document.querySelector('[data-semgp-bar]');
	const body = document.querySelector('[data-semgp-body]');
	const canvas = document.querySelector('[data-semgp-canvas]');
	const info = document.querySelector('[data-semgp-info]');
	// 注意：DOMRect 跨 page.evaluate 传回来会变成 {}（属性在原型上，序列化丢光），
	// 所以这里当场摊平成普通数字。
	const r = (el) => {
		if (!el) return null;
		const b = el.getBoundingClientRect();
		return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height };
	};
	const overflow = (el) => {
		if (!el) return null;
		const b = el.getBoundingClientRect();
		let worst = 0;
		for (const kid of el.children) {
			const k = kid.getBoundingClientRect();
			worst = Math.max(worst, k.right - b.right, k.bottom - b.bottom, b.left - k.left);
		}
		return Math.round(worst);
	};
	return {
		rootRect: r(root),
		barRect: r(bar),
		barOverflow: overflow(bar),
		barKids: bar ? bar.children.length : 0,
		infoOverflow: overflow(info),
		bodyTop: r(body)?.top ?? null,
		barBottom: r(bar)?.bottom ?? null,
		canvasH: Math.round(r(canvas)?.h ?? 0),
		canvasRight: Math.round(r(canvas)?.right ?? 0),
		rootRight: Math.round(r(root)?.right ?? 0),
	};
})
check(
	'工具栏是**一行**（用户明确要求，不许拆成两行）',
	layout.barRect.h <= 44,
	JSON.stringify({ h: layout.barRect.h, kids: layout.barKids }),
)
check(
	'工具栏卡片到 iframe 的间距只有 root 那 10px，中间不再夹着别的行',
	layout.bodyTop !== null && layout.barBottom !== null && Math.round(layout.bodyTop - layout.barBottom) === 10,
	JSON.stringify({ barBottom: Math.round(layout.barBottom), bodyTop: Math.round(layout.bodyTop), gap: Math.round(layout.bodyTop - layout.barBottom) }),
)
// 窗口窄一点也还是一行：说明会收成省略号，而不是掉到第二行
{
	await page.setViewportSize({ width: 1100, height: 820 })
	await page.waitForTimeout(300)
	const narrow = await page.evaluate(() => {
		const bar = document.querySelector('[data-semgp-bar]');
		const info = document.querySelector('[data-semgp-info]');
		return {
			barH: Math.round(bar.getBoundingClientRect().height),
			infoW: Math.round(info.getBoundingClientRect().width),
			infoText: (info.textContent || '').trim().slice(0, 24),
			pathShown: (document.querySelector('[data-semgp-path]')?.textContent || '').trim(),
		};
	})
	check(
		'窗口缩到 1100px，工具栏仍然是**一行**（说明被压缩，没有掉下去）',
		narrow.barH <= 44 && narrow.infoW > 40,
		JSON.stringify(narrow),
	)
	await page.setViewportSize({ width: 1380, height: 820 })
	await page.waitForTimeout(300)
}
{
	// 信息组必须和按钮在**同一行**：它的上下边不能跑到工具栏之外
	const rowFit = await page.evaluate(() => {
		const bar = document.querySelector('[data-semgp-bar]').getBoundingClientRect();
		const info = document.querySelector('[data-semgp-info]').getBoundingClientRect();
		return { infoTop: info.top - bar.top, infoBottom: bar.bottom - info.bottom, barH: bar.height };
	})
	check(
		'说明和路径确实在工具栏那一行里（上下都没被挤出去）',
		rowFit.infoTop >= 0 && rowFit.infoBottom >= 0,
		JSON.stringify(rowFit),
	)
}
check(
	'工具栏里的子元素没有溢出它的盒子',
	layout.barOverflow !== null && layout.barOverflow <= 1,
	String(layout.barOverflow),
)
check(
	'主体紧跟在工具栏下面，没有叠在一起',
	layout.bodyTop !== null && layout.barBottom !== null && layout.bodyTop >= layout.barBottom,
	JSON.stringify({ barBottom: Math.round(layout.barBottom), bodyTop: Math.round(layout.bodyTop) }),
)
check(
	'内容确实从 16px 内边距里开始、右边也留出 16px',
	Math.abs(layout.barRect.left - (layout.rootRect.left + 16)) <= 1 &&
		Math.abs(layout.rootRight - layout.canvasRight - 16) <= 1,
	JSON.stringify({ barLeft: Math.round(layout.barRect.left), rootLeft: Math.round(layout.rootRect.left), gapRight: Math.round(layout.rootRight - layout.canvasRight) }),
)

// 一行里的分组：看哪个图 [模式 统计] → 这是什么/在哪 [说明 路径] ┊ 开关 ┊ 操作
const barOrder = await page.evaluate(() =>
	[...document.querySelector('[data-semgp-bar]').children].map((el) => {
		for (const k of ['info', 'auto', 'default', 'div', 'seg', 'stats', 'spacer']) {
			if (el.hasAttribute('data-semgp-' + k)) return k;
		}
		return (el.textContent || '').trim();
	}),
)
check(
	'工具栏一行分三段：图+统计 → 说明+路径 ┊ 写图开关 ┊ 操作',
	barOrder.join(' ') === 'seg stats info div auto default div 刷新 分析 在浏览器打开 复制提取指令',
	JSON.stringify(barOrder),
)
const infoOrder = await page.evaluate(() =>
	[...document.querySelector('[data-semgp-info]').children].map((el) =>
		el.hasAttribute('data-semgp-path') ? 'path' : (el.textContent || '').trim().slice(0, 12),
	),
)
check(
	'信息组里是「归属说明 + 耗时 + 路径」，路径在最后（它是信息，不是操作）',
	infoOrder.at(-1) === 'path' && infoOrder.length >= 2,
	JSON.stringify(infoOrder),
)
check(
	'工具栏带 1px 边框 + 8px 圆角',
	panelStyle.barBorder === '1px solid' && panelStyle.barRadius === '8px',
	JSON.stringify({ border: panelStyle.barBorder, radius: panelStyle.barRadius }),
)
check(
	'iframe 容器也是 1px 边框 + 8px 圆角，而且 overflow:hidden 把直角裁掉',
	panelStyle.hostBorder === '1px solid' &&
		panelStyle.hostRadius === '8px' &&
		panelStyle.hostOverflow === 'hidden',
	JSON.stringify(panelStyle),
)

// 关回去，别影响后面的用例
await page.evaluate(() => window.__clickText('每轮提取：开'))
await page.waitForTimeout(250)

// ── 空态：「图里有内容、本对话一个字都没有」 ──

emptyMode = true
await page.evaluate(() => {
	window.__root.unmount()
	document.querySelectorAll('[data-semgp-frame-host]').forEach((n) => n.remove())
})
await page.evaluate(() => window.__mount('session-visual-empty'))
await page.waitForTimeout(1200)
const emptyDebug = await page.evaluate(() => ({
	centerText: document.querySelector('[data-semgp-center]')?.textContent?.slice(0, 60) ?? null,
	canvasText: document.querySelector('[data-semgp-canvas]')?.textContent?.replace(/\s+/g, ' ').slice(0, 120) ?? null,
	stats: document.querySelector('[data-semgp-stats]')?.textContent?.replace(/\s+/g, ' ') ?? null,
	info: document.querySelector('[data-semgp-info]')?.textContent?.replace(/\s+/g, ' ') ?? null,
	hasFrame: Boolean(document.querySelector('[data-semgp-frame-host]')),
	html: document.querySelector('[data-semgp-canvas]')?.innerHTML?.slice(0, 300) ?? null,
}))
console.log(`  · 空态现场：${JSON.stringify(emptyDebug)}\n  · 请求日志（共 ${requestLog.length} 条）：${JSON.stringify(requestLog)}`)
const emptyText = await page.textContent('[data-semgp-center]')
check('空态给的是「本对话还没节点」，不是「图坏了」', emptyText.includes('本对话在图里还没有节点'), emptyText.replace(/\s+/g, ' ').slice(0, 80))
check('空态给出可复制的提取指令', emptyText.includes('Semantica 知识图谱'), emptyText.replace(/\s+/g, ' ').slice(0, 60))
check('空图时不渲染 Explorer（空画布不如一句解释）', emptyDebug.hasFrame === false, `frameHost=${emptyDebug.hasFrame}`)
check(
	'空态的主出路是「开开关」，而且文案是翻译过的（不是 auto.ctaOn 这种键名）',
	(emptyDebug.canvasText || '').includes('开启每轮自动提取') && !(emptyDebug.canvasText || '').includes('auto.'),
	(emptyDebug.canvasText || '').slice(0, 60),
)
emptyMode = false // 切回「有内容」，后面的阶段不该继承空态

// ── Explorer 连得上但永远不回应 ──
//
// 用户报的「点开知识图谱，一直提示打开中」就是这个形状：iframe 指向的端口不会回任何
// 东西，load 事件永远不来。以前没有上限，遮罩就永远挂在那儿；现在 15 秒后必须换成
// 一句人话加一个「重试」。

hangMode = true
await page.evaluate(() => window.__resetTree())
await page.evaluate(() => window.__mount('session-visual-hang'))
await page.evaluate(() => window.__mountReal('session-visual-hang', { panel: true }))
await page.waitForTimeout(900)
const hangEarly = await page.textContent('[data-semgp-center]')
check('挂住时先是「正在打开图…」', hangEarly.includes('正在打开图'), hangEarly.replace(/\s+/g, ' ').slice(0, 40))

await page.waitForTimeout(16000) // 越过 LOAD_TIMEOUT_MS（15s）
const hangLate = await page.evaluate(() => ({
	text: document.querySelector('[data-semgp-center]')?.textContent?.replace(/\s+/g, ' ') ?? null,
	hasRetry: [...document.querySelectorAll('[data-semgp-center] button')].some((b) => (b.textContent || '').includes('重试')),
}))
check('超时后不再转圈，而是说明 + 重试', Boolean(hangLate.text?.includes('图没打开')) && hangLate.hasRetry === true, JSON.stringify(hangLate))
hangMode = false

// ── host 半侧没加载时（改了 host 代码还没重启 DSH）要说人话 ──
//
// 这条最容易被忽略：路由不存在时 Web 服务器回的是 HTML，直接 res.json() 会报
// 「Unexpected token '<'」，用户既看不懂也不知道该重启。

// 这一段故意让三个接口回 404，浏览器必然打两条 "Failed to load resource" 控制台记录 ——
// 那是这段测试自己造的噪音，不该记到「整轮没有 JS 报错」头上。所以这里标个起点，
// 断言完把这段的噪音摘掉。
const noiseStart = pageErrors.length
hostMissing = true
await page.evaluate(() => {
	window.__root.unmount()
	document.querySelectorAll('[data-semgp-frame-host]').forEach((n) => n.remove())
})
// 换一个会话 id：同 id 会走「采用已有 iframe」的捷径（那个 iframe 还活着），
// 就测不到「接口根本不存在」这条路径了。
await page.evaluate(() => window.__mount('session-visual-hostmissing'))
await page.waitForTimeout(500)
// 不用 page.textContent（它会等元素出现，等不到就 30 秒超时），这里容错读一次
const hostMissingProbe = await page.evaluate(() => ({
	text: document.querySelector('[data-semgp-center]')?.textContent ?? '',
	rootHtml: (document.getElementById('root')?.innerHTML ?? '').slice(0, 200),
	barText: document.querySelector('[data-semgp-bar]')?.textContent?.replace(/\s+/g, ' ') ?? null,
}))
console.log(`  · host 缺失现场：${JSON.stringify(hostMissingProbe)}`)
const hostMissingText = hostMissingProbe.text
check('host 没加载时给出可照做的提示', hostMissingText.includes('host 半侧还没加载') && hostMissingText.includes('重启 DSH Desktop'), hostMissingText.replace(/\s+/g, ' ').slice(0, 70))
hostMissing = false
{
	const phaseErrors = pageErrors.splice(noiseStart)
	check(
		'host 缺失这一段只该有 404 噪音，没有别的报错',
		phaseErrors.every((e) => e.includes('404')),
		phaseErrors.join(' | ') || '（无）',
	)
}

// ── 切图规则改版之后，旧图不能再被沿用 ──
//
// Explorer 启动时只读一次图，前端切标签回来还会沿用已有的 iframe。所以「规则改了」
// 如果只改代码，用户重新点开面板看到的还是旧规则切出来的图 —— 会以为 bug 没修。
// 视图键里带规则版本就是为了这个。这里验一对反例：
//   同版本重挂 → 沿用（不再发第二次出图请求）；版本变了 → 必须重新出图。

// 先出一次图（这一次本来就要请求），再重挂同一个会话：这一次该沿用，不该再请求
await page.evaluate(() => window.__resetTree())
await page.evaluate(() => window.__mountReal('session-visual-1', { panel: true }))
await page.waitForTimeout(1100)
const beforeAdopt = requestLog.filter((r) => r.includes('/view')).length
await page.evaluate(() => window.__resetTree())
await page.evaluate(() => window.__mountReal('session-visual-1', { panel: true }))
await page.waitForTimeout(1100)
const afterAdopt = requestLog.filter((r) => r.includes('/view')).length
check('同版本重挂时沿用已有的图（不重复起 Explorer）', afterAdopt === beforeAdopt, `${beforeAdopt} → ${afterAdopt}`)

stubScopeVersion = 3
await page.evaluate(() => window.__resetTree())
await page.evaluate(() => window.__mountReal('session-visual-1', { panel: true }))
await page.waitForTimeout(1100)
const afterVersionBump = requestLog.filter((r) => r.includes('/view')).length
check(
	'切图规则版本一变，必须重新出图（不然用户看到的还是旧规则的图）',
	afterVersionBump > afterAdopt,
	`${afterAdopt} → ${afterVersionBump}`,
)
stubScopeVersion = 2

// ══ 第二阶段：照真界面祖先链重挂一次 ══
//
// 第一阶段的 #root 是 height:820px 的确定高度 —— 百分比链当然传得下去。真界面里
// .viewArea 是 flex:1 0 auto; min-height:auto，所以这里必须换成真的链子，否则
// 「工具栏被压扁」「画布塌成 0」这类问题离线永远测不出来。

await page.evaluate(() => {
	try {
		window.__root.unmount()
		window.__headerRoot?.unmount()
	} catch {
		/* 卸载失败不影响后面的重挂 */
	}
})
await page.evaluate(() => window.__mountReal('session-visual-1', { panel: true }))
await page.waitForTimeout(1200)

const real = await page.evaluate(() => {
	const q = (sel) => document.querySelector(sel)
	const cs = (el) => (el ? getComputedStyle(el) : null)
	const rect = (el) => {
		if (!el) return null
		const r = el.getBoundingClientRect()
		return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }
	}
	const bar = q('[data-semgp-bar]')
	const canvas = q('[data-semgp-canvas]')
	const root = q('[data-semgp-root]')
	const seat = q('[data-composer-seat]')
	const scroll = q('[data-conversation-scroll]')
	const barRect = bar?.getBoundingClientRect()
	return {
		bar: rect(bar),
		barBg: cs(bar)?.backgroundColor ?? null,
		barMinHeight: cs(bar)?.minHeight ?? null,
		// 子元素底边超出工具栏底边多少 —— 压扁了就会是个正数
		barChildOverflow: barRect
			? Math.round(Math.max(...[...bar.children].map((c) => c.getBoundingClientRect().bottom)) - barRect.bottom)
			: null,
		canvas: rect(canvas),
		canvasMinHeight: cs(canvas)?.minHeight ?? null,
		rootRect: rect(root),
		viewArea: rect(q('[data-slot="conversation.view"]')?.parentElement),
		holder: rect(q('[data-semgp-holder]')),
		hostDisplay: cs(q('[data-semgp-frame-host]'))?.display ?? null,
		hostHost: rect(document.querySelector('[data-semgp-frame-host]')),
		seatDisplay: cs(seat)?.display ?? null,
		hideAttr: scroll?.hasAttribute('data-semgp-hide-composer') ?? null,
		chartBarH: cs(q('[data-semgp-chartbar]'))?.height ?? null,
	}
})

check('工具栏没有被压扁（曾经有同名规则把 height 改成 5px、底色改灰）', real.bar.h >= 20 && real.barBg === 'rgba(0, 0, 0, 0)', JSON.stringify({ h: real.bar.h, bg: real.barBg }))
check('工具栏的子元素不溢出它的盒子', real.barChildOverflow !== null && real.barChildOverflow <= 2, String(real.barChildOverflow))
check('画布在真祖先链下拿到了高度，不是 0', real.canvas.h >= 200, JSON.stringify({ canvas: real.canvas, viewArea: real.viewArea }))
check('面板铺满视图区', Math.abs(real.rootRect.h - real.viewArea.h) <= 2, JSON.stringify({ root: real.rootRect, viewArea: real.viewArea }))
check('iframe 宿主跟着画布，不再是 0×0', real.hostHost.w >= 200 && real.hostHost.h >= 200, JSON.stringify(real.hostHost))
check('图谱标签下输入框被藏住（不然还能操作背后的对话）', real.hideAttr === true && real.seatDisplay === 'none', JSON.stringify({ hideAttr: real.hideAttr, seatDisplay: real.seatDisplay }))

// 打开面板的唯一入口现在是**标签本身**（头部按钮已按用户要求去掉）
const clicked = await page.evaluate(() => window.__clickTab('知识图谱'))
await page.waitForTimeout(500)
const tabState = await page.evaluate(() =>
	[...document.querySelectorAll('[role="tab"]')].map((t) => ({ text: t.textContent, selected: t.getAttribute('aria-selected') })),
)
check(
	'点「知识图谱」标签能切过去，并且面板挂载出来',
	clicked === true &&
		tabState.some((t) => t.text === '知识图谱' && t.selected === 'true') &&
		(await page.evaluate(() => Boolean(document.querySelector('[data-semgp-root]')))),
	JSON.stringify(tabState),
)

// 诊断通道：面板把自己量到的真 DOM 回传了（host 会落成 last-diag.json）
const diag = diagBodies.at(-1)?.diag
check('面板回传了真 DOM 几何（诊断通道）', Boolean(diag && Array.isArray(diag.chain) && diag.chain.length >= 2), JSON.stringify({ chain: diag?.chain?.length, reason: diag?.reason }))
check(
	'诊断里带了滚动容器 / 输入框 / 是否隐藏的状态',
	Boolean(diag?.scroll && diag.scroll.hideComposerAttr !== undefined && diag.seat && diag.cssLoaded === true),
	JSON.stringify({ hide: diag?.scroll?.hideComposerAttr, seat: diag?.seat?.tag, css: diag?.cssLoaded }),
)

// ── 第三阶段：祖先给不出确定高度时，图也不能消失 ──
await page.evaluate(() => {
	try {
		window.__root.unmount()
	} catch {
		/* ignore */
	}
})
await page.evaluate(() => window.__mountReal('session-visual-1', { hostile: true, panel: true }))
await page.waitForTimeout(900)
const hostile = await page.evaluate(() => {
	const rect = (sel) => {
		const el = document.querySelector(sel)
		if (!el) return null
		const r = el.getBoundingClientRect()
		return { w: Math.round(r.width), h: Math.round(r.height) }
	}
	return { canvas: rect('[data-semgp-canvas]'), host: rect('[data-semgp-frame-host]'), minH: getComputedStyle(document.querySelector('[data-semgp-canvas]')).minHeight }
})
check('祖先给不出高度时画布仍有下限高度（保命，不是靠运气）', hostile.canvas.h >= 280 && hostile.minH === '280px', JSON.stringify(hostile))

// ── 页面级错误 ──

check('整轮没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

if (process.env.SEMGP_SHOT) {
	// 截一张真图看样式 —— 断言能量尺寸和颜色，量不出「难不难看」
	await page.evaluate(() => window.__setActiveView('semantica-graph'))
	await page.waitForTimeout(1200)
	const shot = await page.$('[data-semgp-root]')
	if (shot) await shot.screenshot({ path: process.env.SEMGP_SHOT })
	console.log('截图已存：' + process.env.SEMGP_SHOT)
}

await browser.close()
shell.close()
console.log(failures === 0 ? '\n界面自检全部通过' : `\n界面自检有 ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
