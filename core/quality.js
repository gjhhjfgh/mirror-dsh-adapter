/**
 * 蒸馏候选质量闸门。
 *
 * 离线启发式蒸馏会把整段对话切成句子，其中很多是碎片、疑问句、元叙述，
 * 直接入库只会污染记忆。这里用四个可自动判定的维度打分：
 *   规则性（必须/不要/避免…）、锚点（代码/路径/命令/数字）、
 *   独立性（完整句、非截断）、语言完整度（中文占比）。
 *
 * 只有明确的垃圾才硬拒绝（空、过短、疑问句、元叙述、纯英文碎片）；
 * 其余给分并分档，分数用于排序与面板提示，不单独决定丢弃——
 * 短规则（"先备份"）本身可能是有效的，宁可进复核也不误杀。
 */

export const QUALITY_ACCEPT = 0.65
export const QUALITY_REVIEW = 0.35
export const QUALITY_MIN = QUALITY_REVIEW

const RULE_MARKERS =
  /(必须|不要|避免|禁止|优先|统一|先[做用改看备]|保持|记得|别|应当|需要|一律|严禁|只能|务必|should|must|never|avoid|prefer|always|require)/i
const ANCHOR =
  /(`[^`]+`|[A-Za-z][A-Za-z0-9_]{2,}|[A-Za-z0-9]+\.(?:js|mjs|cjs|ts|tsx|md|json|yml|yaml|py|gd|cs|go|rs|sh|ps1)|[A-Za-z]:\\|\/[\w.-]+\/|\b\d{2,}\b)/
const QUESTION = /[?？]\s*$|是不是|要不要|能不能|有没有|怎么(办|样)$/
const META = /^(这条|这一条|以上|综上|原文|引用|来自|对话|用户说|你说|我觉得)/

function normalize(raw) {
  return String(raw ?? '')
    .replace(/^[-*>\d.)\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 给一条候选打分。
 * @returns {{score: number, label: 'accept'|'review'|'reject', reason: string}}
 */
export function scoreCandidate(raw) {
  const text = normalize(raw)
  if (text.length < 4) return { score: 0, label: 'reject', reason: '过短或碎片' }
  if (QUESTION.test(text)) return { score: 0.1, label: 'reject', reason: '疑问句，不是规则' }
  if (META.test(text)) return { score: 0.15, label: 'reject', reason: '元叙述' }

  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const cjkRatio = cjk / text.length
  const words = text.split(/\s+/).filter(Boolean)
  if (cjkRatio < 0.15 && !RULE_MARKERS.test(text) && words.length >= 4) {
    return { score: 0.2, label: 'reject', reason: '纯英文碎片' }
  }

  const reasons = []
  let score = 0.4

  if (RULE_MARKERS.test(text)) {
    score += 0.25
    reasons.push('有规则动词')
  }
  if (ANCHOR.test(text)) {
    score += 0.15
    reasons.push('有具体锚点')
  }
  if (cjkRatio >= 0.45) {
    score += 0.05
    reasons.push('中文完整句')
  }
  if (text.length < 8) {
    score -= 0.05
    reasons.push('偏短')
  }
  if (text.length > 160) {
    score -= 0.1
    reasons.push('偏长')
  }
  if (/(\.\.\.|…)/.test(text)) {
    score -= 0.1
    reasons.push('疑似截断')
  }

  score = Math.max(0, Math.min(1, Number(score.toFixed(2))))
  const label = score >= QUALITY_ACCEPT ? 'accept' : score >= QUALITY_REVIEW ? 'review' : 'reject'
  return { score, label, reason: reasons.join('、') || '一般' }
}

/** 汇总分档数量。 */
export function summarize(verdicts) {
  const summary = { accept: 0, review: 0, reject: 0, total: 0 }
  for (const verdict of verdicts) {
    if (!verdict) continue
    summary[verdict.label] = (summary[verdict.label] ?? 0) + 1
    summary.total += 1
  }
  return summary
}
