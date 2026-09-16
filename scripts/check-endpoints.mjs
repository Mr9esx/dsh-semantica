// scripts/check-endpoints.mjs — 把 src/analyze.js 里出现的每个 /api/... 路径
// 拿去和真实 Explorer 的 openapi.json 对账
//
// 为什么需要它：digest 里那份「钻取接口」清单是喂给 AI 的，AI 会照着用 curl 去拉。
// 清单里只要有凭印象写错的路径，AI 拿到的就是一堆
// `{"detail":"API route not found"}` —— 而且它多半会当成"这个图没数据"，
// 而不是"路径写错了"。
//
// 实测踩过：曾经有 6 条是错的（/api/analytics/centrality、/api/analytics/communities、
// /api/search?q=、/api/graph/nodes/<id>、/api/graph/neighbors/<id>、?hops= 参数名），
// 每一条都会让分析质量静默变差。人工核对不现实，所以做成脚本。
//
// 用法（Explorer 得在跑）：
//   node scripts/check-endpoints.mjs                      # 自动找 Explorer 端口
//   node scripts/check-endpoints.mjs http://127.0.0.1:53413
//
// 退出码非 0 表示有路径对不上。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

/** 从 openapi.json 里读全部路由（含 path 参数名）。 */
async function loadRoutes(base) {
  const res = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`openapi.json 返回 ${res.status}`)
  const spec = await res.json()
  const routes = new Set()
  for (const [p, methods] of Object.entries(spec.paths ?? {})) {
    for (const m of Object.keys(methods)) routes.add(`${m.toUpperCase()} ${p}`)
  }
  return { routes, title: spec.info?.title, version: spec.info?.version }
}

/** 自动找活着的 Explorer：挨个监听端口问 openapi.json。 */
async function findExplorer() {
  const { execSync } = await import('node:child_process')
  let ports = []
  try {
    ports = execSync("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{split($9,a,\":\"); print a[2]}'", {
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  for (const p of [...new Set(ports)]) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/openapi.json`, { signal: AbortSignal.timeout(700) })
      if (!res.ok) continue
      const spec = await res.json()
      if (typeof spec.info?.title === 'string' && /semantica/i.test(spec.info.title)) return `http://127.0.0.1:${p}`
    } catch {
      /* 不是它就跳过 */
    }
  }
  return null
}

/**
 * 把源码里写的路径规范化成 openapi 的模板形式。
 * 源码里写的是 <nodeId> / {id} / :id，openapi 里是 {node_id} —— 段数对上就算匹配。
 *
 * 另外要认「具体实例」这一形态：文章里会举例子（`/api/graph/node/ent:xxx/neighbors`），
 * 而 Semantica 的节点 id 形如 `ent:xxx` / `dec:xxx` / `tool:xxx`。带冒号的段按占位符处理，
 * 否则检查会把举的例子当成错路径报出来。
 */
function isPlaceholder(seg) {
  return /^(<.*>|\{.*\}|:.*)$/.test(seg) || seg.includes(':') || seg === 'xxx'
}

function normalize(raw) {
  const [pathPart, query] = raw.split('?')
  const segments = pathPart
    .split('/')
    .map((seg) => (isPlaceholder(seg) ? '{}' : seg))
    .join('/')
  return { segments, query: query ?? '' }
}

function templateSegments(routePath) {
  return routePath
    .split('/')
    .map((seg) => (/^\{.*\}$/.test(seg) ? '{}' : seg))
    .join('/')
}

/** 源码里 /api/... 的裸路径（去掉硬编码的 host）。 */
function extractFromSource(src) {
  const out = new Set()
  // 匹配字符串字面量或以 /api/ 开头的任意位置
  for (const m of src.matchAll(/\/api\/[A-Za-z0-9_\-./<>{}:?=&%+]*/g)) out.add(m[0])
  return [...out]
}

const base = process.argv[2] || (await findExplorer())
if (!base) {
  console.log('⚠ 没找到活着的 Explorer，跳过端点对账（这不算失败）')
  process.exit(0)
}

let routes, title, version
try {
  ;({ routes, title, version } = await loadRoutes(base))
} catch (e) {
  console.log(`⚠ 读不到 ${base}/openapi.json：${e.message}`)
  process.exit(0)
}

// openapi 的模板路径
const templates = new Map() // 规范化段 → 原始模板
for (const r of routes) {
  const [method, p] = r.split(' ')
  templates.set(`${method} ${templateSegments(p)}`, p)
}

const src = readFileSync(join(REPO, 'src/analyze.js'), 'utf8')
const found = extractFromSource(src)

console.log(`${title} ${version}`)
console.log(`基址 ${base}   上游路由 ${routes.size} 条   源码里引用 ${found.length} 条\n`)

let bad = 0
let ok = 0
for (const raw of found.sort()) {
  const { segments } = normalize(raw)
  // 路径参数的名字可能不同，只比段数结构
  const hits = [...templates.entries()].filter(([key]) => key.split(' ')[1] === segments)
  if (hits.length === 0) {
    console.log(`  ✗ ${raw}`)
    console.log(`      openapi 里没有这个路径`)
    bad++
  } else {
    const methods = [...new Set(hits.map(([k]) => k.split(' ')[0]))]
    console.log(`  ✓ ${raw}   →  ${methods.join('/')} ${hits[0][1]}`)
    ok++
  }
}

console.log(`\n可用 ${ok} 条，对不上 ${bad} 条`)
if (bad > 0) {
  console.log('\n对不上的路径会返回 {"detail":"API route not found"}，AI 拿到会当成「没数据」。')
  console.log('按上面给出的真实路径改 src/analyze.js。')
}
process.exit(bad === 0 ? 0 : 1)
