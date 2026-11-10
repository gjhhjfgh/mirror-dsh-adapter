#!/usr/bin/env node
/**
 * mirror-install —— 把 Mirror 插件装进一个 DSH profile（不需要 npm registry）。
 *
 * 四种来源：
 *   node bin/mirror-install.mjs                          # 当前源码目录（开发用）
 *   node bin/mirror-install.mjs --source <dir>           # 指定已 clone 的插件目录
 *   node bin/mirror-install.mjs --tarball <file|url>     # GitHub Release 的 .tgz（或任意 URL）
 *   node bin/mirror-install.mjs --from-github owner/repo[@ref]   # 直接拉 GitHub 仓库
 *
 * 做的事（幂等）：
 *   1. 复制 lib/ core/ docs/ samples/ 与清单到 <profile>/node_modules/mirror-dsh-adapter
 *   2. cordis.patch.yml 没有 mirror 条目就追加
 *   3. profile package.json 登记依赖（tarball 来源会把包放进 <profile>/vendor/ 并写 file: 依赖）
 * 不重启进程、不改用户数据。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractTarGz, findPackageDir, writeTarGz } from './lib/tar.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const COPY_ITEMS = ['lib', 'core', 'docs', 'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'samples']
const RELEASE_ITEMS = [...COPY_ITEMS, 'bin']
const PLUGIN_ID = 'mirror-memory'
const PLUGIN_NAME = 'mirror-dsh-adapter'

function parseArgs(argv) {
  const args = { profile: '', source: '', tarball: '', github: '', check: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') args.profile = String(argv[++index] ?? '')
    else if (arg === '--source') args.source = String(argv[++index] ?? '')
    else if (arg === '--tarball') args.tarball = String(argv[++index] ?? '')
    else if (arg === '--from-github' || arg === '--github') args.github = String(argv[++index] ?? '')
    else if (arg === '--check' || arg === '--dry-run') args.check = true
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

function resolveDshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

function resolveProfile(explicit) {
  if (explicit) return path.resolve(explicit)
  const home = resolveDshHome()
  for (const name of ['web', 'default', 'cli']) {
    const candidate = path.join(home, 'profiles', name)
    if (fs.existsSync(path.join(candidate, 'node_modules'))) return candidate
  }
  return path.join(home, 'profiles', 'web')
}

function readJson(file) {
  // 兼容 Windows 编辑器 / PowerShell 写出的 UTF-8 BOM
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

function copyFileWithRetry(source, target, attempts = 4) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (fs.existsSync(target)) {
        try {
          fs.chmodSync(target, 0o666)
        } catch {
          /* 交给兜底 */
        }
      }
      fs.copyFileSync(source, target)
      return true
    } catch (error) {
      lastError = error
      try {
        fs.rmSync(target, { force: true })
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, fs.readFileSync(source))
        return true
      } catch {
        /* 继续重试 */
      }
      const until = Date.now() + attempt * 120
      while (Date.now() < until) {
        /* 忙等，避免引入异步 */
      }
    }
  }
  throw lastError
}

function copyDirectory(source, target, actions, check) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyDirectory(from, to, actions, check)
      continue
    }
    actions.push(to)
    if (!check) copyFileWithRetry(from, to)
  }
}

function ensurePatchEntry(profile, actions, check) {
  const patchPath = path.join(profile, 'cordis.patch.yml')
  let text = ''
  try {
    text = fs.readFileSync(patchPath, 'utf8')
  } catch {
    text = ''
  }
  if (text.includes(PLUGIN_NAME) || text.includes(`- id: ${PLUGIN_ID}`)) return { changed: false, reason: '已有 mirror 条目' }
  const block = `\n# Mirror · AI 认知治理层（记忆 + 文档库 + 记忆包），本地内核，无外部服务。\n- id: ${PLUGIN_ID}\n  name: "${PLUGIN_NAME}"\n  config:\n    dataDir: ""\n    injectTokenBudget: 3000\n    autoExtract: false\n    docAutoScan: true\n`
  actions.push(`${patchPath}（追加 ${PLUGIN_ID} 条目）`)
  if (!check) {
    fs.mkdirSync(path.dirname(patchPath), { recursive: true })
    fs.writeFileSync(patchPath, `${text.trimEnd()}\n${block}`, 'utf8')
  }
  return { changed: true, reason: '已追加 patch 条目' }
}

function ensureProfileManifest(profile, depSpec, actions, check) {
  const manifestPath = path.join(profile, 'package.json')
  if (!fs.existsSync(manifestPath)) return { changed: false, reason: 'profile 没有 package.json（跳过依赖登记）' }
  let manifest
  try {
    manifest = readJson(manifestPath)
  } catch (error) {
    // 不因为清单坏了就中断安装：文件与 patch 已经写好了
    return { changed: false, reason: `package.json 解析失败，跳过依赖登记（${error instanceof Error ? error.message : String(error)}）` }
  }
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  let changed = false
  if (manifest.dependencies[PLUGIN_NAME] !== depSpec) {
    manifest.dependencies[PLUGIN_NAME] = depSpec
    changed = true
  }
  if (!manifest.dsh.profile.bundles.includes(PLUGIN_NAME)) {
    manifest.dsh.profile.bundles.push(PLUGIN_NAME)
    changed = true
  }
  if (changed) {
    actions.push(`${manifestPath}（依赖 ${depSpec} / bundles）`)
    if (!check) {
      const backup = `${manifestPath}.bak-mirror-install`
      if (!fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup)
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    }
  }
  return { changed, reason: changed ? `已登记依赖 ${depSpec}` : '清单已包含 mirror' }
}

function packItems(sourceRoot, outFile, items) {
  return writeTarGz({ sourceRoot, outFile, entries: items.filter((item) => fs.existsSync(path.join(sourceRoot, item))) })
}

async function readTarball(spec) {
  if (/^https?:\/\//i.test(spec)) {
    const response = await fetch(spec, { signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${spec}`)
    return Buffer.from(await response.arrayBuffer())
  }
  const file = path.resolve(spec)
  if (!fs.existsSync(file)) throw new Error(`找不到 tarball：${file}`)
  return fs.readFileSync(file)
}

function parseGithubSpec(spec) {
  const [repoPart, refPart] = String(spec).split('@')
  const parts = repoPart.split('/').filter(Boolean)
  if (parts.length !== 2) throw new Error('--from-github 需要 owner/repo[@ref] 形式，例如 yourname/mirror-dsh-adapter@v2.2.0')
  return { owner: parts[0], repo: parts[1], ref: refPart || 'main' }
}

function stagingDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mirror-${label}-`))
  return dir
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node bin/mirror-install.mjs [--profile <dir>] [--source <dir> | --tarball <file|url> | --from-github owner/repo[@ref]] [--check] [--json]')
    return 0
  }

  const profile = resolveProfile(args.profile)
  if (!fs.existsSync(path.join(profile, 'node_modules'))) {
    console.error('[mirror-install] 目标不像一个 DSH profile（缺 node_modules）。')
    console.error('  用 --profile 指定，例如 $DSH_HOME/profiles/web')
    return 1
  }

  const cleanup = []
  let sourceRoot = args.source ? path.resolve(args.source) : PACKAGE_ROOT
  let depSpec = `file:${sourceRoot.replace(/\\/g, '/')}`
  let tarballBuffer = null
  let tarballName = ''

  try {
    if (args.tarball || args.github) {
      let raw = null
      if (args.github) {
        const { owner, repo, ref } = parseGithubSpec(args.github)
        const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`
        console.log(`[mirror-install] 从 GitHub 下载：${url}`)
        raw = await readTarball(url)
      } else {
        raw = await readTarball(args.tarball)
        console.log(`[mirror-install] 读取 tarball：${args.tarball}`)
      }
      const extractDir = stagingDir('extract')
      cleanup.push(extractDir)
      extractTarGz(raw, extractDir)
      const found = findPackageDir(extractDir)
      if (!found) throw new Error('tarball 里找不到 package.json（name=mirror-dsh-adapter）')
      sourceRoot = found

      // 统一成「包 tarball」放进 profile/vendor，依赖用 file:./vendor/...
      const version = (() => {
        try {
          return readJson(path.join(sourceRoot, 'package.json')).version
        } catch {
          return '0.0.0'
        }
      })()
      tarballName = `${PLUGIN_NAME}-${version}.tgz`
      const stagingTarball = path.join(stagingDir('pack'), tarballName)
      packItems(sourceRoot, stagingTarball, RELEASE_ITEMS)
      tarballBuffer = fs.readFileSync(stagingTarball)
      console.log(`[mirror-install] 已整理成 ${tarballName}（${Math.round(tarballBuffer.length / 1024)} KB）`)
    }

    const version = (() => {
      try {
        return readJson(path.join(sourceRoot, 'package.json')).version
      } catch {
        return 'unknown'
      }
    })()
    if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) throw new Error(`找不到插件源码：${sourceRoot}`)

    if (tarballBuffer) {
      const vendorDir = path.join(profile, 'vendor')
      depSpec = `file:./vendor/${tarballName}`
      if (!args.check) {
        fs.mkdirSync(vendorDir, { recursive: true })
        fs.writeFileSync(path.join(vendorDir, tarballName), tarballBuffer)
      }
    }

    const moduleTarget = path.join(profile, 'node_modules', PLUGIN_NAME)
    const actions = []
    const failures = []
    console.log(`[mirror-install] 源：${sourceRoot}（v${version}）`)
    console.log(`[mirror-install] 目标 profile：${profile}`)

    for (const item of COPY_ITEMS) {
      const from = path.join(sourceRoot, item)
      if (!fs.existsSync(from)) continue
      const to = path.join(moduleTarget, item)
      try {
        if (fs.statSync(from).isDirectory()) copyDirectory(from, to, actions, args.check)
        else {
          actions.push(to)
          if (!args.check) copyFileWithRetry(from, to)
        }
      } catch (error) {
        failures.push(`${item}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const patch = ensurePatchEntry(profile, actions, args.check)
    const manifest = ensureProfileManifest(profile, depSpec, actions, args.check)
    const report = { profile, target: moduleTarget, version, check: args.check, dep: depSpec, actions, patch, manifest, failures }

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(args.check ? '[mirror-install] 预演（--check，不写盘）：' : '[mirror-install] 已写入：')
      for (const action of actions.slice(0, 40)) console.log(`  - ${action}`)
      if (actions.length > 40) console.log(`  … 共 ${actions.length} 项`)
      console.log(`  · cordis.patch.yml：${patch.reason}`)
      console.log(`  · profile 清单：${manifest.reason}`)
      if (tarballBuffer) console.log(`  · 依赖形态：${depSpec}（无需 npm registry）`)
    }

    if (failures.length > 0) {
      console.error(`[mirror-install] ${failures.length} 个文件写入失败（多半是 DSH 正在运行锁文件）：`)
      for (const failure of failures) console.error(`  - ${failure}`)
      console.error('  关闭 dsh web 后再跑一次即可。')
      return 1
    }

    console.log('')
    console.log('[mirror-install] 下一步：')
    console.log('  1) 重启 dsh web（关闭后重新启动；客户端 bundle 只在进程启动时编入）')
    console.log('  2) 刷新浏览器，左侧栏应出现 Mirror 图标')
    console.log('  3) 自检：node bin/mirror-doctor.mjs')
    return 0
  } finally {
    for (const dir of cleanup) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`[mirror-install] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
