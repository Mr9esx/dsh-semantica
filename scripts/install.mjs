#!/usr/bin/env node
// scripts/install.mjs — 把本插件装进 DSH Desktop 的 web profile。
//
// 做的事（全部幂等，且动 profile 前先备份）：
//   1. 备份 profile/package.json
//   2. dependencies 加 "dsh-semantica-graph": "link:<本插件目录>"
//   3. pnpm.overrides 加同一条 link（与 desktop 里其它本地插件一致）
//   4. dsh.profile.bundles 追加 "dsh-semantica-graph"
//   5. 往 profile 的 cordis.patch.yml 里幂等写入 semantica MCP 条目（标记块）
//   6. 用 desktop 自带的 pnpm 跑 install
//
// desktop 的 pnpm runner 在跑 pnpm 前会临时摘掉 generation-projection 管理的插件
// 依赖（避免 pnpm 抹掉它们），跑完再恢复——我们加的这个插件不在 projection 里，
// 因此不会被摘掉。
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

const original = readFileSync(MANIFEST, 'utf8')
const manifest = JSON.parse(original)

manifest.dependencies = manifest.dependencies ?? {}
manifest.pnpm = manifest.pnpm ?? {}
manifest.pnpm.overrides = manifest.pnpm.overrides ?? {}
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? []

const linkSpec = `link:${PLUGIN_DIR}`
const changes = []

if (REMOVE) {
  if (Object.hasOwn(manifest.dependencies, PLUGIN_NAME)) {
    delete manifest.dependencies[PLUGIN_NAME]
    changes.push(`移除 dependencies.${PLUGIN_NAME}`)
  }
  if (Object.hasOwn(manifest.pnpm.overrides, PLUGIN_NAME)) {
    delete manifest.pnpm.overrides[PLUGIN_NAME]
    changes.push(`移除 pnpm.overrides.${PLUGIN_NAME}`)
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
}

// ── semantica MCP：往 profile 的 cordis.patch.yml 写一条 mcp-client 条目 ──
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
    '# semantica MCP（知识图谱的「声明」通道）',
    '#',
    '# 上游推荐的用法就是 MCP：agent 在做事的过程中主动声明决策/实体/关系，',
    '# 而不是事后从对话记录里反推。15 个工具，模型看到的名字是 mcp__semantica__<tool>。',
    '#',
    '# 注意两点：',
    '#   · MCP resources 与 prompts 不受 dsh-mcp-client 支持，只桥接工具；',
    '#   · 子进程环境会先被清洗（删掉 KEY|PASSWORD|SECRET|TOKEN 和所有 DSH_*），',
    '#     所以 SEMANTICA_KG_PATH 必须在这里显式给出，不能指望继承父进程环境。',
    '- insert:',
    '    - id: mcp-semantica',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: semantica',
    '        transport: stdio',
    `        command: '${MCP_BIN}'`,
    '        # 声明出来的图落在这里；semantica 的 MCP server 启动时会自动加载它。',
    '        env:',
    `          SEMANTICA_KG_PATH: '${KG_FILE}'`,
    '        # 首次连接失败不静默：工具没挂上会记录错误，设 true 则直接中止启动。',
    '        failOnStartupError: false',
    MCP_END,
  ].join('\n')
}

function syncPatch() {
  const exists = existsSync(PATCH)
  let text = exists ? readFileSync(PATCH, 'utf8') : PATCH_DEFAULT
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
    console.log(`    先按 README「步骤1」建好 Python 环境，再重跑本脚本。`)
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

if (changes.length > 0) {
  const backup = `${MANIFEST}.bak.semantica-${Date.now()}`
  copyFileSync(MANIFEST, backup)
  console.log(`• 备份原 manifest → ${backup}`)
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
}

// 跑 pnpm install（用 desktop 自带的 wrapper，保证与它自己的安装语义一致）
if (!existsSync(PNPM)) {
  console.log(`! 找不到 desktop pnpm（${PNPM}），请在 profile 目录手动执行 pnpm install：`)
  console.log(`    cd "${PROFILE}" && pnpm install`)
  process.exit(0)
}

console.log(`• 运行 pnpm install（${PROFILE}）…`)
const res = spawnSync(PNPM, ['install'], {
  cwd: PROFILE,
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: HOME },
})

if (res.status !== 0) {
  console.error(`\n✗ pnpm install 失败（退出码 ${res.status}）。`)
  console.error(`  profile manifest 已改动；需要回滚就恢复备份文件。`)
  process.exit(res.status ?? 1)
}

// 客户端半侧直接加载 src/client.js（只依赖 react，在基座冻结表里），
// 没有第三方库要内联，因此不需要构建步骤。

console.log(`
✓ 安装完成。

接下来：
  1. 在 DSH Desktop 里硬刷新页面（Cmd+Shift+R）
     —— 客户端半侧是热加载的；host 半侧（新路由）需要重启 DSH Desktop 才生效。
  2. 打开任意会话，点会话标题右侧的图谱按钮。

两件 Python 侧的前置事项：

  (a) Semantica 本体 + Explorer 组件。Explorer 是可选 extra，
      裸装 semantica 不带 fastapi / uvicorn：

        <venv>/bin/pip install "semantica[explorer]"

      两个 spaCy 模型（en_core_web_sm / zh_core_web_sm）也都必须装。

      插件按顺序自动探测解释器：
        1. 环境变量 DSH_SEMANTICA_PYTHON
        2. $DSH_HOME/semantica-venv/bin/python   ← 推荐，见 README
        3. 插件目录旁的 .venv/bin/python
        4. python3

  (b) 重启 DSH Desktop。Explorer 界面不需要额外配置 —— 插件在自己的
      侧边栏标签里直接内嵌 iframe，不走 better-sidebar 的浏览器标签，
      因此**不需要**去配「浏览器本地回环允许清单」。
`)
