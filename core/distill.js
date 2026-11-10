/**
 * core/distill.js —— 会话蒸馏：把对话提炼成结构化「记忆包 profile」
 *
 * 用户要求：2) 聊完之后用 AI 把聊天记录蒸馏成结构化记忆包——偏好、习惯、做事方式。
 *
 * 这里不绑定任何模型 SDK：
 *   - buildDistillPrompt()：把捕获的对话拼成给模型看的 prompt（与文档 §4.1 的抽取思路一致，但输出是 profile）；
 *   - parseDistillation()：容忍 ```json 包裹/多余文字的解析；
 *   - heuristicDistillation()：没有模型时的离线兜底（按关键词/句式抽，质量有限但可用）；
 *   - normalizeProfile()：把模型输出收敛成固定六段（profile/preferences/rules/patterns/skills/avoid）；
 *   - profileToMemories()：把 profile 映射成记忆（偏好/铁律/踩坑…）以便立刻参与注入。
 *
 * 隐私边界：记忆包里只放 profile，**不包含原始对话**。
 */

export const DISTILL_PROMPT = `你是 Mirror 的记忆蒸馏器。把下面的对话提炼成一份「这个人的认知画像」，供其他人的 AI 加载后按他的方式工作。

## 只提炼判断依据，不要提炼事实
不要收录路径、账号、版本号、一次性任务细节——这些由文档库承载。

## 输出（严格 JSON，不要多余文字）
{
  "profile": "一两句话：这个人是谁、做什么、什么风格",
  "preferences": ["大概率适用的风格/习惯，例如：注释只写为什么"],
  "rules": ["永远适用的硬性约束，例如：接口必须走 WebSocket"],
  "patterns": ["反复出现的做事模式，例如：先写测试再实现"],
  "skills": ["对方擅长的技能/方法论，例如：SQLite 调优、Godot 2D 动画"],
  "avoid": ["明确说不要的，例如：不要用 any"],
  "experiences": [
    {
      "trigger": "什么情境下触发（任务类型/出错信号），例如：让 AI 改一个跨 3 个文件的 bug",
      "action": "这个人会怎么做（可执行的步骤），例如：先让 AI 复述现状，再单文件改，每个文件跑一次测试",
      "why": "为什么这样做（否则这条经验没价值）",
      "boundary": "什么情况下不适用",
      "evidence": "来自哪些对话/案例（会话 id 或现象），可省略",
      "confidence": 0.0-1.0
    }
  ],
  "confidence": 0.0-1.0
}

## experiences 的要求（最重要）
- 每条必须是「情境 → 判断 → 做法 → 理由」的完整决策，不是一句口号；
- 优先提炼**负经验**（什么情况下 AI 不可靠、什么绝不能让 AI 做）；
- 没有明确边界的经验宁可写 boundary 为空也不要编；证据不确定就降低 confidence。

要求：每条一句话、可执行、不要「用户喜欢好代码」这种废话；拿不准的宁可少写。

## 对话
{conversations}`

/** 把采集到的会话拼成 prompt。 */
export function buildDistillPrompt(conversations) {
  const body = (conversations || [])
    .map((item) => `### 会话 ${item.sessionId}（${item.turns} 轮）\n${item.text}`)
    .join('\n\n---\n\n')
  return DISTILL_PROMPT.replace('{conversations}', body)
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏与前后废话）。 */
export function parseDistillation(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, error: '空输出' }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: '找不到 JSON 对象' }
  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const LIST_KEYS = ['preferences', 'rules', 'patterns', 'skills', 'avoid']

/** 收敛成固定六段：数组去重去空、profile 压成一句话、confidence 夹到 0..1。 */
export function normalizeProfile(input = {}) {
  const profile = {
    profile: String(input.profile ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    confidence: clamp01(input.confidence),
  }
  for (const key of LIST_KEYS) {
    const list = Array.isArray(input[key]) ? input[key] : []
    const seen = new Set()
    profile[key] = []
    for (const item of list) {
      const text = String(item ?? '').replace(/\s+/g, ' ').trim()
      if (!text || text.length < 4) continue
      const dedupeKey = text.toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      profile[key].push(text.slice(0, 300))
      if (profile[key].length >= 20) break
    }
  }
  // 经验条目：{trigger, action, why, boundary, evidence, confidence, since}
  const experiences = Array.isArray(input.experiences) ? input.experiences : []
  profile.experiences = []
  const seenExperience = new Set()
  for (const item of experiences) {
    if (!item || typeof item !== 'object') continue
    const experience = {
      trigger: text(item.trigger, 200),
      action: text(item.action, 400),
      why: text(item.why, 300),
      boundary: text(item.boundary, 300),
      evidence: text(item.evidence, 300),
      since: text(item.since, 40),
      confidence: clamp01(item.confidence),
    }
    // trigger + action 是硬要求：没有情境或没有做法，这条经验无法执行
    if (!experience.trigger || !experience.action) continue
    const dedupeKey = `${experience.trigger}|${experience.action}`.toLowerCase()
    if (seenExperience.has(dedupeKey)) continue
    seenExperience.add(dedupeKey)
    profile.experiences.push(experience)
    if (profile.experiences.length >= 30) break
  }
  return profile
}

/** 文字字段归一化小工具（内部用）。 */
function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0.6
  return Math.min(1, Math.max(0, number))
}

/** profile 的总条数（用于面板/工具摘要）。 */
export function profileSize(profile) {
  if (!profile) return 0
  const base = LIST_KEYS.reduce((sum, key) => sum + (Array.isArray(profile[key]) ? profile[key].length : 0), 0)
  const experiences = Array.isArray(profile.experiences) ? profile.experiences.length : 0
  return base + experiences
}

/**
 * 离线兜底：没有模型时，用句式/关键词从对话里抽一份 profile。
 * 质量明显低于模型，但保证功能可用（也用于测试）。
 */
export function heuristicDistillation(conversations) {
  const text = (conversations || []).map((item) => item.text).join('\n')
  const lines = text
    .split(/[\n。；;]+/)
    .map((line) => line.replace(/^(用户|AI|assistant|user)\s*[:：]\s*/i, '').trim())
    .filter((line) => line.length >= 6 && line.length <= 200)

  const bucket = { preferences: [], rules: [], patterns: [], skills: [], avoid: [] }
  const push = (key, line) => {
    if (bucket[key].length >= 8) return
    if (!bucket[key].includes(line)) bucket[key].push(line)
  }

  for (const line of lines) {
    if (/必须|禁止|不要再|绝不能|一律/.test(line)) push('rules', line)
    else if (/不要|别用|避免|别|不要用/.test(line)) push('avoid', line)
    else if (/我(更)?(喜欢|偏好)|习惯|以后都|倾向/.test(line)) push('preferences', line)
    else if (/每次|一律先|先.*再|流程|步骤/.test(line)) push('patterns', line)
    else if (/擅长|熟练|用过|做过|经验/.test(line)) push('skills', line)
  }

  // 出现频次最高的主题词当作 profile 一句话
  const freq = new Map()
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9.+#-]{2,}|[\u4e00-\u9fa5]{2,6}/g)) {
    const term = match[0]
    if (STOP_WORDS.has(term)) continue
    freq.set(term, (freq.get(term) || 0) + 1)
  }
  const topics = [...freq.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([term]) => term)
  const profileText = topics.length > 0
    ? `从 ${(conversations || []).length} 个会话里看，主要围绕 ${topics.join('、')}；偏好与规则见下。`
    : `从 ${(conversations || []).length} 个会话里提炼（离线启发式，未接模型）。`

  return normalizeProfile({
    profile: profileText,
    preferences: bucket.preferences,
    rules: bucket.rules,
    patterns: bucket.patterns,
    skills: bucket.skills,
    avoid: bucket.avoid,
    confidence: 0.4,
  })
}

const STOP_WORDS = new Set([
  '用户', '我们', '这个', '那个', '可以', '需要', '因为', '所以', '现在', '就是', '没有', '一个', '然后', '如果', '已经', '还是', '这样', '不是', '什么', '怎么',
])

/** 空话/无操作性的条目（整条丢弃）。 */
const GENERIC_PATTERNS = [
  /喜欢(写)?好代码/,
  /写(出)?干净(的)?代码/,
  /注重代码质量/,
  /保持(代码)?(简洁|一致)/,
  /多(沟通|思考|交流)/,
  /追求卓越/,
  /要(写)?好文档/,
]

/** 需要脱敏的敏感串（替换成占位符）。 */
const REDACT_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, label: '密钥' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, label: '密钥' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: '密钥' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: '密钥' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: '密钥' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g, label: '邮箱' },
  { re: /\b1[3-9]\d{9}\b/g, label: '手机号' },
  { re: /\b[A-Za-z]:\\[^\s"'，。；)]{2,}/g, label: '路径' },
  { re: /(?:\/Users\/|\/home\/|\/root\/)[^\s"'，。；)]{2,}/g, label: '路径' },
]

/**
 * 蒸馏结果的「去噪 + 脱敏 + 置信度校准」。在 normalizeProfile 之后、落库之前调用。
 *
 * - 空话条目（"喜欢写好代码"）直接丢：这类内容进了记忆库只会稀释注入预算；
 * - 密钥/邮箱/手机号/绝对路径替换成 [已脱敏:xx]：对话里经常混着这些，蒸馏不该原样存；
 * - 没有证据的经验、没有边界的经验降置信度：让"有据可查"的内容在裁决里胜出。
 *
 * @returns {{profile: object, dropped: string[], redacted: {label: string, count: number}[]}}
 */
export function sanitizeProfile(input) {
  const profile = input && typeof input === 'object' ? input : {}
  const dropped = []
  const redactions = []
  const redactedCount = new Map()
  /** 记录每一次替换：字段、原文、占位符 —— 面板据此做逐条复核（还原/保留）。 */
  const clean = (text, field = 'profile', index = 0) => {
    let value = String(text ?? '')
    for (const pattern of REDACT_PATTERNS) {
      pattern.re.lastIndex = 0
      if (!pattern.re.test(value)) continue
      pattern.re.lastIndex = 0
      value = value.replace(pattern.re, (original) => {
        redactedCount.set(pattern.label, (redactedCount.get(pattern.label) ?? 0) + 1)
        if (redactions.length < 100) {
          redactions.push({
            index: redactions.length,
            field,
            itemIndex: index,
            label: pattern.label,
            original: String(original).slice(0, 200),
            masked: `[已脱敏:${pattern.label}]`,
          })
        }
        return `[已脱敏:${pattern.label}]`
      })
    }
    return value
  }
  const keep = (text, minLength = 5) => {
    const value = String(text ?? '').trim()
    if (value.length < minLength) return null
    for (const pattern of GENERIC_PATTERNS) {
      if (pattern.test(value)) return null
    }
    return value
  }

  const result = {
    profile: clean(profile.profile, 'profile'),
    confidence: Number(profile.confidence) || 0.6,
  }
  for (const key of LIST_KEYS) {
    result[key] = []
    const list = Array.isArray(profile[key]) ? profile[key] : []
    list.forEach((item, itemIndex) => {
      const kept = keep(item)
      if (kept) result[key].push(clean(kept, key, itemIndex))
      else dropped.push({ field: key, itemIndex, text: String(item).slice(0, 120) })
    })
  }
  result.experiences = []
  const experiences = Array.isArray(profile.experiences) ? profile.experiences : []
  experiences.forEach((item, itemIndex) => {
    // trigger/action 允许更短（中文"改配置"这种只有 3 个字）
    const triggerRaw = keep(item?.trigger, 3)
    const actionRaw = keep(item?.action, 3)
    if (!triggerRaw || !actionRaw) {
      dropped.push({
        field: 'experiences',
        itemIndex,
        text: `${item?.trigger ?? ''} → ${item?.action ?? ''}`.slice(0, 120),
      })
      return
    }
    const field = `experiences[${itemIndex}]`
    const trigger = clean(triggerRaw, field, itemIndex)
    const action = clean(actionRaw, field, itemIndex)
    const why = item?.why ? clean(item.why, field, itemIndex) : ''
    const boundary = item?.boundary ? clean(item.boundary, field, itemIndex) : ''
    let confidence = Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : 0.7
    if (!why) confidence = Math.min(confidence, 0.85)
    if (!boundary) confidence = Math.min(confidence, 0.9)
    if (!item?.evidence) confidence = Math.min(confidence, 0.75)
    result.experiences.push({
      trigger,
      action,
      why,
      boundary,
      evidence: item?.evidence ? clean(item.evidence, field, itemIndex) : '',
      since: item?.since ? clean(item.since, field, itemIndex) : '',
      confidence,
    })
  })
  // rules 是"硬约束"，没有证据支撑时不要给到铁律级的置信度（供 profileToMemories 使用）
  result.ruleCap = Number(result.confidence) >= 0.75 ? 0.85 : 0.75
  const redacted = [...redactedCount.entries()].map(([label, count]) => ({ label, count }))
  return { profile: result, dropped, redacted, redactions }
}


/**
 * 把 profile 映射成待写入的记忆（分类沿用五类体系）。
 * @returns {{category: string, content: string, layer?: string, confidence?: number, tags?: string}[]}
 */
export function profileToMemories(profile, { sourceTag = 'distill' } = {}) {
  if (!profile) return []
  const out = []
  const add = (category, content, layer, confidence, structured = null) => {
    const text = String(content ?? '').trim()
    if (!text) return
    const draft = { category, content: text, layer, confidence, tags: `${sourceTag},蒸馏` }
    if (structured) draft.structured = structured
    out.push(draft)
  }
  for (const item of profile.rules || []) add('iron_rule', item, 'fact', Number(profile.ruleCap) || 0.85)
  for (const item of profile.avoid || []) add('pitfall', `避免：${item}`, 'strategy', 0.85)
  for (const item of profile.preferences || []) add('preference', item, 'strategy', 0.85)
  for (const item of profile.patterns || []) add('decision', item, 'strategy', 0.8)
  for (const item of profile.skills || []) add('preference', `擅长：${item}`, 'fragment', 0.7)
  if (profile.profile) add('fuzzy', `画像：${profile.profile}`, 'fragment', 0.6)

  // 经验条目：内容用「情境 → 做法」压缩成一句，完整结构放 structured，检索/展示都用得上
  for (const experience of profile.experiences || []) {
    const trigger = String(experience?.trigger ?? '').trim()
    const action = String(experience?.action ?? '').trim()
    if (!trigger || !action) continue
    const boundary = String(experience?.boundary ?? '').trim()
    const content = `${trigger} → ${action}${boundary ? `（边界：${boundary}）` : ''}`
    // 带"必须/禁止"的经验按铁律处理；带"不要/避免"按踩坑；其余算决策（情境判断）
    const category = /必须|禁止|绝不能|一律/.test(action)
      ? 'iron_rule'
      : /不要|别用|避免/.test(action)
        ? 'pitfall'
        : 'decision'
    add(category, content, 'strategy', Number.isFinite(Number(experience.confidence)) ? Number(experience.confidence) : 0.8, {
      kind: 'experience',
      trigger,
      action,
      why: String(experience?.why ?? '').trim(),
      boundary,
      evidence: String(experience?.evidence ?? '').trim(),
      since: String(experience?.since ?? '').trim(),
    })
  }
  return out
}
