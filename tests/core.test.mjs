/**
 * tests/core.test.mjs —— Mirror 内核自测
 *
 * 运行：node --test tests/core.test.mjs
 * 所有数据目录都在 os.tmpdir() 下，测试结束即删除，绝不触碰 ~/.mirror。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  openMirror,
  estimateTokens,
  retrieve,
  buildInjection,
  heuristicExtract,
  parseExtraction,
  fillPrompt,
  EXTRACT_PROMPT,
  isOpposite,
  containsWord,
  splitQueryTerms,
  reviewRelation,
} from '../core/index.js'

const stats = { passed: 0, failed: 0 }

/** 每个用例独立 try/catch，保证「清晰的成功/失败摘要」 */
function runCase(name, fn) {
  test(name, async () => {
    try {
      await fn()
      stats.passed += 1
      console.log(`✅ ${name}`)
    } catch (err) {
      stats.failed += 1
      console.log(`❌ ${name}`)
      console.log(`   原因：${err && err.message ? err.message : err}`)
      throw err
    }
  })
}

function tempDir(prefix = 'mirror-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 建实例 → 跑用例 → 关库 → 删临时目录 */
function withMirror(fn) {
  const dir = tempDir()
  const mirror = openMirror({ dataDir: dir })
  try {
    return fn(mirror, dir)
  } finally {
    try {
      mirror.store.close()
    } catch {
      // 忽略关闭错误
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const DAY = 24 * 60 * 60 * 1000

// ====================================================================== 1. 迁移

runCase('迁移幂等：同一 dataDir 打开两次不报错、不丢数据', () => {
  const dir = tempDir()
  try {
    const first = openMirror({ dataDir: dir })
    assert.equal(typeof first.store.close, 'function')
    assert.equal(typeof first.store.now(), 'number')
    assert.equal(path.isAbsolute(first.store.dataDir), true)
    const created = first.memories.create({ content: '迁移幂等测试：必须保留这条记忆', category: 'iron_rule' })
    assert.equal(created.duplicate, false)
    // 顺手确认所有表都建出来了
    const tables = first.store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((row) => row.name)
    for (const expected of [
      'memories',
      'conflicts',
      'decision_chains',
      'deletion_log',
      'staleness_checks',
      'documents',
      'document_chunks',
      'doc_memory_links',
      'doc_change_queue',
      'installed_packs',
      'pack_update_check',
      'doc_roots',
    ]) {
      assert.ok(tables.includes(expected), `缺少表 ${expected}`)
    }
    assert.equal(Number(first.store.db.prepare('PRAGMA user_version').get().user_version), 1)
    first.store.close()

    // 第二次打开：不报错、数据在、还能继续写
    const second = openMirror({ dataDir: dir })
    assert.equal(second.memories.list().length, 1)
    second.memories.create({ content: '第二次打开后追加的偏好', category: 'preference' })
    assert.equal(second.memories.list().length, 2)
    second.store.close()

    // 第三次打开：数据累积正确
    const third = openMirror({ dataDir: dir })
    assert.equal(third.memories.list().length, 2)
    assert.equal(third.documents.list().length, 0)
    assert.equal(third.packs.list().length, 0)
    third.store.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ====================================================================== 2. 记忆 CRUD

runCase('记忆 create/list/get/update/confirm/freeze/invalidate/remove/stats', () => {
  withMirror((m) => {
    const created = m.memories.create({ content: '偏好用 pnpm 安装依赖', category: 'preference', tags: ['pnpm', '工具'] })
    const mem = created.memory
    assert.equal(created.duplicate, false)
    assert.equal(mem.category, 'preference')
    assert.equal(mem.layer, 'strategy')
    assert.equal(mem.authority, 'user_explicit')
    assert.equal(mem.confidence, 1)
    assert.equal(mem.scope, 'global')
    assert.equal(mem.status, 'active')
    assert.equal(mem.frozen, false)
    assert.deepEqual(mem.tags, ['pnpm', '工具'])
    assert.equal(typeof mem.createdAt, 'number')
    assert.equal(typeof mem.validFrom, 'number')
    assert.ok(mem.createdAt > 0)

    // get 命中会 +1 accessCount
    const got = m.memories.get(mem.id)
    assert.equal(got.accessCount, 1)
    assert.ok(got.lastAccessedAt)
    assert.equal(m.memories.get('mem_not_exists'), null) // 不存在的 id → null

    // list 默认只返回 active，且不更新访问计数
    const listed = m.memories.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].accessCount, 1)

    // update
    const updated = m.memories.update(mem.id, {
      content: '偏好用 pnpm 安装依赖（所有项目）',
      confidence: 0.9,
      tags: 'pnpm,node',
    })
    assert.equal(updated.memory.confidence, 0.9)
    assert.deepEqual(updated.memory.tags, ['pnpm', 'node'])
    assert.ok(updated.memory.lastVerifiedAt)
    assert.equal(updated.memory.userModified, true)

    // confirm：authority 升级、置信度下限 0.9
    const confirmed = m.memories.confirm(mem.id)
    assert.equal(confirmed.memory.authority, 'user_confirmed')
    assert.ok(confirmed.memory.confidence >= 0.9)

    // freeze / 解冻
    assert.equal(m.memories.freeze(mem.id, true).memory.frozen, true)
    assert.equal(m.memories.freeze(mem.id, false).memory.frozen, false)

    // invalidate：保留审计
    const invalidated = m.memories.invalidate(mem.id, { reason: '测试失效' })
    assert.equal(invalidated.memory.status, 'superseded')
    assert.ok(invalidated.memory.validTo)
    assert.equal(invalidated.memory.invalidReason, '测试失效')

    // stats
    const s = m.memories.stats()
    assert.equal(s.memories, 1)
    assert.equal(s.active, 0)
    assert.equal(s.superseded, 1)
    assert.deepEqual(Object.keys(s.byCategory).sort(), ['decision', 'fuzzy', 'iron_rule', 'pitfall', 'preference'])

    // remove：硬删 + 传播日志
    const other = m.memories.create({ content: '另一条待删除的模糊记忆', category: 'fuzzy' })
    const removed = m.memories.remove(other.memory.id)
    assert.equal(removed.deleted, true)
    assert.equal(removed.propagation.propagationStatus, 'complete')
    assert.equal(m.memories.get(other.memory.id), null)
    assert.equal(m.memories.list({ status: 'all' }).length, 1)
    const log = m.store.db.prepare('SELECT * FROM deletion_log WHERE memory_id = ?').get(other.memory.id)
    assert.ok(log, 'deletion_log 应有一条记录')
    assert.equal(log.propagation_status, 'complete')
    const affected = JSON.parse(log.affected_stores)
    assert.equal(affected.cache, true)
    // FTS 同步：删掉的记忆不该再被搜到
    assert.equal(m.memories.search({ q: '待删除' }).length, 0)

    // 返回值必须可 JSON.stringify（Date→数字、布尔→真布尔）
    assert.doesNotThrow(() => JSON.stringify(m.memories.list({ status: 'all' })))
  })
})

// ====================================================================== 3. 去重

runCase('去重：完全重复 → duplicate，不重复写库', () => {
  withMirror((m) => {
    const a = m.memories.create({ content: '不要用 any，用 unknown + 类型守卫', category: 'iron_rule' })
    // 归一化后完全相同（大小写 / 空白 / 标点差异）
    const b = m.memories.create({ content: '不要用 ANY，用 unknown + 类型守卫。', category: 'iron_rule' })
    assert.equal(b.duplicate, true)
    assert.equal(b.memory.id, a.memory.id)
    assert.equal(m.memories.list().length, 1)

    // 高度相似（0.75–0.9）且新条目更权威 → 覆盖式升级
    const low = m.memories.create({
      content: '项目里统一用 npm 安装依赖包',
      category: 'decision',
      authority: 'inferred',
      confidence: 0.6,
    })
    const high = m.memories.create({
      content: '项目里统一用 pnpm 安装依赖包',
      category: 'decision',
      authority: 'user_explicit',
      confidence: 1,
    })
    assert.equal(high.duplicate, false)
    assert.notEqual(high.memory.id, low.memory.id)
    const oldRow = m.memories.get(low.memory.id)
    assert.equal(oldRow.status, 'superseded')
    assert.equal(oldRow.supersededBy, high.memory.id)
    const decisionActive = m.memories.list({ category: 'decision' })
    assert.equal(decisionActive.length, 1)
    assert.equal(decisionActive[0].id, high.memory.id)
  })
})

// ====================================================================== 4. 冲突

runCase('冲突：同 scope 同 category 相反铁律 → contradiction，分数接近 → 需用户裁决', () => {
  withMirror((m) => {
    const a = m.memories.create({ content: '接口必须走 WebSocket，HTTP 会丢消息', category: 'iron_rule' })
    const b = m.memories.create({ content: '接口禁止走 WebSocket', category: 'iron_rule' })
    assert.ok(b.conflicts.length >= 1, '应检测到冲突')
    const conflict = b.conflicts[0]
    assert.equal(conflict.conflictType, 'contradiction')
    assert.equal(conflict.resolved, false)
    assert.match(conflict.reason, /需用户裁决/)

    // 两条都是 user_explicit/confidence=1 → 分数完全接近 → 需用户裁决
    const decision = m.arbiter.resolve(a.memory, b.memory)
    assert.equal(decision.needsUserConfirmation, true)
    assert.equal(decision.winnerId, null)
    assert.ok(decision.scoreA > 0 && decision.scoreA <= 1)

    // 不同 scope + 不同 category → 不建冲突
    const independent = m.memories.create({
      content: '部署前必须跑一遍端到端测试',
      category: 'pitfall',
      scope: 'project:web',
    })
    assert.equal(independent.conflicts.length, 0)

    // 冲突列表附带 a / b 两条记忆
    const list = m.memories.listConflicts()
    assert.ok(list.length >= 1)
    assert.ok(list[0].a && list[0].b, 'listConflicts 应附带 a / b')
    assert.equal(list[0].resolved, false)

    // 裁决 winner_a → memory_b 置 superseded（本用例里 memory_a 是新条目 b，memory_b 是旧条目 a）
    assert.equal(conflict.memoryA, b.memory.id)
    assert.equal(conflict.memoryB, a.memory.id)
    const resolved = m.memories.resolveConflict(conflict.id, { resolution: 'winner_a', reason: '测试裁决' })
    assert.equal(resolved.resolved, true)
    assert.equal(resolved.resolution, 'winner_a')
    assert.equal(resolved.resolutionReason, '测试裁决')
    const loser = m.memories.get(a.memory.id)
    assert.equal(loser.status, 'superseded')
    assert.equal(loser.supersededBy, b.memory.id)
    assert.equal(m.memories.get(b.memory.id).status, 'active')
    // 裁决后待确认清零
    assert.equal(m.memories.listConflicts().length, 0)
    assert.equal(m.memories.stats().pendingConfirm, 0)
  })
})

// ====================================================================== 5. 文档库

runCase('文档库：addRoot+scan → 切片（heading_path / function）→ 中英文检索 → 增量 → 删除', () => {
  const root = tempDir('mirror-docs-')
  const docsDir = path.join(root, 'docs')
  fs.mkdirSync(docsDir, { recursive: true })
  fs.writeFileSync(
    path.join(docsDir, 'guide.md'),
    ['# 指南', '', '## 安装', '', '安装 Mirror 需要 Node 24 环境。', '', '## 使用', '', '调用 openMirror 打开内核。'].join('\n'),
    'utf8',
  )
  fs.writeFileSync(
    path.join(root, 'src.ts'),
    ['export function add(a: number, b: number) {', '  return a + b', '}', '', 'export class Counter {', '  inc() { return 1 }', '}'].join('\n'),
    'utf8',
  )
  fs.writeFileSync(path.join(root, 'notes.txt'), '第一段内容。\n\n第二段内容。', 'utf8')
  fs.writeFileSync(path.join(root, 'skip.pdf'), '%PDF-1.4 fake', 'utf8')

  try {
    withMirror((m) => {
      // addRoot：不存在目录要报中文错误
      assert.throws(() => m.documents.addRoot(path.join(root, '不存在的目录')), /目录不存在/)
      const roots = m.documents.addRoot(root)
      assert.equal(roots.length, 1)
      assert.equal(roots[0].path, path.resolve(root))

      const scan1 = m.documents.scan()
      assert.equal(scan1.errors.length, 0, JSON.stringify(scan1.errors))
      assert.equal(scan1.added, 3, `新增 3 个（md/ts/txt），实际 ${scan1.added}`)
      assert.equal(scan1.truncated, false)

      const docs = m.documents.list()
      const md = docs.find((d) => d.filePath.endsWith('guide.md'))
      assert.ok(md, '应有 guide.md')
      assert.equal(md.chunkCount, 3)
      assert.equal(md.fileType, 'md')
      assert.equal(md.relativePath, 'docs/guide.md')

      const mdDetail = m.documents.get(md.id)
      assert.equal(mdDetail.chunks.length, 3)
      const installChunk = mdDetail.chunks.find((c) => c.headingPath === '指南 > 安装')
      assert.ok(installChunk, JSON.stringify(mdDetail.chunks.map((c) => c.headingPath)))
      assert.match(installChunk.content, /安装 Mirror 需要 Node 24/)
      assert.ok(mdDetail.chunks.every((c) => c.content.length <= 1600))

      const ts = docs.find((d) => d.filePath.endsWith('src.ts'))
      const tsDetail = m.documents.get(ts.id)
      const fnChunk = tsDetail.chunks.find((c) => c.chunkType === 'function')
      const classChunk = tsDetail.chunks.find((c) => c.chunkType === 'class')
      assert.ok(fnChunk, '代码应有 function 切片')
      assert.ok(classChunk, '代码应有 class 切片')
      assert.ok(fnChunk.startLine >= 1 && fnChunk.endLine >= fnChunk.startLine)

      // pdf → status='error'，不抛
      const pdf = docs.find((d) => d.filePath.endsWith('skip.pdf'))
      assert.equal(pdf.status, 'error')
      assert.equal(pdf.errorMessage, 'pdf unsupported in v1')

      // 2 字中文查询（trigram 不支持，必须 LIKE 兜底）
      const short = m.documents.search({ q: '安装' })
      assert.ok(short.length >= 1, '2 字查询应命中')
      assert.ok(short[0].chunk && short[0].document && typeof short[0].score === 'number')

      // 3 字以上中文查询（trigram MATCH）
      const long = m.documents.search({ q: '安装 Mirror' })
      assert.ok(long.length >= 1, '3 字以上查询应命中')

      // 英文标识符
      const en = m.documents.search({ q: 'openMirror' })
      assert.ok(en.length >= 1, '英文查询应命中')

      // scope 过滤不应报错
      assert.ok(Array.isArray(m.documents.search({ q: '安装', scope: 'project:other' })))

      // 增量：只改 src.ts → 只更新它
      fs.writeFileSync(
        path.join(root, 'src.ts'),
        ['export function mul(a: number, b: number) {', '  return a * b', '}'].join('\n'),
        'utf8',
      )
      const scan2 = m.documents.scan()
      assert.equal(scan2.updated, 1, `应只更新 1 个文件，实际 ${scan2.updated}`)
      assert.equal(scan2.added, 0)
      assert.equal(scan2.skipped, 3) // guide.md / notes.txt / skip.pdf
      assert.ok(m.documents.search({ q: 'mul' }).length >= 1, '改后的内容应可检索')

      // 文件消失 → status='deleted'，chunks 清理
      fs.rmSync(path.join(root, 'notes.txt'))
      const scan3 = m.documents.scan()
      assert.equal(scan3.removed, 1, `应删除 1 个文件，实际 ${scan3.removed}`)
      const afterList = m.documents.list()
      assert.equal(afterList.some((d) => d.filePath.endsWith('notes.txt')), false)
      const deletedRow = m.store.db
        .prepare('SELECT * FROM documents WHERE file_path = ?')
        .get(path.join(root, 'notes.txt'))
      assert.equal(deletedRow.status, 'deleted')
      const deletedChunks = m.store.db
        .prepare('SELECT count(*) AS c FROM document_chunks WHERE document_id = ?')
        .get(deletedRow.id)
      assert.equal(deletedChunks.c, 0)

      // 变更队列：全部处理完，不留 pending
      assert.equal(m.store.db.prepare(`SELECT count(*) AS c FROM doc_change_queue WHERE status = 'pending'`).get().c, 0)
      assert.ok(m.store.db.prepare('SELECT count(*) AS c FROM doc_change_queue').get().c >= 4)

      // 文档统计
      const docStats = m.documents.stats()
      assert.equal(docStats.roots, 1)
      assert.ok(docStats.chunks >= 4)
      assert.equal(docStats.pending, 0)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ====================================================================== 5b. 文档联动

runCase('文档驱动复核：内容变了 → doc_memory_links + doc_updated 冲突（对端 doc:<id>）', () => {
  const root = tempDir('mirror-docreview-')
  try {
    const file = path.join(root, 'start.md')
    fs.writeFileSync(file, '# 启动\n\nGodot 必须用 godot_* 工具启动\n', 'utf8')
    withMirror((m) => {
      const mem = m.memories.create({ content: 'Godot 必须用 godot_* 工具启动', category: 'iron_rule' })
      m.documents.addRoot(root)
      const scan1 = m.documents.scan()
      assert.equal(scan1.added, 1)

      // 改写成相反的说法（仍包含原记忆文本 → containment 高，语义相反）
      fs.writeFileSync(
        file,
        '# 启动\n\nGodot 必须用 godot_* 工具启动？不，Godot 禁止用 godot_* 工具启动，只能在 shell 里跑。\n',
        'utf8',
      )
      m.documents.scan()

      const links = m.store.db.prepare('SELECT * FROM doc_memory_links').all()
      assert.ok(links.length >= 1, '应建立文档-记忆关联')
      assert.ok(links.some((l) => l.relation === 'contradicts'), '应标记为 contradicts')

      const docConflicts = m.memories.listConflicts().filter((c) => c.conflictType === 'doc_updated')
      assert.ok(docConflicts.length >= 1, '应写 doc_updated 冲突')
      const docConflict = docConflicts[0]
      assert.equal(docConflict.memoryA, mem.memory.id)
      assert.match(docConflict.memoryB, /^doc:/)
      assert.equal(docConflict.detectedBy, 'doc_updated')
      // 对端是 doc:<id> 时 b 为 null，但 a 是真实记忆
      assert.equal(docConflict.b, null)
      assert.equal(docConflict.a.id, mem.memory.id)
      assert.doesNotThrow(() => JSON.stringify(docConflicts))

      // 对 doc 冲突做裁决：只写冲突状态，不动文档
      const resolved = m.memories.resolveConflict(docConflict.id, { resolution: 'winner_a', reason: '以记忆为准' })
      assert.equal(resolved.resolved, true)
      assert.equal(m.documents.list().length, 1)
      assert.equal(m.documents.list()[0].status, 'active')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

runCase('文档扫描：忽略 node_modules / .mirrorignore，扫描上限与列表接口安全', () => {
  const root = tempDir('mirror-docs2-')
  try {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'fake.md'), '# 依赖里的文档', 'utf8')
    fs.mkdirSync(path.join(root, 'secret'), { recursive: true })
    fs.writeFileSync(path.join(root, 'secret', 'private.md'), '# 秘密内容', 'utf8')
    fs.writeFileSync(path.join(root, '.mirrorignore'), '# 排除规则\nsecret/\n*.draft.md\n', 'utf8')
    fs.writeFileSync(path.join(root, 'draft.draft.md'), '# 草稿', 'utf8')
    fs.writeFileSync(path.join(root, 'keep.md'), '# 保留\n\n这段内容应该被索引。', 'utf8')

    withMirror((m) => {
      m.documents.addRoot(root)
      const scan = m.documents.scan()
      assert.equal(scan.added, 1, `只应索引 keep.md，实际 ${scan.added}`)
      const list = m.documents.list({ limit: 10 })
      assert.equal(list.length, 1)
      assert.equal(list[0].filePath, path.join(root, 'keep.md'))
      // 一次空 q 的 list 调用不能抛错（面板传 limit 不传 q）
      assert.doesNotThrow(() => m.documents.list())
      // q 只过滤文件路径（内容检索走 search）
      assert.equal(m.documents.list({ q: 'keep' }).length, 1)
      assert.equal(m.documents.list({ q: '不存在的文件名' }).length, 0)
      // roots 增删：remove 只解除监听，不删 document 记录
      const afterRemove = m.documents.removeRoot(root)
      assert.equal(afterRemove.length, 0)
      assert.equal(m.documents.list().length, 1)
      // 再添加回来（addRoot 幂等）
      m.documents.addRoot(root)
      assert.equal(m.documents.listRoots().length, 1)
      // 额外方法 remove(id)：只删索引，不删磁盘文件
      const keepDoc = m.documents.list()[0]
      const removedDoc = m.documents.remove(keepDoc.id)
      assert.equal(removedDoc.deleted, true)
      assert.equal(removedDoc.chunks >= 1, true)
      assert.equal(m.documents.list().length, 0)
      assert.equal(
        m.store.db.prepare('SELECT count(*) AS c FROM document_chunks WHERE document_id = ?').get(keepDoc.id).c,
        0,
      )
      assert.equal(fs.existsSync(path.join(root, 'keep.md')), true)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ====================================================================== 5d. R1 修复（契约 §10）

runCase('§10.1 语义相反收紧：配对词必须过主题门槛、拉丁词按词边界', () => {
  // 真相反：共享主题（WebSocket / 接口）
  assert.equal(isOpposite('接口必须走 WebSocket', '接口不要走 WebSocket，用 HTTP'), true)
  // 真相反：同一件事换工具（pnpm vs npm）
  assert.equal(isOpposite('用 pnpm 装依赖', '用 npm 装依赖'), true)
  // 反例（P0-1）：只命中 必须/禁止，主题毫无交集
  assert.equal(isOpposite('改完 lib/client.js 必须重启进程', '接口禁止用 HTTP 轮询'), false)
  // 反例：同一个词、不同主题（装依赖 vs 跑测试）
  assert.equal(isOpposite('用 pnpm 装依赖', '用 pnpm 跑测试'), false)
  // 拉丁词边界：npm 不命中 pnpm，http 不命中 https / http2
  assert.equal(containsWord('用 pnpm 装依赖', 'npm'), false)
  assert.equal(containsWord('用 pnpm 装依赖', 'pnpm'), true)
  assert.equal(containsWord('访问 https 接口', 'http'), false)
  assert.equal(containsWord('走 http2 协议', 'http'), false)
  assert.equal(containsWord('走 http 协议', 'http'), true)
  // 完全相同不算相反
  assert.equal(isOpposite('同一条记忆', '同一条记忆'), false)
})

runCase('§10.1 R2 收紧：单个 2 字中文词（「仓库」）不足以判矛盾', () => {
  // 真实实例回归：A/B 只共享「仓库」这一个 2-gram，叠加 必须/禁止 就误判了
  const ruleA = '必须用 pnpm 管理依赖，禁止在仓库里混用 npm 与 yarn'
  const ruleB = '禁止把 .env 和密钥文件提交到仓库，用 .gitignore 拦住'
  assert.equal(isOpposite(ruleA, ruleB), false, '只共享「仓库」不能判矛盾')
  // 与已播种的 DSH 铁律（含「必须重启进程」）之间也不能有冲突
  const seeded =
    'DSH 客户端插件（dsh.client）只在 dsh web 进程启动时编入 window.__DSH_BOOT__：' +
    '改完 lib/client.js 必须重启进程，让用户刷新页面是不够的。'
  assert.equal(isOpposite(ruleA, seeded), false)
  assert.equal(isOpposite(ruleB, seeded), false)

  // 别收过头：这些必须仍为 true
  assert.equal(
    isOpposite('接口必须走 WebSocket，禁止 HTTP 轮询', '接口不要走 WebSocket，用 HTTP 轮询更简单'),
    true,
    '共享 websocket/http/接口/轮询，且有长度 >=3 的词',
  )
  assert.equal(isOpposite('用 pnpm 装依赖', '用 npm 装依赖'), true)
  // 已修好的反例继续保留
  assert.equal(isOpposite('改完 lib/client.js 必须重启进程', '接口禁止用 HTTP 轮询'), false)
})

runCase('§10.1 R2 集成：A/B/已播种铁律同库并存时不建冲突', () => {
  withMirror((m) => {
    const seeded = m.memories.create({
      content:
        'DSH 客户端插件（dsh.client）只在 dsh web 进程启动时编入 window.__DSH_BOOT__：' +
        '改完 lib/client.js 必须重启进程，让用户刷新页面是不够的。',
      category: 'iron_rule',
    })
    const ruleA = m.memories.create({
      content: '必须用 pnpm 管理依赖，禁止在仓库里混用 npm 与 yarn',
      category: 'iron_rule',
    })
    const ruleB = m.memories.create({
      content: '禁止把 .env 和密钥文件提交到仓库，用 .gitignore 拦住',
      category: 'iron_rule',
    })
    assert.equal(seeded.conflicts.length, 0)
    assert.equal(ruleA.conflicts.length, 0, 'A 与已播种铁律不得判矛盾')
    assert.equal(ruleB.conflicts.length, 0, 'B 与 A / 已播种铁律不得判矛盾')
    assert.equal(m.memories.list({ status: 'active' }).length, 3)
    assert.equal(m.memories.stats().pendingConfirm, 0)
    assert.equal(m.memories.listConflicts().length, 0)
  })
})

runCase('§10.1 集成：无关铁律不再建假冲突、真记忆不会被误 supersede', () => {
  withMirror((m) => {
    const a = m.memories.create({ content: '改完 lib/client.js 必须重启进程', category: 'iron_rule' })
    const b = m.memories.create({ content: '接口禁止用 HTTP 轮询', category: 'iron_rule' })
    assert.equal(b.conflicts.length, 0, '无关铁律不应建冲突')
    // P0-1 的伤害是「点 A 优先 → 真记忆被 supersede」；没有冲突就不会有这个按钮
    assert.equal(m.memories.get(a.memory.id).status, 'active')
    assert.equal(m.memories.get(b.memory.id).status, 'active')
    assert.equal(m.memories.stats().pendingConfirm, 0)
  })
  withMirror((m) => {
    m.memories.create({ content: '接口必须走 WebSocket', category: 'iron_rule' })
    const opposite = m.memories.create({ content: '接口不要走 WebSocket，用 HTTP', category: 'iron_rule' })
    assert.ok(opposite.conflicts.length >= 1, '真相反应仍然建冲突')
    assert.equal(opposite.conflicts[0].conflictType, 'contradiction')
  })
})

runCase('§10.2 splitQueryTerms：拉丁词 + 中文整串 + 相邻 2-gram，去重保序 ≤12', () => {
  const terms = splitQueryTerms('安装依赖怎么跑')
  assert.ok(terms.includes('安装依赖怎么跑'))
  assert.ok(terms.includes('安装'))
  assert.ok(terms.includes('装依'))
  assert.ok(terms.includes('依赖'))
  assert.ok(terms.includes('怎么'))
  assert.ok(terms.length <= 12)
  assert.deepEqual(splitQueryTerms('pnpm install'), ['pnpm', 'install'])
  assert.deepEqual(splitQueryTerms('用 pnpm 装依赖'), ['pnpm', '装依赖', '装依', '依赖'])
  assert.deepEqual(splitQueryTerms('   '), [])
  assert.deepEqual(splitQueryTerms(''), [])
  // 去重保序
  const dup = splitQueryTerms('依赖 依赖')
  assert.equal(dup.filter((term) => term === '依赖').length, 1)
  // 上限 12
  const long = splitQueryTerms('这是一段特别长的中文查询句子用来验证词项数量上限是否生效')
  assert.ok(long.length <= 12)
})

runCase('§10.2 自然语言检索：「安装依赖怎么跑」能命中，无词项重叠返回空', () => {
  const root = tempDir('mirror-nlsearch-')
  try {
    fs.writeFileSync(path.join(root, 'a.md'), '# 安装依赖怎么跑\n\n执行 pnpm install 安装依赖即可。\n', 'utf8')
    fs.writeFileSync(path.join(root, 'b.md'), '# 依赖安装\n\n先安装依赖，然后启动。\n', 'utf8')
    withMirror((m) => {
      m.documents.addRoot(root)
      const scan = m.documents.scan()
      assert.equal(scan.errors.length, 0, JSON.stringify(scan.errors))

      // 自然语言问句 → 命中（修复前整句短语匹配是 0 命中）
      const hits = m.documents.search({ q: '安装依赖怎么跑' })
      assert.ok(hits.length >= 1, '自然语言问句应有命中')
      assert.equal(hits[0].document.relativePath, 'a.md', '命中词项更多的文档应排第一')
      assert.ok(hits.every((hit) => hit.score > 0 && hit.score <= 1))

      // 英文命令式查询
      assert.ok(m.documents.search({ q: 'pnpm install' }).length >= 1)
      // 纯自然语言但词项完全不重叠 → 空（2-gram 有交集时会命中，属预期召回）
      assert.equal(m.documents.search({ q: '缓存预热策略' }).length, 0)
      // 短查询仍然走 LIKE
      assert.ok(m.documents.search({ q: '安装' }).length >= 1)
      // limit 生效、返回结构不变
      const limited = m.documents.search({ q: '安装依赖怎么跑', limit: 1 })
      assert.equal(limited.length, 1)
      assert.deepEqual(Object.keys(limited[0]).sort(), ['chunk', 'document', 'score'])
      // list({q}) 仍然只匹配路径
      assert.equal(m.documents.list({ q: 'a.md' }).length, 1)
      assert.equal(m.documents.list({ q: '安装依赖' }).length, 0)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

runCase('§10.2 注入预算：文档命中变多时仍然按分层预算截断', () => {
  const root = tempDir('mirror-budget-')
  try {
    const sections = []
    for (let i = 0; i < 40; i += 1) {
      sections.push(`## 安装依赖第 ${i} 节\n\n这里是第 ${i} 段关于安装依赖的详细说明，内容重复用于撑大文档体积。\n`)
    }
    fs.writeFileSync(path.join(root, 'big.md'), sections.join('\n'), 'utf8')
    withMirror((m) => {
      m.documents.addRoot(root)
      m.documents.scan()
      assert.ok(m.documents.search({ q: '安装依赖怎么跑', limit: 30 }).length >= 5)
      const result = retrieve({
        memories: m.memories,
        documents: m.documents,
        query: '安装依赖怎么跑',
        scope: 'global',
        tokenBudget: 600,
      })
      assert.ok(result.documents.length >= 1, '应有文档命中')
      assert.ok(result.documents.length < 40, '文档层应被预算截断')
      const built = buildInjection(result)
      assert.ok(built.token_count <= 600, `注入超预算：${built.token_count}`)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

runCase('§10.3 listLinks：关联视图字段、relation 过滤、detectedAt 倒序、limit 上限 500', () => {
  const root = tempDir('mirror-links-')
  const file = path.join(root, 'start.md')
  fs.writeFileSync(file, '# 启动\n\nGodot 必须用 godot_* 工具启动\n', 'utf8')
  try {
    withMirror((m) => {
      const mem = m.memories.create({ content: 'Godot 必须用 godot_* 工具启动', category: 'iron_rule' })
      m.documents.addRoot(root)
      m.documents.scan()
      // 第二次索引内容变化 → 触发文档驱动复核（契约 §3：chunk 变化时才比对记忆）
      fs.writeFileSync(
        file,
        '# 启动\n\nGodot 必须用 godot_* 工具启动？不，Godot 禁止用 godot_* 工具启动。\n\n' +
          '# 补充\n\nGodot 必须用 godot_* 工具启动，这一点没有变。\n',
        'utf8',
      )
      m.documents.scan()

      const links = m.documents.listLinks()
      assert.ok(links.length >= 2, `应同时有 supports 与 contradicts，实际 ${links.length}`)
      const link = links.find((item) => item.relation === 'contradicts')
      assert.ok(link, '应有 contradicts 关联')
      for (const key of [
        'id', 'docId', 'chunkId', 'memoryId', 'relation', 'detectedBy', 'detectedAt', 'resolved',
        'filePath', 'relativePath', 'headingPath', 'memoryContent', 'memoryCategory', 'memoryStatus',
      ]) {
        assert.ok(key in link, `Link 缺少字段 ${key}`)
      }
      assert.equal(link.memoryId, mem.memory.id)
      assert.equal(link.memoryContent, mem.memory.content)
      assert.equal(link.memoryCategory, 'iron_rule')
      assert.equal(link.memoryStatus, 'active')
      assert.equal(link.relativePath, 'start.md')
      assert.equal(typeof link.resolved, 'boolean')
      assert.ok(link.detectedAt > 0)
      assert.doesNotThrow(() => JSON.stringify(links))

      // relation 过滤
      assert.ok(m.documents.listLinks({ relation: 'contradicts' }).every((item) => item.relation === 'contradicts'))
      assert.ok(m.documents.listLinks({ relation: 'supports' }).every((item) => item.relation === 'supports'))
      // detectedAt 倒序
      const sorted = m.documents.listLinks()
      for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i - 1].detectedAt >= sorted[i].detectedAt)
      // limit 上限 500
      assert.ok(m.documents.listLinks({ limit: 9999 }).length <= 500)
      assert.equal(m.documents.listLinks({ limit: 1 }).length, 1)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ====================================================================== 5e. R3 记忆检索切词 + 文档复核关系

runCase('§10.2 R3 记忆检索切词：「沟通」与「我平时怎么跟你沟通」都能命中', () => {
  withMirror((m) => {
    const communication = m.memories.create({
      content: '沟通与交付用中文，回答要直接给结论',
      category: 'preference',
    })
    const evidence = m.memories.create({
      content: '交付前要求给出可验证的证据，不要只说「应该是」',
      category: 'preference',
    })

    // 短词命中（修复前也命中，作为基线）
    assert.ok(m.memories.search({ q: '沟通' }).some((x) => x.id === communication.memory.id))
    // 自然语言整句命中（修复前 0 条）
    const natural = m.memories.search({ q: '我平时怎么跟你沟通' })
    assert.ok(natural.some((x) => x.id === communication.memory.id), '自然语言问句应命中沟通偏好')
    // 交付/证据偏好
    const delivery = m.memories.search({ q: '你交付前要给我什么' })
    assert.ok(delivery.some((x) => x.id === evidence.memory.id), '自然语言问句应命中证据偏好')
    // 完全无关 → 空
    assert.equal(m.memories.search({ q: '量子退火' }).length, 0)
    // 空 query 行为不变
    assert.deepEqual(m.memories.search({ q: '' }), [])
    assert.deepEqual(m.memories.search({}), [])
    assert.deepEqual(m.memories.search({ q: '   ' }), [])
    // list() 语义不变：q 仍是原始子串匹配，不做切词
    assert.equal(m.memories.list({ q: '我平时怎么跟你沟通' }).length, 0)
    assert.equal(m.memories.list({ q: '沟通' }).length, 1)
    // 命中会 +1 accessCount
    assert.ok(m.memories.get(communication.memory.id).accessCount >= 1)
  })
})

runCase('§10.2 R3 记忆检索排序：命中词项数 → 权威分 → createdAt；scope 语义不变', () => {
  withMirror((m) => {
    const many = m.memories.create({ content: '沟通、交付、证据三件事都要讲清楚', category: 'decision' })
    const two = m.memories.create({ content: '交付要写清证据链', category: 'preference' })
    const one = m.memories.create({ content: '沟通要直接给结论', category: 'preference' })

    const results = m.memories.search({ q: '沟通 交付 证据' })
    assert.deepEqual(
      results.map((x) => x.id),
      [many.memory.id, two.memory.id, one.memory.id],
      '命中词项多的排前面，命中数相同按分数/时间',
    )

    // 同命中数时按 arbiter.score（权威/置信）排序
    const low = m.memories.create({ content: '沟通记录可以省略', category: 'fuzzy', authority: 'inferred', confidence: 0.3 })
    const high = m.memories.create({ content: '沟通必须留结论', category: 'fuzzy' })
    const byScore = m.memories.search({ q: '沟通' })
    const lowIndex = byScore.findIndex((x) => x.id === low.memory.id)
    const highIndex = byScore.findIndex((x) => x.id === high.memory.id)
    assert.ok(highIndex >= 0 && lowIndex >= 0)
    assert.ok(highIndex < lowIndex, '权威/置信更高的应排在前面')

    // scope 语义保持不变：不传 / 'all' 不过滤，具体 scope 精确匹配
    const project = m.memories.create({
      content: '项目里沟通走中文',
      category: 'preference',
      scope: 'project:mirror-plugin',
    })
    assert.ok(m.memories.search({ q: '沟通' }).some((x) => x.id === project.memory.id), '不传 scope 不过滤')
    assert.ok(m.memories.search({ q: '沟通', scope: 'all' }).some((x) => x.id === project.memory.id))
    assert.ok(m.memories.search({ q: '沟通', scope: 'global' }).every((x) => x.scope === 'global'))
    assert.deepEqual(
      m.memories.search({ q: '沟通', scope: 'project:mirror-plugin' }).map((x) => x.id),
      [project.memory.id],
    )

    // limit 生效
    assert.equal(m.memories.search({ q: '沟通 交付 证据', limit: 1 }).length, 1)
  })
})

runCase('§10.3 R3b 文档复核关系：同一主张才判 contradicts，否则 supports 且不写冲突', () => {
  // 决策层（这两对文本的 containment 都不足 0.7，不会进入建链阶段，单测关系判定本身）
  assert.equal(
    reviewRelation(
      '首次或改了 lib/client.js 之后必须重启 dsh web，否则面板不会更新。',
      '禁止直接改副本，改完要重启',
    ),
    'supports',
    '都在说「改完要重启」，不应判矛盾',
  )
  assert.equal(
    reviewRelation('cookies() 已改为异步，必须 await', 'cookies() 是同步的，不需要 await'),
    'contradicts',
    '近似文本 + 真相反，应判矛盾',
  )

  // 集成 1：contradicts → 建 link 且写 1 条 doc_updated 冲突
  const root = tempDir('mirror-rel-')
  const file = path.join(root, 'cookies.md')
  fs.writeFileSync(file, '# cookies\n\n占位内容\n', 'utf8')
  try {
    withMirror((m) => {
      const mem = m.memories.create({ content: 'cookies() 是同步的，不需要 await', category: 'iron_rule' })
      m.documents.addRoot(root)
      m.documents.scan()
      fs.writeFileSync(
        file,
        '# cookies\n\nNext.js 15 中 cookies() 已改为异步，必须 await；以前 cookies() 是同步的，不需要 await。\n',
        'utf8',
      )
      m.documents.scan()
      const link = m.documents.listLinks().find((item) => item.memoryId === mem.memory.id)
      assert.ok(link, '应建立文档-记忆关联')
      assert.equal(link.relation, 'contradicts')
      const docConflicts = m.store.db
        .prepare(`SELECT count(*) AS c FROM conflicts WHERE conflict_type = 'doc_updated'`)
        .get()
      assert.equal(docConflicts.c, 1, '真矛盾应写 1 条 doc_updated 冲突')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  // 集成 2：supports → 只建 link，不写冲突
  const root2 = tempDir('mirror-rel2-')
  const file2 = path.join(root2, 'restart.md')
  fs.writeFileSync(file2, '# 重启\n\n占位内容\n', 'utf8')
  try {
    withMirror((m) => {
      const mem = m.memories.create({ content: '改完要重启面板', category: 'preference' })
      m.documents.addRoot(root2)
      m.documents.scan()
      fs.writeFileSync(
        file2,
        '# 重启\n\n首次或改了 lib/client.js 之后必须重启面板，改完要重启面板。否则不会更新。\n',
        'utf8',
      )
      m.documents.scan()
      const link = m.documents.listLinks().find((item) => item.memoryId === mem.memory.id)
      assert.ok(link, '应建立文档-记忆关联')
      assert.equal(link.relation, 'supports')
      const docConflicts = m.store.db
        .prepare(`SELECT count(*) AS c FROM conflicts WHERE conflict_type = 'doc_updated'`)
        .get()
      assert.equal(docConflicts.c, 0, 'supports 不应写冲突')
    })
  } finally {
    fs.rmSync(root2, { recursive: true, force: true })
  }
})

// ====================================================================== 6. 记忆包

const SAMPLE_PACK = {
  $schema: 'https://mirror.dev/schemas/pack/v1.json',
  pack_id: 'pack_nextjs_15_best_practices',
  name: 'Next.js 15 最佳实践记忆包',
  version: '1.2.0',
  format_version: '1.0',
  author: 'frontend_guru',
  category: 'framework',
  description: 'Next.js 15 迁移要点',
  min_mirror_version: '2.0.0',
  memories: [
    {
      category: 'iron_rule',
      layer: 'fact',
      content: 'Next.js 15 中 cookies() 已改为异步，必须 await',
      structured: {
        condition: '使用 next/headers 的 cookies()',
        constraint: '必须 await cookies()',
        reason: 'Next.js 15 breaking change',
      },
      authority: 'imported',
      scope: 'global',
      tags: ['nextjs', '15', 'breaking-change'],
    },
    {
      category: 'pitfall',
      layer: 'fragment',
      content: '把 cookies() 当同步函数用会导致页面渲染报错',
      authority: 'imported',
      scope: 'global',
      tags: ['nextjs'],
    },
  ],
  doc_references: [{ path: 'docs/next15-migration-guide.md', description: 'Next.js 15 迁移指南' }],
  changelog: [
    { version: '1.2.0', date: '2026-11-01', changes: '补充 next-auth v5 适配' },
    { version: '1.0.0', date: '2026-09-20', changes: '初始发布' },
  ],
}

const WS_PACK = {
  $schema: 'https://mirror.dev/schemas/pack/v1.json',
  pack_id: 'pack_ws_rule',
  name: 'WebSocket 接口规范包',
  version: '1.0.0',
  format_version: '1.0',
  author: 'tester',
  category: 'domain',
  description: '接口传输层规范',
  min_mirror_version: '2.0.0',
  memories: [
    {
      category: 'iron_rule',
      layer: 'strategy',
      content: '接口禁止走 WebSocket',
      authority: 'imported',
      scope: 'global',
      tags: ['websocket', 'interface'],
    },
  ],
  doc_references: [],
  changelog: [{ version: '1.0.0', date: '2026-11-01', changes: '初始发布' }],
}

runCase('记忆包：§9.1 样例导入（无冲突）→ list → 校验失败中文报错', () => {
  withMirror((m) => {
    // 文本输入（含 ```json 围栏也应可解析）也能用
    const parsed = m.packs.parse(JSON.stringify(SAMPLE_PACK))
    assert.equal(parsed.packId, 'pack_nextjs_15_best_practices')
    assert.equal(parsed.memories.length, 2)
    assert.equal(parsed.memories[0].tags.length, 3)

    const installed = m.packs.install({ pack: parsed, strategy: 'ask' })
    assert.equal(installed.installed, true)
    assert.equal(installed.created, 2)
    assert.equal(installed.skipped, 0)
    assert.equal(installed.conflicts.length, 0)
    assert.equal(installed.packId, 'pack_nextjs_15_best_practices')
    assert.equal(installed.version, '1.2.0')

    const packs = m.packs.list()
    assert.equal(packs.length, 1)
    assert.equal(packs[0].packId, 'pack_nextjs_15_best_practices')
    assert.equal(packs[0].packVersion, '1.2.0')
    assert.equal(packs[0].packName, 'Next.js 15 最佳实践记忆包')
    assert.equal(packs[0].memoryCount, 2)
    assert.equal(packs[0].status, 'active')
    assert.doesNotThrow(() => JSON.stringify(packs))

    // 记忆带 pack 溯源
    const imported = m.memories.list().filter((x) => x.packId === 'pack_nextjs_15_best_practices')
    assert.equal(imported.length, 2)
    assert.ok(imported.every((x) => x.packVersion === '1.2.0' && x.authority === 'imported'))
    assert.equal(imported.find((x) => x.category === 'iron_rule').layer, 'fact')

    // 重复导入：不新增记忆
    const again = m.packs.install({ pack: SAMPLE_PACK, strategy: 'ask' })
    assert.equal(again.created, 0)
    assert.equal(again.skipped, 2)
    assert.equal(m.memories.list().length, 2)

    // 版本更新检查
    assert.equal(m.packs.checkUpdate({ packId: 'pack_nextjs_15_best_practices', latestVersion: '1.3.0' }).available, true)
    assert.equal(m.packs.checkUpdate({ packId: 'pack_nextjs_15_best_practices', latestVersion: '1.2.0' }).available, false)
    assert.ok(m.store.db.prepare('SELECT count(*) AS c FROM pack_update_check').get().c >= 1)

    // 校验失败：中文消息
    assert.throws(() => m.packs.parse({ name: '缺 pack_id' }), /pack_id/)
    assert.throws(() => m.packs.parse({ ...SAMPLE_PACK, format_version: '9.9' }), /格式版本/)
    assert.throws(() => m.packs.parse({ ...SAMPLE_PACK, min_mirror_version: '9.0.0' }), /要求 Mirror 版本/)
    assert.throws(() => m.packs.parse({ ...SAMPLE_PACK, memories: [{ content: '' }] }), /缺少 content/)
    assert.throws(() => m.packs.parse('{ 不是 json'), /不是合法 JSON/)
    assert.throws(() => m.packs.install({ pack: SAMPLE_PACK, strategy: '乱写' }), /导入策略/)
  })
})

runCase('记忆包：有冲突两种策略（local_first 跳过 / pack_first 覆盖）+ 卸载', () => {
  withMirror((m) => {
    const local = m.memories.create({ content: '接口必须走 WebSocket', category: 'iron_rule' })

    // local_first：跳过包内冲突条，本地记忆不动，冲突留待裁决
    const localFirst = m.packs.install({ pack: WS_PACK, strategy: 'local_first' })
    assert.equal(localFirst.created, 0)
    assert.equal(localFirst.skipped, 1)
    assert.ok(localFirst.conflicts.length >= 1)
    assert.equal(localFirst.conflicts[0].localMemoryId, local.memory.id)
    assert.equal(m.memories.get(local.memory.id).status, 'active')
    assert.equal(m.memories.list().filter((x) => x.packId === 'pack_ws_rule').length, 0)
    // 冲突落库（pack_updated，未裁决）
    const packConflicts = m.memories.listConflicts()
    assert.ok(packConflicts.some((c) => c.conflictType === 'pack_updated'))
    const packConflict = packConflicts.find((c) => c.conflictType === 'pack_updated')
    assert.equal(packConflict.a.id, local.memory.id)

    // 卸载（没导入任何记忆 → 0 删 0 留）
    const uninstall1 = m.packs.uninstall({ packId: 'pack_ws_rule' })
    assert.equal(uninstall1.removedMemories, 0)
    assert.equal(uninstall1.keptMemories, 0)
    assert.equal(m.packs.list().length, 0)
  })

  withMirror((m) => {
    const local = m.memories.create({ content: '接口必须走 WebSocket', category: 'iron_rule' })
    // pack_first：本地记忆被 invalidate，包记忆写入，superseded_by 指向新记忆
    const packFirst = m.packs.install({ pack: WS_PACK, strategy: 'pack_first' })
    assert.equal(packFirst.created, 1)
    assert.ok(packFirst.conflicts.length >= 1)
    const oldOne = m.memories.get(local.memory.id)
    assert.equal(oldOne.status, 'superseded')
    assert.ok(oldOne.supersededBy, 'superseded_by 应指向包内新记忆')
    const imported = m.memories.get(oldOne.supersededBy)
    assert.equal(imported.content, '接口禁止走 WebSocket')
    assert.equal(imported.authority, 'imported')
    assert.equal(imported.packId, 'pack_ws_rule')

    // 卸载：默认只删「未改过」的包记忆
    const confirmed = m.memories.confirm(imported.id) // 用户确认过 → 视为改过
    assert.equal(confirmed.memory.userModified, true)
    const uninstall = m.packs.uninstall({ packId: 'pack_ws_rule' })
    assert.equal(uninstall.removedMemories, 0)
    assert.equal(uninstall.keptMemories, 1)
    assert.ok(m.memories.get(imported.id), '改过的记忆应保留')

    // deleteMemories=true：连改过的也删
    const forced = m.packs.uninstall({ packId: 'pack_ws_rule', deleteMemories: true })
    assert.equal(forced.removedMemories, 1)
    assert.equal(m.memories.get(imported.id), null)
  })
})

runCase('记忆包：从记忆导出 → 可被 parse 回读', () => {
  withMirror((m) => {
    const a = m.memories.create({ content: '不要用 any，用 unknown + 类型守卫', category: 'iron_rule', tags: ['ts'] })
    const b = m.memories.create({ content: '偏好用 pnpm 安装依赖', category: 'preference', tags: ['pnpm'] })
    const pack = m.packs.export({
      memoryIds: [a.memory.id, b.memory.id],
      meta: { name: '我的团队记忆包', version: '0.1.0', author: 'me', category: 'team', description: '团队规范' },
    })
    assert.equal(pack.format_version, '1.0')
    assert.equal(pack.memories.length, 2)
    assert.ok(pack.changelog.length >= 1)
    assert.match(pack.pack_id, /^[A-Za-z0-9_.-]+$/)
    assert.deepEqual(pack.memories.find((x) => x.category === 'iron_rule').tags, ['ts'])
    // 导出的包必须能被 parse 回读（内部已自校验，这里再走一遍）
    const round = m.packs.parse(JSON.stringify(pack))
    assert.equal(round.packId, pack.pack_id)
    assert.equal(round.memories.length, 2)
    assert.equal(round.author, 'me')
    // 空选择 → 中文报错
    assert.throws(() => m.packs.export({ memoryIds: [] }), /请选择要导出的记忆/)
  })
})

// ====================================================================== 7. 检索与注入

runCase('检索与注入：铁律优先 + 预算截断 + 注入标题格式', () => {
  withMirror((m) => {
    const iron = m.memories.create({ content: '接口必须走 WebSocket，HTTP 会丢消息', category: 'iron_rule' })
    m.memories.create({ content: '不要用 any，用 unknown + 类型守卫', category: 'iron_rule' })
    m.memories.create({ content: '偏好用 pnpm 安装依赖', category: 'preference' })
    m.memories.create({ content: '决定用 SQLite 做主存储，因为本地零依赖', category: 'decision' })
    m.memories.create({ content: '踩坑：Godot 里用 shell 启动会段错误', category: 'pitfall' })

    // 铁律兜底：即使 query 完全无关也要带上铁律
    const result = retrieve({
      memories: m.memories,
      documents: m.documents,
      query: '完全不相关的关键词',
      scope: 'global',
      tokenBudget: 3000,
    })
    assert.equal(result.ironRules.length, 2, '铁律应无条件入选')
    assert.ok(result.ironRules.some((x) => x.id === iron.memory.id))
    assert.ok(Array.isArray(result.documents))

    // 不带 query（compaction 注入的典型形态）：所有层都参与
    const all = retrieve({ memories: m.memories, documents: m.documents, scope: 'global', tokenBudget: 3000 })
    assert.equal(all.ironRules.length, 2)
    assert.equal(all.preferences.length, 1)
    assert.equal(all.decisions.length, 1)
    assert.equal(all.pitfalls.length, 1)
    assert.equal(all.fuzzy.length, 0)

    // 注入格式（emoji 与标题必须一字不差）
    const injection = buildInjection(all)
    assert.ok(injection.text.includes('## 🔴 铁律（不可违反）'))
    assert.ok(injection.text.includes('## 🟡 偏好与决策'))
    assert.ok(injection.text.includes('## ⚠️ 踩坑提醒'))
    assert.ok(injection.token_count > 0)
    assert.ok(injection.sections.length >= 3)
    assert.ok(injection.sections.every((s) => ['name', 'label', 'tokens', 'count'].every((k) => k in s)))
    // 偏好与决策合并到同一层
    const prefSection = injection.sections.find((s) => s.name === 'preferences')
    assert.equal(prefSection.count, 2)
    assert.ok(injection.text.includes('- [preference] 偏好用 pnpm 安装依赖'))
    assert.ok(injection.text.includes('- [decision] 决定用 SQLite 做主存储，因为本地零依赖'))

    // 铁律兜底的那次检索：非铁律层不该出现无关内容
    assert.equal(buildInjection(result).text.includes('## 🟡 偏好与决策'), false)

    // 预算截断：极小预算下 token 数受控，且仍优先保留铁律
    const tiny = retrieve({
      memories: m.memories,
      documents: m.documents,
      query: '完全不相关的关键词',
      scope: 'global',
      tokenBudget: 40,
    })
    const tinyInjection = buildInjection(tiny)
    assert.ok(tinyInjection.token_count < injection.token_count, '小预算注入不能比大预算更长')
    assert.ok(tinyInjection.token_count <= 100, `token 预算失控：${tinyInjection.token_count}`)
    assert.ok(tinyInjection.text.includes('## 🔴 铁律（不可违反）'))
    assert.ok(tiny.fuzzy.length === 0 && tiny.pitfalls.length === 0)

    // 空结果 → text '' 且没有分层
    const empty = buildInjection({})
    assert.equal(empty.text, '')
    assert.deepEqual(empty.sections, [])
    assert.equal(empty.token_count, 0)

    // token 估算口径：中文 1 字≈0.6，英文 4 字符≈1
    assert.equal(estimateTokens('中文'), 2)
    assert.equal(estimateTokens('abcd'), 1)
    assert.equal(estimateTokens(''), 0)
  })
})

// ====================================================================== 8. 抽取

runCase('抽取：heuristicExtract 中文对话 >=1 条，parseExtraction 解析 ```json 围栏', () => {
  const conversation =
    '讨论后端接口方案。接口必须走 WebSocket，HTTP 会丢消息。我偏好用 pnpm 安装依赖。' +
    '决定用 SQLite 做主存储，因为本地零依赖。上次踩坑：Godot 里用 shell 启动会段错误。今天天气不错。'

  const heuristic = heuristicExtract(conversation)
  assert.ok(heuristic.extractions.length >= 1, '启发式应至少抽到 1 条')
  assert.ok(heuristic.extractions.length <= 8)
  assert.ok(heuristic.extractions.some((x) => x.category === 'iron_rule'))
  assert.ok(heuristic.extractions.some((x) => x.category === 'preference'))
  assert.ok(heuristic.extractions.some((x) => x.category === 'decision'))
  assert.ok(heuristic.extractions.some((x) => x.category === 'pitfall'))
  assert.ok(heuristic.extractions.every((x) => x.content.length <= 200 && x.confidence > 0 && x.authority === 'inferred'))
  assert.deepEqual(heuristicExtract('').extractions, [])
  assert.deepEqual(heuristicExtract('    ').extractions, [])

  // ```json 围栏 + 前后多余文字
  const fenced =
    '这是模型输出：\n```json\n{"extractions":[{"category":"iron_rule","layer":"strategy",' +
    '"content":"接口必须走 WebSocket","structured":{},"confidence":0.9,"authority":"inferred",' +
    '"scope":"global","reasoning":"明确约束","causal_link":""}],"conflicts":[],"supersedes":[]}\n```\n以上。'
  const parsed = parseExtraction(fenced)
  assert.equal(parsed.parseError, undefined)
  assert.equal(parsed.extractions.length, 1)
  assert.equal(parsed.extractions[0].content, '接口必须走 WebSocket')
  assert.equal(parsed.extractions[0].confidence, 0.9)

  // 裸 JSON + 前后杂字
  const bare = parseExtraction(
    '结果：{"extractions":[{"content":"偏好用 pnpm"}],"conflicts":[{"new_content":"x",' +
      '"conflicting_memory_id":"mem_1","conflict_type":"contradiction","severity":"high"}],' +
      '"supersedes":["mem_1"]}',
  )
  assert.equal(bare.extractions.length, 1)
  assert.equal(bare.conflicts.length, 1)
  assert.deepEqual(bare.supersedes, ['mem_1'])

  // 解析失败不抛错
  const failed = parseExtraction('这不是 JSON')
  assert.equal(failed.extractions.length, 0)
  assert.ok(failed.parseError)
  assert.equal(parseExtraction('').extractions.length, 0)

  // prompt 占位替换
  const filled = fillPrompt(EXTRACT_PROMPT, {
    existingMemories: [{ category: 'iron_rule', content: '已有记忆内容' }],
    conversation,
  })
  assert.ok(filled.includes('已有记忆内容'))
  assert.ok(!filled.includes('{existing_memories}'))
  assert.ok(!filled.includes('{conversation}'))
  assert.ok(filled.includes('接口必须走 WebSocket'))
})

// ====================================================================== 9. 陈旧 + 短查询

runCase('陈旧检测（age）与 1–2 字中文 LIKE 兜底', () => {
  withMirror((m) => {
    const old = m.memories.create({ content: '很久以前的一条模糊记忆', category: 'fuzzy' })
    // 手工把时间调到 200 天前（模拟长期未验证）
    m.store.db
      .prepare('UPDATE memories SET created_at = ?, valid_from = ?, last_verified_at = NULL WHERE id = ?')
      .run(Date.now() - 200 * DAY, Date.now() - 200 * DAY, old.memory.id)

    const check = m.memories.stalenessCheck({ stalerThanDays: 90 })
    assert.equal(check.checked, 1)
    assert.equal(check.stale.length, 1)
    assert.equal(check.stale[0].id, old.memory.id)
    assert.equal(m.store.db.prepare('SELECT count(*) AS c FROM staleness_checks').get().c, 1)
    const record = m.store.db.prepare('SELECT * FROM staleness_checks WHERE memory_id = ?').get(old.memory.id)
    assert.equal(record.check_type, 'age')
    assert.equal(record.result, 'stale')

    // 冻结后不参与陈旧判定
    m.memories.freeze(old.memory.id, true)
    const afterFreeze = m.memories.stalenessCheck({ stalerThanDays: 90 })
    assert.equal(afterFreeze.checked, 0)
    assert.equal(afterFreeze.stale.length, 0)

    // 1–2 字中文查询走 LIKE
    assert.equal(m.memories.search({ q: '模糊' }).length, 1)
    assert.equal(m.memories.search({ q: '记忆' }).length, 1)
    // 3 字以上走 FTS MATCH
    assert.equal(m.memories.search({ q: '模糊记忆' }).length, 1)
    // 空查询返回空数组
    assert.deepEqual(m.memories.search({ q: '' }), [])
  })
})

// ====================================================================== 9b. 稳健性

runCase('稳健性：脏数据（坏 JSON / 缺字段）不让 store 打不开', () => {
  withMirror((m) => {
    // 直接塞一行坏数据（模拟旧版本 / 手工改库）
    m.store.db
      .prepare(
        `INSERT INTO memories (id, category, layer, content, structured, confidence, authority,
                               created_at, status, scope, tags, causal_children)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('mem_dirty', 'iron_rule', 'strategy', '脏数据记忆', '{坏JSON', 1, 'user_explicit', Date.now(), 'active', 'global', '{坏', '{坏')
    const list = m.memories.list()
    assert.equal(list.length, 1)
    assert.deepEqual(list[0].tags, [])
    assert.deepEqual(list[0].causalChildren, [])
    assert.equal(list[0].structured, null)
    assert.doesNotThrow(() => JSON.stringify(list))
    // 脏数据之后仍然可以正常写入与检索
    m.memories.create({ content: '脏数据之后依然可以写入新记忆', category: 'fuzzy' })
    assert.equal(m.memories.list().length, 2)
    assert.equal(m.memories.search({ q: '脏数据' }).length, 2)
    // 业务校验错误都是中文
    assert.throws(() => m.memories.create({ content: '', category: 'iron_rule' }), /记忆内容不能为空/)
    assert.throws(() => m.memories.create({ content: 'x', category: '乱写' }), /记忆分类不合法/)
    assert.throws(() => m.memories.update('mem_not_exists', { content: 'y' }), /记忆不存在/)
    assert.throws(() => m.memories.resolveConflict('cfl_not_exists', { resolution: 'dismiss' }), /冲突不存在/)
    assert.throws(() => m.memories.resolveConflict('cfl_not_exists', { resolution: '乱写' }), /无效的冲突处理方式/)
  })
})

// ====================================================================== 摘要

after(() => {
  const total = stats.passed + stats.failed
  console.log('\n==================== Mirror 内核自测摘要 ====================')
  console.log(`用例总数：${total}    通过：${stats.passed}    失败：${stats.failed}`)
  console.log('数据目录：全部位于 os.tmpdir() 下的临时目录，已用完即删（未触碰 ~/.mirror）')
  if (stats.failed === 0) console.log('结果：全部通过 ✅')
  else console.log('结果：存在失败用例 ❌')
  console.log('=============================================================')
})
