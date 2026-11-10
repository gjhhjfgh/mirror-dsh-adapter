/**
 * core/memory.js —— 记忆层（主观认知）
 *
 * 对应《Mirror 开发文档 v2.0》§3.1（表结构）、§4.1（去重）、§4.5（遗忘）、§6.2。
 *
 * 关键设计决策：
 *   - 去重/冲突用 bigram 相似度（arbiter.js 提供），不依赖 embedding。
 *     同一条记忆的「归一化文本完全相同」优先于一切阈值判定。
 *   - 去重只在**同 scope + 同 category** 的 active 记忆内进行：
 *     跨作用域合并会把项目级铁律误升为全局铁律，跨类别合并会吞掉
 *     「fuzzy → iron_rule」这种真实的认知升级。
 *   - 冲突全部以 resolved=0 记录，把裁决建议写进 reason，而不是自动改数据 ——
 *     产品原则是「冲突可审计，不静默覆盖」。面板「待确认」页据此展示。
 *   - 读取接口（get/search）才 +1 accessCount；list 不写库，保证面板轮询不放大计数。
 */

import { newId, jsonOrNull, parseJson, tx, likeEscape } from './storage.js'
import { Arbiter, AUTHORITY_WEIGHT, bigramJaccard, normalizeText } from './arbiter.js'
// R3：记忆检索复用文档检索的切词规则（splitQueryTerms 无状态，documents.js 不依赖 memory.js，无循环引用）
import { splitQueryTerms } from './documents.js'
// 向量召回 + RRF 融合（纯本地 n-gram 向量，不是神经嵌入）
import { rrfFuse, vectorSearch } from './vector.js'

/** 五级分类（文档 §4.1） */
export const CATEGORIES = ['iron_rule', 'preference', 'decision', 'pitfall', 'fuzzy']
/** 层级（文档 §4.1） */
export const LAYERS = ['fragment', 'strategy', 'fact']
/** 权威级别 */
export const AUTHORITIES = ['user_explicit', 'user_confirmed', 'inferred', 'imported']
/** 冲突处理方式（契约 §2.3） */
export const RESOLUTIONS = ['winner_a', 'winner_b', 'both_valid', 'both_invalid', 'dismiss']

const INSERT_MEMORY_SQL = `
INSERT INTO memories (
  id, category, layer, content, structured, confidence, authority, source_type, source_ref,
  created_at, last_verified_at, last_accessed_at, access_count, valid_from, valid_to, expires_at,
  frozen, causal_parent, causal_children, status, superseded_by, scope, tags,
  pack_id, pack_version, source_doc, doc_conflict, invalid_reason, user_modified
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?
)`

/** DB 行 → 对外的 Memory（camelCase、布尔真值、数组/对象已解析） */
export function rowToMemory(row) {
  if (!row) return null
  return {
    id: String(row.id),
    category: row.category,
    layer: row.layer || 'strategy',
    content: row.content,
    structured: parseJson(row.structured, null),
    confidence: Number(row.confidence ?? 0),
    authority: row.authority || 'inferred',
    sourceType: row.source_type || null,
    sourceRef: row.source_ref || null,
    createdAt: Number(row.created_at ?? 0),
    lastVerifiedAt: row.last_verified_at === null || row.last_verified_at === undefined ? null : Number(row.last_verified_at),
    lastAccessedAt: row.last_accessed_at === null || row.last_accessed_at === undefined ? null : Number(row.last_accessed_at),
    accessCount: Number(row.access_count ?? 0),
    validFrom: row.valid_from === null || row.valid_from === undefined ? null : Number(row.valid_from),
    validTo: row.valid_to === null || row.valid_to === undefined ? null : Number(row.valid_to),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    frozen: Number(row.frozen ?? 0) === 1,
    causalParent: row.causal_parent || null,
    causalChildren: parseJson(row.causal_children, []) || [],
    status: row.status || 'active',
    supersededBy: row.superseded_by || null,
    scope: row.scope || 'global',
    tags: parseJson(row.tags, []) || [],
    packId: row.pack_id || null,
    packVersion: row.pack_version || null,
    sourceDoc: row.source_doc || null,
    docConflict: row.doc_conflict || null,
    invalidReason: row.invalid_reason || null,
    userModified: Number(row.user_modified ?? 0) === 1,
  }
}

/** DB 行 → 对外的 Conflict（契约 §2.3 字段） */
export function rowToConflict(row, a = undefined, b = undefined) {
  if (!row) return null
  const conflict = {
    id: String(row.id),
    memoryA: row.memory_a,
    memoryB: row.memory_b,
    conflictType: row.conflict_type,
    detectedAt: Number(row.detected_at ?? 0),
    detectedBy: row.detected_by || 'arbiter',
    resolved: Number(row.resolved ?? 0) === 1,
    resolution: row.resolution || null,
    resolutionReason: row.resolution_reason || null,
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
    severity: row.severity || null,
    reason: row.reason || null,
  }
  // a/b 由调用方决定是否附带（listConflicts 一定带，内部创建时按需带）
  if (a !== undefined) conflict.a = a
  if (b !== undefined) conflict.b = b
  return conflict
}

function clampUnit(n, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(1, Math.max(0, v))
}

function oneOf(list, value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  if (!list.includes(value)) {
    throw new Error(`${label}不合法：${value}（可选 ${list.join(' / ')}）`)
  }
  return value
}

export class MemoryService {
  constructor({ store }) {
    if (!store || !store.db) throw new Error('MemoryService 需要一个有效的 store')
    this.store = store
    this.db = store.db
    this.arbiter = new Arbiter({ now: () => this.store.now() })
  }

  // ------------------------------------------------------------------ 查询

  /**
   * 列表（面板主数据）。默认只返回 active，按 createdAt 倒序。
   * @param {{category?: string, status?: string, scope?: string, q?: string, limit?: number}} query
   */
  list({ category, status = 'active', scope, q, limit } = {}) {
    const where = []
    const params = []
    if (status && status !== 'all') {
      where.push('status = ?')
      params.push(status)
    }
    if (category && category !== 'all') {
      where.push('category = ?')
      params.push(category)
    }
    if (scope && scope !== 'all') {
      where.push('scope = ?')
      params.push(scope)
    }
    if (q && String(q).trim()) {
      const like = `%${likeEscape(String(q).trim())}%`
      where.push(`(content LIKE ? ESCAPE '\\' OR ifnull(tags, '') LIKE ? ESCAPE '\\')`)
      params.push(like, like)
    }
    const capped = clampLimit(limit, 200, 2000)
    const sql = `SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC, id DESC LIMIT ?`
    params.push(capped)
    try {
      return this.db.prepare(sql).all(...params).map(rowToMemory)
    } catch {
      return []
    }
  }

  /** 读一条记忆：存在则 +1 accessCount / 刷新 lastAccessedAt（契约要求） */
  get(id) {
    if (!id) return null
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id))
    if (!row) return null
    const now = this.store.now()
    try {
      this.db
        .prepare('UPDATE memories SET last_accessed_at = ?, access_count = ifnull(access_count, 0) + 1 WHERE id = ?')
        .run(now, String(id))
    } catch {
      // 访问计数失败不影响读取
    }
    return rowToMemory({ ...row, last_accessed_at: now, access_count: Number(row.access_count ?? 0) + 1 })
  }

  // ------------------------------------------------------------------ 写入

  /**
   * 新建记忆（含去重 + 冲突检测）。
   * @returns {{memory: object, duplicate: boolean, conflicts: object[], superseded?: string[]}}
   */
  create(input = {}) {
    const draft = this._buildDraft(input)
    const now = this.store.now()

    // --- 1) 去重（同 scope + 同 category，文档 §4.1）---
    const closest = this._findClosest(draft)
    if (closest.exact || closest.jaccard >= 0.9) {
      return { memory: closest.memory, duplicate: true, conflicts: [] }
    }

    // --- 2) 相似但不同：新的更权威/更确信则覆盖式升级 ---
    // allowSupersede=false 时（蒸馏/包导入）永远不覆盖已有记忆：
    // AI 推断（confidence 0.95）不能靠"更确信"顶掉用户确认过的记忆。
    const maySupersede = input.allowSupersede !== false
    if (closest.jaccard >= 0.75 && closest.memory) {
      const old = closest.memory
      // 不允许覆盖：既不改旧记录，也不新增近重复 → 当作重复跳过
      if (!maySupersede) return { memory: old, duplicate: true, conflicts: [] }
      const betterAuthority =
        (AUTHORITY_WEIGHT[draft.authority] ?? 0.3) > (AUTHORITY_WEIGHT[old.authority] ?? 0.3)
      const betterConfidence = draft.confidence > Number(old.confidence ?? 0)
      if (!betterAuthority && !betterConfidence) {
        return { memory: old, duplicate: true, conflicts: [] }
      }
      // 先插新记录，再把旧记录标成 superseded（旧记录的 superseded_by 指向新 id）
      const created = this._insert({ ...draft, id: newId('mem') })
      this._supersede(old.id, created.id, now)
      const conflicts = this._detectConflicts(created, { exclude: [old.id] })
      return { memory: created, duplicate: false, conflicts, superseded: [old.id] }
    }

    // --- 3) 新记录 ---
    const created = this._insert({ ...draft, id: newId('mem') })
    const conflicts = this._detectConflicts(created)
    return { memory: created, duplicate: false, conflicts }
  }

  /**
   * 局部更新。改过的记忆会被标记 user_modified=1（记忆包卸载时据此保留）。
   * @returns {{memory: object, conflicts: object[]}}
   */
  update(id, patch = {}) {
    const existing = this._row(id)
    if (!existing) throw new Error(`记忆不存在：${id}`)
    const now = this.store.now()
    const sets = []
    const params = []
    const set = (col, value) => {
      sets.push(`${col} = ?`)
      params.push(value)
    }

    if (patch.content !== undefined) {
      const content = String(patch.content ?? '').trim()
      if (!content) throw new Error('记忆内容不能为空')
      set('content', content)
    }
    if (patch.category !== undefined) set('category', oneOf(CATEGORIES, patch.category, null, '记忆分类'))
    if (patch.layer !== undefined) set('layer', oneOf(LAYERS, patch.layer, null, '记忆层级'))
    if (patch.structured !== undefined) set('structured', jsonOrNull(patch.structured))
    if (patch.confidence !== undefined) set('confidence', clampUnit(patch.confidence, Number(existing.confidence ?? 0.5)))
    if (patch.authority !== undefined) set('authority', oneOf(AUTHORITIES, patch.authority, null, '权威级别'))
    if (patch.sourceType !== undefined) set('source_type', patch.sourceType ? String(patch.sourceType) : null)
    if (patch.sourceRef !== undefined) set('source_ref', patch.sourceRef ? String(patch.sourceRef) : null)
    if (patch.scope !== undefined) set('scope', patch.scope ? String(patch.scope) : 'global')
    if (patch.tags !== undefined) set('tags', jsonOrNull(normalizeTags(patch.tags)))
    if (patch.validFrom !== undefined) set('valid_from', toIntOrNull(patch.validFrom))
    if (patch.validTo !== undefined) set('valid_to', toIntOrNull(patch.validTo))
    if (patch.expiresAt !== undefined) set('expires_at', toIntOrNull(patch.expiresAt))
    if (patch.frozen !== undefined) set('frozen', patch.frozen ? 1 : 0)
    if (patch.status !== undefined) set('status', String(patch.status))
    if (patch.supersededBy !== undefined) set('superseded_by', patch.supersededBy ? String(patch.supersededBy) : null)
    if (patch.causalParent !== undefined) set('causal_parent', patch.causalParent ? String(patch.causalParent) : null)
    if (patch.causalChildren !== undefined) set('causal_children', jsonOrNull(patch.causalChildren))
    if (patch.packId !== undefined) set('pack_id', patch.packId ? String(patch.packId) : null)
    if (patch.packVersion !== undefined) set('pack_version', patch.packVersion ? String(patch.packVersion) : null)
    if (patch.sourceDoc !== undefined) set('source_doc', patch.sourceDoc ? String(patch.sourceDoc) : null)
    if (patch.docConflict !== undefined) set('doc_conflict', patch.docConflict ? String(patch.docConflict) : null)

    if (sets.length > 0) {
      set('user_modified', 1)
      set('last_verified_at', patch.lastVerifiedAt !== undefined ? toIntOrNull(patch.lastVerifiedAt) : now)
      params.push(String(id))
      this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    }

    const updated = rowToMemory(this._row(id))
    const conflicts = updated ? this._detectConflicts(updated) : []
    return { memory: updated, conflicts }
  }

  /** 用户确认：权威升到 user_confirmed，置信度下限 0.9（文档 §4.5 的确认流） */
  confirm(id) {
    const existing = this._row(id)
    if (!existing) throw new Error(`记忆不存在：${id}`)
    const now = this.store.now()
    const confidence = Math.max(0.9, Number(existing.confidence ?? 0))
    this.db
      .prepare(
        `UPDATE memories
            SET authority = 'user_confirmed', last_verified_at = ?, confidence = ?,
                user_modified = 1, status = CASE WHEN status = 'deleted' THEN 'active' ELSE status END
          WHERE id = ?`,
      )
      .run(now, confidence, String(id))
    return { memory: rowToMemory(this._row(id)) }
  }

  /** 冻结 / 解冻：冻结后不参与陈旧自动判定（文档 §4.5） */
  freeze(id, frozen = true) {
    const existing = this._row(id)
    if (!existing) throw new Error(`记忆不存在：${id}`)
    this.db.prepare('UPDATE memories SET frozen = ?, user_modified = 1 WHERE id = ?').run(frozen ? 1 : 0, String(id))
    return { memory: rowToMemory(this._row(id)) }
  }

  /**
   * 失效（默认的遗忘方式）：只标 validTo/status，保留审计痕迹。
   * reason 落到 invalid_reason 列（额外列），面板可展示。
   */
  invalidate(id, { reason } = {}) {
    const existing = this._row(id)
    if (!existing) throw new Error(`记忆不存在：${id}`)
    const now = this.store.now()
    this.db
      .prepare(`UPDATE memories SET status = 'superseded', valid_to = ?, invalid_reason = ? WHERE id = ?`)
      .run(now, reason ? String(reason) : null, String(id))
    return { memory: rowToMemory(this._row(id)) }
  }

  /**
   * 硬删除 + 遗忘传播：FTS（触发器）/ doc_memory_links / conflicts / staleness_checks
   * 全部清理，最后写 deletion_log。删除是「干净遗忘」，不可恢复。
   * @returns {{deleted: true, id: string, propagation: object}} propagation 记录在 deletion_log.affected_stores
   */
  remove(id) {
    const key = String(id)
    const row = this._row(key)
    if (!row) throw new Error(`记忆不存在：${key}`)
    const now = this.store.now()
    const logId = newId('del')

    return tx(this.store, () => {
      // 因果链：子节点不能继续指向一个不存在的父节点
      this.db.prepare('UPDATE memories SET causal_parent = NULL WHERE causal_parent = ?').run(key)
      const links = this.db.prepare('DELETE FROM doc_memory_links WHERE memory_id = ?').run(key)
      const conflicts = this.db
        .prepare('DELETE FROM conflicts WHERE memory_a = ? OR memory_b = ?')
        .run(key, key)
      const stale = this.db.prepare('DELETE FROM staleness_checks WHERE memory_id = ?').run(key)
      // 主表（memories_fts 由触发器同步删除）
      const removed = this.db.prepare('DELETE FROM memories WHERE id = ?').run(key)

      // 传播记录：v1 只有 SQLite + FTS 两个存储，vector/graph/cache 保留字段占位，
      // 未来接 Chroma / 图数据库时这里逐项置真。
      const affected = {
        vector: false,
        graph: false,
        cache: true,
        fts: !!this.store.fts.memories,
        links: true,
      }
      this.db
        .prepare(
          `INSERT INTO deletion_log (id, memory_id, deleted_at, propagation_status, affected_stores)
           VALUES (?, ?, ?, 'complete', ?)`,
        )
        .run(logId, key, now, JSON.stringify(affected))

      return {
        deleted: true,
        id: key,
        propagation: {
          memoryId: key,
          deletedRows: Number(removed.changes || 0),
          links: Number(links.changes || 0),
          conflicts: Number(conflicts.changes || 0),
          stalenessChecks: Number(stale.changes || 0),
          affectedStores: affected,
          deletionLogId: logId,
          propagationStatus: 'complete',
        },
      }
    })
  }

  // ------------------------------------------------------------------ 检索

  /**
   * 记忆检索（R3，与文档检索 §10.2 同口径）：先切词，再逐词 LIKE 匹配 `content` + `tags`。
   *
   * 修复的真实缺陷：`search({q:'我平时怎么跟你沟通'})` 以前整句当子串匹配 → 0 条，
   * 导致 retrieve() 的「偏好/决策/踩坑」层几乎没有候选池。
   *
   * 排序：命中词项数 desc → arbiter.score（权威/新鲜/置信）desc → createdAt desc。
   * 记忆量级小（本地面板常驻几百条），全表读取后在 JS 里打分比 FTS 更好控制排序，
   * 也天然保证 1–2 字中文能命中（不依赖 trigram）。
   * scope 语义保持不变：undefined / 'all' 不过滤，其余精确匹配。
   * 空 query 返回 []；命中会 +1 accessCount（契约要求）。
   * @returns {object[]} Memory[]
   */
  search({ q, scope, limit, useVector = true } = {}) {
    const query = String(q ?? '').trim()
    if (!query) return []
    const capped = clampLimit(limit, 50, 500)
    const terms = splitQueryTerms(query)
    if (terms.length === 0) return []

    const where = ["status = 'active'"]
    const params = []
    if (scope && scope !== 'all') {
      where.push('scope = ?')
      params.push(scope)
    }

    let rows = []
    try {
      rows = this.db
        .prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 2000`)
        .all(...params)
    } catch {
      rows = []
    }

    const scored = []
    for (const row of rows) {
      const content = row.content ?? ''
      const tags = row.tags ?? ''
      let matched = 0
      for (const term of terms) {
        if (memoryFieldMatches(content, term) || memoryFieldMatches(tags, term)) matched += 1
      }
      if (matched === 0) continue
      const memory = rowToMemory(row)
      scored.push({ memory, matched, score: this.arbiter.score(memory) })
    }

    scored.sort(
      (a, b) =>
        b.matched - a.matched ||
        b.score - a.score ||
        b.memory.createdAt - a.memory.createdAt ||
        String(a.memory.id).localeCompare(String(b.memory.id)),
    )

    // --- 向量召回 + RRF 融合：补 FTS/词法漏掉的短词与换词表述 ---
    let ordered = scored
    if (useVector && rows.length > 0) {
      try {
        const lexicalIds = scored.map((item) => item.memory.id)
        const vectorHits = vectorSearch({
          items: rows,
          query,
          getText: (row) => `${row.content ?? ''} ${row.tags ?? ''}`,
          getId: (row) => row.id,
          getKey: (row) => `${row.id}:${row.last_verified_at ?? row.created_at ?? 0}`,
          topK: 60,
        })
        const fused = rrfFuse([lexicalIds, vectorHits.map((hit) => hit.id)])
        const byId = new Map(rows.map((row) => [String(row.id), row]))
        const lexById = new Map(scored.map((item) => [String(item.memory.id), item]))
        ordered = []
        for (const entry of fused) {
          const lexical = lexById.get(entry.id)
          if (lexical) {
            ordered.push({ ...lexical, rrf: entry.score, via: entry.ranks.length > 1 ? 'both' : 'lexical' })
            continue
          }
          const row = byId.get(entry.id)
          if (!row) continue
          const memory = rowToMemory(row)
          ordered.push({ memory, matched: 0, score: this.arbiter.score(memory), rrf: entry.score, via: 'vector' })
        }
      } catch {
        ordered = scored
      }
    }

    const memories = ordered.slice(0, capped).map((item) => item.memory)
    // 命中即访问：批量 +1，避免逐条事务
    if (memories.length > 0) {
      const now = this.store.now()
      try {
        const stmt = this.db.prepare(
          'UPDATE memories SET last_accessed_at = ?, access_count = ifnull(access_count, 0) + 1 WHERE id = ?',
        )
        tx(this.store, () => {
          for (const memory of memories) stmt.run(now, memory.id)
        })
      } catch {
        // 计数失败不影响检索结果
      }
    }
    return memories
  }

  // ------------------------------------------------------------------ 统计

  stats({ scope } = {}) {
    const memWhere = scope && scope !== 'all' ? 'WHERE scope = ?' : ''
    const memParams = scope && scope !== 'all' ? [scope] : []

    const total = this._count(`SELECT count(*) AS c FROM memories ${memWhere}`, ...memParams)
    const active = this._count(
      `SELECT count(*) AS c FROM memories ${memWhere ? memWhere + " AND status = 'active'" : "WHERE status = 'active'"}`,
      ...memParams,
    )
    const superseded = this._count(
      `SELECT count(*) AS c FROM memories ${memWhere ? memWhere + " AND status = 'superseded'" : "WHERE status = 'superseded'"}`,
      ...memParams,
    )
    const frozen = this._count(
      `SELECT count(*) AS c FROM memories ${memWhere ? memWhere + ' AND ifnull(frozen, 0) = 1' : 'WHERE ifnull(frozen, 0) = 1'}`,
      ...memParams,
    )
    const byCategory = {}
    for (const category of CATEGORIES) {
      byCategory[category] = this._count(
        `SELECT count(*) AS c FROM memories WHERE category = ? AND status = 'active'${scope && scope !== 'all' ? ' AND scope = ?' : ''}`,
        category,
        ...memParams,
      )
    }
    // 待确认 = 未裁决且涉及当前作用域记忆的冲突数（面板「2 待确认」）
    const conflicts = this._count(
      `SELECT count(*) AS c FROM conflicts c
        WHERE c.resolved = 0
          ${scope && scope !== 'all' ? 'AND (c.memory_a IN (SELECT id FROM memories WHERE scope = ?) OR c.memory_b IN (SELECT id FROM memories WHERE scope = ?))' : ''}`,
      ...(scope && scope !== 'all' ? [scope, scope] : []),
    )
    return {
      memories: total,
      active,
      superseded,
      frozen,
      pendingConfirm: conflicts,
      conflicts,
      byCategory,
    }
  }

  // ------------------------------------------------------------------ 陈旧检测

  /**
   * 年龄维度的陈旧检测（文档 §4.4）。
   * frozen=1 或 stalerThanDays 天内验证过的都不算陈旧。
   * 只给判定为 stale 的记忆写 staleness_checks，避免每次检查都膨胀日志。
   */
  stalenessCheck({ stalerThanDays = 90 } = {}) {
    const days = Number(stalerThanDays) > 0 ? Number(stalerThanDays) : 90
    const now = this.store.now()
    const cutoff = now - days * 86400000
    let rows = []
    try {
      rows = this.db.prepare(`SELECT * FROM memories WHERE status = 'active' AND ifnull(frozen, 0) = 0`).all()
    } catch {
      rows = []
    }
    const stale = []
    const insert = this.db.prepare(
      `INSERT INTO staleness_checks (id, memory_id, check_type, result, confidence, checked_at)
       VALUES (?, ?, 'age', ?, ?, ?)`,
    )
    // 面板每次刷新 /state 都会调一次陈旧检测；同一记忆 24 小时内只留一条 age/stale 记录，
    // 避免审计表被高频轮询刷爆（记录本身仍然可追溯）。
    const recent = this.db.prepare(
      `SELECT id FROM staleness_checks
        WHERE memory_id = ? AND check_type = 'age' AND result = 'stale' AND checked_at > ?
        LIMIT 1`,
    )
    const dedupeWindowStart = now - 86400000
    tx(this.store, () => {
      for (const row of rows) {
        const verifiedAt = Number(row.last_verified_at || row.created_at || 0)
        if (verifiedAt >= cutoff) continue
        const mem = rowToMemory(row)
        stale.push(mem)
        try {
          if (recent.get(mem.id, dedupeWindowStart)) continue
          insert.run(newId('schk'), mem.id, 'stale', 0.8, now)
        } catch {
          // 记录失败不影响检测结果
        }
      }
    })
    return { checked: rows.length, stale, stalerThanDays: days }
  }

  // ------------------------------------------------------------------ 冲突管理（契约 §2.3）

  /** 冲突列表：默认只看未裁决的，按 detectedAt 倒序，附带 a / b 两条记忆 */
  listConflicts({ resolved = false, limit } = {}) {
    const capped = clampLimit(limit, 100, 1000)
    let rows = []
    try {
      rows = this.db
        .prepare('SELECT * FROM conflicts WHERE resolved = ? ORDER BY detected_at DESC, id DESC LIMIT ?')
        .all(resolved ? 1 : 0, capped)
    } catch {
      rows = []
    }
    const cache = new Map()
    const resolveRef = (ref) => {
      if (!ref) return null
      if (cache.has(ref)) return cache.get(ref)
      let memory = null
      // 对端可能是 'doc:<id>' / 'pack:<id>'，此时没有对应记忆
      if (!String(ref).includes(':')) {
        const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(String(ref))
        memory = rowToMemory(row)
      }
      cache.set(ref, memory)
      return memory
    }
    return rows.map((row) => rowToConflict(row, resolveRef(row.memory_a), resolveRef(row.memory_b)))
  }

  /**
   * 手动合并两条记忆（治理质量：近似重复对一键收敛）。
   *
   * 语义：保留 keep 的内容与结构化，标签取并集、置信度取高；drop 被标成 superseded 指向 keep；
   * 两者之间未解的冲突一并关闭（both_valid）。
   * @returns {{kept: object, superseded: string, conflictsClosed: number, tagsMerged: number}}
   */
  merge({ keepId, dropId, reason = '' } = {}) {
    const keepKey = String(keepId ?? '').trim()
    const dropKey = String(dropId ?? '').trim()
    if (!keepKey || !dropKey) throw new Error('合并需要 keepId 与 dropId')
    if (keepKey === dropKey) throw new Error('不能和自己合并')
    const keep = this._row(keepKey)
    const drop = this._row(dropKey)
    if (!keep) throw new Error(`记忆不存在：${keepKey}`)
    if (!drop) throw new Error(`记忆不存在：${dropKey}`)
    const now = this.store.now()

    const keepTags = normalizeTags(keep.tags)
    const dropTags = normalizeTags(drop.tags)
    const mergedTags = [...new Set([...keepTags, ...dropTags])]
    const confidence = Math.max(Number(keep.confidence ?? 0), Number(drop.confidence ?? 0))
    this.db
      .prepare('UPDATE memories SET tags = ?, confidence = ?, last_verified_at = ?, user_modified = 1 WHERE id = ?')
      .run(jsonOrNull(mergedTags), confidence, now, keep.id)

    this._supersede(drop.id, keep.id, now)

    let conflictsClosed = 0
    try {
      conflictsClosed = this.db
        .prepare(
          `UPDATE conflicts SET resolved = 1, resolution = 'both_valid', resolution_reason = ?, resolved_at = ?
            WHERE resolved = 0 AND ((memory_a = ? AND memory_b = ?) OR (memory_a = ? AND memory_b = ?))`,
        )
        .run(reason || '手动合并（内容近似）', now, keep.id, drop.id, drop.id, keep.id).changes
    } catch {
      conflictsClosed = 0
    }

    return {
      kept: rowToMemory(this._row(keep.id)),
      superseded: drop.id,
      conflictsClosed,
      tagsMerged: mergedTags.length,
    }
  }

  /**
   * 裁决冲突（契约 §2.3）。
   * winner_a → memory_b 置 superseded；winner_b 反向；
   * both_invalid → 两条都 superseded；both_valid / dismiss → 只标记已处理。
   * 对端是 'doc:<id>' / 'pack:<id>' 时只写冲突记录，不动文档/记忆包。
   */
  resolveConflict(id, { resolution, reason = '' } = {}) {
    const key = String(id)
    if (!RESOLUTIONS.includes(resolution)) {
      throw new Error(`无效的冲突处理方式：${resolution || '未提供'}（可选 ${RESOLUTIONS.join(' / ')}）`)
    }
    const row = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(key)
    if (!row) throw new Error(`冲突不存在：${key}`)
    const now = this.store.now()

    const isMemoryRef = (ref) => !!ref && !String(ref).includes(':')
    const supersede = (memoryId, winnerId) => {
      if (!isMemoryRef(memoryId)) return
      this.db
        .prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, valid_to = ? WHERE id = ? AND status = 'active'`)
        .run(winnerId ? String(winnerId) : null, now, String(memoryId))
    }

    tx(this.store, () => {
      if (resolution === 'winner_a') supersede(row.memory_b, row.memory_a)
      else if (resolution === 'winner_b') supersede(row.memory_a, row.memory_b)
      else if (resolution === 'both_invalid') {
        supersede(row.memory_a, null)
        supersede(row.memory_b, null)
      }
      this.db
        .prepare(
          `UPDATE conflicts SET resolved = 1, resolution = ?, resolution_reason = ?, resolved_at = ? WHERE id = ?`,
        )
        .run(resolution, reason ? String(reason) : null, now, key)
    })

    return this._getConflict(key)
  }

  // ------------------------------------------------------------------ 内部实现

  /** 校验 + 填默认值（契约 §2.1 的默认值表） */
  _buildDraft(input = {}) {
    const content = typeof input.content === 'string' ? input.content.trim() : ''
    if (!content) throw new Error('记忆内容不能为空')
    const category = oneOf(CATEGORIES, input.category, null, '记忆分类')
    const authority = oneOf(AUTHORITIES, input.authority, 'user_explicit', '权威级别')
    // 手动写入（面板/工具）= 用户显式；authority=user_explicit 时置信度默认 1，否则 0.6
    const now = this.store.now()
    return {
      category,
      layer: oneOf(LAYERS, input.layer, 'strategy', '记忆层级'),
      content,
      structured: input.structured ?? null,
      confidence:
        input.confidence === undefined || input.confidence === null
          ? authority === 'user_explicit'
            ? 1
            : 0.6
          : clampUnit(input.confidence, 0.6),
      authority,
      sourceType: input.sourceType ?? null,
      sourceRef: input.sourceRef ?? null,
      createdAt: now,
      lastVerifiedAt: input.lastVerifiedAt ?? null,
      lastAccessedAt: null,
      accessCount: 0,
      validFrom: input.validFrom ?? now,
      validTo: input.validTo ?? null,
      expiresAt: input.expiresAt ?? null,
      frozen: input.frozen ? 1 : 0,
      causalParent: input.causalParent ?? null,
      causalChildren: normalizeArray(input.causalChildren),
      status: input.status ? String(input.status) : 'active',
      supersededBy: null,
      scope: input.scope ? String(input.scope) : 'global',
      tags: normalizeTags(input.tags),
      packId: input.packId ?? null,
      packVersion: input.packVersion ?? null,
      sourceDoc: input.sourceDoc ?? null,
      docConflict: input.docConflict ?? null,
      invalidReason: null,
      userModified: input.userModified ? 1 : 0,
    }
  }

  _insert(draft) {
    const values = [
      draft.id,
      draft.category,
      draft.layer,
      draft.content,
      jsonOrNull(draft.structured),
      draft.confidence,
      draft.authority,
      draft.sourceType || null,
      draft.sourceRef || null,
      draft.createdAt,
      draft.lastVerifiedAt ?? null,
      draft.lastAccessedAt ?? null,
      draft.accessCount ?? 0,
      draft.validFrom ?? null,
      draft.validTo ?? null,
      draft.expiresAt ?? null,
      draft.frozen ? 1 : 0,
      draft.causalParent || null,
      jsonOrNull(draft.causalChildren),
      draft.status || 'active',
      draft.supersededBy || null,
      draft.scope || 'global',
      jsonOrNull(draft.tags),
      draft.packId || null,
      draft.packVersion || null,
      draft.sourceDoc || null,
      draft.docConflict || null,
      draft.invalidReason || null,
      draft.userModified ? 1 : 0,
    ]
    this.db.prepare(INSERT_MEMORY_SQL).run(...values)
    return rowToMemory(this._row(draft.id))
  }

  /** 同 scope + 同 category 的 active 记忆里找最像的一条 */
  _findClosest(draft) {
    let rows = []
    try {
      rows = this.db
        .prepare(
          `SELECT * FROM memories
            WHERE status = 'active' AND scope = ? AND category = ?
            ORDER BY created_at DESC LIMIT 300`,
        )
        .all(draft.scope, draft.category)
    } catch {
      rows = []
    }
    const normNew = normalizeText(draft.content)
    let best = { memory: null, exact: false, jaccard: 0 }
    for (const row of rows) {
      const memory = rowToMemory(row)
      if (normalizeText(memory.content) === normNew) {
        return { memory, exact: true, jaccard: 1 }
      }
      const jaccard = bigramJaccard(draft.content, memory.content)
      if (jaccard > best.jaccard) best = { memory, exact: false, jaccard }
    }
    return best
  }

  /** 把旧记忆标成被新记忆取代 */
  _supersede(oldId, newIdValue, now) {
    this.db
      .prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, valid_to = ? WHERE id = ?`)
      .run(newIdValue, now, String(oldId))
  }

  /**
   * 冲突检测 + 落库。返回新写入（或已存在）的冲突记录。
   * 单条记忆最多记 20 条冲突，防止一次导入把面板刷爆。
   */
  _detectConflicts(memory, { exclude = [] } = {}) {
    if (!memory) return []
    let rows = []
    try {
      rows = this.db
        .prepare(
          `SELECT * FROM memories
            WHERE status = 'active' AND scope = ? AND id <> ?
            ORDER BY created_at DESC LIMIT 300`,
        )
        .all(memory.scope, memory.id)
    } catch {
      rows = []
    }
    const conflicts = []
    for (const row of rows) {
      if (exclude.includes(row.id)) continue
      const other = rowToMemory(row)
      const classified = this.arbiter.classify(memory, other)
      if (!classified) continue
      const resolution = this.arbiter.resolve(memory, other)
      const reason = `${classified.reason}。裁决建议：${resolution.reason}`
      const record = this._recordConflict({
        memoryA: memory.id,
        memoryB: other.id,
        conflictType: classified.conflictType,
        severity: classified.severity,
        reason,
        detectedBy: 'arbiter',
      })
      if (record) conflicts.push(record)
      if (conflicts.length >= 20) break
    }
    return conflicts
  }

  /** 同一对记忆、同一类型、尚未裁决的冲突不重复写（否则每次 update 都会加一行） */
  _recordConflict({ memoryA, memoryB, conflictType, severity, reason, detectedBy = 'arbiter' }) {
    try {
      const existed = this.db
        .prepare(
          `SELECT * FROM conflicts
            WHERE resolved = 0 AND conflict_type = ?
              AND ((memory_a = ? AND memory_b = ?) OR (memory_a = ? AND memory_b = ?))
            LIMIT 1`,
        )
        .get(conflictType, memoryA, memoryB, memoryB, memoryA)
      if (existed) {
        this.db.prepare('UPDATE conflicts SET severity = ?, reason = ? WHERE id = ?').run(severity, reason, existed.id)
        return rowToConflict({ ...existed, severity, reason })
      }
      const id = newId('cfl')
      this.db
        .prepare(
          `INSERT INTO conflicts (id, memory_a, memory_b, conflict_type, detected_at, detected_by, resolved, severity, reason)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(id, String(memoryA), String(memoryB), conflictType, this.store.now(), detectedBy, severity || null, reason || null)
      return rowToConflict(this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id))
    } catch {
      // 冲突记录是「辅助审计」，写失败不该让主写入回滚
      return null
    }
  }

  _getConflict(id) {
    const row = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(String(id))
    if (!row) return null
    const lookup = (ref) => {
      if (!ref || String(ref).includes(':')) return null
      return rowToMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(String(ref)))
    }
    return rowToConflict(row, lookup(row.memory_a), lookup(row.memory_b))
  }

  _row(id) {
    if (!id) return null
    try {
      return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id)) ?? null
    } catch {
      return null
    }
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

/** 拉丁词项的正则缓存（记忆检索是热点路径，避免每个词项反复编译正则） */
const FIELD_REGEX_CACHE = new Map()

/**
 * 单个词项是否命中字段（content / tags）。
 * 拉丁词按词边界（npm 不命中 pnpm）；中文按子串，等价于 SQL `LIKE '%词%'`。
 */
function memoryFieldMatches(haystack, term) {
  const text = String(haystack ?? '')
  const target = String(term ?? '')
  if (!text || !target) return false
  if (/^[\x20-\x7e]+$/.test(target)) {
    let re = FIELD_REGEX_CACHE.get(target)
    if (!re) {
      re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(target)}(?![A-Za-z0-9_])`, 'i')
      FIELD_REGEX_CACHE.set(target, re)
    }
    return re.test(text)
  }
  return text.toLowerCase().includes(target.toLowerCase())
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// -------------------------------------------------------------------- 小工具

function clampLimit(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : null
}

function normalizeTags(tags) {
  if (tags === null || tags === undefined) return []
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 50)
  return String(tags)
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50)
}

function normalizeArray(value) {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  return [String(value)]
}
