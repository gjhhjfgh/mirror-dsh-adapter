/**
 * core/dsh-sessions.js —— 读「已有的 DSH 会话日志」（只读、本机），给蒸馏用
 *
 * 为什么需要它：会话捕获只记「打开开关之后」的对话；而 DSH 本身就把历史会话存在
 * <DSH_HOME>/sessions/<工作区>/<sessionId>/session.v4.jsonl.zstd。用户想蒸馏历史，
 * 就得能读这些日志。
 *
 * 难点：DSH 的会话日志是 **append-only、每段一个 zstd frame**（一个 3MB 文件可能有
 * 2000 个 frame）。Node 的 zstdDecompressSync 只解第一帧，所以这里自己扫帧边界、
 * 逐帧解压再拼接。零第三方依赖。
 *
 * 隐私：本模块只读本地文件；调用方必须由用户显式选择数据源（source='dsh'）才走这里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f
/** 单次蒸馏最多读多少个会话 / 每个会话最多取多少字（末尾优先，越近越相关）。 */
const DEFAULT_MAX_SESSIONS = 10
const DEFAULT_MAX_CHARS = 12000
const MAX_BYTES_PER_FILE = 32 * 1024 * 1024

/** DSH 家目录：配置 > 环境变量 > ~/.dsh */
export function resolveDshHome(configured) {
  const fromConfig = typeof configured === 'string' && configured.trim() ? configured.trim() : ''
  if (fromConfig) return fromConfig
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** 扫描 zstd 多帧边界（返回每个 frame 的 [start,end)，skippable 帧跳过）。 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset)
    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      if (offset + 8 > buffer.length) break
      offset += 8 + buffer.readUInt32LE(offset + 4)
      continue
    }
    if (magic !== ZSTD_MAGIC) break
    const start = offset
    try {
      offset += 4
      const descriptor = buffer[offset]
      offset += 1
      const fcsFlag = descriptor >> 6
      const singleSegment = (descriptor >> 5) & 1
      const hasChecksum = (descriptor >> 2) & 1
      const dictFlag = descriptor & 3
      if (!singleSegment) offset += 1
      offset += [0, 1, 2, 4][dictFlag] ?? 0
      if (fcsFlag === 0) {
        if (singleSegment) offset += 1
      } else {
        offset += [0, 2, 4, 8][fcsFlag] ?? 0
      }
      let last = false
      let guard = 0
      while (!last) {
        if (offset + 3 > buffer.length) throw new Error('block header 越界')
        const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
        offset += 3
        last = (header & 1) === 1
        const type = (header >> 1) & 3
        const blockSize = header >>> 3
        if (type === 0 || type === 2) offset += blockSize
        else if (type === 1) offset += 1
        else throw new Error('保留的 block type')
        if (++guard > 100000) throw new Error('block 数量异常')
      }
      if (hasChecksum) offset += 4
      if (offset > buffer.length) throw new Error('frame 越界')
      frames.push({ start, end: offset })
    } catch {
      // 末尾可能是正在写入的半个 frame：从这里截断
      break
    }
  }
  return frames
}

/** 解码一个 DSH 会话日志文件（多帧拼接）；坏帧跳过。 */
export function decodeSessionLog(file) {
  const buffer = fs.readFileSync(file)
  const frames = scanZstdFrames(buffer)
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
    } catch {
      /* 单帧损坏跳过 */
    }
  }
  const text = Buffer.concat(parts).toString('utf8')
  return { text, frames: frames.length, bytes: Buffer.byteLength(text) }
}

/** 从事件里取「可读文本」（只取 text，不取 reasoning/tool-call/tool-result）。 */
function partsText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/** 把一个会话日志解析成 [{role, text, at}]。 */
export function parseSessionEvents(text) {
  const turns = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const content = partsText(event.data?.content ?? event.data?.message?.content)
      if (content) turns.push({ role: 'user', text: content, at: Number(event.time ?? 0) })
    } else if (event.type === 'assistant/message') {
      const content = partsText(event.data?.message?.content ?? event.data?.content)
      if (content) turns.push({ role: 'assistant', text: content, at: Number(event.time ?? 0) })
    }
  }
  return turns
}

/** 读会话头（第一条 session 事件），拿工作区/创建时间用于展示。 */
function readHeader(text) {
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'session') {
        return { id: event.id ? String(event.id) : null, cwd: event.cwd ? String(event.cwd) : null, createdAt: Number(event.createdAt ?? 0) }
      }
    } catch {
      continue
    }
    break
  }
  return { id: null, cwd: null, createdAt: 0 }
}

/** 列出 DSH 历史会话（不解压内容，只给元信息；turns 需要时再 decode）。 */
export function listDshSessions({ dshHome, limit = 50 } = {}) {
  const root = path.join(resolveDshHome(dshHome), 'sessions')
  const sessions = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name)
    let sessionDirs = []
    try {
      sessionDirs = fs.readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const dir of sessionDirs) {
      const dirPath = path.join(projectDir, dir.name)
      let files = []
      try {
        files = fs.readdirSync(dirPath).filter((name) => name === 'session.v4.jsonl.zstd' || name === 'session.v4.jsonl' || name.endsWith('.jsonl.zstd'))
      } catch {
        continue
      }
      if (files.length === 0) continue
      const fileName = files.includes('session.v4.jsonl.zstd') ? 'session.v4.jsonl.zstd' : files[0]
      const file = path.join(dirPath, fileName)
      let stat = null
      try {
        stat = fs.statSync(file)
      } catch {
        continue
      }
      if (stat.size > MAX_BYTES_PER_FILE) continue
      sessions.push({
        sessionId: dir.name.startsWith('session-') ? dir.name.slice('session-'.length) : dir.name,
        dirName: dir.name,
        workspace: project.name.replace(/^--|--$/g, ''),
        file,
        compressed: fileName.endsWith('.zstd'),
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
      })
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions.slice(0, Math.max(1, limit))
}

/**
 * 把 DSH 历史会话整理成蒸馏用的 conversations（末尾优先，单会话截断）。
 * @param {{dshHome?: string, sessionIds?: string[], maxSessions?: number, maxCharsPerSession?: number, limit?: number}} input
 */
export function collectDshConversations({
  dshHome,
  sessionIds,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxCharsPerSession = DEFAULT_MAX_CHARS,
  limit = 200,
} = {}) {
  const wanted = Array.isArray(sessionIds) && sessionIds.length > 0 ? new Set(sessionIds.map(String)) : null
  const candidates = listDshSessions({ dshHome, limit })
    .filter((session) => (wanted ? wanted.has(session.sessionId) || wanted.has(session.dirName) : true))
    .slice(0, Math.max(1, maxSessions))

  const conversations = []
  for (const session of candidates) {
    let decoded
    try {
      decoded = session.compressed ? decodeSessionLog(session.file) : { text: fs.readFileSync(session.file, 'utf8') }
    } catch {
      continue
    }
    const turns = parseSessionEvents(decoded.text)
    if (turns.length === 0) continue
    const header = readHeader(decoded.text)
    const full = turns.map((turn) => `${turn.role === 'assistant' ? 'AI' : '用户'}: ${turn.text}`).join('\n')
    conversations.push({
      sessionId: session.sessionId,
      source: 'dsh',
      workspace: session.workspace,
      cwd: header.cwd,
      turns: turns.length,
      chars: full.length,
      text: full.length > maxCharsPerSession ? full.slice(-maxCharsPerSession) : full,
      truncated: full.length > maxCharsPerSession,
      updatedAt: session.updatedAt,
    })
  }
  conversations.sort((a, b) => b.updatedAt - a.updatedAt)
  return conversations
}
