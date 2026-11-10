/**
 * core/extract.js —— 记忆抽取
 *
 * 对应《Mirror 开发文档 v2.0》§4.1：EXTRACT_PROMPT + 输出解析 + 启发式兜底。
 *
 * 关键设计决策：
 *   - 内核不做 LLM 调用（零依赖 + 不带网络），只负责「给 prompt、收文本、解析、校验」。
 *     真正的模型调用在宿主适配器层（DSH hooks）。
 *   - parseExtraction 容忍三种常见脏输出：```json 围栏、前后多余文字、
 *     被 ``` 包住但带语言名的围栏；解析失败返回 parseError 而不是抛错。
 *   - heuristicExtract 是「无 LLM 时」的第二条写入通路，也是 mirror_remember
 *     之外的兜底；规则刻意保守（宁少勿滥），单句 <= 200 字，最多 8 条。
 */

import { normalizeText } from './arbiter.js'

/**
 * 抽取 prompt（文档 §4.1 原文，占位符为 {existing_memories} / {conversation}）。
 * 注意：这里用单花括号，fillPrompt 只做纯文本占位替换（不走格式化），
 * 所以 JSON 示例里的花括号不需要转义。
 */
export const EXTRACT_PROMPT = `你是 Mirror 记忆抽取器。从对话中提取用户的"判断依据"。

## 类别
1. iron_rule（铁律）：永远适用的硬性约束。权威最高。
2. preference（偏好）：大概率适用的风格/习惯。
3. decision（决策）：特定场景下的选择及原因。必须含 reason。
4. pitfall（踩坑）：犯过的错误及教训。结构：symptom → cause → fix。
5. fuzzy（模糊）：推测但未确认。confidence < 0.7。

## 层级
- fragment（片段）：单次观察、易变。自动衰减，不进长期注入。
- strategy（策略）：反复出现的模式。写前需高置信度。
- fact（事实）：架构决策、API 契约。版本化管理，改了留 changelog。

## 规则
- 不提取路径、账号、版本号等事实——这些由文档库承载。
- 不提取闲聊。
- 无值得记的内容返回空数组。
- 检查与已有记忆的冲突。

## 已有记忆（去重/冲突用）
{existing_memories}

## 对话内容
{conversation}

## 输出（严格 JSON）
{
  "extractions": [{"category": "...", "layer": "...", "content": "...",
                    "structured": {}, "confidence": 0.0-1.0,
                    "authority": "inferred", "scope": "global|project:xxx",
                    "reasoning": "...", "causal_link": "..."}],
  "conflicts": [{"new_content": "...", "conflicting_memory_id": "...",
                  "conflict_type": "...", "severity": "high|medium|low"}],
  "supersedes": ["memory_id_1"]
}`

const MAX_CONVERSATION_CHARS = 30000

/**
 * 填充 prompt 占位符。
 * 注意用函数式 replace：记忆内容里出现 "$&" 之类不会被当成替换模式。
 * @param {string} prompt
 * @param {{existingMemories?: object[]|string, conversation?: string}} input
 */
export function fillPrompt(prompt, { existingMemories, conversation } = {}) {
  const memoryText = formatExistingMemories(existingMemories)
  const conversationText = String(conversation ?? '').slice(0, MAX_CONVERSATION_CHARS)
  return String(prompt ?? '')
    .replace(/\{existing_memories\}/g, () => memoryText)
    .replace(/\{conversation\}/g, () => conversationText)
}

/** 已有记忆 → prompt 里的列表文本 */
export function formatExistingMemories(existingMemories) {
  if (!existingMemories) return '（无）'
  if (typeof existingMemories === 'string') return existingMemories.trim() || '（无）'
  if (!Array.isArray(existingMemories)) return '（无）'
  if (existingMemories.length === 0) return '（无）'
  return existingMemories
    .map((item, index) => {
      if (typeof item === 'string') return `${index + 1}. ${item}`
      const category = item?.category || 'fuzzy'
      const id = item?.id ? `${item.id} ` : ''
      return `${index + 1}. [${category}] ${id}${item?.content ?? ''}`
    })
    .join('\n')
}

/**
 * 解析 LLM 输出。
 * 容忍 ```json 围栏与前后多余文字；解析失败返回 parseError，绝不上抛。
 * @returns {{extractions: object[], conflicts: object[], supersedes: string[], parseError?: string}}
 */
export function parseExtraction(text) {
  const empty = (parseError) => ({ extractions: [], conflicts: [], supersedes: [], parseError })

  if (typeof text !== 'string' || !text.trim()) return empty('抽取结果为空')

  let body = text.replace(/^\uFEFF/, '').trim()

  // ```json ... ``` / ``` ... ```
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(body)
  if (fence) body = fence[1].trim()

  let parsed = null
  let lastError = ''
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    lastError = err.message
    // 去掉围栏后仍失败：截取第一个 { 到最后一个 }，容忍前后解释性文字
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(body.slice(start, end + 1))
        lastError = ''
      } catch (err2) {
        lastError = err2.message
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty(`抽取结果不是合法 JSON：${lastError || '无法解析'}`)
  }

  const extractions = normalizeExtractions(parsed.extractions)
  const conflicts = normalizeConflicts(parsed.conflicts)
  const supersedes = normalizeSupersedes(parsed.supersedes)
  return { extractions, conflicts, supersedes }
}

function normalizeExtractions(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const content = String(item.content ?? '').trim()
    if (!content) continue
    const confidence = Number(item.confidence)
    out.push({
      category: String(item.category ?? 'fuzzy'),
      layer: String(item.layer ?? 'strategy'),
      content,
      structured: item.structured && typeof item.structured === 'object' ? item.structured : {},
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
      authority: String(item.authority ?? 'inferred'),
      scope: String(item.scope ?? 'global'),
      reasoning: String(item.reasoning ?? ''),
      causal_link: String(item.causal_link ?? item.causalLink ?? ''),
    })
  }
  return out
}

function normalizeConflicts(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      new_content: String(item.new_content ?? item.newContent ?? ''),
      conflicting_memory_id: String(item.conflicting_memory_id ?? item.conflictingMemoryId ?? ''),
      conflict_type: String(item.conflict_type ?? item.conflictType ?? 'contradiction'),
      severity: String(item.severity ?? 'medium'),
    }))
}

function normalizeSupersedes(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  if (typeof value === 'string') return [value]
  return []
}

// -------------------------------------------------------------------- 启发式抽取

/** 分类规则（按优先级：铁律 > 偏好 > 决策 > 踩坑） */
const HEURISTIC_RULES = [
  {
    category: 'iron_rule',
    layer: 'strategy',
    confidence: 0.85,
    re: /(必须|禁止|不要|永远|一律|铁律|绝不|绝不能|不得|务必|严格|must|never|always|don't\s)/i,
    reason: '命中铁律关键词',
  },
  {
    category: 'preference',
    layer: 'strategy',
    confidence: 0.8,
    re: /(我偏好|我喜欢|我倾向|以后都|习惯|我一般|我通常|prefer)/i,
    reason: '命中偏好关键词',
  },
  {
    category: 'decision',
    layer: 'strategy',
    confidence: 0.8,
    re: /(决定|选用|选择|采用|改成|换成|方案)/,
    need: /(因为|原因|所以|考虑到|由于|理由)/,
    reason: '命中决策关键词且给出了原因',
  },
  {
    category: 'pitfall',
    layer: 'fragment',
    confidence: 0.8,
    re: /(踩坑|报错|避开|教训|翻车|坑|失败|bug|崩溃)/i,
    reason: '命中踩坑关键词',
  },
]

const MAX_HEURISTIC_ITEMS = 8
const MAX_SENTENCE_CHARS = 200

/**
 * 无 LLM 时的启发式抽取。
 * @param {string} conversation
 * @returns {{extractions: object[], conflicts: object[], supersedes: string[]}}
 */
export function heuristicExtract(conversation) {
  const text = String(conversation ?? '')
  if (!text.trim()) return { extractions: [], conflicts: [], supersedes: [] }

  // 按中文句号/问号/感叹号/分号/换行切句；英文句号单独处理（避免切坏 1.2.0 这类版本号）
  const sentences = text
    .split(/[\n。！？!?；;]+|(?<=[a-zA-Z\u4e00-\u9fff])\.(?=\s|$)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  const extractions = []
  const seen = new Set()

  for (const raw of sentences) {
    const sentence = raw.length > MAX_SENTENCE_CHARS ? raw.slice(0, MAX_SENTENCE_CHARS) : raw
    const rule = HEURISTIC_RULES.find((item) => item.re.test(sentence) && (!item.need || item.need.test(sentence)))
    if (!rule) continue

    const normalized = normalizeText(sentence)
    if (!normalized || seen.has(normalized)) continue
    // 太短的句子（比如只剩「必须」）没有记忆价值
    if (normalized.length < 4) continue
    seen.add(normalized)

    const extraction = {
      category: rule.category,
      layer: rule.layer,
      content: sentence,
      structured: {},
      confidence: rule.confidence,
      authority: 'inferred',
      scope: 'global',
      reasoning: `启发式规则：${rule.reason}`,
      causal_link: '',
    }

    if (rule.category === 'decision') {
      const reasonMatch = /(因为|由于|考虑到|原因[是为]?|理由[是为]?)(.*)$/.exec(sentence)
      if (reasonMatch) extraction.structured = { reason: reasonMatch[2].trim() }
    }
    if (rule.category === 'pitfall') {
      // 踩坑的结构化目标：symptom → cause → fix；启发式只保证 symptom 有值
      extraction.structured = { symptom: sentence }
    }
    if (rule.category === 'iron_rule') {
      extraction.structured = { constraint: sentence }
    }

    extractions.push(extraction)
    if (extractions.length >= MAX_HEURISTIC_ITEMS) break
  }

  return { extractions, conflicts: [], supersedes: [] }
}
