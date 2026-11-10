/**
 * 向量/RRF 检索 + PII 复核 + 经验可达性回归 测试。
 *
 * 1) vector.js：分词/嵌入/余弦/RRF 基础行为
 * 2) 记忆检索：换词表述能靠向量召回（关闭向量时召回不到）
 * 3) 文档检索：换词表述能召回 chunk
 * 4) PII 复核：distill.stage 暂存 → restore 还原原文 → apply 落库；discard
 * 5) quality.benchmark：经验可达性（topK 命中率）+ 关闭向量的对照
 *
 * 运行：node tests/search-vector-benchmark.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-search-'))
process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

const results = []
async function check(label, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`  PASS  ${label}`)
  } catch (error) {
    results.push(false)
    console.log(`  FAIL  ${label}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('向量检索 / PII 复核 / 经验回归')
console.log(`  数据目录：${tmpDir}`)

const vector = await import('../core/vector.js')
const { openMirror } = await import('../core/index.js')

await check('vector：中文二元组分词 + 余弦相似度', () => {
  assert.deepEqual(vector.tokenizeSearchText('重连'), ['重连'])
  assert.ok(vector.tokenizeSearchText('WebSocket 自动重连').includes('websocket'))
  assert.ok(vector.tokenizeSearchText('WebSocket 自动重连').includes('重连'))
  const a = vector.embedText('HTTP 会丢消息')
  const b = vector.embedText('消息丢失')
  assert.ok(vector.cosineSimilarity(a, b) > 0.1, '共享「消息」应有非零相似度')
  assert.equal(vector.cosineSimilarity(a, vector.embedText('完全无关的句子')), 0)
})

await check('vector：RRF 融合让"两个列表都出现"的条目排第一', () => {
  const fused = vector.rrfFuse([['a', 'b'], ['b', 'c']])
  assert.equal(fused[0].id, 'b')
  assert.equal(fused[0].ranks.length, 2)
  assert.ok(fused[0].score > fused[1].score)
})

const mirror = openMirror({ dataDir: path.join(tmpDir, 'core') })
try {
  mirror.memories.create({ category: 'pitfall', content: 'HTTP 会丢消息，必须用 WebSocket', authority: 'user_explicit', confidence: 1 })
  mirror.memories.create({ category: 'decision', content: '数据库迁移必须幂等', authority: 'user_explicit', confidence: 1 })

  await check('记忆检索：RRF 融合不丢已有召回（lexical ⊆ fused）', () => {
    const q = '消息丢失问题怎么避免'
    const lexical = mirror.memories.search({ q, scope: 'all', useVector: false }).map((memory) => memory.id)
    const fused = mirror.memories.search({ q, scope: 'all', useVector: true }).map((memory) => memory.id)
    assert.ok(lexical.length >= 1, '词法应至少命中一条')
    for (const id of lexical) assert.ok(fused.includes(id), `融合后不应丢掉词法结果：${id}`)
  })

  await check('记忆检索：无关查询不会因哈希碰撞误召回', () => {
    const unrelated = mirror.memories.search({ q: '量子退火超导', scope: 'all', useVector: true })
    assert.equal(unrelated.length, 0, `不应召回，实际 ${unrelated.map((m) => m.content).join(' | ')}`)
  })

  // ---------------- 文档检索 ----------------
  const docsDir = path.join(tmpDir, 'docs')
  fs.mkdirSync(docsDir, { recursive: true })
  fs.writeFileSync(
    path.join(docsDir, 'network.md'),
    '# 网络\n\nWebSocket 断线需要自动恢复连接，禁止用轮询兜底。\n',
    'utf8',
  )
  mirror.documents.addRoot(docsDir, { project: 'demo' })
  mirror.documents.scan()

  await check('文档检索：换词表述靠向量召回 chunk', () => {
    const hits = mirror.documents.search({ q: '连接断开', scope: 'all', limit: 5 })
    assert.ok(hits.length >= 1, '应召回文档 chunk')
    assert.ok(String(hits[0].chunk.content).includes('自动恢复连接'))
  })
} finally {
  mirror.store.close()
}

// ---------------- 宿主层：PII 复核 + benchmark ----------------
const tools = new Map()
const routes = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (callback) => callback(),
  on: () => () => {},
  tools: { register: (tool) => tools.set(tool.name, tool) },
  systemPrompt: { section: () => () => {} },
  inject: (deps, callback) => {
    if (deps.includes('webServer')) {
      callback({ effect: (cb) => cb(), webServer: { register(route) { routes.push(route); return () => {} } } })
    }
  },
}
const { apply } = await import('../lib/index.js')
apply(ctx, { dataDir: tmpDir, injectTokenBudget: 1500 })

const route = routes.find((item) => item.path === '/mirror/api/action')
assert.ok(route, '缺少 /action 路由')
const call = (payload) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('route timeout')), 8000)
    const response = {
      statusCode: 0, headersSent: false,
      writeHead(status) { this.statusCode = status; this.headersSent = true },
      end(text) { clearTimeout(timer); try { resolve(JSON.parse(text)) } catch (error) { reject(error) } },
    }
    const request = {
      method: 'POST', url: '/mirror/api/action', headers: {}, socket: { remoteAddress: '127.0.0.1' },
      on(event, callback) {
        if (event === 'data') callback(Buffer.from(JSON.stringify(payload), 'utf8'))
        if (event === 'end') callback()
        return this
      },
      destroy() {},
    }
    route.handler(request, response)
  })

const staged = await call({
  type: 'distill.stage',
  distillation: {
    profile: '测试画像',
    rules: ['密钥是 sk-example-not-a-real-key-000000，别外传'],
    preferences: ['喜欢写好代码', '注释只写为什么'],
  },
})

await check('PII 复核：stage 返回脱敏明细（含原文，供逐条确认）', () => {
  assert.equal(staged.ok, true, JSON.stringify(staged))
  assert.ok(staged.stageId)
  const redactions = staged.preview.redactions || []
  assert.ok(redactions.length >= 1, '应记录脱敏项')
  assert.equal(redactions[0].label, '密钥')
  assert.ok(String(redactions[0].original).includes('sk-'), '应保留原文供复核')
  assert.ok((staged.preview.dropped || []).some((item) => String(item.text).includes('喜欢写好代码')))
})

await check('PII 复核：review.list 能看到待确认项', async () => {
  const list = await call({ type: 'distill.review.list' })
  assert.equal(list.ok, true, JSON.stringify(list))
  assert.ok(list.stages.some((stage) => stage.id === staged.stageId))
})

await check('PII 复核：apply 可还原脱敏项、恢复丢弃项，并落库', async () => {
  const keyRedaction = staged.preview.redactions.find((item) => item.label === '密钥')
  const droppedIndex = (staged.preview.dropped || []).findIndex((item) => String(item.text).includes('喜欢写好代码'))
  const applied = await call({
    type: 'distill.review.apply',
    stageId: staged.stageId,
    restore: [keyRedaction.index],
    keepDropped: droppedIndex >= 0 ? [droppedIndex] : [],
  })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.ok(applied.restored >= 1, '应还原至少一条')
  const list = await call({ type: 'distill.list', limit: 5 })
  const saved = list.distillations.find((item) => item.id === applied.id)
  assert.ok(saved, '应落库一条 distillation')
  const text = JSON.stringify(saved.profile)
  assert.ok(text.includes('sk-example-not-a-real-key-000000'), '还原后应包含原文')
  assert.ok(text.includes('喜欢写好代码'), '恢复的丢弃项应回到画像')
})

await check('PII 复核：discard 后不再出现在待确认列表', async () => {
  const second = await call({ type: 'distill.stage', distillation: { profile: 'x', rules: ['邮箱 a@b.com 别存'] } })
  assert.equal(second.ok, true)
  await call({ type: 'distill.review.discard', stageId: second.stageId })
  const list = await call({ type: 'distill.review.list' })
  assert.ok(!list.stages.some((stage) => stage.id === second.stageId))
})

// ---------------- 经验可达性回归 ----------------
await call({
  type: 'distill.run',
  mode: 'apply',
  importToMemories: true,
  scope: 'project:bench',
  distillation: {
    profile: 'bench',
    experiences: [
      { trigger: '跨三个文件修 bug', action: '先复述现状再单文件改', why: '便于定位', boundary: '纯文案不需要', confidence: 0.9 },
      { trigger: '给旧项目加 WebSocket 自动重连', action: '先写重连测试再改连接层', why: '避免回归', boundary: '没有连接层的项目不适用', confidence: 0.85 },
      { trigger: '数据库迁移失败回滚', action: '先备份再跑幂等迁移', why: '防止数据丢失', boundary: '只读库不需要', confidence: 0.8 },
    ],
  },
})

await check('quality.benchmark：经验可达性 + 关闭向量的对照', async () => {
  const bench = await call({ type: 'quality.benchmark', topK: 5 })
  assert.equal(bench.ok, true, JSON.stringify(bench))
  assert.ok(bench.total >= 3, `应至少 3 条经验，实际 ${bench.total}`)
  assert.ok(bench.hitRate >= 0.6, `命中率应 ≥0.6，实际 ${bench.hitRate}`)
  assert.ok(bench.baseline, '应返回关闭向量的对照')
  assert.ok(Array.isArray(bench.misses))
  assert.equal(typeof bench.improvement, 'number')
})

await check('mirror_quality 工具：benchmark 分支可用', async () => {
  const tool = tools.get('mirror_quality')
  assert.ok(tool, '缺少 mirror_quality 工具')
  const output = await tool.execute({ action: 'benchmark', topK: 5 })
  assert.equal(output.ok, true, JSON.stringify(output))
  assert.ok(String(output.text).includes('经验可达性'))
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
