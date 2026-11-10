/**
 * 权威裁决 + 自动蒸馏 回归测试。
 *
 * 1) resolveAuthority：user_first / doc_first / memory_first 三种模式
 * 2) applyAuthority：记忆赢则隐藏文档、文档赢则隐藏记忆，并给出裁决说明
 * 3) retrieve 集成：注入结果里不再同时出现相反的主张
 * 4) 自动蒸馏状态机：关闭不写盘、累计到点触发、跑完重置
 * 5) 宿主 action：autoDistill.status / update / runNow
 *
 * 运行：node tests/authority-autodistill.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-auth-'))
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

console.log('权威裁决 / 自动蒸馏 回归')
console.log(`  数据目录：${tmpDir}`)

const authority = await import('../core/authority.js')
const auto = await import('../core/auto-distill.js')
const { openMirror } = await import('../core/index.js')
const { retrieve, buildInjection } = await import('../core/retrieve.js')

await check('resolveAuthority：user_first 下用户显式记忆赢文档，推断内容输文档', () => {
  assert.equal(authority.resolveAuthority({ memory: { authority: 'user_explicit' }, mode: 'user_first' }).winner, 'memory')
  assert.equal(authority.resolveAuthority({ memory: { authority: 'user_confirmed' }, mode: 'user_first' }).winner, 'memory')
  assert.equal(authority.resolveAuthority({ memory: { authority: 'inferred' }, mode: 'user_first' }).winner, 'document')
  assert.equal(authority.resolveAuthority({ memory: { authority: 'imported' }, mode: 'user_first' }).winner, 'document')
})

await check('resolveAuthority：doc_first / memory_first 覆盖默认', () => {
  assert.equal(authority.resolveAuthority({ memory: { authority: 'user_explicit' }, mode: 'doc_first' }).winner, 'document')
  assert.equal(authority.resolveAuthority({ memory: { authority: 'inferred' }, mode: 'memory_first' }).winner, 'memory')
})

await check('applyAuthority：记忆赢 → 隐藏文档；文档赢 → 隐藏记忆', () => {
  const memoryWin = {
    ironRules: [{ id: 'm1', content: '接口必须走 WebSocket，HTTP 会丢消息', authority: 'user_explicit' }],
    documents: [{ document: { id: 'doc1', relativePath: 'README.md' }, chunk: { id: 'c1', content: '接口禁止走 WebSocket，必须用 HTTP 轮询' } }],
    preferences: [],
    decisions: [],
    pitfalls: [],
    fuzzy: [],
  }
  const first = authority.applyAuthority({ result: memoryWin, mode: 'user_first' })
  assert.equal(first.conflicts.length, 1)
  assert.equal(first.conflicts[0].winner, 'memory')
  assert.equal(first.hiddenDocs, 1)
  assert.equal(memoryWin.documents.length, 0)
  assert.equal(memoryWin.ironRules.length, 1)

  const docWin = {
    ironRules: [],
    preferences: [{ id: 'm2', content: '接口必须走 WebSocket，HTTP 会丢消息', authority: 'inferred' }],
    decisions: [],
    pitfalls: [],
    fuzzy: [],
    documents: [{ document: { id: 'doc1', relativePath: 'README.md' }, chunk: { id: 'c1', content: '接口禁止走 WebSocket，必须用 HTTP 轮询' } }],
  }
  const second = authority.applyAuthority({ result: docWin, mode: 'user_first' })
  assert.equal(second.conflicts[0].winner, 'document')
  assert.equal(second.hiddenMemories, 1)
  assert.equal(docWin.preferences.length, 0)
  assert.equal(docWin.documents.length, 1)
})

await check('retrieve 集成：注入文本里不再同时出现相反主张，并提示裁决', () => {
  const mirror = openMirror({ dataDir: path.join(tmpDir, 'retrieve') })
  try {
    mirror.memories.create({
      category: 'iron_rule',
      content: '接口必须走 WebSocket，HTTP 会丢消息',
      authority: 'user_explicit',
      confidence: 1,
    })
    const fakeDocuments = {
      search: () => [
        { document: { id: 'doc-x', relativePath: 'docs/protocol.md' }, chunk: { id: 'ch-x', content: '接口禁止走 WebSocket，必须改为 HTTP 轮询' } },
      ],
    }
    const result = retrieve({
      memories: mirror.memories,
      documents: fakeDocuments,
      query: '接口 WebSocket',
      scope: 'all',
      tokenBudget: 2000,
      authorityMode: 'user_first',
    })
    assert.equal(result.authorityHidden?.docs, 1, JSON.stringify(result.authorityHidden))
    const injection = buildInjection(result)
    assert.ok(injection.text.includes('权威裁决'), '注入文本应提示裁决')
    assert.ok(!injection.text.includes('必须改为 HTTP 轮询'), '被裁决掉的文档不应进入注入')
    assert.ok(injection.text.includes('WebSocket'), '胜出的记忆应保留')
  } finally {
    mirror.store.close()
  }
})

await check('自动蒸馏：关闭时不写盘、不累计', () => {
  const closeDir = path.join(tmpDir, 'auto-off')
  const before = auto.readAutoDistillState(closeDir)
  assert.equal(before.enabled, false)
  const { due } = auto.recordTurn(closeDir)
  assert.equal(due, false)
  assert.equal(fs.existsSync(auto.autoDistillStatePath(closeDir)), false, '关闭时不应写状态文件')
})

await check('自动蒸馏：累计到点触发，markRun 后重置', () => {
  const onDir = path.join(tmpDir, 'auto-on')
  // every 最小是 5（clamp 5..200），minTurns 最小 2
  auto.updateAutoDistillState(onDir, { enabled: true, every: 5, minTurns: 2 })
  for (let index = 0; index < 4; index += 1) assert.equal(auto.recordTurn(onDir).due, false)
  assert.equal(auto.recordTurn(onDir).due, true, '累计 5 轮应触发')
  auto.markAutoDistillRun(onDir, { distillId: 'dst_test', after: 2 })
  const status = auto.autoDistillStatus(onDir)
  assert.equal(status.sinceLastRun, 0)
  assert.equal(status.lastDistillId, 'dst_test')
  assert.equal(status.remaining, 5)
})

await check('自动蒸馏：every/minTurns 越界会被夹到合法区间', () => {
  const cellDir = path.join(tmpDir, 'auto-cell')
  const state = auto.updateAutoDistillState(cellDir, { every: 9999, minTurns: 0 })
  assert.equal(state.every, 200)
  assert.equal(state.minTurns, 2)
})

// ---------------- 宿主 action ----------------
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
apply(ctx, { dataDir: tmpDir, injectTokenBudget: 1500, authorityMode: 'user_first' })

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

await check('action autoDistill.status / update 可用', async () => {
  const status = await call({ type: 'autoDistill.status' })
  assert.equal(status.ok, true, JSON.stringify(status))
  assert.equal(status.enabled, false)
  const updated = await call({ type: 'autoDistill.update', enabled: true, every: 5, importToMemories: false })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.enabled, true)
  assert.equal(updated.every, 5)
})

await check('action autoDistill.runNow：没有捕获时返回错误但状态被记录', async () => {
  const run = await call({ type: 'autoDistill.runNow' })
  assert.equal(run.ok, false)
  assert.ok(String(run.error).length > 0)
  const status = await call({ type: 'autoDistill.status' })
  assert.ok(status.lastResult, '应记录上次运行结果（含跳过原因）')
  assert.equal(status.sinceLastRun, 0)
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
