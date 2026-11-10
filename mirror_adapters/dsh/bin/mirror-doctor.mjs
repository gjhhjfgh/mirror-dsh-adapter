#!/usr/bin/env node
/**
 * mirror-doctor —— 装机自检。把「为什么我的 Mirror 没显示」变成一张清单。
 *
 * 用法：
 *   node bin/mirror-doctor.mjs                     # 检查运行环境 + profile 安装
 *   node bin/mirror-doctor.mjs --profile <dir>     # 指定 profile
 *   node bin/mirror-doctor.mjs --http http://127.0.0.1:3080
 *   node bin/mirror-doctor.mjs --json
 *
 * 退出码：0 全部通过 / 1 有 FAIL（WARN 不影响退出码）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const MIN_NODE = [22, 5]
const PLUGIN_NAME = 'mirror-dsh-adapter'

function parseArgs(argv) {
  const args = { profile: '', http: '', json: false, dataDir: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') args.profile = String(argv[++index] ?? '')
    else if (arg === '--http') args.http = String(argv[++index] ?? '')
    else if (arg === '--data-dir') args.dataDir = String(argv[++index] ?? '')
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

function resolveProfile(explicit) {
  if (explicit) return path.resolve(explicit)
  const home = String(process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh')
  for (const name of ['web', 'default', 'cli']) {
    const candidate = path.join(home, 'profiles', name)
    if (fs.existsSync(path.join(candidate, 'node_modules'))) return candidate
  }
  return path.join(home, 'profiles', 'web')
}

function compareVersion(current, minimum) {
  const parse = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [a1, a2, a3] = parse(current)
  const [b1, b2, b3] = parse(minimum.join('.'))
  if (a1 !== b1) return a1 - b1
  if (a2 !== b2) return a2 - b2
  return a3 - b3
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node bin/mirror-doctor.mjs [--profile <dir>] [--http <baseUrl>] [--data-dir <dir>] [--json]')
    return 0
  }
  const checks = []
  const add = (level, name, detail) => checks.push({ level, name, detail })

  // 1) Node 版本
  if (compareVersion(process.versions.node, MIN_NODE) >= 0) {
    add('PASS', 'Node 版本', `${process.versions.node}（需要 ≥ ${MIN_NODE.join('.')}）`)
  } else {
    add('FAIL', 'Node 版本', `${process.versions.node} 太旧，需要 ≥ ${MIN_NODE.join('.')}`)
  }

  // 2) node:sqlite 可用（插件内核依赖）
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)')
    db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='trigram')")
    db.prepare('INSERT INTO t (id, body) VALUES (?, ?)').run('1', '中文检索测试')
    db.exec("INSERT INTO f (body) VALUES ('中文检索测试')")
    // trigram 需要 ≥3 字符；2 字查询由存储层走 LIKE 兜底，这里用 3 字探针
    const hit = db.prepare('SELECT body FROM f WHERE f MATCH ?').all('中文检')
    db.close()
    if (hit.length === 0) throw new Error('FTS5 查询无结果')
    add('PASS', 'node:sqlite + FTS5', '内存库建表/写入/检索均可用')
  } catch (error) {
    add('FAIL', 'node:sqlite + FTS5', `不可用：${error instanceof Error ? error.message : String(error)}`)
  }

  // 3) profile 与插件安装
  const profile = resolveProfile(args.profile)
  const moduleDir = path.join(profile, 'node_modules', PLUGIN_NAME)
  if (!fs.existsSync(path.join(profile, 'node_modules'))) {
    add('FAIL', 'DSH profile', `不是有效的 profile：${profile}（缺 node_modules）`)
  } else {
    add('PASS', 'DSH profile', profile)
  }
  if (fs.existsSync(path.join(moduleDir, 'package.json'))) {
    const installed = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8'))
    const source = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    if (installed.version === source.version) add('PASS', '插件', `${PLUGIN_NAME} v${installed.version} 已安装`)
    else add('WARN', '插件', `已安装 v${installed.version}，源码 v${source.version}（跑一次 mirror-install 同步）`)
  } else {
    add('FAIL', '插件', `未安装到 ${moduleDir}（跑 node bin/mirror-install.mjs）`)
  }

  // 4) patch 条目
  const patchPath = path.join(profile, 'cordis.patch.yml')
  try {
    const text = fs.readFileSync(patchPath, 'utf8')
    if (text.includes(PLUGIN_NAME)) add('PASS', 'cordis.patch.yml', '包含 mirror-dsh-adapter 条目')
    else add('WARN', 'cordis.patch.yml', '没有 mirror 条目（mirror-install 会自动追加）')
  } catch {
    add('WARN', 'cordis.patch.yml', '文件不存在（首次安装会创建）')
  }

  // 5) 数据目录可写
  const dataDir = args.dataDir || path.join(os.homedir(), '.mirror')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const probe = path.join(dataDir, `.doctor-${Date.now()}.tmp`)
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.rmSync(probe, { force: true })
    add('PASS', '数据目录', `${dataDir} 可写`)
  } catch (error) {
    add('FAIL', '数据目录', `不可写：${dataDir}（${error instanceof Error ? error.message : String(error)}）`)
  }

  // 6) 可选：正在运行的实例
  if (args.http) {
    const base = args.http.replace(/\/+$/, '')
    try {
      const response = await fetch(`${base}/mirror/api/state`, { signal: AbortSignal.timeout(5000) })
      const body = await response.json()
      if (response.ok && body && typeof body === 'object') {
        add('PASS', '运行中的实例', `${base} 可达（version ${body.version ?? '?'}，记忆 ${body.stats?.memories ?? '?'} 条）`)
      } else {
        add('WARN', '运行中的实例', `${base} 返回异常 HTTP ${response.status}`)
      }
    } catch (error) {
      add('FAIL', '运行中的实例', `${base} 不可达：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const failed = checks.filter((check) => check.level === 'FAIL').length
  const warned = checks.filter((check) => check.level === 'WARN').length

  if (args.json) {
    console.log(JSON.stringify({ ok: failed === 0, failed, warned, checks }, null, 2))
  } else {
    console.log('Mirror 自检')
    console.log('')
    for (const check of checks) {
      const icon = check.level === 'PASS' ? '✓' : check.level === 'WARN' ? '!' : '✗'
      console.log(`  ${icon} ${check.name}：${check.detail}`)
    }
    console.log('')
    console.log(`结果：${checks.length - failed - warned} PASS · ${warned} WARN · ${failed} FAIL`)
    if (failed > 0) console.log('处理建议：先跑 node bin/mirror-install.mjs，再重启 dsh web。')
  }
  return failed === 0 ? 0 : 1
}

process.exitCode = await main()
