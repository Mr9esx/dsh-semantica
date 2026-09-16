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

/**
 * 源码里 /api/... 的裸路径（去掉硬编码的 host）。
 *
 * 逐行扫，因为要认行尾的忽略标记：digest 里有几条端点是**刻意写成「别用」**的
 * （不可用的 /path、会 503 的 semantic-neighborhood），那些是警告而不是推荐用法，
 * 不该被这个脚本当成「源码主张这个端点可用」来报错。
 *
 *   // check-endpoints: ignore    整行跳过
 */
function extractFromSource(src) {
  const out = new Set()
  for (const line of src.split('\n')) {
    if (line.includes('check-endpoints: ignore')) continue
    for (const m of line.matchAll(/\/api\/[A-Za-z0-9_\-./<>{}:?=&%+]*/g)) out.add(m[0])
  }
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

// ── 真实调用阶段 ─────────────────────────────────────────────────────────
//
// 只查路由存在是不够的。实测踩过：`/api/graph/node/<id>/path` 在 openapi 里**存在**，
// 路由检查会通过，但对任何 id 都 404 `Source node ... not found` —— 连 /neighbors
// 查得到的节点也一样。所以下一步拿真 id 把每个端点实际调一次。

/** POST 端点的探针 body。没有条目的 POST 只做路由检查，不实调。 */
const POST_BODIES = {
  '/api/graph/search': { query: 'a', limit: 1 },
}

/** 从活着的实例里取几个真 id，用来替换占位符。 */
async function discoverIds(base) {
  const j = async (u) => {
    try {
      const r = await fetch(base + u, { signal: AbortSignal.timeout(15000) })
      return r.ok ? await r.json() : null
    } catch {
      return null
    }
  }
  const msgs = await j('/api/graph/nodes?type=message&limit=1')
  const ents = await j('/api/graph/nodes?type=entity&limit=1')
  const decs = await j('/api/decisions?limit=1')
  const b = await j('/api/temporal/bounds')
  return {
    nodeId: msgs?.nodes?.[0]?.id ?? null,
    id: ents?.nodes?.[0]?.id ?? null,
    decisionId: (Array.isArray(decs) ? decs[0]?.decision_id : decs?.decisions?.[0]?.decision_id) ?? null,
    iso: b?.min ?? null,
    from: b?.min ?? null,
    to: b?.max ?? null,
  }
}

/** 把源码里的路径实例化成一个真能发的 URL。 */
function instantiate(raw, ids) {
  const [pathPart, query = ''] = raw.split('?')
  const enc = encodeURIComponent
  // 占位符既可能出现在路径段里，也可能出现在 query 里（`?node_id=<id>`），两边都要换
  const fill = (s) =>
    s
      .replace(/<decisionId>/g, ids.decisionId ? enc(ids.decisionId) : '<decisionId>')
      .replace(/<nodeId>/g, ids.nodeId ? enc(ids.nodeId) : '<nodeId>')
      .replace(/<id>/g, ids.id ? enc(ids.id) : '<id>')
      .replace(/<ISO>/g, ids.iso ? enc(ids.iso) : '<ISO>')
  const p = fill(pathPart)
  const q = fill(query)
    // 必填的时间参数在 digest 里是空值（写成 from_time=&to_time=），拿真实边界补上
    .replace(/from_time=(?=&|$)/, `from_time=${ids.from ? enc(ids.from) : ''}`)
    .replace(/to_time=(?=&|$)/, `to_time=${ids.to ? enc(ids.to) : ''}`)
  const unresolved = /<[^>]+>/.test(p) || /<[^>]+>/.test(q)
  return { url: p + (q ? `?${q}` : ''), unresolved }
}

const src = readFileSync(join(REPO, 'src/analyze.js'), 'utf8')
const found = extractFromSource(src)
const ids = await discoverIds(base)

console.log(`${title} ${version}`)
console.log(`基址 ${base}   上游路由 ${routes.size} 条   源码里引用 ${found.length} 条`)
console.log(`样本 id: nodeId=${ids.nodeId}  id=${ids.id}  decisionId=${ids.decisionId}\n`)

const missing = []
const failing = []
const skipped = []
let ok = 0

for (const raw of found.sort()) {
  const { segments } = normalize(raw)
  // 路径参数的名字可能不同，只比段数结构
  const hits = [...templates.entries()].filter(([key]) => key.split(' ')[1] === segments)
  if (hits.length === 0) {
    missing.push(raw)
    console.log(`  ✗ ${raw}  —— openapi 里没有这个路径`)
    continue
  }

  const { url, unresolved } = instantiate(raw, ids)
  if (unresolved) {
    skipped.push(raw)
    console.log(`  – ${raw}  路由 ✓（占位符没有真值，未实调）`)
    continue
  }

  const method = hits.some(([k]) => k.startsWith('GET ')) ? 'GET' : hits[0][0].split(' ')[0]
  const body = POST_BODIES[segments]
  if (method !== 'GET' && !body) {
    skipped.push(raw)
    console.log(`  – ${raw}  路由 ✓（${method} 没有探针 body，未实调）`)
    continue
  }

  let status = -1
  let head = ''
  try {
    const res = await fetch(base + url, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    })
    status = res.status
    head = (await res.text()).replace(/\s+/g, ' ').slice(0, 88)
  } catch (e) {
    head = e.message
  }

  if (status >= 200 && status < 300) {
    console.log(`  ✓ ${raw}  → ${status}`)
    ok++
  } else {
    failing.push({ raw, status, head })
    console.log(`  ✗ ${raw}  → ${status}  ${head}`)
  }
}

console.log(
  `\n可用 ${ok} 条，路由缺失 ${missing.length}，实调失败 ${failing.length}，未实调 ${skipped.length}`,
)
if (missing.length || failing.length) {
  console.log('\n两类错误的后果一样：模型会把它们当成「这个图没数据」，而不是「我路径写错了」。')
  console.log('路由缺失返回 {"detail":"API route not found"}；实调失败是别的错误。按上面结果改 src/analyze.js。')
}
process.exit(missing.length || failing.length ? 1 : 0)
