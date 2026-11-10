#!/usr/bin/env node
/**
 * build-samples —— 生成可导入的样例记忆包（samples/*.mirrorpack）。
 * 用真实的包解析器自校验，保证样例一定能被导入。
 *
 * 用法：node scripts/build-samples.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const SAMPLES_DIR = path.join(PACKAGE_ROOT, 'samples')

const PACK = {
  $schema: 'https://mirror.dev/schemas/pack/v1.json',
  pack_id: 'godot-2d-pipeline',
  name: 'Godot 2D 上线流程包',
  version: '1.0.0',
  format_version: '1.0',
  author: 'Mirror Samples',
  category: 'template',
  description:
    '一个 Godot 2D 小项目从 0 到上线的可复用判断：先做什么、什么时候别让 AI 碰、哪些坑必踩。含 4 条经验与其边界（示例内容，可自由改装）。',
  min_mirror_version: '0.0.0',
  memories: [
    {
      category: 'iron_rule',
      layer: 'fact',
      content: '场景脚本里不要写资源路径字符串，统一走 preload/export 变量',
      structured: {},
      authority: 'imported',
      scope: 'global',
      tags: ['godot', 'sample'],
    },
    {
      category: 'preference',
      layer: 'strategy',
      content: '节点命名用 PascalCase，脚本文件名与主节点同名',
      structured: {},
      authority: 'imported',
      scope: 'global',
      tags: ['godot', 'sample'],
    },
    {
      category: 'decision',
      layer: 'strategy',
      content: '先做可玩的 10 秒循环，再补动画与音效',
      structured: {},
      authority: 'imported',
      scope: 'global',
      tags: ['godot', 'sample'],
    },
    {
      category: 'pitfall',
      layer: 'strategy',
      content: '避免：在 _process 里每帧 new 节点或用 get_node 查路径',
      structured: {},
      authority: 'imported',
      scope: 'global',
      tags: ['godot', 'sample'],
    },
    {
      category: 'pitfall',
      layer: 'strategy',
      content: '避免：让 AI 直接改 project.godot 的输入映射而不先备份',
      structured: {},
      authority: 'imported',
      scope: 'global',
      tags: ['godot', 'sample'],
    },
    {
      category: 'fuzzy',
      layer: 'fragment',
      content: '用 Godot 4 时 CharacterBody2D 与 move_and_slide 的参数在 4.3 之后有变化',
      structured: {},
      authority: 'imported',
      scope: 'global',
      tags: ['godot', 'sample'],
    },
  ],
  profile: {
    profile: '独立开发者，做 2D 小游戏，偏好先把循环跑通再堆内容。',
    confidence: 0.85,
    preferences: ['节点命名 PascalCase，脚本名与主节点一致', '先可玩循环，后表现层'],
    rules: ['场景脚本不写资源路径字符串'],
    patterns: ['先做 10 秒可玩循环', '每个系统单独一个小场景验证'],
    skills: ['Godot 4 2D 场景组织', '像素风资源管线'],
    avoid: ['_process 里每帧 new 节点', '直接改 project.godot 不备份'],
    experiences: [
      {
        trigger: '用 AI 改一个跨 3 个文件的 Godot 脚本 bug',
        action: '先让 AI 复述现状与假设，再单文件改，每个文件后跑一次场景',
        why: '跨文件失败时无法定位是哪一步引入的',
        boundary: '纯文案/配置改动不需要',
        evidence: '多个 Godot 项目的历史会话',
        confidence: 0.85,
      },
      {
        trigger: '准备让 AI 写一个新的游戏系统',
        action: '先手写 20 行骨架与数据流，再让 AI 补实现',
        why: 'AI 更容易在既有骨架上补全，而不是从零设计结构',
        boundary: '纯 UI 布局可以让 AI 从零开始',
        evidence: '战斗/背包/存档三个系统的实现过程',
        confidence: 0.8,
      },
      {
        trigger: '上线前一周发现性能掉帧',
        action: '先用 Godot 内置监视器定位，再抓 3 帧数据，最后才改代码',
        why: '凭感觉优化通常改错地方',
        boundary: '明显的内存泄漏不需要采样',
        evidence: '一次上线前的掉帧排查',
        confidence: 0.75,
      },
      {
        trigger: 'AI 建议升级 Godot 主版本',
        action: '先建一个独立分支试跑导出，再决定是否合并',
        why: '主版本升级会同时影响脚本 API 与导出模板',
        boundary: '补丁版本升级可以直接跟',
        evidence: '4.2 → 4.3 的升级经验',
        confidence: 0.8,
      },
    ],
  },
  doc_references: [],
  changelog: [
    {
      version: '1.0.0',
      date: '2026-11-10',
      changes: '首个样例包：6 条记忆 + 4 条经验（含边界）',
    },
  ],
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-sample-'))
try {
  const { openMirror } = await import('../core/index.js')
  const mirror = openMirror({ dataDir: tmpDir })
  const parsed = mirror.packs.parse(PACK)
  const installed = mirror.packs.install({ pack: parsed, strategy: 'skip_conflicts' })
  mirror.store.close()

  fs.mkdirSync(SAMPLES_DIR, { recursive: true })
  const file = path.join(SAMPLES_DIR, 'godot-2d-pipeline.mirrorpack')
  fs.writeFileSync(file, `${JSON.stringify(PACK, null, 2)}\n`, 'utf8')
  console.log(`[samples] 已生成 ${file}`)
  console.log(`[samples] 自校验：解析通过，试装 created=${installed.created} skipped=${installed.skipped}`)
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
