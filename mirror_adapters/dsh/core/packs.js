/**
 * core/packs.js —— 记忆包（Mirror Pack）
 *
 * 对应《Mirror 开发文档 v2.0》§9.1（开放格式）、§9.2（导入与冲突处理）、
 * §9.3（版本更新）、§9.4（创作者工具-从记忆导出）。
 *
 * 关键设计决策：
 *   - 包格式是**开放规范**：parse/export 都直接以 §9.1 的 snake_case JSON 为准，
 *     内部再转成 camelCase 对象给其它模块用；toPackFile() 负责反向输出。
 *   - 导入逐条走 MemoryService.create()，复用同一套去重/冲突检测，
 *     绝不另造一套相似度规则。
 *   - strategy 语义：
 *       ask（默认）= 有冲突先跳过，冲突留 unresolved 等用户裁决；
 *       local_first = 本地优先，跳过包内冲突条；
 *       skip_conflicts = 同 local_first（别名，仅语义更明确）；
 *       pack_first = 包优先，把冲突的本地记忆 invalidate 后写入包记忆。
 *   - 包记忆 authority 固定 imported（权重 0.7），因此永远不会盖掉用户显式记忆，
 *     除非用户主动选 pack_first。
 */

import crypto from 'node:crypto'

import { newId } from './storage.js'
import { rowToMemory, CATEGORIES, LAYERS, AUTHORITIES } from './memory.js'
import { bigramJaccard, isOpposite } from './arbiter.js'

/** 本内核版本（min_mirror_version 校验用） */
export const MIRROR_VERSION = '2.0.0'
/** 支持的包格式版本 */
export const SUPPORTED_FORMAT_VERSIONS = ['1.0']
/** 导入策略 */
export const INSTALL_STRATEGIES = ['ask', 'pack_first', 'local_first', 'skip_conflicts']

/** InstalledPack 行 → camelCase（契约 §4） */
export function rowToInstalledPack(row) {
  if (!row) return null
  return {
    id: String(row.id),
    packId: row.pack_id,
    packVersion: row.pack_version,
    packName: row.pack_name,
    author: row.author || null,
    installedAt: Number(row.installed_at ?? 0),
    updatedAt: row.updated_at === null || row.updated_at === undefined ? null : Number(row.updated_at),
    scope: row.scope || 'global',
    autoUpdate: Number(row.auto_update ?? 0) === 1,
    source: row.source || 'local',
    localPath: row.local_path || null,
    memoryCount: Number(row.memory_count ?? 0),
    status: row.status || 'active',
  }
}

export class PackService {
  constructor({ store, memories, arbiter } = {}) {
    if (!store || !store.db) throw new Error('PackService 需要一个有效的 store')
    if (!memories) throw new Error('PackService 需要 MemoryService 实例')
    this.store = store
    this.db = store.db
    this.memories = memories
    this.arbiter = arbiter || memories.arbiter
  }

  // ------------------------------------------------------------------ 解析

  /**
   * 解析并校验记忆包（对象或 JSON 文本均可）。
   * 校验失败抛 Error，消息可直接展示给用户。
   */
  parse(objOrText) {
    const raw = typeof objOrText === 'string' ? parseJsonText(objOrText) : objOrText
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('记忆包格式无效：顶层必须是 JSON 对象')
    }

    // pack_id
    const packId = str(raw.pack_id ?? raw.packId)
    if (!packId) throw new Error('记忆包缺少 pack_id')
    if (!/^[A-Za-z0-9_.-]+$/.test(packId)) {
      throw new Error(`pack_id 只能包含字母、数字、下划线、点和短横线：${packId}`)
    }

    const name = str(raw.name)
    if (!name) throw new Error('记忆包缺少 name')

    const version = str(raw.version)
    if (!version) throw new Error('记忆包缺少 version')
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`记忆包版本号不合法：${version}（应形如 1.2.0）`)
    }

    const formatVersion = str(raw.format_version ?? raw.formatVersion ?? '1.0')
    if (!SUPPORTED_FORMAT_VERSIONS.includes(formatVersion)) {
      throw new Error(`不支持的记忆包格式版本：${formatVersion}（当前仅支持 ${SUPPORTED_FORMAT_VERSIONS.join(' / ')}）`)
    }

    const minMirrorVersion = str(raw.min_mirror_version ?? raw.minMirrorVersion ?? '0.0.0')
    if (compareVersion(minMirrorVersion, MIRROR_VERSION) > 0) {
      throw new Error(
        `该记忆包要求 Mirror 版本 >= ${minMirrorVersion}，当前版本为 ${MIRROR_VERSION}，请先升级 Mirror`,
      )
    }

    const rawMemories = raw.memories
    if (!Array.isArray(rawMemories)) throw new Error('记忆包缺少 memories 数组')

    const memories = rawMemories.map((item, index) => {
      const position = index + 1
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`记忆包第 ${position} 条记忆格式无效：应为对象`)
      }
      const content = str(item.content).trim()
      if (!content) throw new Error(`记忆包第 ${position} 条记忆缺少 content`)
      const category = str(item.category) || 'fuzzy'
      if (!CATEGORIES.includes(category)) {
        throw new Error(`记忆包第 ${position} 条记忆分类不合法：${category}（可选 ${CATEGORIES.join(' / ')}）`)
      }
      const layer = str(item.layer) || 'strategy'
      if (!LAYERS.includes(layer)) {
        throw new Error(`记忆包第 ${position} 条记忆层级不合法：${layer}（可选 ${LAYERS.join(' / ')}）`)
      }
      const authority = str(item.authority) || 'imported'
      if (!AUTHORITIES.includes(authority)) {
        throw new Error(`记忆包第 ${position} 条记忆权威级别不合法：${authority}`)
      }
      const confidence =
        item.confidence === undefined || item.confidence === null ? 0.7 : clamp01(Number(item.confidence), 0.7)
      return {
        category,
        layer,
        content,
        structured: item.structured && typeof item.structured === 'object' ? item.structured : null,
        authority,
        scope: str(item.scope) || 'global',
        tags: Array.isArray(item.tags) ? item.tags.map((t) => String(t)).filter(Boolean) : [],
        confidence,
      }
    })

    const changelog = Array.isArray(raw.changelog)
      ? raw.changelog
          .filter((c) => c && typeof c === 'object')
          .map((c) => ({
            version: str(c.version),
            date: str(c.date),
            changes: str(c.changes),
          }))
      : []

    const docReferences = Array.isArray(raw.doc_references ?? raw.docReferences)
      ? (raw.doc_references ?? raw.docReferences)
          .filter((d) => d && typeof d === 'object')
          .map((d) => ({ path: str(d.path), description: str(d.description) }))
      : []

    return {
      schema: str(raw.$schema) || 'https://mirror.dev/schemas/pack/v1.json',
      packId,
      name,
      version,
      formatVersion,
      author: str(raw.author) || 'unknown',
      category: str(raw.category) || 'template',
      description: str(raw.description) || '',
      minMirrorVersion,
      memories,
      docReferences,
      changelog,
      }
  }

  /** 已安装包列表（installed_packs 行，camelCase） */
  list() {
    try {
      return this.db
        .prepare(`SELECT * FROM installed_packs WHERE status <> 'uninstalled' ORDER BY installed_at DESC`)
        .all()
        .map(rowToInstalledPack)
    } catch {
      return []
    }
  }

  // ------------------------------------------------------------------ 安装

  /**
   * 安装记忆包。
   * @param {{pack: object|string, strategy?: string, source?: string, localPath?: string, scope?: string}} input
   * @returns {{installed: boolean, created: number, skipped: number, conflicts: object[], packId: string, version: string}}
   */
  install({ pack, strategy = 'ask', source = 'local', localPath, scope, allowSupersede = false } = {}) {
    const parsed = this.parse(pack)
    if (!INSTALL_STRATEGIES.includes(strategy)) {
      throw new Error(`不支持的导入策略：${strategy}（可选 ${INSTALL_STRATEGIES.join(' / ')}）`)
    }
    const now = this.store.now()
    const createdIds = []
    const skippedIds = []
    const conflicts = []
    const errors = []

    for (const item of parsed.memories) {
      const targetScope = scope || item.scope || 'global'
      const input = {
        content: item.content,
        category: item.category,
        layer: item.layer,
        structured: item.structured,
        confidence: item.confidence,
        // 包导入永远是 imported：权重 0.7，低于用户显式（1.0）与用户确认（0.9）
        authority: 'imported',
        scope: targetScope,
        tags: item.tags,
        sourceType: 'pack',
        sourceRef: `${parsed.packId}@${parsed.version}`,
        packId: parsed.packId,
        packVersion: parsed.version,
        docConflict: 'none',
      }

      try {
        const clash = this._findLocalClash(input)

        if (clash) {
          // 记录冲突（无论最终是否导入，都要让用户看得见）
          conflicts.push({
            packContent: item.content,
            localMemoryId: clash.memory.id,
            localContent: clash.memory.content,
            score: round2(clash.jaccard),
            semanticOpposite: clash.opposite,
            strategy,
            resolution: strategy === 'pack_first' ? 'pack_first' : 'keep_local',
          })

          if (strategy === 'pack_first') {
            // 包优先：先把本地记忆 invalidate（保留审计），再写包记忆
            this.memories.invalidate(clash.memory.id, {
              reason: `记忆包 ${parsed.name} v${parsed.version} 覆盖（strategy=pack_first）`,
            })
            const result = this.memories.create({ ...input, allowSupersede })
            if (result.duplicate) {
              skippedIds.push(item.content)
              this._recordPackConflict(clash.memory.id, `pack:${parsed.packId}`, {
                resolved: true,
                resolution: 'winner_b',
                reason: '包优先策略：包内内容与已有记忆重复，未重复写入',
              })
            } else {
              createdIds.push(result.memory.id)
              this._linkSuperseded(clash.memory.id, result.memory.id)
              this._recordPackConflict(clash.memory.id, result.memory.id, {
                resolved: true,
                resolution: 'winner_b',
                reason: `包优先策略覆盖本地记忆（${parsed.name} v${parsed.version}）`,
              })
            }
          } else {
            // 本地优先 / 待裁决：跳过包内这一条，冲突留 unresolved
            skippedIds.push(item.content)
            this._recordPackConflict(clash.memory.id, `pack:${parsed.packId}`, {
              resolved: false,
              reason:
                strategy === 'ask'
                  ? `导入包「${parsed.name}」时检测到与本地记忆冲突，已跳过该条，等待用户裁决`
                  : `本地优先策略：跳过与本地记忆冲突的包内条目（${parsed.name} v${parsed.version}）`,
            })
          }
          continue
        }

        const result = this.memories.create({ ...input, allowSupersede })
        if (result.duplicate) {
          // 完全相同：不重复写；若已有条目不是包来源，补上 pack 溯源信息
          skippedIds.push(item.content)
          const existing = result.memory
          if (existing && !existing.packId) {
            try {
              this.db
                .prepare('UPDATE memories SET pack_id = ?, pack_version = ? WHERE id = ?')
                .run(parsed.packId, parsed.version, existing.id)
            } catch {
              // 溯源补充失败不影响导入结果
            }
          }
        } else {
          createdIds.push(result.memory.id)
        }
      } catch (err) {
        errors.push({ content: item.content, message: err.message || String(err) })
      }
    }

    // installed_packs：同一 pack_id 视为同一包，重复导入更新版本而不是新增行
    const existingPack = this._packRow(parsed.packId)
    const memoryCount = this._countMemoriesOfPack(parsed.packId)
    if (existingPack) {
      this.db
        .prepare(
          `UPDATE installed_packs
              SET pack_version = ?, pack_name = ?, author = ?, updated_at = ?, scope = ?,
                  source = ?, local_path = ?, memory_count = ?, status = 'active'
            WHERE id = ?`,
        )
        .run(
          parsed.version,
          parsed.name,
          parsed.author,
          now,
          scope || existingPack.scope || 'global',
          source,
          localPath || existingPack.local_path || null,
          memoryCount,
          existingPack.id,
        )
    } else {
      this.db
        .prepare(
          `INSERT INTO installed_packs
            (id, pack_id, pack_version, pack_name, author, installed_at, updated_at, scope,
             auto_update, source, local_path, memory_count, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'active')`,
        )
        .run(
          newId('pkg'),
          parsed.packId,
          parsed.version,
          parsed.name,
          parsed.author,
          now,
          now,
          scope || 'global',
          source,
          localPath || null,
          memoryCount,
        )
    }

    // pack_update_check：每次安装/更新都落一行基线
    this._upsertUpdateCheck(parsed.packId, parsed.version, null, false, now)

    return {
      installed: true,
      created: createdIds.length,
      skipped: skippedIds.length,
      conflicts,
      errors,
      packId: parsed.packId,
      version: parsed.version,
      packName: parsed.name,
      memoryCount: this._countMemoriesOfPack(parsed.packId),
      createdIds,
    }
  }

  // ------------------------------------------------------------------ 卸载

  /**
   * 卸载记忆包。
   * deleteMemories=false（默认）：只删「未被用户改过」的包记忆，改过的保留；
   * deleteMemories=true：删掉该包导入的全部记忆。
   */
  uninstall({ packId, deleteMemories = false } = {}) {
    const key = str(packId)
    if (!key) throw new Error('缺少 packId')
    // 卸载要能找到「已卸载」的行：这样用户可以二次调用 deleteMemories 清理残余记忆
    const packRow = this._packRowAny(key)
    if (!packRow) throw new Error(`未安装该记忆包：${key}`)

    let rows = []
    try {
      rows = this.db.prepare('SELECT * FROM memories WHERE pack_id = ?').all(key)
    } catch {
      rows = []
    }

    const toRemove = []
    for (const row of rows) {
      const memory = rowToMemory(row)
      if (deleteMemories) {
        toRemove.push(memory)
        continue
      }
      // 「未被用户改过」判定：仍是 imported、没被确认过、没有文档冲突、没被冻结、没被手工编辑
      const untouched =
        memory.authority === 'imported' &&
        !memory.lastVerifiedAt &&
        !memory.userModified &&
        !memory.frozen &&
        (!memory.docConflict || memory.docConflict === 'none')
      if (untouched) toRemove.push(memory)
    }

    const removedIds = []
    for (const memory of toRemove) {
      try {
        this.memories.remove(memory.id)
        removedIds.push(memory.id)
      } catch {
        // 单条删不掉（被外部引用等）时保留，计入 kept
      }
    }

    try {
      this.db
        .prepare(`UPDATE installed_packs SET status = 'uninstalled', updated_at = ? WHERE id = ?`)
        .run(this.store.now(), packRow.id)
      if (removedIds.length > 0) {
        this.db
          .prepare(`UPDATE installed_packs SET memory_count = ? WHERE id = ?`)
          .run(this._countMemoriesOfPack(key), packRow.id)
      }
    } catch {
      // 状态更新失败不影响记忆清理结果
    }

    return {
      removedMemories: removedIds.length,
      keptMemories: Math.max(0, rows.length - removedIds.length),
      packId: key,
      removedIds,
    }
  }

  // ------------------------------------------------------------------ 导出

  /**
   * 从现有记忆导出记忆包（文档 §9.4「从现有记忆导出」）。
   * @returns {object} 符合文档 §9.1 的 JSON 对象（snake_case）
   */
  export({ memoryIds, meta = {}, profile = null } = {}) {
    const ids = Array.isArray(memoryIds) ? memoryIds.map(String).filter(Boolean) : []
    // 阶段三：允许「只带认知画像」的记忆包（不选记忆也可以导出）
    const profilePayload = normalizePackProfile(profile)
    if (ids.length === 0 && !profilePayload) throw new Error('请选择要导出的记忆，或先蒸馏出一份认知画像')
    const rows = []
    for (const id of ids) {
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
      if (row) rows.push(row)
    }
    if (ids.length > 0 && rows.length === 0) throw new Error('没有找到可导出的记忆')

    const memories = rows.map((row) => {
      const memory = rowToMemory(row)
      return {
        category: memory.category,
        layer: memory.layer,
        content: memory.content,
        structured: memory.structured || {},
        authority: 'imported', // 导出后导入到别人机器上应是 imported
        scope: memory.scope || 'global',
        tags: memory.tags || [],
      }
    })

    const name = str(meta.name) || 'Mirror 记忆包'
    const version = str(meta.version) || '1.0.0'
    const pack = {
      $schema: 'https://mirror.dev/schemas/pack/v1.json',
      pack_id: str(meta.packId) || buildPackId(name),
      name,
      version,
      format_version: '1.0',
      author: str(meta.author) || 'local',
      category: str(meta.category) || 'template',
      description:
        str(meta.description) ||
        `从本地导出的记忆包（${memories.length} 条记忆${profilePayload ? ' + 认知画像' : ''}）`,
      min_mirror_version: MIRROR_VERSION,
      memories,
      doc_references: [],
      changelog: [
        {
          version,
          date: new Date(this.store.now()).toISOString().slice(0, 10),
          changes: `导出 ${memories.length} 条记忆${profilePayload ? ' + 认知画像' : ''}`,
        },
      ],
    }
    // 阶段三：认知画像（只含提炼后的六段，不含原始对话）
    if (profilePayload) pack.profile = profilePayload
    // 自校验一遍：导出的包必须能被 parse 接受（防止写出坏包）
    this.parse(pack)
    return pack
  }

  // ------------------------------------------------------------------ 版本更新

  /** 检查已安装包是否有新版本（文档 §9.3） */
  checkUpdate({ packId, latestVersion } = {}) {
    const key = str(packId)
    if (!key) throw new Error('缺少 packId')
    const latest = str(latestVersion)
    const packRow = this._packRow(key)
    const currentVersion = packRow ? packRow.pack_version : null
    let available = false
    if (currentVersion && latest) available = compareVersion(latest, currentVersion) > 0
    this._upsertUpdateCheck(key, currentVersion, latest || null, available, this.store.now())
    return {
      available,
      packId: key,
      currentVersion,
      latestVersion: latest || null,
      installed: !!packRow,
    }
  }

  // ------------------------------------------------------------------ 内部实现

  /** 找与包内条目最像的本地记忆（同 scope + 同 category） */
  _findLocalClash(input) {
    let rows = []
    try {
      rows = this.db
        .prepare(
          `SELECT * FROM memories WHERE status = 'active' AND scope = ? AND category = ?
            ORDER BY created_at DESC LIMIT 300`,
        )
        .all(input.scope, input.category)
    } catch {
      rows = []
    }
    let best = null
    for (const row of rows) {
      const memory = rowToMemory(row)
      const jaccard = bigramJaccard(input.content, memory.content)
      const opposite = isOpposite(input.content, memory.content)
      const clash = jaccard >= 0.75 || (opposite && jaccard >= 0.45)
      if (!clash) continue
      if (!best || jaccard > best.jaccard) best = { memory, jaccard, opposite }
    }
    return best
  }

  /** 包内条目覆盖本地记忆时，把旧记忆的 superseded_by 指到新记忆 */
  _linkSuperseded(oldId, newIdValue) {
    try {
      this.db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(newIdValue, String(oldId))
    } catch {
      // 审计链补不上不影响导入
    }
  }

  _recordPackConflict(memoryA, memoryB, { resolved = false, resolution = null, reason = '' } = {}) {
    try {
      if (!resolved) {
        const existed = this.db
          .prepare(
            `SELECT id FROM conflicts WHERE resolved = 0 AND conflict_type = 'pack_updated' AND memory_a = ? AND memory_b = ?`,
          )
          .get(String(memoryA), String(memoryB))
        if (existed) return
      }
      const now = this.store.now()
      this.db
        .prepare(
          `INSERT INTO conflicts (id, memory_a, memory_b, conflict_type, detected_at, detected_by, resolved,
                                  resolution, resolution_reason, resolved_at, severity, reason)
           VALUES (?, ?, ?, 'pack_updated', ?, 'pack', ?, ?, ?, ?, 'medium', ?)`,
        )
        .run(
          newId('cfl'),
          String(memoryA),
          String(memoryB),
          now,
          resolved ? 1 : 0,
          resolution,
          reason || null,
          resolved ? now : null,
          reason || null,
        )
    } catch {
      // 冲突是审计用，写失败不阻断导入
    }
  }

  /** 同一 pack_id 的存活行（重复导入时更新版本） */
  _packRow(packId) {
    try {
      return (
        this.db
          .prepare(
            `SELECT * FROM installed_packs WHERE pack_id = ? AND status <> 'uninstalled'
              ORDER BY installed_at DESC LIMIT 1`,
          )
          .get(String(packId)) ?? null
      )
    } catch {
      return null
    }
  }

  /** 任意状态的最近一行（卸载/删残留时用） */
  _packRowAny(packId) {
    try {
      return (
        this.db
          .prepare(`SELECT * FROM installed_packs WHERE pack_id = ? ORDER BY installed_at DESC LIMIT 1`)
          .get(String(packId)) ?? null
      )
    } catch {
      return null
    }
  }

  _countMemoriesOfPack(packId) {
    try {
      const row = this.db
        .prepare(`SELECT count(*) AS c FROM memories WHERE pack_id = ? AND status = 'active'`)
        .get(String(packId))
      return Number(row?.c) || 0
    } catch {
      return 0
    }
  }

  _upsertUpdateCheck(packId, currentVersion, latestVersion, available, now) {
    try {
      const existed = this.db
        .prepare('SELECT id FROM pack_update_check WHERE pack_id = ? ORDER BY checked_at DESC LIMIT 1')
        .get(String(packId))
      if (existed) {
        this.db
          .prepare(
            `UPDATE pack_update_check
                SET current_version = ?, latest_version = ?, checked_at = ?, available = ?
              WHERE id = ?`,
          )
          .run(currentVersion || '', latestVersion, now, available ? 1 : 0, existed.id)
      } else {
        this.db
          .prepare(
            `INSERT INTO pack_update_check (id, pack_id, current_version, latest_version, checked_at, available)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(newId('puc'), String(packId), currentVersion || '', latestVersion, now, available ? 1 : 0)
      }
    } catch {
      // 更新检查表失败不影响安装
    }
  }
}

// -------------------------------------------------------------------- 工具

/**
 * Pack（camelCase）→ 符合文档 §9.1 的 .mirrorpack JSON（snake_case）。
 * 用于写文件，保证两种表示不漂移。
 */
export function toPackFile(pack) {
  const p = pack || {}
  const out = {
    $schema: p.schema || 'https://mirror.dev/schemas/pack/v1.json',
    pack_id: p.packId,
    name: p.name,
    version: p.version,
    format_version: p.formatVersion || '1.0',
    author: p.author || 'unknown',
    category: p.category || 'template',
    description: p.description || '',
    min_mirror_version: p.minMirrorVersion || '0.0.0',
    memories: (p.memories || []).map((m) => ({
      category: m.category,
      layer: m.layer || 'strategy',
      content: m.content,
      structured: m.structured || {},
      authority: m.authority || 'imported',
      scope: m.scope || 'global',
      tags: Array.isArray(m.tags) ? m.tags : [],
    })),
    doc_references: (p.docReferences || []).map((d) => ({ path: d.path, description: d.description })),
    changelog: (p.changelog || []).map((c) => ({ version: c.version, date: c.date, changes: c.changes })),
  }
  return out
}

/** 语义化版本比较：a>b 返回正数，a<b 返回负数，相等 0 */
export function compareVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 把 profile 收敛成包里允许出现的六段（去掉 undefined/空值，限制长度）。 */
export function normalizePackProfile(profile) {
  if (!profile || typeof profile !== 'object') return null
  const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  const list = (value, limit) =>
    (Array.isArray(value) ? value : [])
      .map((item) => text(item, 300))
      .filter(Boolean)
      .slice(0, limit)
  const normalized = {
    profile: text(profile.profile, 300),
    confidence: Math.min(1, Math.max(0, Number(profile.confidence) || 0.6)),
    preferences: list(profile.preferences, 20),
    rules: list(profile.rules, 20),
    patterns: list(profile.patterns, 20),
    skills: list(profile.skills, 20),
    avoid: list(profile.avoid, 20),
    // 阶段三补充：经验条目（情境 → 判断 → 做法 → 理由 → 边界）
    experiences: (Array.isArray(profile.experiences) ? profile.experiences : [])
      .map((item) => ({
        trigger: text(item?.trigger, 200),
        action: text(item?.action, 400),
        why: text(item?.why, 300),
        boundary: text(item?.boundary, 300),
        evidence: text(item?.evidence, 300),
        since: text(item?.since, 40),
        confidence: Math.min(1, Math.max(0, Number(item?.confidence) || 0.6)),
      }))
      .filter((item) => item.trigger && item.action)
      .slice(0, 30),
  }
  const size =
    normalized.preferences.length +
    normalized.rules.length +
    normalized.patterns.length +
    normalized.skills.length +
    normalized.avoid.length +
    normalized.experiences.length
  if (!normalized.profile && size === 0) return null
  return normalized
}
/** 从包名生成稳定 pack_id（中文名走哈希，保证 ASCII 且可重复） */
export function buildPackId(name) {
  const ascii = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (ascii.length >= 3) return `pack_${ascii.slice(0, 60)}`
  const hash = crypto.createHash('sha1').update(String(name || '')).digest('hex').slice(0, 10)
  return `pack_${hash}`
}

function parseJsonText(text) {
  let body = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (!body) throw new Error('记忆包内容为空')
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  if (fence) body = fence[1].trim()
  try {
    return JSON.parse(body)
  } catch (err) {
    throw new Error(`记忆包不是合法 JSON：${err.message}`)
  }
}

function str(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function clamp01(n, fallback) {
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

function round2(n) {
  return Math.round(n * 100) / 100
}
