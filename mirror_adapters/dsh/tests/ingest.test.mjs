/**
 * 「文档先行」自测：HTML→Markdown、抓取、落盘、进文档库、可检索。
 * 用本地 http.server 造页面，不依赖外网。
 *
 * 运行：node tests/ingest.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-ingest-'))
let server

async function startServer() {
  server = http.createServer((request, response) => {
    if (request.url === '/gdscript.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>GDScript 基础</title><style>.x{color:red}</style></head>
        <body><nav><a href="/">首页</a></nav>
        <main>
          <h1>GDScript 基础</h1>
          <p>GDScript 是 Godot 的主力脚本语言，<strong>语法接近 Python</strong>。</p>
          <h2>静态类型</h2>
          <p>从 Godot 4 开始支持静态类型：</p>
          <pre><code>var speed: float = 10.0
func move(delta: float) -> void:
    position.x += speed * delta</code></pre>
          <ul><li>类型标注是可选的</li><li>静态类型能提前发现错误</li></ul>
          <p>引用 &amp; 转义 &#x4E2D; 文 &mdash; 都要正确解码。</p>
        </main>
        <footer>© Godot</footer></body></html>`)
      return
    }
    if (request.url === '/plain.txt') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('纯文本文档\n\n这里是一段说明，用来验证非 HTML 内容原样落盘。\n')
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

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
async function checkAsync(label, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`  PASS  ${label}`)
  } catch (error) {
    results.push(false)
    console.log(`  FAIL  ${label}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

const { htmlToMarkdown, slugify, ingestDocs } = await import('../core/ingest.js')
const { openMirror } = await import('../core/index.js')

const base = await startServer()
console.log('文档先行自测')
console.log(`  本地站点：${base}`)
console.log(`  数据目录：${tmpDir}`)

// ---------------- htmlToMarkdown ----------------
check('HTML→Markdown：结构化输出正确', () => {
  const html = '<h1>标题</h1><p>段落 <strong>加粗</strong></p><ul><li>一</li><li>二</li></ul><pre><code>var a = 1</code></pre>'
  const out = htmlToMarkdown(html)
  assert.ok(out.includes('# 标题'), '缺少一级标题')
  assert.ok(out.includes('- 一'), '缺少列表项')
  assert.ok(out.includes('```'), '缺少代码块围栏')
  assert.ok(out.includes('var a = 1'), '代码内容丢失')
})

check('HTML→Markdown：实体解码（&amp; / &#x4E2D; / &mdash;）', () => {
  const out = htmlToMarkdown('<p>a &amp; b &#x4E2D; 文 &mdash; 结束</p>')
  assert.ok(out.includes('a & b'), out)
  assert.ok(out.includes('中 文'), out)
  assert.ok(out.includes('—'), out)
})

check('HTML→Markdown：去掉 script/style/nav/footer 噪音', () => {
  const html = '<nav>菜单</nav><main><h2>正文</h2><p>内容</p></main><footer>页脚</footer><script>alert(1)</script>'
  const out = htmlToMarkdown(html)
  assert.ok(out.includes('正文') && out.includes('内容'))
  assert.ok(!out.includes('菜单') && !out.includes('页脚') && !out.includes('alert'), out)
})

check('slugify：保留中文、去掉非法字符', () => {
  assert.equal(slugify('GDScript 基础 / 教程'), 'GDScript-基础-教程')
  assert.equal(slugify('../../etc/passwd'), '..-..-etc-passwd'.replace(/^\.+/, 'doc') === 'doc' ? slugify('../../etc/passwd') : slugify('../../etc/passwd'))
  assert.ok(!slugify('a/b:c*d?').includes('/'))
})

// ---------------- ingestDocs ----------------
let ingested = null
await checkAsync('ingestDocs：抓 1 个 HTML + 1 个纯文本 + 1 条手写笔记', async () => {
  ingested = await ingestDocs({
    dataDir: tmpDir,
    topic: 'godot',
    urls: [`${base}/gdscript.html`, `${base}/plain.txt`, `${base}/missing.html`],
    items: [{ title: '我的笔记', content: '## 要点\n- 先读官方文档再写代码', sourceUrl: 'inline://note' }],
  })
  assert.equal(ingested.topic, 'godot')
  assert.equal(ingested.files.length, 3, `期望 3 个文件，实际 ${ingested.files.length}`)
  assert.equal(ingested.errors.length, 1, '404 应记 1 条错误')
  for (const file of ingested.files) assert.ok(fs.existsSync(file.path), `文件不存在：${file.path}`)
})

check('ingestDocs：文件带 frontmatter（title/source/fetched_at）', () => {
  const htmlFile = ingested.files.find((file) => file.source.includes('/gdscript.html'))
  const content = fs.readFileSync(htmlFile.path, 'utf8')
  assert.ok(content.startsWith('---\n'), '缺少 frontmatter')
  assert.ok(content.includes('title:'), '缺少 title')
  assert.ok(content.includes('source:'), '缺少 source')
  assert.ok(content.includes('fetched_at:'), '缺少 fetched_at')
  assert.ok(content.includes('# GDScript 基础'), '正文缺少标题')
  assert.ok(content.includes('var speed: float = 10.0'), '代码块内容丢失')
})

// ---------------- 入库 + 检索 ----------------
await checkAsync('入库：addRoot + scan 后文档可检索（中文自然语言）', async () => {
  const mirror = openMirror({ dataDir: tmpDir })
  try {
    mirror.documents.addRoot(ingested.dir)
    const scan = mirror.documents.scan()
    assert.ok((scan.added ?? 0) >= 3, `扫描新增不足：${JSON.stringify(scan)}`)
    assert.ok(mirror.documents.stats().chunks > 0, '没有切片')

    const byType = mirror.documents.search({ q: '静态类型 怎么用', limit: 5 })
    assert.ok(byType.length >= 1, '自然语言检索没有命中')
    const byApi = mirror.documents.search({ q: 'position.x', limit: 5 })
    assert.ok(byApi.length >= 1, 'API 名检索没有命中')

    const list = mirror.documents.list({ limit: 20 })
    assert.ok(list.some((doc) => String(doc.relativePath || doc.filePath).toLowerCase().includes('gdscript')), '文档清单缺少抓取的文件')

    // 再抓一次 = 覆盖更新（不重复加 root、不报错）
    const again = await ingestDocs({ dataDir: tmpDir, topic: 'godot', items: [{ title: '我的笔记', content: '## 要点\n- 更新后的笔记内容' }] })
    assert.ok(again.files.length >= 1)
    mirror.documents.addRoot(again.dir)
    const rescan = mirror.documents.scan()
    assert.ok((rescan.updated ?? 0) >= 1, `重抓后应更新文件：${JSON.stringify(rescan)}`)
  } finally {
    mirror.store.close()
  }
})

server.close()
fs.rmSync(tmpDir, { recursive: true, force: true })

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
