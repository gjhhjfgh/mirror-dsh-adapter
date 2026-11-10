#!/usr/bin/env node
/**
 * make-release —— 为 GitHub Release 打一个可直接安装的 .tgz（不需要 npm）。
 *
 * 产物：
 *   dist/mirror-dsh-adapter-<version>.tgz   （包内容：lib/core/bin/docs/samples/清单）
 *   dist/SHA256SUMS.txt
 *
 * 用法：
 *   node scripts/make-release.mjs            # 输出到 dist/
 *   node scripts/make-release.mjs --out <dir>
 *
 * 发布流程（纯 GitHub）：
 *   1. 跑本脚本，得到 .tgz 与 sha256
 *   2. GitHub → Releases → 新建 tag（如 v2.2.0）→ 上传 .tgz 与 SHA256SUMS.txt
 *   3. 用户安装：
 *        node bin/mirror-install.mjs --tarball <下载的 .tgz 路径>
 *      或直接：
 *        node bin/mirror-install.mjs --from-github <owner>/<repo>@v2.2.0
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeTarGz } from '../bin/lib/tar.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const ITEMS = ['lib', 'core', 'bin', 'docs', 'samples', 'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']

function parseOut(argv) {
  const index = argv.indexOf('--out')
  return index >= 0 && argv[index + 1] ? path.resolve(argv[index + 1]) : path.join(ROOT, 'dist')
}

const outDir = parseOut(process.argv.slice(2))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const outFile = path.join(outDir, `${pkg.name}-${version}.tgz`)

if (pkg.private) {
  console.error('[make-release] package.json 还是 private，先去掉再发。')
  process.exit(1)
}

const entries = ITEMS.filter((item) => fs.existsSync(path.join(ROOT, item)))
const result = writeTarGz({ sourceRoot: ROOT, outFile, entries })
const sha = crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex')

const sumsPath = path.join(outDir, 'SHA256SUMS.txt')
fs.writeFileSync(sumsPath, `${sha}  ${path.basename(outFile)}\n`, 'utf8')

console.log(`[make-release] ${pkg.name} v${version}`)
console.log(`  文件：${outFile}`)
console.log(`  大小：${Math.round(result.bytes / 1024)} KB · ${result.files} 个文件`)
console.log(`  SHA256：${sha}`)
console.log('')
console.log('上传到 GitHub Release（tag 建议 v' + version + '）：')
console.log(`  gh release create v${version} "${outFile}" "${sumsPath}" --title "v${version}" --notes-file CHANGELOG.md`)
console.log('')
console.log('用户安装（二选一）：')
console.log(`  node bin/mirror-install.mjs --tarball <下载的 ${path.basename(outFile)}>`)
console.log(`  node bin/mirror-install.mjs --from-github <owner>/${pkg.name}@v${version}`)
