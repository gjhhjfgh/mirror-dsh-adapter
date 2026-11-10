/**
 * core/storage.js —— Mirror 内核存储层
 *
 * 职责：
 *   1. 打开/创建 <dataDir>/mirror.db（node:sqlite 同步 API）
 *   2. 建表 + 索引 + FTS5（trigram）全文索引，迁移幂等
 *   3. 提供跨模块使用的极小工具函数（id / json / 事务 / LIKE 转义）
 *
 * 设计决策（重要）：
 *   - 全部同步 API。内核被 HTTP 路由同步调用，异步只会增加复杂度。
 *   - 没有顶层副作用：只有调用 openStore() 才会触碰磁盘。
 *   - FTS5 用「独立表 + 触发器」而不是 external content：触发器把
 *     memories / document_chunks 的增删改同步过去，语义最简单。
 *     若某个环境建 FTS 失败（例如 sqlite 没编 FTS5），捕获后置
 *     store.fts.* = false，检索层退回 LIKE，不影响内核启动。
 *   - 迁移用 PRAGMA user_version 记录版本，DDL 全部 IF NOT EXISTS，
 *     同一 dataDir 重复打开不报错、不丢数据。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'

/** 当前 schema 版本（未来加列时 +1，并在 migrate 里补一段 if (version < n)） */
export const SCHEMA_VERSION = 1

/** 数据目录默认位置（测试时必须覆盖，严禁污染真实 ~/.mirror） */
export function defaultDataDir() {
  return path.join(os.homedir(), '.mirror')
}

/**
 * 建表语句（顺序有依赖：memories 必须先于引用它的表）。
 * 字段严格按《Mirror 开发文档 v2.0》§3.1–§3.10，snake_case；
 * 额外列见各处注释（契约允许「再多加实现需要的列」）。
 */
const SCHEMA_STATEMENTS = [
  // ---------- §3.1 记忆主表 ----------
  `CREATE TABLE IF NOT EXISTS memories (
    id               TEXT PRIMARY KEY,
    category         TEXT NOT NULL,                     -- iron_rule / preference / decision / pitfall / fuzzy
    layer            TEXT NOT NULL DEFAULT 'strategy',  -- fragment / strategy / fact
    content          TEXT NOT NULL,
    structured       TEXT,                              -- JSON
    confidence       REAL DEFAULT 0.5,
    authority        TEXT DEFAULT 'inferred',           -- user_explicit / user_confirmed / inferred / imported
    source_type      TEXT,
    source_ref       TEXT,
    created_at       INTEGER NOT NULL,
    last_verified_at INTEGER,
    last_accessed_at INTEGER,
    access_count     INTEGER DEFAULT 0,
    valid_from       INTEGER,
    valid_to         INTEGER,
    expires_at       INTEGER,
    frozen           INTEGER DEFAULT 0,
    causal_parent    TEXT,
    causal_children  TEXT,                              -- JSON 数组
    status           TEXT DEFAULT 'active',
    superseded_by    TEXT,
    scope            TEXT DEFAULT 'global',
    tags             TEXT,                              -- JSON 数组
    pack_id          TEXT,
    pack_version     TEXT,
    source_doc       TEXT,
    doc_conflict     TEXT,
    invalid_reason   TEXT,                              -- 额外列：invalidate 的中文原因（审计可读）
    user_modified    INTEGER DEFAULT 0,                 -- 额外列：1=被用户改过（记忆包卸载时保留）
    FOREIGN KEY (causal_parent) REFERENCES memories(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_category ON memories(category)`,
  `CREATE INDEX IF NOT EXISTS idx_status ON memories(status)`,
  `CREATE INDEX IF NOT EXISTS idx_scope ON memories(scope)`,
  `CREATE INDEX IF NOT EXISTS idx_valid ON memories(valid_from, valid_to)`,
  `CREATE INDEX IF NOT EXISTS idx_pack ON memories(pack_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_created ON memories(created_at)`,

  // ---------- §3.2 冲突记录表 ----------
  // 注意：这里**故意不加外键**。契约 §3 要求文档冲突用 memory_b='doc:<documentId>'、
  // 记忆包冲突用 'pack:<packId>'，这些不是 memories.id，加了 FK 会直接写不进去。
  // 记忆被硬删时由 MemoryService.remove() 显式清理冲突行，等价于级联。
  `CREATE TABLE IF NOT EXISTS conflicts (
    id                TEXT PRIMARY KEY,
    memory_a          TEXT NOT NULL,
    memory_b          TEXT NOT NULL,
    conflict_type     TEXT NOT NULL,   -- contradiction / scope_overlap / temporal_mismatch / doc_updated / pack_updated
    detected_at       INTEGER NOT NULL,
    detected_by       TEXT DEFAULT 'arbiter',
    resolved          INTEGER DEFAULT 0,
    resolution        TEXT,            -- winner_a / winner_b / both_valid / both_invalid / dismiss
    resolution_reason TEXT,
    resolved_at       INTEGER,
    severity          TEXT,            -- 额外列：high / medium / low（面板标色用）
    reason            TEXT             -- 额外列：中文说明 + 裁决建议
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_resolved ON conflicts(resolved)`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_pair ON conflicts(memory_a, memory_b)`,

  // ---------- §3.3 因果链 / 决策时间线 ----------
  `CREATE TABLE IF NOT EXISTS decision_chains (
    id         TEXT PRIMARY KEY,
    project    TEXT,
    title      TEXT,
    trigger    TEXT,
    decision   TEXT,
    reason     TEXT,
    outcome    TEXT,
    parent_id  TEXT,
    root_id    TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES decision_chains(id)
  )`,

  // ---------- §3.4 删除传播日志 ----------
  // 同 conflicts：硬删之后仍要留日志，故不加 FK。
  `CREATE TABLE IF NOT EXISTS deletion_log (
    id                 TEXT PRIMARY KEY,
    memory_id          TEXT NOT NULL,
    deleted_at         INTEGER NOT NULL,
    propagation_status TEXT DEFAULT 'pending',
    affected_stores    TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deletion_memory ON deletion_log(memory_id)`,

  // ---------- §3.5 陈旧检测记录 ----------
  `CREATE TABLE IF NOT EXISTS staleness_checks (
    id         TEXT PRIMARY KEY,
    memory_id  TEXT NOT NULL,
    check_type TEXT,
    result     TEXT,
    confidence REAL,
    checked_at INTEGER NOT NULL,
    FOREIGN KEY (memory_id) REFERENCES memories(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stale_memory ON staleness_checks(memory_id)`,

  // ---------- §3.6 文档文件表 ----------
  `CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    file_path     TEXT NOT NULL UNIQUE,
    relative_path TEXT,                 -- 额外列：相对索引根目录的路径，注入时展示
    root_path     TEXT,                 -- 额外列：所属索引根目录
    project       TEXT,
    file_type     TEXT NOT NULL,        -- md / text / code / pdf / readme
    mime_type     TEXT,
    size_bytes    INTEGER,
    last_modified REAL NOT NULL,
    last_indexed  REAL NOT NULL,
    checksum      TEXT,
    chunk_count   INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'active',-- active / deleted / error
    error_message TEXT,
    created_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_doc_project ON documents(project)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_status ON documents(status)`,

  // ---------- §3.7 文档切片表 ----------
  `CREATE TABLE IF NOT EXISTS document_chunks (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    chunk_index  INTEGER NOT NULL,
    content      TEXT NOT NULL,
    chunk_type   TEXT NOT NULL DEFAULT 'paragraph',
    heading_path TEXT,
    start_line   INTEGER,
    end_line     INTEGER,
    metadata_json TEXT,
    created_at   INTEGER NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chunk_doc ON document_chunks(document_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunk_doc_index ON document_chunks(document_id, chunk_index)`,

  // ---------- §3.8 文档-记忆关联表 ----------
  `CREATE TABLE IF NOT EXISTS doc_memory_links (
    id          TEXT PRIMARY KEY,
    doc_id      TEXT NOT NULL,
    chunk_id    TEXT,
    memory_id   TEXT NOT NULL,
    relation    TEXT NOT NULL,          -- supports / contradicts / supersedes / unrelated
    detected_by TEXT DEFAULT 'system',
    detected_at INTEGER NOT NULL,
    resolved    INTEGER DEFAULT 0,
    FOREIGN KEY (doc_id) REFERENCES documents(id),
    FOREIGN KEY (memory_id) REFERENCES memories(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_links_doc ON doc_memory_links(doc_id)`,
  `CREATE INDEX IF NOT EXISTS idx_links_memory ON doc_memory_links(memory_id)`,

  // ---------- §3.9 文档变更队列 ----------
  `CREATE TABLE IF NOT EXISTS doc_change_queue (
    id           TEXT PRIMARY KEY,
    file_path    TEXT NOT NULL,
    event_type   TEXT NOT NULL,         -- create / modify / delete / rename
    detected_at  REAL NOT NULL,
    processed_at REAL,
    status       TEXT DEFAULT 'pending'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_queue_status ON doc_change_queue(status)`,

  // ---------- §3.10 记忆包记录表 ----------
  `CREATE TABLE IF NOT EXISTS installed_packs (
    id           TEXT PRIMARY KEY,
    pack_id      TEXT NOT NULL,
    pack_version TEXT NOT NULL,
    pack_name    TEXT NOT NULL,
    author       TEXT,
    installed_at INTEGER NOT NULL,
    updated_at   INTEGER,
    scope        TEXT DEFAULT 'global',
    auto_update  INTEGER DEFAULT 0,
    source       TEXT DEFAULT 'local',
    local_path   TEXT,
    memory_count INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'active'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_installed_pack ON installed_packs(pack_id)`,
  `CREATE TABLE IF NOT EXISTS pack_update_check (
    id              TEXT PRIMARY KEY,
    pack_id         TEXT NOT NULL,
    current_version TEXT NOT NULL,
    latest_version  TEXT,
    checked_at      INTEGER,
    available       INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pack_check ON pack_update_check(pack_id)`,

  // ---------- 索引根目录（契约 §0 允许放 DB，这里落表，原子且无需额外文件） ----------
  `CREATE TABLE IF NOT EXISTS doc_roots (
    path         TEXT PRIMARY KEY,
    added_at     INTEGER NOT NULL,
    last_scan_at INTEGER
  )`,
]

/** FTS 建表 + 触发器（失败可降级，单独 try/catch） */
const FTS_STATEMENTS = {
  memories: [
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
       USING fts5(content, tags, memory_id UNINDEXED, tokenize='trigram')`,
    `CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
       INSERT INTO memories_fts(content, tags, memory_id)
       VALUES (new.content, ifnull(new.tags, ''), new.id);
     END`,
    `CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
       DELETE FROM memories_fts WHERE memory_id = old.id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
       DELETE FROM memories_fts WHERE memory_id = old.id;
       INSERT INTO memories_fts(content, tags, memory_id)
       VALUES (new.content, ifnull(new.tags, ''), new.id);
     END`,
  ],
  chunks: [
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
       USING fts5(content, heading_path, chunk_id UNINDEXED, document_id UNINDEXED, tokenize='trigram')`,
    `CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON document_chunks BEGIN
       INSERT INTO chunks_fts(content, heading_path, chunk_id, document_id)
       VALUES (new.content, ifnull(new.heading_path, ''), new.id, new.document_id);
     END`,
    `CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON document_chunks BEGIN
       DELETE FROM chunks_fts WHERE chunk_id = old.id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON document_chunks BEGIN
       DELETE FROM chunks_fts WHERE chunk_id = old.id;
       INSERT INTO chunks_fts(content, heading_path, chunk_id, document_id)
       VALUES (new.content, ifnull(new.heading_path, ''), new.id, new.document_id);
     END`,
  ],
}

/** 简单的自增序号：同一毫秒内批量创建也不会撞 id */
let idCounter = 0

/**
 * 生成 id：<prefix>_<8字节时间戳><4位序号随机>
 * 纯内存操作，无 IO。
 */
export function newId(prefix) {
  idCounter = (idCounter + 1) % 100000
  const ts = Date.now().toString(36)
  const rand = crypto.randomBytes(4).toString('hex')
  return `${prefix}_${ts}${rand}${idCounter.toString(36)}`
}

/** 把任意值序列化成 JSON 文本；null/undefined/空数组 → null（保持 DB 干净） */
export function jsonOrNull(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value) && value.length === 0) return null
  if (typeof value === 'object' && Object.keys(value).length === 0) return null
  try {
    return JSON.stringify(value)
  } catch {
    // 含循环引用的对象不应让写库整体失败，退化成字符串
    return JSON.stringify(String(value))
  }
}

/** 解析 JSON 文本，失败或为空时返回 fallback（绝不抛错） */
export function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback
  if (typeof text !== 'string') return text
  try {
    const out = JSON.parse(text)
    return out === null || out === undefined ? fallback : out
  } catch {
    return fallback
  }
}

/** LIKE 查询转义（默认 ESCAPE '\'，见 sql 里的 escape 子句） */
export function likeEscape(text) {
  return String(text ?? '').replace(/[\\%_]/g, (ch) => '\\' + ch)
}

/**
 * 事务包装。node:sqlite 的 DatabaseSync 是同步的，所以事务也是同步的；
 * 嵌套调用直接复用外层事务，避免 "cannot start a transaction within a transaction"。
 */
export function tx(store, fn) {
  const db = store.db
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败（连接已断）时保留原始错误，信息更有价值
    }
    throw err
  }
}

/** 毫秒时间戳（store.now 的实现，便于测试时替换） */
export function nowMs() {
  return Date.now()
}

/**
 * 打开（必要时创建）存储。
 * @param {{dataDir?: string}} opts
 * @returns {{db: DatabaseSync, dataDir: string, dbPath: string, fts: {memories: boolean, chunks: boolean}, now: () => number, close: () => void}}
 */
export function openStore({ dataDir } = {}) {
  const dir = path.resolve(dataDir || defaultDataDir())

  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new Error(`无法创建 Mirror 数据目录：${dir}（${err.message}）`)
  }

  const dbPath = path.join(dir, 'mirror.db')
  let db
  try {
    db = new DatabaseSync(dbPath)
  } catch (err) {
    throw new Error(`无法打开 Mirror 数据库：${dbPath}（${err.message}）`)
  }

  // WAL：面板读 + 抽取写入并存时不会互相阻塞；
  // foreign_keys 打开后，删除记忆前必须显式清理引用行（MemoryService 里做了）。
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
  } catch {
    // PRAGMA 失败不是致命问题（只读介质等），继续用默认行为
  }

  let closed = false
  const store = {
    db,
    dataDir: dir,
    dbPath,
    // FTS 可用性标记：建表失败的极端环境下检索层退回 LIKE
    fts: { memories: false, chunks: false, error: null },
    now: nowMs,
    close() {
      if (closed) return
      closed = true
      try {
        db.close()
      } catch {
        // 关闭失败无需上抛，宿主卸载流程不应该因此中断
      }
    },
  }

  migrate(store)
  return store
}

/**
 * 迁移：user_version 判定，DDL 幂等。
 * DDL 放在事务里，中途失败会整体回滚，不会留下半个 schema。
 */
export function migrate(store) {
  const db = store.db
  let version = 0
  try {
    const row = db.prepare('PRAGMA user_version').get()
    version = Number(row?.user_version) || 0
  } catch {
    version = 0
  }

  if (version < SCHEMA_VERSION) {
    tx(store, () => {
      for (const sql of SCHEMA_STATEMENTS) db.exec(sql)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
  } else {
    // 已是最新版本：仍然跑一遍 IF NOT EXISTS，容忍手工删表/外部工具重建
    for (const sql of SCHEMA_STATEMENTS) db.exec(sql)
  }

  ensureFts(store)
  ensureExtras(store)
  return store
}

/**
 * 增量表（不抬 SCHEMA_VERSION，每次打开都幂等地补一遍）：
 *   - distillations：会话蒸馏产出的 profile（原始对话仍只在 sessions/ 里）
 *
 * 记忆包只记录本地来源（local / file）。
 */
function ensureExtras(store) {
  const db = store.db
  const statements = [
    `CREATE TABLE IF NOT EXISTS distillations (
        id           TEXT PRIMARY KEY,
        created_at   INTEGER NOT NULL,
        session_ids  TEXT,
        turn_count   INTEGER DEFAULT 0,
        profile_json TEXT NOT NULL,
        confidence   REAL DEFAULT 0.6,
        source       TEXT DEFAULT 'heuristic',   -- llm / heuristic / manual
        memory_count INTEGER DEFAULT 0
     )`,
    `CREATE INDEX IF NOT EXISTS idx_distill_created ON distillations(created_at)`,
    // PII 复核：暂存"待确认的蒸馏结果"（raw 含未脱敏原文，仅本机、应用/丢弃后即删）
    `CREATE TABLE IF NOT EXISTS distill_stage (
        id             TEXT PRIMARY KEY,
        created_at     INTEGER NOT NULL,
        source         TEXT DEFAULT 'manual',
        raw_json       TEXT NOT NULL,
        sanitized_json TEXT NOT NULL,
        redactions_json TEXT,
        dropped_json   TEXT,
        status         TEXT DEFAULT 'pending'    -- pending / applied / discarded
     )`,
    `CREATE INDEX IF NOT EXISTS idx_distill_stage_status ON distill_stage(status)`,
  ]
  for (const sql of statements) {
    try {
      db.exec(sql)
    } catch {
      /* 单个 DDL 失败不影响打开 store */
    }
  }
}

/** 建 FTS；任何一步失败都降级而不是让 store 打不开 */
function ensureFts(store) {
  const db = store.db
  for (const [key, statements] of Object.entries(FTS_STATEMENTS)) {
    try {
      tx(store, () => {
        for (const sql of statements) db.exec(sql)
      })
      // 自愈：清孤儿 + 补缺失（外部用 sqlite 工具改过库也能恢复）
      repairFts(store, key)
      store.fts[key] = true
    } catch (err) {
      store.fts[key] = false
      store.fts.error = store.fts.error || `全文索引不可用：${err.message}`
    }
  }
}

function repairFts(store, key) {
  const db = store.db
  try {
    if (key === 'memories') {
      db.exec(`DELETE FROM memories_fts WHERE memory_id NOT IN (SELECT id FROM memories)`)
      db.exec(
        `INSERT INTO memories_fts(content, tags, memory_id)
         SELECT content, ifnull(tags, ''), id FROM memories
         WHERE id NOT IN (SELECT memory_id FROM memories_fts)`,
      )
    } else {
      db.exec(`DELETE FROM chunks_fts WHERE chunk_id NOT IN (SELECT id FROM document_chunks)`)
      db.exec(
        `INSERT INTO chunks_fts(content, heading_path, chunk_id, document_id)
         SELECT content, ifnull(heading_path, ''), id, document_id FROM document_chunks
         WHERE id NOT IN (SELECT chunk_id FROM chunks_fts)`,
      )
    }
  } catch {
    // 自愈失败不影响可用性（新写入仍走触发器）
  }
}

/** 粗粒度计数（测试与面板统计都会用） */
export function countRows(store, sql, ...params) {
  try {
    const row = store.db.prepare(sql).get(...params)
    return Number(row?.c) || 0
  } catch {
    return 0
  }
}
