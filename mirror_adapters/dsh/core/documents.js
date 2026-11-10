/**
 * core/documents.js —— 文档库层（客观事实）
 *
 * 对应《Mirror 开发文档 v2.0》§5.1（监听/排除）、§5.2（索引器）、
 * §5.3（检索器）、§5.4（文档驱动的主动更新）。
 *
 * 关键设计决策：
 *   - 「文件是真源」：documents 表只是索引缓存，chunks 可随时重建。
 *     文件消失只把 documents.status 置 deleted，不删行（保留审计）。
 *   - 增量判定 = checksum（sha256: 前 1MB + size）+ mtimeMs。二者都没变才 skipped；
 *     只比 mtime 会在 git checkout 之类的场景误判。
 *   - 所有单文件错误都被吞成 {path, message} 放进 scan().errors，
 *     一个坏文件不能让它之后的文件不被索引。
 *   - 切片上限 1600 字符（文档 §5.2），超长按行二次切分。
 *   - 不带任何异步/监听器：scan() 由宿主按需调用（面板「重新索引」/ 定时任务），
 *     内核保持纯同步，避免后台线程与 SQLite 锁竞争。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { newId, jsonOrNull, parseJson, tx, likeEscape } from './storage.js'
import { bigramContainment, bigramJaccard, isOpposite, normalizeText, sharedTopicWords } from './arbiter.js'
import { rrfFuse, vectorSearch } from './vector.js'

/** 索引忽略的目录名（文档 §5.2） */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'vendor',
  'coverage',
  '.cache',
  '.turbo',
  '.idea',
  '.vscode',
])

const MD_EXTS = new Set(['md', 'mdx', 'markdown'])
const TEXT_EXTS = new Set(['txt', 'text', 'log', 'rst'])
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'cs', 'json',
  'yaml', 'yml', 'toml', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'css', 'scss', 'less',
  'html', 'htm', 'vue', 'svelte', 'c', 'h', 'cc', 'cpp', 'hpp', 'rb', 'php', 'kt',
  'swift', 'lua', 'ini', 'conf', 'dockerfile', 'gradle', 'proto',
])

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 单文件 2MB 上限（文档 §5.2）
const MAX_FILES = 5000 // 单次扫描文件数上限
const MAX_CHUNK_CHARS = 1600 // 单切片字符上限
const REVIEW_LIMIT = 500 // 文档复核时参与比对的记忆条数上限

const MIME_BY_EXT = {
  md: 'text/markdown',
  mdx: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  css: 'text/css',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  go: 'text/x-go',
  rs: 'text/x-rust',
  sql: 'application/sql',
}

/** 代码切块起始行模式（启发式，文档 §5.2 允许） */
const CODE_START_PATTERNS = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/, type: 'function' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/, type: 'class' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, type: 'function' },
  { re: /^\s*(?:export\s+)?(?:async\s+)?def\s+\w+\s*\(/, type: 'function' },
  { re: /^\s*class\s+\w+/, type: 'class' },
  { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+\w+/, type: 'class' },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?\w+\s*\(/, type: 'function' },
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/, type: 'function' },
  { re: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],\s]+\s+\w+\s*\([^;]*\)\s*\{?\s*$/, type: 'function' },
  { re: /^\s*(?:export\s+)?(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*\{\s*$/, type: 'class' },
]

/** 判断文件类型（返回 null = 不支持，不索引） */
export function detectFileType(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase().slice(1)
  const base = path.basename(String(filePath)).toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (base.startsWith('readme')) return 'readme'
  if (MD_EXTS.has(ext)) return 'md'
  if (TEXT_EXTS.has(ext)) return 'text'
  if (CODE_EXTS.has(ext)) return 'code'
  if (base === 'dockerfile' || base === 'makefile') return 'code'
  return null
}

/** DB 行 → 对外 Document */
export function rowToDocument(row) {
  if (!row) return null
  return {
    id: String(row.id),
    filePath: row.file_path,
    relativePath: row.relative_path || row.file_path,
    rootPath: row.root_path || null,
    project: row.project || null,
    fileType: row.file_type,
    mimeType: row.mime_type || null,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    lastModified: Number(row.last_modified ?? 0),
    lastIndexed: Number(row.last_indexed ?? 0),
    checksum: row.checksum || null,
    chunkCount: Number(row.chunk_count ?? 0),
    status: row.status || 'active',
    errorMessage: row.error_message || null,
    createdAt: Number(row.created_at ?? 0),
  }
}

/** DB 行 → 对外 chunk */
export function rowToChunk(row) {
  if (!row) return null
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    chunkIndex: Number(row.chunk_index ?? 0),
    content: row.content,
    chunkType: row.chunk_type || 'paragraph',
    headingPath: row.heading_path || null,
    startLine: row.start_line === null || row.start_line === undefined ? null : Number(row.start_line),
    endLine: row.end_line === null || row.end_line === undefined ? null : Number(row.end_line),
    metadata: parseJson(row.metadata_json, null),
    createdAt: Number(row.created_at ?? 0),
  }
}

export class DocumentService {
  constructor({ store }) {
    if (!store || !store.db) throw new Error('DocumentService 需要一个有效的 store')
    this.store = store
    this.db = store.db
  }

  // ------------------------------------------------------------------ 根目录

  listRoots() {
    let rows = []
    try {
      rows = this.db.prepare('SELECT * FROM doc_roots ORDER BY path').all()
    } catch {
      rows = []
    }
    return rows.map((row) => ({
      path: row.path,
      addedAt: Number(row.added_at ?? 0),
      lastScanAt: row.last_scan_at === null || row.last_scan_at === undefined ? null : Number(row.last_scan_at),
      fileCount: this._count(
        `SELECT count(*) AS c FROM documents WHERE root_path = ? AND status <> 'deleted'`,
        row.path,
      ),
    }))
  }

  /** 添加索引目录；目录不存在/不是目录 → 抛中文错误（契约 §3） */
  addRoot(dir) {
    const raw = typeof dir === 'string' ? dir.trim() : ''
    if (!raw) throw new Error('索引目录不能为空')
    const abs = path.resolve(raw)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new Error(`目录不存在：${abs}`)
    }
    if (!stat.isDirectory()) throw new Error(`不是目录：${abs}`)
    const now = this.store.now()
    try {
      this.db
        .prepare('INSERT INTO doc_roots (path, added_at, last_scan_at) VALUES (?, ?, NULL) ON CONFLICT(path) DO NOTHING')
        .run(abs, now)
    } catch (err) {
      throw new Error(`添加索引目录失败：${err.message}`)
    }
    return this.listRoots()
  }

  /** 移除索引目录：只解除监听，documents 记录保留（契约 §3） */
  removeRoot(dir) {
    const raw = typeof dir === 'string' ? dir.trim() : ''
    if (!raw) throw new Error('索引目录不能为空')
    const abs = path.resolve(raw)
    try {
      this.db.prepare('DELETE FROM doc_roots WHERE path = ?').run(abs)
    } catch {
      // 幂等：没这个 root 也不报错
    }
    return this.listRoots()
  }

  // ------------------------------------------------------------------ 扫描

  /**
   * 全量增量扫描。
   * @param {{force?: boolean}} opts force=true 时忽略 checksum/mtime，全部重索引
   */
  scan({ force = false } = {}) {
    const roots = this._rootRows()
    const errors = []
    const warnings = []
    const result = { added: 0, updated: 0, removed: 0, skipped: 0, errors, warnings, files: 0, truncated: false }
    if (roots.length === 0) {
      warnings.push('尚未添加任何索引目录')
      return result
    }

    const collected = []
    let truncated = false
    for (const root of roots) {
      const ignore = this._loadIgnore(root.path)
      const stack = [root.path]
      while (stack.length > 0) {
        if (collected.length >= MAX_FILES) {
          truncated = true
          break
        }
        const dir = stack.pop()
        let entries = []
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch (err) {
          errors.push({ path: dir, message: `目录无法读取：${err.message}` })
          continue
        }
        for (const entry of entries) {
          const abs = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
            if (ignore(abs, entry.name)) continue
            stack.push(abs)
            continue
          }
          if (!entry.isFile()) continue
          if (entry.name.startsWith('.')) continue
          if (!detectFileType(entry.name)) continue
          if (ignore(abs, entry.name)) continue
          if (collected.length >= MAX_FILES) {
            truncated = true
            break
          }
          collected.push({ abs, rootPath: root.path })
        }
        if (truncated) break
      }
      if (truncated) break
    }
    if (truncated) warnings.push(`本次扫描达到 ${MAX_FILES} 个文件上限，已停止（剩余文件下次扫描处理）`)
    result.truncated = truncated
    result.files = collected.length

    const now = this.store.now()
    const seen = new Set()
    const queue = [] // 变更队列（create / modify / delete）

    for (const item of collected) {
      seen.add(item.abs)
      let stat
      try {
        stat = fs.statSync(item.abs)
      } catch (err) {
        errors.push({ path: item.abs, message: `无法读取文件信息：${err.message}` })
        continue
      }
      const fileType = detectFileType(item.abs)
      const known = this._docByPath(item.abs)

      // PDF 与超大文件：标记 error 但不抛（文档 §5.2 / 契约 §3）
      if (fileType === 'pdf' || stat.size > MAX_FILE_BYTES) {
        const message = fileType === 'pdf' ? 'pdf unsupported in v1' : '文件超过 2MB 上限，已跳过'
        try {
          this._markError(item.abs, item.rootPath, stat, message, fileType)
        } catch (err) {
          errors.push({ path: item.abs, message: err.message })
        }
        result.skipped += 1
        continue
      }

      if (!force && known && known.status === 'active' && known.checksum) {
        let checksum = null
        try {
          checksum = this._checksum(item.abs, stat.size)
        } catch {
          checksum = null
        }
        const mtimeSame = Math.abs(Number(known.last_modified ?? 0) - stat.mtimeMs) < 2
        if (checksum && known.checksum === checksum && mtimeSame) {
          result.skipped += 1
          continue
        }
      }

      try {
        this.reindexFile(item.abs, { rootPath: item.rootPath })
        if (known && known.status !== 'deleted') result.updated += 1
        else result.added += 1
        queue.push({
          path: item.abs,
          type: !known || known.status === 'deleted' ? 'create' : 'modify',
          at: now,
        })
      } catch (err) {
        errors.push({ path: item.abs, message: err.message || String(err) })
        try {
          this._markError(item.abs, item.rootPath, stat, err.message || String(err), fileType)
        } catch {
          // 连 error 都写不进去时只保留 errors 数组里的记录
        }
      }
    }

    // 文件消失 → status='deleted'，chunks 一并清理（文档 §5.2）
    let docsUnderRoots = []
    try {
      docsUnderRoots = this.db.prepare(`SELECT * FROM documents WHERE status IN ('active', 'error')`).all()
    } catch {
      docsUnderRoots = []
    }
    for (const doc of docsUnderRoots) {
      if (seen.has(doc.file_path)) continue
      if (!this._underAnyRoot(doc.file_path, roots.map((r) => r.path))) continue
      // 文件其实还在（可能被 .mirrorignore 排除或超出上限）→ 不判为删除
      if (fs.existsSync(doc.file_path)) continue
      try {
        tx(this.store, () => {
          this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(doc.id)
          this.db
            .prepare(
              `UPDATE documents SET status = 'deleted', chunk_count = 0, last_indexed = ? WHERE id = ?`,
            )
            .run(now, doc.id)
        })
        result.removed += 1
        queue.push({ path: doc.file_path, type: 'delete', at: now })
      } catch (err) {
        errors.push({ path: doc.file_path, message: `标记删除失败：${err.message}` })
      }
    }

    // 变更队列：先写 pending，再统一标 done（文档 §3.9 / 契约 §3）
    try {
      tx(this.store, () => {
        for (const event of queue) {
          const id = newId('chg')
          this.db
            .prepare(
              `INSERT INTO doc_change_queue (id, file_path, event_type, detected_at, processed_at, status)
               VALUES (?, ?, ?, ?, ?, 'done')`,
            )
            .run(id, event.path, event.type, event.at, now)
        }
        for (const root of roots) {
          this.db.prepare('UPDATE doc_roots SET last_scan_at = ? WHERE path = ?').run(now, root.path)
        }
      })
    } catch (err) {
      warnings.push(`变更队列写入失败：${err.message}`)
    }

    return result
  }

  // ------------------------------------------------------------------ 单文件索引

  /**
   * 重新索引单个文件（面板「重新索引」/ scan 内部使用）。
   * @returns {{document: object, chunks: object[]}}
   */
  reindexFile(absPath, opts = {}) {
    const abs = path.resolve(String(absPath || ''))
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new Error(`文件不存在或无法访问：${abs}`)
    }
    if (!stat.isFile()) throw new Error(`不是文件：${abs}`)
    const fileType = detectFileType(abs)
    if (!fileType) throw new Error(`暂不支持的文件类型：${abs}`)
    if (fileType === 'pdf') {
      const doc = this._markError(abs, opts.rootPath, stat, 'pdf unsupported in v1', 'pdf')
      return { document: doc, chunks: [] }
    }
    if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过 2MB 上限：${abs}`)

    let text = ''
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      throw new Error(`读取文件失败：${err.message}`)
    }

    const rootPath = opts.rootPath || this._rootFor(abs)
    const relativePath = rootPath ? path.relative(rootPath, abs).split(path.sep).join('/') : abs
    const project = rootPath ? path.basename(rootPath) : null
    const chunks = chunkText(text, fileType)
    let checksum = null
    try {
      checksum = this._checksum(abs, stat.size)
    } catch {
      checksum = null
    }

    const now = this.store.now()
    const existing = this._docByPath(abs)
    const docId = existing ? String(existing.id) : newId('doc')

    // 变更前的内容指纹：用来判断是否需要跑「文档驱动复核」（文档 §5.4）
    let beforeSignature = ''
    if (existing) {
      try {
        const oldChunks = this.db
          .prepare('SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index')
          .all(docId)
        beforeSignature = oldChunks.map((c) => c.content).join('\u0000')
      } catch {
        beforeSignature = ''
      }
    }
    const afterSignature = chunks.map((c) => c.content).join('\u0000')

    const mimeType = MIME_BY_EXT[path.extname(abs).toLowerCase().slice(1)] || (fileType === 'md' ? 'text/markdown' : 'text/plain')

    tx(this.store, () => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE documents
                SET relative_path = ?, root_path = ?, project = ?, file_type = ?, mime_type = ?,
                    size_bytes = ?, last_modified = ?, last_indexed = ?, checksum = ?,
                    chunk_count = ?, status = 'active', error_message = NULL
              WHERE id = ?`,
          )
          .run(
            relativePath,
            rootPath || null,
            project,
            fileType,
            mimeType,
            stat.size,
            stat.mtimeMs,
            now,
            checksum,
            chunks.length,
            docId,
          )
        this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(docId)
      } else {
        this.db
          .prepare(
            `INSERT INTO documents
              (id, file_path, relative_path, root_path, project, file_type, mime_type, size_bytes,
               last_modified, last_indexed, checksum, chunk_count, status, error_message, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
          )
          .run(
            docId,
            abs,
            relativePath,
            rootPath || null,
            project,
            fileType,
            mimeType,
            stat.size,
            stat.mtimeMs,
            now,
            checksum,
            chunks.length,
            now,
          )
      }

      const insertChunk = this.db.prepare(
        `INSERT INTO document_chunks
          (id, document_id, chunk_index, content, chunk_type, heading_path, start_line, end_line, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      chunks.forEach((chunk, index) => {
        const chunkId = newId('chk')
        chunk.id = chunkId
        chunk.documentId = docId
        chunk.chunkIndex = index
        chunk.createdAt = now
        insertChunk.run(
          chunkId,
          docId,
          index,
          chunk.content,
          chunk.chunkType || 'paragraph',
          chunk.headingPath || null,
          chunk.startLine ?? null,
          chunk.endLine ?? null,
          jsonOrNull(chunk.metadata),
          now,
        )
      })
    })

    const document = rowToDocument(this._docById(docId))

    // 文档驱动复核：内容真的变了才比对记忆，避免每次 force 索引都刷冲突
    if (existing && beforeSignature && beforeSignature !== afterSignature) {
      try {
        this._reviewDocAgainstMemories(docId, chunks, now)
      } catch {
        // 复核失败不影响索引本身
      }
    }

    return { document, chunks }
  }

  // ------------------------------------------------------------------ 查询

  /** 文档列表（不含已删除的）；q 可选，按文件路径模糊匹配 */
  list({ q, limit } = {}) {
    const where = [`status <> 'deleted'`]
    const params = []
    if (q && String(q).trim()) {
      where.push(`(file_path LIKE ? ESCAPE '\\' OR relative_path LIKE ? ESCAPE '\\')`)
      const like = `%${likeEscape(String(q).trim())}%`
      params.push(like, like)
    }
    const capped = clampLimit(limit, 200, 2000)
    params.push(capped)
    try {
      return this.db
        .prepare(
          `SELECT * FROM documents WHERE ${where.join(' AND ')}
            ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, file_path LIMIT ?`,
        )
        .all(...params)
        .map(rowToDocument)
    } catch {
      return []
    }
  }

  get(id) {
    if (!id) return null
    const row = this._docById(String(id))
    if (!row) return null
    let chunks = []
    try {
      chunks = this.db
        .prepare('SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index')
        .all(String(id))
        .map(rowToChunk)
    } catch {
      chunks = []
    }
    return { document: rowToDocument(row), chunks }
  }

  /**
   * 额外方法：硬删单个文档索引（宿主 `doc.delete` 动作使用，契约 §3 未列出但有用）。
   * **只删索引，不动磁盘文件**；chunks / FTS（触发器）/ doc_memory_links / 该文档的 doc_updated 冲突一并清理。
   */
  remove(id) {
    const key = String(id ?? '').trim()
    if (!key) throw new Error('缺少文档 id')
    const row = this._docById(key)
    if (!row) throw new Error(`文档不存在：${key}`)
    return tx(this.store, () => {
      const chunks = this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(key)
      const links = this.db.prepare('DELETE FROM doc_memory_links WHERE doc_id = ?').run(key)
      const conflicts = this.db.prepare('DELETE FROM conflicts WHERE memory_b = ?').run(`doc:${key}`)
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(key)
      return {
        deleted: true,
        id: key,
        path: row.file_path,
        chunks: Number(chunks.changes || 0),
        links: Number(links.changes || 0),
        conflicts: Number(conflicts.changes || 0),
      }
    })
  }

  /**
   * 文档检索（契约 §10.2）：先切词，再 FTS(OR) + 短词 LIKE 兜底，
   * 最后按「命中词项数 → bm25/位置 → 路径命中」排序。
   *
   * 之前整句当 FTS 短语 + LIKE 整串匹配，导致「安装依赖怎么跑」0 命中；
   * 现在逐轮注入用用户原话也能召回「📚 相关文档」层。
   *
   * @returns {{chunk: object, document: object, score: number}[]}
   */
  search({ q, scope, limit = 20, useVector = true } = {}) {
    const query = String(q ?? '').trim()
    if (!query) return []
    const capped = clampLimit(limit, 20, 200)
    const terms = splitQueryTerms(query)
    if (terms.length === 0) return []

    const scopeFilter = scopeToProjectFilter(scope)
    /** chunkId -> { row, ftsRank: number|null }（Map 天然去重，FTS 命中优先） */
    const candidates = new Map()
    const fetchLimit = Math.min(500, capped * 8)

    const ftsTerms = terms.filter((term) => normalizeText(term).length >= 3)
    const shortTerms = terms.filter((term) => normalizeText(term).length < 3)

    // 1) FTS 候选：每个 >=3 字的词项取短语，OR 连接
    if (ftsTerms.length > 0 && this.store.fts.chunks) {
      const match = ftsTerms.map((term) => `"${normalizeText(term).replace(/"/g, '""')}"`).join(' OR ')
      try {
        const rows = this.db
          .prepare(
            `SELECT c.* FROM chunks_fts f
               JOIN document_chunks c ON c.id = f.chunk_id
               JOIN documents d ON d.id = c.document_id
              WHERE chunks_fts MATCH ? AND d.status = 'active' ${scopeFilter.sql}
              ORDER BY bm25(chunks_fts) LIMIT ?`,
          )
          .all(match, ...scopeFilter.params, fetchLimit)
        rows.forEach((row, index) => candidates.set(String(row.id), { row, ftsRank: index }))
      } catch {
        // FTS 语法异常 / 索引不可用时退回 LIKE
      }
    }

    // 2) LIKE 兜底：<3 字的词项（trigram 无索引）始终走这里；
    //    若 FTS 一个候选都没有，则所有词项都走 LIKE（保证自然语言能召回）
    const likeTargets = candidates.size === 0 ? terms : shortTerms
    if (likeTargets.length > 0) {
      const clauses = []
      const params = []
      for (const term of likeTargets) {
        const like = `%${likeEscape(term)}%`
        clauses.push(`(c.content LIKE ? ESCAPE '\\' OR ifnull(c.heading_path, '') LIKE ? ESCAPE '\\')`)
        params.push(like, like)
      }
      try {
        const rows = this.db
          .prepare(
            `SELECT c.* FROM document_chunks c
               JOIN documents d ON d.id = c.document_id
              WHERE d.status = 'active' AND (${clauses.join(' OR ')}) ${scopeFilter.sql}
              ORDER BY d.last_modified DESC, c.chunk_index LIMIT ?`,
          )
          .all(...params, ...scopeFilter.params, fetchLimit)
        for (const row of rows) {
          const key = String(row.id)
          if (!candidates.has(key)) candidates.set(key, { row, ftsRank: null })
        }
      } catch {
        // LIKE 失败时保留已有 FTS 候选
      }
    }

    if (candidates.size === 0) return []

    // 3) 打分排序：命中词项数 desc → bm25/位置 → 路径命中
    const docCache = new Map()
    const scored = []
    for (const { row, ftsRank } of candidates.values()) {
      const documentId = String(row.document_id)
      if (!docCache.has(documentId)) docCache.set(documentId, this._docById(documentId))
      const document = docCache.get(documentId)
      if (!document) continue
      const haystack = `${row.content ?? ''} ${row.heading_path ?? ''}`
      let matched = 0
      for (const term of terms) {
        if (termMatches(haystack, term)) matched += 1
      }
      if (matched === 0) continue // FTS/LIKE 命中了，但词项对不上（短语切分差异）→ 丢弃
      const pathText = `${document.relative_path || ''} ${document.file_path || ''}`
      const pathHit = terms.some((term) => termMatches(pathText, term)) ? 1 : 0
      scored.push({ row, document, matched, ftsRank, pathHit })
    }
    if (scored.length === 0) return []

    scored.sort((a, b) => {
      if (b.matched !== a.matched) return b.matched - a.matched
      const rankA = a.ftsRank === null ? Number.MAX_SAFE_INTEGER : a.ftsRank
      const rankB = b.ftsRank === null ? Number.MAX_SAFE_INTEGER : b.ftsRank
      if (rankA !== rankB) return rankA - rankB
      return b.pathHit - a.pathHit
    })

    const top = (() => {
      if (!useVector) return scored.slice(0, capped)
      // 向量召回 + RRF 融合：补短词（<3 字）与换词表述的召回
      try {
        const lexicalIds = scored.map((item) => String(item.row.id))
        const vectorHits = vectorSearch({
          items: scored,
          query,
          getText: (item) => `${item.row.heading_path ?? ''} ${item.row.content ?? ''}`,
          getId: (item) => item.row.id,
          getKey: (item) => `${item.row.id}:${item.row.checksum ?? item.row.created_at ?? 0}`,
          topK: 60,
        })
        const fused = rrfFuse([lexicalIds, vectorHits.map((hit) => hit.id)])
        const byId = new Map(scored.map((item) => [String(item.row.id), item]))
        const ordered = fused.map((entry) => byId.get(entry.id)).filter(Boolean)
        return ordered.length > 0 ? ordered.slice(0, capped) : scored.slice(0, capped)
      } catch {
        return scored.slice(0, capped)
      }
    })()
    const total = Math.max(1, top.length)
    return top.map((item, index) => ({
      chunk: rowToChunk(item.row),
      document: rowToDocument(item.document),
      // 0..1：70% 来自「命中词项覆盖率」，30% 来自排序位置
      score: round2(0.7 * (item.matched / terms.length) + 0.3 * (1 - index / total)),
    }))
  }

  /**
   * 文档-记忆关联列表（契约 §10.3，面板「关联视图」用）。
   * @param {{limit?: number, relation?: string}} query limit 上限 500；relation 可过滤
   */
  listLinks({ limit = 200, relation } = {}) {
    const capped = clampLimit(limit, 200, 500)
    const where = []
    const params = []
    if (relation) {
      where.push('l.relation = ?')
      params.push(String(relation))
    }
    params.push(capped)
    let rows = []
    try {
      rows = this.db
        .prepare(
          `SELECT l.id, l.doc_id, l.chunk_id, l.memory_id, l.relation, l.detected_by, l.detected_at, l.resolved,
                  d.file_path AS doc_file_path, d.relative_path AS doc_relative_path,
                  c.heading_path AS chunk_heading_path,
                  m.content AS memory_content, m.category AS memory_category, m.status AS memory_status
             FROM doc_memory_links l
             LEFT JOIN documents d ON d.id = l.doc_id
             LEFT JOIN document_chunks c ON c.id = l.chunk_id
             LEFT JOIN memories m ON m.id = l.memory_id
             ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY l.detected_at DESC, l.id DESC
             LIMIT ?`,
        )
        .all(...params)
    } catch {
      rows = []
    }
    return rows.map((row) => ({
      id: String(row.id),
      docId: row.doc_id,
      chunkId: row.chunk_id || null,
      memoryId: row.memory_id,
      relation: row.relation,
      detectedBy: row.detected_by || 'system',
      detectedAt: Number(row.detected_at ?? 0),
      resolved: Number(row.resolved ?? 0) === 1,
      filePath: row.doc_file_path || null,
      relativePath: row.doc_relative_path || row.doc_file_path || null,
      headingPath: row.chunk_heading_path || null,
      memoryContent: row.memory_content || null,
      memoryCategory: row.memory_category || null,
      memoryStatus: row.memory_status || null,
    }))
  }

  stats() {
    return {
      documents: this._count(`SELECT count(*) AS c FROM documents WHERE status = 'active'`),
      chunks: this._count(
        `SELECT count(*) AS c FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.status = 'active'`,
      ),
      pending: this._count(`SELECT count(*) AS c FROM doc_change_queue WHERE status = 'pending'`),
      roots: this._count(`SELECT count(*) AS c FROM doc_roots`),
      errors: this._count(`SELECT count(*) AS c FROM documents WHERE status = 'error'`),
      deleted: this._count(`SELECT count(*) AS c FROM documents WHERE status = 'deleted'`),
    }
  }

  // ------------------------------------------------------------------ 内部实现

  _rootRows() {
    try {
      return this.db.prepare('SELECT * FROM doc_roots ORDER BY path').all()
    } catch {
      return []
    }
  }

  _rootFor(abs) {
    const roots = this._rootRows()
    let best = null
    for (const root of roots) {
      if (isInside(abs, root.path) && (!best || root.path.length > best.length)) best = root.path
    }
    return best
  }

  _underAnyRoot(abs, roots) {
    return roots.some((root) => isInside(abs, root))
  }

  _docByPath(abs) {
    try {
      return this.db.prepare('SELECT * FROM documents WHERE file_path = ?').get(String(abs)) ?? null
    } catch {
      return null
    }
  }

  _docById(id) {
    try {
      return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(String(id)) ?? null
    } catch {
      return null
    }
  }

  /** 标记为 error（pdf / 超大 / 读取失败），保留行以便面板显示 */
  _markError(abs, rootPath, stat, message, forcedType) {
    const existing = this._docByPath(abs)
    const now = this.store.now()
    const resolvedRoot = rootPath || this._rootFor(abs)
    const relativePath = resolvedRoot ? path.relative(resolvedRoot, abs).split(path.sep).join('/') : abs
    const project = resolvedRoot ? path.basename(resolvedRoot) : null
    const fileType = forcedType || detectFileType(abs) || 'text'

    tx(this.store, () => {
      if (existing) {
        this.db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(existing.id)
        this.db
          .prepare(
            `UPDATE documents SET status = 'error', error_message = ?, size_bytes = ?, last_modified = ?,
                    last_indexed = ?, chunk_count = 0, root_path = ?, relative_path = ?, project = ?
              WHERE id = ?`,
          )
          .run(
            String(message),
            stat?.size ?? null,
            stat?.mtimeMs ?? now,
            now,
            resolvedRoot || null,
            relativePath,
            project,
            existing.id,
          )
      } else {
        this.db
          .prepare(
            `INSERT INTO documents
              (id, file_path, relative_path, root_path, project, file_type, mime_type, size_bytes,
               last_modified, last_indexed, checksum, chunk_count, status, error_message, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0, 'error', ?, ?)`,
          )
          .run(
            newId('doc'),
            abs,
            relativePath,
            resolvedRoot || null,
            project,
            fileType,
            stat?.size ?? null,
            stat?.mtimeMs ?? now,
            now,
            String(message),
            now,
          )
      }
    })
    return rowToDocument(this._docByPath(abs))
  }

  /** 内容指纹：sha256(前 1MB) + 文件大小；读失败退化为 stat 信息 */
  _checksum(abs, size) {
    try {
      const fd = fs.openSync(abs, 'r')
      try {
        const len = Math.min(1024 * 1024, Math.max(0, Number(size) || 0))
        const buffer = Buffer.alloc(len)
        const read = len > 0 ? fs.readSync(fd, buffer, 0, len, 0) : 0
        const hash = crypto.createHash('sha256')
        hash.update(buffer.subarray(0, read))
        hash.update(`:${size}`)
        return hash.digest('hex')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      try {
        const stat = fs.statSync(abs)
        return `stat:${stat.mtimeMs}:${stat.size}`
      } catch {
        return `stat:${size ?? 0}`
      }
    }
  }

  /** 读取 .mirrorignore（gitignore 风格简化实现，文档 §5.1） */
  _loadIgnore(rootPath) {
    const patterns = []
    try {
      const ignoreFile = path.join(rootPath, '.mirrorignore')
      if (fs.existsSync(ignoreFile)) {
        const stat = fs.statSync(ignoreFile)
        if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
          const text = fs.readFileSync(ignoreFile, 'utf8')
          for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim()
            if (!line || line.startsWith('#')) continue
            patterns.push(line)
          }
        }
      }
    } catch {
      // 读不到 ignore 就当没有，不阻断扫描
    }
    if (patterns.length === 0) return () => false
    return (abs, name) => {
      const rel = path.relative(rootPath, abs).split(path.sep).join('/')
      for (const pattern of patterns) {
        if (pattern.startsWith('!')) {
          if (matchIgnore(pattern.slice(1), rel, name)) return false
          continue
        }
        if (matchIgnore(pattern, rel, name)) return true
      }
      return false
    }
  }

  /**
   * 文档驱动复核（文档 §5.4）：新切片与记忆的 containment >= 0.7 时建链；
   * 语义相反 → relation=contradicts + 一条 doc_updated 冲突。
   * 每条切片最多关联 3 条记忆，单文件最多 20 条，避免一次索引写爆。
   */
  _reviewDocAgainstMemories(documentId, chunks, now) {
    let memoryRows = []
    try {
      memoryRows = this.db
        .prepare(`SELECT * FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT ${REVIEW_LIMIT}`)
        .all()
    } catch {
      return { links: 0, conflicts: 0 }
    }
    if (memoryRows.length === 0) return { links: 0, conflicts: 0 }

    let links = 0
    let conflicts = 0
    let total = 0
    const now2 = now || this.store.now()

    for (const chunk of chunks) {
      if (total >= 20) break
      const haystack = `${chunk.headingPath || ''} ${chunk.content || ''}`
      const scored = []
      for (const row of memoryRows) {
        const containment = bigramContainment(haystack, row.content)
        if (containment >= 0.7) scored.push({ row, containment })
      }
      scored.sort((a, b) => b.containment - a.containment)
      for (const { row } of scored.slice(0, 3)) {
        // R3b：contradicts 需要「语义相反 + 同一主张」双重证据，否则只记 supports
        const relation = reviewRelation(chunk.content, row.content)
        try {
          const existed = this.db
            .prepare('SELECT id FROM doc_memory_links WHERE doc_id = ? AND memory_id = ? AND relation = ?')
            .get(documentId, String(row.id), relation)
          if (existed) continue
          this.db
            .prepare(
              `INSERT INTO doc_memory_links (id, doc_id, chunk_id, memory_id, relation, detected_by, detected_at, resolved)
               VALUES (?, ?, ?, ?, ?, 'doc_updated', ?, 0)`,
            )
            .run(newId('lnk'), documentId, chunk.id || null, String(row.id), relation, now2)
          links += 1
        } catch {
          continue
        }
        if (relation === 'contradicts') {
          const ref = `doc:${documentId}`
          try {
            const existedConflict = this.db
              .prepare(
                `SELECT id FROM conflicts WHERE resolved = 0 AND conflict_type = 'doc_updated' AND memory_a = ? AND memory_b = ?`,
              )
              .get(String(row.id), ref)
            if (!existedConflict) {
              this.db
                .prepare(
                  `INSERT INTO conflicts (id, memory_a, memory_b, conflict_type, detected_at, detected_by, resolved, severity, reason)
                   VALUES (?, ?, ?, 'doc_updated', ?, 'doc_updated', 0, 'medium', ?)`,
                )
                .run(
                  newId('cfl'),
                  String(row.id),
                  ref,
                  now2,
                  '文档内容更新，相关记忆可能与新文档矛盾，请复核',
                )
              conflicts += 1
            }
          } catch {
            // 冲突写失败不影响建链
          }
        }
        total += 1
      }
    }
    return { links, conflicts }
  }

  _count(sql, ...params) {
    try {
      const row = this.db.prepare(sql).get(...params)
      return Number(row?.c) || 0
    } catch {
      return 0
    }
  }
}

// -------------------------------------------------------------------- 切片实现

/**
 * 按文件类型切片。
 * @returns {{content: string, chunkType: string, headingPath: string|null, startLine: number, endLine: number}[]}
 */
function stripFrontmatter(text) {
  return String(text ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

export function chunkText(text, fileType) {
  // 文档库里的 .md 可能带 YAML frontmatter（ingest / 手工存档），切片前剥掉，别让它进检索正文
  const source = stripFrontmatter(String(text ?? ''))
  if (!source.trim()) return []
  let raw = []
  if (fileType === 'md' || fileType === 'readme') raw = chunkMarkdown(source)
  else if (fileType === 'code') raw = chunkCode(source)
  else raw = chunkParagraph(source)
  if (raw.length === 0) raw = chunkParagraph(source)
  return raw.flatMap((chunk) => splitOversize(chunk))
}

/** Markdown：按 # 标题层级切块，heading_path 形如 "Guide > Install" */
export function chunkMarkdown(text) {
  const lines = String(text).split(/\r?\n/)
  const chunks = []
  const stack = []
  let buffer = []
  let bufferStart = 1

  const flush = () => {
    const content = buffer.join('\n').trim()
    if (content) {
      chunks.push({
        content,
        chunkType: 'heading',
        headingPath: stack.length > 0 ? stack.map((h) => h.title).join(' > ') : null,
        startLine: bufferStart,
        endLine: bufferStart + buffer.length - 1,
      })
    }
    buffer = []
  }

  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, title: heading[2].trim() })
      bufferStart = index + 1
      buffer.push(line) // 标题行也进块：检索命中标题时能带出上下文
      return
    }
    if (buffer.length === 0) bufferStart = index + 1
    buffer.push(line)
  })
  flush()
  return chunks
}

/** 代码：按 function / class 启发式切块，记录 startLine/endLine */
export function chunkCode(text) {
  const lines = String(text).split(/\r?\n/)
  const marks = []
  for (let i = 0; i < lines.length; i += 1) {
    for (const pattern of CODE_START_PATTERNS) {
      if (pattern.re.test(lines[i])) {
        marks.push({ index: i, type: pattern.type })
        break
      }
    }
  }
  if (marks.length === 0) return chunkParagraph(text)

  const chunks = []
  if (marks[0].index > 0) {
    const preamble = lines.slice(0, marks[0].index).join('\n').trim()
    if (preamble) {
      chunks.push({
        content: preamble,
        chunkType: 'paragraph',
        headingPath: null,
        startLine: 1,
        endLine: marks[0].index,
      })
    }
  }
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index
    const endLine = i + 1 < marks.length ? marks[i + 1].index - 1 : lines.length - 1
    const content = lines.slice(start, endLine + 1).join('\n').trim()
    if (!content) continue
    chunks.push({
      content,
      chunkType: marks[i].type,
      headingPath: null,
      startLine: start + 1,
      endLine: endLine + 1,
    })
  }
  return chunks
}

/** 其它类型：按空行段落切块 */
export function chunkParagraph(text) {
  const lines = String(text).split(/\r?\n/)
  const chunks = []
  let buffer = []
  let start = 1

  const flush = (endLine) => {
    const content = buffer.join('\n').trim()
    if (content) {
      chunks.push({ content, chunkType: 'paragraph', headingPath: null, startLine: start, endLine })
    }
    buffer = []
  }

  lines.forEach((line, index) => {
    if (buffer.length === 0) start = index + 1
    buffer.push(line)
    if (line.trim() === '') flush(index + 1)
  })
  flush(lines.length)
  return chunks
}

/** 超过 MAX_CHUNK_CHARS 的块按行二次切分；单行超长时硬切 */
export function splitOversize(chunk, max = MAX_CHUNK_CHARS) {
  if (!chunk || !chunk.content) return []
  if (chunk.content.length <= max) return [chunk]

  const lines = chunk.content.split(/\r?\n/)
  const out = []
  let buffer = []
  let startLine = chunk.startLine
  let cursor = chunk.startLine

  const push = (content, start, end) => {
    const trimmed = content.trim()
    if (trimmed) out.push({ ...chunk, content: trimmed, startLine: start, endLine: end })
  }

  for (const line of lines) {
    if (line.length > max) {
      if (buffer.length > 0) {
        push(buffer.join('\n'), startLine, cursor - 1)
        buffer = []
      }
      for (let offset = 0; offset < line.length; offset += max) {
        push(line.slice(offset, offset + max), cursor, cursor)
      }
      cursor += 1
      startLine = cursor
      continue
    }
    const candidate = buffer.length > 0 ? `${buffer.join('\n')}\n${line}` : line
    if (candidate.length > max && buffer.length > 0) {
      push(buffer.join('\n'), startLine, cursor - 1)
      buffer = [line]
      startLine = cursor
    } else {
      if (buffer.length === 0) startLine = cursor
      buffer.push(line)
    }
    cursor += 1
  }
  if (buffer.length > 0) push(buffer.join('\n'), startLine, cursor - 1)
  return out
}

const REVIEW_CONTRADICT_JACCARD = 0.45
const REVIEW_CONTRADICT_LONG_SHARED = 2

/**
 * 文档复核的关系判定（R3b）。
 *
 * 真实误判：文档里「必须重启 dsh web」与记忆里「禁止改副本」只因为 必须/禁止 配对词
 * 再加上主题词重叠就被判 `contradicts`，还写了一条 doc_updated 冲突 —— 实际二者都在说
 * 「改完要重启」。所以 `contradicts` 现在需要**双重证据**：
 *   1. `isOpposite(chunkText, memoryText) === true`；且
 *   2. 同一主张的证据：`bigramJaccard >= 0.45`，或共享主题词里至少 2 个长度 >= 3 的词。
 * 不满足 2 时返回 `supports`（仍然建 link、仍然算关联，只是不写冲突）。
 */
export function reviewRelation(chunkText, memoryText) {
  if (!isOpposite(chunkText, memoryText)) return 'supports'
  if (bigramJaccard(chunkText, memoryText) >= REVIEW_CONTRADICT_JACCARD) return 'contradicts'
  const longShared = new Set(
    sharedTopicWords(chunkText, memoryText).filter((word) => String(word).length >= 3),
  )
  return longShared.size >= REVIEW_CONTRADICT_LONG_SHARED ? 'contradicts' : 'supports'
}

/** FTS5 MATCH 查询串（token 归一化后必须 >=3 字符，否则返回 null 走 LIKE） */
export function buildMatchQuery(query) {
  const tokens = String(query ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return null
  const parts = []
  for (const token of tokens) {
    const phrase = normalizeText(token)
    if (phrase.length < 3) return null
    parts.push(`"${phrase.replace(/"/g, '""')}"`)
  }
  return parts.join(' AND ')
}

/**
 * 查询切词（契约 §10.2）。
 *   - 拉丁/数字/`_`/`-` 连续串按词切（小写化，长度 >= 2）；
 *   - 中文连续串：整串保留，并生成相邻 2-gram（「安装依赖」→ 安装/装依/依赖/安装依赖）；
 *   - 去重、保序、最多 12 个词项。
 * 单字中文（如「装」）只在没有其它词项时保留，避免高频单字把召回淹没。
 */
export function splitQueryTerms(query) {
  const text = String(query ?? '').trim()
  if (!text) return []
  const terms = []
  const seen = new Set()
  const push = (term) => {
    const value = String(term ?? '').trim()
    if (!value) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    terms.push(value)
  }

  const segments = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_.-]+/g) || []
  for (const segment of segments) {
    if (isCjkSegment(segment)) {
      const chars = Array.from(segment)
      if (chars.length >= 2) push(chars.join(''))
      for (let i = 0; i + 1 < chars.length; i += 1) push(`${chars[i]}${chars[i + 1]}`)
    } else {
      const word = segment.toLowerCase().replace(/^[._-]+|[._-]+$/g, '')
      if (word.length >= 2) push(word)
    }
  }

  if (terms.length === 0) {
    const single = Array.from(text).find((ch) => isCjkChar(ch))
    if (single) push(single)
  }
  return terms.slice(0, 12)
}

function isCjkChar(ch) {
  const code = ch.codePointAt(0) || 0
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

function isCjkSegment(segment) {
  return Array.from(segment).every((ch) => isCjkChar(ch))
}

const TERM_REGEX_CACHE = new Map()

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isAsciiTerm(term) {
  return /^[\x20-\x7e]+$/.test(String(term))
}

/** 拉丁词项按词边界匹配（npm 不命中 pnpm、http 不命中 https）；中文按归一化子串 */
function termMatches(haystack, term) {
  const text = String(haystack ?? '')
  const target = String(term ?? '')
  if (!text || !target) return false
  if (isAsciiTerm(target)) {
    let re = TERM_REGEX_CACHE.get(target)
    if (!re) {
      re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(target)}(?![A-Za-z0-9_])`, 'i')
      TERM_REGEX_CACHE.set(target, re)
    }
    return re.test(text)
  }
  return normalizeText(text).includes(normalizeText(target))
}

// -------------------------------------------------------------------- 小工具

function clampLimit(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** abs 是否在 dir 之内（大小写不敏感，Windows 友好） */
function isInside(abs, dir) {
  const a = path.resolve(abs).toLowerCase()
  const d = path.resolve(dir).toLowerCase()
  return a === d || a.startsWith(d.endsWith(path.sep) ? d : d + path.sep)
}

/** scope → documents.project 过滤条件 */
function scopeToProjectFilter(scope) {
  const value = String(scope ?? '').trim()
  if (!value || value === 'global' || value === 'all') return { sql: '', params: [] }
  if (value.startsWith('project:')) {
    return { sql: `AND (d.project = ? OR d.project IS NULL)`, params: [value.slice('project:'.length)] }
  }
  // role:/session: 等作用域对文档不适用，不加限制
  return { sql: '', params: [] }
}

/** .mirrorignore 单条模式匹配（支持 * / ? 与目录前缀） */
function matchIgnore(pattern, rel, name) {
  const cleaned = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim()
  if (!cleaned) return false
  const relLower = rel.toLowerCase()
  const nameLower = name.toLowerCase()
  const patternLower = cleaned.toLowerCase()

  if (patternLower.includes('*') || patternLower.includes('?')) {
    const regexSource = patternLower
      .split('')
      .map((ch) => {
        if (ch === '*') return '.*'
        if (ch === '?') return '.'
        return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      })
      .join('')
    let re
    try {
      re = new RegExp(`^${regexSource}$`)
    } catch {
      return false
    }
    return re.test(relLower) || re.test(nameLower) || relLower.split('/').some((segment) => re.test(segment))
  }

  if (patternLower.includes('/')) {
    return relLower === patternLower || relLower.startsWith(`${patternLower}/`)
  }
  return nameLower === patternLower || relLower.split('/').some((segment) => segment === patternLower)
}
