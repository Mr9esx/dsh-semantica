#!/usr/bin/env node
// scripts/install.mjs — 把本插件装进 DSH Desktop 的 web profile。
//
// 做的事（全部幂等，且动 profile 前先备份）：
//   1. 备份 profile/package.json
//   2. dependencies 加 "dsh-semantica-graph": "link:<本插件目录>"
//   3. pnpm.overrides 加同一条 link（与 desktop 里其它本地插件一致）
//   4. dsh.profile.bundles 追加 "dsh-semantica-graph"
//   5. 用 desktop 自带的 pnpm 跑 install
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
