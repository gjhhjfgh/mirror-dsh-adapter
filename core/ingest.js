/**
 * core/ingest.js —— 「文档先行」：把官方文档抓下来、转 Markdown、存成本地可索引文件。
 *
 * 为什么在插件里做而不是让模型自己贴：
 *   - 官方文档要能增量更新（同一个 topic 重抓就是覆盖），要有来源 URL 与抓取时间；
 *   - 存成文件后走 DocumentIndexer（切片 + FTS5），检索/注入/关联全部复用；
 *   - 零第三方依赖：HTML→Markdown 用启发式提取正文，够读，不追求完美还原。
 *
 * 目录布局：<dataDir>/docs-cache/<topic>/<NN>-<slug>.md
 * 每个文件带 frontmatter（title / source / fetched_at / topic），便于审计。
 */

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 20000
const MAX_BYTES = 2 * 1024 * 1024

/** 抓一页（跟随重定向，限大小与超时）。 */
export async function fetchPage(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_BYTES, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前运行时没有 fetch')
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error(`不是合法的 URL：${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只支持 http/https：${url}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  try {
    const response = await doFetch(parsed.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'MirrorDocsIngest/2.0 (+local)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const contentType = String(response.headers.get('content-type') ?? '')
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error(`页面过大（${buffer.length} bytes > ${maxBytes}）`)
    const charsetMatch = /charset=([\w-]+)/i.exec(contentType)
    const charset = (charsetMatch?.[1] ?? 'utf-8').toLowerCase()
    const text = charset.includes('utf-8') || charset.includes('utf8')
      ? buffer.toString('utf8')
      : decodeWithCharset(buffer, charset)
    return { url: response.url || parsed.toString(), contentType, text, bytes: buffer.length }
  } finally {
    clearTimeout(timer)
  }
}

/** Node 内置只保证 utf-8/latin1/utf-16；其它编码用 TextDecoder（Node 全量 ICU 时才支持）。 */
function decodeWithCharset(buffer, charset) {
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/** HTML → Markdown（启发式：优先正文容器，去掉脚本/样式/导航噪音）。 */
export function htmlToMarkdown(html) {
  let source = String(html ?? '')
  if (!source) return ''

  // 1) 只留正文容器。注意：不能靠「懒匹配到 </div></div>」去截嵌套 div（Sphinx 的正文
  //    容器里套着几十层 div，懒匹配会只截到几 KB）。这里改成「从左边界切到右边界」：
  //    左边取第一个正文标志，右边取第一个明显的噪音容器（侧边栏/页脚/评论）。
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(source)
  let body = bodyMatch ? bodyMatch[1] : source

  const LEFT_MARKERS = [
    /<main[\s>]/i,
    /<article[\s>]/i,
    /<div[^>]+role="main"/i,
    /<div[^>]+class="[^"]*\bbody\b[^"]*"[^>]*role="main"/i,
    /<div[^>]+class="[^"]*\bdocument\b[^"]*"/i,
    /<div[^>]+class="[^"]*\bmarkdown-body\b[^"]*"/i,
    /<div[^>]+class="[^"]*\barticle-content\b[^"]*"/i,
    /<div[^>]+id="content"/i,
  ]
  const RIGHT_MARKERS = [
    /<div[^>]+class="[^"]*\bsphinxsidebar\b[^"]*"/i,
    /<div[^>]+class="[^"]*\brelated\b[^"]*"/i,
    /<footer[\s>]/i,
    /<aside[\s>]/i,
    /<div[^>]+id="comments"/i,
  ]

  let start = -1
  for (const marker of LEFT_MARKERS) {
    const hit = marker.exec(body)
    if (hit) {
      start = hit.index
      break
    }
  }
  if (start >= 0) {
    let end = body.length
    for (const marker of RIGHT_MARKERS) {
      const hit = marker.exec(body)
      if (hit && hit.index > start + 400) {
        end = Math.min(end, hit.index)
      }
    }
    body = body.slice(start, end)
  }
  if (body.length > 400) source = body

  // 2) 去掉完全不需要的块
  source = source
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')

  // 3) 结构化标签 → Markdown
  source = source
    .replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code) => `\n\`\`\`\n${stripTags(code)}\n\`\`\`\n`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => `\n\`\`\`\n${stripTags(code)}\n\`\`\`\n`)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, text) => `\n${'#'.repeat(Number(level))} ${stripTags(text).trim()}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text) => `\n- ${stripTags(text).trim()}`)
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row) => `\n| ${stripTags(row).split(/\s{2,}|<td|<th/i).map((cell) => cell.trim()).filter(Boolean).join(' | ')} |`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, code) => `\`${stripTags(code).trim()}\``)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|table|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')

  // 4) 实体 + 空白整理（顺带去掉 Sphinx 标题锚点 ¶ 与零宽字符）
  return decodeEntities(source)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00b6\uE000-\uF8FF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' '))
}

function decodeEntities(text) {
  const named = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&middot;': '·',
    '&times;': '×',
    '&copy;': '©',
    '&reg;': '®',
  }
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(Number(dec)))
    .replace(/&[a-z]+;/gi, (entity) => named[entity.toLowerCase()] ?? entity)
}

function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 文件名安全化：保留中英文/数字/连字符，其余折成 '-'。 */
export function slugify(text, { maxLength = 60 } = {}) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const sliced = cleaned.slice(0, maxLength) || 'doc'
  return sliced.replace(/^\.+/, 'doc')
}

/**
 * 把一组 URL / 现成文本存成本地 Markdown 文件。
 * @param {{dataDir: string, topic: string, urls?: string[], items?: {title?: string, content: string, sourceUrl?: string, kind?: string}[],
 *          fetchImpl?: Function, timeoutMs?: number}} input
 * @returns {Promise<{topic: string, dir: string, files: {path: string, title: string, source: string, bytes: number, chars: number}[], errors: {source: string, message: string}[]}>}
 */
export async function ingestDocs({
  dataDir,
  topic,
  urls = [],
  items = [],
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const topicName = slugify(topic || 'docs', { maxLength: 40 })
  const dir = path.join(String(dataDir), 'docs-cache', topicName)
  fs.mkdirSync(dir, { recursive: true })

  const files = []
  const errors = []
  const fetchedAt = new Date().toISOString()
  let index = 0

  const writeOne = (title, markdown, source, kind) => {
    index += 1
    const fileName = `${String(index).padStart(2, '0')}-${slugify(title, { maxLength: 48 })}.md`
    const filePath = path.join(dir, fileName)
    const front = [
      '---',
      `title: ${JSON.stringify(title || 'untitled')}`,
      `source: ${JSON.stringify(source || '')}`,
      `topic: ${JSON.stringify(topicName)}`,
      `kind: ${JSON.stringify(kind || 'doc')}`,
      `fetched_at: ${JSON.stringify(fetchedAt)}`,
      '---',
      '',
    ].join('\n')
    const content = front + markdown.trim() + '\n'
    fs.writeFileSync(filePath, content, 'utf8')
    files.push({ path: filePath, title: title || fileName, source: source || '', bytes: Buffer.byteLength(content), chars: content.length })
  }

  // 1) 现成文本（模型已读到的内容 / 手工粘贴）
  for (const item of items) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue
    const title = item.title || deriveTitle(item.content) || `note-${index + 1}`
    writeOne(title, item.content, item.sourceUrl || 'inline', item.kind || 'doc')
  }

  // 2) URL：抓取 → 转 Markdown
  for (const url of urls.slice(0, 10)) {
    try {
      const page = await fetchPage(url, { fetchImpl, timeoutMs })
      const isHtml = /html/i.test(page.contentType) || /<html|<body|<div/i.test(page.text.slice(0, 2000))
      const markdown = isHtml ? htmlToMarkdown(page.text) : String(page.text).trim()
      // 只对 HTML 设最小长度门槛（挡登录墙/纯脚本页）；纯文本允许短
      if (!markdown) throw new Error('抓到的正文为空')
      if (isHtml && markdown.length < 80) throw new Error('正文过短（可能是登录墙或纯脚本页）')
      const title = deriveTitle(markdown) || page.url
      writeOne(title, markdown, page.url, 'web')
    } catch (error) {
      errors.push({ source: String(url), message: error instanceof Error ? error.message : String(error) })
    }
  }

  return { topic: topicName, dir, files, errors }
}

/** 去掉标题尾巴上的锚点符号/零宽字符。 */
function cleanTitle(text) {
  return String(text ?? '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00b6\u00a7#\uE000-\uF8FF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** 从 Markdown 第一行标题或首句推导标题。 */
function deriveTitle(markdown) {
  const text = String(markdown ?? '')
  const heading = /^#{1,3}\s+(.+)$/m.exec(text)
  if (heading) return cleanTitle(heading[1])
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  return firstLine ? firstLine.slice(0, 120) : ''
}

export const INGEST_DEFAULTS = { DEFAULT_TIMEOUT_MS, MAX_BYTES }
