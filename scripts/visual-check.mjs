// scripts/visual-check.mjs — 用真 Chromium 渲染控制面板，量排版 + 出截图
//
// 为什么需要它（它抓出过一个真 bug）：
//
// 布局改版那次，`.semg-toolbar-actions` 写成了 `flex:0 0 auto`。这个简写的
// flex-basis 取的是 **auto**，也就是内容宽度（八个按钮约 625px）。它自己不收缩，
// 于是内部的 `flex-wrap` 永远不触发 —— 在 300px 的侧边栏里横向溢出 315px，
// 按钮被裁掉一半。所有单元测试都是绿的，因为 renderToString 只吐 HTML 字符串，
// 不含任何几何信息。
//
// 所以：**涉及排版就必须在真浏览器里量。** 这个脚本就是干这个的。
//
// 另外它还会验证 iframe 里真的渲染出了 Explorer（跨源 + sandbox 下有没有白屏）——
// 那是 `allow-same-origin` 缺失时会踩的坑。
//
// 用法：
//   node scripts/visual-check.mjs                 # Explorer 用 about:blank 占位
//   node scripts/visual-check.mjs http://127.0.0.1:56513   # 用真的 Explorer
//
// 依赖：playwright（全局装即可）+ DSH Desktop 的 React UMD。
// 两者缺一就跳过，不让它拦住 CI。

import { createRequire } from 'node:module'
import { readFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const APP = '/Applications/DSH Desktop.app/Contents/Resources/app'
const OUT = join(REPO, 'tmp-visual')

const EXPLORER = process.argv[2] || 'about:blank'
// graphPath 用真实的完整路径（~100 字符）—— 路径 chip 是最容易把工具栏撑宽的
// 元素，用短假路径测等于没测。
const STATS = {
  nodes: 2186,
  edges: 2737,
  entities: 226,
  relations: 253,
  elapsed: 24.8,
  engine: { semantica: '0.6.8', python: '3.12' },
  graphPath:
    '/Users/mr9esx/Library/Application Support/dsh-desktop/harness/dsh-semantica-graph/session-c4f2f73e-08ac-44f7-a6a8-050f4917b740.json',
}

// 侧边栏实际可能的宽度区间
// 600 单列出来：那是插件自动加宽后的真实面板宽度（better-sidebar 出厂是 483）。
// 面板现在铺满整个对话视图区，不再挤在 640px 侧边栏里，所以扫的是一组真实视图宽度：
// 小窗口一路到 1380px 窗口下的全宽。640 那档留着 —— 面板窄到那个程度布局仍然不能散，
// 而且它正好落在路径 chip 的换行临界点上。
const WIDTHS = [420, 640, 780, 900, 1100, 1380]
/** 两组按钮能排在同一行所需的最小宽度（实测：600 同行、520 换行）。 */
const SAME_ROW_MIN = 600
/**
 * 路径 chip 能和统计数字同处第一行的最小宽度。
 *
 * 这个数比 SAME_ROW_MIN 更值钱：chip 一旦换行，info 从 26px 涨到 52px，
 * 工具栏跟着从 77px 涨到 103px —— 26px 的图区高度。
 *
 * ⚠️ 它会跟着第一行的内容走，改第一行就得重量：
 *   700px  无「图已过期」标记（下面主循环量的就是这个）
 *   820px  有标记时（标记 12px 占 62px，把门槛推高 120px）
 * 「重新抽取」按钮搬进第一行时，这个数从 640 涨到了 700；
 * 工具栏改成卡片后内容区又窄了 38px，带标记的那个门槛从 780 涨到 820。
 */
const CHIP_ONE_LINE_MIN = 700
/**
 * 第一行多一个「图已过期」标记时的门槛 —— 标记一出现就要到这个宽度 chip 才回得来。
 *
 * 这个数是**扫出来**的，不是算的。下面那段会扫 760~860 并把实测值跟这里对齐，
 * 所以布局一变就会报出来，不用去猜。
 *
 * 一个诚实的提醒：这个门槛**对上下文敏感**。同一个 800px，用独立脚本扫是「同行」，
 * 放到本套件的页面里（堆了很多面板、有滚动条）却是「换行」，差 20px。所以这里钉住的
 * 是本套件这个上下文里的值；真实 GUI 的字体/滚动条情况未必完全一样，差几个像素是正常的。
 * 而且换行本身只是变高（工具栏 82px → 108px），不是错误。
 */
const CHIP_ONE_LINE_MIN_STALE = 820

// PathChip 的 title 是「提示语 + 换行 + 完整路径」
const TIP = '点击复制完整路径（这张图落盘的 JSON 文件）\n'

function tryRequire(id, from) {
	try {
		return createRequire(from)(id)
	} catch {
		return null
	}
}

const playwright = tryRequire('/opt/homebrew/lib/node_modules/playwright', import.meta.url)
if (!playwright) {
	console.log('⚠ 没装 playwright（npm i -g playwright），跳过可视化检查')
	process.exit(0)
}

const CLIENT = readFileSync(join(REPO, 'src/client.js'), 'utf8')
mkdirSync(OUT, { recursive: true })

// 页面必须从 http://127.0.0.1 提供，不能用 page.setContent ——
// `navigator.clipboard` 只在**安全上下文**里存在，而 setContent 出来的页面是
// about:blank，不是安全上下文。那样测出来的是"clipboard 是 undefined"，
// 而真实 GUI 跑在 http://127.0.0.1:<port>，本来就有这个 API。
let frameHits = 0
const server = createServer((req, res) => {
	// `/frame` 是给 iframe 用的仿真 Explorer 页，里面挂一个 <img src="/hit">。
	// **每次文档加载**都会重新请求一次 /hit，所以服务端这个计数就是「iframe 重载了几次」
	// —— 比在页面里数 load 事件更硬：完全不依赖被测代码，也不依赖页面 JS。
	if (req.url === '/hit') {
		frameHits++
		res.writeHead(204)
		res.end()
		return
	}
	if (req.url === '/frame') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(
			'<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#0a0">' +
				'<img src="/hit" width="1" height="1" alt="">Explorer 仿真页</body></html>',
		)
		return
	}
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
	res.end(
		'<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f6f7f9;font-family:-apple-system,"PingFang SC",sans-serif}</style></head><body><div id="host"></div></body></html>',
	)
})
await new Promise((res) => server.listen(0, '127.0.0.1', res))
const PORT = server.address().port

const browser = await playwright.chromium.launch()
// 授剪贴板权限：路径 chip 的核心是「点一下复制**完整**路径」，
// 只断言它显示了什么是不够的，得真点一次、读一次剪贴板。
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.goto(`http://127.0.0.1:${PORT}/`)
await page.addScriptTag({ path: `${APP}/node_modules/react/umd/react.development.js` })
await page.addScriptTag({ path: `${APP}/node_modules/react-dom/umd/react-dom.development.js` })
await page.evaluate(() => { window.__ModuleLoader__ = { load: (d) => { window.__plugin = d } } })
await page.addScriptTag({ content: CLIENT })

let failures = 0
const check = (label, ok, extra) => {
	console.log(`   ${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  ← ${extra}` : ''}`)
	if (!ok) failures++
}

console.log(`Explorer: ${EXPLORER}`)
console.log(`截图目录: ${OUT}\n`)

const renderPanel = async ({ width, explorer, stats, stale = false }) =>
	page.evaluate(
		async ({ width, explorer, stats, stale }) => {
			const host = document.getElementById('host')
			host.innerHTML = ''
			const panel = document.createElement('div')
			// 容器必须模仿真实的 .viewArea：`display:flex; flex-direction:column`。
			// 面板根元素是 `flex:1 1 auto`（不依赖父元素有确定高度），父元素不是
			// flex 容器的话它就只有内容高度 —— 图区量出来是 0，几何检查全废。
			panel.style.cssText = `width:${width}px;height:720px;background:#fff;overflow:hidden;display:flex;flex-direction:column`
			panel.id = `panel-${width}`
			host.appendChild(panel)

			// 头部入口按钮是通过 slots 注册的，这里把它抓出来，
			// 好在后面单独塞进一个仿真的 DSH 头部里量布局。
			window.__headerAction = null
			const mod = window.__plugin.factory((n) => {
				if (n === 'react') return React
				throw new Error(`意外的 require("${n}")`)
			})
			// 面板住在 conversation.view 槽里（核心包提供），**不经过 better-sidebar**。
			// 这里连 betterSidebar 服务都不提供 —— 面板照样要能渲染出来。
			const ctx = {
				get: (k) =>
					k === 'sessions' ? { open: () => {} }
					: k === 'locale' ? { getLocale: () => ({ active: 'zh-CN', locales: [], revision: 1 }) }
					: undefined,
				on: () => {}, effect: (fn) => fn(),
				slots: {
					inject: (_n, cb) => cb(),
					register: (desc, comp) => {
						if (desc.name === 'conversation.view') window.__panelComp = comp
						if (desc.name === 'conversation.session.header.actions') window.__headerAction = { desc, comp }
						return () => {}
					},
				},
				inject: (deps, cb) => cb({ get: (k) => (deps.includes(k) ? ctx.get(k) : undefined) }),
			}
			window.fetch = async () => ({
				status: 200, ok: true,
				text: async () => JSON.stringify({ ok: true, url: explorer, cached: false, stale, drillable: true, stats }),
			})
			mod.apply(ctx)
			ReactDOM.createRoot(panel).render(
				// 槽渲染时给的 props：ownerProps 只有 viewRequest/openView/
				// completeViewRequest，standardProps 里有 sessionId。我们只用 sessionId。
				React.createElement(window.__panelComp, { sessionId: 'sess-visual' }),
			)
			await new Promise((res) => setTimeout(res, 2600))

			const q = (s) => panel.querySelector(s)
			const rel = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } }
			const toolbar = q('.semg-toolbar')
			const info = q('.semg-toolbar-info')
			const acts = q('.semg-toolbar-actions')
			const util = q('.semg-toolbar-util')
			const frame = q('.semg-viewbody')
			// iframe **不在面板里**了 —— 它常驻 body 上的 [data-semg-frame-host]，
			// 靠 fixed 跟着 .semg-viewbody 里的占位元素走（见 ExplorerFrame 的注释）
			const iframe = document.querySelector('[data-semg-frame-host] iframe')
			// 真重叠：两个盒子的 x 和 y 区间**都**相交（只比 x 会把不同行误判成重叠）
			let overlap = false
			if (info && acts) {
				const i = rel(info), a = rel(acts)
				overlap = i.t < a.t + a.h - 1 && a.t < i.t + i.h - 1 && i.l < a.l + a.w - 1 && a.l < i.l + i.w - 1
			}
			// 路径 chip：点击**之前**先把它量完。
			//
			// 这个顺序是有教训的：chip 点下去会把文案换成「已复制」，宽度从 359px
			// 缩到 62px，于是整行不再换行、工具栏也跟着矮一截。一开始点击在量几何
			// 之前，量到的全是被点击后的尺寸 —— 报出去的工具栏高度全部是错的。
			// 所以：几何先量、存进 geom，复制测试放到最后。
			const chip = q('.semg-path')
			const chipText = chip ? (chip.querySelector('code') || {}).textContent || '' : null
			const chipTitle = chip ? chip.getAttribute('title') || '' : null
			const geom = {
				viewportW: window.innerWidth,
				toolbarH: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0,
				chipW: chip ? Math.round(chip.getBoundingClientRect().width) : 0,
				chipT: chip ? Math.round(chip.getBoundingClientRect().top) : 0,
				chipH: chip ? Math.round(chip.getBoundingClientRect().height) : 0,
				chipOverflowX: chip ? chip.scrollWidth - chip.clientWidth : 0,
				panelW: Math.round(panel.getBoundingClientRect().width),
				overflowX: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : 0,
				frame: rel(frame),
				iframe: rel(iframe),
				info: rel(info),
				acts: rel(acts),
				util: rel(util),
				mini: rel(info && info.querySelector('.semg-mini')),
				tag: rel(panel.querySelector('.semg-tag')),
				refresh: rel([...panel.querySelectorAll('.semg-toolbar-info .semg-btn')][0]),
				stats: [...panel.querySelectorAll('.semg-mini')].map((s) => s.textContent.trim()),
				buttons: [...panel.querySelectorAll('.semg-toolbar-actions .semg-btn')].map((b) => b.textContent.trim()),
				overlap,
			}

			// 量完了，再点 chip 验复制。这里会改状态，所以之后不能再量几何。
			let chipCopied = null
			if (chip) {
				chip.click()
				await new Promise((res) => setTimeout(res, 120))
				try {
					chipCopied = await navigator.clipboard.readText()
				} catch (e) {
					chipCopied = `<读剪贴板失败: ${e.message}>`
				}
			}
			const chipLabelAfter = chip ? (chip.querySelector('code') || {}).textContent || '' : null

			return { ...geom, chipText, chipTitle, chipCopied, chipLabelAfter }
		},
		{ width, explorer: EXPLORER, stats: STATS, stale },
	)

// ═══════════ 图谱标签的三个真实行为（真 DOM 才能验）═══════════
//
// 这一段放在宽度扫描**之前**：扫描会连续挂载 6 个面板且从不卸载，那些残留组件的
// ResizeObserver 会跟这里的宿主抢位置。先测、后扫描。
console.log('── 图谱标签：iframe 不重载 / 隐藏输入框 / 卡片样式')
{
	const FRAME_URL = `http://127.0.0.1:${PORT}/frame`
	const before = frameHits
	const r = await page.evaluate(
		async ({ url, stats }) => {
			// ── 仿真的对话骨架 ──
			// scrollBody > [conversation.session] > [slot=conversation.view](面板)
			//            > [data-composer-seat]（输入框）
			// 结构照 ConversationRoot 的真实 DOM 来：data-conversation-scroll /
			// data-slot / data-composer-seat 都是它显式写死的稳定属性。
			const host = document.getElementById('host')
			host.innerHTML = ''
			const stale = document.querySelector('[data-semg-frame-host]')
			if (stale) stale.remove()

			const scroll = document.createElement('div')
			scroll.setAttribute('data-conversation-scroll', '')
			scroll.style.cssText =
				'position:relative;display:flex;flex-direction:column;width:1000px;height:720px;background:#fff;overflow:hidden'
			const sessionSlot = document.createElement('div')
			sessionSlot.setAttribute('data-slot', 'conversation.session')
			sessionSlot.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column'
			const viewSlot = document.createElement('div')
			viewSlot.setAttribute('data-slot', 'conversation.view')
			viewSlot.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column'
			const seat = document.createElement('div')
			seat.setAttribute('data-composer-seat', '')
			// 刻意**不写内联 display**：真实里输入框的 display 来自 module CSS 的类，
			// 内联样式会压过插件那条属性选择器规则，测出来的是假失败。
			seat.style.cssText = 'height:120px;flex:none;background:#dde'
			seat.textContent = '对话输入框'
			const panel = document.createElement('div')
			panel.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column'
			viewSlot.appendChild(panel)
			sessionSlot.appendChild(viewSlot)
			scroll.appendChild(sessionSlot)
			scroll.appendChild(seat)
			host.appendChild(scroll)

			const mod = window.__plugin.factory((n) => {
				if (n === 'react') return React
				throw new Error(`意外的 require("${n}")`)
			})
			const ctx = {
				get: (k) =>
					k === 'sessions' ? { open: () => {} }
					: k === 'locale' ? { getLocale: () => ({ active: 'zh-CN', locales: [], revision: 1 }) }
					: undefined,
				on: () => {},
				effect: (fn) => fn(),
				slots: {
					inject: (_n, cb) => cb(),
					register: (desc, comp) => {
						if (desc.name === 'conversation.view') window.__panelComp = comp
						return () => {}
					},
				},
				inject: (deps, cb) => cb({ get: (k) => (deps.includes(k) ? ctx.get(k) : undefined) }),
			}
			window.fetch = async () => ({
				status: 200, ok: true,
				text: async () => JSON.stringify({ ok: true, url, cached: false, stale: false, drillable: true, stats }),
			})
			mod.apply(ctx)

			const wait = (ms) => new Promise((res) => setTimeout(res, ms))
			const hostEl = () => document.querySelector('[data-semg-frame-host]')
			const box = (el) => {
				if (!el) return null
				const b = el.getBoundingClientRect()
				return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
			}
			const snap = () => {
				const fh = hostEl()
				const f = fh && fh.querySelector('iframe')
				const holder = document.querySelector('.semg-viewholder')
				const cs = f ? getComputedStyle(f) : null
				const hs = fh ? getComputedStyle(fh) : null
				return {
					seatDisplay: getComputedStyle(seat).display,
					hostDisplay: fh ? hs.display : null,
					panelRect: (() => {
						const b = panel.getBoundingClientRect()
						return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
					})(),
					radius: cs ? cs.borderTopLeftRadius : null,
					borderW: cs ? cs.borderTopWidth : null,
					src: f ? f.src : null,
					status: f ? f.getAttribute('sandbox') : null,
					ref: f ? f.getAttribute('referrerpolicy') : null,
					host: box(fh),
					holder: box(holder),
					iframe: box(f),
				}
			}

			// ── 第一次挂载 ──
			const root = ReactDOM.createRoot(panel)
			root.render(React.createElement(window.__panelComp, { sessionId: 'sess-persist' }))
			await wait(2600)
			const mounted = snap()
			const firstFrame = hostEl() && hostEl().querySelector('iframe')

			// ── 卸载（= 切到别的标签）──
			root.unmount()
			await wait(400)
			const unmounted = snap()

			// ── 再挂载（= 切回图谱标签）──
			const root2 = ReactDOM.createRoot(panel)
			root2.render(React.createElement(window.__panelComp, { sessionId: 'sess-persist' }))
			await wait(2600)
			const remounted = snap()
			const secondFrame = hostEl() && hostEl().querySelector('iframe')

			return {
				mounted,
				unmounted,
				remounted,
				sameFrame: Boolean(firstFrame) && firstFrame === secondFrame,
				frameExists: Boolean(firstFrame),
			}
		},
		{ url: FRAME_URL, stats: STATS },
	)
	const hits = frameHits - before

	// ── iframe 没有重载（主人反馈的第 2 条）──
	//
	// 这是整段里最硬的一条：服务端数的是**文档加载次数**，卸载再挂载一次之后
	// 必须仍然是 1。要是 iframe 被重建，这个数会变成 2，Explorer 的 SPA 也就
	// 得从头启动一次 —— 那正是「每次切 tab 都在提取」的来源。
	check('iframe 建出来了', r.frameExists)
	check('切走再切回来，iframe 是**同一个元素**（没重建）', r.sameFrame)
	check('服务端只收到 1 次文档加载（真的没重载）', hits === 1, `hits=${hits}`)

	// ── 隐藏输入框（第 1 条）──
	check('挂载时隐藏了对话输入框', r.mounted.seatDisplay === 'none', `display=${r.mounted.seatDisplay}`)
	check('卸载后输入框恢复', r.unmounted.seatDisplay !== 'none', `display=${r.unmounted.seatDisplay}`)
	check('切回来又藏起来', r.remounted.seatDisplay === 'none', `display=${r.remounted.seatDisplay}`)

	// ── 离开标签时宿主必须隐藏（否则这块 fixed 会盖住别的界面）──
	check('挂载时宿主显示', r.mounted.hostDisplay === 'block', `display=${r.mounted.hostDisplay}`)
	check('卸载后宿主隐藏（不盖住别的界面）', r.unmounted.hostDisplay === 'none', `display=${r.unmounted.hostDisplay}`)

	// ── 卡片样式（第 3 条）──
	// 16px 由 .semg-split 的内边距给（宿主 padding 为 0，精确盖住 .semg-viewbody）。
	// 断言**用户看到的**结果 —— iframe 到面板四边各 16px —— 而不是某个实现细节。
	const PB = r.mounted.panelRect
	const FB = r.mounted.iframe
	check('iframe 左/右各离面板 16px', !!PB && !!FB && FB.l - PB.l === 16 && PB.l + PB.w - (FB.l + FB.w) === 16,
		`panel=${JSON.stringify(PB)} iframe=${JSON.stringify(FB)}`)
	check('iframe 下边离面板 16px', !!PB && !!FB && PB.t + PB.h - (FB.t + FB.h) === 16,
		`panel底 ${PB && PB.t + PB.h} iframe底 ${FB && FB.t + FB.h}`)
	check('iframe 8px 圆角', r.mounted.radius === '8px', String(r.mounted.radius))
	check('iframe 1px 边框', r.mounted.borderW === '1px', String(r.mounted.borderW))
	check('iframe 指向 Explorer 地址', r.mounted.src === FRAME_URL, String(r.mounted.src))
	check('卸载后 iframe 仍然指着同一地址（没被清空）', r.unmounted.src === FRAME_URL, String(r.unmounted.src))

	// ── 宿主摆位：跟占位元素对齐、向外 16px ──
	check('宿主盖住画布占位元素', !!r.mounted.host && !!r.mounted.holder &&
		Math.abs(r.mounted.host.l - r.mounted.holder.l) <= 1 &&
		Math.abs(r.mounted.host.t - r.mounted.holder.t) <= 1 &&
		Math.abs(r.mounted.host.w - r.mounted.holder.w) <= 1 &&
		Math.abs(r.mounted.host.h - r.mounted.holder.h) <= 1,
		`host=${JSON.stringify(r.mounted.host)} holder=${JSON.stringify(r.mounted.holder)}`)
	check('iframe 精确铺满宿主', !!r.mounted.host && !!r.mounted.iframe &&
		r.mounted.iframe.l === r.mounted.host.l && r.mounted.iframe.t === r.mounted.host.t &&
		r.mounted.iframe.w === r.mounted.host.w && r.mounted.iframe.h === r.mounted.host.h,
		`host=${JSON.stringify(r.mounted.host)} iframe=${JSON.stringify(r.mounted.iframe)}`)

	// ── 工具栏也是一张卡片，与图谱同规格（边框 / 圆角 / 16px 内缩）──
	const TB = await page.evaluate(() => {
		const tb = document.querySelector('.semg-split .semg-toolbar')
		const sp = document.querySelector('.semg-split')
		if (!tb || !sp) return null
		const cs = getComputedStyle(tb)
		const b = tb.getBoundingClientRect()
		const s = sp.getBoundingClientRect()
		return {
			border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
			radius: cs.borderTopLeftRadius,
			padTop: cs.paddingTop,
			padLeft: cs.paddingLeft,
			insetL: Math.round(b.left - s.left),
			insetT: Math.round(b.top - s.top),
			insetR: Math.round(s.right - b.right),
			bottomBorder: cs.borderBottomWidth,
		}
	})
	check('工具栏有 1px 边框', !!TB && TB.border === '1px solid', TB && TB.border)
	check('工具栏 8px 圆角（与图谱一致）', !!TB && TB.radius === '8px', TB && TB.radius)
	check('工具栏有自己的内边距', !!TB && parseFloat(TB.padTop) > 0 && parseFloat(TB.padLeft) > 0,
		TB && `${TB.padTop} / ${TB.padLeft}`)
	check('工具栏四周与图谱同距（16px）', !!TB && TB.insetL === 16 && TB.insetT === 16 && TB.insetR === 16,
		TB && `L${TB.insetL} T${TB.insetT} R${TB.insetR}`)
	check('工具栏不再只有「贴边下边框」', !!TB && TB.bottomBorder === '1px', TB && `下边框 ${TB.bottomBorder}`)

	// sandbox 是安全边界，别在重构里悄悄丢
	const sb = String(r.mounted.status || '')
	check('sandbox 仍含 allow-same-origin（缺它 SPA 白屏）', sb.includes('allow-same-origin'), sb)
	check('sandbox 仍含 allow-scripts', sb.includes('allow-scripts'), sb)
	check('sandbox 不含 allow-top-navigation', !sb.includes('allow-top-navigation'), sb)
	check('referrerpolicy 仍是 no-referrer', r.mounted.ref === 'no-referrer', String(r.mounted.ref))
	console.log('')
}

for (const width of WIDTHS) {
	const r = await renderPanel({ width, explorer: EXPLORER, stats: STATS })
	console.log(`── ${width}px  工具栏高 ${r.toolbarH}  图区 ${r.frame ? `${r.frame.w}×${r.frame.h}` : '—'}`)
	console.log(`     信息 y${r.info && r.info.t} h${r.info && r.info.h} | 分析 y${r.acts && r.acts.t} x${r.acts && r.acts.l}~${r.acts && r.acts.l + r.acts.w} | 控制 y${r.util && r.util.t} x${r.util && r.util.l}~${r.util && r.util.l + r.util.w} | chip w${r.chipW} y${r.chipT}`)
	check('没有横向溢出', r.overflowX === 0, `溢出 ${r.overflowX}px`)
	check('信息区与按钮组不重叠', r.overlap === false)
	// 第二行：分析按钮靠左、控制按钮靠右。
	// 宽度够时两组同一行；不够时控制按钮换到下一行 —— 但**永远不能跑到分析按钮上方**，
	// 否则「下面那行」这个约定就破了。
	check(
		'控制按钮不在分析按钮上方',
		!!r.util && !!r.acts && r.util.t >= r.acts.t - 2,
		`acts.t=${r.acts && r.acts.t} util.t=${r.util && r.util.t}`,
	)
	check(
		'控制按钮在分析按钮右边',
		!!r.util && !!r.acts && r.util.l > r.acts.l,
		`acts.l=${r.acts && r.acts.l} util.l=${r.util && r.util.l}`,
	)
	if (width >= SAME_ROW_MIN) {
		check(
			'够宽时两组排在同一行',
			Math.abs(r.util.t - r.acts.t) <= 2,
			`acts.t=${r.acts.t} util.t=${r.util.t}`,
		)
	}
	// 路径 chip 的行位：够宽时和统计数字同一行，不够时换到第二行。
	//
	// 判据是**垂直中心**相等，不是顶边相等。踩过这个坑：720px 下 chip 明明在第一行，
	// 但「重新抽取」按钮 26px 比 chip 16px 高，chip 被 align-items:center 居中，
	// 顶边就比 info 低了 5px —— 按顶边断言会误判成「换行了」。
	// 同一 flex 行上的元素中心必然对齐，换行必然不对齐，这个判据对两边都成立。
	const sameLineWithStats =
		!!r.mini && Math.abs(r.chipT + r.chipH / 2 - (r.mini.t + r.mini.h / 2)) <= 2
	if (width >= CHIP_ONE_LINE_MIN) {
		check('够宽时路径 chip 和统计同处第一行', sameLineWithStats, `chip.c=${r.chipT + r.chipH / 2} mini.c=${r.mini && r.mini.t + r.mini.h / 2}`)
	} else {
		check('不够宽时路径 chip 换到第二行', !sameLineWithStats, `chip.c=${r.chipT + r.chipH / 2} mini.c=${r.mini && r.mini.t + r.mini.h / 2}`)
	}
	check(
		'控制按钮贴着右边缘（margin-left:auto）',
		// 右缘 = 面板宽 - 16(split 内边距) - 1(卡片边框) - 12(工具栏内边距)
		!!r.util && r.util.l + r.util.w >= r.panelW - 30,
		`util右缘 ${r.util && r.util.l + r.util.w} vs 面板宽 ${r.panelW}`,
	)
	// 第一行只剩信息，必须在按钮行上方
	check(
		'第一行（信息）在第二行（按钮）上方',
		!!r.info && !!r.acts && r.info.t + r.info.h <= r.acts.t + 1,
		`info底 ${r.info && r.info.t + r.info.h} vs acts顶 ${r.acts && r.acts.t}`,
	)
	// 整列必须刚好填满：16(上内边距) + 工具栏 + 16(行距) + 画布 + 16(下内边距) = 720
	check(
		'上内边距 + 工具栏 + 行距 + 画布 + 下内边距 = 面板高度',
		16 + r.toolbarH + 16 + (r.frame ? r.frame.h : 0) + 16 === 720,
		`16 + ${r.toolbarH} + 16 + ${r.frame ? r.frame.h : 0} + 16`,
	)
	// 画布区铺满「16px 内缩之后」的宽度：.semg-split 有 16px 内边距，两张卡片都在里面
	check('画布区铺满卡片区宽度', !!r.frame && Math.abs(r.frame.w - (r.panelW - 32)) <= 1, `frame.w=${r.frame && r.frame.w} panelW=${r.panelW}`)
	check('渲染出内嵌 iframe（在常驻宿主里）', !!r.iframe, String(r.iframe && r.iframe.src))
	check('统计四项齐全', r.stats.length === 4, r.stats.join(' '))
	check('分析按钮四个齐全', r.buttons.length === 4, r.buttons.join(' | '))
	check('图文件路径 chip 渲染出来了', typeof r.chipText === 'string' && r.chipText.length > 0)
	check('显示的是省略形式（短于完整路径）', (r.chipText || '').length < STATS.graphPath.length, `${(r.chipText || '').length} vs ${STATS.graphPath.length}`)
	check('title 里是完整路径', r.chipTitle === TIP + STATS.graphPath, r.chipTitle || '(空)')
	check('点一下复制的是完整路径', r.chipCopied === STATS.graphPath, String(r.chipCopied).slice(0, 70))
	check('复制后 chip 给出反馈文案', r.chipLabelAfter !== r.chipText, `「${r.chipLabelAfter}」`)
	await page.locator(`#panel-${width}`).screenshot({ path: join(OUT, `panel-${width}.png`) })
	console.log('')
}

// ── 「图已过期」标记对第一行的影响 ──
//
// 标记本身只有 72px，但它出现时第一行要装「图标 + 4 个统计 + 标记 + 重新抽取 + 路径 chip」，
// chip 的同行门槛从 700px 被推到 840px。这个数会随着第一行的内容变，所以必须量、不能算。
console.log('── 「图已过期」标记推高路径 chip 的门槛（扫描实测，两侧都断言）')
//
// 这个门槛**只能在同一个上下文里量**：我先用独立脚本扫出 800px 同行，搬到
// visual-check 里同样的 800px 却仍然换行 —— 两个上下文的可用宽度并不相同。
// 所以这里不写死一个「两侧取样」，直接扫过去，然后把实测门槛跟常数对齐。
{
	const rows = []
	for (const width of [760, 780, 800, 820, 840, 860]) {
		const r = await renderPanel({ width, stats: STATS, stale: true })
		const mini = r.mini
		const sameLine = !!mini && Math.abs(r.chipT + r.chipH / 2 - (mini.t + mini.h / 2)) <= 2
		check(`  ${width}px 过期标记渲染出来了`, !!r.tag, `tag=${JSON.stringify(r.tag)}`)
		rows.push({ width, sameLine })
		console.log(
			`   ${width}px  工具栏高 ${r.toolbarH}  info 高 ${r.info.h}  标记 ${r.tag && r.tag.w}×${r.tag && r.tag.h}  重新抽取 ${r.refresh && r.refresh.w}px  ` +
				`chip.c=${r.chipT + r.chipH / 2} mini.c=${mini && mini.t + mini.h / 2} → ${sameLine ? '同一行' : '换行'}`,
		)
	}
	const firstSame = rows.find((r) => r.sameLine)
	check(
		`带标记时的同行门槛就是 CHIP_ONE_LINE_MIN_STALE=${CHIP_ONE_LINE_MIN_STALE}px（扫描实测）`,
		!!firstSame && firstSame.width === CHIP_ONE_LINE_MIN_STALE,
		`实测 ${firstSame ? firstSame.width : '—'}px`,
	)
	check(
		'门槛以下确实换行',
		rows.filter((r) => r.width < CHIP_ONE_LINE_MIN_STALE).every((r) => !r.sameLine),
	)
}
console.log('')

// ── 头部入口按钮：图标 + 文案，且不能把标题挤坏 ──
//
// 这个按钮坐在 DSH 的 conversation.session.header.actions 里，那一排是
// `flex:none`（宽度由内容决定、自己不收缩），而左边 .titleCluster 是
// `flex:1;min-width:0`（会被压、标题走省略号）。所以按钮每宽 1px，标题就少 1px ——
// 只断言「有文案」不够，得在真实的三段式布局里量它有没有把标题顶没。
console.log('── 头部入口按钮')
const HEADER_CSS = `
  .hdr{box-sizing:border-box;padding:12px 28px 0 20px;width:100%}
  .titleRow{align-items:center;gap:0;min-height:32px;display:flex}
  .titleCluster{flex:1;align-items:center;gap:10px;min-width:0;display:flex}
  .crumbs{white-space:nowrap;align-items:center;gap:4px;min-width:0;display:flex;overflow:hidden}
  .crumbCurrent{color:#222;cursor:default;font-weight:500;max-width:220px;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;overflow:hidden}
  .headerActions{flex:none;align-items:center;gap:8px;display:flex}
  .headerUtilities{flex:none;align-items:center;gap:8px;margin-left:20px;display:flex}
  .util{width:26px;height:26px;border-radius:6px;background:#00000010}
`
for (const viewportW of [1380, 1100, 900]) {
	const hr = await page.evaluate(
		async ({ viewportW, css }) => {
			const host = document.getElementById('host')
			host.innerHTML = ''
			const style = document.createElement('style')
			style.textContent = css
			document.head.appendChild(style)
			const row = document.createElement('div')
			row.className = 'hdr'
			row.style.width = `${viewportW}px`
			row.id = `hdr-${viewportW}`
			row.innerHTML = `
				<div class="titleRow">
					<div class="titleCluster"><div class="crumbs"><span class="crumbCurrent">${
						'把 semantica 做成一个 dsh 插件，点击之后在侧边栏展示'.repeat(2)
					}</span></div></div>
					<div class="headerActions" id="ha-${viewportW}"></div>
					<div class="headerUtilities"><span class="util"></span></div>
				</div>`
			host.appendChild(row)
			const slot = row.querySelector(`#ha-${viewportW}`)
			const root = ReactDOM.createRoot(slot)
			root.render(React.createElement(window.__headerAction.comp, { sessionId: 'sess-visual', openPanel: () => {} }))
			await new Promise((res) => setTimeout(res, 200))
			const btn = slot.querySelector('button')
			const cluster = row.querySelector('.titleCluster')
			const crumbs = row.querySelector('.crumbs')
			const b = btn && btn.getBoundingClientRect()
			return {
				text: btn ? btn.textContent.trim() : null,
				btnW: b ? Math.round(b.width) : 0,
				btnH: b ? Math.round(b.height) : 0,
				clusterW: cluster ? Math.round(cluster.getBoundingClientRect().width) : 0,
				titleClipped: crumbs ? crumbs.scrollWidth > crumbs.clientWidth + 1 : false,
				overflowX: row.scrollWidth - row.clientWidth,
				ariaLabel: btn ? btn.getAttribute('aria-label') : null,
				title: btn ? btn.getAttribute('title') : null,
			}
		},
		{ viewportW, css: HEADER_CSS },
	)
	const tag = `视口 ${viewportW}px`
	console.log(`   ${tag}  按钮 ${hr.btnW}×${hr.btnH}  标题区 ${hr.clusterW}  标题被截断=${hr.titleClipped}`)
	check(`${tag}：按钮带文案「${hr.text}」`, hr.text === '知识图谱', String(hr.text))
	check(`${tag}：按钮尺寸正常`, hr.btnW > 40 && hr.btnW <= 120 && hr.btnH === 22, `${hr.btnW}×${hr.btnH}`)
	check(`${tag}：整行不横向溢出`, hr.overflowX === 0, `溢出 ${hr.overflowX}px`)
	check(`${tag}：标题区仍有空间（${hr.clusterW}px）`, hr.clusterW > 120, `${hr.clusterW}px`)
	check(`${tag}：aria-label / title 都在`, !!hr.ariaLabel && !!hr.title, `${hr.ariaLabel} / ${hr.title}`)
}
console.log('')

// iframe 里真的渲染出东西了吗（sandbox 缺 allow-same-origin 会白屏）
if (EXPLORER !== 'about:blank') {
	await page.waitForTimeout(4000)
	const inner = await page.evaluate(async () => {
		const f = document.querySelector('.semg-viewbody iframe')
		return { src: f && f.getAttribute('src'), sandbox: f && f.getAttribute('sandbox') }
	})
	const frames = page.frames().filter((f) => f.url().startsWith('http'))
	console.log('── iframe 内容')
	for (const f of frames) {
		let title = '?', len = -1
		try { title = await f.title() } catch {}
		try { len = await f.evaluate(() => (document.querySelector('#root') || document.body).innerHTML.length) } catch {}
		console.log(`   ${f.url().slice(0, 50)}  title="${title}"  DOM ${len} 字符`)
		check(`Explorer 在 iframe 里渲染出来了（${len} 字符）`, len > 1000, `只有 ${len} 字符`)
	}
	if (frames.length === 0) check('找到 Explorer 子 frame', false, '一个都没有')
	console.log(`   sandbox: ${inner.sandbox}`)
}

console.log(`\n控制台错误: ${errors.length}`)
for (const e of errors.slice(0, 6)) console.log(`   ! ${e.slice(0, 140)}`)

await browser.close()
await browser.close()
server.close()
console.log(failures === 0 ? '\n✓ 可视化检查全部通过' : `\n✗ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
