/**
 * core/auto-distill.js —— 自动蒸馏的状态机（轮末累计，到点就跑一次）
 *
 * 设计取舍：
 *   - 只做「计数 + 到点触发」，真正的蒸馏仍复用 distill.run（heuristic 兜底）；
 *   - 默认关闭：自动蒸馏会把 AI 的推断写进画像，应该是用户显式选择；
 *   - 状态落在 <dataDir>/auto-distill.json，错误可读、可手改，不进 SQLite 免得迁移。
 */

import fs from 'node:fs'
import path from 'node:path'

export const AUTO_DISTILL_DEFAULTS = {
  enabled: false,
  every: 20, // 累计多少轮跑一次
  minTurns: 8, // 至少攒够多少轮，避免刚开就跑个空蒸馏
  importToMemories: false, // 跑完是否直接写入记忆库（默认不写）
  source: 'capture', // capture / dsh / all
  sinceLastRun: 0,
  lastRunAt: 0,
  lastDistillId: null,
  lastResult: null,
}

export function autoDistillStatePath(dataDir) {
  return path.join(String(dataDir ?? ''), 'auto-distill.json')
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** 读状态（文件损坏时回退默认值，绝不抛错）。 */
export function readAutoDistillState(dataDir) {
  const file = autoDistillStatePath(dataDir)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...AUTO_DISTILL_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...AUTO_DISTILL_DEFAULTS }
  }
}

export function writeAutoDistillState(dataDir, state) {
  const file = autoDistillStatePath(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return state
}

/** 更新配置项（enabled/every/minTurns/importToMemories/source）。 */
export function updateAutoDistillState(dataDir, patch = {}) {
  const current = readAutoDistillState(dataDir)
  const next = { ...current }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (patch.every !== undefined) next.every = clampInt(patch.every, 5, 200, current.every)
  if (patch.minTurns !== undefined) next.minTurns = clampInt(patch.minTurns, 2, 100, current.minTurns)
  if (patch.importToMemories !== undefined) next.importToMemories = patch.importToMemories === true
  if (patch.source !== undefined) {
    const source = String(patch.source)
    if (['capture', 'dsh', 'all'].includes(source)) next.source = source
  }
  return writeAutoDistillState(dataDir, next)
}

/**
 * 记一轮对话，返回是否到点该跑了。
 * @returns {{state: object, due: boolean}}
 */
export function recordTurn(dataDir, count = 1) {
  const state = readAutoDistillState(dataDir)
  // 关闭时不写盘：每轮都写一个小文件没必要，也避免磁盘噪音
  if (state.enabled !== true) return { state, due: false }
  state.sinceLastRun = Math.max(0, Number(state.sinceLastRun ?? 0)) + Math.max(1, Number(count) || 1)
  const due = state.sinceLastRun >= Number(state.every ?? 20) && state.sinceLastRun >= Number(state.minTurns ?? 8)
  writeAutoDistillState(dataDir, state)
  return { state, due }
}

/** 记录一次自动蒸馏的结果（重置计数）。 */
export function markAutoDistillRun(dataDir, { distillId = null, before = null, after = null, skipped = null } = {}) {
  const state = readAutoDistillState(dataDir)
  const next = {
    ...state,
    sinceLastRun: 0,
    lastRunAt: Date.now(),
    lastDistillId: distillId ?? state.lastDistillId,
    lastResult: { distillId, before, after, skipped, at: Date.now() },
  }
  return writeAutoDistillState(dataDir, next)
}

/** 面板/工具用的状态摘要。 */
export function autoDistillStatus(dataDir) {
  const state = readAutoDistillState(dataDir)
  const every = Number(state.every ?? 20)
  const since = Number(state.sinceLastRun ?? 0)
  return {
    ...state,
    due: state.enabled === true && since >= every && since >= Number(state.minTurns ?? 8),
    remaining: Math.max(0, every - since),
  }
}
