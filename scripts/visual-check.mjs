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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const APP = '/Applications/DSH Desktop.app/Contents/Resources/app'
const OUT = join(REPO, 'tmp-visual')

const EXPLORER = process.argv[2] || 'about:blank'
const STATS = { nodes: 2186, edges: 2737, entities: 226, relations: 253, elapsed: 24.8, engine: { semantica: '0.6.8', python: '3.12' } }

// 侧边栏实际可能的宽度区间
const WIDTHS = [300, 320, 420, 520, 640, 720]

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

const browser = await playwright.chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.setContent(
	'<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f6f7f9;font-family:-apple-system,"PingFang SC",sans-serif}</style></head><body><div id="host"></div></body></html>',
)
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

for (const width of WIDTHS) {
	const r = await page.evaluate(
		async ({ width, explorer, stats }) => {
			const host = document.getElementById('host')
			host.innerHTML = ''
			const panel = document.createElement('div')
			panel.style.cssText = `width:${width}px;height:720px;background:#fff;overflow:hidden`
			panel.id = `panel-${width}`
			host.appendChild(panel)

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
				slots: { inject: (_n, cb) => cb(), register: () => () => {} },
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
					store: { getPrefs: () => ({}), getSnapshot: () => ({}), reduce: () => {}, subscribe: () => () => {} },
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
			const frame = q('.semg-viewbody')
			const iframe = frame && frame.querySelector('iframe')
			// 真重叠：两个盒子的 x 和 y 区间**都**相交（只比 x 会把不同行误判成重叠）
			let overlap = false
			if (info && acts) {
				const i = rel(info), a = rel(acts)
				overlap = i.t < a.t + a.h - 1 && a.t < i.t + i.h - 1 && i.l < a.l + a.w - 1 && a.l < i.l + i.w - 1
			}
			return {
				toolbarH: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0,
				overflowX: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : 0,
				frame: rel(frame),
				iframe: rel(iframe),
				stats: [...panel.querySelectorAll('.semg-mini')].map((s) => s.textContent.trim()),
				buttons: [...panel.querySelectorAll('.semg-toolbar-actions .semg-btn')].map((b) => b.textContent.trim()),
				overlap,
			}
		},
		{ width, explorer: EXPLORER, stats: STATS },
	)

	console.log(`── ${width}px  工具栏高 ${r.toolbarH}  图区 ${r.frame ? `${r.frame.w}×${r.frame.h}` : '—'}`)
	check('没有横向溢出', r.overflowX === 0, `溢出 ${r.overflowX}px`)
	check('信息区与按钮组不重叠', r.overlap === false)
	check('工具栏 + 图区 = 面板高度', r.toolbarH + (r.frame ? r.frame.h : 0) >= 719, `${r.toolbarH} + ${r.frame ? r.frame.h : 0}`)
	check('渲染出内嵌 iframe', !!r.iframe)
	check('统计四项齐全', r.stats.length === 4, r.stats.join(' '))
	check('分析按钮四个齐全', r.buttons.length === 4, r.buttons.join(' | '))
	await page.locator(`#panel-${width}`).screenshot({ path: join(OUT, `panel-${width}.png`) })
	console.log('')
}

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
console.log(failures === 0 ? '\n✓ 可视化检查全部通过' : `\n✗ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
