/**
 * core/vector.js —— 轻量向量检索 + RRF 融合（零依赖、离线可用）
 *
 * 定位：**不是神经嵌入**。这里用「字符 n-gram 哈希向量」捕捉词面重叠（中文二元组、英文词），
 * 解决 FTS5 trigram 的两个硬伤：
 *   1) 1–2 个汉字的查询（如「重连」）trigram 根本命中不了；
 *   2) 换了说法的同义表述（「消息丢失」vs「丢消息」）词面不完全匹配。
 * 真正的语义检索需要 embedding 模型，那是后续可插拔的一层；这里先把召回率垫高，并给
 * 文档/记忆的检索加一层 RRF（Reciprocal Rank Fusion）融合，排序更稳。
 *
 * 所有缓存都是进程内、按 id+更新时间做 key，容量有上限，随进程退出释放。
 */

const DIMS = 512
const MAX_CACHE = 4000

/** 分词：英文/数字词 + 中文二元组（单字也保留，处理「茶」这种极短查询）。 */
export function tokenizeSearchText(text) {
  const value = String(text ?? '')
  if (!value) return []
  const tokens = []
  for (const match of value.matchAll(/[a-z0-9_+#.-]{2,}/gi)) tokens.push(match[0].toLowerCase())
  const cjkRuns = value.replace(/[^\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, ' ')
  for (const run of cjkRuns.split(/\s+/)) {
    if (!run) continue
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/** 稳定字符串哈希（FNV-1a 32bit），用于把 token 映射到桶。 */
export function hashToken(token) {
  let hash = 0x811c9dc5
  const value = String(token)
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 文本 → 归一化向量（哈希分桶的 TF 向量，L2 归一化）。 */
export function embedText(text, dims = DIMS) {
  const vector = new Float64Array(dims)
  const tokens = tokenizeSearchText(text)
  if (tokens.length === 0) return vector
  for (const token of tokens) vector[hashToken(token) % dims] += 1
  let norm = 0
  for (let index = 0; index < dims; index += 1) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let index = 0; index < dims; index += 1) vector[index] /= norm
  }
  return vector
}

export function cosineSimilarity(a, b) {
  if (!a || !b) return 0
  const length = Math.min(a.length, b.length)
  let dot = 0
  for (let index = 0; index < length; index += 1) dot += a[index] * b[index]
  return Math.max(0, Math.min(1, dot))
}

const cache = new Map()

/** 带缓存的嵌入（key 建议 `${id}:${updatedAt}`）。 */
export function embedCached(key, text) {
  const cacheKey = String(key)
  const hit = cache.get(cacheKey)
  if (hit) return hit
  const vector = embedText(text)
  if (cache.size >= MAX_CACHE) {
    // 简单淘汰：删掉最早插入的 1/4
    const remove = Math.floor(cache.size / 4)
    let count = 0
    for (const existing of cache.keys()) {
      cache.delete(existing)
      if (++count >= remove) break
    }
  }
  cache.set(cacheKey, vector)
  return vector
}

export function vectorCacheSize() {
  return cache.size
}

export function resetVectorCache() {
  cache.clear()
}

/**
 * 向量检索：对 items 逐个算与 query 的余弦相似度，返回降序结果。
 * @param {{items: object[], query: string, getText: (item: object) => string, getId: (item: object) => string,
 *          getKey?: (item: object) => string, topK?: number, minScore?: number}} input
 */
export function vectorSearch({ items, query, getText, getId, getKey, topK = 50, minScore = 0.1, minSharedTokens = 1 } = {}) {
  const queryTokens = new Set(tokenizeSearchText(query))
  const queryVector = embedText(query)
  const results = []
  for (const item of Array.isArray(items) ? items : []) {
    const text = getText(item)
    if (!text) continue
    // 硬门禁：至少要共享一个 token。哈希分桶会有碰撞，只靠余弦会出现
    // 「无关 query 也命中」的假阳性（检索精度比多召回几条更重要）。
    const tokens = tokenizeSearchText(text)
    let shared = 0
    for (const token of tokens) {
      if (queryTokens.has(token)) shared += 1
    }
    if (shared < minSharedTokens) continue
    const vector = getKey ? embedCached(getKey(item), text) : embedText(text)
    const score = cosineSimilarity(queryVector, vector)
    if (score < minScore) continue
    results.push({ id: String(getId(item)), item, score, shared })
  }
  results.sort((a, b) => b.shared - a.shared || b.score - a.score)
  return results.slice(0, Math.max(1, topK))
}

/**
 * RRF 融合：输入若干「已按相关度排好序的 id 列表」，输出合并后的 [{id, score, ranks}]。
 * score = Σ 1/(k + rank)，rank 从 1 开始；出现在多个列表里的条目天然靠前。
 */
export function rrfFuse(lists, { k = 60 } = {}) {
  const merged = new Map()
  const safeLists = (Array.isArray(lists) ? lists : []).filter((list) => Array.isArray(list))
  safeLists.forEach((list, listIndex) => {
    list.forEach((id, rank) => {
      const key = String(id)
      const entry = merged.get(key) ?? { id: key, score: 0, ranks: [] }
      entry.score += 1 / (k + rank + 1)
      entry.ranks.push({ list: listIndex, rank: rank + 1 })
      merged.set(key, entry)
    })
  })
  return [...merged.values()].sort((a, b) => b.score - a.score)
}
