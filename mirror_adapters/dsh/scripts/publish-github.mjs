#!/usr/bin/env node
/**
 * publish-github —— 一条命令把仓库建好、推上去、发 Release（可选）。
 *
 * 有 token（GITHUB_TOKEN / GH_TOKEN / --token）时全自动：
 *   node scripts/publish-github.mjs --repo <owner>/<name> [--public] [--tag v2.2.1]
 * 没有 token 时只打印手动步骤（不会失败到一半）。
 *
 * 安全：token 只用于一次 push（临时 URL），不会写进 .git/config；push 后把 origin 改成干净地址。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')
const ROOT = PLUGIN_ROOT

function parseArgs(argv) {
  const args = { repo: '', token: '', public: false, tag: '', dryRun: false, private: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') args.repo = String(argv[++index] ?? '')
    else if (arg === '--token') args.token = String(argv[++index] ?? '')
    else if (arg === '--tag') args.tag = String(argv[++index] ?? '')
    else if (arg === '--public') args.public = true
    else if (arg === '--private') args.private = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: options.stdio ?? 'pipe', ...options })
}

async function github(pathname, { method = 'GET', token, body = null, headers = {} } = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'mirror-publish',
      'x-github-api-version': '2022-11-28',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

async function uploadAsset({ owner, repo, releaseId, token, file }) {
  const data = fs.readFileSync(file)
  const response = await fetch(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(path.basename(file))}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/gzip',
        'user-agent': 'mirror-publish',
      },
      body: data,
    },
  )
  return { status: response.status, text: await response.text() }
}

function manualInstructions({ repo, tag, isPublic }) {
  const [ownerCandidate, nameCandidate] = repo ? repo.split('/') : ['<owner>', '<repo>']
  const owner = ownerCandidate
  const name = nameCandidate
  console.log('没有检测到 GitHub token，下面是手动步骤（或设置 GITHUB_TOKEN 后重跑本脚本）：')
  console.log('')
  console.log('1) 建仓库（网页）：https://github.com/new')
  console.log(`   - 名称：${name}，可见性：${isPublic ? 'Public' : 'Private（确认不含隐私后再改 Public）'}`)
  console.log('')
  console.log('2) 本地已初始化并提交好，直接推：')
  console.log(`   git remote add origin https://github.com/${owner}/${name}.git`)
  console.log('   git push -u origin main')
  console.log(`   git push origin ${tag}`)
  console.log('')
  console.log('3) 建 Release 并上传两个文件（网页 Releases → Draft a new release）：')
  console.log(`   tag：${tag}`)
  console.log(`   资产：dist/mirror-dsh-adapter-*.tgz、dist/SHA256SUMS.txt`)
  console.log('')
  console.log('4) 发完把占位符换成真实地址：')
  console.log(`   node scripts/set-repo.mjs --repo ${owner}/${name}`)
  console.log('')
  console.log('（可选）安装 gh 后一条命令完成：gh release create ...（见 docs/INSTALL-GITHUB.md）')
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/publish-github.mjs --repo <owner>/<name> [--public] [--tag vX.Y.Z] [--dry-run]')
    return 0
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
  const tag = args.tag || `v${pkg.version}`
  const repo = args.repo.trim()
  const token = args.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const isPublic = args.public && !args.private

  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    console.error('[publish] 还没有 git 仓库，先跑：git init -b main && git add . && git commit -m "chore: initial"')
    return 1
  }
  if (!repo || repo.split('/').length !== 2) {
    console.error('[publish] 需要 --repo <owner>/<name>（例如 yourname/mirror-dsh-adapter）')
    return 1
  }
  const [owner, name] = repo.split('/')

  if (!token) return manualInstructions({ repo, tag, isPublic })

  // 1) 建仓库（已存在则忽略 422）
  const created = await github('/user/repos', {
    method: 'POST',
    token,
    body: {
      name,
      private: !isPublic,
      description: 'Mirror · AI 的记忆治理层 —— DSH 插件（本地记忆内核 + 面板）',
      has_issues: true,
      has_wiki: false,
    },
  })
  if (created.status === 201) console.log(`[publish] 已创建仓库：${created.json.html_url}（${isPublic ? 'public' : 'private'}）`)
  else if (created.status === 422) console.log('[publish] 仓库已存在，继续推送')
  else {
    console.error(`[publish] 创建仓库失败 HTTP ${created.status}：${created.text.slice(0, 300)}`)
    return 1
  }

  // 2) push（临时 token URL，不落盘）
  const cleanUrl = `https://github.com/${owner}/${name}.git`
  const pushUrl = `https://x-access-token:${token}@github.com/${owner}/${name}.git`
  try {
    git(['remote', 'remove', 'origin'])
  } catch {
    /* 没有就忽略 */
  }
  git(['remote', 'add', 'origin', cleanUrl])
  console.log('[publish] 推送 main…')
  git(['push', '-u', pushUrl, 'main'], { stdio: 'inherit' })
  try {
    git(['push', pushUrl, tag], { stdio: 'inherit' })
  } catch {
    console.log(`[publish] 标签 ${tag} 推送失败（可能已存在）`)
  }

  // 3) Release + 上传资产
  if (!args.dryRun) {
    const release = await github(`/repos/${owner}/${name}/releases`, {
      method: 'POST',
      token,
      body: {
        tag_name: tag,
        name: tag,
        body: fs.existsSync(path.join(PLUGIN_ROOT, 'CHANGELOG.md'))
          ? `见 CHANGELOG：${pkg.version}`
          : `Mirror ${pkg.version}`,
        draft: false,
        prerelease: false,
      },
    })
    if (release.status === 201) {
      console.log(`[publish] Release：${release.json.html_url}`)
      const distDir = path.join(PLUGIN_ROOT, 'dist')
      const assets = fs.existsSync(distDir)
        ? fs.readdirSync(distDir).filter((file) => file.endsWith('.tgz') || file === 'SHA256SUMS.txt')
        : []
      for (const file of assets) {
        const upload = await uploadAsset({
          owner,
          repo: name,
          releaseId: release.json.id,
          token,
          file: path.join(distDir, file),
        })
        console.log(`[publish] 上传 ${file} → HTTP ${upload.status}`)
      }
      if (assets.length === 0) console.log('[publish] 提示：dist/ 为空，先跑 node scripts/make-release.mjs')
    } else if (release.status === 422) {
      console.log('[publish] Release 已存在，跳过')
    } else {
      console.error(`[publish] 创建 Release 失败 HTTP ${release.status}：${release.text.slice(0, 300)}`)
    }
  }

  console.log('')
  console.log(`[publish] 完成。仓库：${cleanUrl}`)
  console.log(`[publish] 下一步：node scripts/set-repo.mjs --repo ${owner}/${name}`)
  return 0
}

process.exitCode = await main()
