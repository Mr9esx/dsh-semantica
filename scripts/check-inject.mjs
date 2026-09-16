// scripts/check-inject.mjs — 检查两半侧声明的 inject 是否覆盖了它们真正访问的服务
//
// 为什么需要这个检查：
//   Cordis 的 ctx 是服务代理。访问**没写进 inject 数组**的服务属性会直接抛
//   `cannot get property "x" without inject`，整个插件条目 apply 失败 ——
//   不是降级，是加载不起来，Web GUI 直接弹「Failed to load plugins」。
//
//   这个坑真的踩过：client.js 里写了 `const inject = []` 却用了 ctx.slots。
//   更麻烦的是 DSH 加载失败后会把插件从 dsh.profile.bundles 里摘掉并跑一次
//   pnpm install，插件的 dependencies / node_modules 链接一起被清掉，
//   必须重新执行 install.mjs 才能恢复。
//
//   另一个方向的坑是「静默失败」：客户端 fiber 会**等待** inject 的服务就绪，
//   声明了一个永远不存在的服务，插件会永远不 apply，而且不报错。
//
// 用法：node scripts/check-inject.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ctx 上属于「核心」、不需要 inject 就能用的成员。
// 依据：宿主侧插件里 ctx.logger 被用了 168 次且从不声明；effect/on/get/inject
// 是 Cordis 的上下文方法本身。
const CORE = new Set([
  'effect', 'on', 'get', 'inject', 'logger', 'emit', 'set', 'start', 'stop',
])

/** 造一个会严格执行 inject 的 ctx（Proxy 模拟 Cordis 的取值语义）。 */
function strictCtx(injectList, services, log) {
  const core = {
    effect: (fn) => {
      const c = fn()
      return typeof c === 'function' ? c : () => {}
    },
    on: () => {},
    // get() 是**安全读取**：服务缺席返回 undefined 而不抛 —— 这正是它与
    // 属性访问的区别，也是 betterSidebar 这类可选服务该用的方式。
    get: (k) => services[k],
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    inject: (names, cb) => {
      const list = Array.isArray(names) ? names : [names]
      if (list.every((n) => services[n] !== undefined)) {
        log.push(`inject(${list.join(',')}) → 回调执行`)
        cb(strictCtx([...injectList, ...list], services, log))
      } else {
        log.push(`inject(${list.join(',')}) → 服务缺席，回调不执行`)
      }
    },
  }
  return new Proxy(core, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      if (prop in t) return t[prop]
      if (CORE.has(prop)) return undefined
      if (injectList.includes(prop)) {
        const s = services[prop]
        if (s === undefined) throw new Error(`service "${prop}" not available`)
        return s
      }
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

const react = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat() }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
}

let failed = false

// ── 客户端半侧 ──────────────────────────────────────────────────────────
{
  console.log('══ src/client.js ══')
  let loaded = null
  const win = { __ModuleLoader__: { load: (d) => { loaded = d } } }
  new Function('window', readFileSync(join(ROOT, 'src/client.js'), 'utf8'))(win)
  const mod = loaded.factory((n) => {
    if (n === 'react') return react
    throw new Error(`意外的 require("${n}")`)
  })

  console.log('  inject =', JSON.stringify(mod.inject))
  const log = []
  try {
    mod.apply(
      strictCtx(mod.inject ?? [], {
        // 客户端 ctx 上的服务。slots / locale 是本插件用到的。
        slots: { inject: (name, cb) => cb(), register: () => {} },
        locale: 'zh-CN',
        betterSidebar: { registerTab: () => () => {}, openTab: () => {} },
      }, log),
    )
    console.log('  ✓ apply 通过严格 inject 检查')
    log.forEach((l) => console.log('    ', l))
  } catch (e) {
    console.log('  ✗ apply 抛错:', e.message)
    failed = true
  }
}

// ── 宿主半侧 ────────────────────────────────────────────────────────────
{
  console.log('\n══ src/index.js ══')
  const host = await import(join(ROOT, 'src/index.js'))
  console.log('  inject =', JSON.stringify(host.inject))
  const log = []
  try {
    host.apply(strictCtx(host.inject ?? [], {
      webServer: { register: () => {} },
    }, log))
    console.log('  ✓ apply 通过严格 inject 检查')
    log.forEach((l) => console.log('    ', l))
  } catch (e) {
    console.log('  ✗ apply 抛错:', e.message)
    failed = true
  }
}

console.log(failed ? '\n✗ 有半侧未通过' : '\n✓ 两半侧都通过')
process.exit(failed ? 1 : 0)
