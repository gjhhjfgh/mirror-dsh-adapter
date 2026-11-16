/**
 * 质量闸门自测：蒸馏候选分档、入库过滤、文档扫描排除发布目录。
 *
 * 运行：node tests/quality-gate.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-gate-'))
process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

const { scoreCandidate, summarize } = await import('../core/quality.js')
const { sanitizeProfile, profileToMemories } = await import('../core/distill.js')
const { openMirror } = await import('../core/index.js')

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

check('好规则判为 accept（有规则动词 + 具体锚点）', () => {
  const verdict = scoreCandidate('改 project.godot 时 Color 必须写完整构造函数，否则整份配置解析失败')
  assert.equal(verdict.label, 'accept')
  assert.ok(verdict.score >= 0.6, `score=${verdict.score}`)
})

check('短但有效的中文规则不被误杀（review 或 accept）', () => {
  const verdict = scoreCandidate('先备份再改配置')
  assert.ok(['accept', 'review'].includes(verdict.label), `label=${verdict.label}`)
})

check('疑问句 / 元叙述 / 纯英文碎片判为 reject', () => {
  assert.equal(scoreCandidate('是不是要改配置？').label, 'reject')
  assert.equal(scoreCandidate('这条我倾向接受——盖缝很关键').label, 'reject')
  assert.equal(scoreCandidate('the memory LASTCALL and your').label, 'reject')
})

check('summarize 统计三档数量', () => {
  const summary = summarize([
    { label: 'accept' },
    { label: 'accept' },
    { label: 'review' },
    { label: 'reject' },
  ])
  assert.deepEqual({ accept: summary.accept, review: summary.review, reject: summary.reject, total: summary.total }, {
    accept: 2,
    review: 1,
    reject: 1,
    total: 4,
  })
})

check('sanitizeProfile 丢弃垃圾候选并给出质量汇总', () => {
  const { profile, dropped, quality } = sanitizeProfile({
    profile: '画像',
    rules: ['接口必须走 WebSocket，HTTP 轮询会丢消息', '是不是要改配置？', '这条我倾向接受——盖缝很关键'],
    preferences: ['注释只写为什么，不写是什么'],
  })
  assert.equal(profile.rules.length, 1, '只保留有效规则')
  assert.equal(profile.rules[0].includes('WebSocket'), true)
  assert.ok(quality.total >= 2, `quality=${JSON.stringify(quality)}`)
  assert.ok(dropped.some((item) => item.reason), '丢弃项要带理由')
})

check('profileToMemories 只导入达标候选，并带质量标签', () => {
  const { profile } = sanitizeProfile({
    profile: '画像',
    rules: ['接口必须走 WebSocket，HTTP 轮询会丢消息'],
    avoid: ['不要用 any，用 unknown + 类型守卫'],
  })
  const drafts = profileToMemories(profile)
  const gated = drafts.filter((draft) => draft.structured && draft.structured.quality)
  assert.ok(gated.length >= 2, `gated=${gated.length}`)
  for (const draft of gated) {
    assert.ok(/质量(高|中)/.test(draft.tags), `tags=${draft.tags}`)
    assert.ok(Number(draft.structured.quality.score) >= 0.35)
  }
})

check('文档扫描默认跳过 launch/_publish 目录', () => {
  const root = path.join(tmpDir, 'repo')
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'launch'), { recursive: true })
  fs.mkdirSync(path.join(root, '_publish'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n\n## 安装\n\n正文。\n', 'utf8')
  fs.writeFileSync(path.join(root, 'launch', 'post.md'), '# 发帖\n\n正文。\n', 'utf8')
  fs.writeFileSync(path.join(root, '_publish', 'readme.md'), '# 发布\n\n正文。\n', 'utf8')

  const mirror = openMirror({ dataDir: path.join(tmpDir, 'data') })
  mirror.documents.addRoot(root)
  mirror.documents.scan({ force: true })
  const list = mirror.documents.list({ limit: 50 })
  const paths = list.map((item) => item.relativePath.replace(/\\/g, '/'))
  assert.ok(paths.some((item) => item.includes('docs/guide.md')), `未索引 docs：${paths.join(',')}`)
  assert.ok(!paths.some((item) => item.startsWith('launch/')), 'launch 不应被索引')
  assert.ok(!paths.some((item) => item.startsWith('_publish/')), '_publish 不应被索引')
  mirror.store.close()
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
