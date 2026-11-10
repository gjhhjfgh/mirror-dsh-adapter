/**
 * 基础能力回归：备份 / 恢复 / 诊断包 / 样例包一键导入。
 *
 * 1) createBackup 生成一致快照（VACUUM INTO）+ manifest，listBackups 能列出
 * 2) restoreBackup 恢复后数据回到备份点，且自动留一份 before-restore 安全副本
 * 3) 无效备份（缺 mirror.db）被拒绝
 * 4) 诊断包：只含统计/脱敏配置/日志，**不含任何记忆正文**
 * 5) 宿主 action：backup.* / diagnostics.export / pack.importSample
 *
 * 运行：node tests/backup-diagnostics.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-backup-'))
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
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

console.log('基础能力回归（备份 / 恢复 / 诊断 / 样例）')
console.log(`  临时目录：${tmpRoot}`)

const { openMirror } = await import('../core/index.js')
const { createBackup, listBackups, restoreBackup } = await import('../core/backup.js')
const { createDiagnostics, sanitizeConfig } = await import('../core/diagnostics.js')

await check('备份：生成快照目录 + manifest，且能列出', () => {
  const dataDir = path.join(tmpRoot, 'core')
  const mirror = openMirror({ dataDir })
  try {
    for (let index = 0; index < 3; index += 1) {
      mirror.memories.create({ category: 'preference', content: `备份测试记忆 ${index}`, authority: 'user_explicit' })
    }
    const backup = createBackup({ dataDir, db: mirror.store.db, note: '第一次备份', counts: { memories: 3 } })
    assert.ok(fs.existsSync(path.join(backup.path, 'mirror.db')), '应有 mirror.db')
    assert.ok(fs.existsSync(path.join(backup.path, 'manifest.json')), '应有 manifest')
    assert.ok(backup.bytes > 0)
    const list = listBackups({ dataDir })
    assert.equal(list.length, 1)
    assert.equal(list[0].name, backup.name)
    assert.equal(list[0].valid, true)
    assert.equal(list[0].note, '第一次备份')
  } finally {
    mirror.store.close()
  }
})

await check('恢复：数据回到备份点，并留 before-restore 安全副本', () => {
  const dataDir = path.join(tmpRoot, 'core')
  const mirror = openMirror({ dataDir })
  // 备份之后又写一条
  mirror.memories.create({ category: 'preference', content: '备份之后新增的记忆', authority: 'user_explicit' })
  const before = mirror.memories.list({ status: 'active', limit: 100 }).length
  mirror.store.close()

  const name = listBackups({ dataDir })[0].name
  const restored = restoreBackup({ dataDir, backup: name })
  assert.ok(fs.existsSync(restored.safetyCopy), '应留下 before-restore 副本')

  const reopened = openMirror({ dataDir })
  try {
    const after = reopened.memories.list({ status: 'active', limit: 100 }).length
    assert.ok(after < before, `恢复后应回到备份点（${after} < ${before}）`)
    const contents = reopened.memories.list({ status: 'active', limit: 100 }).map((memory) => memory.content)
    assert.ok(!contents.includes('备份之后新增的记忆'), '备份后新增的记忆应消失')
    assert.equal(after, 3, `应恢复为 3 条，实际 ${after}`)
  } finally {
    reopened.store.close()
  }
})

await check('恢复：无效备份（缺 mirror.db）被拒绝', () => {
  const dataDir = path.join(tmpRoot, 'core')
  const bogus = path.join(dataDir, 'backups', 'bogus')
  fs.mkdirSync(bogus, { recursive: true })
  assert.throws(() => restoreBackup({ dataDir, backupPath: bogus }), /备份无效/)
})

await check('诊断包：生成 json+md，只含统计/脱敏配置/日志', () => {
  const dataDir = path.join(tmpRoot, 'diag')
  const result = createDiagnostics({
    dataDir,
    version: '2.2.0',
    summary: { memories: 12, documents: 3, chunks: 180 },
    logs: [{ level: 'warn', message: '示例警告' }],
    config: { dataDir: 'C:\\Users\\someone\\AppData\\mirror', injectTokenBudget: 3000 },
  })
  assert.ok(fs.existsSync(result.jsonPath))
  assert.ok(fs.existsSync(result.mdPath))
  const json = fs.readFileSync(result.jsonPath, 'utf8')
  assert.ok(json.includes('"version": "2.2.0"'))
  assert.ok(json.includes('示例警告'))
  assert.ok(!json.includes('C:\\\\Users\\\\someone'), '配置里的完整路径应被脱敏')
  const md = fs.readFileSync(result.mdPath, 'utf8')
  assert.ok(md.includes('不含记忆/文档/对话正文'))
})

await check('sanitizeConfig：路径只留最后一段', () => {
  const clean = sanitizeConfig({ dataDir: 'D:\\deep\\mirror\\data', injectTokenBudget: 3000 })
  assert.equal(clean.injectTokenBudget, 3000)
  assert.ok(!String(clean.dataDir).includes('D:\\deep'), clean.dataDir)
  assert.ok(String(clean.dataDir).includes('data'), clean.dataDir)
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
apply(ctx, { dataDir: path.join(tmpRoot, 'host'), injectTokenBudget: 1500 })

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

const SAMPLE_CREATED = await call({ type: 'pack.importSample' })
await check('action pack.importSample：一键导入样例包', () => {
  assert.equal(SAMPLE_CREATED.ok, true, JSON.stringify(SAMPLE_CREATED))
  assert.ok(Number(SAMPLE_CREATED.created ?? 0) >= 5, `应导入 ≥5 条，实际 ${SAMPLE_CREATED.created}`)
  assert.equal(SAMPLE_CREATED.hasProfile, true, '样例包应带画像')
})

const backup = await call({ type: 'backup.create', note: '宿主层备份' })
const list = await call({ type: 'backup.list' })
await check('action backup.create / backup.list', () => {
  assert.equal(backup.ok, true, JSON.stringify(backup))
  assert.equal(list.ok, true, JSON.stringify(list))
  assert.ok(list.backups.some((item) => item.name === backup.name))
  assert.ok(list.backups[0].counts.memories >= 5)
})

await check('action diagnostics.export：生成诊断包且不含记忆正文', async () => {
  const diagnostic = await call({ type: 'diagnostics.export' })
  assert.equal(diagnostic.ok, true, JSON.stringify(diagnostic))
  assert.ok(fs.existsSync(diagnostic.jsonPath))
  const json = fs.readFileSync(diagnostic.jsonPath, 'utf8')
  assert.ok(json.includes('"version"'))
  assert.ok(!json.includes('样例'), '诊断包不应包含记忆/文档正文')
})

await check('action backup.restore：恢复到备份点', async () => {
  // 备份之后再写一条，然后恢复
  const created = await call({ type: 'memory.create', category: 'preference', content: '恢复前新增的记忆', scope: 'global' })
  assert.equal(created.ok, true, JSON.stringify(created))
  const restored = await call({ type: 'backup.restore', name: backup.name })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  const state = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('state timeout')), 8000)
    const stateRoute = routes.find((item) => item.path === '/mirror/api/state')
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
    stateRoute.handler(request, response)
  })
  const contents = (state.memories || []).map((memory) => memory.content)
  assert.ok(!contents.includes('恢复前新增的记忆'), '恢复后新增的记忆应消失')
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
