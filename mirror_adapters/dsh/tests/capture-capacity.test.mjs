/**
 * 捕获容量治理自测：单会话超限只留末尾、按数量裁剪、一键清空、总量统计。
 *
 * 运行：node tests/capture-capacity.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cap-'))
process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

const capture = await import('../core/capture.js')
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

console.log('捕获容量治理自测')
console.log(`  数据目录：${tmpDir}`)

capture.setCaptureState(tmpDir, true)

check('默认关闭时 appendTurn 不写盘', () => {
  const offDir = path.join(tmpDir, 'off')
  capture.setCaptureState(offDir, false)
  const result = capture.appendTurn({ dataDir: offDir, sessionId: 's1', role: 'user', text: '不该写入' })
  assert.equal(result.skipped, true)
  assert.equal(capture.listCaptured(offDir).length, 0)
})

check('写入 3 个会话 + 统计（sessions/turns/bytes）', () => {
  for (const sessionId of ['a', 'b', 'c']) {
    capture.appendTurn({ dataDir: tmpDir, sessionId, role: 'user', text: `${sessionId} 的第一句` })
    capture.appendTurn({ dataDir: tmpDir, sessionId, role: 'assistant', text: `${sessionId} 的回复` })
  }
  const totals = capture.captureTotals(tmpDir)
  assert.equal(totals.sessions, 3, `会话数 ${totals.sessions}`)
  assert.equal(totals.turns, 6, `轮数 ${totals.turns}`)
  assert.ok(totals.bytes > 0)
})

check('pruneCaptured：只保留最近 2 个会话', () => {
  const result = capture.pruneCaptured(tmpDir, 2)
  assert.equal(result.removed.length, 1, `删掉 ${result.removed.length} 个`)
  assert.equal(capture.listCaptured(tmpDir).length, 2)
})

check('单会话超限：只保留末尾，返回 rotated=true', () => {
  const sessionId = 'big'
  // 先写一条小记录，再用很小的 maxFileBytes 触发轮转
  capture.appendTurn({ dataDir: tmpDir, sessionId, role: 'user', text: 'start' })
  let rotated = false
  for (let index = 0; index < 40; index += 1) {
    const result = capture.appendTurn({
      dataDir: tmpDir,
      sessionId,
      role: 'user',
      text: `第 ${index} 条很长的对话内容 ${'x'.repeat(80)}`,
      maxFileBytes: 2500,
    })
    if (result.rotated) rotated = true
  }
  assert.equal(rotated, true, '应至少触发一次轮转')
  const file = path.join(tmpDir, 'sessions', 'big.jsonl')
  const size = fs.statSync(file).size
  assert.ok(size <= 4000, `轮转后文件应被截断，实际 ${size} 字节`)
  const turns = capture.readCaptured(tmpDir, 'big')
  assert.ok(turns.length > 0, '轮转后仍有内容')
  assert.ok(turns[turns.length - 1].text.includes('第 39 条'), '应保留最近的对话')
})

check('clearCaptured：清空全部原始捕获', () => {
  const before = capture.listCaptured(tmpDir).length
  assert.ok(before >= 1)
  const result = capture.clearCaptured(tmpDir)
  assert.equal(result.removed.length, before)
  assert.equal(capture.listCaptured(tmpDir).length, 0)
  assert.equal(capture.captureTotals(tmpDir).sessions, 0)
})

check('清空后开关状态保持（不清掉授权状态）', () => {
  assert.equal(capture.getCaptureState(tmpDir).enabled, true)
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
