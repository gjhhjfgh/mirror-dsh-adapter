/**
 * 「记录 → 蒸馏」端到端自测（阶段一/二）（宿主层，用假 ctx + 假 webServer）。
 *
 * 覆盖：
 *   1. 捕获默认关闭；打开后才记；关闭后停记
 *   2. distill.run apply 落库（image 六段），可选导入记忆
 *
 * 运行：node tests/memorypack.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-memorypack-'))
process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

const tools = new Map()
const routes = []
const handlers = new Map()

const fakeWebServer = {
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(callback) {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  tools: { register(tool) { tools.set(tool.name, tool) } },
  systemPrompt: { section() { return () => {} } },
  inject(deps, callback) {
    if (deps.includes('webServer')) {
      callback({ effect(cb) { return cb() }, webServer: fakeWebServer })
    }
  },
}

function callRoute(method, url, body) {
  const pathname = url.split('?')[0]
  const exact = routes.find((route) => route.kind === 'exact' && route.path === pathname)
  const prefix = routes
    .filter((route) => route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const route = exact ?? prefix
  assert.ok(route, `没有匹配的路由：${url}`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`路由超时：${url}`)), 8000)
    const response = {
      statusCode: 0, headersSent: false, body: '',
      writeHead(status) { this.statusCode = status; this.headersSent = true },
      end(text) {
        clearTimeout(timer)
        this.body = typeof text === 'string' ? text : ''
        let json = null
        try { json = JSON.parse(this.body) } catch { json = null }
        resolve({ status: this.statusCode, json, body: this.body })
      },
    }
    const request = {
      method, url, headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      on(event, callback) {
        if (event === 'data' && body !== undefined) callback(Buffer.from(JSON.stringify(body), 'utf8'))
        if (event === 'end') callback()
        return this
      },
      destroy() {},
    }
    try { route.handler(request, response) } catch (error) { clearTimeout(timer); reject(error) }
  })
}

async function action(type, payload = {}) {
  const { json } = await callRoute('POST', '/mirror/api/action', { type, ...payload })
  assert.ok(json, `${type} 返回体不是 JSON`)
  return json
}
const state = async () => (await callRoute('GET', '/mirror/api/state')).json
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const { apply } = await import('../lib/index.js')

console.log('记录 → 蒸馏 自测')
console.log(`  数据目录：${tmpDir}`)

apply(ctx, { dataDir: tmpDir, injectTokenBudget: 1500 })

const sessionEvent = handlers.get('session/event')
assert.ok(typeof sessionEvent === 'function', '没有注册 session/event（捕获靠它）')

const session = { id: 'sess-test' }
const emitTurn = async (text, role = 'user') => {
  sessionEvent(session, { type: role === 'user' ? 'user/message' : 'assistant/message', data: { role, content: text } })
  await sleep(30) // 捕获是异步 fire-and-forget
}

await check('捕获默认关闭：消息不落盘', async () => {
  const before = await action('capture.status')
  assert.equal(before.enabled, false, '默认应是关闭')
  await emitTurn('这条不该被记录')
  const read = await action('capture.read', { sessionId: 'sess-test' })
  assert.equal((read.turns || []).length, 0, '关闭时不应写入')
})

await check('打开捕获后逐轮记录（用户 + AI）', async () => {
  const enabled = await action('capture.update', { enabled: true })
  assert.equal(enabled.enabled, true)
  await emitTurn('我习惯先写测试再实现')
  await emitTurn('好的，先写测试', 'assistant')
  await emitTurn('接口必须走 WebSocket，禁止用 HTTP 轮询')
  await emitTurn('不要用 any，用 unknown + 类型守卫')
  const read = await action('capture.read', { sessionId: 'sess-test' })
  assert.equal((read.turns || []).length, 4, `期望 4 轮，实际 ${(read.turns || []).length}`)
  assert.equal(read.turns[1].role, 'assistant')
})

await check('关闭捕获后停止记录（历史保留）', async () => {
  await action('capture.update', { enabled: false })
  await emitTurn('关闭后的这句话不该被记录')
  const read = await action('capture.read', { sessionId: 'sess-test' })
  assert.equal((read.turns || []).length, 4, '关闭后不应再追加')
})

await check('distill prepare 返回 prompt 与会话摘要', async () => {
  const prepared = await action('distill.run', { mode: 'prepare' })
  assert.equal(prepared.ok, true, JSON.stringify(prepared))
  assert.equal(prepared.phase, 'prepare')
  assert.ok(String(prepared.prompt).includes('{') === false || String(prepared.prompt).length > 200, 'prompt 太短')
  assert.ok((prepared.sessions || []).length >= 1)
})

let distillation = null
await check('distill apply 落库（六段画像）', async () => {
  const applied = await action('distill.run', {
    mode: 'apply',
    importToMemories: true,
    distillation: {
      profile: '做后端的工程师，偏好先测试后实现，重视接口可靠性。',
      preferences: ['先写测试再实现', '注释只写为什么'],
      rules: ['接口必须走 WebSocket'],
      patterns: ['改完代码先自测再提交'],
      skills: ['SQLite 调优'],
      avoid: ['不要用 any'],
      confidence: 0.82,
    },
  })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.phase, 'done')
  assert.equal(applied.profile.confidence, 0.82)
  assert.ok(applied.imported.length >= 4, `应导入至少 4 条记忆，实际 ${applied.imported.length}`)
  distillation = applied
})

await check('/state 暴露捕获状态与最近蒸馏画像', async () => {
  const current = await state()
  assert.equal(current.capture.enabled, false)
  assert.equal(current.capture.sessions >= 1, true, 'capture.sessions 应 >=1')
  assert.ok(current.distillation?.profile?.profile, 'state.distillation 应带画像')
})

await check('distill.list 能列历史', async () => {
  const list = await action('distill.list', { limit: 5 })
  assert.equal(list.ok, true, JSON.stringify(list))
  assert.ok((list.distillations || []).length >= 1)
  assert.ok(list.distillations[0].profile?.rules?.length >= 1)
})

await check('mirror_capture / mirror_distill 工具已注册', async () => {
  for (const name of ['mirror_capture', 'mirror_distill']) {
    assert.ok(tools.has(name), `缺少工具 ${name}`)
    assert.equal(typeof tools.get(name).execute, 'function')
  }
  const status = await tools.get('mirror_capture').execute({ action: 'status' })
  assert.equal(status.ok, true)
  assert.ok(/未开启|已关闭/.test(status.text), status.text)
})

// ---------------- 阶段三：打包带认知画像 ----------------
let packPath = ''
await check('pack.export：选中记忆 + 画像一起导出', async () => {
  const exported = await action('pack.export', {
    memoryIds: (distillation.imported || []).slice(0, 2),
    meta: { name: '带画像的包', version: '1.0.0', author: 'tester' },
  })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.hasProfile, true, '应带上最近一次蒸馏画像')
  packPath = exported.path
  const raw = JSON.parse(fs.readFileSync(packPath, 'utf8'))
  assert.ok(raw.profile && raw.profile.rules.length >= 1, '包内应有 profile 六段')
  assert.ok(Array.isArray(raw.memories), '包内应有 memories')
  assert.ok(!JSON.stringify(raw).includes('我习惯先写测试再实现'), '记忆包不应包含原始对话')
})

await check('pack.export：不勾「包含画像」时只导记忆', async () => {
  const exported = await action('pack.export', {
    memoryIds: (distillation.imported || []).slice(0, 1),
    includeProfile: false,
    meta: { name: '纯记忆包', version: '1.0.0' },
  })
  assert.equal(exported.ok, true, JSON.stringify(exported))
  assert.equal(exported.hasProfile, false, '不应包含画像')
  const raw = JSON.parse(fs.readFileSync(exported.path, 'utf8'))
  assert.equal(raw.profile, undefined)
})

await check('pack.import：识别画像并落成一条 distillation（source=pack）', async () => {
  const imported = await action('pack.import', { path: packPath, strategy: 'skip_conflicts' })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  assert.equal(imported.hasProfile, true, '导入应识别 profile')
  assert.ok(imported.distillationId, '应为画像落一条 distillation')
  const list = await action('distill.list', { limit: 5 })
  const packRow = (list.distillations || []).find((row) => row.source === 'pack')
  assert.ok(packRow, 'distill.list 应出现 source=pack 的画像')
  assert.ok(packRow.profile?.rules?.length >= 1)
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
