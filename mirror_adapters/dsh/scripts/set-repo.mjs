#!/usr/bin/env node
/**
 * set-repo —— 把文档里的 <owner>/<repo> 占位符替换成真实仓库地址。
 *
 * 用法：node scripts/set-repo.mjs --repo yourname/mirror-dsh-adapter
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO_ROOT = path.resolve(ROOT, '..', '..')

const TARGETS = [
  path.join(REPO_ROOT, 'README.md'),
  path.join(ROOT, 'README.md'),
  path.join(ROOT, 'docs', 'INSTALL-GITHUB.md'),
  path.join(ROOT, 'docs', 'FAQ.md'),
]

function main() {
  const index = process.argv.indexOf('--repo')
  const repo = index >= 0 ? String(process.argv[index + 1] ?? '') : ''
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    console.error('用法: node scripts/set-repo.mjs --repo <owner>/<name>')
    return 1
  }
  const [owner, name] = repo.split('/')
  let changed = 0
  for (const file of TARGETS) {
    if (!fs.existsSync(file)) continue
    const before = fs.readFileSync(file, 'utf8')
    let after = before
      .replaceAll('<owner>/<repo>', repo)
      .replaceAll('<owner>', owner)
      .replaceAll('<repo>', name)
    if (after !== before) {
      fs.writeFileSync(file, after)
      changed += 1
      console.log(`  updated ${path.relative(REPO_ROOT, file)}`)
    }
  }
  console.log(changed > 0 ? `[set-repo] 已替换 ${changed} 个文件 → ${repo}` : '[set-repo] 没有需要替换的占位符')
  return 0
}

process.exitCode = main()
