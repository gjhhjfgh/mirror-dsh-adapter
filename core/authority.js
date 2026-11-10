/**
 * core/authority.js —— 权威裁决：同一条主张同时出现在「记忆」和「文档」里时，谁说了算
 *
 * 为什么需要：注入时记忆和文档是分开两层的，如果两边对同一件事给出相反结论
 * （记忆："接口必须走 WebSocket" / 文档："接口禁止走 WebSocket"），模型会看到自相矛盾的内容。
 * 这里在注入前做一次裁决：保留权威更高的一侧，另一侧从本轮注入里隐藏（不删数据），
 * 并在注入文本里说明"已按裁决隐藏 N 条冲突"。
 *
 * 规则（默认 user_first）：
 *   - 用户显式/确认过的记忆（user_explicit / user_confirmed）永远赢文档；
 *   - 其余（AI 推断 / 记忆包导入 / 模糊）输给文档——文档是经过整理的、可追溯的事实；
 *   - 可配置 doc_first / memory_first 覆盖默认。
 */

import { bigramJaccard, isOpposite } from './arbiter.js'

export const AUTHORITY_MODES = ['user_first', 'doc_first', 'memory_first']

export const MEMORY_RANK = {
  user_explicit: 5,
  user_confirmed: 4,
  imported: 2,
  inferred: 1,
}

/** 文档的权威分：经过人工/官方整理的资料，高于 AI 推断，低于用户显式记忆 */
export const DOC_RANK = 3

export function normalizeMode(mode) {
  const value = String(mode ?? '').trim()
  return AUTHORITY_MODES.includes(value) ? value : 'user_first'
}

export function memoryRankOf(memory) {
  const authority = String(memory?.authority ?? 'inferred')
  return MEMORY_RANK[authority] ?? MEMORY_RANK.inferred
}

/**
 * 单条记忆 vs 单篇文档的裁决。
 * @returns {{winner: 'memory'|'document', reason: string, memoryRank: number, docRank: number}}
 */
export function resolveAuthority({ memory, mode = 'user_first' } = {}) {
  const normalized = normalizeMode(mode)
  const memoryRank = memoryRankOf(memory)
  const docRank = DOC_RANK
  if (normalized === 'memory_first') {
    return { winner: 'memory', reason: '配置为 memory_first：记忆优先', memoryRank, docRank }
  }
  if (normalized === 'doc_first') {
    return { winner: 'document', reason: '配置为 doc_first：文档优先', memoryRank, docRank }
  }
  if (memoryRank > docRank) {
    return {
      winner: 'memory',
      reason: `用户${String(memory?.authority) === 'user_confirmed' ? '确认' : '显式'}的记忆优先于文档`,
      memoryRank,
      docRank,
    }
  }
  return { winner: 'document', reason: '推断/导入内容的权威低于文档', memoryRank, docRank }
}

/** 两段文本是否在讲同一件事（用共享二元组近似判断主题重叠）。 */
function sameTopic(a, b) {
  return bigramJaccard(String(a ?? ''), String(b ?? '')) >= 0.25
}

/**
 * 在注入结果上做权威裁决：同一主张相反时，隐藏权威低的一侧。
 * 直接修改传入的 result（各层数组 + documents），返回冲突明细。
 *
 * @param {{result: object, mode?: string}} input
 * @returns {{conflicts: object[], hiddenMemories: number, hiddenDocs: number}}
 */
export function applyAuthority({ result, mode = 'user_first' } = {}) {
  const normalized = normalizeMode(mode)
  const conflicts = []
  if (!result) return { conflicts, hiddenMemories: 0, hiddenDocs: 0 }

  const memoryKeys = ['ironRules', 'preferences', 'decisions', 'pitfalls', 'fuzzy']
  const docHits = Array.isArray(result.documents) ? result.documents : []
  if (docHits.length === 0) return { conflicts, hiddenMemories: 0, hiddenDocs: 0 }

  const hiddenMemoryIds = new Set()
  const hiddenDocKeys = new Set()

  for (const key of memoryKeys) {
    const list = Array.isArray(result[key]) ? result[key] : []
    for (const memory of list) {
      if (!memory || hiddenMemoryIds.has(memory.id)) continue
      const memoryText = String(memory.content ?? '')
      for (const hit of docHits) {
        const chunkText = String(hit?.chunk?.content ?? '')
        if (!chunkText || !isOpposite(memoryText, chunkText)) continue
        if (!sameTopic(memoryText, chunkText)) continue
        const decision = resolveAuthority({ memory, mode: normalized })
        const docKey = `${hit?.document?.id ?? ''}#${hit?.chunk?.id ?? ''}`
        conflicts.push({
          memoryId: memory.id,
          memoryText,
          docKey,
          docPath: hit?.document?.relativePath || hit?.document?.filePath || '',
          winner: decision.winner,
          reason: decision.reason,
        })
        if (decision.winner === 'document') hiddenMemoryIds.add(memory.id)
        else hiddenDocKeys.add(docKey)
      }
    }
  }

  if (hiddenMemoryIds.size === 0 && hiddenDocKeys.size === 0) {
    return { conflicts, hiddenMemories: 0, hiddenDocs: 0 }
  }

  for (const key of memoryKeys) {
    if (!Array.isArray(result[key])) continue
    result[key] = result[key].filter((memory) => !hiddenMemoryIds.has(memory?.id))
  }
  if (hiddenDocKeys.size > 0) {
    result.documents = docHits.filter((hit) => !hiddenDocKeys.has(`${hit?.document?.id ?? ''}#${hit?.chunk?.id ?? ''}`))
  }
  result.authorityMode = normalized
  result.authorityConflicts = conflicts
  return { conflicts, hiddenMemories: hiddenMemoryIds.size, hiddenDocs: hiddenDocKeys.size }
}
