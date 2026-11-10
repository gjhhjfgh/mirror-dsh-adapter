/**
 * DSH 历史会话读取自测（多帧 zstd 解码 + 蒸馏数据源）。
 *
 * 造一个假的 DSH_HOME（sessions/<workspace>/<session>/session.v4.jsonl.zstd），
 * 用「每行一个独立 zstd frame」模拟 DSH 的 append-only 写法，验证：
 *   1. 帧扫描器能找出全部帧
 *   2. 解码后能解析出 user/assistant 文本（跳过 reasoning/tool-call）
 *   3. collectDshConversations 产出可直接蒸馏的会话
 *   4. distill.run(source='dsh') 能落库画像
 *
 * 运行：node tests/dsh-sessions.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-dshsess-'))
const dshHome = path.join(tmpRoot, 'dsh-home')
const dataDir = path.join(tmpRoot, 'mirror-data')
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

function writeSession({ workspace, sessionId, events }) {
  const dir = path.join(dshHome, 'sessions', `--${workspace}--`, `session-${sessionId}`)
  fs.mkdirSync(dir, { recursive: true })
  const frames = events.map((event) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

// 两个会话：一个有内容，一个只有头
writeSession({
  workspace: 'D-demo',
  sessionId: 'sess-a',
  events: [
    { type: 'session', version: 4, id: 'session-sess-a', createdAt: 1_700_000_000_000, cwd: 'D:\\demo' },
    { type: 'user/message', seq: 1, time: 1_700_000_001_000, data: { content: [{ type: 'text', text: '我习惯先写测试再实现' }] } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1_700_000_002_000,
      data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '内部思考不该被蒸馏' }, { type: 'text', text: '好的，先写测试。' }, { type: 'tool-call', name: 'fs' }] } },
    },
    { type: 'user/message', seq: 3, time: 1_700_000_003_000, data: { content: [{ type: 'text', text: '接口必须走 WebSocket，禁止 HTTP 轮询' }] } },
    { type: 'user/message', seq: 4, time: 1_700_000_004_000, data: { content: [{ type: 'text', text: '不要用 any' }] } },
  ],
})
writeSession({
  workspace: 'D-empty',
  sessionId: 'sess-b',
  events: [{ type: 'session', version: 4, id: 'session-sess-b', createdAt: 1_700_000_000_000, cwd: 'D:\\empty' }],
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

const dsh = await import('../core/dsh-sessions.js')
const fileA = path.join(dshHome, 'sessions', '--D-demo--', 'session-sess-a', 'session.v4.jsonl.zstd')

console.log('DSH 历史会话读取自测')
console.log(`  DSH_HOME：${dshHome}`)
console.log(`  数据目录：${dataDir}`)

await check('帧扫描器：5 个独立 frame 全部识别', async () => {
  const buffer = fs.readFileSync(fileA)
  const frames = dsh.scanZstdFrames(buffer)
  assert.equal(frames.length, 5, `期望 5 帧，实际 ${frames.length}`)
  assert.equal(frames[0].start, 0)
  assert.equal(frames[frames.length - 1].end, buffer.length, '最后一帧应到文件末尾')
})

await check('解码 + 解析：只取 text，跳过 reasoning/tool-call', async () => {
  const decoded = dsh.decodeSessionLog(fileA)
  assert.ok(decoded.text.length > 0)
  assert.ok(!decoded.text.includes('内部思考不该被蒸馏') || decoded.bytes > 0)
  const turns = dsh.parseSessionEvents(decoded.text)
  assert.equal(turns.length, 4, `期望 4 轮，实际 ${turns.length}`)
  assert.equal(turns[0].role, 'user')
  assert.equal(turns[1].role, 'assistant')
  assert.ok(turns[1].text.includes('先写测试'))
  assert.ok(!turns[1].text.includes('内部思考'), 'reasoning 不应进入文本')
  assert.ok(!JSON.stringify(turns).includes('tool-call'), 'tool-call 不应进入文本')
})

await check('listDshSessions：列出会话与工作区（不解压）', async () => {
  const list = dsh.listDshSessions({ dshHome })
  assert.equal(list.length, 2, `期望 2 个会话，实际 ${list.length}`)
  const first = list.find((item) => item.sessionId === 'sess-a')
  assert.ok(first, '缺少 sess-a')
  assert.equal(first.workspace, 'D-demo')
  assert.ok(first.bytes > 0)
  assert.equal(first.compressed, true)
})

await check('collectDshConversations：产出蒸馏可用会话', async () => {
  const conversations = dsh.collectDshConversations({ dshHome, maxSessions: 5, maxCharsPerSession: 10000 })
  assert.equal(conversations.length, 1, `只有 1 个会话有内容，实际 ${conversations.length}`)
  const conversation = conversations[0]
  assert.equal(conversation.sessionId, 'sess-a')
  assert.equal(conversation.source, 'dsh')
  assert.equal(conversation.turns, 4)
  assert.ok(conversation.text.includes('WebSocket'))
  assert.equal(conversation.cwd, 'D:\\demo')
})

await check('distill.run(source=dsh)：能从历史会话蒸馏并落库', async () => {
  const tools = new Map()
  const routes = []
  const fakeWebServer = { register(route) { routes.push(route); return () => {} } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (callback) => callback(),
    on: () => () => {},
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section: () => () => {} },
    inject: (deps, callback) => { if (deps.includes('webServer')) callback({ effect: (cb) => cb(), webServer: fakeWebServer }) },
  }
  const { apply } = await import('../lib/index.js')
  apply(ctx, { dataDir, dshHome, injectTokenBudget: 1200 })

  const route = routes.find((item) => item.path === '/mirror/api/action')
  assert.ok(route, '缺少 /action 路由')
  const call = (payload) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('route timeout')), 8000)
      const response = {
        statusCode: 0, headersSent: false, body: '',
        writeHead(status) { this.statusCode = status; this.headersSent = true },
        end(text) {
          clearTimeout(timer)
          try { resolve(JSON.parse(text)) } catch (error) { reject(error) }
        },
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

  const sources = await call({ type: 'distill.sources' })
  assert.equal(sources.ok, true, JSON.stringify(sources))
  assert.ok(sources.dsh.length >= 1, 'distill.sources 应列出 DSH 历史会话')
  assert.ok(sources.dsh.some((item) => item.sessionId === 'sess-a'))

  const prepared = await call({ type: 'distill.run', mode: 'prepare', source: 'dsh' })
  assert.equal(prepared.ok, true, JSON.stringify(prepared))
  assert.ok(prepared.sessions.some((item) => item.source === 'dsh'))
  assert.ok(String(prepared.prompt).includes('先写测试') || String(prepared.prompt).includes('WebSocket'))

  const applied = await call({
    type: 'distill.run',
    mode: 'apply',
    source: 'dsh',
    distillation: {
      profile: '偏好先测试后实现的后端工程师。',
      rules: ['接口必须走 WebSocket'],
      preferences: ['先写测试再实现'],
      avoid: ['不要用 any'],
      confidence: 0.7,
    },
  })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.phase, 'done')
  assert.ok(applied.id)

  const listed = await call({ type: 'distill.list' })
  assert.ok((listed.distillations || []).length >= 1)
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
