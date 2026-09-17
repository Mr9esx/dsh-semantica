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

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
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
const KG_FILE = join(HOME, 'dsh-semantica-graph', 'kg.json')

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
    '# 两点必须知道（都是 dsh-mcp-client 的行为，不是这里的偏好）：',
    '#   · 子进程环境会先被清洗（删掉 KEY|PASSWORD|SECRET|TOKEN 和所有 DSH_*），',
    '#     所以 SEMANTICA_KG_PATH 只能在这里显式写死，不能指望继承父进程环境；',
    '#   · 只桥接工具能力，MCP resources / prompts 不会出现在 DSH 里。',
    '- insert:',
    '    - id: mcp-semantica',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: semantica',
    '        transport: stdio',
    `        command: '${MCP_BIN}'`,
    '        # 图落在这里；semantica 的 MCP server 启动时自动加载它。',
    '        env:',
    `          SEMANTICA_KG_PATH: '${KG_FILE}'`,
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
