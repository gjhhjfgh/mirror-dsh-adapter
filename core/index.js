/**
 * core/index.js —— Mirror 内核统一入口
 *
 * 用法（宿主适配器 / lib/index.js 的 HTTP 层都从这里拿内核）：
 *
 *   import { openMirror } from 'mirror-dsh-adapter/core/index.js'
 *   const mirror = openMirror({ dataDir })   // 同步返回，无需 await
 *   mirror.memories.create({ content, category: 'iron_rule' })
 *   mirror.documents.addRoot('D:/proj')
 *   mirror.documents.scan()
 *   mirror.store.close()                     // 插件卸载时调用
 *
 * 设计约束（契约 §0 / 任务要求）：
 *   - 同步返回：宿主用 lazy dynamic import 调它，不需要处理 Promise。
 *   - 零外部依赖：只用 node:*。
 *   - 这里只是「装配 + 再导出」，所有业务逻辑都在各模块里。
 */

import { openStore } from './storage.js'
import { MemoryService } from './memory.js'
import { Arbiter } from './arbiter.js'
import { DocumentService } from './documents.js'
import { PackService } from './packs.js'

/**
 * 打开一个 Mirror 内核实例。
 * @param {{dataDir?: string}} opts dataDir 必须指向可写目录；测试请用 os.tmpdir()
 * @returns {{store: object, memories: MemoryService, documents: DocumentService, packs: PackService, arbiter: Arbiter}}
 */
export function openMirror({ dataDir } = {}) {
  const store = openStore({ dataDir })
  const arbiter = new Arbiter({ now: () => store.now() })
  const memories = new MemoryService({ store })
  const documents = new DocumentService({ store })
  const packs = new PackService({ store, memories, arbiter })
  return { store, memories, documents, packs, arbiter }
}

// ---- 各模块（供测试/CLI 单独使用）----
export { openStore, openStore as default, defaultDataDir, migrate, SCHEMA_VERSION, newId } from './storage.js'
export { MemoryService, CATEGORIES, LAYERS, AUTHORITIES, RESOLUTIONS, rowToMemory, rowToConflict } from './memory.js'
export {
  Arbiter,
  AUTHORITY_WEIGHT,
  normalizeText,
  bigramJaccard,
  bigramContainment,
  isOpposite,
  containsWord,
  stripPairWords,
  findOppositePair,
  sharedTopicWords,
  hasSharedTopic,
} from './arbiter.js'
export {
  DocumentService,
  chunkText,
  chunkMarkdown,
  chunkCode,
  chunkParagraph,
  detectFileType,
  splitQueryTerms,
  buildMatchQuery,
  reviewRelation,
  rowToDocument,
  rowToChunk,
} from './documents.js'
export {
  PackService,
  toPackFile,
  compareVersion,
  buildPackId,
  MIRROR_VERSION,
  INSTALL_STRATEGIES,
  rowToInstalledPack,
} from './packs.js'
export { estimateTokens, retrieve, buildInjection, SECTION_META } from './retrieve.js'
export { EXTRACT_PROMPT, fillPrompt, parseExtraction, heuristicExtract, formatExistingMemories } from './extract.js'
