/**
 * 检查「浏览器端」是否真的被宿主编排并可以服务。
 *
 * 只看 host 端 HTTP 是不够的：左侧栏入口由客户端 bundle（lib/client.js）在浏览器里注册，
 * 而 boot graph 只在 dsh web 进程启动时编排。这个脚本从 /plugins/events 的 graph 帧里
 * 找到本插件，然后把它实际的 combo 包下载下来做内容断言。
 *
 * 用法：node scripts/check-client.mjs [port]
 * 退出码：0 = PASS，1 = FAIL（可直接给 verify.ps1 用）
 *
 * 注意：/plugins/events 是 SSE，读完 graph 帧要主动 cancel reader；否则在 Node/Windows 上
 * 退出时可能触发 libuv 断言。这里统一走 finish()：先关流，给事件循环一拍，再置退出码。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'

const PORT = Number(process.argv[2] || 3080)
const BASE = `http://127.0.0.1:${PORT}`
const PLUGIN_ID = 'mirror-dsh-adapter'
/**
 * 运行目录里的 client.js：用来判断「boot graph 的 rev」是否还等于磁盘上的文件。
 * 只改文件、不重启进程时，宿主会照样按旧 rev 服务（内容其实是新文件），
 * 所以只对比 bundle 内容会误判成「已生效」——必须比 rev。
 */
const CLIENT_FILE =
  process.argv[3] || '$DSH_HOME/profiles/web\\node_modules\\mirror-dsh-adapter\\lib\\client.js'

const failures = []
const pass = (label) => console.log(`  PASS  ${label}`)
const fail = (label) => {
  failures.push(label)
  console.log(`  FAIL  ${label}`)
}

/** 与 dsh-client-modules 的 artifactRevision 完全一致：sha1("plugin-artifact\0" + framed(mtimeMs,ctimeMs,size)) 取前 12 位。 */
function diskRevision() {
  try {
    if (!fs.existsSync(CLIENT_FILE)) return null
    const stat = fs.statSync(CLIENT_FILE)
    const hash = crypto.createHash('sha1').update('plugin-artifact').update('\0')
    for (const part of [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)]) {
      hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
    }
    return hash.digest('hex').slice(0, 12)
  } catch {
    return null
  }
}

async function readGraph(timeoutMs = 6000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reader
  try {
    const response = await fetch(`${BASE}/plugins/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (response.status !== 200) throw new Error(`/plugins/events -> HTTP ${response.status}`)
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      const line = text.split('\n').find((row) => row.startsWith('data: ') && row.includes('"type":"graph"'))
      if (line) return JSON.parse(line.slice('data: '.length)).graph
      if (text.length > 400000) break
    }
    throw new Error('/plugins/events 没有在超时前送出 graph 帧')
  } finally {
    clearTimeout(timer)
    try {
      await reader?.cancel()
    } catch {
      /* already closed */
    }
    controller.abort()
  }
}

async function check() {
  let graph
  try {
    graph = await readGraph()
  } catch (error) {
    fail(`读取 /plugins/events 失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const entries = graph.entries || []
  const entry = entries.find((row) => row.id === PLUGIN_ID)
  if (!entry) {
    fail(
      `boot graph 共 ${entries.length} 个客户端插件，但没有 ${PLUGIN_ID}。` +
        '可能是进程还是旧的，或 package.json 的 dsh.client 声明有问题。',
    )
    return
  }
  pass(`boot graph 含 ${PLUGIN_ID}（rev=${entry.rev}，共 ${entries.length} 个客户端插件）`)

  // 关键：只改文件不重启进程时，宿主仍按旧 rev 服务（内容是新文件），所以必须比 rev。
  const expected = diskRevision()
  if (expected === null) {
    pass(`磁盘上没找到 ${CLIENT_FILE}，跳过 rev 新鲜度检查`)
  } else if (expected === entry.rev) {
    pass(`boot graph rev 与磁盘一致（rev=${entry.rev}；注意 HMR 会刷新 rev，判断进程是否重启看 verify.ps1 的 R1 能力项）`)
  } else {
    fail(
      `boot graph 的 rev=${entry.rev} 落后于磁盘（${expected}）：dsh web 进程是在最后一次 sync 之前启动的。` +
        '请运行 scripts/restart-dsh.ps1 后重新刷新页面。',
    )
  }

  let source = ''
  try {
    const response = await fetch(`${BASE}/${entry.url}`)
    source = await response.text()
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    fail(`下载客户端 bundle 失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const checks = [
    ['__ModuleLoader__ factory 包', source.includes('id: "mirror-dsh-adapter"') && source.includes('factory:')],
    ['注册了左侧栏入口 sidebar.panellist', source.includes('sidebar.panellist') && source.includes('id: "mirror"')],
    ['注册了中央列主面板 name: "main"', source.includes('name: "main"') && source.includes('key: "mirror"')],
    ['带了左侧栏图标组件', source.includes('MirrorIcon')],
    ['没有遗留 ESM 语法', !/^\s*(import|export)\s/m.test(source)],
  ]
  for (const [label, ok] of checks) {
    if (ok) pass(`客户端 bundle：${label}`)
    else fail(`客户端 bundle 内容检查未通过：${label}`)
  }
  if (failures.length === 0) pass(`客户端 bundle 可服务（${source.length} bytes）`)
}

await check()

// 先让 SSE 的 socket 彻底关掉，再给事件循环一拍；个别环境仍挂着连接时 1.5s 后强制退出。
await new Promise((resolve) => setTimeout(resolve, 120))
process.exitCode = failures.length === 0 ? 0 : 1
setTimeout(() => process.exit(process.exitCode), 1500).unref()
