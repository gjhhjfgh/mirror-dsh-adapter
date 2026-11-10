/**
 * core/diagnostics.js —— 诊断包导出（出问题时能一次性把现场带给我）
 *
 * 隐私原则：**只导出统计与配置，不导出记忆/文档/对话正文**。
 * 输出两个文件（同一目录）：
 *   diag-<ts>.json —— 机器可读（版本、平台、计数、最近日志、配置脱敏后）
 *   diag-<ts>.md   —— 人可读（贴进 issue 就行）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 配置脱敏：路径只留最后一段，避免泄露用户名/目录结构。 */
export function sanitizeConfig(config = {}) {
  const out = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (typeof value === 'string' && (key.toLowerCase().includes('dir') || key.toLowerCase().includes('path'))) {
      const trimmed = String(value).trim()
      out[key] = trimmed ? `…${path.basename(trimmed)}` : ''
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 120)
    } else if (typeof value === 'object' && value !== null) {
      out[key] = Array.isArray(value) ? value.slice(0, 10) : '[object]'
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 生成诊断包。
 * @param {{dataDir: string, version: string, summary: object, logs?: object[], config?: object, now?: number}} input
 * @returns {{jsonPath: string, mdPath: string, createdAt: number}}
 */
export function createDiagnostics({ dataDir, version, summary = {}, logs = [], config = {}, now = Date.now() } = {}) {
  if (!dataDir) throw new Error('缺少 dataDir')
  const dir = path.join(String(dataDir), 'diagnostics')
  fs.mkdirSync(dir, { recursive: true })
  const name = `diag-${stamp(new Date(now))}`
  const jsonPath = path.join(dir, `${name}.json`)
  const mdPath = path.join(dir, `${name}.md`)

  const payload = {
    format: 'mirror-diagnostics/1',
    createdAt: now,
    version,
    platform: { node: process.versions.node, platform: process.platform, arch: process.arch, release: os.release() },
    summary,
    config: sanitizeConfig(config),
    logs: (Array.isArray(logs) ? logs : []).slice(-50),
  }
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const lines = [
    `# Mirror 诊断包（${new Date(now).toLocaleString()}）`,
    '',
    `- 版本：${version}`,
    `- Node：${process.versions.node} · ${process.platform}/${process.arch}`,
    '',
    '## 统计（不含任何正文内容）',
    '',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    '',
    '## 配置（已脱敏）',
    '',
    '```json',
    JSON.stringify(payload.config, null, 2),
    '```',
    '',
    '## 最近日志',
    '',
    ...(payload.logs.length > 0 ? payload.logs.map((entry) => `- [${entry.level ?? 'info'}] ${entry.message ?? ''}`) : ['（无）']),
    '',
    '> 本文件不含记忆/文档/对话正文；可直接贴进 issue。',
    '',
  ]
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')
  return { jsonPath, mdPath, createdAt: now }
}

/** 只保留最近 N 个诊断包。 */
export function pruneDiagnostics(dataDir, keep = 10) {
  const dir = path.join(String(dataDir ?? ''), 'diagnostics')
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith('diag-'))
  } catch {
    return { removed: 0 }
  }
  const groups = new Map()
  for (const name of names) {
    const base = name.replace(/\.(json|md)$/, '')
    groups.set(base, [...(groups.get(base) ?? []), name])
  }
  const bases = [...groups.keys()].sort().reverse()
  let removed = 0
  for (const base of bases.slice(keep)) {
    for (const name of groups.get(base) ?? []) {
      try {
        fs.rmSync(path.join(dir, name), { force: true })
        removed += 1
      } catch {
        /* 忽略 */
      }
    }
  }
  return { removed }
}
