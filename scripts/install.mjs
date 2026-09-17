#!/usr/bin/env node
// scripts/install.mjs — 把本插件装进 DSH Desktop 的 web profile。
//
// 做的事（全部幂等，动 profile 前先备份）：
//   1. profile/package.json：dependencies + pnpm.overrides 加 link:<插件目录>，
//      dsh.profile.bundles 追加插件名
//   2. profile/cordis.patch.yml：用哨兵标记维护「semantica MCP」那一条配置项
//   3. 有改动时用 desktop 自带的 pnpm 跑一次 install
//
// 第 2 步是这套架构的关键：模型能写进图，全靠 `mcp-semantica` 这条配置把
// `semantica-mcp` 挂成 `mcp__semantica__*` 工具。没有它，面板永远是空的。
// 那个子进程的环境会先被 dsh-mcp-client 清洗（删掉所有 DSH_* 和含 KEY/SECRET/TOKEN
// 的变量），所以 SEMANTICA_KG_PATH 必须在这里写死绝对路径。
//
// 用法：
//   node scripts/install.mjs              # 安装
//   node scripts/install.mjs --dry-run    # 只打印将要做的事
//   node scripts/install.mjs --remove     # 从 profile 移除
//   node scripts/install.mjs --upstream   # 退回官方 semantica-mcp（不分会话文件）
//
// 第 2 步用的是**我们自己的包装层**（mcp/server.py），不是官方的 semantica-mcp：
// 官方那份的存储假设是「一台机器一张图」，所有会话的写入落进同一个文件，于是不同对话会
// 互相覆盖同一个 id 的节点（真实事故：两个会话都写 `guangzhou`，后写的把先写的整块替换）。
// 包装层不复制官方语义，只把 5 个写工具多跑一遍到 `sessions/<会话>.json`。

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const PLUGIN_NAME = 'dsh-semantica-graph'

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry-run')
const REMOVE = args.has('--remove')
// 退回官方 server：写进 profile 的是官方命令、不装包装层。给「不信这个包装层」留的开关。
const UPSTREAM = args.has('--upstream')

/** 定位 desktop 的 harness 根。 */
function harnessHome() {
  if (process.env.DSH_HOME && existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME
  const desktop = join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
  if (existsSync(desktop)) return desktop
  return join(homedir(), '.dsh')
}

const HOME = harnessHome()
const PROFILE = join(HOME, 'profiles', 'web')
const MANIFEST = join(PROFILE, 'package.json')
const PNPM = join(HOME, '.desktop-bin', 'pnpm')

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!existsSync(MANIFEST)) fail(`找不到 profile manifest：${MANIFEST}`)

// ─────────────────────────── 1. profile manifest ───────────────────────────

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
manifest.pnpm = manifest.pnpm ?? {}
manifest.pnpm.overrides = manifest.pnpm.overrides ?? {}
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? []

const linkSpec = `link:${PLUGIN_DIR}`
const changes = []

if (REMOVE) {
  for (const [holder, label] of [
    [manifest.dependencies, 'dependencies'],
    [manifest.pnpm.overrides, 'pnpm.overrides'],
  ]) {
    if (Object.hasOwn(holder, PLUGIN_NAME)) {
      delete holder[PLUGIN_NAME]
      changes.push(`移除 ${label}.${PLUGIN_NAME}`)
    }
  }
  const i = manifest.dsh.profile.bundles.indexOf(PLUGIN_NAME)
  if (i >= 0) {
    manifest.dsh.profile.bundles.splice(i, 1)
    changes.push(`从 dsh.profile.bundles 移除 ${PLUGIN_NAME}`)
  }
} else {
  if (manifest.dependencies[PLUGIN_NAME] !== linkSpec) {
    manifest.dependencies[PLUGIN_NAME] = linkSpec
    changes.push(`dependencies.${PLUGIN_NAME} = ${linkSpec}`)
  }
  if (manifest.pnpm.overrides[PLUGIN_NAME] !== linkSpec) {
    manifest.pnpm.overrides[PLUGIN_NAME] = linkSpec
    changes.push(`pnpm.overrides.${PLUGIN_NAME} = ${linkSpec}`)
  }
  if (!manifest.dsh.profile.bundles.includes(PLUGIN_NAME)) {
    manifest.dsh.profile.bundles.push(PLUGIN_NAME)
    changes.push(`dsh.profile.bundles += ${PLUGIN_NAME}`)
  }
}

if (changes.length === 0) {
  console.log('• profile 已经是最新状态，无需改动')
} else {
  console.log(`• profile: ${MANIFEST}`)
  for (const c of changes) console.log(`  - ${c}`)
  if (!DRY) {
    copyFileSync(MANIFEST, `${MANIFEST}.bak.semantica-${Date.now()}`)
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

// ── 2. semantica MCP：往 profile 的 cordis.patch.yml 写一条 mcp-client 条目 ──
//
// 为什么不解析 YAML 再序列化：那个文件里有用户自己的注释和 `!!js` 表达式，
// 过一遍 parser/serializer 会把注释全丢掉。所以用**哨兵标记 + 文本级**处理：
// 只认标记之间的那一段，标记之外一个字都不动。
const PATCH = join(PROFILE, 'cordis.patch.yml')
const MCP_BEGIN = '# >>> dsh-semantica-graph: semantica MCP'
const MCP_END = '# <<< dsh-semantica-graph: semantica MCP'
const MCP_BIN = join(HOME, 'semantica-venv', 'bin', 'semantica-mcp')
const VENV_PY = join(HOME, 'semantica-venv', 'bin', 'python')
const KG_FILE = join(HOME, 'dsh-semantica-graph', 'kg.json')
// 包装层装到 harness 下（跟 semantica-venv 一个层级），不依赖插件仓库的路径
const WRAPPER_DIR = join(HOME, 'dsh-semantica-mcp')
const WRAPPER_SERVER = join(WRAPPER_DIR, 'server.py')
const SESSIONS_DIR = join(HOME, 'dsh-semantica-graph', 'sessions')

const PATCH_DEFAULT = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# 下面那个标记块由 \`node scripts/install.mjs\` 维护 —— 它会按标记幂等写入/更新/
# 移除这一段，标记之外的任何内容（包括你自己的注释和条目）一行都不动。

[]

# >>> dsh-semantica-graph: semantica MCP
# <<< dsh-semantica-graph: semantica MCP
`

function mcpBlock() {
  return [
    MCP_BEGIN,
    '# semantica MCP —— 知识图谱的**写入通道**。',
    '#',
    '# 模型用它把当前对话抽成图：extract_entities/extract_relations 抽取，',
    '# add_entity/add_relationship 写入，record_decision 记决策。15 个工具，',
    '# 模型看到的名字是 mcp__semantica__<tool>。',
    '#',
    '# 三点必须知道（都是 dsh-mcp-client 的行为，不是这里的偏好）：',
    '#   · 子进程环境会先被清洗（删掉 KEY|PASSWORD|SECRET|TOKEN 和所有 DSH_*），',
    '#     所以 SEMANTICA_KG_PATH 只能在这里显式写死，不能指望继承父进程环境；',
    '#   · 只桥接工具能力，MCP resources / prompts 不会出现在 DSH 里；',
    '#   · command 指的是**我们的包装层**（写入按会话分文件），不是官方 semantica-mcp。',
    '#     想退回官方那份：node scripts/install.mjs --upstream（要重启 DSH Desktop）。',
    '- insert:',
    '    - id: mcp-semantica',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: semantica',
    '        transport: stdio',
    ...(UPSTREAM
      ? [`        command: '${MCP_BIN}'`]
      : [
          `        command: '${VENV_PY}'`,
          '        args:',
          `          - '${WRAPPER_SERVER}'`,
        ]),
    '        # env 是给**子进程**的，dsh-mcp-client 会把它和清洗后的环境合并。',
    '        env:',
    '          # 合并图：所有会话的写入都会落一份到这里（「全部」视图 + 跨会话复用靠它）。',
    `          SEMANTICA_KG_PATH: '${KG_FILE}'`,
    '          # 每个会话自己的那份图文件放这里（本对话视图直接读它）。',
    `          DSH_SEMANTICA_SESSIONS_DIR: '${SESSIONS_DIR}'`,
    '        # 首次连接失败不静默：工具没挂上会记录错误，设 true 则直接中止启动。',
    '        failOnStartupError: false',
    MCP_END,
  ].join('\n')
}

function syncPatch() {
  const exists = existsSync(PATCH)
  const text = exists ? readFileSync(PATCH, 'utf8') : PATCH_DEFAULT
  const hasMark = text.includes(MCP_BEGIN) && text.includes(MCP_END)
  let next = text
  let note = null

  if (REMOVE) {
    if (!hasMark) {
      note = 'MCP 标记块不在，无需移除'
    } else {
      const a = text.indexOf(MCP_BEGIN)
      const b = text.indexOf(MCP_END) + MCP_END.length
      next = (text.slice(0, a) + text.slice(b)).replace(/\n{3,}/g, '\n\n')
      note = '移除 MCP 条目'
    }
  } else if (!hasMark) {
    const block = mcpBlock()
    // 文件主体若是空列表 `[]`，不能直接往后追加 —— 那会变成「列表里套一个空列表」。
    // 按**整行**锚定，免得匹配到注释里偶然出现的方括号。
    const body = text.replace(/^\s*#.*$/gm, '').trim()
    if (body === '[]') {
      next = text.replace(/^\[\]\s*$/m, block)
      note = '把空列表替换为 MCP 条目'
    } else if (body === '') {
      next = text.replace(/\s*$/, '\n') + block + '\n'
      note = '写入 MCP 条目'
    } else {
      next = text.replace(/\s*$/, '\n') + block + '\n'
      note = '追加 MCP 条目'
    }
  } else {
    const a = text.indexOf(MCP_BEGIN)
    const b = text.indexOf(MCP_END) + MCP_END.length
    if (text.slice(a, b) === mcpBlock()) {
      note = 'MCP 条目已是最新'
    } else {
      next = text.slice(0, a) + mcpBlock() + text.slice(b)
      note = '更新 MCP 条目（路径或内容有变）'
    }
  }

  console.log(`• MCP 配置: ${PATCH}`)
  console.log(`  - ${note}`)
  if (!REMOVE && !existsSync(MCP_BIN)) {
    console.log(`  ! 找不到 ${MCP_BIN} —— 该条目指向的服务器还不存在。`)
    console.log('    先建好 Python 环境（semantica-venv）并装 semantica，再重跑本脚本。')
  }
  if (REMOVE && !exists) return
  if (next === text) return
  if (DRY) return
  if (exists) {
    const backup = `${PATCH}.bak.semantica-${Date.now()}`
    copyFileSync(PATCH, backup)
    console.log(`  - 备份原文件 → ${backup}`)
  }
  writeFileSync(PATCH, next)
}

// ── 2.5 装包装层：mcp/server.py → <harness>/dsh-semantica-mcp/server.py ──
//
// 直接复制而不是软链到插件仓库：profile 里的 command 是**写死的绝对路径**，而且这个路径
// 要在 DSH Desktop 重启后依然有效。复制一份到 harness 下，插件仓库挪走也不影响运行。
function installWrapper() {
  if (UPSTREAM) {
    console.log('• --upstream：用官方 semantica-mcp，不装包装层')
    return
  }
  const src = join(PLUGIN_DIR, 'mcp', 'server.py')
  if (!existsSync(src)) fail(`包装层源码不在：${src}`)
  const before = existsSync(WRAPPER_SERVER) ? readFileSync(WRAPPER_SERVER, 'utf8') : null
  const next = readFileSync(src, 'utf8')
  if (before === next) {
    console.log(`• 包装层已是最新（${WRAPPER_SERVER}）`)
    return
  }
  if (DRY) {
    console.log(`• 将写入包装层 → ${WRAPPER_SERVER}`)
    return
  }
  mkdirSync(WRAPPER_DIR, { recursive: true })
  mkdirSync(SESSIONS_DIR, { recursive: true })
  writeFileSync(WRAPPER_SERVER, next)
  console.log(`  + 包装层 → ${WRAPPER_SERVER}`)
  console.log(`  + 会话图目录 → ${SESSIONS_DIR}`)
}

installWrapper()
syncPatch()

if (DRY) {
  console.log('• --dry-run：不写入、不跑 pnpm')
  process.exit(0)
}

// ─────────────────────────── 3. pnpm install ───────────────────────────

if (changes.length === 0) {
  console.log('• profile 无改动，跳过 pnpm install')
  process.exit(0)
}

console.log(`• 运行 pnpm install（${PROFILE}）…`)
const res = spawnSync(PNPM, ['install'], { cwd: PROFILE, stdio: 'inherit' })
if (res.error) fail(`pnpm 跑不起来：${res.error.message}`)
if (res.status !== 0) fail(`pnpm install 失败（exit ${res.status}）`)
console.log('✓ 装好了。host 半侧的路由与提示词段需要重启 DSH Desktop 才会生效。')
