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
const CLAIM = { tagged: 30, byEntity: 2, byTime: 2, untagged: 3, totalSemantic: 33 }
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
	prompt: { injected: true, section: 'plugin:semantica-graph' },
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
const requestLog = []
await page.route('**/api-semantica/**', async (route, request) => {
	if (hostMissing) {
		return route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>404</title>not found' })
	}
	const url = request.url()
	requestLog.push(`${request.method()} ${url.split('/api-semantica')[1]} empty=${emptyMode}`)
	const body = JSON.parse(request.postData() || '{}')
	if (url.includes('/status')) return route.fulfill({ json: STATUS })
	if (url.includes('/view')) {
		if (emptyMode) {
			return route.fulfill({
				json: {
					ok: true,
					url: VIEW_URL,
					mode: body.mode,
					key: `${body.mode}:${body.sessionId}`,
					stats: { ...STATS, nodes: 0, edges: 0, entities: 0, relations: 0, decisions: 0 },
					claim: { tagged: 0, byEntity: 0, byTime: 0, untagged: 3, totalSemantic: 33 },
					kg: KG,
					ms: 12,
				},
			})
		}
		return route.fulfill({
			json: { ok: true, url: VIEW_URL, mode: body.mode, key: `${body.mode}:${body.sessionId}`, stats: STATS, claim: CLAIM, kg: KG, ms: 37 },
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
        registered[meta.name] = component;
        specs[meta.name] = meta;
      },
    },
  };
  window.__plugin.apply(ctx);
  window.__view = registered['conversation.view'];
  window.__header = registered['conversation.session.header.actions'];
  window.__specs = specs;
  // 照核心的真实契约组 props：conversation.view 的注册项 inject 会收到会话 id
  // （dsh-client-ui-renderer 的 runInject(entry, binding, actions) → binding.key），
  // 核心自己只额外传 viewRequest / openView / completeViewRequest。
  // **核心不传 sessionId** —— 这里也不传，否则测不出「忘了 inject」这类错。
  const meta = specs['conversation.view'] || {};
  const injected = typeof meta.inject === 'function' ? meta.inject(sessionId) : {};
  const coreProps = { viewRequest: null, openView: () => {}, completeViewRequest: () => {} };
  window.__root = ReactDOM.createRoot(document.getElementById('root'));
  window.__root.render(React.createElement(window.__view, Object.assign({}, coreProps, injected)));
  return Boolean(window.__view);
};
`,
})

const applied = await page.evaluate(() => window.__mount('session-visual-1'))
check('插件 apply() 注册出了 conversation.view', applied === true)

const viewMeta = await page.evaluate(() => {
  const m = (window.__specs || {})['conversation.view'] || {}
  return { id: m.id, order: m.order, label: typeof m.label === 'function' ? m.label() : m.label, hasInject: typeof m.inject === 'function' }
})
check('视图注册项 id/顺序/文案对', viewMeta.id === 'semantica-graph' && viewMeta.order === 30 && viewMeta.label === '知识图谱', JSON.stringify(viewMeta))
check('视图注册项声明了 inject（核心不会把 sessionId 传成 props）', viewMeta.hasInject === true)
check('头部按钮也注册了', await page.evaluate(() => Boolean(window.__header)))

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
		sub: rect('[data-semgp-sub]'),
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
	sub: document.querySelector('[data-semgp-sub]')?.textContent?.replace(/\s+/g, ' ') ?? null,
	hasFrame: Boolean(document.querySelector('[data-semgp-frame-host]')),
	html: document.querySelector('[data-semgp-canvas]')?.innerHTML?.slice(0, 300) ?? null,
}))
console.log(`  · 空态现场：${JSON.stringify(emptyDebug)}\n  · 请求日志（共 ${requestLog.length} 条）：${JSON.stringify(requestLog)}`)
const emptyText = await page.textContent('[data-semgp-center]')
check('空态给的是「本对话还没节点」，不是「图坏了」', emptyText.includes('本对话在图里还没有节点'), emptyText.replace(/\s+/g, ' ').slice(0, 80))
check('空态给出可复制的提取指令', emptyText.includes('Semantica 知识图谱'), emptyText.replace(/\s+/g, ' ').slice(0, 60))
check('空图时不渲染 Explorer（空画布不如一句解释）', emptyDebug.hasFrame === false, `frameHost=${emptyDebug.hasFrame}`)

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

// ── 页面级错误 ──

check('整轮没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

await browser.close()
shell.close()
console.log(failures === 0 ? '\n界面自检全部通过' : `\n界面自检有 ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
