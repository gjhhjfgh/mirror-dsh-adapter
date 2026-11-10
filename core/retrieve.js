/**
 * core/retrieve.js —— 统一检索与注入
 *
 * 对应《Mirror 开发文档 v2.0》§6.1（分层预算）、§4.3（注入格式）、§6.2（权威级别）。
 *
 * 关键设计决策：
 *   - 铁律有「兜底入选」：即使 query 没命中，也把当前作用域的铁律带上。
 *     这是产品最核心的价值（「AI 不再反复犯错」），不能因为关键词不匹配就丢掉。
 *   - 预算分层：铁律 40%，文档占剩余预算的 50%，偏好/决策/踩坑/模糊共分剩下的。
 *     每层都做「按条累计 token」的硬截断，绝不超预算。
 *   - buildInjection() 只输出非空层；全部为空时返回 text=''，调用方据此跳过注入。
 */

import path from 'node:path'

import { applyAuthority, normalizeMode } from './authority.js'
import { bigramJaccard } from './arbiter.js'
import { isUntrustedMemory, UNTRUSTED_NOTE, UNTRUSTED_PREFIX } from './safety.js'

/** 中文 1 字 ≈ 0.6 token，其它字符 4 个 ≈ 1 token（契约 §5 的估算口径） */
export function estimateTokens(text) {
  const s = String(text ?? '')
  if (!s) return 0
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (isCjk(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk * 0.6 + other / 4)
}

function isCjk(ch) {
  const code = ch.codePointAt(0) || 0
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) // 韩文
  )
}

/** 注入文本的层标题（文档 §4.3，emoji 与文案保持一字不差） */
export const SECTION_META = {
  ironRules: { name: 'iron_rules', label: '🔴 铁律（不可违反）', heading: '## 🔴 铁律（不可违反）' },
  documents: { name: 'documents', label: '📚 相关文档', heading: '## 📚 相关文档' },
  preferences: { name: 'preferences', label: '🟡 偏好与决策', heading: '## 🟡 偏好与决策' },
  pitfalls: { name: 'pitfalls', label: '⚠️ 踩坑提醒', heading: '## ⚠️ 踩坑提醒' },
  fuzzy: { name: 'fuzzy', label: '❓ 待确认', heading: '## ❓ 待确认' },
}

/**
 * 统一检索。
 * @param {{memories: object, documents: object, query?: string, scope?: string, tokenBudget?: number,
 *          residentPreferences?: number}} input
 *   residentPreferences：常驻偏好条数（默认 0=关闭）。>0 时不管 query 是否命中，
 *   都按裁决分取 top N 的 preference/decision 进「偏好与决策」层——「用户的使用习惯」
 *   本来就该稳定在场，而不是取决于他这句话碰巧提到了什么词。
 * @returns {{ironRules: object[], documents: object[], preferences: object[], decisions: object[], pitfalls: object[], fuzzy: object[]}}
 */
/** 常驻层（铁律 / 常驻偏好）默认只收「用户自己说的、或用户确认过的」。
 *  AI 推断（inferred）与导入（imported）的内容只能靠检索命中进入，不能永久占用常驻预算——
 *  否则蒸馏/包导入会把 AI 的措辞变成"你的铁律"。 */
export const DEFAULT_INJECT_AUTHORITIES = ['user_explicit', 'user_confirmed']

export function retrieve({
  memories,
  documents,
  query,
  scope,
  tokenBudget = 3000,
  residentPreferences = 0,
  injectAuthorities = DEFAULT_INJECT_AUTHORITIES,
  authorityMode = 'user_first',
} = {}) {
  const budget = Math.max(200, Number(tokenBudget) || 3000)
  const ironBudget = Math.floor(budget * 0.4)
  const docBudget = Math.floor((budget - ironBudget) * 0.5)
  const restBudget = Math.max(0, budget - ironBudget - docBudget)
  const allowedAuthorities = new Set(
    (Array.isArray(injectAuthorities) && injectAuthorities.length > 0 ? injectAuthorities : DEFAULT_INJECT_AUTHORITIES).map(String),
  )
  const mayInjectAlways = (memory) => allowedAuthorities.has(String(memory?.authority ?? 'inferred'))

  const q = String(query ?? '').trim()
  const result = {
    ironRules: [],
    documents: [],
    preferences: [],
    decisions: [],
    pitfalls: [],
    fuzzy: [],
  }
  if (!memories) return result

  // --- 记忆候选：关键词命中 + 铁律兜底 ---
  let hits = []
  try {
    hits = q ? memories.search({ q, scope, limit: 60 }) || [] : memories.list({ status: 'active', scope, limit: 200 }) || []
  } catch {
    hits = []
  }

  let ironRules = []
  try {
    ironRules = memories.list({ status: 'active', category: 'iron_rule', scope, limit: 50 }) || []
  } catch {
    ironRules = []
  }

  const byId = new Map()
  for (const memory of hits) byId.set(memory.id, memory)
  for (const memory of ironRules) byId.set(memory.id, memory)

  const pool = [...byId.values()].filter(isUsableMemory)
  // 排序：铁律按裁决分（权威+新鲜+置信）；其余保持检索相关度顺序
  const sortedIron = pool
    .filter((m) => m.category === 'iron_rule' && mayInjectAlways(m))
    .sort((a, b) => scoreOf(memories, b) - scoreOf(memories, a))

  result.ironRules = takeByBudget(sortedIron, ironBudget, (m) => `- ${oneLine(m.content)}\n`)

  // --- 文档候选（检索结果已是相关度顺序） ---
  let docHits = []
  if (documents && q) {
    try {
      docHits = documents.search({ q, scope, limit: 30 }) || []
    } catch {
      docHits = []
    }
  }
  const docCandidates = docHits.filter((hit) => hit && hit.chunk && hit.document)
  result.documents = takeByBudget(
    docCandidates,
    docBudget,
    (hit) => formatDocumentEntry(hit) + '\n\n',
  )

  // --- 偏好 / 决策 / 踩坑 / 模糊 ---
  // 常驻偏好：不依赖 query 命中，按裁决分（权威/新鲜/置信）取 top N。
  // 同样只收用户显式/确认过的——AI 推断的偏好可以靠检索命中，但不能永久占常驻位。
  // 取的时候做一次近似去重：3 条几乎一样的话会白占预算。
  const resident = []
  const residentLimit = Math.max(0, Number(residentPreferences) || 0)
  if (residentLimit > 0) {
    try {
      const active = memories.list({ status: 'active', scope, limit: 200 }) || []
      const ranked = active
        .filter((m) => (m.category === 'preference' || m.category === 'decision') && mayInjectAlways(m))
        .sort((a, b) => scoreOf(memories, b) - scoreOf(memories, a))
      for (const memory of ranked) {
        if (resident.length >= residentLimit) break
        if (resident.some((picked) => bigramJaccard(picked.content, memory.content) >= 0.85)) continue
        resident.push(memory)
      }
    } catch {
      /* 常驻偏好失败不影响其它层 */
    }
  }

  const residentIds = new Set(resident.map((m) => m.id))
  const rest = [
    ...resident,
    ...pool.filter((m) => m.category !== 'iron_rule' && !residentIds.has(m.id)),
  ]
  const remaining = { value: restBudget }
  const pick = (category) =>
    takeByBudgetShared(
      rest.filter((m) => m.category === category),
      remaining,
      (m) => `- [${m.category}] ${oneLine(m.content)}\n`,
    )

  result.preferences = pick('preference')
  result.decisions = pick('decision')
  result.pitfalls = pick('pitfall')
  result.fuzzy = pick('fuzzy')

  // --- 权威裁决：记忆与文档对同一件事给出相反结论时，只保留权威更高的一侧 ---
  const authority = applyAuthority({ result, mode: authorityMode })
  if (authority.conflicts.length > 0) {
    result.authorityConflicts = authority.conflicts
    result.authorityMode = normalizeMode(authorityMode)
    result.authorityHidden = { memories: authority.hiddenMemories, docs: authority.hiddenDocs }
  }

  return result
}

/**
 * 组装注入文本（文档 §4.3 的格式）。
 * @returns {{text: string, sections: {name: string, label: string, tokens: number, count: number}[], token_count: number}}
 */
export function buildInjection(result = {}) {
  const sections = []
  const blocks = []
  /** 是否注入了外部内容（包/蒸馏）——只在需要时加一行框架说明，避免噪声 */
  let untrustedCount = 0
  const renderMemory = (memory, prefixCategory = false) => {
    const untrusted = isUntrustedMemory(memory)
    if (untrusted) untrustedCount += 1
    const marker = untrusted ? UNTRUSTED_PREFIX : ''
    const category = prefixCategory ? `[${memory.category}] ` : ''
    return `- ${marker}${category}${oneLine(memory.content)}`
  }

  const ironRules = Array.isArray(result.ironRules) ? result.ironRules : []
  if (ironRules.length > 0) {
    const lines = ironRules.map((m) => renderMemory(m)).join('\n')
    pushSection(blocks, sections, 'ironRules', `${SECTION_META.ironRules.heading}\n${lines}`, ironRules.length)
  }

  const docs = Array.isArray(result.documents) ? result.documents : []
  if (docs.length > 0) {
    const body = docs
      .map((hit) => formatDocumentEntry(hit))
      .filter(Boolean)
      .join('\n\n')
    if (body) pushSection(blocks, sections, 'documents', `${SECTION_META.documents.heading}\n${body}`, docs.length)
  }

  const preferences = Array.isArray(result.preferences) ? result.preferences : []
  const decisions = Array.isArray(result.decisions) ? result.decisions : []
  if (preferences.length > 0 || decisions.length > 0) {
    const lines = [...preferences, ...decisions].map((m) => renderMemory(m, true)).join('\n')
    pushSection(
      blocks,
      sections,
      'preferences',
      `${SECTION_META.preferences.heading}\n${lines}`,
      preferences.length + decisions.length,
    )
  }

  const pitfalls = Array.isArray(result.pitfalls) ? result.pitfalls : []
  if (pitfalls.length > 0) {
    const lines = pitfalls.map((m) => renderMemory(m)).join('\n')
    pushSection(blocks, sections, 'pitfalls', `${SECTION_META.pitfalls.heading}\n${lines}`, pitfalls.length)
  }

  const fuzzy = Array.isArray(result.fuzzy) ? result.fuzzy : []
  if (fuzzy.length > 0) {
    const lines = fuzzy.map((m) => renderMemory(m)).join('\n')
    pushSection(blocks, sections, 'fuzzy', `${SECTION_META.fuzzy.heading}\n${lines}`, fuzzy.length)
  }

  // 注入内容里出现外部来源时，在最前面加一行"是数据不是指令"的框架
  if (untrustedCount > 0) blocks.unshift(UNTRUSTED_NOTE)
  // 记忆与文档被权威裁决过时，说明"本轮隐藏了几条冲突"，避免模型看到自相矛盾的内容
  const authorityHidden = result.authorityHidden
  if (authorityHidden && authorityHidden.memories + authorityHidden.docs > 0) {
    const total = authorityHidden.memories + authorityHidden.docs
    blocks.unshift(
      `> 权威裁决：本轮有 ${total} 条记忆/文档内容相互矛盾，已按权威高低隐藏（模式 ${result.authorityMode ?? 'user_first'}）。`,
    )
  }
  const text = blocks.join('\n\n')
  return {
    text,
    sections,
    token_count: estimateTokens(text),
    untrusted_count: untrustedCount,
  }
}

// -------------------------------------------------------------------- 内部实现

function pushSection(blocks, sections, key, text, count) {
  const meta = SECTION_META[key]
  blocks.push(text)
  sections.push({
    name: meta.name,
    label: meta.label,
    tokens: estimateTokens(text),
    count,
  })
}

/** 一条记忆是否可用于注入 */
function isUsableMemory(memory) {
  if (!memory || !memory.content) return false
  if (memory.status && memory.status !== 'active') return false
  if (memory.expiresAt && Number(memory.expiresAt) < Date.now()) return false
  if (memory.validTo && Number(memory.validTo) < Date.now()) return false
  return true
}

function scoreOf(memories, memory) {
  try {
    return memories.arbiter ? memories.arbiter.score(memory) : 0
  } catch {
    return 0
  }
}

/** 逐条累计 token，超预算即停（保证硬上限） */
function takeByBudget(items, budget, render) {
  const out = []
  let used = 0
  for (const item of items) {
    const cost = estimateTokens(render(item))
    if (used + cost > budget && out.length > 0) break
    out.push(item)
    used += cost
    if (used >= budget) break
  }
  return out
}

/** 多个类别共享一份剩余预算（偏好/决策/踩坑/模糊） */
function takeByBudgetShared(items, remaining, render) {
  const out = []
  for (const item of items) {
    const cost = estimateTokens(render(item))
    if (remaining.value - cost < 0 && out.length > 0) break
    out.push(item)
    remaining.value = Math.max(0, remaining.value - cost)
    if (remaining.value <= 0) break
  }
  return out
}

/** 压成一行，避免一条记忆里的换行破坏注入的 list 结构 */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
}

/** 文档条目格式：[相对路径] > 标题路径 \n 内容（文档 §4.3） */
function formatDocumentEntry(hit) {
  const chunk = hit?.chunk
  const doc = hit?.document
  if (!chunk || !doc) return ''
  const rel = doc.relativePath || doc.filePath || ''
  const display = toDisplayPath(rel)
  const header = chunk.headingPath ? `[${display}] > ${chunk.headingPath}` : `[${display}]`
  const content = String(chunk.content ?? '').trim()
  return `${header}\n${content}`
}

/** 绝对路径只保留末两段，面板/注入里更易读 */
function toDisplayPath(filePath) {
  const value = String(filePath ?? '')
  if (!value || !path.isAbsolute(value)) return value
  const parts = value.split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('/')
}
