/**
 * Mirror · DSH 插件（宿主端）
 *
 * 一个进程内内核，不做独立服务：
 *   - core/* 用 node:sqlite 直接落盘（记忆 / 文档库 / 记忆包 / 冲突 / 审计）
 *   - 本文件负责把内核接进 DSH：工具、逐轮注入、浏览器面板的 HTTP API
 *
 * 设计要点：
 *   - 内核按需懒加载：插件启动时绝不因为数据目录、sqlite 或坏文件而炸掉宿主；
 *     第一次真正用到时初始化，失败则所有工具返回中文错误、面板拿到 503。
 *   - 逐轮注入是「缓存 + 同步读取」：agent/pre-step 阶段异步组装文本放 Map，
 *     systemPrompt.section 的 text() 是同步函数，只读缓存，绝不在 prompt 组装时发 IO。
 *   - HTTP API 只接受 loopback 请求，只读同源页面，不需要额外鉴权。
 */

import os from "node:os";
import path from "node:path";

const VERSION = "2.3.0";
/** 注入 section 的排序：早于 first-party 的 persona 尾巴。 */
const SECTION_ORDER = 9500;
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".mirror");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONVERSATION_CHARS = 8000;

/** 离线自测时可用 MIRROR_DSH_TOOLS_URL 指向真实 dsh-tools。 */
let defineTool;
try {
  ({ defineTool } = await import(process.env.MIRROR_DSH_TOOLS_URL || "@deepseek-ai/dsh-tools"));
} catch {
  // defineTool 的产物本来就是普通定义对象，宿主缺该包时退化为恒等函数。
  defineTool = (definition) => definition;
}

export const name = "mirror-adapter";
export const inject = ["tools", "systemPrompt"];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 安全 JSON 解析：损坏的数据返回 null，不让面板/工具崩。 */
function safeJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 落一条蒸馏记录（profile 存 JSON；原始对话不写入这里）。 */
function saveDistillation(opened, profile, conversations, source) {
  const id = `dst_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = Date.now();
  const turnCount = (conversations || []).reduce((sum, item) => sum + (Number(item.turns) || 0), 0);
  opened.store.db
    .prepare(
      `INSERT INTO distillations (id, created_at, session_ids, turn_count, profile_json, confidence, source, memory_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      createdAt,
      JSON.stringify((conversations || []).map((item) => item.sessionId)),
      turnCount,
      JSON.stringify(profile),
      Number(profile?.confidence ?? 0.6),
      source,
    );
  return { id, createdAt, turnCount };
}

function parseTags(input) {
  if (Array.isArray(input)) return input.map((tag) => String(tag)).filter(Boolean);
  if (typeof input !== "string") return [];
  return input
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** 从 DSH 的 session 事件汇总可读文本。 */
function textOf(data) {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : "";
  const content = data.content ?? data.message?.content ?? data.text;
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/** 取 messages 里最后一条 user 文本，作为本轮检索 query。 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return textOf(message);
  }
  return "";
}

/**
 * 没有模型兜底时的极简分类：只为了让 `mirror_remember` 不带 category 时
 * 也能落到合理的分类上。真正的抽取在 core/extract.js。
 */
function guessCategory(content) {
  if (/必须|禁止|不要|永远|一律|铁律|绝不能/.test(content)) return "iron_rule";
  if (/踩坑|报错|抛错|教训|坑了|避开|别再/.test(content)) return "pitfall";
  if (/决定|选用|改成|换成|方案|因为|原因/.test(content)) return "decision";
  if (/我偏好|我喜欢|习惯|以后都|倾向于/.test(content)) return "preference";
  return "fuzzy";
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大（上限 2MB）"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const dataDir = String(config.dataDir ?? "").trim() || DEFAULT_DATA_DIR;
  // DSH 家目录（读历史会话日志用）：配置 > DSH_HOME > ~/.dsh
  const dshHome = String(config.dshHome ?? process.env.DSH_HOME ?? "").trim() || path.join(os.homedir(), ".dsh");
  const tokenBudget = clamp(Number(config.injectTokenBudget ?? 3000) || 3000, 200, 8000);
  const autoExtract = config.autoExtract === true;
  const docAutoScan = config.docAutoScan !== false;
  // 逐轮注入的作用域：默认 all（全局 + 当前项目的记忆一起注入）。
  // 单用户单机场景下，"我在这个项目里的偏好/决策"比"只注入 global"更符合直觉；
  // 想严格隔离就把它设成 'global'。
  const injectScope = String(config.injectScope ?? "all").trim() || "all";
  // 常驻层（铁律 / 常驻偏好）只收这些 authority：用户显式的、或用户确认过的。
  // AI 推断（蒸馏）与导入（记忆包）的内容只能靠检索命中进入，不能永久占预算——
  // 否则蒸馏会把 AI 的措辞变成"你的铁律"。需要放宽时在这里加 'imported' / 'inferred'。
  const injectAuthorities = Array.isArray(config.injectAuthorities)
    ? config.injectAuthorities.map(String).filter(Boolean)
    : undefined;
  // 常驻偏好：不管这轮问题是否命中，都把 top N 条偏好/决策放进注入（0=关闭）。
  // 「用户的使用习惯」应该稳定在场，而不是取决于他这句话碰巧提到哪些词。
  const residentPreferences = clamp(
    Number.isFinite(Number(config.residentPreferences)) ? Number(config.residentPreferences) : 3,
    0,
    10,
  );
  // 捕获容量治理：单会话文件上限（超出只留末尾 60%）+ 最多保留多少个会话
  const captureMaxFileBytes = clamp(Number(config.captureMaxFileBytes ?? 2 * 1024 * 1024) || 2 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024);
  const captureMaxSessions = clamp(Number(config.captureMaxSessions ?? 100) || 100, 1, 1000);
  // 权威裁决模式：user_first（默认）/ doc_first / memory_first
  const authorityMode = ["user_first", "doc_first", "memory_first"].includes(String(config.authorityMode ?? ""))
    ? String(config.authorityMode)
    : "user_first";
  // 自动蒸馏：默认关闭；开启后每累计 autoDistillEvery 轮在轮末跑一次启发式蒸馏
  const autoDistillEnabled = config.autoDistill === true;
  const autoDistillEvery = clamp(Number(config.autoDistillEvery ?? 20) || 20, 5, 200);
  const autoDistillImport = config.autoDistillImport === true;

  // 最近日志环形缓冲（诊断包用；不写盘、不联网）
  const recentLogs = [];
  const pushLog = (level, message) => {
    recentLogs.push({ level, message: String(message).slice(0, 500), at: Date.now() });
    if (recentLogs.length > 50) recentLogs.shift();
  };
  const logInfo = (message) => {
    pushLog("info", message);
    ctx.logger?.info?.(`mirror: ${message}`);
  };
  const logWarn = (message) => {
    pushLog("warn", message);
    ctx.logger?.warn?.(`mirror: ${message}`);
  };
  const logError = (message) => {
    pushLog("error", message);
    ctx.logger?.error?.(`mirror: ${message}`);
  };

  // ---------------------------------------------------------------- 内核生命周期

  let core = null;
  let corePromise = null;
  let coreFailure = null;
  /** DSH 历史会话数缓存（/state 每次扫描目录太贵，30s 一次） */
  let dshSessionsCache = { at: 0, count: 0 };

  function ensureCore() {
    if (core) return Promise.resolve(core);
    if (!corePromise) {
      corePromise = (async () => {
        // 动态导入：内核的语法/依赖问题不牵连插件本身加载。
        const { openMirror } = await import("../core/index.js");
        const opened = openMirror({ dataDir });
        core = opened;
        coreFailure = null;
        logInfo(`内核已就绪：${dataDir}`);
        return opened;
      })().catch((error) => {
        corePromise = null;
        coreFailure = error instanceof Error ? error.message : String(error);
        logError(`内核初始化失败：${coreFailure}`);
        throw error;
      });
    }
    return corePromise;
  }

  /** 面板 / 工具查询前做一次节流的增量扫描。 */
  let lastScanAt = 0;
  function maybeScan(opened) {
    if (!docAutoScan) return null;
    if (Date.now() - lastScanAt < 15_000) return null;
    lastScanAt = Date.now();
    try {
      return opened.documents.scan();
    } catch (error) {
      logWarn(`自动扫描失败（不影响读取）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 注入前的节流增量扫描（§10.7）：文件是真源，用户改完文档后下一轮注入就该用新内容。
   * 与面板的 15s 节流分开计数——注入是热路径，节流放长一点（20s），失败静默。
   */
  let lastRetrieveScanAt = 0;
  function scanBeforeRetrieve(opened) {
    if (!docAutoScan) return null;
    if (Date.now() - lastRetrieveScanAt < 20_000) return null;
    lastRetrieveScanAt = Date.now();
    try {
      return opened.documents.scan();
    } catch (error) {
      logWarn(`注入前扫描失败（沿用旧索引）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- 状态组装

  const emptyStats = {
    memories: 0,
    active: 0,
    pendingConfirm: 0,
    conflicts: 0,
    documents: 0,
    chunks: 0,
    packs: 0,
    roots: 0,
    byCategory: { iron_rule: 0, preference: 0, decision: 0, pitfall: 0, fuzzy: 0 },
  };

  async function buildState({ scope = "", category = "" } = {}) {
    const opened = await ensureCore();
    maybeScan(opened);
    const scopeFilter = scope && scope !== "all" ? scope : undefined;
    const memories = opened.memories.list({ scope: scopeFilter, limit: 500 });
    if (category) {
      const filtered = memories.filter((memory) => memory.category === category);
      memories.length = 0;
      memories.push(...filtered);
    }
    const baseStats = opened.memories.stats({ scope: scopeFilter });
    const docStats = opened.documents.stats();
    let conflicts = [];
    try {
      conflicts = opened.memories.listConflicts?.({ limit: 100 }) ?? [];
      // 按"冲突来自哪次导入"分组：一次蒸馏导入可能产生一堆冲突，
      // 面板应该显示"本次导入的 N 个冲突"而不是把每条都摊开。
      const groupOf = (memory) => {
        if (!memory) return { key: "user", label: "用户记忆" };
        const sourceType = String(memory.sourceType ?? "");
        if (sourceType === "distill") return { key: `distill:${memory.sourceRef ?? "unknown"}`, label: "蒸馏导入" };
        if (sourceType === "pack") return { key: `pack:${memory.packId ?? memory.sourceRef ?? "unknown"}`, label: "记忆包导入" };
        return { key: "user", label: "用户记忆" };
      };
      conflicts = conflicts.map((conflict) => {
        // 冲突的两端可能一端是用户记忆、一端是导入内容：优先用导入端作为分组依据
        const candidates = [conflict.a, conflict.b].filter(Boolean);
        const imported = candidates.find((memory) => ["distill", "pack"].includes(String(memory.sourceType ?? "")));
        return { ...conflict, group: groupOf(imported ?? candidates[0] ?? null) };
      });
    } catch (error) {
      logWarn(`读取冲突失败：${error instanceof Error ? error.message : String(error)}`);
    }
    let stale = [];
    try {
      stale = opened.memories.stalenessCheck?.({ stalerThanDays: 90 })?.stale ?? [];
    } catch {
      stale = [];
    }
    const documents = opened.documents.list({ limit: 400 });
    const roots = opened.documents.listRoots();
    const packs = opened.packs.list();
    // 面板「关联」Tab 用：文档 ↔ 记忆的支持/矛盾关系（§10.3/§10.4）
    let links = [];
    try {
      links = opened.documents.listLinks?.({ limit: 200 }) ?? [];
    } catch (error) {
      logWarn(`读取文档-记忆关联失败：${error instanceof Error ? error.message : String(error)}`);
    }

    // 会话捕获状态 + 最近一次蒸馏画像（面板「记忆包」用）
    let capture = { enabled: false, enabledAt: null, sessions: 0, bytes: 0, turns: 0, lastTurnAt: null };
    try {
      const module = await import("../core/capture.js");
      const captureState = module.getCaptureState(dataDir);
      const totals = module.captureTotals(dataDir);
      capture = {
        enabled: captureState.enabled,
        enabledAt: captureState.enabledAt,
        sessions: totals.sessions,
        bytes: totals.bytes,
        turns: totals.turns,
        lastTurnAt: totals.lastTurnAt,
        limits: { maxSessions: captureMaxSessions, maxFileBytes: captureMaxFileBytes },
      };
    } catch (error) {
      logWarn(`读取捕获状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
    let distillation = null;
    try {
      const row = opened.store.db
        .prepare("SELECT id, created_at, turn_count, confidence, source, memory_count, profile_json FROM distillations ORDER BY created_at DESC LIMIT 1")
        .get();
      if (row) {
        distillation = {
          id: row.id,
          createdAt: Number(row.created_at ?? 0),
          turns: Number(row.turn_count ?? 0),
          confidence: Number(row.confidence ?? 0),
          source: row.source,
          memoryCount: Number(row.memory_count ?? 0),
          profile: safeJson(row.profile_json),
        };
      }
    } catch {
      distillation = null;
    }
    // 已有 DSH 历史会话数量（面板蒸馏卡片用来提示「可以直接蒸馏历史」）。
    // 目录扫描不便宜，缓存 30s：面板轮询 /state 时不该每次重扫。
    let dshSessions = 0;
    const nowMs = Date.now();
    if (nowMs - dshSessionsCache.at > 30_000) {
      try {
        const { listDshSessions } = await import("../core/dsh-sessions.js");
        dshSessionsCache = { at: nowMs, count: listDshSessions({ dshHome, limit: 200 }).length };
      } catch {
        dshSessionsCache = { at: nowMs, count: 0 };
      }
    }
    dshSessions = dshSessionsCache.count;

    // 自动蒸馏状态（面板开关与状态行用）
    let autoDistillState = null;
    try {
      const { autoDistillStatus } = await import("../core/auto-distill.js");
      autoDistillState = autoDistillStatus(dataDir);
    } catch (error) {
      logWarn(`读取自动蒸馏状态失败：${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      ok: true,
      version: VERSION,
      scope: scopeFilter ?? "all",
      dataDir,
      stats: {
        ...emptyStats,
        ...baseStats,
        conflicts: conflicts.filter((conflict) => !conflict.resolved).length,
        documents: docStats.documents ?? documents.length,
        chunks: docStats.chunks ?? 0,
        packs: packs.length,
        roots: roots.length,
      },
      memories,
      conflicts,
      documents,
      roots,
      packs,
      links,
      stale,
      capture,
      distillation,
      dshSessions,
      autoDistill: autoDistillState,
    };
  }

  // ---------------------------------------------------------------- 动作分发（HTTP 与工具共用）

  async function runAction(type, payload = {}) {
    const opened = await ensureCore();
    const memories = opened.memories;
    const documents = opened.documents;

    switch (type) {
      case "memory.create": {
        if (!payload.content || !String(payload.content).trim()) {
          return { ok: false, error: "记忆内容不能为空" };
        }
        const result = memories.create({
          content: String(payload.content).trim(),
          category: payload.category || guessCategory(String(payload.content)),
          layer: payload.layer,
          authority: payload.authority || "user_explicit",
          confidence: isNum(payload.confidence) ? payload.confidence : 1,
          scope: payload.scope || "global",
          tags: parseTags(payload.tags),
          sourceType: payload.sourceType || "panel",
          sourceRef: payload.sourceRef,
        });
        return { ok: true, ...result };
      }
      case "memory.update": {
        if (!payload.id) return { ok: false, error: "缺少 id" };
        // 兼容两种调用：{ patch: {...} } 与平铺 { content, category, ... }
        const flatKeys = ["content", "category", "layer", "structured", "confidence", "authority", "scope", "tags", "status", "validTo", "expiresAt", "frozen", "causalParent", "causalChildren", "packId", "packVersion", "sourceDoc", "docConflict"];
        const patch = { ...(payload.patch ?? {}) };
        for (const key of flatKeys) {
          if (payload[key] !== undefined && patch[key] === undefined) patch[key] = payload[key];
        }
        if (Object.keys(patch).length === 0) {
          return { ok: false, error: "没有要更新的字段（用 patch:{...} 或平铺 content/category/...）" };
        }
        if (patch.tags !== undefined) patch.tags = parseTags(patch.tags);
        const result = memories.update(String(payload.id), patch);
        if (!result?.memory) return { ok: false, error: "记忆不存在" };
        return { ok: true, ...result };
      }
      case "memory.confirm": {
        const result = memories.confirm(String(payload.id));
        if (!result?.memory) return { ok: false, error: "记忆不存在" };
        return { ok: true, ...result };
      }
      case "memory.freeze": {
        const result = memories.freeze(String(payload.id), payload.frozen !== false);
        if (!result?.memory) return { ok: false, error: "记忆不存在" };
        return { ok: true, ...result };
      }
      case "memory.invalidate": {
        const result = memories.invalidate(String(payload.id), { reason: payload.reason ?? "" });
        if (!result?.memory) return { ok: false, error: "记忆不存在" };
        return { ok: true, ...result };
      }
      case "memory.delete": {
        return { ok: true, ...memories.remove(String(payload.id)) };
      }
      case "conflict.resolve": {
        if (!memories.resolveConflict) return { ok: false, error: "内核版本不支持冲突裁决" };
        const conflict = memories.resolveConflict(String(payload.id), {
          resolution: String(payload.resolution ?? "dismiss"),
          reason: payload.reason ?? "",
        });
        if (!conflict) return { ok: false, error: "冲突不存在" };
        return { ok: true, conflict };
      }
      case "doc.addRoot": {
        const target = String(payload.path ?? "").trim();
        if (!target) return { ok: false, error: "目录路径不能为空" };
        documents.addRoot(target);
        const scan = documents.scan();
        return { ok: true, roots: documents.listRoots(), scan };
      }
      case "doc.removeRoot": {
        const target = String(payload.path ?? "").trim();
        if (!target) return { ok: false, error: "目录路径不能为空" };
        documents.removeRoot(target);
        return { ok: true, roots: documents.listRoots() };
      }
      case "doc.reindex": {
        const scan = documents.scan({ force: payload.force === true });
        return { ok: true, scan };
      }
      case "doc.search": {
        const query = String(payload.q ?? "").trim();
        if (!query) return { ok: true, results: [] };
        return { ok: true, results: documents.search({ q: query, scope: payload.scope, limit: payload.limit ?? 20 }) };
      }
      case "doc.delete": {
        if (documents.remove) return { ok: true, ...documents.remove(String(payload.id)) };
        return { ok: false, error: "内核版本不支持删除文档" };
      }
      // ---------------- 会话捕获（默认关闭，需显式授权） ----------------
      case "capture.status": {
        const { getCaptureState, listCaptured, captureTotals } = await import("../core/capture.js");
        const captureState = getCaptureState(dataDir);
        return {
          ok: true,
          enabled: captureState.enabled,
          enabledAt: captureState.enabledAt,
          sessions: listCaptured(dataDir),
          totals: captureTotals(dataDir),
          limits: { maxSessions: captureMaxSessions, maxFileBytes: captureMaxFileBytes },
        };
      }
      case "capture.update": {
        const { setCaptureState } = await import("../core/capture.js");
        const next = setCaptureState(dataDir, payload.enabled === true);
        return { ok: true, enabled: next.enabled, enabledAt: next.enabledAt };
      }
      case "capture.read": {
        const { readCaptured } = await import("../core/capture.js");
        const sessionId = String(payload.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "缺少 sessionId" };
        return { ok: true, sessionId, turns: readCaptured(dataDir, sessionId) };
      }
      case "capture.drop": {
        const { dropCaptured } = await import("../core/capture.js");
        const sessionId = String(payload.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "缺少 sessionId" };
        return { ok: true, dropped: dropCaptured(dataDir, sessionId) };
      }
      case "capture.prune": {
        const { pruneCaptured } = await import("../core/capture.js");
        const limit = clamp(Number(payload.maxSessions ?? captureMaxSessions) || captureMaxSessions, 1, 1000);
        return { ok: true, ...pruneCaptured(dataDir, limit), maxSessions: limit };
      }
      case "capture.clear": {
        const { clearCaptured } = await import("../core/capture.js");
        return { ok: true, ...clearCaptured(dataDir) };
      }

      // ---------------- 蒸馏：会话 → 结构化 profile ----------------
      case "distill.run": {
        const { collectConversations } = await import("../core/capture.js");
        const { buildDistillPrompt, heuristicDistillation, normalizeProfile, parseDistillation, profileToMemories, sanitizeProfile } =
          await import("../core/distill.js");
        const { bigramJaccard } = await import("../core/arbiter.js");
        // 数据源：capture=插件捕获（默认）/ dsh=读 DSH 已有会话日志（只读）/ all=两者合并
        const sourceMode = String(payload.source ?? "capture");
        const sessionIds = Array.isArray(payload.sessionIds) ? payload.sessionIds.map(String) : undefined;
        let conversations = [];
        if (sourceMode === "dsh" || sourceMode === "all") {
          const { collectDshConversations } = await import("../core/dsh-sessions.js");
          conversations = conversations.concat(
            collectDshConversations({
              dshHome,
              sessionIds,
              maxSessions: clamp(Number(payload.maxSessions ?? 10) || 10, 1, 30),
              maxCharsPerSession: clamp(Number(payload.maxCharsPerSession ?? 12000) || 12000, 2000, 40000),
            }),
          );
        }
        if (sourceMode === "capture" || sourceMode === "all") {
          conversations = conversations.concat(collectConversations({ dataDir, sessionIds }));
        }
        const mode = String(payload.mode ?? "prepare");
        // apply 模式允许没有会话：调用方可能已经带着别处产出的 JSON 画像来落库
        if (conversations.length === 0 && mode !== "apply") {
          return {
            ok: false,
            error:
              sourceMode === "capture"
                ? "还没有可蒸馏的会话：打开「会话捕获」聊几轮，或把数据源切到「DSH 历史会话」。"
                : "没有读到可蒸馏的会话：确认 DSH 的 sessions 目录存在且包含 user/assistant 消息。",
          };
        }
        if (mode === "prepare") {
          return {
            ok: true,
            phase: "prepare",
            source: sourceMode,
            sessions: conversations.map((item) => ({
              sessionId: item.sessionId,
              source: item.source ?? "capture",
              workspace: item.workspace,
              turns: item.turns,
              chars: item.chars,
            })),
            prompt: buildDistillPrompt(conversations),
            digest: conversations.map((item) => `### 会话 ${item.sessionId}\n${item.text}`).join("\n\n"),
          };
        }

        let profile;
        let source;
        if (mode === "heuristic") {
          profile = heuristicDistillation(conversations);
          source = "heuristic";
        } else {
          let value = payload.distillation;
          if (typeof value === "string") {
            const parsed = parseDistillation(value);
            if (!parsed.ok) return { ok: false, error: `蒸馏结果解析失败：${parsed.error}` };
            value = parsed.value;
          }
          if (!value || typeof value !== "object") {
            return { ok: false, error: "apply 模式需要 distillation（对象或 JSON 字符串）；先用 mode=prepare 拿 prompt" };
          }
          profile = normalizeProfile(value);
          source = "llm";
        }

        // 质量闸门：去噪（空话）、脱敏（密钥/邮箱/路径）、置信度校准（无证据降级）
        const sanitized = sanitizeProfile(profile);
        profile = sanitized.profile;
        const observedAt =
          conversations.reduce((max, item) => Math.max(max, Number(item.observedAt ?? item.updatedAt ?? 0) || 0), 0) ||
          Date.now();
        const saved = saveDistillation(opened, profile, conversations, source);
        // 安全扫描：画像里若出现指令注入样式，默认不写进记忆库（仍保存画像供人工查看）
        const { scanProfile } = await import("../core/safety.js");
        const profileScan = scanProfile(profile);
        const imported = [];
        let skippedImports = 0;
        let deduped = 0;
        let blockedBySafety = false;
        if (payload.importToMemories === true) {
          if (profileScan.suspect && payload.force !== true) {
            blockedBySafety = true;
          }
          // 幂等：同一条蒸馏内容重复导入不新增（否则每跑一次蒸馏就涨一批重复记忆）
          const importScope = String(payload.scope ?? "global").trim() || "global";
          const existingStmt = opened.store.db.prepare(
            "SELECT id FROM memories WHERE source_type = 'distill' AND content = ? LIMIT 1",
          );
          const drafts = blockedBySafety ? [] : profileToMemories(profile);
          // 批内近似去重：同分类里两条几乎一样的只留一条（模型经常换个说法重复输出）
          const keptDrafts = [];
          for (const draft of drafts) {
            const near = keptDrafts.some(
              (other) =>
                other.category === draft.category && bigramJaccard(String(other.content), String(draft.content)) >= 0.9,
            );
            if (near) {
              deduped += 1;
              continue;
            }
            keptDrafts.push(draft);
          }
          const evidenceSessionIds = conversations.map((item) => String(item.sessionId)).slice(0, 8);
          for (const draft of keptDrafts) {
            try {
              const existing = existingStmt.get(String(draft.content));
              if (existing?.id) {
                skippedImports += 1;
                continue;
              }
              const result = opened.memories.create({
                ...draft,
                allowSupersede: false,
                authority: "inferred",
                confidence: typeof draft.confidence === "number" ? draft.confidence : 0.7,
                scope: importScope,
                sourceType: "distill",
                sourceRef: saved.id,
                structured: {
                  ...(draft.structured ?? {}),
                  // 新鲜度按对话时间算，避免"旧对话提炼的经验"冒充新记忆
                  observedAt,
                  evidenceSessionIds,
                },
              });
              if (!result.duplicate && result.memory?.id) imported.push(result.memory.id);
              else skippedImports += 1;
            } catch (error) {
              logWarn(`蒸馏记忆写入失败：${error instanceof Error ? error.message : String(error)}`);
            }
          }
          try {
            opened.store.db.prepare("UPDATE distillations SET memory_count = ? WHERE id = ?").run(imported.length, saved.id);
          } catch {
            /* 计数失败不影响结果 */
          }
        }
        return {
          ok: true,
          phase: "done",
          id: saved.id,
          source,
          profile,
          imported,
          memoryCount: imported.length,
          skipped: skippedImports,
          deduped,
          quality: { dropped: sanitized.dropped, redacted: sanitized.redacted },
          observedAt,
          safety: { suspect: profileScan.suspect, hits: profileScan.hits, blocked: blockedBySafety },
        };
      }
      case "distill.sources": {
        // 列出可蒸馏的数据源：插件捕获的会话 + DSH 已有会话日志（只读元信息，不解压）
        const { listDshSessions, resolveDshHome } = await import("../core/dsh-sessions.js");
        const { listCaptured } = await import("../core/capture.js");
        const dsh = listDshSessions({ dshHome, limit: clamp(Number(payload.limit ?? 50) || 50, 1, 200) }).map((session) => ({
          sessionId: session.sessionId,
          workspace: session.workspace,
          bytes: session.bytes,
          updatedAt: session.updatedAt,
          compressed: session.compressed,
        }));
        const captured = listCaptured(dataDir).map((session) => ({
          sessionId: session.sessionId,
          turns: session.turns,
          bytes: session.bytes,
          updatedAt: session.updatedAt,
        }));
        return { ok: true, dshHome: resolveDshHome(dshHome), dsh, captured };
      }
      case "distill.list": {
        try {
          const rows = opened.store.db
            .prepare("SELECT id, created_at, turn_count, confidence, source, memory_count, profile_json FROM distillations ORDER BY created_at DESC LIMIT ?")
            .all(clamp(Number(payload.limit ?? 10) || 10, 1, 50));
          return {
            ok: true,
            distillations: rows.map((row) => ({
              id: row.id,
              createdAt: Number(row.created_at ?? 0),
              turns: Number(row.turn_count ?? 0),
              confidence: Number(row.confidence ?? 0),
              source: row.source,
              memoryCount: Number(row.memory_count ?? 0),
              profile: safeJson(row.profile_json),
            })),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "distill.undo": {
        // 撤销一次蒸馏的导入：只删"AI 推断、未确认、未改过"的记忆，用户确认过的保留
        const id = String(payload.id ?? "").trim();
        if (!id) return { ok: false, error: "缺少蒸馏 id（先 distill.list 拿）" };
        let rows = [];
        try {
          rows = opened.store.db
            .prepare("SELECT id, authority, user_modified FROM memories WHERE source_type = 'distill' AND source_ref = ?")
            .all(id);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        let removed = 0;
        const kept = [];
        for (const row of rows) {
          const removable = String(row.authority) === "inferred" && Number(row.user_modified ?? 0) === 0;
          if (!removable) {
            kept.push(row.id);
            continue;
          }
          try {
            opened.memories.remove(row.id);
            removed += 1;
          } catch (error) {
            logWarn(`撤销蒸馏记忆失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        try {
          opened.store.db.prepare("UPDATE distillations SET memory_count = 0 WHERE id = ?").run(id);
        } catch {
          /* 计数失败不影响结果 */
        }
        return { ok: true, id, removed, kept: kept.length };
      }
      case "distill.stage": {
        // PII 复核第一步：暂存「原始 profile + 脱敏结果 + 每条脱敏明细」，等用户逐条确认
        const { normalizeProfile, sanitizeProfile } = await import("../core/distill.js");
        let value = payload.distillation;
        if (typeof value === "string") {
          const { parseDistillation } = await import("../core/distill.js");
          const parsed = parseDistillation(value);
          if (!parsed.ok) return { ok: false, error: `蒸馏结果解析失败：${parsed.error}` };
          value = parsed.value;
        }
        if (!value || typeof value !== "object") {
          return { ok: false, error: "distill.stage 需要 distillation（对象或 JSON 字符串）" };
        }
        const rawProfile = normalizeProfile(value);
        const sanitized = sanitizeProfile(rawProfile);
        const stageId = `sta_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        opened.store.db
          .prepare(
            `INSERT INTO distill_stage (id, created_at, source, raw_json, sanitized_json, redactions_json, dropped_json, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .run(
            stageId,
            Date.now(),
            String(payload.source ?? "manual"),
            JSON.stringify(rawProfile),
            JSON.stringify(sanitized.profile),
            JSON.stringify(sanitized.redactions ?? []),
            JSON.stringify(sanitized.dropped ?? []),
          );
        return {
          ok: true,
          stageId,
          preview: {
            profile: sanitized.profile,
            redacted: sanitized.redacted ?? [],
            redactions: sanitized.redactions ?? [],
            dropped: sanitized.dropped ?? [],
          },
        };
      }
      case "distill.review.list": {
        try {
          const rows = opened.store.db
            .prepare("SELECT * FROM distill_stage WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20")
            .all();
          return {
            ok: true,
            stages: rows.map((row) => ({
              id: row.id,
              createdAt: Number(row.created_at ?? 0),
              source: row.source,
              profile: safeJson(row.sanitized_json),
              redactions: safeJson(row.redactions_json) ?? [],
              dropped: safeJson(row.dropped_json) ?? [],
            })),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "distill.review.apply": {
        // PII 复核第二步：按用户选择还原脱敏项 / 恢复被丢弃项，然后落库（可选写记忆）
        const stageId = String(payload.stageId ?? "").trim();
        if (!stageId) return { ok: false, error: "缺少 stageId" };
        const row = opened.store.db.prepare("SELECT * FROM distill_stage WHERE id = ?").get(stageId);
        if (!row) return { ok: false, error: `暂存记录不存在：${stageId}` };
        if (String(row.status) !== "pending") return { ok: false, error: "该暂存记录已处理过" };
        const sanitizedProfile = safeJson(row.sanitized_json) ?? {};
        const redactions = safeJson(row.redactions_json) ?? [];
        const droppedItems = safeJson(row.dropped_json) ?? [];
        const restore = new Set((Array.isArray(payload.restore) ? payload.restore : []).map(Number));
        const keepDropped = new Set((Array.isArray(payload.keepDropped) ? payload.keepDropped : []).map(Number));
        const profile = JSON.parse(JSON.stringify(sanitizedProfile));

        const replacePlaceholder = (target, field, itemIndex, masked, original) => {
          if (field === "profile") {
            if (typeof target.profile === "string" && target.profile.includes(masked)) {
              target.profile = target.profile.replace(masked, original);
              return true;
            }
            return false;
          }
          if (field.startsWith("experiences[")) {
            const experience = Array.isArray(target.experiences) ? target.experiences[itemIndex] : null;
            if (!experience) return false;
            for (const key of ["trigger", "action", "why", "boundary", "evidence", "since"]) {
              if (typeof experience[key] === "string" && experience[key].includes(masked)) {
                experience[key] = experience[key].replace(masked, original);
                return true;
              }
            }
            return false;
          }
          if (!Array.isArray(target[field])) return false;
          for (let index = 0; index < target[field].length; index += 1) {
            if (typeof target[field][index] === "string" && target[field][index].includes(masked)) {
              target[field][index] = target[field][index].replace(masked, original);
              return true;
            }
          }
          return false;
        };

        let restoredCount = 0;
        for (const redaction of redactions) {
          if (!restore.has(Number(redaction.index))) continue;
          if (replacePlaceholder(profile, String(redaction.field), Number(redaction.itemIndex) || 0, String(redaction.masked), String(redaction.original))) {
            restoredCount += 1;
          }
        }
        let keptBack = 0;
        for (const dropped of droppedItems) {
          if (!keepDropped.has(Number(dropped.itemIndex))) continue;
          const field = String(dropped.field ?? "");
          if (Array.isArray(profile[field])) {
            profile[field].push(String(dropped.text ?? ""));
            keptBack += 1;
          }
        }

        const saved = saveDistillation(opened, profile, [{ sessionId: `review:${stageId}`, turns: 0 }], "manual");
        const imported = [];
        let skipped = 0;
        let blockedBySafety = false;
        const { scanProfile } = await import("../core/safety.js");
        const profileScan = scanProfile(profile);
        if (payload.importToMemories === true) {
          if (profileScan.suspect && payload.force !== true) {
            blockedBySafety = true;
          } else {
            const { profileToMemories } = await import("../core/distill.js");
            const { bigramJaccard } = await import("../core/arbiter.js");
            const importScope = String(payload.scope ?? "global").trim() || "global";
            const keptDrafts = [];
            for (const draft of profileToMemories(profile)) {
              const near = keptDrafts.some(
                (other) => other.category === draft.category && bigramJaccard(String(other.content), String(draft.content)) >= 0.9,
              );
              if (near) {
                skipped += 1;
                continue;
              }
              keptDrafts.push(draft);
            }
            for (const draft of keptDrafts) {
              try {
                const result = opened.memories.create({
                  ...draft,
                  allowSupersede: false,
                  authority: "inferred",
                  scope: importScope,
                  sourceType: "distill",
                  sourceRef: saved.id,
                  structured: { ...(draft.structured ?? {}), observedAt: Date.now() },
                });
                if (!result.duplicate && result.memory?.id) imported.push(result.memory.id);
                else skipped += 1;
              } catch (error) {
                logWarn(`复核后写入记忆失败：${error instanceof Error ? error.message : String(error)}`);
              }
            }
            try {
              opened.store.db.prepare("UPDATE distillations SET memory_count = ? WHERE id = ?").run(imported.length, saved.id);
            } catch {
              /* 忽略计数失败 */
            }
          }
        }
        opened.store.db.prepare("UPDATE distill_stage SET status = 'applied' WHERE id = ?").run(stageId);
        return {
          ok: true,
          stageId,
          id: saved.id,
          restored: restoredCount,
          keptBack,
          imported,
          skipped,
          safety: { suspect: profileScan.suspect, hits: profileScan.hits, blocked: blockedBySafety },
        };
      }
      case "distill.review.discard": {
        const stageId = String(payload.stageId ?? "").trim();
        if (!stageId) return { ok: false, error: "缺少 stageId" };
        opened.store.db.prepare("UPDATE distill_stage SET status = 'discarded' WHERE id = ?").run(stageId);
        return { ok: true, stageId };
      }
      case "autoDistill.status": {
        const { autoDistillStatus } = await import("../core/auto-distill.js");
        return { ok: true, ...autoDistillStatus(dataDir) };
      }
      case "autoDistill.update": {
        const { updateAutoDistillState, autoDistillStatus } = await import("../core/auto-distill.js");
        updateAutoDistillState(dataDir, {
          enabled: payload.enabled,
          every: payload.every,
          minTurns: payload.minTurns,
          importToMemories: payload.importToMemories,
          source: payload.source,
        });
        return { ok: true, ...autoDistillStatus(dataDir) };
      }
      case "autoDistill.runNow": {
        const { markAutoDistillRun, autoDistillStatus } = await import("../core/auto-distill.js");
        const state = autoDistillStatus(dataDir);
        const result = await runAction("distill.run", {
          mode: "heuristic",
          source: String(payload.source ?? state.source ?? "capture"),
          importToMemories: payload.importToMemories === true,
        });
        markAutoDistillRun(dataDir, {
          distillId: result.ok ? result.id : null,
          after: result.ok ? result.memoryCount : null,
          skipped: result.ok ? null : result.error,
        });
        return {
          ok: result.ok,
          ...(result.ok ? { id: result.id, memoryCount: result.memoryCount, deduped: result.deduped } : { error: result.error }),
          status: autoDistillStatus(dataDir),
        };
      }
      case "authority.resolve": {
        // 单条裁决查询：给面板/工具解释"这条记忆 vs 文档谁说了算"
        const { resolveAuthority, AUTHORITY_MODES } = await import("../core/authority.js");
        const mode = String(payload.mode ?? authorityMode);
        if (!AUTHORITY_MODES.includes(mode)) {
          return { ok: false, error: `不支持的模式：${mode}（可选 ${AUTHORITY_MODES.join(" / ")}）` };
        }
        const decision = resolveAuthority({ memory: { authority: payload.memoryAuthority ?? "inferred" }, mode });
        return { ok: true, mode, ...decision };
      }
      case "quality.benchmark": {
        // 经验可达性回归：默认用每条经验的 trigger 当查询，看它能被检索回 topK 吗
        try {
          const topK = clamp(Number(payload.topK ?? 5) || 5, 1, 20);
          const scope = String(payload.scope ?? "all");
          let tasks = Array.isArray(payload.tasks)
            ? payload.tasks
                .map((task) => ({
                  id: String(task?.id ?? task?.prompt ?? ""),
                  prompt: String(task?.prompt ?? "").trim(),
                  expectId: task?.expectId ? String(task.expectId) : null,
                }))
                .filter((task) => task.prompt)
            : [];
          if (tasks.length === 0) {
            const active = opened.memories.list({ status: "active", limit: 300 }) || [];
            tasks = active
              .filter((memory) => memory.structured?.kind === "experience")
              .map((memory) => ({
                id: memory.id,
                prompt: String(memory.structured.trigger || memory.content),
                expectId: memory.id,
              }));
          }
          if (tasks.length === 0) {
            return {
              ok: false,
              error: "没有可用的经验条目：先蒸馏出 experiences（或传 tasks: [{prompt, expectId}]）",
            };
          }
          const run = (withVector) => {
            let hits = 0;
            let rankSum = 0;
            const misses = [];
            for (const task of tasks) {
              const results = opened.memories.search({ q: task.prompt, scope, limit: topK * 2, useVector: withVector }) || [];
              const rank = task.expectId ? results.findIndex((item) => item.id === task.expectId) : -1;
              if (rank >= 0 && rank < topK) {
                hits += 1;
                rankSum += rank + 1;
              } else {
                misses.push({ prompt: task.prompt, rank: rank < 0 ? null : rank + 1 });
              }
            }
            return {
              total: tasks.length,
              hits,
              hitRate: Math.round((hits / tasks.length) * 1000) / 1000,
              avgRank: hits > 0 ? Math.round((rankSum / hits) * 100) / 100 : null,
              misses: misses.slice(0, 10),
            };
          };
          const withVector = run(payload.useVector !== false);
          const baseline = payload.compare === false ? null : run(false);
          return {
            ok: true,
            topK,
            scope,
            ...withVector,
            baseline,
            improvement: baseline === null ? null : Math.round((withVector.hitRate - baseline.hitRate) * 1000) / 1000,
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "quality.report": {
        // 质量体检：让"记忆库现在有多干净"变成可验证的数字
        try {
          const db = opened.store.db;
          const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);
          const total = one("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'");
          const byAuthority = db.prepare("SELECT authority, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY authority").all();
          const experiences = one(
            "SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND structured LIKE '%\"kind\":\"experience\"%'",
          );
          const untrusted = one(
            "SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND (authority = 'imported' OR source_type IN ('pack','distill'))",
          );
          const openConflicts = one("SELECT COUNT(*) AS n FROM conflicts WHERE resolution IS NULL");
          let stale = 0;
          try {
            stale = (opened.memories.listStale?.() ?? []).length;
          } catch {
            stale = 0;
          }
          // 近似重复对：同 scope + 同 category 里 Jaccard ≥ 0.9 的两条（只算 active，最多 300 条）
          const { bigramJaccard } = await import("../core/arbiter.js");
          const pool = opened.memories.list({ status: "active", limit: 300 }) || [];
          let nearDuplicatePairs = 0;
          for (let i = 0; i < pool.length; i += 1) {
            for (let j = i + 1; j < pool.length; j += 1) {
              const a = pool[i];
              const b = pool[j];
              if (a.category !== b.category || a.scope !== b.scope) continue;
              if (bigramJaccard(String(a.content), String(b.content)) >= 0.9) nearDuplicatePairs += 1;
            }
          }
          const lastDistill = db
            .prepare("SELECT id, created_at, source, memory_count FROM distillations ORDER BY created_at DESC LIMIT 1")
            .get();
          return {
            ok: true,
            report: {
              total,
              experiences,
              untrusted,
              openConflicts,
              stale,
              nearDuplicatePairs,
              byAuthority: Object.fromEntries(byAuthority.map((row) => [String(row.authority), Number(row.n)])),
              lastDistill: lastDistill
                ? {
                    id: lastDistill.id,
                    createdAt: Number(lastDistill.created_at ?? 0),
                    source: lastDistill.source,
                    memoryCount: Number(lastDistill.memory_count ?? 0),
                  }
                : null,
              // 0-100 的"干净度"：重复/冲突/陈旧/未确认推断各扣分
              score: Math.max(
                0,
                Math.min(
                  100,
                  Math.round(
                    100 -
                      nearDuplicatePairs * 4 -
                      openConflicts * 2 -
                      stale * 1 -
                      Math.min(20, untrusted * 0.5),
                  ),
                ),
              ),
            },
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "quality.duplicates": {
        // 近似重复对（可操作列表）：面板据此一键合并
        try {
          const { bigramJaccard } = await import("../core/arbiter.js");
          const minScore = clamp(Number(payload.minScore ?? 0.85) || 0.85, 0.6, 1);
          const pool = opened.memories.list({ status: "active", limit: 300 }) || [];
          const pairs = [];
          for (let i = 0; i < pool.length; i += 1) {
            for (let j = i + 1; j < pool.length; j += 1) {
              const a = pool[i];
              const b = pool[j];
              if (a.category !== b.category || a.scope !== b.scope) continue;
              const similarity = bigramJaccard(String(a.content), String(b.content));
              if (similarity < minScore) continue;
              const pick = (memory) => ({
                id: memory.id,
                content: memory.content,
                category: memory.category,
                scope: memory.scope,
                authority: memory.authority,
                confidence: memory.confidence,
                createdAt: memory.createdAt,
              });
              pairs.push({ a: pick(a), b: pick(b), similarity: Math.round(similarity * 1000) / 1000 });
            }
          }
          pairs.sort((x, y) => y.similarity - x.similarity);
          return { ok: true, minScore, total: pairs.length, pairs: pairs.slice(0, clamp(Number(payload.limit ?? 30) || 30, 1, 100)) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "memory.merge": {
        // 手动合并：保留 keepId 的内容，dropId 标 superseded（标签并集、置信度取高、关掉两者冲突）
        const keepId = String(payload.keepId ?? "").trim();
        const dropId = String(payload.dropId ?? "").trim();
        if (!keepId || !dropId) return { ok: false, error: "缺少 keepId / dropId" };
        try {
          const result = opened.memories.merge({
            keepId,
            dropId,
            reason: String(payload.reason ?? "").trim() || "手动合并（内容近似）",
          });
          return { ok: true, ...result };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "backup.create": {
        // 数据安全：VACUUM INTO 生成一致快照，额外带上自动蒸馏/捕获开关文件
        const { createBackup } = await import("../core/backup.js");
        const counts = { memories: 0, documents: 0, chunks: 0, packs: 0, distillations: 0 };
        try {
          const memStats = opened.memories.stats({}) ?? {};
          const docStats = opened.documents.stats() ?? {};
          counts.memories = Number(memStats.memories ?? 0);
          counts.documents = Number(docStats.documents ?? 0);
          counts.chunks = Number(docStats.chunks ?? 0);
          counts.packs = (opened.packs.list() ?? []).length;
          counts.distillations = Number(
            opened.store.db.prepare("SELECT COUNT(*) AS n FROM distillations").get()?.n ?? 0,
          );
        } catch (error) {
          logWarn(`统计备份信息失败：${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          const result = createBackup({ dataDir, db: opened.store.db, note: String(payload.note ?? ""), counts });
          return { ok: true, ...result };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "backup.list": {
        const { listBackups } = await import("../core/backup.js");
        try {
          return { ok: true, backups: listBackups({ dataDir }), root: path.join(dataDir, "backups") };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "backup.restore": {
        // 恢复需要先关库：恢复完成后重新打开
        const { restoreBackup } = await import("../core/backup.js");
        const name = String(payload.name ?? "").trim();
        const backupPath = String(payload.path ?? "").trim();
        if (!name && !backupPath) return { ok: false, error: "缺少 name 或 path" };
        try {
          core?.store?.close?.();
        } catch {
          /* 关不掉也继续尝试 */
        }
        core = null;
        corePromise = null;
        try {
          const result = restoreBackup({ dataDir, backup: name, backupPath });
          await ensureCore();
          return { ok: true, ...result };
        } catch (error) {
          try {
            await ensureCore();
          } catch {
            coreFailure = error;
          }
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "diagnostics.export": {
        // 出问题时导出「统计 + 脱敏配置 + 最近日志」，不含任何正文
        const { createDiagnostics, pruneDiagnostics } = await import("../core/diagnostics.js");
        try {
          let summary = {};
          try {
            const memStats = opened.memories.stats({}) ?? {};
            const docStats = opened.documents.stats() ?? {};
            summary = {
              memories: Number(memStats.memories ?? 0),
              byCategory: memStats.byCategory ?? null,
              byAuthority: memStats.byAuthority ?? null,
              documents: Number(docStats.documents ?? 0),
              chunks: Number(docStats.chunks ?? 0),
              packs: (opened.packs.list() ?? []).length,
              conflictsOpen: Number(
                opened.store.db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE resolved = 0").get()?.n ?? 0,
              ),
              distillations: Number(
                opened.store.db.prepare("SELECT COUNT(*) AS n FROM distillations").get()?.n ?? 0,
              ),
              captureEnabled: await (async () => {
                try {
                  const { getCaptureState } = await import("../core/capture.js");
                  return Boolean(getCaptureState(dataDir).enabled);
                } catch {
                  return null;
                }
              })(),
            };
          } catch (error) {
            summary = { error: error instanceof Error ? error.message : String(error) };
          }
          const result = createDiagnostics({
            dataDir,
            version: VERSION,
            summary,
            logs: recentLogs,
            config,
          });
          pruneDiagnostics(dataDir, 10);
          return { ok: true, ...result };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case "pack.importSample": {
        // 首启引导用：一键导入内置样例包（走完整导入链路，含安全扫描）
        const { fileURLToPath } = await import("node:url");
        const samplePath = fileURLToPath(new URL("../samples/godot-2d-pipeline.mirrorpack", import.meta.url));
        return runAction("pack.import", { path: samplePath, strategy: "skip_conflicts" });
      }
      case "doc.ingest": {
        // 文档先行：抓最新官方文档 → 存成本地 Markdown → 加进文档库 → 立刻可检索/注入
        const topic = String(payload.topic ?? "").trim();
        if (!topic) return { ok: false, error: "请填写主题（例如 godot / nextjs）" };
        const urls = Array.isArray(payload.urls) ? payload.urls.map(String).filter((url) => url.trim()) : [];
        const items = Array.isArray(payload.items) ? payload.items : [];
        const inlineContent = String(payload.content ?? "").trim();
        if (urls.length === 0 && items.length === 0 && !inlineContent) {
          return { ok: false, error: "请至少给一个 urls，或提供 content（正文）/items" };
        }
        const { ingestDocs } = await import("../core/ingest.js");
        const inline = inlineContent
          ? [{ title: String(payload.title ?? topic), content: inlineContent, sourceUrl: payload.sourceUrl || "inline", kind: "inline" }]
          : [];
        const ingested = await ingestDocs({ dataDir, topic, urls, items: [...items, ...inline] });
        if (!ingested.files || ingested.files.length === 0) {
          return { ok: false, error: `没有抓到任何文档：${(ingested.errors ?? []).map((item) => item.message).join("；") || "未知原因"}`, ...ingested };
        }
        try {
          opened.documents.addRoot(ingested.dir);
        } catch {
          /* 已添加过同名目录时忽略，扫描照跑 */
        }
        const ingestScan = opened.documents.scan();
        return { ok: true, ...ingested, scan: ingestScan };
      }
      case "pack.import": {
        const filePath = String(payload.path ?? "").trim();
        if (!filePath) return { ok: false, error: "请填写 .mirrorpack 文件路径" };
        const { readFileSync } = await import("node:fs");
        const text = readFileSync(filePath, "utf8");
        const rawPack = safeJson(text);
        const pack = opened.packs.parse(text);
        // 安全闸门：包里的记忆/画像若含指令注入样式，默认拒绝导入（避免卖家用记忆给买家的 AI 下指令）
        const { scanUntrusted, scanProfile } = await import("../core/safety.js");
        const safetyHits = [];
        for (const item of pack.memories || []) {
          const scanned = scanUntrusted(item.content);
          if (scanned.suspect) safetyHits.push(...scanned.hits);
        }
        const profileScanned = scanProfile(rawPack?.profile ?? pack.profile);
        if (profileScanned.suspect) safetyHits.push(...profileScanned.hits);
        if (safetyHits.length > 0 && payload.force !== true) {
          return {
            ok: false,
            blocked: true,
            suspect: safetyHits,
            error: `该记忆包含 ${safetyHits.length} 处可疑指令样式，已拒绝导入（如需强行导入请传 force:true）`,
          };
        }
        const result = opened.packs.install({
          pack,
          strategy: payload.strategy || "skip_conflicts",
          source: "local",
          localPath: filePath,
          // 导入的内容不允许覆盖买家已有记忆（AI/卖家措辞不能顶掉你确认过的东西）
          allowSupersede: false,
        });
        // 阶段三：包里的认知画像存成一条 distillation（source='pack'），
        // 面板「蒸馏」卡片会显示最近一次，方便加载别人的认知资产。
        let distillationId = null;
        if (rawPack?.profile) {
          try {
            const { normalizePackProfile } = await import("../core/packs.js");
            const normalizedProfile = normalizePackProfile(rawPack.profile);
            if (normalizedProfile) {
              const saved = saveDistillation(
                opened,
                normalizedProfile,
                [{ sessionId: `pack:${result?.packId ?? pack.pack_id ?? "unknown"}`, turns: 0 }],
                "pack",
              );
              distillationId = saved.id;
            }
          } catch (error) {
            logWarn(`导入包画像失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return { ok: true, ...result, hasProfile: !!rawPack?.profile, distillationId };
      }
      case "pack.uninstall": {
        if (!payload.packId) return { ok: false, error: "缺少 packId" };
        return {
          ok: true,
          ...opened.packs.uninstall({
            packId: String(payload.packId),
            deleteMemories: payload.deleteMemories === true,
          }),
        };
      }
      case "pack.export": {
        // 选中记忆 + 认知画像一起导出（仅生成本地文件）
        const ids = Array.isArray(payload.memoryIds) ? payload.memoryIds.map(String) : [];
        const meta = payload.meta ?? {};
        let profile = payload.profile ?? null;
        if (!profile && payload.includeProfile !== false) {
          try {
            const row = opened.store.db
              .prepare("SELECT profile_json FROM distillations ORDER BY created_at DESC LIMIT 1")
              .get();
            if (row?.profile_json) profile = safeJson(row.profile_json);
          } catch {
            profile = null;
          }
        }
        if (ids.length === 0 && !profile) {
          return { ok: false, error: "请先勾选要打包的记忆，或先在「蒸馏」卡片生成一份认知画像" };
        }
        const pack = opened.packs.export({ memoryIds: ids, meta, profile });
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const exportDir = path.join(dataDir, "exports");
        mkdirSync(exportDir, { recursive: true });
        const safeName = String(pack.pack_id || "mirrorpack").replace(/[^\w.-]+/g, "_");
        const outputPath = path.join(exportDir, `${safeName}-${pack.version || "1.0.0"}.mirrorpack`);
        writeFileSync(outputPath, JSON.stringify(pack, null, 2), "utf8");
        return { ok: true, path: outputPath, pack, hasProfile: !!pack.profile, memoryCount: (pack.memories || []).length };
      }
      case "pack.checkUpdates": {
        // 面板「更新可用」徽标用（§10.5）。纯本地比对，不依赖远端服务：
        // 有本地 .mirrorpack 就重新解析比对版本；否则只看上次检查记录。
        const { compareVersion } = await import("../core/packs.js");
        const { existsSync, readFileSync } = await import("node:fs");
        const updates = [];
        for (const installedPack of opened.packs.list()) {
          const currentVersion = installedPack.packVersion ?? installedPack.pack_version ?? "";
          let latestVersion = null;
          let note = "";
          const localPath = installedPack.localPath ?? installedPack.local_path ?? "";
          if (localPath && existsSync(localPath)) {
            try {
              const parsed = opened.packs.parse(readFileSync(localPath, "utf8"));
              latestVersion = parsed.version ?? null;
              note = "本地文件";
            } catch {
              note = "本地包文件无法解析";
            }
          } else {
            try {
              const row = opened.store.db
                .prepare("SELECT latest_version FROM pack_update_check WHERE pack_id = ? ORDER BY checked_at DESC LIMIT 1")
                .get(installedPack.packId ?? installedPack.pack_id);
              if (row?.latest_version) {
                latestVersion = row.latest_version;
                note = "上次检查记录";
              } else {
                note = "本地包没有可对比的新版本";
              }
            } catch {
              note = "无法读取更新记录";
            }
          }
          const available = !!(latestVersion && compareVersion(latestVersion, currentVersion) > 0);
          if (latestVersion) {
            try {
              opened.packs.checkUpdate({ packId: installedPack.packId, latestVersion });
            } catch {
              /* 记录失败不影响返回 */
            }
          }
          updates.push({
            packId: installedPack.packId ?? installedPack.pack_id,
            packName: installedPack.packName ?? installedPack.pack_name,
            currentVersion,
            latestVersion,
            available,
            source: installedPack.source ?? "local",
            note,
          });
        }
        return { ok: true, updates };
      }
      case "inject.preview": {
        // 注入前先做一次节流增量扫描，避免用到过期文档（§10.7）
        scanBeforeRetrieve(opened);
        const { retrieve, buildInjection } = await import("../core/retrieve.js");
        const budget = clamp(Number(payload.tokenBudget ?? tokenBudget) || tokenBudget, 100, 8000);
        const result = retrieve({
          memories,
          documents,
          query: String(payload.query ?? ""),
          scope: payload.scope || injectScope,
          tokenBudget: budget,
          residentPreferences,
          injectAuthorities,
          authorityMode,
        });
        const built = buildInjection(result);
        return {
          ok: true,
          ...built,
          authorityMode: result.authorityMode ?? authorityMode,
          authorityConflicts: result.authorityConflicts ?? [],
          authorityHidden: result.authorityHidden ?? { memories: 0, docs: 0 },
        };
      }
      case "extract.run": {
        const { heuristicExtract } = await import("../core/extract.js");
        const conversation = String(payload.conversation ?? "");
        if (!conversation.trim()) return { ok: false, error: "对话内容为空" };
        const extracted = heuristicExtract(conversation);
        let created = 0;
        const conflicts = [];
        for (const item of extracted.extractions ?? []) {
          try {
            const result = memories.create({
              ...item,
              authority: item.authority || "inferred",
              confidence: isNum(item.confidence) ? item.confidence : 0.5,
              sourceType: "conversation",
              sourceRef: payload.sessionId ?? null,
              scope: item.scope || payload.scope || "global",
            });
            if (result.duplicate) continue;
            created += 1;
            conflicts.push(...(result.conflicts ?? []));
          } catch (error) {
            logWarn(`抽取写入失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return { ok: true, extracted: (extracted.extractions ?? []).length, created, conflicts: conflicts.length };
      }
      case "staleness.check": {
        if (!memories.stalenessCheck) return { ok: true, checked: 0, stale: [] };
        return { ok: true, ...memories.stalenessCheck({ stalerThanDays: payload.stalerThanDays ?? 90 }) };
      }
      case "state": {
        return buildState({ scope: payload.scope ?? "" });
      }
      default:
        return { ok: false, error: `未知动作：${type}` };
    }
  }

  // ---------------------------------------------------------------- HTTP API

  // 注意：这里必须是普通函数。写成 async 会返回 Promise<handler>，
  // 而 host-webserver 是 `await route.handler(req, res)`，拿 Promise 当函数调用会直接抛错。
  function withCore(handler) {
    return async (request, response) => {
      if (!isLoopback(request)) {
        sendJson(response, 403, { ok: false, error: "Mirror 面板只接受本机请求" });
        return;
      }
      try {
        await handler(request, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn(`HTTP 处理失败：${message}`);
        if (!response.headersSent) sendJson(response, 500, { ok: false, error: message });
      }
    };
  }

  function installRoutes(webServer) {
    const disposers = [];

    disposers.push(
      webServer.register({
        kind: "exact",
        path: "/mirror/api/health",
        handler: withCore(async (_request, response) => {
          try {
            await ensureCore();
            sendJson(response, 200, { ok: true, version: VERSION, dataDir, core: "ready" });
          } catch {
            sendJson(response, 503, { ok: false, version: VERSION, dataDir, core: "unavailable", error: coreFailure });
          }
        }),
      }),
    );

    disposers.push(
      webServer.register({
        kind: "exact",
        path: "/mirror/api/state",
        handler: withCore(async (request, response) => {
          const url = new URL(request.url ?? "/", "http://mirror.local");
          sendJson(
            response,
            200,
            await buildState({
              scope: url.searchParams.get("scope") ?? "",
              category: url.searchParams.get("category") ?? "",
            }),
          );
        }),
      }),
    );

    disposers.push(
      webServer.register({
        kind: "exact",
        path: "/mirror/api/search",
        handler: withCore(async (request, response) => {
          const url = new URL(request.url ?? "/", "http://mirror.local");
          const query = (url.searchParams.get("q") ?? "").trim();
          const scope = url.searchParams.get("scope") ?? "";
          const limit = clamp(Number(url.searchParams.get("limit") ?? 20) || 20, 1, 100);
          if (!query) {
            sendJson(response, 200, { ok: true, memories: [], documents: [] });
            return;
          }
          const opened = await ensureCore();
          sendJson(response, 200, {
            ok: true,
            memories: opened.memories.search({ q: query, scope: scope === "all" ? undefined : scope || undefined, limit }),
            documents: opened.documents.search({ q: query, scope, limit }),
          });
        }),
      }),
    );

    disposers.push(
      webServer.register({
        kind: "prefix",
        path: "/mirror/api/document",
        handler: withCore(async (request, response) => {
          const url = new URL(request.url ?? "/", "http://mirror.local");
          const id = url.pathname.slice("/mirror/api/document/".length);
          if (!id) {
            sendJson(response, 400, { ok: false, error: "缺少文档 id" });
            return;
          }
          const opened = await ensureCore();
          const found = opened.documents.get(decodeURIComponent(id));
          if (!found) {
            sendJson(response, 404, { ok: false, error: "文档不存在" });
            return;
          }
          sendJson(response, 200, { ok: true, ...found });
        }),
      }),
    );

    disposers.push(
      webServer.register({
        kind: "exact",
        path: "/mirror/api/action",
        handler: withCore(async (request, response) => {
          if (request.method !== "POST") {
            sendJson(response, 405, { ok: false, error: "只接受 POST" });
            return;
          }
          let body;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
            return;
          }
          const type = String(body.type ?? "").trim();
          if (!type) {
            sendJson(response, 400, { ok: false, error: "缺少 type" });
            return;
          }
          try {
            const result = await runAction(type, body);
            sendJson(response, 200, result);
          } catch (error) {
            sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        }),
      }),
    );

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 卸载期忽略 */
        }
      }
    };
  }

  ctx.inject(["webServer"], (scoped) => {
    scoped.effect(() => installRoutes(scoped.webServer), "mirror: http api");
    logInfo("面板 HTTP API 已挂载：/mirror/api/*");
  });

  // ---------------------------------------------------------------- 逐轮注入

  const injected = new Map();
  const sessionIdOf = (agent) => agent?.session?.id ?? "dsh-mirror";

  async function refresh(agent, query) {
    const sessionId = sessionIdOf(agent);
    try {
      const opened = await ensureCore();
      scanBeforeRetrieve(opened);
      const { retrieve, buildInjection } = await import("../core/retrieve.js");
      const result = retrieve({
        memories: opened.memories,
        documents: opened.documents,
        query: query ?? "",
        scope: injectScope,
        tokenBudget,
        residentPreferences,
        injectAuthorities,
        authorityMode,
      });
      injected.set(sessionId, buildInjection(result).text ?? "");
    } catch (error) {
      // 内核不可用时保持安静：记忆是增强项，不能因为失败打断对话。
      logWarn(`注入刷新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  ctx.on("agent/pre-step", async ({ agent, messages, step }, next) => {
    if (step === 1) await refresh(agent, lastUserText(messages));
    return next();
  });

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "mirror:memory",
        order: SECTION_ORDER,
        text: (context) => {
          const agent = context?.agent;
          return agent ? injected.get(sessionIdOf(agent)) ?? "" : "";
        },
      }),
    "mirror.systemPrompt.section()",
  );

  // ---------------------------------------------------------------- 会话捕获 + 轮末自动抽取

  let captureModule = null;
  async function captureTurn(sessionId, role, text) {
    try {
      const module = (captureModule ??= await import("../core/capture.js"));
      // 捕获默认关闭：appendTurn 内部读 capture.json，未授权直接 skipped，不写盘
      module.appendTurn({ dataDir, sessionId, role, text, maxFileBytes: captureMaxFileBytes });
    } catch (error) {
      logWarn(`会话捕获失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const turns = new Map();
  ctx.on("session/event", (session, event) => {
    if (!event) return;
    const sessionId = session?.id ?? String(event.session ?? "dsh-mirror");

    if (event.type === "user/message" || event.type === "assistant/message") {
      const text = textOf(event.data);
      if (!text) return;
      // 记录（需用户在面板/工具里显式打开捕获）
      void captureTurn(sessionId, event.type === "user/message" ? "user" : "assistant", text);

      if (!autoExtract) return;
      const buffer = turns.get(sessionId) ?? [];
      buffer.push(text);
      turns.set(sessionId, buffer);
      const joined = buffer.join("\n");
      if (joined.length > MAX_CONVERSATION_CHARS) turns.set(sessionId, [joined.slice(-MAX_CONVERSATION_CHARS)]);
      return;
    }

    if (event.type === "turn/end") {
      const conversation = (turns.get(sessionId) ?? []).join("\n");
      turns.delete(sessionId);
      // 自动蒸馏：累计轮数，到点就在轮末跑一次启发式蒸馏（默认关闭，状态存在 auto-distill.json）
      void (async () => {
        try {
          const { recordTurn, markAutoDistillRun } = await import("../core/auto-distill.js");
          const { state, due } = recordTurn(dataDir);
          if (!due) return;
          const result = await runAction("distill.run", {
            mode: "heuristic",
            source: state.source,
            importToMemories: state.importToMemories === true,
          });
          markAutoDistillRun(dataDir, {
            distillId: result.ok ? result.id : null,
            after: result.ok ? result.memoryCount : null,
            skipped: result.ok ? null : result.error,
          });
        } catch (error) {
          logWarn(`自动蒸馏失败：${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      if (!autoExtract || !conversation.trim()) return;
      void runAction("extract.run", { conversation, sessionId, scope: "global" }).catch((error) => {
        logWarn(`轮末抽取失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  // ---------------------------------------------------------------- 工具

  const toolFailed = (message) => `Mirror 不可用：${message}`;

  ctx.tools.register(
    defineTool({
      name: "mirror_remember",
      description:
        "把一条需要长期记住的判断依据（偏好/铁律/决策/踩坑）写进 Mirror 本地记忆库：本地去重、冲突检测、落 SQLite，并立即参与下一轮注入。用户明确要求记住某件事，或你发现一条跨会话有用的约束时调用。",
      parameters: {
        content: {
          type: "string",
          required: true,
          description: "要记住的完整陈述，一句话说清，不要只给关键词。",
        },
        category: {
          type: "string",
          enum: ["iron_rule", "preference", "decision", "pitfall", "fuzzy"],
          description: "分类：铁律/偏好/决策/踩坑/模糊。省略时按内容自动判断。",
        },
        scope: { type: "string", description: "global 或 project:<名称>；默认 global。" },
        tags: { type: "string", description: "逗号分隔的标签，可省略。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            created: { type: "integer", required: true },
            skipped: { type: "integer", required: true },
            conflicts: { type: "integer", required: true },
            memory_ids: { type: "array", items: { type: "string" } },
            text: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text || "已处理。" }],
      },
      async execute(args) {
        try {
          const result = await runAction("memory.create", args);
          if (!result.ok) return { status: "error", created: 0, skipped: 0, conflicts: 0, memory_ids: [], text: result.error };
          if (result.duplicate) {
            return {
              status: "duplicate",
              created: 0,
              skipped: 1,
              conflicts: 0,
              memory_ids: [result.memory?.id ?? ""],
              text: `已存在等价记忆（${result.memory?.id ?? "未知"}），未重复写入。`,
            };
          }
          const conflicts = (result.conflicts ?? []).length;
          return {
            status: "created",
            created: 1,
            skipped: 0,
            conflicts,
            memory_ids: [result.memory?.id ?? ""],
            text: `${result.memory?.id ?? ""}：${result.memory?.content ?? ""}${conflicts > 0 ? `（检测到 ${conflicts} 条冲突，待用户裁决）` : ""}`,
          };
        } catch (error) {
          return { status: "error", created: 0, skipped: 0, conflicts: 0, memory_ids: [], text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_recall",
      description:
        "按当前问题检索 Mirror 里最相关的记忆与文档，返回可直接阅读的注入文本（铁律优先，其次是相关文档与偏好）。用户问“你还记得/之前我们怎么定的”时调用。",
      parameters: {
        query: { type: "string", required: true, description: "检索用的自然语言问题或关键词。" },
        mode: { type: "string", enum: ["light", "full"], description: "light 只给铁律与最相关文档；full 给分层全量。默认 full。" },
        scope: { type: "string", description: "global 或 project:<名称>；默认 global。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
            token_count: { type: "integer", required: true },
            memory_ids: { type: "array", items: { type: "string" } },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text || "（没有检索到相关记忆）" }],
      },
      async execute(args) {
        try {
          const opened = await ensureCore();
          const { retrieve, buildInjection } = await import("../core/retrieve.js");
          const budget = args.mode === "light" ? clamp(Math.round(tokenBudget / 2), 150, 4000) : tokenBudget;
          const result = retrieve({
            memories: opened.memories,
            documents: opened.documents,
            query: args.query,
            scope: args.scope || "global",
            tokenBudget: budget,
          });
          const built = buildInjection(result);
          const ids = [...(result.ironRules ?? []), ...(result.preferences ?? []), ...(result.decisions ?? []), ...(result.pitfalls ?? []), ...(result.fuzzy ?? [])]
            .map((memory) => memory.id)
            .filter(Boolean);
          return { text: built.text, token_count: built.token_count, memory_ids: ids };
        } catch (error) {
          return { text: toolFailed(error instanceof Error ? error.message : String(error)), token_count: 0, memory_ids: [] };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_forget",
      description:
        "遗忘：按 id 或按自然语言描述定位记忆并失效（默认，保留审计痕迹）或彻底删除。用户说“忘掉/别再记着/删掉那条”时调用。",
      parameters: {
        id: { type: "string", description: "记忆 id；有 id 时优先用 id。" },
        query: { type: "string", description: "没有 id 时用来检索最接近的一条记忆。" },
        mode: { type: "string", enum: ["invalidate", "delete"], description: "invalidate=标记失效（默认），delete=物理删除。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            memory_id: { type: "string" },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const opened = await ensureCore();
          let id = args.id ? String(args.id) : "";
          if (!id && args.query) {
            const found = opened.memories.search({ q: args.query, limit: 1 });
            id = found[0]?.id ?? "";
          }
          if (!id) return { ok: false, text: "没有定位到要遗忘的记忆（可以给更具体的描述或直接给 id）。" };
          if (args.mode === "delete") {
            await runAction("memory.delete", { id });
            return { ok: true, memory_id: id, text: `已彻底删除 ${id}（含向量/关联/审计记录）。` };
          }
          await runAction("memory.invalidate", { id, reason: "用户要求遗忘" });
          return { ok: true, memory_id: id, text: `已把 ${id} 标记为失效（保留审计痕迹）。` };
        } catch (error) {
          return { ok: false, text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_confirm",
      description: "确认一条模糊记忆：把 authority 提升为 user_confirmed，置信度 ≥0.9，并刷新验证时间（不再参与陈旧淘汰）。",
      parameters: { id: { type: "string", required: true, description: "记忆 id。" } },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, text: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const result = await runAction("memory.confirm", { id: args.id });
          return { ok: result.ok, text: result.ok ? `已确认：${result.memory.content}` : result.error };
        } catch (error) {
          return { ok: false, text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_doc_index",
      description: "把本地目录加入 Mirror 文档库并（增量）索引：Markdown 按标题切块，代码按函数/类切块。用户说“索引这个目录/让 AI 读我的文档”时调用。",
      parameters: {
        path: { type: "string", description: "要索引的目录绝对路径；省略时对已添加的所有目录做增量扫描。" },
        force: { type: "boolean", description: "true 时忽略 checksum/mtime 全量重建。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, text: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const opened = await ensureCore();
          if (args.path) {
            const result = await runAction("doc.addRoot", { path: args.path });
            if (!result.ok) return { ok: false, text: result.error };
            const scan = result.scan ?? {};
            return {
              ok: true,
              text: `已索引 ${args.path}：新增 ${scan.added ?? 0}，更新 ${scan.updated ?? 0}，删除 ${scan.removed ?? 0}，跳过 ${scan.skipped ?? 0}。`,
            };
          }
          const scan = opened.documents.scan({ force: args.force === true });
          return { ok: true, text: `增量扫描完成：新增 ${scan.added ?? 0}，更新 ${scan.updated ?? 0}，删除 ${scan.removed ?? 0}，跳过 ${scan.skipped ?? 0}。` };
        } catch (error) {
          return { ok: false, text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_doc_search",
      description: "在 Mirror 文档库里检索（关键词 + 路径 + 标题层级融合），返回带文件路径与标题链的片段。回答“这个 API 实际怎么用”之前先调用。",
      parameters: {
        query: { type: "string", required: true, description: "检索词或自然语言问题。" },
        limit: { type: "integer", description: "返回片段数，默认 8。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string", required: true }, count: { type: "integer", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const opened = await ensureCore();
          const results = opened.documents.search({ q: args.query, limit: clamp(Number(args.limit ?? 8) || 8, 1, 30) });
          if (results.length === 0) return { text: "（文档库里没有匹配片段）", count: 0 };
          const text = results
            .map((item, index) => {
              const header = item.chunk?.headingPath ? `${item.document?.filePath} > ${item.chunk.headingPath}` : item.document?.filePath;
              return `### ${index + 1}. ${header}\n${String(item.chunk?.content ?? "").slice(0, 1200)}`;
            })
            .join("\n\n");
          return { text, count: results.length };
        } catch (error) {
          return { text: toolFailed(error instanceof Error ? error.message : String(error)), count: 0 };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_doc_list",
      description: "列出 Mirror 文档库里已索引的目录与文档（路径、切片数、状态）。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute() {
        try {
          const opened = await ensureCore();
          const roots = opened.documents.listRoots();
          const documents = opened.documents.list({ limit: 200 });
          if (roots.length === 0) return { text: "文档库还是空的：用 mirror_doc_index 添加目录。" };
          const rootLines = roots.map((root) => `- ${root.path}（${root.fileCount ?? 0} 个文件）`);
          const docLines = documents.map(
            (doc) => `- [${doc.status}] ${doc.filePath} · ${doc.chunkCount ?? 0} 切片 · ${new Date(doc.lastModified ?? 0).toLocaleDateString()}`,
          );
          return { text: `## 已索引目录\n${rootLines.join("\n")}\n\n## 文档（${documents.length}）\n${docLines.join("\n")}` };
        } catch (error) {
          return { text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_pack_list",
      description: "列出已安装的 Mirror 记忆包（名称、版本、作者、记忆数、状态）。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string", required: true }, count: { type: "integer", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute() {
        try {
          const opened = await ensureCore();
          const packs = opened.packs.list();
          if (packs.length === 0) return { text: "还没有安装记忆包。", count: 0 };
          const lines = packs.map(
            (pack) => `- ${pack.packName} v${pack.packVersion}（${pack.author || "未知作者"}）· ${pack.memoryCount ?? 0} 条记忆 · ${pack.status}`,
          );
          return { text: `## 已安装记忆包（${packs.length}）\n${lines.join("\n")}`, count: packs.length };
        } catch (error) {
          return { text: toolFailed(error instanceof Error ? error.message : String(error)), count: 0 };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_pack_import",
      description: "导入一个本地 .mirrorpack 记忆包（开放 JSON 格式）。默认跳过与本地冲突的条目（local_first）。",
      parameters: {
        path: { type: "string", required: true, description: ".mirrorpack 或 .json 文件的绝对路径。" },
        strategy: {
          type: "string",
          enum: ["skip_conflicts", "pack_first", "local_first"],
          description: "冲突策略：skip_conflicts 跳过、pack_first 包优先、local_first 本地优先。默认 skip_conflicts。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, text: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const result = await runAction("pack.import", { path: args.path, strategy: args.strategy ?? "skip_conflicts" });
          if (!result.ok) return { ok: false, text: result.error };
          return {
            ok: true,
            text: `已导入 ${result.packId ?? ""} v${result.version ?? ""}：新增 ${result.created ?? 0} 条，跳过 ${result.skipped ?? 0} 条，冲突 ${result.conflicts ?? 0} 条。`,
          };
        } catch (error) {
          return { ok: false, text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  // ---------------------------------------------------------------- 文档先行

  ctx.tools.register(
    defineTool({
      name: "mirror_doc_ingest",
      description:
        "文档先行：把某项技术的最新官方文档抓进本地文档库（存成 Markdown + 参与切片/检索/注入），然后再动手实现。开始任何涉及外部框架/引擎的工作前（例如用 Godot 做游戏、用 Next.js 15 写页面）先调用它更新文档，再用 mirror_doc_search 确认版本/API 差异，避免拿过时知识写代码。",
      parameters: {
        topic: { type: "string", required: true, description: "主题名（会成为文档库里的目录名），如 godot / nextjs15 / godot-gdscript。" },
        urls: { type: "array", items: { type: "string" }, description: "要抓取的官方文档 URL 列表（最多 10 个，只支持 http/https）。" },
        title: { type: "string", description: "配合 content 使用时，这条笔记的标题。" },
        content: { type: "string", description: "已经读到的正文（Markdown/纯文本）——不方便抓取或需要人工摘要时用它直接存档。" },
        sourceUrl: { type: "string", description: "配合 content 使用时的来源 URL（便于审计）。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            text: { type: "string", required: true },
            topic: { type: "string" },
            dir: { type: "string" },
            files: { type: "integer" },
            chunks: { type: "integer" },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const result = await runAction("doc.ingest", {
            topic: args.topic,
            urls: args.urls,
            title: args.title,
            content: args.content,
            sourceUrl: args.sourceUrl,
          });
          if (!result.ok) return { ok: false, text: result.error || "文档抓取失败", topic: args.topic };
          const lines = (result.files || []).map((file) => `- ${file.title}（${Math.round((file.bytes || 0) / 1024)} KB）`);
          const errors = (result.errors || []).map((item) => `- ${item.source}：${item.message}`);
          return {
            ok: true,
            topic: result.topic,
            dir: result.dir,
            files: (result.files || []).length,
            chunks: result.scan?.added + result.scan?.updated || 0,
            text: [
              `已把 ${result.topic} 的 ${(result.files || []).length} 篇文档存进本地文档库：${result.dir}`,
              ...lines,
              result.scan ? `索引结果：新增 ${result.scan.added ?? 0} 个文件 / ${result.scan.updated ?? 0} 更新` : "",
              errors.length ? `抓取失败 ${errors.length} 个：\n${errors.join("\n")}` : "",
              "下一步：用 mirror_doc_search 检索确认版本/API，再开始实现。",
            ]
              .filter(Boolean)
              .join("\n"),
          };
        } catch (error) {
          return { ok: false, text: toolFailed(error instanceof Error ? error.message : String(error)), topic: args.topic };
        }
      },
    }),
  );

  // ---------------------------------------------------------------- 捕获 / 蒸馏 / 导出

  ctx.tools.register(
    defineTool({
      name: "mirror_capture",
      description:
        "会话捕获开关（本地、默认关闭）：打开后插件会把之后每一轮你和 AI 的对话追加到本地 sessions/*.jsonl，供 mirror_distill 蒸馏。只存本机，不上传；用户明确同意才打开。",
      parameters: {
        action: {
          type: "string",
          enum: ["status", "enable", "disable", "list", "read", "drop", "clear"],
          required: true,
          description: "status 查状态 / enable 打开 / disable 关闭 / list 列出已捕获会话 / read 读某会话 / drop 删某会话 / clear 清空全部原始捕获",
        },
        sessionId: { type: "string", description: "read / drop 时必填" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, text: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const action = String(args.action ?? "status");
          if (action === "enable" || action === "disable") {
            const result = await runAction("capture.update", { enabled: action === "enable" });
            return {
              ok: result.ok,
              text: result.ok ? `会话捕获已${result.enabled ? "打开" : "关闭"}（仅存本地 ${dataDir}\\sessions）。` : result.error,
            };
          }
          if (action === "read") {
            const result = await runAction("capture.read", { sessionId: args.sessionId });
            if (!result.ok) return { ok: false, text: result.error };
            const lines = (result.turns || []).map((turn) => `${turn.role === "assistant" ? "AI" : "用户"}: ${turn.text.slice(0, 160)}`);
            return { ok: true, text: lines.length ? lines.join("\n") : "（该会话没有捕获内容）" };
          }
          if (action === "drop") {
            const result = await runAction("capture.drop", { sessionId: args.sessionId });
            return { ok: result.ok, text: result.ok ? `已删除 ${args.sessionId} 的本地对话记录。` : result.error };
          }
          if (action === "clear") {
            const result = await runAction("capture.clear", {});
            return { ok: result.ok, text: result.ok ? `已清空 ${(result.removed || []).length} 个会话的原始捕获（蒸馏出的画像不受影响）。` : result.error };
          }          if (action === "list") {
            const result = await runAction("capture.status", {});
            const sessions = result.sessions || [];
            if (sessions.length === 0) return { ok: true, text: `捕获${result.enabled ? "已开启" : "未开启"}；还没有捕获到会话。` };
            const lines = sessions.map((item) => `- ${item.sessionId} · ${item.turns} 轮 · ${new Date(item.updatedAt).toLocaleString()}`);
            return { ok: true, text: `捕获${result.enabled ? "已开启" : "已关闭（历史仍保留）"}，共 ${sessions.length} 个会话：\n${lines.join("\n")}` };
          }
          const result = await runAction("capture.status", {});
          return {
            ok: true,
            text: `捕获${result.enabled ? "已开启" : "未开启"}；已捕获 ${result.totals?.sessions ?? (result.sessions || []).length} 个会话 / ${result.totals?.turns ?? 0} 轮 / ${Math.round((result.totals?.bytes ?? 0) / 1024)} KB。数据只在本地：${dataDir}\\sessions`,
          };
        } catch (error) {
          return { ok: false, text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_distill",
      description:
        "把会话蒸馏成结构化「认知画像」（profile / preferences / rules / patterns / skills / avoid）。数据源可选：source=capture（插件捕获的）或 source=dsh（直接读 DSH 已有的历史会话日志，只读本机）或 all。用法：先 mode=prepare 拿 prompt 与对话摘要，由你自己产出 JSON，再 mode=apply 传 distillation 落库；没有模型时可用 mode=heuristic 兜底。",
      parameters: {
        mode: { type: "string", enum: ["prepare", "apply", "heuristic"], description: "prepare 取 prompt / apply 提交蒸馏结果 / heuristic 离线兜底" },
        source: {
          type: "string",
          enum: ["capture", "dsh", "all"],
          description: "数据源：capture=插件捕获（默认）/ dsh=DSH 历史会话日志 / all=两者合并",
        },
        distillation: { type: "string", description: "apply 时传：模型产出的 JSON（六个字段）" },
        sessionIds: { type: "array", items: { type: "string" }, description: "只蒸馏这些会话；省略=最近若干个" },
        maxSessions: { type: "integer", description: "source=dsh 时最多读几个历史会话（默认 10，上限 30）" },
        importToMemories: { type: "boolean", description: "true 时把画像里的条目直接写入记忆库（默认 false）" },
        scope: { type: "string", description: "importToMemories 时的作用域：global（默认）或 project:<名称>" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            text: { type: "string", required: true },
            phase: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const result = await runAction("distill.run", {
            mode: args.mode ?? "prepare",
            source: args.source ?? "capture",
            distillation: args.distillation,
            sessionIds: args.sessionIds,
            maxSessions: args.maxSessions,
            importToMemories: args.importToMemories === true,
            scope: args.scope,
          });
          if (!result.ok) return { ok: false, text: result.error || "蒸馏失败" };
          if (result.phase === "prepare") {
            return {
              ok: true,
              phase: "prepare",
              text: `已取到 ${result.sessions.length} 个会话。请按下面 prompt 产出 JSON，然后调用 mirror_distill(mode="apply", distillation=<JSON>)。\n\n${result.prompt}`,
            };
          }
          const profile = result.profile || {};
          const size = ["preferences", "rules", "patterns", "skills", "avoid"].reduce(
            (sum, key) => sum + (Array.isArray(profile[key]) ? profile[key].length : 0),
            0,
          );
          return {
            ok: true,
            phase: "done",
            text: [
              `画像已生成（${result.source}，${size} 条，id=${result.id}）。`,
              profile.profile ? `画像：${profile.profile}` : "",
              result.memoryCount > 0 ? `已写入记忆 ${result.memoryCount} 条。` : "（未写入记忆；需要时用 importToMemories=true）",
            ]
              .filter(Boolean)
              .join("\n"),
          };
        } catch (error) {
          return { ok: false, text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "mirror_quality",
      description:
        "记忆库质量体检与撤销：report 返回重复对/未解冲突/陈旧/未确认推断的数量与干净度分数；undo 撤销某次蒸馏导入（只删 AI 推断、未确认、未改过的记忆）。",
      parameters: {
        action: { type: "string", enum: ["report", "undo", "duplicates", "merge", "benchmark"], required: true, description: "report 体检 / undo 撤销一次蒸馏 / duplicates 近似重复对 / merge 合并两条记忆 / benchmark 经验可达性回归" },
        id: { type: "string", description: "undo 时必填：蒸馏 id（distill.list 或 report.lastDistill.id）" },
        keepId: { type: "string", description: "merge 时必填：保留的记忆 id" },
        dropId: { type: "string", description: "merge 时必填：被合并掉的记忆 id" },
        topK: { type: "integer", description: "benchmark 的 topK（默认 5，1-20）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", required: true }, text: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        try {
          const action = String(args.action ?? "report");
          if (action === "undo") {
            const result = await runAction("distill.undo", { id: args.id });
            if (!result.ok) return { ok: false, text: result.error };
            return { ok: true, text: `已撤销蒸馏 ${result.id}：删除 ${result.removed} 条，保留 ${result.kept} 条（已确认/已修改）。` };
          }
          if (action === "duplicates") {
            const result = await runAction("quality.duplicates", { limit: 20 });
            if (!result.ok) return { ok: false, text: result.error };
            if (!result.pairs.length) return { ok: true, text: `没有相似度 ≥ ${result.minScore} 的近似重复对。` };
            const lines = result.pairs.map(
              (pair) =>
                `- ${pair.similarity} · ${pair.a.id} / ${pair.b.id}\n  保留：${pair.a.content.slice(0, 60)}\n  合并：${pair.b.content.slice(0, 60)}`,
            );
            return { ok: true, text: `近似重复对 ${result.total} 组（显示 ${result.pairs.length}）：\n${lines.join("\n")}` };
          }
          if (action === "merge") {
            const result = await runAction("memory.merge", { keepId: args.keepId, dropId: args.dropId });
            if (!result.ok) return { ok: false, text: result.error };
            return {
              ok: true,
              text: `已合并：保留 ${result.kept.id}，${result.superseded} 标记为被取代；关闭冲突 ${result.conflictsClosed} 条，标签合并为 ${result.tagsMerged} 个。`,
            };
          }
          if (action === "benchmark") {
            const result = await runAction("quality.benchmark", { topK: args.topK, scope: "all" });
            if (!result.ok) return { ok: false, text: result.error };
            const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
            const lines = [
              `经验可达性：${result.hits}/${result.total}（${percent(result.hitRate)}）· top${result.topK}${result.avgRank ? ` · 平均名次 ${result.avgRank}` : ""}`,
            ];
            if (result.baseline) {
              lines.push(
                `对照（关闭向量）：${result.baseline.hits}/${result.baseline.total}（${percent(result.baseline.hitRate)}）→ 提升 ${Math.round((Number(result.improvement) || 0) * 100)} 个百分点`,
              );
            }
            if (result.misses.length > 0) {
              lines.push(`未命中 ${result.misses.length} 条：\n${result.misses.map((miss) => `- ${miss.prompt.slice(0, 60)}`).join("\n")}`);
            }
            return { ok: true, text: lines.join("\n") };
          }
          const result = await runAction("quality.report", {});
          if (!result.ok) return { ok: false, text: result.error };
          const r = result.report;
          return {
            ok: true,
            text: [
              `记忆库干净度：${r.score}/100（共 ${r.total} 条）`,
              `经验 ${r.experiences} · 外部来源 ${r.untrusted} · 近似重复对 ${r.nearDuplicatePairs} · 未解冲突 ${r.openConflicts} · 陈旧 ${r.stale}`,
              r.lastDistill ? `最近蒸馏：${r.lastDistill.id}（${r.lastDistill.source}，${new Date(r.lastDistill.createdAt).toLocaleString()}）` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          };
        } catch (error) {
          return { ok: false, text: toolFailed(error instanceof Error ? error.message : String(error)) };
        }
      },
    }),
  );

  // ---------------------------------------------------------------- 卸载

  ctx.effect(
    () => () => {
      try {
        core?.store?.close?.();
      } catch {
        /* 忽略 */
      }
      core = null;
      corePromise = null;
    },
    "mirror: close store",
  );

  logInfo("插件已加载（工具 / 逐轮注入 / 面板 API / 左侧栏面板）");
}
