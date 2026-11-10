/**
 * 装机链路回归：mirror-install / mirror-doctor / 样例包。
 *
 * 1) install 能装进一个空 profile（文件 + patch 条目 + 依赖登记）
 * 2) install 幂等（重复跑不会重复写 patch 条目）
 * 3) doctor 在装好的 profile 上 0 FAIL；在空目录上 FAIL 且退出码 1
 * 4) 样例包能被真实解析器接受并试装
 * 5) package.json 的 bin / engines / files 与实际文件一致
 *
 * 运行：node tests/install-doctor.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const NODE = process.execPath

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-install-'))
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

function run(script, args = []) {
  try {
    const stdout = execFileSync(NODE, [path.join(ROOT, 'bin', script), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: path.join(tmpRoot, 'dsh-home') },
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

console.log('装机链路回归（install / doctor / samples）')
console.log(`  临时目录：${tmpRoot}`)

const profile = path.join(tmpRoot, 'dsh-home', 'profiles', 'web')
fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
fs.writeFileSync(
  path.join(profile, 'package.json'),
  `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`,
  'utf8',
)

const installed = run('mirror-install.mjs', ['--profile', profile])
const moduleDir = path.join(profile, 'node_modules', 'mirror-dsh-adapter')

await check('mirror-install：把插件装进空 profile', () => {
  assert.equal(installed.code, 0, installed.stdout)
  for (const rel of ['lib/index.js', 'lib/client.js', 'core/index.js', 'package.json', 'cordis.patch.yml']) {
    assert.ok(fs.existsSync(path.join(moduleDir, rel)), `缺少 ${rel}`)
  }
})

await check('mirror-install：cordis.patch.yml 追加 mirror 条目', () => {
  const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('mirror-dsh-adapter'), 'patch 应包含插件名')
  assert.ok(patch.includes('mirror-memory'), 'patch 应包含 id: mirror-memory')
})

await check('mirror-install：profile 清单登记依赖与 bundle', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies['mirror-dsh-adapter'], '应写入 dependencies')
  assert.ok(manifest.dsh.profile.bundles.includes('mirror-dsh-adapter'), '应加入 bundles')
  assert.ok(fs.existsSync(path.join(profile, 'package.json.bak-mirror-install')), '应留一份备份')
})

await check('mirror-install：幂等（重复跑不重复追加 patch 条目）', () => {
  const again = run('mirror-install.mjs', ['--profile', profile])
  assert.equal(again.code, 0, again.stdout)
  const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  const occurrences = patch.split('name: "mirror-dsh-adapter"').length - 1
  assert.equal(occurrences, 1, `patch 条目应只有 1 个，实际 ${occurrences}`)
})

await check('mirror-install --check：只预演不写盘', () => {
  const fresh = path.join(tmpRoot, 'dry-run-profile')
  fs.mkdirSync(path.join(fresh, 'node_modules'), { recursive: true })
  const dry = run('mirror-install.mjs', ['--profile', fresh, '--check'])
  assert.equal(dry.code, 0, dry.stdout)
  assert.ok(!fs.existsSync(path.join(fresh, 'node_modules', 'mirror-dsh-adapter')), '--check 不应写文件')
  assert.ok(dry.stdout.includes('预演') || dry.stdout.includes('不写盘'), dry.stdout)
})

const dataDir = path.join(tmpRoot, 'data')
const doctorOk = run('mirror-doctor.mjs', ['--profile', profile, '--data-dir', dataDir])
const doctorBad = run('mirror-doctor.mjs', ['--profile', path.join(tmpRoot, 'empty-profile'), '--data-dir', dataDir])

await check('mirror-doctor：装好的 profile 全部通过', () => {
  assert.equal(doctorOk.code, 0, doctorOk.stdout)
  assert.ok(!doctorOk.stdout.includes('✗'), doctorOk.stdout)
  assert.ok(doctorOk.stdout.includes('0 FAIL'), doctorOk.stdout)
})

await check('mirror-doctor：空 profile 报 FAIL 且退出码 1', () => {
  assert.equal(doctorBad.code, 1, doctorBad.stdout)
  assert.ok(doctorBad.stdout.includes('FAIL'), doctorBad.stdout)
})

await check('样例包：能被真实解析器接受并试装', async () => {
  const file = path.join(ROOT, 'samples', 'godot-2d-pipeline.mirrorpack')
  assert.ok(fs.existsSync(file), '缺少样例包（跑 node scripts/build-samples.mjs）')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(raw.profile && raw.profile.experiences.length >= 4, '样例包应包含经验条目')
  assert.ok(raw.memories.length >= 5, '样例包应包含记忆')
  const { openMirror } = await import('../core/index.js')
  const mirror = openMirror({ dataDir: path.join(tmpRoot, 'sample-db') })
  try {
    const parsed = mirror.packs.parse(raw)
    const result = mirror.packs.install({ pack: parsed, strategy: 'skip_conflicts' })
    assert.ok(result.created >= 5, `试装应写入 ≥5 条，实际 ${result.created}`)
    assert.equal(result.skipped, 0)
  } finally {
    mirror.store.close()
  }
})

await check('package.json：bin / engines / files 与实际一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.bin['mirror-install'] && pkg.bin['mirror-doctor'], '缺少 bin 入口')
  for (const rel of Object.values(pkg.bin)) assert.ok(fs.existsSync(path.join(ROOT, rel)), `bin 文件不存在：${rel}`)
  assert.match(pkg.engines.node, />=\s*22\.5/)
  for (const entry of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, entry)), `files 里声明的 ${entry} 不存在`)
  assert.ok(!pkg.private, '发布前不能是 private')
  assert.equal(pkg.license, 'MIT')
})

// ---------------- GitHub 分发（不经过 npm registry） ----------------
const { writeTarGz, extractTarGz, findPackageDir } = await import('../bin/lib/tar.mjs')

const RELEASE_ITEMS = ['lib', 'core', 'bin', 'docs', 'samples', 'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']
const releaseTarball = path.join(tmpRoot, 'release.tgz')
writeTarGz({
  sourceRoot: ROOT,
  outFile: releaseTarball,
  entries: RELEASE_ITEMS.filter((item) => fs.existsSync(path.join(ROOT, item))),
})

await check('tar：打包/解包一致，findPackageDir 能定位包根', () => {
  assert.ok(fs.statSync(releaseTarball).size > 10000, 'release 包应有内容')
  const extractDir = path.join(tmpRoot, 'extract')
  const result = extractTarGz(fs.readFileSync(releaseTarball), extractDir)
  assert.ok(result.files > 20, `应解开 ≥20 个文件，实际 ${result.files}`)
  const found = findPackageDir(extractDir)
  assert.ok(found, '应找到 package 根')
  assert.ok(fs.existsSync(path.join(found, 'lib', 'index.js')))
})

await check('tar：拒绝越界路径（tar-slip）', () => {
  // 手工构造一个 ../evil.txt 条目
  const header = Buffer.alloc(512, 0)
  header.write('../evil.txt', 0, 'utf8')
  header.write('0000644', 100, 'utf8')
  header.write('00000000000', 124, 'utf8')
  header.write('0', 156, 'utf8')
  header.write('ustar\0', 257, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  const body = Buffer.from('x')
  const payload = Buffer.concat([header, body, Buffer.alloc(511, 0), Buffer.alloc(1024, 0)])
  assert.throws(() => extractTarGz(gzipSync(payload), path.join(tmpRoot, 'evil')), /不安全路径|越界/)
})

const tarballProfile = path.join(tmpRoot, 'tarball-profile')
fs.mkdirSync(path.join(tarballProfile, 'node_modules'), { recursive: true })
fs.writeFileSync(
  path.join(tarballProfile, 'package.json'),
  `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
  'utf8',
)
const tarballInstall = run('mirror-install.mjs', ['--profile', tarballProfile, '--tarball', releaseTarball])

await check('GitHub tarball 安装：写文件 + vendor + file: 依赖（不需要 npm）', () => {
  assert.equal(tarballInstall.code, 0, tarballInstall.stdout)
  assert.ok(fs.existsSync(path.join(tarballProfile, 'node_modules', 'mirror-dsh-adapter', 'lib', 'index.js')))
  const vendorDir = path.join(tarballProfile, 'vendor')
  const vendorFiles = fs.readdirSync(vendorDir)
  assert.equal(vendorFiles.length, 1, `vendor 应有 1 个 tarball，实际 ${vendorFiles.join(',')}`)
  const manifest = JSON.parse(fs.readFileSync(path.join(tarballProfile, 'package.json'), 'utf8'))
  assert.match(manifest.dependencies['mirror-dsh-adapter'], /^file:\.\/vendor\/mirror-dsh-adapter-.*\.tgz$/)
  assert.ok(manifest.dsh.profile.bundles.includes('mirror-dsh-adapter'))
})

await check('BOM 清单：带 UTF-8 BOM 的 package.json 也能正确登记依赖', () => {
  const bomProfile = path.join(tmpRoot, 'bom-profile')
  fs.mkdirSync(path.join(bomProfile, 'node_modules'), { recursive: true })
  fs.writeFileSync(
    path.join(bomProfile, 'package.json'),
    `\uFEFF${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } })}`,
    'utf8',
  )
  const result = run('mirror-install.mjs', ['--profile', bomProfile, '--source', ROOT])
  assert.equal(result.code, 0, result.stdout)
  const raw = fs.readFileSync(path.join(bomProfile, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
  const manifest = JSON.parse(raw)
  assert.ok(manifest.dependencies['mirror-dsh-adapter'], '应登记依赖')
})

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，PASS ${results.length - failed}，FAIL ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
