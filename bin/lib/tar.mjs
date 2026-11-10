/**
 * bin/lib/tar.mjs —— 零依赖的 tar.gz 读写（给 GitHub 分发用）
 *
 * 为什么自己写：不希望"装个插件"还依赖 npm registry 或系统 tar.exe。
 * 只支持 ustar（普通文件/目录），足够打包插件；解包时拒绝 `..` 与绝对路径。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const BLOCK = 512

function octal(value, length) {
  const text = Math.max(0, Math.floor(Number(value) || 0)).toString(8)
  return `${'0'.repeat(Math.max(0, length - 1 - text.length))}${text}\0`
}

function writeHeader({ name, size, mode = 0o644, type = '0', mtime = Math.floor(Date.now() / 1000) }) {
  const header = Buffer.alloc(BLOCK, 0)
  header.write(String(name).slice(0, 100), 0, 'utf8')
  header.write(octal(mode, 8), 100, 'utf8')
  header.write(octal(0, 8), 108, 'utf8') // uid
  header.write(octal(0, 8), 116, 'utf8') // gid
  header.write(octal(size, 12), 124, 'utf8')
  header.write(octal(mtime, 12), 136, 'utf8')
  header.write('        ', 148, 'utf8') // checksum 占位（8 空格）
  header.write(type, 156, 'utf8')
  header.write('ustar\0', 257, 'utf8')
  header.write('00', 263, 'utf8')
  // checksum = 所有字节求和
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) sum += header[index]
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  return header
}

function walk(sourceRoot, rel = '', out = []) {
  const dir = path.join(sourceRoot, rel)
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name
    if (entry.isDirectory()) {
      out.push({ name: childRel, type: 'dir' })
      walk(sourceRoot, childRel, out)
    } else if (entry.isFile()) {
      out.push({ name: childRel, type: 'file' })
    }
  }
  return out
}

/**
 * 把目录打成 npm 风格的 tar.gz（条目前缀 `package/`）。
 * @param {{sourceRoot: string, outFile: string, entries?: string[]}} input entries 传顶层文件/目录名，省略则全量
 */
export function writeTarGz({ sourceRoot, outFile, entries = null }) {
  const root = path.resolve(sourceRoot)
  const list = []
  const tops = entries ?? fs.readdirSync(root)
  for (const top of tops) {
    const full = path.join(root, top)
    if (!fs.existsSync(full)) continue
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      list.push({ name: top, type: 'dir' })
      walk(root, top, list)
    } else if (stat.isFile()) {
      list.push({ name: top, type: 'file' })
    }
  }

  const chunks = []
  for (const item of list) {
    const full = path.join(root, item.name)
    if (item.type === 'dir') {
      chunks.push(writeHeader({ name: `package/${item.name.replace(/\\/g, '/')}/`, size: 0, type: '5' }))
      continue
    }
    const data = fs.readFileSync(full)
    chunks.push(
      writeHeader({ name: `package/${item.name.replace(/\\/g, '/')}`, size: data.length }),
      data,
      Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0),
    )
  }
  // 结尾两个全零块
  chunks.push(Buffer.alloc(BLOCK * 2, 0))
  const gz = zlib.gzipSync(Buffer.concat(chunks), { level: 9 })
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, gz)
  return { bytes: gz.length, files: list.filter((item) => item.type === 'file').length }
}

function parseEntries(buffer) {
  const entries = []
  let offset = 0
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8) || 0
    const flag = header.subarray(156, 157).toString('utf8') || '0'
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix ? `${prefix}/${name}` : name
    offset += BLOCK
    const data = buffer.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK
    entries.push({ name: fullName, size, type: flag === '5' ? 'dir' : flag === '0' || flag === '\0' ? 'file' : 'other', data })
  }
  return entries
}

/** 安全解包：拒绝绝对路径与 `..`（防 tar-slip）。 */
export function extractTarGz(gzBuffer, destDir) {
  const buffer = zlib.gunzipSync(gzBuffer)
  const entries = parseEntries(buffer)
  const root = path.resolve(destDir)
  fs.mkdirSync(root, { recursive: true })
  let files = 0
  for (const entry of entries) {
    const safeName = String(entry.name).replace(/\\/g, '/')
    if (safeName.startsWith('/') || safeName.split('/').includes('..')) {
      throw new Error(`拒绝不安全路径：${entry.name}`)
    }
    const target = path.join(root, safeName)
    if (!target.startsWith(root)) throw new Error(`拒绝越界路径：${entry.name}`)
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    if (entry.type !== 'file') continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
    files += 1
  }
  return { files, entries: entries.length }
}

/**
 * 在解包目录里找插件包根（package.json 的 name 为 mirror-dsh-adapter）。
 * 找不到就返回 null。
 */
export function findPackageDir(root, packageName = 'mirror-dsh-adapter') {
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    if (depth > 5) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    // 直接命中：包根
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const json = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        if (json.name === packageName) return dir
      } catch {
        /* 忽略坏 manifest */
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
    }
  }
  return null
}
