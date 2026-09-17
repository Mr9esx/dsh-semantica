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
const WIDTHS = [300, 320, 420, 520, 600, 640, 720]
/** 两组按钮能排在同一行所需的最小宽度（实测：600 同行、520 换行）。 */
const SAME_ROW_MIN = 600
/**
 * 路径 chip 能和统计数字同处第一行的最小宽度（实测：640 同行、600 换行）。
 *
 * 这个数比 SAME_ROW_MIN 更值钱：chip 一旦换行，info 从 17px 涨到 43px，
 * 工具栏跟着从 68px 涨到 94px —— 26px 的图区高度。（600px 正好落在换行那一侧，
 * 而插件默认就把面板加宽到 600，所以这个边界直接决定用户看到的是 68 还是 94。）
 */
const CHIP_ONE_LINE_MIN = 640

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
const server = createServer((_req, res) => {
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

// 侧边栏宽度：better-sidebar 出厂值是「窗口宽度 35%」，1380px 窗口 = 483px。
// 插件会在图谱面板展开时把它拉到 600px（只加宽，不回缩）。
const SEED_WIDTH_NARROW = 483
const SEED_WIDTH_WIDE = 700
const EXPANDED_WIDTH = 640

const renderPanel = async ({ width, explorer, stats, seedWidth }) =>
	page.evaluate(
		async ({ width, explorer, stats, seedWidth }) => {
			const host = document.getElementById('host')
			host.innerHTML = ''
			const panel = document.createElement('div')
			panel.style.cssText = `width:${width}px;height:720px;background:#fff;overflow:hidden`
			panel.id = `panel-${width}`
			host.appendChild(panel)

			const widthWrites = []
			// 头部入口按钮是通过 slots 注册的，这里把它抓出来，
			// 好在后面单独塞进一个仿真的 DSH 头部里量布局。
			window.__headerAction = null
			const mod = window.__plugin.factory((n) => {
				if (n === 'react') return React
				throw new Error(`意外的 require("${n}")`)
			})
			const components = {}
			const sidebar = { registerTab: (d) => { components[d.id] = d.component; return () => {} }, openTab: () => {}, closeTab: () => {} }
			const ctx = {
				get: (k) =>
					k === 'betterSidebar' ? sidebar
					: k === 'sessions' ? { open: () => {} }
					: k === 'locale' ? { getLocale: () => ({ active: 'zh-CN', locales: [], revision: 1 }) }
					: undefined,
				on: () => {}, effect: (fn) => fn(),
				slots: {
					inject: (_n, cb) => cb(),
					register: (desc, comp) => {
						if (desc.name === 'conversation.session.header.actions') window.__headerAction = { desc, comp }
						return () => {}
					},
				},
				inject: (deps, cb) => cb({ get: (k) => (deps.includes(k) ? ctx.get(k) : undefined) }),
			}
			window.fetch = async () => ({
				status: 200, ok: true,
				text: async () => JSON.stringify({ ok: true, url: explorer, cached: false, stale: false, drillable: true, stats }),
			})
			mod.apply(ctx)
			ReactDOM.createRoot(panel).render(
				React.createElement(components['semantica:launcher'], {
					ctx,
					// 真 store 的形状：getSnapshot().state.width 是当前宽度，
					// reduce(fn) 提交一个新 state。这里把 reduce 的产物记下来，
					// 好断言插件到底有没有改宽度、改成了多少。
					store: {
						getPrefs: () => ({}),
						getSnapshot: () => ({ state: { width: seedWidth } }),
						reduce: (fn) => { widthWrites.push(fn({ width: seedWidth })) },
						subscribe: () => () => {},
					},
					scope: { sessionId: 'sess-visual' }, sessionId: 'sess-visual', visible: true,
					tab: { id: 'semantica:launcher' },
				}),
			)
			await new Promise((res) => setTimeout(res, 2600))

			const q = (s) => panel.querySelector(s)
			const rel = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } }
			const toolbar = q('.semg-toolbar')
			const info = q('.semg-toolbar-info')
			const acts = q('.semg-toolbar-actions')
			const util = q('.semg-toolbar-util')
			const frame = q('.semg-viewbody')
			const iframe = frame && frame.querySelector('iframe')
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
				widthWrites: widthWrites.map((st) => st.width),
				viewportW: window.innerWidth,
				toolbarH: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0,
				chipW: chip ? Math.round(chip.getBoundingClientRect().width) : 0,
				chipT: chip ? Math.round(chip.getBoundingClientRect().top) : 0,
				chipOverflowX: chip ? chip.scrollWidth - chip.clientWidth : 0,
				overflowX: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : 0,
				frame: rel(frame),
				iframe: rel(iframe),
				info: rel(info),
				acts: rel(acts),
				util: rel(util),
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
		{ width, explorer: EXPLORER, stats: STATS, seedWidth },
	)

for (const width of WIDTHS) {
	const r = await renderPanel({ width, explorer: EXPLORER, stats: STATS, seedWidth: SEED_WIDTH_NARROW })
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
	// 直接断言「chip 顶 == info 顶」比断言高度稳 —— 高度还受字体影响。
	if (width >= CHIP_ONE_LINE_MIN) {
		check(
			'够宽时路径 chip 和统计同处第一行',
			r.chipT - r.info.t <= 2,
			`chip.t=${r.chipT} info.t=${r.info.t}`,
		)
		check('chip 不换行时 info 只有一行高', r.info.h < 25, `info.h=${r.info.h}`)
	} else {
		check(
			'不够宽时路径 chip 换到第二行',
			r.chipT - r.info.t > 2,
			`chip.t=${r.chipT} info.t=${r.info.t}`,
		)
	}
	check(
		'控制按钮贴着右边缘（margin-left:auto）',
		!!r.util && r.util.l + r.util.w >= (r.frame ? r.frame.w : 0) - 12,
		`util右缘 ${r.util && r.util.l + r.util.w} vs 面板宽 ${r.frame && r.frame.w}`,
	)
	// 第一行只剩信息，必须在按钮行上方
	check(
		'第一行（信息）在第二行（按钮）上方',
		!!r.info && !!r.acts && r.info.t + r.info.h <= r.acts.t + 1,
		`info底 ${r.info && r.info.t + r.info.h} vs acts顶 ${r.acts && r.acts.t}`,
	)
	check('工具栏 + 图区 = 面板高度', r.toolbarH + (r.frame ? r.frame.h : 0) >= 719, `${r.toolbarH} + ${r.frame ? r.frame.h : 0}`)
	check('渲染出内嵌 iframe', !!r.iframe)
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

// ── 侧边栏宽度：图谱面板展开时自动加宽到 600px ──
//
// 出厂宽度 483px 放不下 Explorer（它自带一条约 240px 的左栏），所以插件在
// 面板展开时把侧边栏拉到 600px。三条断言：会加宽、不反复触发、不越界。
console.log('── 侧边栏宽度')
const narrow = await renderPanel({ width: 520, explorer: EXPLORER, stats: STATS, seedWidth: SEED_WIDTH_NARROW })
check(
	`出厂宽度 ${SEED_WIDTH_NARROW}px → 加宽到 ${EXPANDED_WIDTH}px`,
	narrow.widthWrites[0] === EXPANDED_WIDTH,
	`写入 ${JSON.stringify(narrow.widthWrites)}`,
)
check('只写一次（展开期间不反复触发）', narrow.widthWrites.length === 1, `${narrow.widthWrites.length} 次`)

const wide = await renderPanel({ width: 520, explorer: EXPLORER, stats: STATS, seedWidth: SEED_WIDTH_WIDE })
check(
	`用户已经拖到 ${SEED_WIDTH_WIDE}px 时不动它（只加宽不回缩）`,
	wide.widthWrites.length === 0,
	`写入 ${JSON.stringify(wide.widthWrites)}`,
)

// 视口 < 768px 时 better-sidebar 切成全屏抽屉，面板铺满窗口，改宽度没有意义
await page.setViewportSize({ width: 700, height: 720 })
const drawer = await renderPanel({ width: 520, explorer: EXPLORER, stats: STATS, seedWidth: SEED_WIDTH_NARROW })
check(
	'窄视口（抽屉模式）下不加宽',
	drawer.widthWrites.length === 0,
	`视口 ${drawer.viewportW}px，写入 ${JSON.stringify(drawer.widthWrites)}`,
)
await page.setViewportSize({ width: 1280, height: 720 })
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
