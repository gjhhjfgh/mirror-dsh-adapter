/**
 * core/capture.js —— 会话捕获（本地、需显式授权）
 *
 * 用户要求：1) 记录你跟 AI 聊天时说了什么、AI 怎么回的（授权后才记）。
 *
 * 设计约束：
 *   - **默认关闭**。只有用户显式打开（面板开关 / mirror_capture 工具 / 配置 capture: true）才写盘。
 *   - 只存本地：<dataDir>/sessions/<sessionId>.jsonl，一行一轮，带时间戳与角色。
 *   - 原始对话只用于「蒸馏」，蒸馏产出的记忆包里**不包含原文**（见 core/distill.js）。
 *   - 不做任何上传；路径可由用户随时删除。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 捕获开关文件（与 DB 分开，删除即恢复默认关闭）。 */
function stateFile(dataDir) {
  return path.join(String(dataDir), 'capture.json')
}

/** 会话目录。 */
export function sessionsDir(dataDir) {
  return path.join(String(dataDir), 'sessions')
}

/** 读捕获开关。 */
export function getCaptureState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8'))
    return { enabled: raw.enabled === true, enabledAt: raw.enabledAt ?? null }
  } catch {
    return { enabled: false, enabledAt: null }
  }
}

/** 打开/关闭捕获。关闭不删历史，只是不再追加。 */
export function setCaptureState(dataDir, enabled) {
  const next = { enabled: enabled === true, enabledAt: enabled === true ? Date.now() : null }
  fs.mkdirSync(String(dataDir), { recursive: true })
  fs.writeFileSync(stateFile(dataDir), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 会话文件名安全化。 */
function safeSessionId(sessionId) {
  return String(sessionId ?? 'unknown').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'unknown'
}

/** 容量治理默认值：单会话文件超过 2MB 就只留末尾 60%；最多保留 100 个会话。 */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
export const DEFAULT_MAX_SESSIONS = 100

/**
 * 单会话文件超限时截断：保留最后 60% 的行（最近的对话），写回文件。
 * 返回 { rotated, bytes }。
 */
function rotateIfOversized(file, maxBytes) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { rotated: false, bytes: 0 }
  }
  if (stat.size <= maxBytes) return { rotated: false, bytes: stat.size }
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim())
    const keep = lines.slice(Math.max(0, Math.floor(lines.length * 0.4)))
    fs.writeFileSync(file, `${keep.join('\n')}\n`, 'utf8')
    return { rotated: true, bytes: fs.statSync(file).size }
  } catch {
    return { rotated: false, bytes: stat.size }
  }
}

/**
 * 追加一轮对话。捕获关闭时直接返回 { skipped: true }，绝不静默写盘。
 * @param {{dataDir: string, sessionId: string, role: 'user'|'assistant'|'system', text: string, at?: number,
 *          maxFileBytes?: number}} input
 */
export function appendTurn({ dataDir, sessionId, role, text, at, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const state = getCaptureState(dataDir)
  if (!state.enabled) return { skipped: true, reason: 'capture-disabled' }
  const content = String(text ?? '')
  if (!content.trim()) return { skipped: true, reason: 'empty' }
  const dir = sessionsDir(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${safeSessionId(sessionId)}.jsonl`)
  const line = JSON.stringify({ role: role || 'user', text: content, at: at ?? Date.now() })
  fs.appendFileSync(file, `${line}\n`, 'utf8')
  const rotated = rotateIfOversized(file, maxFileBytes).rotated
  return { skipped: false, file, rotated }
}

/**
 * 只保留最近 maxSessions 个会话，删掉更早的（按 mtime）。
 * @returns {{removed: string[]}}
 */
export function pruneCaptured(dataDir, maxSessions = DEFAULT_MAX_SESSIONS) {
  const sessions = listCaptured(dataDir) // 已按 updatedAt 倒序
  const limit = Math.max(1, Number(maxSessions) || DEFAULT_MAX_SESSIONS)
  const dropped = sessions.slice(limit)
  const removed = []
  for (const session of dropped) {
    try {
      fs.rmSync(session.file, { force: true })
      removed.push(session.sessionId)
    } catch {
      /* 单个失败不影响其它 */
    }
  }
  return { removed }
}

/** 清空全部原始捕获（画像/蒸馏记录不受影响）。 */
export function clearCaptured(dataDir) {
  const sessions = listCaptured(dataDir)
  const removed = []
  for (const session of sessions) {
    try {
      fs.rmSync(session.file, { force: true })
      removed.push(session.sessionId)
    } catch {
      /* 忽略 */
    }
  }
  return { removed }
}

/** 捕获占用统计（面板容量提示用）。 */
export function captureTotals(dataDir) {
  const sessions = listCaptured(dataDir)
  return {
    sessions: sessions.length,
    bytes: sessions.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
    turns: sessions.reduce((sum, item) => sum + (Number(item.turns) || 0), 0),
    lastTurnAt: sessions[0]?.updatedAt ?? null,
  }
}

/**
 * 列出已捕获的会话。
 * @returns {{sessionId: string, file: string, turns: number, bytes: number, updatedAt: number}[]}
 */
export function listCaptured(dataDir) {
  const dir = sessionsDir(dataDir)
  let files = []
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  return files
    .map((name) => {
      const file = path.join(dir, name)
      const stat = fs.statSync(file)
      let turns = 0
      try {
        turns = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length
      } catch {
        turns = 0
      }
      return { sessionId: name.replace(/\.jsonl$/, ''), file, turns, bytes: stat.size, updatedAt: stat.mtimeMs }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读某个会话的轮次（解析失败的行跳过）。 */
export function readCaptured(dataDir, sessionId) {
  const file = path.join(sessionsDir(dataDir), `${safeSessionId(sessionId)}.jsonl`)
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const turns = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed.text === 'string') turns.push(parsed)
    } catch {
      /* 单行坏数据跳过 */
    }
  }
  return turns
}

/**
 * 取「待蒸馏」的会话内容：默认最近 N 个会话、每个会话最多 M 字。
 * @param {{dataDir: string, sessionIds?: string[], maxSessions?: number, maxCharsPerSession?: number}} input
 */
export function collectConversations({ dataDir, sessionIds, maxSessions = 20, maxCharsPerSession = 12000 } = {}) {
  const targets = Array.isArray(sessionIds) && sessionIds.length > 0
    ? sessionIds.map(String)
    : listCaptured(dataDir).slice(0, maxSessions).map((item) => item.sessionId)

  const conversations = []
  for (const sessionId of targets) {
    const turns = readCaptured(dataDir, sessionId)
    if (turns.length === 0) continue
    const text = turns
      .map((turn) => `${turn.role === 'assistant' ? 'AI' : '用户'}: ${turn.text}`)
      .join('\n')
    conversations.push({
      sessionId,
      turns: turns.length,
      chars: text.length,
      text: text.length > maxCharsPerSession ? text.slice(-maxCharsPerSession) : text,
      truncated: text.length > maxCharsPerSession,
      // 对话发生时间（最后一轮的 at）：蒸馏导入时用它算新鲜度，而不是"导入时间"
      observedAt: turns.reduce((max, turn) => Math.max(max, Number(turn.at) || 0), 0),
    })
  }
  return conversations
}

/** 删除某个会话的原始捕获（蒸馏完可选清理）。 */
export function dropCaptured(dataDir, sessionId) {
  try {
    fs.rmSync(path.join(sessionsDir(dataDir), `${safeSessionId(sessionId)}.jsonl`), { force: true })
    return true
  } catch {
    return false
  }
}
