/**
 * core/backup.js —— 本地备份与恢复（数据安全的地基）
 *
 * 设计取舍：
 *   - 不做 zip/压缩依赖：一次备份 = `<dataDir>/backups/mirror-<ts>/` 目录，里面放
 *     `mirror.db` + `manifest.json` + 可选的 `auto-distill.json` / `capture.json`。
 *     目录形式可直接看、可直接拷走，也不需要第三方库。
 *   - DB 用 SQLite 的 `VACUUM INTO` 生成一致快照（WAL 下也安全），不是粗暴复制文件。
 *   - 恢复前**先把当前库另存**为 `mirror.db.before-restore-<ts>`，误操作可回溯。
 */

import fs from 'node:fs'
import path from 'node:path'

const KEEP_BACKUPS = 20

export function backupsRoot(dataDir) {
  return path.join(String(dataDir ?? ''), 'backups')
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function quoteSqlPath(filePath) {
  // VACUUM INTO 需要单引号字符串字面量；路径里的单引号要转义
  return `'${String(filePath).replace(/'/g, "''")}'`
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function copyIfExists(from, to) {
  try {
    if (!fs.existsSync(from)) return false
    fs.copyFileSync(from, to)
    return true
  } catch {
    return false
  }
}

/**
 * 创建一份备份。
 * @param {{dataDir: string, db: object, note?: string, counts?: object, now?: number}} input
 * @returns {{name: string, path: string, createdAt: number, counts: object, bytes: number}}
 */
export function createBackup({ dataDir, db, note = '', counts = {}, now = Date.now() } = {}) {
  if (!dataDir) throw new Error('缺少 dataDir')
  if (!db) throw new Error('缺少数据库连接')
  const root = backupsRoot(dataDir)
  fs.mkdirSync(root, { recursive: true })
  const name = `mirror-${stamp(new Date(now))}`
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const dbTarget = path.join(dir, 'mirror.db')

  // 一致快照：SQLite 自己保证一致性（WAL 下也安全）
  db.exec(`VACUUM INTO ${quoteSqlPath(dbTarget)}`)

  const extras = []
  for (const file of ['auto-distill.json', 'capture.json']) {
    if (copyIfExists(path.join(dataDir, file), path.join(dir, file))) extras.push(file)
  }

  const manifest = {
    format: 'mirror-backup/1',
    createdAt: now,
    note: String(note ?? ''),
    counts,
    extras,
    dbBytes: fs.statSync(dbTarget).size,
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 只保留最近 KEEP_BACKUPS 份，避免磁盘无限增长
  try {
    const all = listBackups({ dataDir }).map((item) => item.path)
    for (const stale of all.slice(KEEP_BACKUPS)) fs.rmSync(stale, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响备份本身 */
  }

  return { name, path: dir, createdAt: now, counts, bytes: manifest.dbBytes }
}

/** 列出备份（新的在前）。 */
export function listBackups({ dataDir } = {}) {
  const root = backupsRoot(dataDir)
  let names = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  return names
    .map((name) => {
      const dir = path.join(root, name)
      const manifest = readJsonSafe(path.join(dir, 'manifest.json')) ?? {}
      let bytes = 0
      try {
        bytes = fs.statSync(path.join(dir, 'mirror.db')).size
      } catch {
        bytes = -1
      }
      return {
        name,
        path: dir,
        createdAt: Number(manifest.createdAt ?? 0),
        note: String(manifest.note ?? ''),
        counts: manifest.counts ?? null,
        bytes,
        valid: bytes > 0,
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name))
}

/**
 * 恢复备份。调用方必须**先关闭数据库连接**，恢复后再重新打开。
 * @param {{dataDir: string, backup?: string, backupPath?: string}} input backup 传名字，backupPath 传绝对路径
 * @returns {{restored: string, safetyCopy: string, restoredAt: number}}
 */
export function restoreBackup({ dataDir, backup = '', backupPath = '' } = {}) {
  if (!dataDir) throw new Error('缺少 dataDir')
  const dir = backupPath ? path.resolve(backupPath) : path.join(backupsRoot(dataDir), String(backup))
  const sourceDb = path.join(dir, 'mirror.db')
  if (!fs.existsSync(sourceDb)) throw new Error(`备份无效（缺少 mirror.db）：${dir}`)
  const manifest = readJsonSafe(path.join(dir, 'manifest.json'))
  if (!manifest || manifest.format !== 'mirror-backup/1') {
    throw new Error(`备份清单缺失或格式不支持：${dir}`)
  }

  const liveDb = path.join(dataDir, 'mirror.db')
  const safetyCopy = path.join(dataDir, `mirror.db.before-restore-${stamp()}`)
  if (fs.existsSync(liveDb)) {
    fs.copyFileSync(liveDb, safetyCopy)
    // 清掉 WAL/SHM，避免旧日志覆盖恢复后的库
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(`${liveDb}${suffix}`, { force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
  fs.copyFileSync(sourceDb, liveDb)
  for (const file of ['auto-distill.json', 'capture.json']) {
    copyIfExists(path.join(dir, file), path.join(dataDir, file))
  }
  return { restored: dir, safetyCopy, restoredAt: Date.now() }
}
