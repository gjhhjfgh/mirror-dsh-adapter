/**
 * 蒸馏/治理 质量回归测试。
 *
 * 覆盖本轮的「质量」改动：
 *   1. 蒸馏去噪：空话条目丢弃、敏感串脱敏、无证据经验降置信度、rules 置信度封顶
 *   2. 批内近似去重：同分类里两条几乎一样的只导入一条
 *   3. 时效语义：observedAt 参与 recency（旧对话提炼的经验不再冒充新记忆）
 *   4. 常驻偏好多样性：近似重复的偏好不重复占预算
 *   5. 撤销一次蒸馏：只删推断生成、未确认、未改过的记忆
 *   6. 质量报告：重复对/冲突/陈旧/未确认推断 + 干净度分数
 *
 * 运行：node tests/quality.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-quality-'))
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

console.log('蒸馏 / 治理 质量回归')
console.log(`  数据目录：${tmpDir}`)

const { sanitizeProfile } = await import('../core/distill.js')
const { recencyScore, bigramJaccard } = await import('../core/arbiter.js')
const { retrieve } = await import('../core/retrieve.js')
const { openMirror } = await import('../core/index.js')

// ---------------- 1) 蒸馏去噪 ----------------
await check('sanitizeProfile：脱敏密钥/邮箱/手机号/路径', async () => {
  const { profile, redacted } = sanitizeProfile({
    profile: '后端工程师，联系 dev@example.com',
    rules: ['API key 是 sk-example-not-a-real-key-000000'],
    preferences: ['项目在 D:\\work\\secret-project 下', '电话 13812345678'],
  })
  const text = JSON.stringify(profile)
  assert.ok(!text.includes('sk-example-not-a-real-key-000000'), '密钥未脱敏')
  assert.ok(!text.includes('dev@example.com'), '邮箱未脱敏')
  assert.ok(!text.includes('13812345678'), '手机号未脱敏')
  assert.ok(!text.includes('D:\\\\work\\\\secret-project'), '绝对路径未脱敏')
  assert.ok(text.includes('[已脱敏:密钥]'), '缺少密钥占位符')
  const labels = redacted.map((item) => item.label)
  assert.ok(labels.includes('密钥') && labels.includes('邮箱'), `redacted=${JSON.stringify(labels)}`)
})

await check('sanitizeProfile：丢弃空话条目', async () => {
  const { profile, dropped } = sanitizeProfile({
    profile: 'x',
    preferences: ['喜欢写好代码', '写干净代码', '注释只写为什么'],
  })
  assert.deepEqual(profile.preferences, ['注释只写为什么'])
  assert.ok(dropped.length >= 2, `dropped=${JSON.stringify(dropped)}`)
})

await check('sanitizeProfile：无证据/无边界的经验降置信度，rules 置信度封顶', async () => {
  const { profile } = sanitizeProfile({
    profile: 'x',
    confidence: 0.9,
    rules: ['提交前必须跑测试'],
    experiences: [
      { trigger: '跨文件改 bug', action: '先复述再单文件改', why: '便于定位', boundary: '纯文案不需要', confidence: 0.95 },
      { trigger: '改配置', action: '直接改', confidence: 0.95 },
    ],
  })
  assert.equal(profile.rules.length, 1)
  assert.equal(profile.ruleCap, 0.85, 'rules 置信度应封顶 0.85')
  const withBoundary = profile.experiences.find((item) => item.trigger === '跨文件改 bug')
  const bare = profile.experiences.find((item) => item.trigger === '改配置')
  assert.ok(withBoundary && bare, '两条经验都应保留')
  assert.ok(withBoundary.confidence <= 0.85, `有边界经验 ${withBoundary.confidence}`)
  assert.ok(bare.confidence <= 0.75, `无证据经验应降到 0.75，实际 ${bare.confidence}`)
})

// ---------------- 2) 时效语义 ----------------
await check('recencyScore：observedAt 优先于 createdAt', async () => {
  const now = Date.now()
  assert.equal(recencyScore({ createdAt: now }), 1.0)
  assert.equal(recencyScore({ createdAt: now, structured: { observedAt: now - 200 * 86400000 } }), 0.2)
  assert.equal(recencyScore({ createdAt: now, structured: { observedAt: now - 10 * 86400000 } }), 0.8)
})

// ---------------- 3) 常驻偏好多样性 ----------------
await check('常驻偏好：近似重复的偏好只占一个位置', async () => {
  const mirror = openMirror({ dataDir: path.join(tmpDir, 'resident') })
  try {
    mirror.memories.create({ category: 'preference', content: '注释只写为什么，不写是什么', authority: 'user_explicit', confidence: 1 })
    mirror.memories.create({ category: 'preference', content: '注释只写为什么，不是写是什么', authority: 'user_explicit', confidence: 0.99 })
    mirror.memories.create({ category: 'preference', content: '沟通用中文', authority: 'user_explicit', confidence: 0.9 })
    const result = retrieve({
      memories: mirror.memories,
      documents: mirror.documents,
      query: '完全无关',
      scope: 'all',
      tokenBudget: 2000,
      residentPreferences: 3,
    })
    const picked = result.preferences.map((item) => item.content)
    assert.ok(picked.some((text) => text.includes('沟通用中文')), '应包含中文偏好')
    const nearDup = picked.filter((text) => text.includes('注释只写为什么'))
    assert.equal(nearDup.length, 1, `近似重复只应留一条，实际 ${nearDup.length}`)
  } finally {
    mirror.store.close()
  }
})

// ---------------- 宿主层 ----------------
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

const applied = await call({
  type: 'distill.run',
  mode: 'apply',
  importToMemories: true,
  distillation: {
    profile: '质量测试',
    confidence: 0.9,
    rules: ['提交前必须跑完整测试', '提交前必须跑完整测试。'],
    preferences: ['喜欢写好代码'],
    experiences: [{ trigger: '跨文件改 bug', action: '先复述再单文件改', why: '便于定位', confidence: 0.95 }],
  },
})

// ---------------- 4) 批内近似去重 ----------------
await check('批内近似去重：两条几乎一样的规则只导入一条', async () => {
  assert.equal(applied.ok, true, JSON.stringify(applied))
  const ruleMemories = applied.imported.length
  assert.ok(ruleMemories >= 2, `应至少导入规则+经验，实际 ${ruleMemories}`)
  assert.ok(applied.deduped >= 1, `应记录去重数，实际 ${applied.deduped}`)
  assert.ok(bigramJaccard('提交前必须跑完整测试', '提交前必须跑完整测试。') >= 0.9, '测试数据应≥0.9')
})

// ---------------- 5) 质量报告 ----------------
await check('quality.report：返回重复对/冲突/未确认推断与干净度分数', async () => {
  const report = await call({ type: 'quality.report' })
  assert.equal(report.ok, true, JSON.stringify(report))
  const data = report.report
  assert.equal(typeof data.total, 'number')
  assert.equal(typeof data.score, 'number')
  assert.ok(data.score >= 0 && data.score <= 100)
  assert.equal(typeof data.nearDuplicatePairs, 'number')
  assert.equal(typeof data.openConflicts, 'number')
  assert.ok(data.untrusted >= 1, '刚导入的蒸馏记忆应计入 untrusted')
  assert.ok(data.lastDistill?.id, '应带最近一次蒸馏')
})

// ---------------- 6) 撤销一次蒸馏 ----------------
await check('distill.undo：只删推断生成、未确认的记忆', async () => {
  const before = await call({ type: 'quality.report' })
  const undo = await call({ type: 'distill.undo', id: applied.id })
  assert.equal(undo.ok, true, JSON.stringify(undo))
  assert.ok(undo.removed >= 1, `应删除至少一条，实际 ${undo.removed}`)
  const after = await call({ type: 'quality.report' })
  assert.ok(after.report.untrusted < before.report.untrusted, '未确认推断记忆应减少')
})

// ---------------- 7) 近似重复对 + 手动合并 ----------------
// 现实里近似重复对来自"历史遗留数据"（新写入已被去重/门禁拦住），
// 这里直接用 SQL 改内容模拟一条历史数据，验证检测与合并能力。
const legacyA = await call({
  type: 'memory.create',
  category: 'decision',
  content: '接口必须走 WebSocket',
  scope: 'project:merge',
})
const legacyB = await call({
  type: 'memory.create',
  category: 'decision',
  content: '接口必须走 RabbitMQ 队列',
  scope: 'project:merge',
})
await check('quality.duplicates：列出历史遗留的近似重复对（带相似度与 id）', async () => {
  assert.equal(legacyA.ok, true, JSON.stringify(legacyA))
  assert.equal(legacyB.ok, true, JSON.stringify(legacyB))
  // 模拟历史数据：绕过写入路径直接改成近似内容
  const dbPath = path.join(tmpDir, 'mirror.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('接口必须走 WebSocket 协议', legacyB.id ?? legacyB.memory?.id)
  db.close()
  const duplicates = await call({ type: 'quality.duplicates', minScore: 0.85 })
  assert.equal(duplicates.ok, true, JSON.stringify(duplicates))
  const pair = duplicates.pairs.find(
    (item) => [item.a.content, item.b.content].some((text) => text.includes('WebSocket 协议')),
  )
  assert.ok(pair, `应检测到近似重复对，实际 ${JSON.stringify(duplicates.pairs)}`)
  assert.ok(pair.similarity >= 0.85, `相似度应 ≥0.85，实际 ${pair.similarity}`)
})

await check('memory.merge：保留前者、后者标 superseded、标签并集', async () => {
  const duplicates = await call({ type: 'quality.duplicates', minScore: 0.85 })
  const pair = duplicates.pairs.find(
    (item) => [item.a.content, item.b.content].some((text) => text.includes('WebSocket 协议')),
  )
  assert.ok(pair, '缺少可合并的对')
  const merged = await call({ type: 'memory.merge', keepId: pair.a.id, dropId: pair.b.id, reason: '测试合并' })
  assert.equal(merged.ok, true, JSON.stringify(merged))
  assert.equal(merged.kept.id, pair.a.id)
  assert.equal(merged.superseded, pair.b.id)
  const after = await call({ type: 'quality.duplicates', minScore: 0.85 })
  assert.ok(
    !after.pairs.some((item) => item.a.id === pair.a.id && item.b.id === pair.b.id),
    '合并后该对应消失',
  )
})

// ---------------- 8) 冲突按来源分组 ----------------
await check('/state 的冲突带 group（蒸馏导入分组用）', async () => {
  await call({
    type: 'memory.create',
    category: 'iron_rule',
    content: '接口必须走 WebSocket，HTTP 会丢消息',
    scope: 'project:conflict',
  })
  const distilled = await call({
    type: 'distill.run',
    mode: 'apply',
    scope: 'project:conflict',
    importToMemories: true,
    distillation: { profile: '冲突测试', rules: ['接口禁止走 WebSocket'], confidence: 0.9 },
  })
  assert.equal(distilled.ok, true, JSON.stringify(distilled))
  const stateRoute2 = routes.find((item) => item.path === '/mirror/api/state')
  const state = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('state timeout')), 8000)
    const response = {
      statusCode: 0, headersSent: false,
      writeHead(status) { this.statusCode = status; this.headersSent = true },
      end(text) { clearTimeout(timer); try { resolve(JSON.parse(text)) } catch (error) { reject(error) } },
    }
    const request = {
      method: 'GET', url: '/mirror/api/state', headers: {}, socket: { remoteAddress: '127.0.0.1' },
      on(event, callback) { if (event === 'end') callback(); return this },
      destroy() {},
    }
    stateRoute2.handler(request, response)
  })
  const conflicts = (state.conflicts || []).filter((item) => !item.resolved)
  assert.ok(conflicts.length >= 1, `应至少有一条未解冲突，实际 ${conflicts.length}`)
  const grouped = conflicts.filter((item) => String(item.group?.key ?? '').startsWith('distill:'))
  assert.ok(grouped.length >= 1, `冲突应按蒸馏 id 分组，实际 ${JSON.stringify(conflicts.map((c) => c.group))}`)
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
