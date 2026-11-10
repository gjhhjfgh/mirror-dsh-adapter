/**
 * 「常驻偏好」自测：不管 query 是否命中，top N 条偏好/决策都要进注入层。
 *
 * 背景：用户问「注入了我的使用习惯了没」时，偏好层按 query 检索常常为空——
 * 而「使用习惯」本来就该稳定在场。retrieve({ residentPreferences }) 负责这件事。
 *
 * 运行：node tests/resident.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-resident-'))
process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

const { openMirror } = await import('../core/index.js')
const { retrieve, buildInjection } = await import('../core/retrieve.js')

const results = []
function check(label, fn) {
  try {
    fn()
    results.push(true)
    console.log(`  PASS  ${label}`)
  } catch (error) {
    results.push(false)
    console.log(`  FAIL  ${label}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

const mirror = openMirror({ dataDir: tmpDir })
const { memories, documents } = mirror

const fixtures = [
  { category: 'iron_rule', content: '接口必须走 WebSocket，禁止 HTTP 轮询' },
  { category: 'preference', content: '沟通与交付用中文，技术标识保持英文' },
  { category: 'preference', content: '交付前必须给出可验证的证据：测试输出与实测数据' },
  { category: 'preference', content: '修 bug 时先定位根因再改代码，并补回归测试' },
  { category: 'decision', content: '小步交付：每轮只推进一个可验证主题' },
  { category: 'pitfall', content: '踩坑：HMR 会刷新 bundle rev，不能用来判断进程是否重启' },
]
for (const fixture of fixtures) memories.create({ ...fixture, authority: 'user_explicit', confidence: 1 })

const unrelated = '量子退火 与 超导材料' // 与所有记忆词项都不重叠

console.log('常驻偏好自测')
console.log(`  数据目录：${tmpDir}`)

check('residentPreferences=0 时，无关 query 不带偏好层（旧行为）', () => {
  const result = retrieve({ memories, documents, query: unrelated, scope: 'all', tokenBudget: 3000, residentPreferences: 0 })
  const built = buildInjection(result)
  assert.equal(result.preferences.length + result.decisions.length, 0, '不应有偏好/决策')
  assert.ok(!built.text.includes('## 🟡 偏好与决策'), '注入文本不应有偏好段')
})

check('residentPreferences=3 时，无关 query 也带 3 条偏好/决策', () => {
  const result = retrieve({ memories, documents, query: unrelated, scope: 'all', tokenBudget: 3000, residentPreferences: 3 })
  const count = result.preferences.length + result.decisions.length
  assert.equal(count, 3, `期望 3 条，实际 ${count}`)
  const built = buildInjection(result)
  assert.ok(built.text.includes('## 🟡 偏好与决策'), '注入文本应有偏好段')
  assert.ok(built.text.includes('[preference]') || built.text.includes('[decision]'), '应带分类前缀')
})

check('常驻偏好不挤掉铁律层', () => {
  const result = retrieve({ memories, documents, query: unrelated, scope: 'all', tokenBudget: 3000, residentPreferences: 3 })
  assert.ok(result.ironRules.length >= 1, '铁律仍在')
  const built = buildInjection(result)
  const ironAt = built.text.indexOf('## 🔴 铁律')
  const prefAt = built.text.indexOf('## 🟡 偏好与决策')
  assert.ok(ironAt >= 0 && prefAt > ironAt, '铁律应排在偏好之前')
})

check('常驻偏好来自 active 记忆，且不含铁律/踩坑', () => {
  const result = retrieve({ memories, documents, query: unrelated, scope: 'all', tokenBudget: 3000, residentPreferences: 10 })
  const picked = [...result.preferences, ...result.decisions]
  assert.ok(picked.length >= 4, `期望 >=4 条，实际 ${picked.length}`)
  for (const memory of picked) {
    assert.ok(['preference', 'decision'].includes(memory.category), `混入了 ${memory.category}`)
  }
})

check('常驻偏好受 token 预算约束（预算很小时会被截断）', () => {
  const result = retrieve({ memories, documents, query: unrelated, scope: 'all', tokenBudget: 200, residentPreferences: 10 })
  const built = buildInjection(result)
  assert.ok(built.token_count <= 260, `注入超预算：${built.token_count} tokens`)
})

check('常驻偏好不重复计入 query 命中', () => {
  const result = retrieve({ memories, documents, query: '沟通 用中文', scope: 'all', tokenBudget: 3000, residentPreferences: 3 })
  const ids = [...result.preferences, ...result.decisions].map((m) => m.id)
  assert.equal(ids.length, new Set(ids).size, '偏好层出现重复记忆')
})

mirror.store.close()

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
