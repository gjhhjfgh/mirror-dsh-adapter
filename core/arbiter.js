/**
 * core/arbiter.js —— 裁决引擎 + 文本相似度工具
 *
 * 对应《Mirror 开发文档 v2.0》§4.2：
 *   核心原则 —— 「LLM 只做语义识别，确定性代码做裁决」。
 *   没有 embedding 的前提下，用字符 bigram Jaccard / containment 代替向量相似度，
 *   好处是零依赖、可解释、结果稳定（同一对文本永远同一结论）。
 *
 * 这里同时导出文本工具（normalizeText / bigramJaccard / bigramContainment /
 * isOpposite），memory.js、documents.js、packs.js 都复用这一份实现，
 * 保证「去重阈值」「冲突判定」「文档复核」用的是同一把尺子。
 */

/** 权威级别权重（文档 §4.2 原值） */
export const AUTHORITY_WEIGHT = {
  user_explicit: 1.0,
  user_confirmed: 0.9,
  imported: 0.7,
  inferred: 0.3,
}

/** 冲突严重度：面板按这个上色 */
export const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 }

/** 中文/英文否定词表（用于「语义相反」判定） */
const NEGATION_CN = /(禁止|不要|不能|不得|不允许|切勿|勿|避免|别用|不用|无需|不)/g
const NEGATION_EN = /\b(never|don'?t|do not|must not|should not|avoid|no longer|not)\b/gi

/** 常见「互斥关键词」对：命中任意一对即视为语义相反 */
const OPPOSITE_PAIRS = [
  ['必须', '禁止'],
  ['必须', '不要'],
  ['使用', '不要使用'],
  ['同步', '异步'],
  ['启用', '禁用'],
  ['开启', '关闭'],
  ['大于', '小于'],
  ['增加', '减少'],
  ['允许', '拒绝'],
  ['方案a', '方案b'],
  ['websocket', 'http'],
  ['http', 'grpc'],
  ['rest', 'graphql'],
  ['pnpm', 'npm'],
  ['pnpm', 'yarn'],
  ['typescript', 'javascript'],
  ['any', 'unknown'],
  ['redux', 'zustand'],
  ['use', 'avoid'],
  ['always', 'never'],
  ['enable', 'disable'],
  ['mutable', 'immutable'],
  ['sync', 'async'],
]

/**
 * 归一化：NFKC（全角/半角统一）→ 小写 → 去掉空白、标点、符号。
 * 这样「不要用 any。」与「不要用ANY」会被判为完全重复。
 */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符 bigram 集合；单字符文本退化为单元素集合，避免空集 */
export function bigramsOf(text) {
  const s = normalizeText(text)
  const set = new Set()
  if (s.length <= 1) {
    if (s.length === 1) set.add(s)
    return set
  }
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
  return set
}

/** Jaccard 相似度：交集 / 并集，取值 0..1 */
export function bigramJaccard(a, b) {
  return jaccardSets(bigramsOf(a), bigramsOf(b))
}

/**
 * Containment：a 里出现了多少比例的 b。
 * 文档复核场景（长文档切片 vs 短记忆）必须用它：
 * Jaccard 会被长文本稀释，containment 才反映「这条记忆是否出现在文档里」。
 */
export function bigramContainment(a, b) {
  const setA = bigramsOf(a)
  const setB = bigramsOf(b)
  if (setB.size === 0 || setA.size === 0) return 0
  let inter = 0
  for (const g of setB) if (setA.has(g)) inter += 1
  return inter / setB.size
}

function jaccardSets(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const g of setA) if (setB.has(g)) inter += 1
  const union = setA.size + setB.size - inter
  return union <= 0 ? 0 : inter / union
}

/** 文本里是否含否定词 */
export function hasNegation(text) {
  const t = String(text ?? '').toLowerCase()
  NEGATION_CN.lastIndex = 0
  NEGATION_EN.lastIndex = 0
  return NEGATION_CN.test(t) || NEGATION_EN.test(t)
}

/** 去掉否定词后的主题文本（用于判断「是不是在说同一件事」） */
export function stripNegation(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(NEGATION_CN, '')
    .replace(NEGATION_EN, '')
}

/** 抽取数字（版本号/端口/超时值都算），用于「数值相反」判定 */
export function numbersOf(text) {
  const out = []
  const re = /\d+(?:\.\d+)?/g
  let m
  const s = String(text ?? '')
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[0])
  return out
}

/** 所有配对词（去重、按长度降序：「不要使用」必须先于「使用」被剥离） */
const PAIR_WORDS = [...new Set(OPPOSITE_PAIRS.flat())].sort((a, b) => b.length - a.length)

/** 主题词停用表：剥掉这些词之后仍共享的词，才算「在说同一件事」 */
const TOPIC_STOP_ZH = new Set([
  '我们', '你们', '他们', '这个', '那个', '一个', '可以', '需要', '应该', '如果',
  '然后', '因为', '所以', '已经', '没有', '什么', '怎么', '这样', '那样', '不是',
  '还是', '或者', '并且', '而且', '但是', '其实', '现在', '时候', '问题', '东西',
  '进行', '不要', '必须', '禁止', '使用', '不用', '不必', '无需',
])

const TOPIC_STOP_EN = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'these', 'those',
  'then', 'than', 'when', 'where', 'what', 'which', 'how', 'why', 'who', 'also',
  'use', 'using', 'used', 'must', 'never', 'not', 'should', 'would', 'could',
  'have', 'has', 'had', 'was', 'were', 'are', 'you', 'your', 'our', 'its',
  'can', 'will', 'all', 'any', 'but', 'one', 'two', 'off', 'out', 'via', 'per',
])

/** 编译过的词边界正则缓存（冲突检测是热点路径，避免反复 new RegExp） */
const WORD_REGEX_CACHE = new Map()

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isAsciiWord(word) {
  return /^[\x20-\x7e]+$/.test(String(word))
}

function wordRegex(word, flags = 'i') {
  const key = `${word}\u0000${flags}`
  if (WORD_REGEX_CACHE.has(key)) return WORD_REGEX_CACHE.get(key)
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(word)}(?![A-Za-z0-9_])`, flags)
  WORD_REGEX_CACHE.set(key, re)
  return re
}

/**
 * 拉丁词按词边界匹配（P0-1 要求）：
 * `npm` 不得命中 `pnpm`，`http` 不得命中 `https` / `http2`。
 * 中文词没有词边界概念，按子串匹配。
 */
export function containsWord(haystack, word) {
  const text = String(haystack ?? '')
  const target = String(word ?? '')
  if (!text || !target) return false
  if (isAsciiWord(target)) return wordRegex(target).test(text)
  return text.toLowerCase().includes(target.toLowerCase())
}

/** 从文本里剥掉全部配对词（拉丁词按边界，避免把 pnpm 里的 npm 一起剥掉） */
export function stripPairWords(text) {
  let out = String(text ?? '').toLowerCase()
  for (const word of PAIR_WORDS) {
    if (isAsciiWord(word)) {
      out = out.replace(wordRegex(word, 'gi'), ' ')
    } else {
      out = out.split(word).join(' ')
    }
  }
  return out
}

/** 命中哪一对互斥关键词（只是候选，是否相反还要看主题证据） */
export function findOppositePair(aText, bText) {
  const a = String(aText ?? '').toLowerCase()
  const b = String(bText ?? '').toLowerCase()
  if (!a || !b) return null
  for (const pair of OPPOSITE_PAIRS) {
    const [x, y] = pair
    if ((containsWord(a, x) && containsWord(b, y)) || (containsWord(a, y) && containsWord(b, x))) {
      return pair
    }
  }
  return null
}

/** 主题文本：去掉否定词 + 配对词（其余保留） */
function topicText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(NEGATION_CN, ' ')
    .replace(NEGATION_EN, ' ')
}

/** 中文连续段（先去掉否定词，再按拉丁词/标点切段，避免跨语言拼出无意义 n-gram） */
function cjkRuns(text) {
  const normalized = normalizeText(topicText(text))
  return normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || []
}

/**
 * 中文 n-gram 主题词集合。
 * - 2-gram：去掉停用词（我们/可以/必须/禁止…）；
 * - 3-gram：只要含停用 2-gram（如「必须使」「使用x」）就丢弃 —— 那是句式词不是主题词。
 */
function topicGrams(text, size = 2) {
  const set = new Set()
  for (const run of cjkRuns(text)) {
    for (let i = 0; i + size <= run.length; i += 1) {
      const gram = run.slice(i, i + size)
      if (size === 2) {
        if (TOPIC_STOP_ZH.has(gram)) continue
      } else if (TOPIC_STOP_ZH.has(gram.slice(0, 2)) || TOPIC_STOP_ZH.has(gram.slice(1))) {
        continue
      }
      set.add(gram)
    }
  }
  return set
}

/** 英文/拉丁主题词集合（长度 >= 2，去停用词） */
function topicLatinWords(text) {
  const words = String(topicText(text)).match(/[a-z][a-z0-9_-]{1,}/g) || []
  const set = new Set()
  for (const word of words) {
    if (TOPIC_STOP_EN.has(word)) continue
    set.add(word)
  }
  return set
}

/**
 * 两条文本共享的主题词（契约 §10.1 / R2）：
 * 中文 2-gram 交集 + 中文 3-gram 交集 + 拉丁词交集，
 * 都先去掉否定词/停用词（配对词已在 hasSharedTopic 的第一步里剥掉）。
 */
export function sharedTopicWords(aText, bText) {
  const shared = []
  const collect = (setA, setB) => {
    for (const item of setA) if (setB.has(item)) shared.push(item)
  }
  collect(topicGrams(aText, 2), topicGrams(bText, 2))
  collect(topicGrams(aText, 3), topicGrams(bText, 3))
  collect(topicLatinWords(aText), topicLatinWords(bText))
  return shared
}

/**
 * 主题门槛（契约 §10.1 / R2 收紧）：配对词命中后必须有主题证据才判相反。
 *   证据 1：剥掉配对词后的 bigram Jaccard >= 0.3；
 *   证据 2：共享主题词里至少 1 个长度 >= 3（中文 3-gram / 拉丁词 >= 3 字符）；
 *   证据 3：共享主题词至少 2 个（长度 >= 2）。
 * R2 收紧原因：真实实例里两条无关铁律只共享一个中文 2-gram「仓库」，
 * 叠加 必须/禁止 配对词就被误判矛盾 —— **单个 2 字中文词不足以证明同一主题**。
 */
export function hasSharedTopic(aText, bText) {
  if (bigramJaccard(stripPairWords(aText), stripPairWords(bText)) >= 0.3) return true
  const shared = [...new Set(sharedTopicWords(aText, bText))]
  if (shared.some((word) => String(word).length >= 3)) return true
  return shared.length >= 2
}

/**
 * 语义相反判定（启发式，宁少勿滥：只在证据明确时返回 true）。
 * 三条证据（契约 §10.1 收紧后）：
 *   1. 一方有否定词、另一方没有，且去掉否定词后主题高度相似（Jaccard >= 0.45）；
 *   2. 双方都给出数字但数字不同，且去掉数字后主题高度相似（Jaccard >= 0.5）；
 *   3. 命中互斥关键词对（必须/禁止、ws/http …）**且**通过主题门槛（见 hasSharedTopic）。
 *      —— 只命中配对词、主题毫不相干时返回 false，避免误判「必须重启进程」vs「禁止 HTTP 轮询」。
 */
export function isOpposite(aText, bText) {
  const a = String(aText ?? '')
  const b = String(bText ?? '')
  if (!a || !b) return false
  if (normalizeText(a) === normalizeText(b)) return false

  const negA = hasNegation(a)
  const negB = hasNegation(b)
  if (negA !== negB) {
    const topicSim = bigramJaccard(stripNegation(a), stripNegation(b))
    if (topicSim >= 0.45) return true
  }

  const numsA = numbersOf(a)
  const numsB = numbersOf(b)
  if (numsA.length > 0 && numsB.length > 0) {
    const setA = new Set(numsA)
    const setB = new Set(numsB)
    const sameNumbers = setA.size === setB.size && [...setA].every((n) => setB.has(n))
    if (!sameNumbers) {
      const topicSim = bigramJaccard(
        a.replace(/\d+(?:\.\d+)?/g, ''),
        b.replace(/\d+(?:\.\d+)?/g, ''),
      )
      if (topicSim >= 0.5) return true
    }
  }

  // 配对词只是「候选」，必须再有主题证据（P0-1：否则两条无关铁律会被误判相反）
  if (findOppositePair(a, b)) return hasSharedTopic(a, b)
  return false
}

/** 权威分（未知 authority 按 inferred 处理，不让脏数据拖垮整个评分） */
export function authorityScore(authority) {
  return AUTHORITY_WEIGHT[authority] ?? AUTHORITY_WEIGHT.inferred
}

/**
 * 新鲜度分：7/30/90 天分档 1.0 / 0.8 / 0.5 / 0.2（文档 §4.2 原值）
 *
 * 蒸馏/导入内容优先用 `structured.observedAt`（对话发生时间）：否则一批从旧对话提炼的"经验"
 * 会拿到 createdAt=now 的新鲜分，把用户真正最近的表达压下去。
 */
export function recencyScore(mem, now = Date.now()) {
  const observed = Number(mem?.structured?.observedAt ?? 0) || 0
  const created = observed || Number(mem?.createdAt ?? mem?.created_at ?? 0) || 0
  if (!created) return 0.5 // 时间缺失时给中性分，避免误判为「很旧」
  const ageDays = Math.max(0, now - created) / 86400000
  if (ageDays < 7) return 1.0
  if (ageDays < 30) return 0.8
  if (ageDays < 90) return 0.5
  return 0.2
}

/**
 * 裁决引擎。
 * classify / resolve / score 三个方法都是纯函数式（不写库），
 * 写库由 MemoryService 负责 —— 便于单测，也避免「裁决顺手改数据」。
 */
export class Arbiter {
  constructor({ now } = {}) {
    this._now = typeof now === 'function' ? now : () => Date.now()
  }

  /**
   * 判断两条记忆的关系。
   * @returns {{conflictType: 'contradiction'|'scope_overlap'|'temporal_mismatch', severity: 'high'|'medium'|'low', reason: string}|null}
   *          返回 null 表示独立（不建冲突）。
   */
  classify(a, b) {
    if (!a || !b) return null
    if (a.id && b.id && a.id === b.id) return null

    const scopeA = a.scope || 'global'
    const scopeB = b.scope || 'global'
    const sameScope = scopeA === scopeB
    const sameCategory = a.category === b.category

    // 不同作用域 + 不同类别 → 明确独立（文档 §4.2 第一条）
    if (!sameScope && !sameCategory) return null

    // 双时态：B 在 A 诞生之前就已失效 → 时间错位，提示复核而不是直接判错
    const aCreated = Number(a.createdAt ?? a.created_at ?? 0) || 0
    const bValidTo = Number(b.validTo ?? b.valid_to ?? 0) || 0
    if (bValidTo && aCreated && bValidTo < aCreated) {
      return {
        conflictType: 'temporal_mismatch',
        severity: 'low',
        reason: '被比对记忆在对方创建之前就已失效，可能是旧结论尚未清理',
      }
    }

    const similarity = bigramJaccard(a.content, b.content)

    if (sameScope && sameCategory) {
      if (normalizeText(a.content) === normalizeText(b.content)) return null // 完全一样不算冲突
      if (isOpposite(a.content, b.content)) {
        return {
          conflictType: 'contradiction',
          severity: 'high',
          reason: '同作用域、同类别的两条记忆语义相反（否定词/数值/互斥关键词）',
        }
      }
      // 两条铁律高度雷同但表述不同：大概率是同一规则的新旧版本，值得让用户确认
      if (a.category === 'iron_rule' && similarity >= 0.6) {
        return {
          conflictType: 'contradiction',
          severity: 'medium',
          reason: '两条铁律高度相似但表述不同，可能互为新旧版本',
        }
      }
      return null
    }

    // 同类别、不同作用域：内容高度重叠 → 作用域重叠（提示是否该合并/上提）
    if (sameCategory && !sameScope && similarity >= 0.8) {
      return {
        conflictType: 'scope_overlap',
        severity: 'low',
        reason: `同一类别记忆在 ${scopeA} 与 ${scopeB} 两个作用域重复出现`,
      }
    }

    return null
  }

  /** 综合分：authority*0.4 + recency*0.3 + confidence*0.3（文档 §4.2） */
  score(mem) {
    if (!mem) return 0
    const authority = authorityScore(mem.authority)
    const recency = recencyScore(mem, this._now())
    const confidence = clamp01(Number(mem.confidence ?? 0.5))
    return round4(authority * 0.4 + recency * 0.3 + confidence * 0.3)
  }

  /**
   * 裁决两条记忆谁更可信。
   * 分差 < 0.1 视为「分数接近」→ 不自动裁决，交用户。
   */
  resolve(a, b) {
    const scoreA = this.score(a)
    const scoreB = this.score(b)
    const diff = Math.abs(scoreA - scoreB)
    if (diff < 0.1) {
      return {
        winnerId: null,
        scoreA,
        scoreB,
        needsUserConfirmation: true,
        reason: `分数接近（${scoreA.toFixed(2)} vs ${scoreB.toFixed(2)}），需用户裁决`,
      }
    }
    const winner = scoreA > scoreB ? a : b
    const loser = scoreA > scoreB ? b : a
    return {
      winnerId: winner.id ?? null,
      scoreA,
      scoreB,
      needsUserConfirmation: false,
      reason: `${winner.id ?? '其一'} 得分更高（${scoreA.toFixed(2)} vs ${scoreB.toFixed(2)}），建议保留；另一条 ${loser.id ?? '其一'} 建议失效`,
    }
  }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function round4(n) {
  return Math.round(n * 10000) / 10000
}
