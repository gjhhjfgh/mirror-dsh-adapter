#!/usr/bin/env node
/**
 * release-api —— 用 GitHub REST API 发布一个扁平仓库树（不依赖 git push）。
 *
 * 适用场景：本地到 github.com 的 git 通道不通，但 HTTPS API 可用。
 *
 * 用法：
 *   node scripts/release-api.mjs --repo owner/name --tag v2.4.0 --tree D:\Mirror\_publish
 *
 * 凭证（任选其一，按顺序读取）：
 *   1. 环境变量 GITHUB_TOKEN
 *   2. 文件 <repo 根>/.github-token（内容只有一行 token）
 *
 * 做的事：
 *   1. 把 --tree 目录下的文本/二进制文件整体上传为新 tree（替换远端树）
 *   2. 基于当前 main 建一个提交并移动 main
 *   3. 建/更新 tag
 *   4. 建 Release 并上传 dist 里的 .tgz 与 SHA256SUMS.txt
 */
import fs from 'node:fs'
import path from 'node:path'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const repoArg = arg('repo', '')
if (!/^[^/]+\/[^/]+$/.test(repoArg)) {
  console.error('用法: node scripts/release-api.mjs --repo <owner>/<name> --tag <tag> --tree <目录>')
  process.exit(1)
}
const [owner, repo] = repoArg.split('/')
const tag = arg('tag', '')
if (!tag) {
  console.error('缺少 --tag')
  process.exit(1)
}
const treeDir = path.resolve(arg('tree', process.cwd()))
const API = `https://api.github.com/repos/${owner}/${repo}`

function readToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv) return fromEnv.trim()
  for (const tokenFile of [path.join(treeDir, '.github-token'), path.resolve(treeDir, '..', '.github-token')]) {
    if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim()
  }
  console.error('缺少凭证：设置 GITHUB_TOKEN，或在发布树根放 .github-token 文件')
  process.exit(1)
}

const token = readToken()
const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'user-agent': 'mirror-release-api',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
}

async function call(url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!response.ok) throw new Error(`${method} ${url} → ${response.status} ${text.slice(0, 200)}`)
  return json
}

const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'dist' || entry.name === '.github-token') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile()) files.push(path.relative(treeDir, full).split(path.sep).join('/'))
  }
}
walk(treeDir)
files.sort()
console.log('文件数：', files.length)

const blobs = []
for (let index = 0; index < files.length; index += 8) {
  const batch = files.slice(index, index + 8)
  const results = await Promise.all(
    batch.map(async (file) => {
      const created = await call(`${API}/git/blobs`, 'POST', {
        content: fs.readFileSync(path.join(treeDir, file)).toString('base64'),
        encoding: 'base64',
      })
      return { path: file, sha: created.sha }
    }),
  )
  blobs.push(...results)
  process.stdout.write('.')
}
console.log('\nblob 完成')

const tree = await call(`${API}/git/trees`, 'POST', {
  tree: blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })),
})
const main = await call(`${API}/branches/main`)
const pkg = JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf8'))
const commit = await call(`${API}/git/commits`, 'POST', {
  message: `release: ${tag} (${pkg.name} ${pkg.version})`,
  tree: tree.sha,
  parents: [main.commit.sha],
})
await call(`${API}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: true })
console.log('main →', commit.sha)

try {
  await call(`${API}/git/refs/tags/${tag}`, 'DELETE')
} catch {
  /* 标签不存在 */
}
await call(`${API}/git/refs`, 'POST', { ref: `refs/tags/${tag}`, sha: commit.sha })
console.log('tag 就绪：', tag)

let notes = `Mirror ${tag}`
const changelog = path.join(treeDir, 'CHANGELOG.md')
if (fs.existsSync(changelog)) {
  const text = fs.readFileSync(changelog, 'utf8')
  const match = new RegExp(`## ${tag.replace(/^v/, '')}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text)
  if (match) notes = `## ${tag}\n${match[1].trim()}`
}
const release = await call(`${API}/releases`, 'POST', { tag_name: tag, name: `Mirror ${tag}`, body: notes })
console.log('release →', release.html_url)

const dist = path.join(treeDir, 'dist')
if (fs.existsSync(dist)) {
  for (const file of fs.readdirSync(dist)) {
    if (!file.endsWith('.tgz') && file !== 'SHA256SUMS.txt') continue
    const data = fs.readFileSync(path.join(dist, file))
    const response = await fetch(
      `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(file)}`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': file.endsWith('.tgz') ? 'application/gzip' : 'text/plain' },
        body: data,
      },
    )
    console.log('上传', file, '→', response.status)
  }
}

const verify = await call(`${API}/releases/tags/${tag}`)
console.log('资产：', (verify.assets ?? []).map((asset) => `${asset.name}(${asset.size}B)`).join(', '))
