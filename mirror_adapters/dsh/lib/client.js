/**
 * mirror-dsh-adapter — 浏览器半月（DSH Web GUI 的 Mirror 面板）。
 *
 * 本文件 **不是 ESM**：它是 DSH 浏览器模块加载器的 factory 包，格式固定为
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return exports } })
 * 只能 require 平台种子模块（react / react-dom / react/jsx-runtime）。因此这里
 * 没有 import/export，没有 JSX，只能用 React.createElement。
 *
 * 说明见仓库根 README 与 docs/INSTALL-GITHUB.md：
 *   - §8.2 左侧栏入口：ctx.slots.inject("sidebar.panellist", …) 探测 + register
 *     { name, id: "mirror", order: 10, label, locale }，渲染 16x16 内联 SVG 图标；
 *     中央列：ctx.slots.register({ name: "main", key: "mirror" }, Panel)。
 *     register 返回的 disposer 包在 ctx.effect(() => …, "mirror: …") 里；
 *     宿主没声明某个槽位时安静降级，不抛错。
 *   - §8.3 面板内容：顶栏 / 9 个 Tab / 记忆卡片与内联增删改 / 文档库 / 记忆包 /
 *     待确认裁决 / 注入预览 / 加载骨架 / 错误横幅 / 按钮 loading / 操作后刷新。
 *   - §7 数据全部走同源 HTTP：GET /mirror/api/state、GET /mirror/api/search、
 *     POST /mirror/api/action（{ type, … }）；所有请求带 credentials: "same-origin"、
 *     cache: "no-store"。
 *   - 样式：apply() 注入 <style id="mirror-panel-style">，类名前缀 mrp-，颜色只用
 *     DSH 主题变量且每个 var() 都带 fallback，深色主题下可读。
 */
window.__ModuleLoader__.load({
  id: "mirror-dsh-adapter",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    // ------------------------------------------------------------------
    // 常量
    // ------------------------------------------------------------------

    /** locale 命名空间（本半月自己的字典）。 */
    const NS = "mirror-panel";
    /** 左侧栏入口 id / 中央面板 key。 */
    const PANEL_ID = "mirror";
    /** 同源 HTTP 基址（契约 §7）。 */
    const API_BASE = "/mirror/api";

    /** 九宫格外的分类元数据（契约 §8.3 / 文档 §4.1 的五类记忆）。 */
    const CATEGORIES = [
      { key: "iron_rule", label: "铁律", emoji: "🔴", tone: "error", hint: "永远适用的硬性约束，权威最高。" },
      { key: "preference", label: "偏好", emoji: "🟡", tone: "warn", hint: "大概率适用的风格与习惯。" },
      { key: "decision", label: "决策", emoji: "📋", tone: "business", hint: "特定场景下的选择及原因。" },
      { key: "pitfall", label: "踩坑", emoji: "⚠️", tone: "brand", hint: "犯过的错误与教训（症状 → 原因 → 修法）。" },
      { key: "fuzzy", label: "模糊", emoji: "❓", tone: "dimmed", hint: "AI 推测但尚未确认，值得你点头或摇头。" },
    ];
    const CATEGORY_BY_KEY = new Map(CATEGORIES.map((item) => [item.key, item]));

    /** 顶栏之后的 Tab 顺序（R14 瘦身：模糊并入偏好筛选、关联并入文档库折叠区）。 */
    const TABS = [
      { key: "iron_rule", label: "铁律" },
      { key: "preference", label: "偏好" },
      { key: "pitfall", label: "踩坑" },
      { key: "documents", label: "文档库" },
      { key: "packs", label: "记忆包" },
      { key: "pending", label: "待确认" },
      { key: "inject", label: "注入预览" },
    ];

    /** 偏好 Tab 内的三个筛选（偏好/决策/模糊）。 */
    const PREFERENCE_FILTERS = [
      { key: "preference", label: "偏好" },
      { key: "decision", label: "决策" },
      { key: "fuzzy", label: "模糊" },
    ];

    const AUTHORITY_LABEL = {
      user_explicit: "用户显式",
      user_confirmed: "用户确认",
      imported: "包导入",
      inferred: "AI 推断",
    };

    const MEMORY_STATUS_LABEL = {
      active: "生效中",
      superseded: "已失效",
      archived: "已归档",
      deleted: "已删除",
      pending: "待确认",
    };

    const DOCUMENT_STATUS_LABEL = {
      active: "已索引",
      deleted: "已移除",
      error: "错误",
    };

    const CONFLICT_TYPE_LABEL = {
      contradiction: "内容矛盾",
      scope_overlap: "作用域重叠",
      temporal_mismatch: "时间线不一致",
      doc_updated: "文档已更新",
      pack_updated: "记忆包更新",
    };

    const RESOLUTION_LABEL = {
      winner_a: "A 优先",
      winner_b: "B 优先",
      both_valid: "都保留",
      both_invalid: "都无效",
      dismiss: "忽略",
    };

    /** 文档 ↔ 记忆关联（契约 §10.3/§10.6）：关系文案与徽标色调。 */
    const RELATION_LABEL = {
      supports: "支持",
      contradicts: "矛盾",
      supersedes: "取代",
      unrelated: "无关",
    };

    const RELATION_TONE = {
      supports: "ok",
      contradicts: "error",
      supersedes: "neutral",
      unrelated: "neutral",
    };

    /** locale 字典：宿主可能用 t("title") 取面板名，两个语言都给中文（产品文案中文）。 */
    const COPY = {
      nav: "Mirror",
      title: "Mirror · 我对你的理解",
      subtitle: "我对你的理解 · v2.0",
    };

    /**
     * R4 D：首次打开的一句话引导。页面会话级（模块单例），不写 localStorage；
     * 切换到别的 Tab 不会重复出现，卸载重挂也不会。
     */
    let introDismissed = false;
    function dismissIntro() {
      introDismissed = true;
    }
    function resetIntro() {
      introDismissed = false;
    }

    /** R4 E：注入预览的示例 query，点一下直接填并触发。 */
    const INJECT_EXAMPLES = [
      { key: "habits", label: "我的使用习惯" },
      { key: "workflow", label: "这个项目的开发流程" },
      { key: "pitfalls", label: "最近的踩坑" },
    ];

    function buildInjectPreviewRequest(query, tokenBudget, scope) {
      return {
        query: str(query),
        tokenBudget: num(tokenBudget, 3000) || 3000,
        scope: str(scope) || "all",
      };
    }

    async function requestInjectPreview(payload) {
      return api.action("inject.preview", payload);
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    function warn(message, error) {
      if (typeof console === "undefined" || typeof console.warn !== "function") return;
      if (error === undefined) console.warn("[mirror] " + message);
      else console.warn("[mirror] " + message, error);
    }

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function asObject(value) {
      return value !== null && typeof value === "object" ? value : {};
    }

    function str(value) {
      if (typeof value === "string") return value;
      if (value === undefined || value === null) return "";
      return String(value);
    }

    function num(value, fallback) {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback === undefined ? 0 : fallback;
      return n;
    }

    function bool(value) {
      return value === true || value === 1 || value === "1" || value === "true";
    }

    function firstDefined(candidates) {
      for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null) return candidate;
      }
      return undefined;
    }

    function truncate(text, limit) {
      const value = str(text);
      if (value.length <= limit) return value;
      return value.slice(0, limit) + "…";
    }

    function splitTags(value) {
      return str(value)
        .split(/[,\uFF0C\u3001\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    function pad2(value) {
      return value < 10 ? "0" + value : String(value);
    }

    /** 毫秒/秒两种时间戳都认（SQLite 里 REAL 可能是秒，JS 侧是毫秒）。 */
    function toDate(value) {
      const raw = Number(value);
      if (!Number.isFinite(raw) || raw <= 0) return null;
      const ms = raw < 100000000000 ? raw * 1000 : raw;
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) return null;
      return date;
    }

    function formatTimestamp(value) {
      const date = toDate(value);
      if (!date) return "—";
      return (
        date.getFullYear() +
        "-" +
        pad2(date.getMonth() + 1) +
        "-" +
        pad2(date.getDate()) +
        " " +
        pad2(date.getHours()) +
        ":" +
        pad2(date.getMinutes())
      );
    }

    function formatShortTimestamp(value) {
      const date = toDate(value);
      if (!date) return "—";
      return pad2(date.getMonth() + 1) + "/" + pad2(date.getDate()) + " " + pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }

    function formatConfidence(value) {
      const ratio = num(value, 0);
      return Math.round(Math.max(0, Math.min(1, ratio)) * 100) + "%";
    }

    /** 空态「主操作」聚焦到页面上的某个输入框（SSR 下安全 no-op）。 */
    function focusById(id) {
      if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
      const node = document.getElementById(id);
      if (node && typeof node.focus === "function") node.focus();
    }

    /** 顶栏「最后更新 HH:mm」。 */
    function formatClock(value) {
      const date = toDate(value);
      if (!date) return "";
      return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }

    /**
     * 估算 textarea 需要的行数：按换行 + 每 46 字符折行，夹在 [minRows, maxRows]。
     * 用于编辑态「随内容自动撑高，最多 8 行」。
     */
    function autoRows(text, minRows, maxRows) {
      const lines = str(text).split("\n");
      let rows = 0;
      for (const line of lines) rows += Math.max(1, Math.ceil(Array.from(line).length / 46));
      return Math.max(minRows === undefined ? 2 : minRows, Math.min(maxRows === undefined ? 8 : maxRows, rows));
    }

    function authorityLabel(value) {
      return AUTHORITY_LABEL[str(value)] || str(value) || "未知来源";
    }

    function memoryStatusLabel(value) {
      return MEMORY_STATUS_LABEL[str(value)] || str(value);
    }

    function documentStatusLabel(value) {
      return DOCUMENT_STATUS_LABEL[str(value)] || str(value);
    }

    function conflictTypeLabel(value) {
      return CONFLICT_TYPE_LABEL[str(value)] || str(value) || "冲突";
    }

    function resolutionLabel(value) {
      return RESOLUTION_LABEL[str(value)] || str(value);
    }

    function relationLabel(value) {
      return RELATION_LABEL[str(value)] || str(value) || "关联";
    }

    function categoryLabel(value) {
      const meta = CATEGORY_BY_KEY.get(str(value));
      return meta ? meta.label : str(value);
    }

    /** scope 文案直白化（R4）：全部记忆 / 仅全局 / 项目：<name>。 */
    function scopeLabel(value) {
      const scope = str(value) || "all";
      if (scope === "all") return "全部记忆";
      if (scope === "global") return "仅全局";
      if (scope.indexOf("project:") === 0) return "项目：" + scope.slice(8);
      return scope;
    }

    /** Tab 键盘导航（R4 C）：ArrowLeft/ArrowRight 环绕，Home/End 到首尾。 */
    function moveTab(currentKey, key) {
      const index = TABS.findIndex((item) => item.key === currentKey);
      if (index < 0) return currentKey;
      if (key === "ArrowRight") return TABS[(index + 1) % TABS.length].key;
      if (key === "ArrowLeft") return TABS[(index - 1 + TABS.length) % TABS.length].key;
      if (key === "Home") return TABS[0].key;
      if (key === "End") return TABS[TABS.length - 1].key;
      return currentKey;
    }

    function describeError(error) {
      if (!error) return "未知错误";
      if (typeof error === "string") return error;
      const message = str(error.message) || String(error);
      const status = num(error.status, 0);
      if (status > 0 && message.indexOf("HTTP") === -1) return message + "（HTTP " + status + "）";
      return message;
    }

    // ------------------------------------------------------------------
    // HTTP 层（契约 §7）
    // ------------------------------------------------------------------

    function withQuery(path, params) {
      const parts = [];
      for (const key of Object.keys(params)) {
        const value = params[key];
        if (value === undefined || value === null || value === "") continue;
        parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
      }
      return parts.length ? path + "?" + parts.join("&") : path;
    }

    /**
     * 同源请求。业务失败由契约保证是 HTTP 200 + { ok:false, error }，
     * 这里统一抛 Error（面板显示 error 原文）。
     */
    async function requestJson(path, init) {
      const options = init || {};
      const url = path.indexOf("http") === 0 ? path : API_BASE + path;
      const requestInit = {
        method: options.method || "GET",
        credentials: "same-origin",
        cache: "no-store",
      };
      if (options.body !== undefined) {
        requestInit.headers = { "Content-Type": "application/json" };
        requestInit.body = JSON.stringify(options.body);
      }
      const response = await fetch(url, requestInit);
      const raw = await response.text();
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (parseError) {
          data = null;
        }
      }
      if (!response.ok) {
        const message = str(asObject(data).error) || truncate(raw, 200) || "HTTP " + response.status;
        const error = new Error(message);
        error.status = response.status;
        error.detail = data;
        throw error;
      }
      if (data === null) {
        const error = new Error("返回内容不是合法 JSON（" + truncate(raw, 120) + "）");
        error.status = response.status;
        throw error;
      }
      if (data && typeof data === "object" && data.ok === false) {
        const error = new Error(str(data.error) || "操作失败");
        error.status = response.status;
        // R9：业务拒绝（如指令注入拦截）需要把 blocked/suspect 等字段带给调用方。
        error.detail = data;
        throw error;
      }
      return data;
    }

    const api = {
      getState(options) {
        const opts = options || {};
        return requestJson(withQuery("/state", { scope: opts.scope }));
      },
      search(options) {
        const opts = options || {};
        return requestJson(withQuery("/search", { q: opts.q, scope: opts.scope, limit: opts.limit }));
      },
      action(type, payload) {
        return requestJson("/action", { method: "POST", body: Object.assign({ type: type }, payload || {}) });
      },
      getDocument(id) {
        return requestJson("/document/" + encodeURIComponent(str(id)));
      },
    };

    /**
     * 契约 §10.5：查一次记忆包更新。只返回 available 为真、且带 packId 的条目；
     * 任何异常由调用方静默吞掉（面板不因为后端不可用而报错）。
     */
    async function fetchPackUpdates() {
      const result = await api.action("pack.checkUpdates", {});
      return normalizePackUpdates(result && result.updates);
    }

    function normalizePackUpdates(list) {
      return asArray(list)
        .map(normalizePackUpdate)
        .filter((update) => update.available === true && update.packId !== "");
    }

    /**
     * 顶栏全局搜索：GET /mirror/api/search?q=&limit=12，返回归一化的记忆/文档与耗时（ms）。
     * 顶栏覆盖层与测试共用这一条路径。
     */
    async function searchAll(query, scope) {
      const started = Date.now();
      const scoped = scope && scope !== "all" ? scope : undefined;
      const data = await api.search({ q: query, scope: scoped, limit: 12 });
      return {
        memories: asArray(data && data.memories).map(normalizeMemory),
        documents: asArray(data && data.documents).map(normalizeDocument),
        elapsed: Date.now() - started,
      };
    }

    /** 导出 meta 的默认值补全（批量操作条与记忆包 Tab 共用）。 */
    function normalizeExportMeta(meta) {
      const m = asObject(meta);
      return {
        name: str(m.name),
        version: str(m.version) || "1.0.0",
        author: str(m.author),
        description: str(m.description),
        category: str(m.category) || "framework",
      };
    }

    /** 统一导出入口：POST /action {type:"pack.export", memoryIds, meta, includeProfile?}。 */
    async function exportMemories(memoryIds, meta, includeProfile) {
      const ids = asArray(memoryIds)
        .map(str)
        .filter(Boolean);
      const payload = { memoryIds: ids, meta: normalizeExportMeta(meta) };
      if (typeof includeProfile === "boolean") payload.includeProfile = includeProfile;
      return api.action("pack.export", payload);
    }

    /** R8：画像摘要（一句话前 40 字 + 规则/偏好/模式/技能/避免 五组判断总数）。 */
    function profileSummary(profile) {
      const p = asObject(profile);
      const sentence = truncate(str(p.profile) || "（无一句话画像）", 40);
      let count = 0;
      for (const group of PROFILE_GROUPS) count += asArray(p[group.key]).length;
      return { sentence: sentence, count: count };
    }

    /** R8：导出可用性——未选记忆但勾选画像且确有画像时允许「仅导出认知画像」。 */
    function packExportAvailability(selectedCount, includeProfile, profileExists) {
      const count = num(selectedCount, 0);
      const onlyProfile = count === 0 && includeProfile === true && profileExists === true;
      return { allowed: count > 0 || onlyProfile, onlyProfile: onlyProfile };
    }

    function packExportNotice(result, memoryCount) {
      const hasProfile = result && result.hasProfile === true;
      return (
        "已导出 " +
        (str(result && result.path) || "（服务端未返回路径）") +
        "（记忆 " +
        num(memoryCount, 0) +
        " 条 · 含画像：" +
        (hasProfile ? "是" : "否") +
        "）"
      );
    }

    function packImportNotice(result) {
      const created = num(result && (result.created !== undefined ? result.created : result.installed), 0);
      const skipped = num(result && result.skipped, 0);
      const conflicts = asArray(result && result.conflicts).length;
      return (
        "已导入记忆包：" +
        created +
        " 条新增 / " +
        skipped +
        " 条跳过" +
        (conflicts > 0 ? " / " + conflicts + " 条冲突待裁决" : "") +
        (result && result.hasProfile === true ? "。该包包含认知画像，已作为最近画像载入（见上方蒸馏卡片）" : "")
      );
    }

    /**
     * R9：导入入口。指令注入拦截返回 ok:false + blocked:true，
     * 这里把它转成 { blocked, data } 给面板渲染红色拒绝提示（force:true 可强行导入）。
     */
    async function importPack(path, strategy, force) {
      const payload = { path: str(path), strategy: str(strategy) || "skip_conflicts" };
      if (force === true) payload.force = true;
      try {
        const data = await api.action("pack.import", payload);
        return { ok: true, data: data };
      } catch (error) {
        const detail = error && error.detail;
        if (detail && detail.blocked === true) {
          return { ok: false, blocked: true, data: detail };
        }
        throw error;
      }
    }

    /** R5 会话捕获 / 蒸馏动作（面板与测试共用同一份请求形状）。 */
    async function updateCapture(enabled) {
      return api.action("capture.update", { enabled: enabled === true });
    }

    async function readCapture(sessionId) {
      return api.action("capture.read", { sessionId: str(sessionId) });
    }

    async function dropCapture(sessionId) {
      return api.action("capture.drop", { sessionId: str(sessionId) });
    }

    async function captureStatus() {
      return api.action("capture.status", {});
    }

    async function runDistill(payload) {
      return api.action("distill.run", asObject(payload));
    }

    /** R6：蒸馏数据源（capture=插件捕获 / dsh=DSH 历史会话 / all=两者）。 */
    const DISTILL_SOURCES = [
      { key: "capture", label: "插件捕获" },
      { key: "dsh", label: "DSH 历史会话" },
      { key: "all", label: "两者都蒸馏" },
    ];

    /** 列一下蒸馏可用的数据源（DSH 历史会话 + 已捕获会话）。 */
    async function distillSources() {
      return api.action("distill.sources", {});
    }

    /** 统一构造 distill.run 请求体：source / scope 一律显式带上。 */
    function buildDistillPayload(mode, source, extra, scope) {
      return Object.assign(
        { mode: str(mode), source: str(source) || "capture", scope: str(scope) || "global" },
        asObject(extra)
      );
    }

    /** R7：authority → 徽标色调与说明（AI 推断要显眼、可确认）。 */
    const AUTHORITY_TONE = {
      inferred: "warn",
      imported: "brand",
      user_confirmed: "ok",
      user_explicit: "business",
    };

    const AUTHORITY_TITLE = {
      inferred: "AI 推断（蒸馏/自动抽取），点「确认」后才进入常驻注入",
      imported: "来自记忆包",
      user_confirmed: "你确认过的记忆",
      user_explicit: "你明确说过的记忆",
    };

    /** 容量展示：B / KB / MB，0 视为无数据。 */
    function formatBytes(bytes) {
      const value = num(bytes, 0);
      if (value <= 0) return "0 KB";
      if (value < 1024) return value + " B";
      if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + " KB";
      return Math.round((value / (1024 * 1024)) * 10) / 10 + " MB";
    }

    /** R7：捕获存储治理。 */
    async function clearCapture() {
      return api.action("capture.clear", {});
    }

    async function pruneCapture(maxSessions) {
      return api.action("capture.prune", { maxSessions: num(maxSessions, 0) });
    }

    function normalizeDistillSession(raw) {
      const s = asObject(raw);
      return {
        sessionId: str(s.sessionId !== undefined ? s.sessionId : s.session_id),
        source: str(s.source) || "capture",
        turns: num(s.turns, 0),
        chars: num(s.chars, 0),
        bytes: num(s.bytes, 0),
        workspace: str(s.workspace),
        updatedAt: num(firstDefined([s.updatedAt, s.updated_at]), 0),
        compressed: bool(s.compressed),
      };
    }

    /** 画像五组（R5）：键固定，顺序即面板展示顺序。 */
    const PROFILE_GROUPS = [
      { key: "rules", label: "规则", tone: "error" },
      { key: "preferences", label: "偏好", tone: "warn" },
      { key: "patterns", label: "模式", tone: "business" },
      { key: "skills", label: "技能", tone: "ok" },
      { key: "avoid", label: "避免", tone: "dimmed" },
    ];

    function normalizeProfile(raw) {
      const p = asObject(raw);
      const out = {
        profile: str(p.profile),
        confidence: num(p.confidence, 0),
        experiences: asArray(p.experiences).map(normalizeExperience).filter((item) => item.trigger || item.action),
      };
      for (const group of PROFILE_GROUPS) {
        out[group.key] = asArray(p[group.key]).map(str).filter(Boolean);
      }
      return out;
    }

    /** R9：经验条目（画像第六段 / 记忆 structured.kind === "experience"）。 */
    function normalizeExperience(raw) {
      const e = asObject(raw);
      return {
        trigger: str(firstDefined([e.trigger, e.situation])),
        action: str(firstDefined([e.action, e.doing])),
        why: str(firstDefined([e.why, e.reason])),
        boundary: str(e.boundary),
        evidence: str(e.evidence),
        since: str(e.since),
        confidence: num(e.confidence, 0),
      };
    }

    function isExperienceStructured(structured) {
      return str(asObject(structured).kind) === "experience";
    }

    /** R9：apply 返回的 safety → 中文提示（无风险返回空串）。 */
    function distillSafetyNotice(safety) {
      const s = asObject(safety);
      if (s.suspect !== true) return "";
      const hits = num(s.hits, 0);
      if (s.blocked === true) return "画像已保存，但有 " + hits + " 处可疑内容，未写入记忆库";
      return "有 " + hits + " 处可疑内容，请复核";
    }

    function normalizeSafety(safety) {
      const s = asObject(safety);
      return {
        suspect: s.suspect === true,
        hits: num(s.hits, 0),
        blocked: s.blocked === true,
      };
    }

    /** R9：导入被拦截时的提示文案。 */
    function importBlockedMessage(detail) {
      const suspect = asArray(detail && detail.suspect);
      return "已拒绝导入：检测到 " + suspect.length + " 处可疑指令样式";
    }

    /** R10：质量体检报告归一化（0–100 干净度 + 指标行）。 */
    function normalizeQualityReport(raw) {
      const r = asObject(raw);
      const byAuthority = asObject(firstDefined([r.byAuthority, r.by_authority]));
      const last = asObject(firstDefined([r.lastDistill, r.last_distill]));
      const hasLast = Object.keys(last).length > 0;
      return {
        total: num(r.total, 0),
        experiences: num(r.experiences, 0),
        untrusted: num(r.untrusted, 0),
        openConflicts: num(firstDefined([r.openConflicts, r.open_conflicts]), 0),
        stale: num(r.stale, 0),
        nearDuplicatePairs: num(firstDefined([r.nearDuplicatePairs, r.near_duplicate_pairs]), 0),
        byAuthority: {
          user_explicit: num(firstDefined([byAuthority.user_explicit, byAuthority.userExplicit]), 0),
          user_confirmed: num(firstDefined([byAuthority.user_confirmed, byAuthority.userConfirmed]), 0),
          imported: num(byAuthority.imported, 0),
          inferred: num(byAuthority.inferred, 0),
        },
        lastDistill: hasLast
          ? {
              id: str(last.id),
              createdAt: num(firstDefined([last.createdAt, last.created_at]), 0),
              source: str(last.source),
              memoryCount: num(firstDefined([last.memoryCount, last.memory_count]), 0),
            }
          : null,
        score: num(r.score, 0),
      };
    }

    function qualityTone(score) {
      const value = num(score, 0);
      if (value >= 85) return "ok";
      if (value >= 60) return "warn";
      return "error";
    }

    async function qualityReport() {
      return api.action("quality.report", {});
    }

    async function undoDistill(id) {
      return api.action("distill.undo", { id: str(id) });
    }

    /** R10：apply 的去噪信息（空数组=没有需要展示的行）。 */
    function distillDenoiseLines(result) {
      const r = asObject(result);
      const quality = asObject(r.quality);
      const dropped = asArray(quality.dropped).map(str).filter(Boolean);
      const redacted = asArray(quality.redacted)
        .map((item) => ({ label: str(asObject(item).label), count: num(asObject(item).count, 0) }))
        .filter((item) => item.label !== "");
      const lines = [];
      if (dropped.length > 0) lines.push("已去噪 " + dropped.length + " 条空话/无效内容");
      const redactedTotal = redacted.reduce((sum, item) => sum + item.count, 0);
      if (redactedTotal > 0) {
        lines.push("已脱敏 " + redactedTotal + " 处（" + redacted.map((item) => item.label + "×" + item.count).join("、") + "）");
      }
      const deduped = num(r.deduped, 0);
      if (deduped > 0) lines.push("批内合并 " + deduped + " 条近似重复");
      return lines;
    }

    function normalizeCapture(raw) {
      const c = asObject(raw);
      const limits = asObject(c.limits);
      return {
        enabled: bool(c.enabled),
        enabledAt: num(firstDefined([c.enabledAt, c.enabled_at]), 0),
        sessions: num(c.sessions, 0),
        turns: num(c.turns, 0),
        bytes: num(c.bytes, 0),
        lastTurnAt: num(firstDefined([c.lastTurnAt, c.last_turn_at]), 0),
        limits: {
          maxSessions: num(firstDefined([limits.maxSessions, limits.max_sessions]), 100) || 100,
          maxFileBytes: num(firstDefined([limits.maxFileBytes, limits.max_file_bytes]), 2 * 1024 * 1024) || 2 * 1024 * 1024,
        },
      };
    }

    /** R12：自动蒸馏状态（旧宿主缺字段时给安全默认）。 */
    function normalizeAutoDistill(raw) {
      const a = asObject(raw);
      const last = firstDefined([a.lastResult, a.last_result]);
      const lastObj = last && typeof last === "object" ? asObject(last) : null;
      const remaining = firstDefined([a.remaining]);
      return {
        enabled: bool(a.enabled),
        every: num(a.every, 20) || 20,
        minTurns: num(firstDefined([a.minTurns, a.min_turns]), 0),
        importToMemories: bool(firstDefined([a.importToMemories, a.import_to_memories])),
        source: str(a.source) || "capture",
        sinceLastRun: num(firstDefined([a.sinceLastRun, a.since_last_run]), 0),
        remaining: remaining === undefined || remaining === null ? -1 : num(remaining, 0),
        due: bool(a.due),
        lastRunAt: num(firstDefined([a.lastRunAt, a.last_run_at]), 0),
        lastDistillId: str(firstDefined([a.lastDistillId, a.last_distill_id])),
        lastResult: lastObj
          ? {
              distillId: str(firstDefined([lastObj.distillId, lastObj.distill_id])),
              before: num(lastObj.before, 0),
              after: num(lastObj.after, 0),
              skipped: str(lastObj.skipped),
              at: num(lastObj.at, 0),
            }
          : null,
      };
    }

    async function autoDistillStatus() {
      return api.action("autoDistill.status", {});
    }

    async function updateAutoDistill(patch) {
      return api.action("autoDistill.update", asObject(patch));
    }

    async function runAutoDistillNow(options) {
      return api.action("autoDistill.runNow", asObject(options));
    }

    /** R12：inject.preview 的权威裁决信息归一化。 */
    function normalizeInjectAuthority(raw) {
      const r = asObject(raw);
      const hidden = asObject(firstDefined([r.authorityHidden, r.authority_hidden]));
      return {
        mode: str(firstDefined([r.authorityMode, r.authority_mode])),
        hidden: {
          memories: num(firstDefined([hidden.memories]), 0),
          docs: num(firstDefined([hidden.docs]), 0),
        },
        conflicts: asArray(firstDefined([r.authorityConflicts, r.authority_conflicts])).map((item) => {
          const c = asObject(item);
          return {
            memoryId: str(firstDefined([c.memoryId, c.memory_id])),
            memoryText: str(firstDefined([c.memoryText, c.memory_text])),
            docKey: str(firstDefined([c.docKey, c.doc_key])),
            docPath: str(firstDefined([c.docPath, c.doc_path])),
            winner: str(c.winner),
            reason: str(c.reason),
          };
        }),
      };
    }

    function authorityModeLabel(mode) {
      const key = str(mode);
      if (key === "user_first") return "用户优先";
      if (key === "doc_first") return "文档优先";
      if (key === "memory_first") return "记忆优先";
      return key;
    }

    /** R13：画像条目总数（五组 + 经验），用于复核概览「画像 N 条」。 */
    function profileEntryCount(profile) {
      const p = asObject(profile);
      let count = asArray(p.experiences).length;
      for (const group of PROFILE_GROUPS) count += asArray(p[group.key]).length;
      return count;
    }

    /** R13：PII 复核 stage 预览归一化。 */
    function normalizeStagePreview(raw) {
      const r = asObject(raw);
      const preview = asObject(firstDefined([r.preview]));
      const text = Object.keys(preview).length > 0 ? preview : r;
      return {
        stageId: str(firstDefined([r.stageId, r.stage_id])),
        profile: normalizeProfile(text.profile),
        redacted: asArray(firstDefined([text.redacted])).map((item) => {
          const entry = asObject(item);
          return { label: str(entry.label), count: num(entry.count, 0) };
        }),
        redactions: asArray(firstDefined([text.redactions])).map((item) => {
          const entry = asObject(item);
          return {
            index: num(entry.index, 0),
            field: str(entry.field),
            itemIndex: num(firstDefined([entry.itemIndex, entry.item_index]), 0),
            label: str(entry.label),
            original: str(entry.original),
            masked: str(entry.masked),
          };
        }),
        dropped: asArray(firstDefined([text.dropped])).map((item) => {
          const entry = asObject(item);
          return {
            field: str(entry.field),
            itemIndex: num(firstDefined([entry.itemIndex, entry.item_index]), 0),
            text: str(entry.text),
          };
        }),
      };
    }

    async function stageDistill(distillation, source) {
      return api.action("distill.stage", { distillation: str(distillation), source: str(source) || "capture" });
    }

    async function listDistillReviews() {
      return api.action("distill.review.list", {});
    }

    async function applyDistillReview(payload) {
      const p = asObject(payload);
      return api.action("distill.review.apply", {
        stageId: str(firstDefined([p.stageId, p.stage_id])),
        restore: asArray(p.restore).map((value) => num(value, 0)),
        keepDropped: asArray(firstDefined([p.keepDropped, p.keep_dropped])).map((value) => num(value, 0)),
        importToMemories: p.importToMemories === true,
        scope: str(p.scope) || "global",
      });
    }

    async function discardDistillReview(stageId) {
      return api.action("distill.review.discard", { stageId: str(stageId) });
    }

    /** R13：复核写入后的提示。 */
    function reviewApplyNotice(result) {
      const r = asObject(result);
      return (
        "已保存画像 " +
        (str(r.id) || "—") +
        "（还原 " +
        num(r.restored, 0) +
        " 处、恢复 " +
        num(r.keptBack, 0) +
        " 条、写入记忆 " +
        num(r.imported, 0) +
        "）"
      );
    }

    /** R13：经验可达性 benchmark。 */
    function normalizeBenchmark(raw) {
      const b = asObject(raw);
      const baseline = firstDefined([b.baseline]);
      return {
        topK: num(firstDefined([b.topK, b.top_k]), 5),
        total: num(b.total, 0),
        hits: num(b.hits, 0),
        hitRate: num(firstDefined([b.hitRate, b.hit_rate]), 0),
        avgRank: num(firstDefined([b.avgRank, b.avg_rank]), 0),
        misses: asArray(b.misses).map((item) => {
          const miss = asObject(item);
          return { prompt: str(miss.prompt), rank: num(miss.rank, 0) };
        }),
        baseline:
          baseline && typeof baseline === "object"
            ? {
                hitRate: num(firstDefined([asObject(baseline).hitRate, asObject(baseline).hit_rate]), 0),
                hits: num(asObject(baseline).hits, 0),
                total: num(asObject(baseline).total, 0),
              }
            : null,
        improvement: num(b.improvement, 0),
      };
    }

    async function qualityBenchmark(topK, scope) {
      return api.action("quality.benchmark", { topK: num(topK, 5) || 5, scope: str(scope) || "all" });
    }

    /** R15：数据备份 / 恢复 / 诊断包 / 样例包。 */
    function normalizeBackup(raw) {
      const b = asObject(raw);
      const counts = asObject(b.counts);
      return {
        name: str(b.name),
        path: str(b.path),
        createdAt: num(firstDefined([b.createdAt, b.created_at]), 0),
        note: str(b.note),
        counts: {
          memories: num(counts.memories, 0),
          documents: num(counts.documents, 0),
          chunks: num(counts.chunks, 0),
          packs: num(counts.packs, 0),
          distillations: num(counts.distillations, 0),
        },
        bytes: num(b.bytes, 0),
        valid: b.valid !== false,
      };
    }

    function normalizeBackups(raw) {
      const r = asObject(raw);
      return { root: str(r.root), backups: asArray(r.backups).map(normalizeBackup) };
    }

    async function backupCreate(note) {
      return api.action("backup.create", { note: str(note) });
    }

    async function backupListAll() {
      return api.action("backup.list", {});
    }

    async function backupRestore(target) {
      const t = asObject(target);
      return api.action("backup.restore", str(t.path) ? { path: str(t.path) } : { name: str(t.name) });
    }

    async function diagnosticsExport() {
      return api.action("diagnostics.export", {});
    }

    async function importSamplePack() {
      return api.action("pack.importSample", {});
    }

    const SAMPLE_IMPORT_NOTICE = "样例包已导入：6 条记忆 + 4 条经验，可到偏好/待确认查看";

    function backupSummary(backups) {
      const list = asArray(backups);
      if (list.length === 0) return "还没有备份";
      const latest = list[0];
      return (
        "上次备份：" +
        formatShortTimestamp(latest.createdAt) +
        "（" +
        num(latest.counts.memories, 0) +
        " 条记忆 / " +
        num(latest.counts.documents, 0) +
        " 文档）"
      );
    }

    function normalizeDistillation(raw) {
      if (raw === null || raw === undefined) return null;
      const d = asObject(raw);
      if (Object.keys(d).length === 0) return null;
      return {
        id: str(d.id),
        createdAt: num(firstDefined([d.createdAt, d.created_at]), 0),
        turns: num(d.turns, 0),
        confidence: num(d.confidence, 0),
        source: str(d.source),
        memoryCount: num(firstDefined([d.memoryCount, d.memory_count]), 0),
        profile: normalizeProfile(d.profile),
      };
    }

    // ------------------------------------------------------------------
    // 数据规整（容错 camelCase / snake_case）
    // ------------------------------------------------------------------

    function normalizeMemory(raw) {
      const m = asObject(raw);
      return {
        id: str(m.id),
        category: str(m.category) || "fuzzy",
        layer: str(m.layer) || "strategy",
        content: str(m.content),
        structured: m.structured !== undefined ? m.structured : null,
        confidence: num(firstDefined([m.confidence]), 0.6),
        authority: str(m.authority) || "inferred",
        sourceType: str(firstDefined([m.sourceType, m.source_type])),
        sourceRef: str(firstDefined([m.sourceRef, m.source_ref])),
        createdAt: num(firstDefined([m.createdAt, m.created_at]), 0),
        lastVerifiedAt: num(firstDefined([m.lastVerifiedAt, m.last_verified_at]), 0),
        lastAccessedAt: num(firstDefined([m.lastAccessedAt, m.last_accessed_at]), 0),
        accessCount: num(firstDefined([m.accessCount, m.access_count]), 0),
        validFrom: num(firstDefined([m.validFrom, m.valid_from]), 0),
        validTo: num(firstDefined([m.validTo, m.valid_to]), 0),
        expiresAt: num(firstDefined([m.expiresAt, m.expires_at]), 0),
        frozen: bool(m.frozen),
        causalParent: str(firstDefined([m.causalParent, m.causal_parent])),
        status: str(m.status) || "active",
        supersededBy: str(firstDefined([m.supersededBy, m.superseded_by])),
        scope: str(m.scope) || "global",
        tags: asArray(m.tags).map((tag) => str(tag)).filter(Boolean),
        packId: str(firstDefined([m.packId, m.pack_id])),
        packVersion: str(firstDefined([m.packVersion, m.pack_version])),
        sourceDoc: str(firstDefined([m.sourceDoc, m.source_doc])),
        docConflict: str(firstDefined([m.docConflict, m.doc_conflict])),
      };
    }

    function normalizeDocument(raw) {
      const d = asObject(raw);
      return {
        id: str(d.id),
        filePath: str(firstDefined([d.filePath, d.file_path])),
        relativePath: str(firstDefined([d.relativePath, d.relative_path])),
        rootPath: str(firstDefined([d.rootPath, d.root_path])),
        project: str(d.project),
        fileType: str(firstDefined([d.fileType, d.file_type])),
        lastModified: num(firstDefined([d.lastModified, d.last_modified]), 0),
        lastIndexed: num(firstDefined([d.lastIndexed, d.last_indexed]), 0),
        chunkCount: num(firstDefined([d.chunkCount, d.chunk_count]), 0),
        sizeBytes: num(firstDefined([d.sizeBytes, d.size_bytes]), 0),
        status: str(d.status) || "active",
        errorMessage: str(firstDefined([d.errorMessage, d.error_message])),
      };
    }

    function normalizeRoot(raw) {
      const r = asObject(raw);
      return {
        path: str(r.path),
        fileCount: num(firstDefined([r.fileCount, r.file_count]), 0),
        addedAt: num(firstDefined([r.addedAt, r.added_at]), 0),
        lastScanAt: num(firstDefined([r.lastScanAt, r.last_scan_at]), 0),
      };
    }

    function normalizePack(raw) {
      const p = asObject(raw);
      return {
        id: str(p.id),
        packId: str(firstDefined([p.packId, p.pack_id])),
        packVersion: str(firstDefined([p.packVersion, p.pack_version])),
        packName: str(firstDefined([p.packName, p.pack_name])),
        author: str(p.author),
        installedAt: num(firstDefined([p.installedAt, p.installed_at]), 0),
        updatedAt: num(firstDefined([p.updatedAt, p.updated_at]), 0),
        memoryCount: num(firstDefined([p.memoryCount, p.memory_count]), 0),
        status: str(p.status) || "active",
        source: str(p.source),
        localPath: str(firstDefined([p.localPath, p.local_path])),
        scope: str(p.scope) || "global",
      };
    }

    /**
     * 文档 ↔ 记忆关联（契约 §10.3）：a/b 两侧可能已经由宿主展开好文本，
     * 这里统一成面板渲染需要的扁平行。
     */
    function normalizeLink(raw) {
      const l = asObject(raw);
      const memory = asObject(l.memory);
      const document = asObject(l.document);
      return {
        id: str(l.id),
        docId: str(firstDefined([l.docId, l.doc_id, document.id])),
        chunkId: str(firstDefined([l.chunkId, l.chunk_id])),
        memoryId: str(firstDefined([l.memoryId, l.memory_id, memory.id])),
        relation: str(l.relation) || "unrelated",
        detectedBy: str(firstDefined([l.detectedBy, l.detected_by])),
        detectedAt: num(firstDefined([l.detectedAt, l.detected_at]), 0),
        resolved: bool(l.resolved),
        filePath: str(firstDefined([l.filePath, l.file_path, document.filePath, document.file_path])),
        relativePath: str(firstDefined([l.relativePath, l.relative_path, document.relativePath, document.relative_path])),
        headingPath: str(firstDefined([l.headingPath, l.heading_path])),
        memoryContent: str(firstDefined([l.memoryContent, l.memory_content, memory.content])),
        memoryCategory: str(firstDefined([l.memoryCategory, l.memory_category, memory.category])),
        memoryStatus: str(firstDefined([l.memoryStatus, l.memory_status, memory.status])),
      };
    }

    /** 记忆包更新记录（契约 §10.5）。 */
    function normalizePackUpdate(raw) {
      const u = asObject(raw);
      return {
        packId: str(firstDefined([u.packId, u.pack_id])),
        packName: str(firstDefined([u.packName, u.pack_name])),
        currentVersion: str(firstDefined([u.currentVersion, u.current_version])),
        latestVersion: str(firstDefined([u.latestVersion, u.latest_version])),
        available: bool(u.available),
        source: str(u.source),
        note: str(u.note),
      };
    }

    function normalizeStats(raw) {
      const s = asObject(raw);
      const byCategory = asObject(firstDefined([s.byCategory, s.by_category]));
      const counts = {};
      for (const category of CATEGORIES) {
        counts[category.key] = num(byCategory[category.key], 0);
      }
      return {
        memories: num(s.memories, 0),
        active: num(s.active, 0),
        pendingConfirm: num(firstDefined([s.pendingConfirm, s.pending_confirm]), 0),
        conflicts: num(s.conflicts, 0),
        documents: num(s.documents, 0),
        chunks: num(s.chunks, 0),
        packs: num(s.packs, 0),
        roots: num(s.roots, 0),
        byCategory: counts,
      };
    }

    function memorySide(memory) {
      const meta = CATEGORY_BY_KEY.get(memory.category);
      return {
        id: memory.id,
        content: memory.content,
        category: memory.category,
        categoryLabel: meta ? meta.label : memory.category,
        scope: memory.scope,
        authority: memory.authority,
        confidence: memory.confidence,
        createdAt: memory.createdAt,
        sourceType: memory.sourceType,
        packId: memory.packId,
        isDoc: false,
        isPack: false,
      };
    }

    /** R11：冲突来源分组（老宿主没有 group 时按「用户记忆」兜底）。 */
    function conflictGroupOf(conflict) {
      const group = asObject(conflict && conflict.group);
      const key = str(group.key) || "user";
      let label = str(group.label);
      if (!label) {
        if (key.indexOf("distill:") === 0) label = "蒸馏导入";
        else if (key.indexOf("pack:") === 0) label = "记忆包导入";
        else label = "用户记忆";
      }
      return { key: key, label: label };
    }

    /** 组内小字：保留前缀 + id 前 8 位（user 原样）。 */
    function conflictSourceLabel(key) {
      const value = str(key) || "user";
      const at = value.indexOf(":");
      if (at < 0) return value;
      return value.slice(0, at + 1) + value.slice(at + 1, at + 9);
    }

    function isImportedSide(side) {
      if (!side) return false;
      if (side.isDoc === true || side.isPack === true) return true;
      const sourceType = str(side.sourceType);
      return sourceType === "distill" || sourceType === "pack" || sourceType === "imported" || str(side.packId) !== "";
    }

    /**
     * R11：批量裁决的 winner 计算。
     * mode="local" 保留本地（导入端输），mode="imported" 采用新内容（导入端赢）；
     * 两端同质（都不是导入端 / 都是导入端）时降级为 dismiss，不冒险。
     */
    function conflictBatchResolution(conflict, mode) {
      const aImported = isImportedSide(conflict && conflict.a);
      const bImported = isImportedSide(conflict && conflict.b);
      if (mode === "local") {
        if (aImported && !bImported) return "winner_b";
        if (bImported && !aImported) return "winner_a";
        return "dismiss";
      }
      if (aImported && !bImported) return "winner_a";
      if (bImported && !aImported) return "winner_b";
      return "dismiss";
    }

    /** R11：逐条调用 conflict.resolve（批量裁决用；返回成功/失败计数）。 */
    async function resolveConflictsSequentially(entries, reason) {
      let ok = 0;
      let failed = 0;
      for (const entry of asArray(entries)) {
        try {
          await api.action("conflict.resolve", {
            id: str(entry && entry.id),
            resolution: str(entry && entry.resolution) || "dismiss",
            reason: str(reason) || "批量裁决",
          });
          ok += 1;
        } catch (error) {
          failed += 1;
        }
      }
      return { ok: ok, failed: failed };
    }

    /** R11：近似重复对。 */
    function normalizeDuplicateSide(raw) {
      const side = asObject(raw);
      return {
        id: str(side.id),
        content: str(side.content),
        category: str(side.category),
        scope: str(side.scope),
        authority: str(side.authority),
        confidence: num(side.confidence, 0),
        createdAt: num(firstDefined([side.createdAt, side.created_at]), 0),
      };
    }

    function normalizeDuplicatePair(raw, index) {
      const pair = asObject(raw);
      return {
        key: str(pair.key) || str(pair.a && pair.a.id) + ":" + str(pair.b && pair.b.id) || "pair-" + index,
        a: normalizeDuplicateSide(pair.a),
        b: normalizeDuplicateSide(pair.b),
        similarity: num(pair.similarity, 0),
      };
    }

    function normalizeDuplicates(raw) {
      const d = asObject(raw);
      return {
        minScore: num(firstDefined([d.minScore, d.min_score]), 0.85),
        total: num(d.total, 0),
        pairs: asArray(d.pairs).map(normalizeDuplicatePair),
      };
    }

    async function qualityDuplicates() {
      return api.action("quality.duplicates", {});
    }

    async function mergeMemories(keepId, dropId, reason) {
      return api.action("memory.merge", {
        keepId: str(keepId),
        dropId: str(dropId),
        reason: str(reason) || "面板合并近似重复",
      });
    }

    function normalizeConflict(raw, memoryById, documentById) {
      const c = asObject(raw);
      const sideFrom = (value) => {
        if (value && typeof value === "object") return memorySide(normalizeMemory(value));
        const id = str(value);
        if (!id) return { id: "", content: "（内容缺失）", category: "", categoryLabel: "", scope: "", isDoc: false, isPack: false };
        if (id.indexOf("doc:") === 0) {
          const docId = id.slice(4);
          const document = documentById.get(docId);
          const path = document ? document.filePath : docId;
          return {
            id: id,
            content: "📄 " + (path || "（文档已不存在）"),
            category: "",
            categoryLabel: "文档",
            scope: document ? document.project : "",
            isDoc: true,
            isPack: false,
            docPath: path,
          };
        }
        if (id.indexOf("pack:") === 0) {
          return {
            id: id,
            content: "📦 记忆包 " + id.slice(5),
            category: "",
            categoryLabel: "记忆包",
            scope: "",
            isDoc: false,
            isPack: true,
          };
        }
        const found = memoryById.get(id);
        if (found) return memorySide(found);
        return { id: id, content: "（记忆 " + id + " 已不存在）", category: "", categoryLabel: "", scope: "", isDoc: false, isPack: false };
      };
      const resolved = bool(c.resolved);
      // 新内核的 listConflicts 会附带 a / b 两条 Memory（对端是 doc:<id> 时为 null），
      // 优先用它们；老形态退回 memoryA / memoryB 里的字符串引用。
      const objectSide = (value) => (value && typeof value === "object" ? memorySide(normalizeMemory(value)) : null);
      const aSide = objectSide(c.a) || sideFrom(firstDefined([c.memoryA, c.memory_a]));
      const bSide = objectSide(c.b) || sideFrom(firstDefined([c.memoryB, c.memory_b]));
      return {
        id: str(c.id),
        a: aSide,
        b: bSide,
        group: conflictGroupOf({ group: firstDefined([c.group, c.groupInfo]) }),
        conflictType: str(firstDefined([c.conflictType, c.conflict_type])) || "contradiction",
        severity: str(c.severity),
        detectedAt: num(firstDefined([c.detectedAt, c.detected_at]), 0),
        detectedBy: str(firstDefined([c.detectedBy, c.detected_by])),
        resolved: resolved,
        resolution: str(c.resolution),
        reason: str(firstDefined([c.resolutionReason, c.resolution_reason, c.reason])),
      };
    }

    function emptyPanelState() {
      return {
        ok: true,
        version: "",
        scope: "all",
        dataDir: "",
        stats: normalizeStats({}),
        memories: [],
        conflicts: [],
        documents: [],
        links: [],
        roots: [],
        packs: [],
        stale: [],
        scopes: [],
        capture: normalizeCapture(null),
        distillation: null,
        autoDistill: normalizeAutoDistill(null),
        dshSessions: 0,
      };
    }

    function normalizeState(raw) {
      const s = asObject(raw);
      const memories = asArray(s.memories).map(normalizeMemory);
      const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
      const documents = asArray(s.documents).map(normalizeDocument);
      const documentById = new Map(documents.map((document) => [document.id, document]));
      const stale = asArray(s.stale).map(normalizeMemory);
      return {
        ok: s.ok !== false,
        version: str(s.version),
        scope: str(s.scope) || "all",
        dataDir: str(s.dataDir !== undefined ? s.dataDir : s.data_dir),
        stats: normalizeStats(firstDefined([s.stats])),
        memories: memories,
        conflicts: asArray(s.conflicts).map((conflict) => normalizeConflict(conflict, memoryById, documentById)),
        documents: documents,
        // 契约 §10.4：老宿主没有 links 字段时按空数组渲染，不报错。
        links: asArray(s.links).map(normalizeLink),
        roots: asArray(s.roots).map(normalizeRoot),
        packs: asArray(s.packs).map(normalizePack),
        stale: stale,
        scopes: asArray(s.scopes).map(str).filter(Boolean),
        // R5：会话捕获状态与最近一次蒸馏画像（旧宿主没有这两个字段时给安全默认值）。
        capture: normalizeCapture(s.capture),
        distillation: normalizeDistillation(s.distillation),
        // R12：自动蒸馏状态（旧宿主缺失时 enabled=false / every=20 / remaining=—）
        autoDistill: normalizeAutoDistill(s.autoDistill !== undefined ? s.autoDistill : s.auto_distill),
        // R6：检测到的 DSH 历史会话数量（旧宿主缺失时为 0）。
        dshSessions: num(firstDefined([s.dshSessions, s.dsh_sessions]), 0),
      };
    }

    /** SSR / 测试可注入的顶栏搜索状态。 */
    function normalizeSearchState(raw) {
      const s = asObject(raw);
      return {
        query: str(s.query),
        loading: bool(s.loading),
        error: str(s.error),
        memories: asArray(s.memories).map(normalizeMemory),
        documents: asArray(s.documents).map(normalizeDocument),
        elapsed: num(s.elapsed, 0),
      };
    }

    /**
     * scope 下拉选项：全部(all，服务端默认) / global / 数据里出现过的 project: 作用域
     * （宿主没有暴露当前会话工作区时，拿不到就只剩 all + global）。
     */
    function buildScopeOptions(data) {
      const found = new Set(["all", "global"]);
      const add = (value) => {
        const text = str(value).trim();
        if (text) found.add(text);
      };
      add(data.scope);
      for (const memory of data.memories) add(memory.scope);
      for (const scope of data.scopes) add(scope);
      const list = Array.from(found);
      const rank = (value) => (value === "all" ? 0 : value === "global" ? 1 : 2);
      list.sort((left, right) => {
        const diff = rank(left) - rank(right);
        if (diff !== 0) return diff;
        return left.localeCompare(right);
      });
      return list;
    }

    // ------------------------------------------------------------------
    // 基础展示件
    // ------------------------------------------------------------------

    function MirrorIcon(props) {
      const owner = props || {};
      const size = typeof owner.size === "number" && owner.size > 0 ? owner.size : 16;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
          focusable: "false",
          display: "block",
        },
        h("path", {
          d: "M8 1.4 14.6 8 8 14.6 1.4 8Z",
          stroke: "currentColor",
          strokeWidth: 1.35,
          strokeLinejoin: "round",
        }),
        h("circle", { cx: 8, cy: 8, r: 2.45, stroke: "currentColor", strokeWidth: 1.1, opacity: 0.85 }),
        h("path", { d: "M8 8 5.6 5.6", stroke: "currentColor", strokeWidth: 1.1, strokeLinecap: "round", opacity: 0.85 })
      );
    }

    function button(label, onClick, options) {
      const opts = options || {};
      const classes = ["mrp-btn"];
      if (opts.primary) classes.push("mrp-btn-primary");
      if (opts.danger) classes.push("mrp-btn-danger");
      if (opts.subtle) classes.push("mrp-btn-subtle");
      if (opts.dimmed) classes.push("mrp-btn-dimmed");
      if (opts.className) classes.push(opts.className);
      return h(
        "button",
        {
          key: opts.key,
          type: opts.submit ? "submit" : "button",
          className: classes.join(" "),
          onClick: opts.submit ? undefined : onClick,
          disabled: opts.disabled === true,
          title: opts.title,
          "aria-label": opts.ariaLabel,
        },
        label
      );
    }

    function badge(text, tone, title) {
      // key 取文案：同一张卡片里徽章文案互不相同，省掉每个调用点传参（React 列表 key 警告）。
      return h("span", { className: "mrp-badge", "data-tone": tone || "neutral", title: title, key: "badge-" + text }, text);
    }

    function field(labelText, control, hint) {
      return h(
        "label",
        { className: "mrp-field", key: labelText },
        h("span", { className: "mrp-field-label" }, labelText),
        control,
        hint ? h("span", { className: "mrp-field-hint" }, hint) : null
      );
    }

    function sectionHead(title, actions, count) {
      const children = [h("div", { className: "mrp-section-title", key: "title" }, title)];
      if (count !== undefined && count !== null) {
        children.push(h("span", { className: "mrp-section-count", key: "count" }, String(count)));
      }
      if (actions) children.push(h("div", { className: "mrp-section-actions", key: "actions" }, actions));
      return h("div", { className: "mrp-section-head" }, children);
    }

    /** 统一空态：图标 + 一句话 + 可选主操作。 */
    function emptyState(title, hint, action, icon) {
      return h(
        "div",
        { className: "mrp-empty" },
        h("div", { className: "mrp-empty-icon", "aria-hidden": "true" }, icon || "◇"),
        h("div", { className: "mrp-empty-title" }, title),
        hint ? h("div", { className: "mrp-empty-hint" }, hint) : null,
        action ? h("div", { className: "mrp-empty-action" }, action) : null
      );
    }

    function skeleton() {
      return h(
        "div",
        { className: "mrp-skeleton", role: "status", "aria-label": "正在读取 Mirror 数据" },
        h("div", { className: "mrp-skeleton-hint" }, "正在读取 Mirror 数据…"),
        h("div", { className: "mrp-skeleton-row" }),
        h("div", { className: "mrp-skeleton-row" }),
        h("div", { className: "mrp-skeleton-row mrp-skeleton-short" }),
        h("div", { className: "mrp-skeleton-row" }),
        h("div", { className: "mrp-skeleton-row mrp-skeleton-short" })
      );
    }

    function banner(text, tone, onClose, extra) {
      return h(
        "div",
        { className: "mrp-banner", "data-tone": tone || "error", role: tone === "error" ? "alert" : "status" },
        h("span", { className: "mrp-banner-text" }, text),
        extra || null,
        onClose
          ? h(
              "button",
              { type: "button", className: "mrp-banner-close", onClick: onClose, title: "关闭", "aria-label": "关闭" },
              "×"
            )
          : null
      );
    }

    function tabCount(key, data) {
      if (key === "documents") return num(data.stats.documents, data.documents.length);
      if (key === "packs") return num(data.stats.packs, data.packs.length);
      if (key === "pending") {
        const open = data.conflicts.filter((conflict) => !conflict.resolved).length;
        return num(data.stats.pendingConfirm ? data.stats.pendingConfirm : open, open);
      }
      if (key === "inject") return null;
      // R14：偏好 Tab 聚合 偏好/决策/模糊 三个筛选，Tab 计数取三者之和。
      if (key === "preference") {
        const listed = data.memories.filter((memory) => PREFERENCE_FILTERS.some((item) => item.key === memory.category)).length;
        const statsTotal = PREFERENCE_FILTERS.reduce((sum, item) => sum + num(data.stats.byCategory[item.key], 0), 0);
        return statsTotal > 0 ? statsTotal : listed;
      }
      const listed = data.memories.filter((memory) => memory.category === key).length;
      const direct = data.stats.byCategory[key];
      // stats.byCategory 只统计 active；list 也只返回 active，两者应一致。
      // 差异只可能来自 bounds（stats 覆盖全库、memories 被 limit 截断），此时取有值的一侧。
      if (typeof direct === "number" && direct > 0) return direct;
      return listed;
    }

    // ------------------------------------------------------------------
    // 主面板
    // ------------------------------------------------------------------

    function Panel(props) {
      const owner = props || {};
      // SSR / 测试可以注入首屏数据；首次渲染后不再重算（浏览器里恒为 null）。
      const initial = useMemo(() => (owner.initialData ? normalizeState(owner.initialData) : null), []);

      const [state, setState] = useState(initial);
      const [loading, setLoading] = useState(initial ? false : true);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [scope, setScope] = useState(initial ? initial.scope : "all");
      const [tab, setTab] = useState(typeof owner.initialTab === "string" ? owner.initialTab : "iron_rule");
      // R14：偏好 Tab 内的筛选（偏好/决策/模糊）
      const [preferenceFilter, setPreferenceFilter] = useState(str(owner.initialFilter) || "preference");
      const [busy, setBusy] = useState({});
      const [selected, setSelected] = useState(() => new Set(asArray(owner.initialSelection).map(str).filter(Boolean)));
      const [lastUpdated, setLastUpdated] = useState(num(owner.initialLastUpdated, 0));
      const [highlightId, setHighlightId] = useState(str(owner.initialHighlightId));
      const [focusDocId, setFocusDocId] = useState(str(owner.initialOpenDocId));
      const [search, setSearch] = useState(owner.initialSearch ? normalizeSearchState(owner.initialSearch) : null);
      const [searchDraft, setSearchDraft] = useState(owner.initialSearch ? str(owner.initialSearch.query) : "");
      const [bulkExportOpen, setBulkExportOpen] = useState(false);
      const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
      const [bulkExportMeta, setBulkExportMeta] = useState({ name: "", version: "1.0.0", author: "", description: "" });
      // R4 D：每次页面会话只出现一次的一句话引导。
      const [introOpen, setIntroOpen] = useState(!introDismissed);
      // R15：首启引导（无记忆且无画像时出现，可关闭；导入样例/打开捕获后会因数据变化自动消失）
      const [guideDismissed, setGuideDismissed] = useState(owner.initialGuideDismissed === true);
      // R15：「去蒸馏」跳转后高亮/滚动到「记录 → 蒸馏」卡
      const [recordFocus, setRecordFocus] = useState(false);
      const mounted = useRef(false);
      // 批量动作的同步防重入（state 更新是异步的，双击可能进两次）。
      const bulkBusyRef = useRef({});
      // 快速切换 scope 时，丢弃比最新请求更早返回的响应。
      const requestSeq = useRef(0);

      const refresh = useCallback(
        async (options) => {
          const opts = options || {};
          const target = opts.scope || scope;
          const seq = requestSeq.current + 1;
          requestSeq.current = seq;
          if (opts.silent === true) {
            /* 静默刷新：保留旧数据，不清空骨架 */
          } else {
            setLoading(true);
          }
          setError(null);
          try {
            const data = await api.getState({ scope: target });
            if (seq !== requestSeq.current) return false;
            setState(normalizeState(data));
            setLastUpdated(Date.now());
            return true;
          } catch (refreshError) {
            if (seq !== requestSeq.current) return false;
            setError(describeError(refreshError));
            return false;
          } finally {
            if (seq === requestSeq.current) setLoading(false);
          }
        },
        [scope]
      );

      useEffect(() => {
        if (!mounted.current) {
          mounted.current = true;
          // 首屏已有注入数据（测试 / SSR）时跳过重复拉取
          if (initial) return;
        }
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [refresh]);

      // 从搜索结果跳过来的记忆：滚动到可视区并高亮 4 秒。
      useEffect(() => {
        if (!highlightId) return undefined;
        if (typeof document !== "undefined" && typeof document.querySelector === "function") {
          const node = document.querySelector('[data-memory-id="' + highlightId + '"]');
          if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
        }
        const timer = setTimeout(() => setHighlightId(""), 4000);
        return () => clearTimeout(timer);
      }, [highlightId]);

      // R4 C：切 Tab 时把当前 tab 滚进视野（窄列里 10 个 Tab 会滚出可见区），键盘切换时焦点跟随。
      useEffect(() => {
        if (typeof document === "undefined" || typeof document.querySelector !== "function") return;
        const node = document.querySelector('[data-tab-key="' + tab + '"]');
        if (!node) return;
        if (typeof node.scrollIntoView === "function") node.scrollIntoView({ inline: "nearest", block: "nearest" });
        const active = document.activeElement;
        if (active && typeof active.getAttribute === "function" && active.getAttribute("role") === "tab" && typeof node.focus === "function") {
          node.focus();
        }
      }, [tab]);

      const act = useCallback(
        async (type, payload, options) => {
          const opts = options || {};
          const key = opts.key || type;
          setBusy((prev) => {
            const next = Object.assign({}, prev);
            next[key] = true;
            return next;
          });
          setError(null);
          try {
            const result = await api.action(type, payload);
            if (opts.silent !== true) await refresh({ silent: true });
            return result;
          } catch (actionError) {
            setError(describeError(actionError));
            return null;
          } finally {
            setBusy((prev) => {
              const next = Object.assign({}, prev);
              delete next[key];
              return next;
            });
          }
        },
        [refresh]
      );

      const notify = useCallback((message, tone) => {
        if (!message) {
          setNotice(null);
          return;
        }
        setNotice({ text: String(message), tone: tone || "ok" });
      }, []);

      const toggleSelect = useCallback((id) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);

      /** 顶栏全局搜索：GET /search?q=&limit=12。 */
      const runSearch = useCallback(
        async (rawQuery) => {
          const query = str(rawQuery).trim();
          if (!query) {
            setSearch(null);
            return;
          }
          setSearch({ query: query, loading: true, error: "", memories: [], documents: [], elapsed: 0 });
          try {
            const result = await searchAll(query, scope);
            setSearch({ query: query, loading: false, error: "", memories: result.memories, documents: result.documents, elapsed: result.elapsed });
          } catch (searchError) {
            setSearch({ query: query, loading: false, error: describeError(searchError), memories: [], documents: [], elapsed: 0 });
          }
        },
        [scope]
      );

      function onSearchKeyDown(event) {
        const key = event && event.key;
        if (key === "Escape") {
          if (typeof event.preventDefault === "function") event.preventDefault();
          setSearch(null);
          setSearchDraft("");
          return;
        }
        if (key === "Enter") {
          if (typeof event.preventDefault === "function") event.preventDefault();
          void runSearch(searchDraft);
        }
      }

      function jumpToMemory(memory) {
        // R14：模糊/决策已并入偏好 Tab 的三个筛选。
        if (memory.category === "fuzzy" || memory.category === "decision") {
          setTab("preference");
          setPreferenceFilter(memory.category);
        } else {
          setTab(CATEGORY_BY_KEY.has(memory.category) ? memory.category : "iron_rule");
        }
        setHighlightId(memory.id);
        setSearch(null);
        setSearchDraft("");
      }

      function jumpToDocument(document) {
        setTab("documents");
        setFocusDocId(document.id);
        setSearch(null);
        setSearchDraft("");
      }

      /** R15：首启引导三个动作。 */
      async function guideOpenCapture() {
        const result = await act("capture.update", { enabled: true }, { key: "capture.update" });
        if (result) notify("会话捕获已打开：聊几轮后再回来蒸馏。");
      }

      async function guideImportSample() {
        const result = await act("pack.importSample", {}, { key: "pack.importSample" });
        if (result) notify(SAMPLE_IMPORT_NOTICE);
      }

      function guideGoDistill() {
        setTab("packs");
        setRecordFocus(true);
      }

      /** 批量冻结：逐条 memory.freeze，最后一次刷新收口。 */
      async function bulkFreeze() {
        if (bulkBusyRef.current["bulk.freeze"] === true) return;
        bulkBusyRef.current["bulk.freeze"] = true;
        setBusy((prev) => Object.assign({}, prev, { "bulk.freeze": true }));
        try {
          const ids = Array.from(selected);
          let done = 0;
          for (const id of ids) {
            const result = await act("memory.freeze", { id: id, frozen: true }, { key: "memory.freeze:" + id, silent: true });
            if (result) done += 1;
          }
          await refresh({ silent: true });
          if (done > 0) notify("已冻结 " + done + " 条记忆。");
        } finally {
          delete bulkBusyRef.current["bulk.freeze"];
          setBusy((prev) => {
            const next = Object.assign({}, prev);
            delete next["bulk.freeze"];
            return next;
          });
        }
      }

      /** 批量删除：走与单卡一致的 memory.delete（硬删，不可撤销）。 */
      async function bulkDelete() {
        if (bulkBusyRef.current["bulk.delete"] === true) return;
        bulkBusyRef.current["bulk.delete"] = true;
        setBusy((prev) => Object.assign({}, prev, { "bulk.delete": true }));
        try {
          const ids = Array.from(selected);
          let done = 0;
          for (const id of ids) {
            const result = await act("memory.delete", { id: id }, { key: "memory.delete:" + id, silent: true });
            if (result) done += 1;
          }
          setBulkDeleteConfirm(false);
          setSelected(new Set());
          await refresh({ silent: true });
          if (done > 0) notify("已删除 " + done + " 条记忆（含索引与文档关联）。");
        } finally {
          delete bulkBusyRef.current["bulk.delete"];
          setBusy((prev) => {
            const next = Object.assign({}, prev);
            delete next["bulk.delete"];
            return next;
          });
        }
      }

      async function submitBulkExport(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const ids = Array.from(selected);
        if (ids.length === 0) {
          notify("先勾选要打包的记忆。", "error");
          return;
        }
        if (!str(bulkExportMeta.name).trim()) {
          notify("请填写记忆包名称。", "error");
          return;
        }
        setBusy((prev) => Object.assign({}, prev, { "pack.export": true }));
        setError(null);
        try {
          const result = await exportMemories(ids, bulkExportMeta);
          await refresh({ silent: true });
          setBulkExportOpen(false);
          notify("已导出记忆包：" + (str(result && result.path) || "（服务端未返回路径）"));
        } catch (exportError) {
          setError(describeError(exportError));
        } finally {
          setBusy((prev) => {
            const next = Object.assign({}, prev);
            delete next["pack.export"];
            return next;
          });
        }
      }

      const data = state || emptyPanelState();
      const stats = data.stats;
      const scopes = useMemo(() => buildScopeOptions(data), [data]);
      const staleIds = useMemo(() => new Set(data.stale.map((memory) => memory.id)), [data]);
      const isBusy = (key) => busy[key] === true;

      const shared = {
        busy: busy,
        isBusy: isBusy,
        act: act,
        notify: notify,
        refresh: refresh,
        scope: scope,
        selected: selected,
        toggleSelect: toggleSelect,
        staleIds: staleIds,
        scopes: scopes,
      };

      function renderSearchPop() {
        const current = search;
        const hitCount = current.memories.length + current.documents.length;
        const groups = [];
        if (current.memories.length > 0) {
          groups.push(
            h(
              "div",
              { className: "mrp-search-group", key: "memories" },
              h("div", { className: "mrp-search-group-head" }, "记忆 " + current.memories.length),
              current.memories.slice(0, 6).map((memory) =>
                h(
                  "button",
                  { type: "button", className: "mrp-search-item", key: "m-" + memory.id, onClick: () => jumpToMemory(memory) },
                  h("span", { className: "mrp-search-item-main" }, truncate(memory.content || "（内容缺失）", 70)),
                  h("span", { className: "mrp-search-item-meta" }, categoryLabel(memory.category))
                )
              )
            )
          );
        }
        if (current.documents.length > 0) {
          groups.push(
            h(
              "div",
              { className: "mrp-search-group", key: "documents" },
              h("div", { className: "mrp-search-group-head" }, "文档 " + current.documents.length),
              current.documents.slice(0, 6).map((document) =>
                h(
                  "button",
                  { type: "button", className: "mrp-search-item", key: "d-" + document.id, onClick: () => jumpToDocument(document) },
                  h("span", { className: "mrp-search-item-main" }, truncate(document.relativePath || document.filePath || "（路径缺失）", 70)),
                  h("span", { className: "mrp-search-item-meta" }, document.chunkCount + " 切片")
                )
              )
            )
          );
        }
        return h(
          "div",
          { className: "mrp-search-pop", role: "dialog", "aria-label": "搜索结果" },
          current.loading
            ? h("div", { className: "mrp-search-status" }, "搜索中…")
            : current.error
              ? h("div", { className: "mrp-search-status", "data-tone": "error" }, current.error)
              : hitCount === 0
                ? h("div", { className: "mrp-search-status" }, "没有找到「" + current.query + "」相关的记忆或文档")
                : groups,
          current.loading
            ? null
            : h(
                "div",
                { className: "mrp-search-foot" },
                hitCount === 0 ? "" : hitCount + " 条命中" + (current.elapsed > 0 ? " · 用时 " + current.elapsed + " ms" : "") + " · ",
                "Esc 关闭"
              )
        );
      }

      function renderBulkExportForm() {
        return h(
          "form",
          { className: "mrp-bulk-export", onSubmit: submitBulkExport },
          field(
            "名称",
            h("input", {
              className: "mrp-input",
              value: bulkExportMeta.name,
              placeholder: "记忆包名称",
              onChange: (event) => setBulkExportMeta(Object.assign({}, bulkExportMeta, { name: event.target.value })),
            })
          ),
          field(
            "版本",
            h("input", {
              className: "mrp-input mrp-input-narrow",
              value: bulkExportMeta.version,
              onChange: (event) => setBulkExportMeta(Object.assign({}, bulkExportMeta, { version: event.target.value })),
            })
          ),
          field(
            "作者",
            h("input", {
              className: "mrp-input mrp-input-narrow",
              value: bulkExportMeta.author,
              onChange: (event) => setBulkExportMeta(Object.assign({}, bulkExportMeta, { author: event.target.value })),
            })
          ),
          field(
            "描述",
            h("input", {
              className: "mrp-input mrp-input-grow",
              value: bulkExportMeta.description,
              placeholder: "一句话说明",
              onChange: (event) => setBulkExportMeta(Object.assign({}, bulkExportMeta, { description: event.target.value })),
            })
          ),
          button(isBusy("pack.export") ? "导出中…" : "导出 " + selected.size + " 条", null, {
            primary: true,
            submit: true,
            disabled: isBusy("pack.export"),
          }),
          button("取消", () => setBulkExportOpen(false), { subtle: true })
        );
      }

      function renderSelectionBar() {
        const count = selected.size;
        if (count === 0) return null;
        const actions = bulkDeleteConfirm
          ? [
              h("span", { className: "mrp-selection-warn", key: "warn" }, "确认删除这 " + count + " 条？不可撤销"),
              button("确认删除", () => void bulkDelete(), { danger: true, key: "bulk-delete-ok" }),
              button("取消", () => setBulkDeleteConfirm(false), { subtle: true, key: "bulk-delete-cancel" }),
            ]
          : [
              button(bulkExportOpen ? "收起导出" : "打包导出", () => setBulkExportOpen((open) => !open), { primary: true, key: "bulk-export" }),
              button("冻结", () => void bulkFreeze(), { subtle: true, key: "bulk-freeze" }),
              button("删除", () => setBulkDeleteConfirm(true), { subtle: true, danger: true, key: "bulk-delete" }),
              button(
                "清空",
                () => {
                  setSelected(new Set());
                  setBulkDeleteConfirm(false);
                  setBulkExportOpen(false);
                },
                { subtle: true, key: "bulk-clear" }
              ),
            ];
        return h(
          "div",
          { className: "mrp-selection-bar", role: "region", "aria-label": "批量操作" },
          h("span", { className: "mrp-selection-count" }, "已选 " + count),
          actions,
          bulkExportOpen && !bulkDeleteConfirm ? renderBulkExportForm() : null
        );
      }

      function renderHeader() {
        // R14：顶栏统计 chips 已移除（与 Tab 计数/红点重复），搜索框占满右侧空间。
        return h(
          "header",
          { className: "mrp-header" },
          h(
            "div",
            { className: "mrp-topbar" },
            h(
              "div",
              { className: "mrp-brand" },
              h("span", { className: "mrp-brand-icon", "aria-hidden": "true" }, h(MirrorIcon, { size: 18 })),
              h("span", { className: "mrp-brand-name" }, "Mirror"),
              h("span", { className: "mrp-brand-sub" }, COPY.subtitle)
            ),
            h(
              "div",
              { className: "mrp-search" },
              h("input", {
                className: "mrp-search-input",
                type: "search",
                value: searchDraft,
                placeholder: "搜索记忆与文档（Enter）",
                "aria-label": "搜索记忆与文档",
                spellCheck: false,
                autoComplete: "off",
                onChange: (event) => setSearchDraft(str(event.target.value)),
                onKeyDown: onSearchKeyDown,
              }),
              search ? renderSearchPop() : null
            ),
            h(
              "div",
              { className: "mrp-topbar-actions" },
              h(
                "select",
                {
                  className: "mrp-select mrp-select-scope",
                  value: scope,
                  title: "作用域决定哪些记忆会进入注入与面板列表",
                  "aria-label": "作用域",
                  onChange: (event) => {
                    const next = event && event.target ? str(event.target.value) : "all";
                    setScope(next || "all");
                  },
                },
                scopes.map((item) => h("option", { key: item, value: item }, scopeLabel(item)))
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "mrp-icon-btn",
                  onClick: () => {
                    void refresh();
                  },
                  disabled: loading,
                  title: "刷新（重新读取 /mirror/api/state）",
                  "aria-label": "刷新",
                },
                loading ? "…" : "⟳"
              ),
              lastUpdated
                ? h("span", { className: "mrp-updated", title: "最近一次成功读取 /mirror/api/state 的时间" }, "最后更新 " + formatClock(lastUpdated))
                : null
            )
          )
        );
      }

      function renderTabs() {
        const pendingCount = data.conflicts.filter((conflict) => !conflict.resolved).length || num(stats.pendingConfirm, 0);
        return h(
          "div",
          { className: "mrp-tabs-wrap" },
          h(
            "nav",
            { className: "mrp-tabs", role: "tablist", "aria-label": "Mirror 分区", "data-scroll": "true" },
            TABS.map((item) => {
              const count = tabCount(item.key, data);
              const isPending = item.key === "pending";
              const active = tab === item.key;
              return h(
                "button",
                {
                  key: item.key,
                  type: "button",
                  role: "tab",
                  "aria-selected": active ? "true" : "false",
                  "data-active": active ? "true" : "false",
                  "data-tab-key": item.key,
                  tabIndex: active ? 0 : -1,
                  className: "mrp-tab",
                  onClick: () => setTab(item.key),
                  onKeyDown: (event) => {
                    const key = event && event.key;
                    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
                    if (typeof event.preventDefault === "function") event.preventDefault();
                    setTab(moveTab(item.key, key));
                  },
                },
                item.label,
                isPending
                  ? pendingCount > 0
                    ? h("span", {
                        className: "mrp-tab-dot",
                        title: pendingCount + " 条待确认",
                        "aria-label": pendingCount + " 条待确认",
                      })
                    : null
                  : count !== null && count > 0
                    ? h("span", { className: "mrp-tab-count" }, String(count))
                    : null
              );
            })
          ),
          h("span", { className: "mrp-tabs-fade mrp-tabs-fade-l", "aria-hidden": "true" }),
          h("span", { className: "mrp-tabs-fade mrp-tabs-fade-r", "aria-hidden": "true" })
        );
      }

      function renderContent() {
        if (!state && loading) return skeleton();
        if (tab === "preference") {
          return h(
            MemoryTab,
            Object.assign({}, shared, {
              key: "preference",
              category: "preference",
              filters: PREFERENCE_FILTERS,
              initialFilter: preferenceFilter,
              memories: data.memories.filter((memory) => PREFERENCE_FILTERS.some((item) => item.key === memory.category)),
              highlightId: highlightId,
              initialOnlyInferred: owner.initialOnlyInferred,
            })
          );
        }
        if (tab === "iron_rule" || tab === "pitfall") {
          return h(
            MemoryTab,
            Object.assign({}, shared, {
              key: "mem-" + tab,
              category: tab,
              filters: [],
              memories: data.memories.filter((memory) => memory.category === tab),
              highlightId: highlightId,
              initialOnlyInferred: owner.initialOnlyInferred,
            })
          );
        }
        if (tab === "documents") {
          return h(
            "div",
            { className: "mrp-stack" },
            h(
              DocumentsTab,
              Object.assign({}, shared, {
                key: "documents",
                documents: data.documents,
                roots: data.roots,
                focusDocId: focusDocId,
                initialOpenDocId: str(owner.initialOpenDocId),
                initialDocumentDetails: owner.initialDocumentDetails,
              })
            ),
            h(
              LinksTab,
              Object.assign({}, shared, {
                key: "links",
                links: data.links,
                initialOpen: owner.initialLinksOpen === true,
              })
            )
          );
        }
        if (tab === "packs") {
          return h(
            PacksTab,
            Object.assign({}, shared, {
              key: "packs",
              packs: data.packs,
              memories: data.memories,
              capture: data.capture,
              distillation: data.distillation,
              autoDistill: data.autoDistill,
              dshSessions: data.dshSessions,
              // SSR / 测试可注入更新检查结果；浏览器里由 PacksTab 自己拉一次。
              initialPackUpdates: owner.initialPackUpdates,
              // SSR / 测试可注入捕获会话列表与删除确认态。
              initialCapturedSessions: owner.initialCapturedSessions,
              initialCaptureOpen: owner.initialCaptureOpen,
              initialDropConfirmId: owner.initialDropConfirmId,
              // SSR / 测试可注入蒸馏数据源与来源列表。
              initialDistillSource: owner.initialDistillSource,
              initialDistillSources: owner.initialDistillSources,
              initialShowSources: owner.initialShowSources,
              initialPrepareSessions: owner.initialPrepareSessions,
              initialPromptOpen: owner.initialPromptOpen,
              initialPromptText: owner.initialPromptText,
              // R7：蒸馏导入作用域 / 捕获清空确认
              initialApplyOpen: owner.initialApplyOpen,
              initialImportToMemories: owner.initialImportToMemories,
              initialDistillScope: owner.initialDistillScope,
              initialClearConfirm: owner.initialClearConfirm,
              // R8：导出是否带画像（SSR/测试可注入）
              initialIncludeProfile: owner.initialIncludeProfile,
              // R9：导入拦截提示（SSR/测试可注入）
              initialImportBlocked: owner.initialImportBlocked,
              // R10：撤销二次确认（SSR/测试可注入）
              initialUndoConfirm: owner.initialUndoConfirm,
              // R13：PII 复核预览（SSR/测试可注入）
              initialStagePreview: owner.initialStagePreview,
              initialRestore: owner.initialRestore,
              initialKeepDropped: owner.initialKeepDropped,
              // R14：高级（导入/导出）折叠状态
              initialAdvancedOpen: owner.initialAdvancedOpen,
              // R15：首启引导「去蒸馏」跳转高亮
              highlightRecord: recordFocus,
            })
          );
        }
        if (tab === "pending") {
          return h(
            PendingTab,
            Object.assign({}, shared, {
              key: "pending",
              conflicts: data.conflicts,
              stale: data.stale,
              // R10：SSR/测试可注入质量体检报告
              initialQuality: owner.initialQuality,
              // R11：批量裁决 / 近似重复（SSR/测试可注入）
              initialBatchConfirm: owner.initialBatchConfirm,
              initialDuplicates: owner.initialDuplicates,
              initialDuplicatesOpen: owner.initialDuplicatesOpen,
              initialDuplicatesError: owner.initialDuplicatesError,
              initialDuplicateConfirm: owner.initialDuplicateConfirm,
              // R13：经验可达性（SSR/测试可注入）
              initialBenchmark: owner.initialBenchmark,
              initialBenchmarkOpen: owner.initialBenchmarkOpen,
              initialBenchmarkError: owner.initialBenchmarkError,
              // R15：备份 / 诊断（SSR/测试可注入）
              initialBackups: owner.initialBackups,
              initialBackupOpen: owner.initialBackupOpen,
              initialBackupError: owner.initialBackupError,
              initialRestoreConfirm: owner.initialRestoreConfirm,
              initialDiagnosticsPath: owner.initialDiagnosticsPath,
            })
          );
        }
        if (tab === "inject") {
          return h(InjectTab, Object.assign({}, shared, { key: "inject", initialPreview: owner.initialInjectPreview }));
        }
        return null;
      }

      return h(
        "div",
        { className: "mrp-root", "data-mirror-panel": PANEL_ID },
        renderHeader(),
        renderSelectionBar(),
        renderTabs(),
        h(
          "div",
          { className: "mrp-body" },
          h("datalist", { id: "mrp-scope-options" }, scopes.map((item) => h("option", { key: item, value: item }))),
          state !== null && !guideDismissed && asArray(state.memories).length === 0 && !state.distillation
            ? h(
                "div",
                { className: "mrp-firstrun", role: "note", "aria-label": "首启引导" },
                h("span", { className: "mrp-firstrun-icon", "aria-hidden": "true" }, "🚀"),
                h(
                  "span",
                  { className: "mrp-firstrun-text" },
                  "三步开始：① 打开会话捕获 ② 聊几轮后蒸馏 ③ 看注入预览"
                ),
                h(
                  "div",
                  { className: "mrp-firstrun-actions" },
                  button("打开捕获", () => void guideOpenCapture(), {
                    subtle: true,
                    key: "guide-capture",
                    disabled: isBusy("capture.update"),
                  }),
                  button("导入样例包", () => void guideImportSample(), {
                    subtle: true,
                    key: "guide-sample",
                    disabled: isBusy("pack.importSample"),
                  }),
                  button("去蒸馏", () => guideGoDistill(), { subtle: true, key: "guide-distill" })
                ),
                button("×", () => setGuideDismissed(true), {
                  subtle: true,
                  key: "guide-dismiss",
                  title: "关闭引导（本会话不再出现）",
                  ariaLabel: "关闭首启引导",
                })
              )
            : null,
          introOpen
            ? h(
                "div",
                { className: "mrp-intro", role: "note", "aria-label": "Mirror 使用提示" },
                h("span", { className: "mrp-intro-icon", "aria-hidden": "true" }, "💡"),
                h(
                  "span",
                  { className: "mrp-intro-text" },
                  "Mirror 记住你的判断依据（偏好/铁律/踩坑），并把相关文档带进每轮对话。左侧栏图标随时打开。"
                ),
                button(
                  "知道了",
                  () => {
                    introDismissed = true;
                    setIntroOpen(false);
                  },
                  { subtle: true, key: "intro-dismiss" }
                )
              )
            : null,
          error
            ? banner(error, "error", () => setError(null), [
                h(
                  "button",
                  { type: "button", className: "mrp-banner-retry", key: "retry", onClick: () => void refresh() },
                  "重试"
                ),
              ])
            : null,
          notice
            ? banner(notice.text, notice.tone === "error" ? "error" : notice.tone === "warn" ? "warn" : "ok", () => setNotice(null))
            : null,
          renderContent()
        )
      );
    }

    // ------------------------------------------------------------------
    // 记忆 Tab（五类共用）
    // ------------------------------------------------------------------

    function MemoryTab(props) {
      const filters = asArray(props.filters);
      const initialFilter = str(props.initialFilter);
      const category = initialFilter || str(props.category);
      const memories = asArray(props.memories);
      const notify = props.notify;
      const act = props.act;
      const isBusy = props.isBusy;

      const [activeFilter, setActiveFilter] = useState(
        filters.some((item) => item.key === category) ? category : filters.length > 0 ? filters[0].key : category
      );
      const [creating, setCreating] = useState(false);
      const [onlyInferred, setOnlyInferred] = useState(props.initialOnlyInferred === true);
      const [draft, setDraft] = useState({
        content: "",
        category: activeFilter,
        scope: "global",
        tags: "",
      });

      const meta = CATEGORY_BY_KEY.get(activeFilter) || CATEGORIES[0];
      const filterMemories = memories.filter((memory) => memory.category === activeFilter);

      useEffect(() => {
        if (initialFilter && initialFilter !== activeFilter && filters.some((item) => item.key === initialFilter)) {
          setActiveFilter(initialFilter);
        }
      }, [initialFilter]);

      function openCreate() {
        setDraft({ content: "", category: activeFilter, scope: "global", tags: "" });
        setCreating(true);
      }

      async function submitCreate(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const content = str(draft.content).trim();
        if (!content) {
          notify("内容不能为空。", "error");
          return;
        }
        const result = await act(
          "memory.create",
          {
            content: content,
            category: draft.category,
            scope: str(draft.scope).trim() || "global",
            tags: splitTags(draft.tags),
          },
          { key: "memory.create" }
        );
        if (!result) return;
        if (result.duplicate === true) {
          notify("这条内容与已有记忆重复，未重复写入。", "warn");
        } else if (asArray(result.conflicts).length > 0) {
          notify("已新增，并检测到 " + asArray(result.conflicts).length + " 条冲突，去「待确认」裁决。", "warn");
        } else {
          notify("已新增一条" + (CATEGORY_BY_KEY.get(str(result.memory && result.memory.category)) || meta).label + "记忆。");
        }
        setCreating(false);
        setDraft({ content: "", category: activeFilter, scope: draft.scope, tags: "" });
      }

      function renderCreateForm() {
        return h(
          "form",
          { className: "mrp-form mrp-create", onSubmit: submitCreate, key: "create" },
          h("textarea", {
            className: "mrp-textarea mrp-autogrow",
            rows: autoRows(draft.content, 2, 8),
            value: draft.content,
            placeholder: "写一条「判断依据」：约束、偏好、决策理由或踩过的坑。不要写路径/账号/版本号——那些属于文档库。",
            "aria-label": "记忆内容",
            onChange: (event) => setDraft(Object.assign({}, draft, { content: event.target.value })),
            onKeyDown: (event) => {
              if (event && event.key === "Escape") {
                setCreating(false);
              } else if (event && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                if (typeof event.preventDefault === "function") event.preventDefault();
                void submitCreate();
              }
            },
          }),
          h(
            "div",
            { className: "mrp-form-row" },
            field(
              "分类",
              h(
                "select",
                {
                  className: "mrp-select",
                  value: draft.category,
                  onChange: (event) => setDraft(Object.assign({}, draft, { category: event.target.value })),
                },
                CATEGORIES.map((item) => h("option", { key: item.key, value: item.key }, item.emoji + " " + item.label))
              )
            ),
            field(
              "作用域",
              h("input", {
                className: "mrp-input",
                value: draft.scope,
                list: "mrp-scope-options",
                spellCheck: false,
                onChange: (event) => setDraft(Object.assign({}, draft, { scope: event.target.value })),
              })
            ),
            field(
              "标签",
              h("input", {
                className: "mrp-input",
                value: draft.tags,
                placeholder: "用逗号分隔，如 nextjs, archi",
                spellCheck: false,
                onChange: (event) => setDraft(Object.assign({}, draft, { tags: event.target.value })),
              })
            )
          ),
          h(
            "div",
            { className: "mrp-form-actions" },
            button(isBusy("memory.create") ? "保存中…" : "保存记忆", null, { primary: true, submit: true, disabled: isBusy("memory.create") }),
            button("取消", () => setCreating(false), { subtle: true })
          )
        );
      }

      const inferredCount = filterMemories.filter((memory) => memory.authority === "inferred").length;
      const visibleMemories = onlyInferred
        ? filterMemories.filter((memory) => memory.authority === "inferred")
        : filterMemories;
      const filterRow =
        filters.length > 1
          ? h(
              "div",
              { className: "mrp-filter-row" },
              filters.map((item) => {
                const count = memories.filter((memory) => memory.category === item.key).length;
                return h(
                  "button",
                  {
                    key: item.key,
                    type: "button",
                    className: "mrp-filter-chip" + (activeFilter === item.key ? " mrp-filter-chip-active" : ""),
                    "aria-pressed": activeFilter === item.key ? "true" : "false",
                    onClick: () => setActiveFilter(item.key),
                  },
                  item.label + " " + count
                );
              })
            )
          : null;

      return h(
        "section",
        { className: "mrp-section" },
        sectionHead(
          h("span", { className: "mrp-title-with-dot" }, h("span", { className: "mrp-dot", "data-tone": meta.tone }), meta.label + "（" + filterMemories.length + "）"),
          [
            h(
              "button",
              {
                key: "inferred-filter",
                type: "button",
                className: "mrp-filter-chip" + (onlyInferred ? " mrp-filter-chip-active" : ""),
                "aria-pressed": onlyInferred ? "true" : "false",
                title: "只显示 AI 推断（蒸馏/自动抽取）的记忆，方便逐条确认",
                onClick: () => setOnlyInferred((value) => !value),
              },
              "只看 AI 推断" + (inferredCount > 0 ? "（" + inferredCount + "）" : "")
            ),
            button(creating ? "取消新增" : "+ 新增", () => (creating ? setCreating(false) : openCreate()), {
              primary: true,
              key: "create-toggle",
            }),
          ]
        ),
        filterRow,
        h("p", { className: "mrp-section-hint" }, meta.hint),
        creating ? renderCreateForm() : null,
        visibleMemories.length === 0
          ? onlyInferred
            ? h("p", { className: "mrp-hint" }, "当前分类没有 AI 推断的记忆；关掉「只看 AI 推断」查看全部。")
            : emptyState(
                "还没有" + meta.label + "记忆",
                "点右上角「+ 新增」把一条判断依据记下来；也可以在对话里直接说「记住：…」，宿主会调用 mirror_remember。",
                null,
                meta.emoji
              )
          : h(
              "div",
              { className: "mrp-list" },
              visibleMemories.map((memory) =>
                h(
                  MemoryCard,
                  Object.assign({}, props, {
                    key: memory.id || memory.content,
                    memory: memory,
                    selected: props.selected.has(memory.id),
                    onToggleSelect: props.toggleSelect,
                  })
                )
              )
            )
      );
    }

    function MemoryCard(props) {
      const memory = props.memory;
      const act = props.act;
      const notify = props.notify;
      const isBusy = props.isBusy;
      const meta = CATEGORY_BY_KEY.get(memory.category) || CATEGORIES[4];
      // R9：经验条目用结构化字段展示（默认折叠视图），编辑态仍编辑 content。
      const experience = isExperienceStructured(memory.structured) ? normalizeExperience(memory.structured) : null;

      const [editing, setEditing] = useState(false);
      const [confirming, setConfirming] = useState(false);
      const [draft, setDraft] = useState(null);

      const keyOf = (action) => "memory." + action + ":" + memory.id;
      const pending = (action) => isBusy(keyOf(action));

      function startEdit() {
        setDraft({
          content: memory.content,
          category: memory.category,
          scope: memory.scope,
          tags: memory.tags.join(", "),
        });
        setEditing(true);
        setConfirming(false);
      }

      async function saveEdit() {
        if (!draft) return;
        const content = str(draft.content).trim();
        if (!content) {
          notify("内容不能为空。", "error");
          return;
        }
        const result = await act(
          "memory.update",
          {
            id: memory.id,
            patch: {
              content: content,
              category: draft.category,
              scope: str(draft.scope).trim() || memory.scope,
              tags: splitTags(draft.tags),
            },
          },
          { key: keyOf("update") }
        );
        if (result) {
          setEditing(false);
          setDraft(null);
          notify("已保存修改。");
        }
      }

      async function runAction(action, payload, message) {
        const result = await act("memory." + action, Object.assign({ id: memory.id }, payload || {}), {
          key: keyOf(action),
        });
        if (result) notify(message);
        return result;
      }

      function renderEditForm() {
        return h(
          "div",
          { className: "mrp-form mrp-card-form" },
          h("textarea", {
            className: "mrp-textarea mrp-autogrow",
            rows: autoRows(draft.content, 2, 8),
            value: draft.content,
            "aria-label": "编辑记忆内容",
            onChange: (event) => setDraft(Object.assign({}, draft, { content: event.target.value })),
            onKeyDown: (event) => {
              if (event && event.key === "Escape") {
                setEditing(false);
                setDraft(null);
              } else if (event && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                if (typeof event.preventDefault === "function") event.preventDefault();
                void saveEdit();
              }
            },
          }),
          h(
            "div",
            { className: "mrp-form-row" },
            field(
              "分类",
              h(
                "select",
                {
                  className: "mrp-select",
                  value: draft.category,
                  onChange: (event) => setDraft(Object.assign({}, draft, { category: event.target.value })),
                },
                CATEGORIES.map((item) => h("option", { key: item.key, value: item.key }, item.emoji + " " + item.label))
              )
            ),
            field(
              "作用域",
              h("input", {
                className: "mrp-input",
                value: draft.scope,
                list: "mrp-scope-options",
                spellCheck: false,
                onChange: (event) => setDraft(Object.assign({}, draft, { scope: event.target.value })),
              })
            ),
            field(
              "标签",
              h("input", {
                className: "mrp-input",
                value: draft.tags,
                placeholder: "用逗号分隔",
                spellCheck: false,
                onChange: (event) => setDraft(Object.assign({}, draft, { tags: event.target.value })),
              })
            )
          ),
          h(
            "div",
            { className: "mrp-form-actions" },
            button(pending("update") ? "保存中…" : "保存修改", saveEdit, { primary: true, disabled: pending("update") }),
            button(
              "取消",
              () => {
                setEditing(false);
                setDraft(null);
              },
              { subtle: true }
            )
          )
        );
      }

      const metaItems = [
        h("span", { className: "mrp-meta-item mrp-meta-cat", key: "cat" }, [
          h("span", { className: "mrp-dot", "data-tone": meta.tone, key: "dot" }),
          meta.label,
        ]),
        h(
          "span",
          { className: "mrp-meta-item", key: "source", title: memory.sourceType || "来源" },
          "来源：" + (memory.sourceRef || memory.sourceType || "手动记录")
        ),
        memory.sourceType === "distill"
          ? h(
              "span",
              { className: "mrp-meta-item", key: "distill" },
              badge("蒸馏", "brand", "来自蒸馏" + (memory.sourceRef ? "（" + memory.sourceRef + "）" : ""))
            )
          : null,
        h("span", { className: "mrp-meta-item", key: "confidence" }, "置信度 " + formatConfidence(memory.confidence)),
        h(
          "span",
          { className: "mrp-meta-item", key: "authority" },
          badge(
            authorityLabel(memory.authority),
            AUTHORITY_TONE[memory.authority] || "neutral",
            AUTHORITY_TITLE[memory.authority] || "权威来源"
          )
        ),
        h(
          "span",
          { className: "mrp-meta-item", key: "time", title: formatTimestamp(memory.createdAt) },
          formatShortTimestamp(memory.createdAt)
        ),
        h("span", { className: "mrp-meta-item mrp-mono", key: "scope" }, memory.scope),
        memory.tags.length
          ? h(
              "span",
              { className: "mrp-meta-item", key: "tags" },
              memory.tags.slice(0, 4).map((tag) => h("span", { className: "mrp-tag", key: "tag-" + tag }, "#" + tag))
            )
          : null,
        memory.packId
          ? h("span", { className: "mrp-meta-item mrp-mono", key: "pack" }, "包 v" + (memory.packVersion || memory.packId))
          : null,
      ];

      const badges = [];
      if (experience) badges.push(badge("🧭 经验", "brand", "经验条目：情境 → 做法（带边界）"));
      if (memory.frozen) badges.push(badge("冻结", "business", "冻结后不参与陈旧的自动判定"));
      if (memory.status && memory.status !== "active") {
        badges.push(badge(memoryStatusLabel(memory.status), memory.status === "superseded" ? "warn" : "neutral"));
      }
      if (props.staleIds && props.staleIds.has(memory.id)) {
        badges.push(badge("待复核", "warn", "超过 90 天未验证：确认仍有效或标记失效"));
      }
      if (memory.packId) badges.push(badge("包", "neutral", "来自记忆包 " + memory.packId));

      const cardClass = "mrp-card" + (props.highlightId && props.highlightId === memory.id ? " mrp-card-highlight" : "");

      return h(
        "article",
        { className: cardClass, "data-category": memory.category, "data-status": memory.status, "data-memory-id": memory.id },
        h(
          "div",
          { className: "mrp-card-top" },
          h(
            "label",
            { className: "mrp-card-check", title: "选中后可批量冻结 / 删除 / 打包导出" },
            h("input", {
              type: "checkbox",
              checked: props.selected === true,
              "aria-label": experience
                ? "选择经验条目：" + truncate(experience.trigger + " → " + experience.action, 40)
                : "选择记忆：" + truncate(memory.content || memory.id, 30),
              onChange: () => props.onToggleSelect && props.onToggleSelect(memory.id),
            })
          ),
          h(
            "div",
            { className: "mrp-card-main" },
            experience
              ? h(
                  "div",
                  { className: "mrp-exp" },
                  h(
                    "div",
                    { className: "mrp-exp-row" },
                    h("span", { className: "mrp-exp-label" }, "情境"),
                    h("span", { className: "mrp-exp-text" }, experience.trigger || "（未填写）")
                  ),
                  h(
                    "div",
                    { className: "mrp-exp-row" },
                    h("span", { className: "mrp-exp-label" }, "做法"),
                    h("span", { className: "mrp-exp-text" }, experience.action || "（未填写）")
                  ),
                  experience.why
                    ? h(
                        "div",
                        { className: "mrp-exp-row" },
                        h("span", { className: "mrp-exp-label" }, "理由"),
                        h("span", { className: "mrp-exp-why" }, experience.why)
                      )
                    : null,
                  h(
                    "div",
                    { className: "mrp-exp-row" },
                    h("span", { className: "mrp-exp-label" }, "边界"),
                    h("span", { className: "mrp-exp-boundary" }, experience.boundary || "—")
                  ),
                  experience.evidence
                    ? h(
                        "div",
                        { className: "mrp-exp-row" },
                        h("span", { className: "mrp-exp-label" }, "证据"),
                        h("span", { className: "mrp-exp-evidence" }, experience.evidence)
                      )
                    : null
                )
              : h("div", { className: "mrp-content mrp-clamp3" }, memory.content || "（内容缺失）"),
            h("div", { className: "mrp-meta" }, metaItems)
          ),
          badges.length ? h("div", { className: "mrp-card-badges" }, badges) : null
        ),
        editing ? renderEditForm() : null,
        confirming
          ? h(
              "div",
              { className: "mrp-confirm" },
              h("span", { className: "mrp-confirm-text" }, "确认彻底删除这条记忆？索引与文档关联会一并清理，无法撤销。"),
              button(pending("delete") ? "删除中…" : "确认删除", () =>
                runAction("delete", {}, "已彻底删除这条记忆（含索引与文档关联）。").then((result) => {
                  if (result) setConfirming(false);
                }), {
                danger: true,
                disabled: pending("delete"),
                key: "confirm-delete",
              }),
              button("取消", () => setConfirming(false), { subtle: true, key: "cancel-delete" })
            )
          : null,
        h(
          "div",
          { className: "mrp-card-actions", role: "group", "aria-label": "记忆操作" },
          editing ? null : button("编辑", startEdit, { subtle: true, key: "edit" }),
          button("确认", () => runAction("confirm", {}, "已确认这条记忆（authority=user_confirmed，置信度≥0.9）。"), {
            subtle: true,
            disabled: pending("confirm"),
            key: "confirm",
          }),
          button(
            memory.frozen ? "解冻" : "冻结",
            () =>
              runAction(
                "freeze",
                { frozen: !memory.frozen },
                memory.frozen ? "已解冻，重新参与陈旧判定。" : "已冻结，不再参与陈旧自动判定。"
              ),
            { subtle: true, disabled: pending("freeze"), key: "freeze" }
          ),
          button("失效", () => runAction("invalidate", {}, "已标记失效（validTo=now），审计记录保留。"), {
            subtle: true,
            disabled: pending("invalidate"),
            key: "invalidate",
          }),
          button("删除", () => setConfirming(true), { subtle: true, dimmed: true, disabled: pending("delete"), key: "delete" })
        )
      );
    }

    // ------------------------------------------------------------------
    // 文档库 Tab
    // ------------------------------------------------------------------

    function DocumentsTab(props) {
      const documents = asArray(props.documents);
      const roots = asArray(props.roots);
      const act = props.act;
      const notify = props.notify;
      const isBusy = props.isBusy;

      const [rootPath, setRootPath] = useState("");
      const [filter, setFilter] = useState("");
      const [query, setQuery] = useState("");
      const [results, setResults] = useState(null);
      const [searching, setSearching] = useState(false);
      const [searchElapsed, setSearchElapsed] = useState(0);
      const [searchError, setSearchError] = useState(null);
      const [openChunk, setOpenChunk] = useState(null);
      // 文档行展开：详情懒加载（GET /mirror/api/document/:id），每篇只拉一次。
      const [openId, setOpenId] = useState(() => str(props.initialOpenDocId));
      const [details, setDetails] = useState(() => asObject(props.initialDocumentDetails));
      const [detailLoading, setDetailLoading] = useState("");
      const [detailErrors, setDetailErrors] = useState({});
      const [expandedAll, setExpandedAll] = useState(() => new Set());

      function idOf(document) {
        return str(document && document.id) || str(document && document.filePath);
      }

      async function loadDocument(document) {
        const id = idOf(document);
        if (!id || details[id] || detailLoading === id) return;
        setDetailLoading(id);
        setDetailErrors((prev) => {
          const next = Object.assign({}, prev);
          delete next[id];
          return next;
        });
        try {
          const detail = await api.getDocument(id);
          setDetails((prev) => Object.assign({}, prev, { [id]: { document: asObject(detail && detail.document), chunks: asArray(detail && detail.chunks) } }));
        } catch (detailError) {
          setDetailErrors((prev) => Object.assign({}, prev, { [id]: describeError(detailError) }));
        } finally {
          setDetailLoading("");
        }
      }

      function toggleDocument(document) {
        const id = idOf(document);
        if (!id) return;
        if (openId === id) {
          setOpenId("");
          return;
        }
        setOpenId(id);
        void loadDocument(document);
      }

      // 顶栏全局搜索点「文档」→ 自动展开该文档并加载切片。
      useEffect(() => {
        const target = str(props.focusDocId);
        if (!target) return;
        const document = documents.find((item) => idOf(item) === target);
        if (!document) return;
        setOpenId(target);
        void loadDocument(document);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [props.focusDocId]);

      // 搜索框停顿 400ms 自动检索（契约 R2 §D）。
      useEffect(() => {
        const keyword = str(query).trim();
        if (!keyword) {
          setResults(null);
          setSearchElapsed(0);
          setSearchError(null);
          return undefined;
        }
        const timer = setTimeout(() => {
          void runSearch();
        }, 400);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [query]);

      const filtered = useMemo(() => {
        const needle = str(filter).trim().toLowerCase();
        if (!needle) return documents;
        return documents.filter((document) => document.filePath.toLowerCase().indexOf(needle) >= 0);
      }, [documents, filter]);

      async function addRoot(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const path = str(rootPath).trim();
        if (!path) {
          notify("请填写要索引的目录（绝对路径）。", "error");
          return;
        }
        const result = await act("doc.addRoot", { path: path }, { key: "doc.addRoot" });
        if (!result) return;
        const scan = asObject(result.scan);
        notify(
          "已添加并扫描：" +
            num(scan.added) +
            " 新增 / " +
            num(scan.updated) +
            " 更新 / " +
            num(scan.skipped) +
            " 跳过" +
            (asArray(scan.errors).length ? " / " + asArray(scan.errors).length + " 个错误" : "")
        );
        setRootPath("");
      }

      async function reindex(target) {
        const payload = target ? { path: target } : {};
        const key = target ? "doc.reindex:" + target : "doc.reindex";
        const result = await act("doc.reindex", payload, { key: key });
        if (!result) return;
        const scan = asObject(result.scan);
        notify(
          "索引完成：" +
            num(scan.added) +
            " 新增 / " +
            num(scan.updated) +
            " 更新 / " +
            num(scan.removed) +
            " 移除 / " +
            num(scan.skipped) +
            " 跳过"
        );
      }

      async function removeRoot(path) {
        const result = await act("doc.removeRoot", { path: path }, { key: "doc.removeRoot:" + path });
        if (result) notify("已移除目录监听：" + path);
      }

      async function runSearch(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const keyword = str(query).trim();
        if (!keyword) {
          setResults([]);
          setSearchElapsed(0);
          setSearchError(null);
          return;
        }
        setSearching(true);
        setSearchError(null);
        const started = Date.now();
        try {
          const result = await api.action("doc.search", { q: keyword, limit: 20 });
          const list = asArray(result.results);
          setResults(list);
          setSearchElapsed(Date.now() - started);
        } catch (searchFailure) {
          setSearchError(describeError(searchFailure));
          setResults([]);
          setSearchElapsed(Date.now() - started);
        } finally {
          setSearching(false);
        }
      }

      function renderRoots() {
        return h(
          "section",
          { className: "mrp-section" },
          sectionHead(
            "📁 索引目录",
            [
              button(isBusy("doc.reindex") ? "索引中…" : "重新索引全部", () => reindex(null), {
                key: "reindex-all",
                disabled: isBusy("doc.reindex"),
              }),
            ],
            roots.length
          ),
          roots.length === 0
            ? emptyState(
                "还没有索引任何目录",
                "填一个项目目录的绝对路径，Mirror 只读不写；node_modules / .git / dist 等会自动跳过。",
                button("添加目录", () => focusById("mrp-add-root-input"), { primary: true }),
                "📁"
              )
            : h(
                "ul",
                { className: "mrp-roots" },
                roots.map((root) =>
                  h(
                    "li",
                    { className: "mrp-root-item", key: root.path },
                    h("span", { className: "mrp-root-path", title: root.path }, root.path),
                    h("span", { className: "mrp-root-count" }, root.fileCount + " 文件"),
                    button(isBusy("doc.reindex:" + root.path) ? "索引中…" : "重新索引", () => reindex(root.path), {
                      subtle: true,
                      disabled: isBusy("doc.reindex:" + root.path),
                      key: "reindex-" + root.path,
                    }),
                    button("移除", () => removeRoot(root.path), {
                      subtle: true,
                      disabled: isBusy("doc.removeRoot:" + root.path),
                      key: "remove-" + root.path,
                    })
                  )
                )
              ),
          h(
            "form",
            { className: "mrp-inline-form", onSubmit: addRoot },
            h("input", {
              id: "mrp-add-root-input",
              className: "mrp-input mrp-input-grow",
              value: rootPath,
              placeholder: "输入要索引的目录，例如 D:\\docs",
              spellCheck: false,
              "aria-label": "要索引的目录",
              onChange: (event) => setRootPath(event.target.value),
            }),
            button(isBusy("doc.addRoot") ? "添加中…" : "添加目录", null, { primary: true, submit: true, disabled: isBusy("doc.addRoot") })
          )
        );
      }

      function renderChunk(chunk, index) {
        const key = str(chunk.id) || "chunk-" + index;
        const heading = str(firstDefined([chunk.headingPath, chunk.heading_path]));
        return h(
          "div",
          { className: "mrp-chunk", key: key },
          h(
            "div",
            { className: "mrp-chunk-head" },
            h("span", { className: "mrp-chunk-heading" }, heading || "切片 " + (index + 1)),
            h("span", { className: "mrp-chunk-index" }, "#" + (index + 1))
          ),
          h("p", { className: "mrp-chunk-text" }, truncate(str(chunk.content), 240))
        );
      }

      function renderDocDetail(document) {
        const id = idOf(document);
        const detail = asObject(details[id]);
        const chunks = asArray(detail.chunks);
        const loading = detailLoading === id;
        const failure = str(detailErrors[id]);
        if (loading) {
          return h("div", { className: "mrp-doc-detail" }, h("p", { className: "mrp-hint" }, "加载切片中…"));
        }
        if (failure) {
          return h("div", { className: "mrp-doc-detail" }, banner(failure, "error", null));
        }
        if (!detail.chunks) {
          return h("div", { className: "mrp-doc-detail" }, h("p", { className: "mrp-hint" }, "展开时按需加载切片。"));
        }
        const showAll = expandedAll.has(id);
        const visible = showAll ? chunks : chunks.slice(0, 3);
        return h(
          "div",
          { className: "mrp-doc-detail" },
          chunks.length === 0
            ? h("p", { className: "mrp-hint" }, "这篇文档还没有切片。")
            : h("div", { className: "mrp-chunks" }, visible.map((chunk, index) => renderChunk(chunk, index))),
          chunks.length > 3
            ? h(
                "div",
                { className: "mrp-doc-detail-foot" },
                button(showAll ? "收起切片" : "查看全部 " + chunks.length + " 个切片", () => {
                  setExpandedAll((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  });
                }, { subtle: true, key: "toggle-all" })
              )
            : null
        );
      }

      function docRow(document) {
        const modified = document.lastModified;
        const needReindex = document.lastIndexed > 0 && modified > 0 && document.lastIndexed < modified;
        const label = document.relativePath || document.filePath;
        const id = idOf(document);
        const open = openId === id;
        return h(
          "div",
          { className: "mrp-doc", key: id || document.filePath, "data-open": open ? "true" : "false" },
          h(
            "button",
            {
              type: "button",
              className: "mrp-doc-head",
              onClick: () => toggleDocument(document),
              "aria-expanded": open ? "true" : "false",
              title: "展开查看切片",
            },
            h("span", { className: "mrp-doc-caret", "aria-hidden": "true" }, open ? "▾" : "▸"),
            h("span", { className: "mrp-doc-path", title: document.filePath }, label || "（路径缺失）"),
            h(
              "span",
              { className: "mrp-doc-meta" },
              document.project ? h("span", { className: "mrp-meta-item", key: "project" }, "项目 " + document.project) : null,
              h("span", { className: "mrp-meta-item", key: "chunks" }, document.chunkCount + " 切片"),
              h("span", { className: "mrp-meta-item", key: "modified" }, "修改 " + formatShortTimestamp(modified))
            ),
            h(
              "span",
              { className: "mrp-doc-badges" },
              badge(
                documentStatusLabel(document.status),
                document.status === "error" ? "error" : document.status === "deleted" ? "warn" : "ok"
              ),
              needReindex ? badge("待重索引", "warn", "文件修改时间晚于上次索引时间") : null
            )
          ),
          document.errorMessage ? h("div", { className: "mrp-doc-error" }, document.errorMessage) : null,
          open ? renderDocDetail(document) : null
        );
      }

      function renderDocuments() {
        return h(
          "section",
          { className: "mrp-section" },
          sectionHead("📄 已索引文档", null, documents.length),
          h("input", {
            className: "mrp-input",
            value: filter,
            placeholder: "按路径过滤…",
            spellCheck: false,
            "aria-label": "按路径过滤文档",
            onChange: (event) => setFilter(event.target.value),
          }),
          documents.length === 0
            ? emptyState("还没有文档", "添加上面的目录后，Markdown 按标题切块、代码按函数/类切块。", null, "📄")
            : h(
                "div",
                { className: "mrp-doc-list" },
                filtered.slice(0, 400).map((document) => docRow(document)),
                filtered.length > 400
                  ? h("p", { className: "mrp-hint" }, "仅显示前 400 条（共 " + filtered.length + " 条），用上面的过滤框缩小范围。")
                  : null
              )
        );
      }

      function renderSearch() {
        return h(
          "section",
          { className: "mrp-section" },
          sectionHead("🔍 搜索文档片段", null, null),
          h(
            "form",
            { className: "mrp-inline-form", onSubmit: runSearch },
            h("input", {
              className: "mrp-input mrp-input-grow",
              value: query,
              placeholder: "输入关键词，停顿 400ms 自动检索",
              spellCheck: false,
              "aria-label": "搜索文档",
              onChange: (event) => setQuery(event.target.value),
            }),
            button(searching ? "搜索中…" : "搜索", null, { primary: true, submit: true, disabled: searching })
          ),
          searchError ? banner(searchError, "error", () => setSearchError(null)) : null,
          results === null
            ? h("p", { className: "mrp-hint" }, "字数 ≥3 走 FTS5 全文索引，1–2 字自动回退 LIKE 匹配；停顿 400ms 自动搜索。")
            : results.length === 0
              ? h("p", { className: "mrp-hint" }, "没有命中任何文档片段，换个更短的关键词试试。")
              : h(
                  "div",
                  { className: "mrp-results-wrap" },
                  h(
                    "p",
                    { className: "mrp-hint mrp-result-count" },
                    results.length + " 命中" + (searchElapsed > 0 ? " · 用时 " + searchElapsed + " ms" : "")
                  ),
                  h(
                    "div",
                    { className: "mrp-results" },
                    results.map((item, index) => {
                    const record = asObject(item);
                    const chunk = asObject(record.chunk);
                    const document = asObject(record.document);
                    const chunkId = str(chunk.id) || str(document.id) + "#" + num(firstDefined([chunk.chunkIndex, chunk.chunk_index]), index);
                    const open = openChunk === chunkId;
                    const docFullPath = str(firstDefined([document.filePath, document.file_path]));
                    const docLabel = str(firstDefined([document.relativePath, document.relative_path])) || docFullPath || "未知文档";
                    return h(
                      "div",
                      { className: "mrp-result", key: chunkId },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "mrp-result-head",
                          onClick: () => setOpenChunk(open ? null : chunkId),
                          "aria-expanded": open ? "true" : "false",
                        },
                        h(
                          "span",
                          { className: "mrp-result-path", title: docFullPath || docLabel },
                          docLabel
                        ),
                        str(firstDefined([chunk.headingPath, chunk.heading_path]))
                          ? h(
                              "span",
                              { className: "mrp-result-heading" },
                              str(firstDefined([chunk.headingPath, chunk.heading_path]))
                            )
                          : null,
                        h("span", { className: "mrp-result-score" }, "score " + num(record.score, 0).toFixed(2)),
                        h("span", { className: "mrp-result-toggle" }, open ? "收起" : "展开")
                      ),
                      open
                        ? h("pre", { className: "mrp-pre" }, str(chunk.content))
                        : h("p", { className: "mrp-snippet" }, truncate(str(chunk.content), 180))
                    );
                  })
                  )
                )
        );
      }

      return h("div", { className: "mrp-stack" }, renderRoots(), renderDocuments(), renderSearch());
    }

    // ------------------------------------------------------------------
    // 关联 Tab（文档 ↔ 记忆，契约 §10.6）
    // ------------------------------------------------------------------

    function LinksTab(props) {
      const links = asArray(props.links);
      const supportCount = links.filter((link) => link.relation === "supports").length;
      const contradictCount = links.filter((link) => link.relation === "contradicts").length;
      const otherCount = links.length - supportCount - contradictCount;
      // R14：关联并入文档库，默认收起，点标题展开。
      const [open, setOpen] = useState(props.initialOpen === true);

      function linkRow(link) {
        const docLabel = link.relativePath || link.filePath || "（文档缺失）";
        const heading = link.headingPath ? " > " + link.headingPath : "";
        const meta = [categoryLabel(link.memoryCategory), link.memoryStatus ? memoryStatusLabel(link.memoryStatus) : "", link.detectedBy ? "检测：" + link.detectedBy : ""]
          .filter(Boolean)
          .join(" · ");
        return h(
          "div",
          { className: "mrp-link", key: link.id || link.docId + ":" + link.memoryId },
          h(
            "div",
            { className: "mrp-link-main" },
            badge(relationLabel(link.relation), RELATION_TONE[link.relation] || "neutral", "文档与记忆的关联关系"),
            h("span", { className: "mrp-link-memory", title: link.memoryContent || "" }, truncate(link.memoryContent || "（记忆内容缺失）", 60)),
            h("span", { className: "mrp-link-doc", title: docLabel + heading }, "📄 " + docLabel + heading)
          ),
          h(
            "div",
            { className: "mrp-link-meta" },
            meta ? h("span", { className: "mrp-meta-item" }, meta) : null,
            link.detectedAt ? h("span", { className: "mrp-meta-item" }, formatShortTimestamp(link.detectedAt)) : null
          )
        );
      }

      return h(
        "section",
        { className: "mrp-section mrp-links-fold" },
        h(
          "button",
          {
            type: "button",
            className: "mrp-fold-head",
            "aria-expanded": open ? "true" : "false",
            onClick: () => setOpen((value) => !value),
            title: "展开/收起文档与记忆的关联",
          },
          "🔗 文档 ↔ 记忆关联（" + links.length + "）",
          h("span", { className: "mrp-fold-chevron", "aria-hidden": "true" }, open ? "▴" : "▾")
        ),
        open
          ? h(
              "div",
              { className: "mrp-links-body" },
              h(
                "div",
                { className: "mrp-chips" },
                h("span", { className: "mrp-chip mrp-chip-ok" }, "支持 " + supportCount),
                h("span", { className: "mrp-chip mrp-chip-error" }, "矛盾 " + contradictCount),
                otherCount > 0 ? h("span", { className: "mrp-chip" }, "其他 " + otherCount) : null
              ),
              h(
                "p",
                { className: "mrp-hint" },
                "这里显示文档与记忆的相互支持/矛盾关系；标为「矛盾」的项可以到「待确认」里裁决。"
              ),
              links.length === 0
                ? emptyState("文档与记忆还没有建立关联", "索引目录并让文档内容与记忆相近时自动链接。", null, "🔗")
                : h("div", { className: "mrp-links" }, links.map((link) => linkRow(link)))
            )
          : null
      );
    }

    // ------------------------------------------------------------------
    // 记忆包 Tab
    // ------------------------------------------------------------------

    function PacksTab(props) {
      const packs = asArray(props.packs);
      const act = props.act;
      const notify = props.notify;
      const isBusy = props.isBusy;
      const selected = props.selected;
      // R5：会话捕获 / 蒸馏（宿主 /state 提供 capture 与 distillation）
      const capture = asObject(props.capture);
      const distillation = props.distillation || null;
      // R12：自动蒸馏状态
      const autoDistill = asObject(props.autoDistill);

      const [importPath, setImportPath] = useState("");
      const [strategy, setStrategy] = useState("ask");
      const [confirmingId, setConfirmingId] = useState(null);
      const [deleteMemories, setDeleteMemories] = useState(false);
      const [captureOpen, setCaptureOpen] = useState(props.initialCaptureOpen === true);
      // R14：导入/导出折叠进「高级：记忆包文件」，默认收起
      const [advancedOpen, setAdvancedOpen] = useState(props.initialAdvancedOpen === true);
      const [sessions, setSessions] = useState(() => asArray(props.initialCapturedSessions));
      const [sessionsLoading, setSessionsLoading] = useState(false);
      const [sessionsError, setSessionsError] = useState("");
      const [readingId, setReadingId] = useState("");
      const [turnsById, setTurnsById] = useState({});
      const [turnsLoading, setTurnsLoading] = useState("");
      const [confirmDropId, setConfirmDropId] = useState(str(props.initialDropConfirmId));
      const [promptOpen, setPromptOpen] = useState(props.initialPromptOpen === true);
      const [promptText, setPromptText] = useState(str(props.initialPromptText));
      const [applyOpen, setApplyOpen] = useState(props.initialApplyOpen === true);
      const [applyText, setApplyText] = useState("");
      const [importToMemories, setImportToMemories] = useState(props.initialImportToMemories === true);
      const [distillScope, setDistillScope] = useState(str(props.initialDistillScope) || "global");
      const [confirmClearAll, setConfirmClearAll] = useState(props.initialClearConfirm === true);
      // R10：撤销本次蒸馏导入的二次确认
      const [confirmUndo, setConfirmUndo] = useState(props.initialUndoConfirm === true);
      // R12：自动蒸馏操作中（update / run）
      const [autoBusy, setAutoBusy] = useState("");
      // R13：PII 复核两段式
      const [stagePreview, setStagePreview] = useState(() =>
        props.initialStagePreview ? normalizeStagePreview(props.initialStagePreview) : null
      );
      const [restoreIndexes, setRestoreIndexes] = useState(() => asArray(props.initialRestore).map((value) => num(value, 0)));
      const [keepDroppedIndexes, setKeepDroppedIndexes] = useState(() =>
        asArray(props.initialKeepDropped).map((value) => num(value, 0))
      );
      const [stageBusy, setStageBusy] = useState("");
      const [distillBusy, setDistillBusy] = useState("");
      const [distillError, setDistillError] = useState("");
      // R6：蒸馏数据源（插件捕获 / DSH 历史会话 / 两者）
      const [distillSource, setDistillSource] = useState(str(props.initialDistillSource) || "capture");
      const [distillSourcesData, setDistillSourcesData] = useState(() =>
        props.initialDistillSources ? asObject(props.initialDistillSources) : null
      );
      const [sourcesLoading, setSourcesLoading] = useState(false);
      const [sourcesError, setSourcesError] = useState("");
      const [showSources, setShowSources] = useState(props.initialShowSources === true);
      const [prepareSessions, setPrepareSessions] = useState(() =>
        asArray(props.initialPrepareSessions).map(normalizeDistillSession)
      );
      const [meta, setMeta] = useState({
        name: "",
        version: "1.0.0",
        author: "",
        description: "",
        category: "framework",
      });
      const [exportPath, setExportPath] = useState(null);
      // R8：导出时是否带上最近一次蒸馏画像（默认带上）。
      const [includeProfile, setIncludeProfile] = useState(props.initialIncludeProfile !== false);
      const [exportHasProfile, setExportHasProfile] = useState(null);
      // R9：导入被指令注入拦截时的红色提示（snippet 列表）
      const [importBlocked, setImportBlocked] = useState(() =>
        props.initialImportBlocked ? asObject(props.initialImportBlocked) : null
      );
      // 契约 §10.6.2：进入「记忆包」Tab 时查一次更新；失败安静降级（不弹错、不影响列表）。
      const [updates, setUpdates] = useState(() => normalizePackUpdates(props.initialPackUpdates));

      useEffect(() => {
        let alive = true;
        fetchPackUpdates()
          .then((next) => {
            if (alive) setUpdates(next);
          })
          .catch(() => {
            /* 静默：后端不可用不影响已安装列表 */
          });
        return () => {
          alive = false;
        };
      }, []);

      const toggles = useMemo(() => {
        const map = new Map();
        for (const update of updates) {
          if (update.available && update.packId) map.set(update.packId, update);
        }
        return map;
      }, [updates]);

      const selectedIds = useMemo(() => Array.from(selected), [selected]);
      // R8：最近画像是否存在 + 摘要（导出区展示 / 决定能否只导画像）。
      const profileExists = !!(distillation && distillation.profile);
      const profileInfo = profileSummary(profileExists ? distillation.profile : null);

      // R7：蒸馏导入作用域选项（global + 现有 project:*，与顶栏 scope 数据同源）。
      const distillScopeOptions = useMemo(() => {
        const list = Array.from(new Set(asArray(props.scopes).filter((item) => item && item !== "all")));
        if (list.indexOf("global") === -1) list.unshift("global");
        return list;
      }, [props.scopes]);

      // ---------------- R5：会话捕获 ----------------

      async function toggleCapture() {
        const result = await act("capture.update", { enabled: capture.enabled !== true }, { key: "capture.update" });
        if (!result) return;
        notify(result.enabled ? "已开启会话捕获：之后每轮对话会存到本机，不上传。" : "已关闭会话捕获：不再追加，历史会话仍保留。");
      }

      async function loadSessions() {
        setSessionsLoading(true);
        setSessionsError("");
        try {
          const result = await captureStatus();
          setSessions(asArray(result && result.sessions));
        } catch (statusError) {
          setSessionsError(describeError(statusError));
        } finally {
          setSessionsLoading(false);
        }
      }

      function toggleSessionList() {
        const next = !captureOpen;
        setCaptureOpen(next);
        if (next && sessions.length === 0) void loadSessions();
      }

      async function toggleSessionRead(sessionId) {
        if (readingId === sessionId) {
          setReadingId("");
          return;
        }
        setReadingId(sessionId);
        if (turnsById[sessionId]) return;
        setTurnsLoading(sessionId);
        try {
          const result = await readCapture(sessionId);
          setTurnsById((prev) => Object.assign({}, prev, { [sessionId]: asArray(result && result.turns) }));
        } catch (readError) {
          setSessionsError(describeError(readError));
        } finally {
          setTurnsLoading("");
        }
      }

      async function dropSession(sessionId) {
        const result = await act("capture.drop", { sessionId: sessionId }, { key: "capture.drop:" + sessionId });
        if (!result) return;
        setConfirmDropId("");
        notify("已删除会话：" + sessionId);
        await loadSessions();
      }

      async function clearAllSessions() {
        const result = await act("capture.clear", {}, { key: "capture.clear" });
        if (!result) return;
        setConfirmClearAll(false);
        setReadingId("");
        setTurnsById({});
        setSessions([]);
        setConfirmDropId("");
        notify("已清空全部原始对话（" + asArray(result.removed).length + " 个会话）；蒸馏出的画像不受影响。");
      }

      /** R10：撤销最近一次蒸馏导入（只删 AI 推断、未确认、未改过的记忆）。 */
      async function undoLastDistill() {
        if (!distillation || !distillation.id) return;
        const result = await act("distill.undo", { id: distillation.id }, { key: "distill.undo" });
        if (!result) return;
        setConfirmUndo(false);
        notify(
          "已撤销：删除 " + num(result.removed, 0) + " 条，保留 " + num(result.kept, 0) + " 条"
        );
      }

      /** R12：自动蒸馏开关。 */
      async function toggleAutoDistill(nextEnabled) {
        setAutoBusy("update");
        try {
          const result = await updateAutoDistill({ enabled: nextEnabled === true });
          await refresh({ silent: true });
          const status = asObject(result && result.status);
          const enabledNow = status.enabled !== undefined ? status.enabled === true : nextEnabled === true;
          notify(enabledNow ? "已开启自动蒸馏" : "已关闭自动蒸馏");
        } catch (autoError) {
          notify(describeError(autoError), "error");
        } finally {
          setAutoBusy("");
        }
      }

      /** R12：立即运行一次自动蒸馏。 */
      async function runAutoNow() {
        setAutoBusy("run");
        try {
          const result = await runAutoDistillNow({
            source: distillSource,
            importToMemories: importToMemories === true,
          });
          await refresh({ silent: true });
          if (result && result.ok === false) {
            notify(str(result.error) || "自动蒸馏失败", "error");
          } else {
            notify(
              "已生成画像 " +
                (str(result && result.id) || "—") +
                "（写入 " +
                num(result && result.memoryCount, 0) +
                " 条）"
            );
          }
        } catch (autoError) {
          notify(describeError(autoError), "error");
        } finally {
          setAutoBusy("");
        }
      }

      /** R13：第一步——解析并生成复核预览（distill.stage）。 */
      async function stageDistillNow(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const text = str(applyText).trim();
        if (!text) {
          setDistillError("请先把 AI 产出的蒸馏 JSON 粘贴进来。");
          return;
        }
        setDistillBusy("stage");
        setDistillError("");
        setStagePreview(null);
        try {
          const result = await stageDistill(text, distillSource);
          setStagePreview(normalizeStagePreview(result));
          setRestoreIndexes([]);
          setKeepDroppedIndexes([]);
        } catch (stageError) {
          setDistillError(describeError(stageError));
        } finally {
          setDistillBusy("");
        }
      }

      function toggleRestore(index) {
        setRestoreIndexes((prev) => (prev.indexOf(index) >= 0 ? prev.filter((value) => value !== index) : prev.concat([index])));
      }

      function toggleKeepDropped(index) {
        setKeepDroppedIndexes((prev) => (prev.indexOf(index) >= 0 ? prev.filter((value) => value !== index) : prev.concat([index])));
      }

      /** R13：第二步——按复核选择写入（distill.review.apply）。 */
      async function confirmReview() {
        if (!stagePreview) return;
        setStageBusy("apply");
        try {
          const result = await applyDistillReview({
            stageId: stagePreview.stageId,
            restore: restoreIndexes,
            keepDropped: keepDroppedIndexes,
            importToMemories: importToMemories === true,
            scope: distillScope,
          });
          await refresh({ silent: true });
          notify(reviewApplyNotice(result));
          setStagePreview(null);
          setApplyOpen(false);
          setApplyText("");
        } catch (reviewError) {
          notify(describeError(reviewError), "error");
        } finally {
          setStageBusy("");
        }
      }

      async function discardReview() {
        if (!stagePreview) return;
        setStageBusy("discard");
        try {
          await discardDistillReview(stagePreview.stageId);
          notify("已放弃本次复核（未写入任何内容）");
          setStagePreview(null);
          setRestoreIndexes([]);
          setKeepDroppedIndexes([]);
        } catch (discardError) {
          notify(describeError(discardError), "error");
        } finally {
          setStageBusy("");
        }
      }

      function renderReview() {
        if (!stagePreview) return null;
        const redactions = asArray(stagePreview.redactions);
        const dropped = asArray(stagePreview.dropped);
        const profileCount = profileEntryCount(stagePreview.profile);
        return h(
          "div",
          { className: "mrp-review" },
          h(
            "div",
            { className: "mrp-review-head" },
            h("span", { className: "mrp-review-title" }, "PII 复核"),
            h(
              "span",
              { className: "mrp-hint" },
              "画像 " +
                profileCount +
                " 条 · 脱敏 " +
                redactions.length +
                " 处 · 丢弃 " +
                dropped.length +
                " 条"
            )
          ),
          redactions.length > 0
            ? h(
                "div",
                { className: "mrp-review-block" },
                h("span", { className: "mrp-field-label" }, "脱敏明细"),
                redactions.map((item) =>
                  h(
                    "label",
                    { className: "mrp-review-row", key: "redaction-" + item.index },
                    h("input", {
                      type: "checkbox",
                      checked: restoreIndexes.indexOf(item.index) >= 0,
                      onChange: () => toggleRestore(item.index),
                    }),
                    h("span", { className: "mrp-review-label" }, item.label + " · " + item.field),
                    h("span", { className: "mrp-review-text" }, "原文：" + truncate(item.original, 40)),
                    h("span", { className: "mrp-review-toggle" }, "还原原文")
                  )
                )
              )
            : null,
          dropped.length > 0
            ? h(
                "div",
                { className: "mrp-review-block" },
                h("span", { className: "mrp-field-label" }, "丢弃明细"),
                dropped.map((item, index) =>
                  h(
                    "label",
                    { className: "mrp-review-row", key: "dropped-" + index },
                    h("input", {
                      type: "checkbox",
                      checked: keepDroppedIndexes.indexOf(index) >= 0,
                      onChange: () => toggleKeepDropped(index),
                    }),
                    h("span", { className: "mrp-review-text" }, truncate(item.text, 40) || "（空内容）"),
                    h("span", { className: "mrp-review-toggle" }, "保留这条")
                  )
                )
              )
            : null,
          redactions.length === 0 && dropped.length === 0
            ? h("p", { className: "mrp-hint" }, "本次没有需要复核的内容")
            : null,
          h(
            "div",
            { className: "mrp-form-actions" },
            button(stageBusy === "apply" ? "写入中…" : "确认写入", () => void confirmReview(), {
              primary: true,
              key: "review-apply",
              disabled: stageBusy !== "",
            }),
            button(stageBusy === "discard" ? "放弃中…" : "放弃", () => void discardReview(), {
              subtle: true,
              key: "review-discard",
              disabled: stageBusy !== "",
            })
          )
        );
      }

      function renderAutoDistill() {
        const enabled = autoDistill.enabled === true;
        const every = num(autoDistill.every, 20) || 20;
        const remaining = num(autoDistill.remaining, -1);
        const lastResult = autoDistill.lastResult ? asObject(autoDistill.lastResult) : null;
        const lastParts = [];
        if (autoDistill.lastRunAt) lastParts.push("上次运行 " + formatShortTimestamp(autoDistill.lastRunAt));
        if (lastResult) {
          if (str(lastResult.skipped)) {
            lastParts.push("上次跳过：" + str(lastResult.skipped));
          } else {
            lastParts.push("上次写入 " + num(lastResult.after, 0) + " 条（画像 " + (str(lastResult.distillId) || "—") + "）");
          }
        }
        return h(
          "div",
          { className: "mrp-auto-distill" },
          h(
            "div",
            { className: "mrp-auto-head" },
            h(
              "label",
              { className: "mrp-check" },
              h("input", {
                type: "checkbox",
                checked: enabled,
                disabled: autoBusy === "update",
                onChange: () => void toggleAutoDistill(!enabled),
                "aria-label": "自动蒸馏",
              }),
              h("span", null, "自动蒸馏")
            ),
            button(autoBusy === "run" ? "运行中…" : "立即运行一次", () => void runAutoNow(), {
              subtle: true,
              key: "auto-run",
              disabled: autoBusy !== "",
              title: "立刻用离线启发式蒸馏一次（不等阈值）",
            })
          ),
          h(
            "p",
            { className: "mrp-hint" },
            enabled ? "每 " + every + " 轮跑一次 · 还差 " + (remaining >= 0 ? remaining + " 轮" : "—") : "自动蒸馏未开启"
          ),
          lastParts.length > 0
            ? h(
                "div",
                { className: "mrp-auto-last" },
                lastParts.map((text, index) => h("span", { className: "mrp-meta-item", key: index }, text))
              )
            : null,
          h(
            "p",
            { className: "mrp-hint mrp-auto-note" },
            "开启后会在每轮结束时累计，达到阈值后台用「离线启发式」蒸馏一次；默认不写入记忆库。"
          )
        );
      }

      function renderCaptureBody() {
        const sessionCount = num(capture.sessions, 0);
        const turnCount = num(capture.turns, 0);
        const limits = asObject(capture.limits);
        const maxSessions = num(limits.maxSessions, 100) || 100;
        const maxFileMb = Math.round((num(limits.maxFileBytes, 2 * 1024 * 1024) / (1024 * 1024)) * 10) / 10;
        return h(
          "div",
          { className: "mrp-record-step mrp-capture-card" },
          h(
            "div",
            { className: "mrp-record-step-head" },
            h("span", { className: "mrp-step-no" }, "第一步"),
            h("span", { className: "mrp-record-title" }, "会话捕获"),
            badge(capture.enabled ? "已开启" : "未开启", capture.enabled ? "ok" : "neutral"),
            button(capture.enabled ? "关闭捕获" : "打开捕获", () => void toggleCapture(), {
              primary: capture.enabled !== true,
              key: "capture-toggle",
              disabled: isBusy("capture.update"),
              title: capture.enabled ? "停止追加新对话（历史保留）" : "开始把之后每轮对话存到本机",
            })
          ),
          h(
            "div",
            { className: "mrp-capture-stats" },
            h("span", { className: "mrp-meta-item" }, sessionCount + " 个会话 · " + turnCount + " 轮 · " + formatBytes(capture.bytes)),
            capture.lastTurnAt ? h("span", { className: "mrp-meta-item" }, "最近 " + formatShortTimestamp(capture.lastTurnAt)) : null,
            capture.enabledAt ? h("span", { className: "mrp-meta-item" }, "开启于 " + formatShortTimestamp(capture.enabledAt)) : null,
            button(captureOpen ? "收起会话列表" : "展开会话列表", toggleSessionList, {
              subtle: true,
              key: "capture-list-toggle",
            }),
            confirmClearAll
              ? [
                  h("span", { className: "mrp-selection-warn", key: "clear-warn" }, "确认清空全部原始对话？蒸馏出的画像不受影响"),
                  button("确认清空", () => void clearAllSessions(), {
                    danger: true,
                    key: "capture-clear-confirm",
                    disabled: isBusy("capture.clear"),
                  }),
                  button("取消", () => setConfirmClearAll(false), { subtle: true, key: "capture-clear-cancel" }),
                ]
              : button("清空全部", () => setConfirmClearAll(true), {
                  subtle: true,
                  dimmed: true,
                  key: "capture-clear",
                  disabled: sessionCount === 0,
                  title: "删除本机保存的全部原始对话（蒸馏出的画像保留）",
                })
          ),
          h(
            "p",
            { className: "mrp-hint mrp-capture-limits" },
            "单会话超过 " + maxFileMb + "MB 自动只保留最近部分；最多保留 " + maxSessions + " 个会话"
          ),
          captureOpen ? renderSessionList() : null
        );
      }

      function renderSessionList() {
        return h(
          "div",
          { className: "mrp-sessions" },
          sessionsLoading
            ? h("p", { className: "mrp-hint" }, "读取会话列表…")
            : sessionsError
              ? banner(sessionsError, "error", () => setSessionsError(""))
              : sessions.length === 0
                ? h("p", { className: "mrp-hint" }, "还没有捕获到会话：打开上方的捕获开关，聊几轮后再回来。")
                : sessions.map((session) => {
                    const sessionId = str(session.sessionId);
                    const reading = readingId === sessionId;
                    const turns = asArray(turnsById[sessionId]);
                    return h(
                      "div",
                      { className: "mrp-session", key: sessionId || str(session.file) },
                      h(
                        "div",
                        { className: "mrp-session-head" },
                        h("span", { className: "mrp-session-id mrp-mono", title: sessionId }, sessionId || "（未知会话）"),
                        h("span", { className: "mrp-meta-item" }, num(session.turns, 0) + " 轮"),
                        h("span", { className: "mrp-meta-item" }, formatShortTimestamp(session.updatedAt)),
                        button(reading ? "收起" : "查看", () => void toggleSessionRead(sessionId), {
                          subtle: true,
                          key: "session-view",
                          disabled: turnsLoading === sessionId,
                        }),
                        confirmDropId === sessionId
                          ? [
                              h("span", { className: "mrp-selection-warn", key: "warn" }, "确认删除该会话？"),
                              button("确认删除", () => void dropSession(sessionId), {
                                danger: true,
                                key: "session-drop-confirm",
                                disabled: isBusy("capture.drop:" + sessionId),
                              }),
                              button("取消", () => setConfirmDropId(""), { subtle: true, key: "session-drop-cancel" }),
                            ]
                          : button("删除", () => setConfirmDropId(sessionId), { subtle: true, dimmed: true, key: "session-drop" })
                      ),
                      reading
                        ? h(
                            "div",
                            { className: "mrp-session-turns" },
                            turnsLoading === sessionId
                              ? h("p", { className: "mrp-hint" }, "读取对话…")
                              : turns.length === 0
                                ? h("p", { className: "mrp-hint" }, "该会话还没有可显示的对话轮次。")
                                : turns.slice(0, 20).map((turn, index) =>
                                    h(
                                      "div",
                                      { className: "mrp-turn", key: index },
                                      h("span", { className: "mrp-turn-role", "data-role": str(turn.role) }, str(turn.role) || "?"),
                                      h("span", { className: "mrp-turn-text" }, truncate(str(turn.text), 300))
                                    )
                                  )
                          )
                        : null
                    );
                  })
        );
      }

      // ---------------- R5：蒸馏 ----------------

      // ---------------- R6：蒸馏数据源 ----------------

      async function loadDistillSources() {
        setSourcesLoading(true);
        setSourcesError("");
        try {
          const result = await distillSources();
          setDistillSourcesData({
            dshHome: str(result && result.dshHome),
            dsh: asArray(result && result.dsh).map(normalizeDistillSession),
            captured: asArray(result && result.captured).map(normalizeDistillSession),
          });
        } catch (sourceError) {
          setSourcesError(describeError(sourceError));
        } finally {
          setSourcesLoading(false);
        }
      }

      function switchDistillSource(nextSource) {
        const key = str(nextSource) || "capture";
        if (key === distillSource) return;
        setDistillSource(key);
        setPrepareSessions([]);
        setPromptOpen(false);
        if (key !== "capture") {
          setShowSources(true);
          if (!distillSourcesData && !sourcesLoading) void loadDistillSources();
        }
      }

      async function prepareDistill() {
        setDistillBusy("prepare");
        setDistillError("");
        try {
          const result = await runDistill(buildDistillPayload("prepare", distillSource, {}, distillScope));
          setPromptText(str(result && result.prompt));
          setPrepareSessions(asArray(result && result.sessions).map(normalizeDistillSession));
          setPromptOpen(true);
          setApplyOpen(false);
          const sessionCount = asArray(result && result.sessions).length;
          notify("已准备蒸馏 prompt（" + sessionCount + " 个会话）：交给 AI，把 JSON 贴回来。");
        } catch (prepareError) {
          setDistillError(describeError(prepareError));
        } finally {
          setDistillBusy("");
        }
      }

      async function heuristicDistill() {
        setDistillBusy("heuristic");
        setDistillError("");
        try {
          const result = await act("distill.run", buildDistillPayload("heuristic", distillSource, { scope: distillScope }, distillScope), {
            key: "distill.heuristic",
          });
          if (result) {
            setPromptOpen(false);
            setApplyOpen(false);
            notify(
              "已离线蒸馏：生成认知画像并保存" +
                (num(result.memoryCount, 0) > 0 ? "，写入 " + num(result.memoryCount, 0) + " 条记忆。" : "。")
            );
          }
        } finally {
          setDistillBusy("");
        }
      }

      async function applyDistill(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const text = str(applyText).trim();
        if (!text) {
          setDistillError("请先把 AI 产出的蒸馏 JSON 粘贴进来。");
          return;
        }
        setDistillBusy("apply");
        setDistillError("");
        try {
          const result = await act(
            "distill.run",
            buildDistillPayload("apply", distillSource, { distillation: text, importToMemories: importToMemories === true }, distillScope),
            { key: "distill.apply" }
          );
          if (result) {
            setApplyOpen(false);
            setApplyText("");
            setPromptOpen(false);
            const safety = normalizeSafety(result.safety);
            const safetyText = distillSafetyNotice(safety);
            const denoiseLines = distillDenoiseLines(result);
            const denoiseText = denoiseLines.length > 0 ? "\n" + denoiseLines.join("\n") : "";
            const base =
              "已应用蒸馏结果：" +
              (num(result.memoryCount, 0) > 0 ? "写入 " + num(result.memoryCount, 0) + " 条记忆。" : "画像已保存。");
            if (safetyText && safety.blocked) {
              notify("已应用蒸馏结果：" + safetyText + denoiseText, "warn");
            } else if (safetyText) {
              notify(base + "（" + safetyText + "）" + denoiseText, "warn");
            } else {
              notify(base + denoiseText);
            }
          }
        } finally {
          setDistillBusy("");
        }
      }

      function copyPrompt() {
        const nav = typeof navigator !== "undefined" ? navigator : null;
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
          nav.clipboard
            .writeText(promptText)
            .then(() => notify("prompt 已复制到剪贴板。"))
            .catch(() => notify("复制失败，请手动选中复制。", "error"));
          return;
        }
        notify("当前环境不支持自动复制，请手动选中复制。", "warn");
      }

      function renderProfileGroups(profile) {
        const experiences = asArray(profile && profile.experiences);
        return h(
          "div",
          { className: "mrp-profile-groups" },
          PROFILE_GROUPS.map((group) => {
            const items = asArray(profile[group.key]);
            return h(
              "div",
              { className: "mrp-profile-group", key: group.key, "data-group": group.key },
              h(
                "div",
                { className: "mrp-profile-head" },
                h("span", { className: "mrp-profile-label", "data-tone": group.tone }, group.label),
                h("span", { className: "mrp-profile-count" }, String(items.length))
              ),
              items.length === 0
                ? h("span", { className: "mrp-hint" }, "—")
                : h(
                    "div",
                    { className: "mrp-profile-items" },
                    items.map((item, index) => h("span", { className: "mrp-profile-item", key: group.key + "-" + index }, item))
                  )
            );
          }),
          h(
            "div",
            { className: "mrp-profile-group", key: "experiences", "data-group": "experiences" },
            h(
              "div",
              { className: "mrp-profile-head" },
              h("span", { className: "mrp-profile-label", "data-tone": "brand" }, "🧭 经验（" + experiences.length + "）")
            ),
            experiences.length === 0
              ? h("span", { className: "mrp-hint" }, "—")
              : h(
                  "div",
                  { className: "mrp-profile-items" },
                  experiences.map((experience, index) =>
                    h(
                      "span",
                      {
                        className: "mrp-profile-item",
                        key: "experience-" + index,
                        title: [experience.why, experience.boundary].filter(Boolean).join(" · "),
                      },
                      experience.trigger + " → " + experience.action
                    )
                  )
                )
          )
        );
      }

      function sourceBadge(source) {
        const isDsh = str(source) === "dsh";
        return badge(isDsh ? "DSH" : "捕获", isDsh ? "business" : "neutral", isDsh ? "来自 DSH 历史会话" : "来自插件捕获");
      }

      function sourceListRow(session, index) {
        const sessionId = str(session.sessionId);
        const kb = num(session.bytes, 0) > 0 ? Math.max(1, Math.round(num(session.bytes, 0) / 1024)) + " KB" : "";
        return h(
          "div",
          { className: "mrp-source-item", key: sessionId + "-" + index },
          h("span", { className: "mrp-source-workspace", title: session.workspace || "" }, session.workspace || "（未知工作区）"),
          h("span", { className: "mrp-mono mrp-source-sid", title: sessionId }, sessionId.slice(0, 8)),
          kb ? h("span", { className: "mrp-meta-item" }, kb) : null,
          h("span", { className: "mrp-meta-item" }, formatShortTimestamp(session.updatedAt))
        );
      }

      function renderSourceList() {
        if (sourcesLoading) return h("p", { className: "mrp-hint" }, "读取 DSH 历史会话…");
        if (sourcesError) return banner(sourcesError, "error", () => setSourcesError(""));
        const sources = asObject(distillSourcesData);
        const dsh = asArray(sources.dsh).slice(0, 10);
        const captured = asArray(sources.captured);
        return h(
          "div",
          { className: "mrp-sources" },
          dsh.length === 0
            ? h("p", { className: "mrp-hint" }, "没有在 ~/.dsh/sessions 下发现历史会话。")
            : dsh.map((session, index) => sourceListRow(session, index)),
          h("p", { className: "mrp-hint" }, "已捕获会话：" + captured.length + " 个")
        );
      }

      function renderPrepareSessions() {
        if (prepareSessions.length === 0) return null;
        return h(
          "div",
          { className: "mrp-prep-sessions" },
          h("span", { className: "mrp-field-label" }, "参与蒸馏的会话（" + prepareSessions.length + "）"),
          prepareSessions.map((session, index) =>
            h(
              "div",
              { className: "mrp-prep-session", key: str(session.sessionId) + "-" + index },
              sourceBadge(session.source),
              h("span", { className: "mrp-mono" }, str(session.sessionId).slice(0, 12) || "（未知）"),
              session.workspace ? h("span", { className: "mrp-meta-item" }, session.workspace) : null,
              h("span", { className: "mrp-meta-item" }, num(session.turns, 0) + " 轮")
            )
          )
        );
      }

      function renderDistillBody() {
        const profile = distillation ? distillation.profile : null;
        return h(
          "div",
          { className: "mrp-record-step mrp-distill-card" },
          h(
            "div",
            { className: "mrp-record-step-head" },
            h("span", { className: "mrp-step-no" }, "第二步"),
            h("span", { className: "mrp-record-title" }, "蒸馏（对话 → 认知画像）")
          ),
          h(
            "div",
            { className: "mrp-source-row" },
            h("span", { className: "mrp-field-label" }, "数据源"),
            h(
              "div",
              { className: "mrp-segmented", role: "radiogroup", "aria-label": "蒸馏数据源" },
              DISTILL_SOURCES.map((item) => {
                const active = distillSource === item.key;
                return h(
                  "button",
                  {
                    key: item.key,
                    type: "button",
                    role: "radio",
                    "aria-checked": active ? "true" : "false",
                    "data-source": item.key,
                    className: "mrp-seg" + (active ? " mrp-seg-active" : ""),
                    onClick: () => switchDistillSource(item.key),
                  },
                  item.label
                );
              })
            )
          ),
          distillSource !== "capture"
            ? h(
                "div",
                { className: "mrp-source-hint" },
                h("span", null, "检测到 " + num(props.dshSessions, 0) + " 个 DSH 历史会话（只读本机日志）"),
                button(showSources ? "收起列表" : "查看前 10 个", () => {
                  const next = showSources !== true;
                  setShowSources(next);
                  if (next && !distillSourcesData && !sourcesLoading) void loadDistillSources();
                }, { subtle: true, key: "sources-toggle" })
              )
            : null,
          showSources && distillSource !== "capture" ? renderSourceList() : null,
          h(
            "div",
            { className: "mrp-distill-actions" },
            button(distillBusy === "heuristic" ? "蒸馏中…" : "离线蒸馏", () => void heuristicDistill(), {
              primary: true,
              key: "distill-heuristic",
              disabled: distillBusy !== "",
              title: "无模型兜底：直接按规则从对话里提炼画像",
            }),
            button(distillBusy === "prepare" ? "准备中…" : "准备蒸馏 prompt", () => void prepareDistill(), {
              subtle: true,
              key: "distill-prepare",
              disabled: distillBusy !== "",
              title: "生成给外部模型用的 prompt，再把它产出的 JSON 贴回来",
            }),
            button(applyOpen ? "收起提交窗口" : "提交蒸馏结果", () => setApplyOpen((open) => !open), {
              subtle: true,
              key: "distill-apply-toggle",
              disabled: distillBusy !== "",
            })
          ),
          distillError ? banner(distillError, "error", () => setDistillError("")) : null,
          renderAutoDistill(),
          promptOpen
            ? h(
                "div",
                { className: "mrp-form mrp-distill-prompt" },
                h(
                  "div",
                  { className: "mrp-form-actions" },
                  h("span", { className: "mrp-field-label" }, "蒸馏 prompt（只读）"),
                  button("复制", copyPrompt, { subtle: true, key: "prompt-copy" })
                ),
                renderPrepareSessions(),
                h("textarea", {
                  className: "mrp-textarea mrp-mono",
                  rows: 8,
                  readOnly: true,
                  value: promptText,
                  "aria-label": "蒸馏 prompt",
                  onFocus: (event) => {
                    if (event && event.target && typeof event.target.select === "function") event.target.select();
                  },
                }),
                h("p", { className: "mrp-hint" }, "把它交给 AI，贴回 JSON 到下面的「提交蒸馏结果」。")
              )
            : null,
          applyOpen
            ? h(
                "form",
                { className: "mrp-form mrp-distill-apply", onSubmit: stageDistillNow },
                h("span", { className: "mrp-field-label" }, "粘贴 AI 产出的 JSON"),
                h("textarea", {
                  className: "mrp-textarea mrp-mono",
                  rows: 6,
                  value: applyText,
                  placeholder: '{"profile":"…","confidence":0.8,"preferences":[],"rules":[],"patterns":[],"skills":[],"avoid":[]}',
                  "aria-label": "蒸馏结果 JSON",
                  onChange: (event) => setApplyText(str(event.target.value)),
                }),
                h(
                  "label",
                  { className: "mrp-check" },
                  h("input", {
                    type: "checkbox",
                    checked: importToMemories,
                    onChange: (event) => setImportToMemories(event.target.checked === true),
                  }),
                  h("span", null, "同时写入记忆库")
                ),
                importToMemories
                  ? h(
                      "div",
                      { className: "mrp-form-row" },
                      field(
                        "导入作用域",
                        h(
                          "select",
                          {
                            className: "mrp-select",
                            value: distillScope,
                            title: "蒸馏出的记忆写到哪个作用域",
                            "aria-label": "蒸馏导入作用域",
                            onChange: (event) => setDistillScope(str(event.target.value) || "global"),
                          },
                          distillScopeOptions.map((item) =>
                            h("option", { key: item, value: item }, item === "global" ? "全局 global" : scopeLabel(item))
                          )
                        ),
                        "全局会进入每轮注入；项目作用域只在该项目下生效"
                      )
                    )
                  : null,
                h(
                  "div",
                  { className: "mrp-form-actions" },
                  button(distillBusy === "stage" ? "解析中…" : "解析并复核", null, {
                    primary: true,
                    submit: true,
                    key: "stage-submit",
                    disabled: distillBusy !== "" || stageBusy !== "",
                  }),
                  button(distillBusy === "apply" ? "提交中…" : "跳过复核直接提交", () => void applyDistill(), {
                    subtle: true,
                    key: "skip-review",
                    disabled: distillBusy !== "" || stageBusy !== "",
                    title: "不经过脱敏复核，直接调用 distill.run apply",
                  })
                ),
                h("p", { className: "mrp-hint" }, "「跳过复核直接提交」不经过脱敏复核，直接写入；建议先用「解析并复核」检查脱敏与丢弃项。"),
                renderReview()
              )
            : null,
          h("div", { className: "mrp-divider" }),
          h("span", { className: "mrp-field-label" }, "最近画像"),
          profile
            ? h(
                "div",
                { className: "mrp-profile" },
                h("p", { className: "mrp-profile-summary" }, profile.profile || "（这次蒸馏没有生成一句话画像）"),
                h(
                  "div",
                  { className: "mrp-chips" },
                  h("span", { className: "mrp-chip mrp-chip-strong" }, "置信度 " + formatConfidence(profile.confidence || distillation.confidence)),
                  h("span", { className: "mrp-chip" }, "来源 " + (distillation.source || "未知")),
                  h("span", { className: "mrp-chip" }, formatShortTimestamp(distillation.createdAt)),
                  h("span", { className: "mrp-chip" }, num(distillation.turns, 0) + " 轮对话"),
                  h("span", { className: "mrp-chip" }, "写入记忆 " + num(distillation.memoryCount, 0) + " 条")
                ),
                renderProfileGroups(profile),
                num(distillation.memoryCount, 0) > 0
                  ? confirmUndo
                    ? h(
                        "div",
                        { className: "mrp-confirm" },
                        h(
                          "span",
                          { className: "mrp-confirm-text" },
                          "确认撤销？只删 AI 推断、未确认的 " + num(distillation.memoryCount, 0) + " 条记忆，你确认过/改过的会保留"
                        ),
                        button("确认撤销", () => void undoLastDistill(), {
                          danger: true,
                          key: "undo-confirm",
                          disabled: isBusy("distill.undo"),
                        }),
                        button("取消", () => setConfirmUndo(false), { subtle: true, key: "undo-cancel" })
                      )
                    : button("撤销本次导入", () => setConfirmUndo(true), { subtle: true, dimmed: true, key: "undo-open" })
                  : null
              )
            : emptyState(
                "还没有认知画像",
                "打开上面的捕获，或切到「DSH 历史会话」直接蒸馏已有对话。",
                null,
                "🧠"
              )
        );
      }

      function renderRecordDistill() {
        return h(
          "section",
          { className: "mrp-section mrp-record-card" + (props.highlightRecord === true ? " mrp-record-focus" : "") },
          sectionHead("🔁 记录 → 蒸馏", null, null),
          h(
            "p",
            { className: "mrp-hint mrp-record-sub" },
            "打开捕获后每轮对话存到本机 ~/.mirror/sessions（不上传）；蒸馏只在本地解析，不写回、不上传。"
          ),
          renderCaptureBody(),
          h("div", { className: "mrp-divider" }),
          renderDistillBody()
        );
      }

      async function submitImport(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const path = str(importPath).trim();
        if (!path) {
          notify("请填写 .mirrorpack / .json 文件的本地路径。", "error");
          return;
        }
        setImportBlocked(null);
        setBusy((prev) => Object.assign({}, prev, { "pack.import": true }));
        try {
          const outcome = await importPack(path, strategy);
          if (outcome.ok) {
            await refresh({ silent: true });
            notify(packImportNotice(outcome.data));
            setImportPath("");
            return;
          }
          // R9：指令注入拦截 → 红色拒绝提示（不显示「已导入」）。
          setImportBlocked({ suspect: asArray(outcome.data && outcome.data.suspect), error: str(outcome.data && outcome.data.error) });
        } catch (importError) {
          notify(describeError(importError), "error");
        } finally {
          setBusy((prev) => {
            const next = Object.assign({}, prev);
            delete next["pack.import"];
            return next;
          });
        }
      }

      async function uninstall(pack) {
        const packId = pack.packId || pack.id;
        const result = await act(
          "pack.uninstall",
          { packId: packId, deleteMemories: deleteMemories },
          { key: "pack.uninstall:" + packId }
        );
        if (!result) return;
        notify(
          "已卸载 " +
            (pack.packName || packId) +
            "：移除 " +
            num(result.removedMemories) +
            " 条 / 保留 " +
            num(result.keptMemories) +
            " 条记忆"
        );
        setConfirmingId(null);
        setDeleteMemories(false);
      }

      async function submitExport(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const availability = packExportAvailability(selectedIds.length, includeProfile, profileExists);
        if (!availability.allowed) {
          notify("请先勾选记忆，或勾选「包含认知画像」只导出画像。", "error");
          return;
        }
        if (!str(meta.name).trim()) {
          notify("请填写记忆包名称。", "error");
          return;
        }
        const withProfile = includeProfile === true && profileExists;
        const result = await act(
          "pack.export",
          { memoryIds: selectedIds, meta: normalizeExportMeta(meta), includeProfile: withProfile },
          { key: "pack.export" }
        );
        if (!result) return;
        setExportPath(str(result.path));
        setExportHasProfile(result.hasProfile === true);
        notify((availability.onlyProfile ? "仅导出认知画像：" : "") + packExportNotice(result, selectedIds.length));
      }

      function renderPacks() {
        return h(
          "section",
          { className: "mrp-section" },
          sectionHead("📦 已安装记忆包", null, packs.length),
          packs.length === 0
            ? emptyState(
                "还没有安装记忆包",
                "导入本地 .mirrorpack 文件，或把选中的记忆打包导出分享给别人。",
                button("导入记忆包", () => focusById("mrp-import-path"), { primary: true }),
                "📦"
              )
            : h(
                "div",
                { className: "mrp-packs" },
                packs.map((pack) => {
                  const packId = pack.packId || pack.id;
                  const confirming = confirmingId === packId;
                  const update = toggles.get(packId);
                  return h(
                    "div",
                    { className: "mrp-pack", key: packId },
                    h(
                      "div",
                      { className: "mrp-pack-main" },
                      h("span", { className: "mrp-pack-name" }, pack.packName || packId),
                      h("span", { className: "mrp-pack-version" }, "v" + (pack.packVersion || "0.0.0")),
                      badge(
                        pack.status === "active" ? "已启用" : pack.status === "disabled" ? "已停用" : str(pack.status) || "未知",
                        pack.status === "active" ? "ok" : "neutral"
                      ),
                      update
                        ? badge(
                            "更新可用 v" + (update.latestVersion || ""),
                            "warn",
                            update.note || "有可用的新版本（本地 .mirrorpack 或上次检查记录）"
                          )
                        : null,
                      h(
                        "span",
                        { className: "mrp-pack-meta-row" },
                        h("span", { className: "mrp-pack-meta" }, num(pack.memoryCount) + " 条记忆"),
                        pack.author ? h("span", { className: "mrp-pack-meta" }, "作者 " + pack.author) : null,
                        pack.installedAt
                          ? h("span", { className: "mrp-pack-meta" }, "安装于 " + formatShortTimestamp(pack.installedAt))
                          : null,
                        h("span", { className: "mrp-pack-meta mrp-mono" }, packId)
                      )
                    ),
                    confirming
                      ? h(
                          "div",
                          { className: "mrp-confirm mrp-pack-confirm" },
                          h(
                            "label",
                            { className: "mrp-check" },
                            h("input", {
                              type: "checkbox",
                              checked: deleteMemories,
                              onChange: (event) => setDeleteMemories(event.target.checked === true),
                            }),
                            h("span", null, "同时删除该包导入且未被改过的记忆")
                          ),
                          button(isBusy("pack.uninstall:" + packId) ? "卸载中…" : "确认卸载", () => uninstall(pack), {
                            danger: true,
                            disabled: isBusy("pack.uninstall:" + packId),
                            key: "confirm-uninstall",
                          }),
                          button("取消", () => setConfirmingId(null), { subtle: true, key: "cancel-uninstall" })
                        )
                      : button("卸载", () => setConfirmingId(packId), { subtle: true, key: "uninstall" })
                  );
                })
              )
        );
      }

      function renderImportBlocked() {
        if (!importBlocked) return null;
        const suspect = asArray(importBlocked.suspect).slice(0, 3);
        return h(
          "div",
          { className: "mrp-import-blocked" },
          h(
            "div",
            { className: "mrp-banner", "data-tone": "error", role: "alert" },
            h("span", { className: "mrp-banner-text" }, importBlockedMessage(importBlocked)),
            h(
              "button",
              { type: "button", className: "mrp-banner-close", onClick: () => setImportBlocked(null), title: "关闭", "aria-label": "关闭" },
              "×"
            )
          ),
          suspect.length > 0
            ? h(
                "pre",
                { className: "mrp-blocked-snippets mrp-mono" },
                suspect.map((item, index) => "• " + (str(asObject(item).snippet) || "（无片段）")).join("\n")
              )
            : null,
          importBlocked.error ? h("p", { className: "mrp-hint" }, str(importBlocked.error)) : null
        );
      }

      function renderImport() {
        return h(
          "div",
          { className: "mrp-stack mrp-import-wrap" },
          h(
            "form",
            { className: "mrp-section", onSubmit: submitImport },
            sectionHead("⬇️ 导入记忆包", null, null),
            h(
              "div",
              { className: "mrp-form-row" },
              field(
                "本地路径",
                h("input", {
                  id: "mrp-import-path",
                  className: "mrp-input",
                  value: importPath,
                  placeholder: "选择 .mirrorpack 文件",
                  spellCheck: false,
                  onChange: (event) => setImportPath(event.target.value),
                }),
                ".mirrorpack 或符合规范 §9.1 的 JSON"
              ),
              field(
                "冲突策略",
                h(
                  "select",
                  { className: "mrp-select", value: strategy, onChange: (event) => setStrategy(event.target.value) },
                  h("option", { value: "ask" }, "有冲突时留给我裁决"),
                  h("option", { value: "pack_first" }, "包优先（覆盖本地）"),
                  h("option", { value: "local_first" }, "我的优先（跳过冲突条）"),
                  h("option", { value: "skip_conflicts" }, "跳过冲突条目")
                )
              )
            ),
            h(
              "div",
              { className: "mrp-form-actions" },
              button(isBusy("pack.import") ? "导入中…" : "导入", null, { primary: true, submit: true, disabled: isBusy("pack.import") })
            )
          ),
          renderImportBlocked()
        );
      }

      function renderExport() {
        return h(
          "form",
          { className: "mrp-section", onSubmit: submitExport },
          sectionHead("⬆️ 导出选中记忆为记忆包", null, selectedIds.length || null),
          h(
            "p",
            { className: "mrp-hint" },
            selectedIds.length
              ? "已选 " + selectedIds.length + " 条记忆，填写元信息后导出。"
              : profileExists
                ? "没有选中记忆，也可以只导出最近一次的认知画像（勾选下方「包含认知画像」）。"
                : "还没有选中记忆：去任意记忆 Tab 勾选卡片左上角的复选框，或直接用顶栏下方的批量操作条导出。"
          ),
          h(
            "div",
            { className: "mrp-form-row" },
            field(
              "名称",
              h("input", {
                className: "mrp-input",
                value: meta.name,
                placeholder: "Next.js 15 最佳实践记忆包",
                onChange: (event) => setMeta(Object.assign({}, meta, { name: event.target.value })),
              })
            ),
            field(
              "版本",
              h("input", {
                className: "mrp-input",
                value: meta.version,
                onChange: (event) => setMeta(Object.assign({}, meta, { version: event.target.value })),
              })
            ),
            field(
              "作者",
              h("input", {
                className: "mrp-input",
                value: meta.author,
                onChange: (event) => setMeta(Object.assign({}, meta, { author: event.target.value })),
              })
            )
          ),
          h(
            "div",
            { className: "mrp-form-row" },
            field(
              "分类",
              h(
                "select",
                {
                  className: "mrp-select",
                  value: meta.category,
                  onChange: (event) => setMeta(Object.assign({}, meta, { category: event.target.value })),
                },
                ["framework", "language", "domain", "toolchain", "team", "role", "industry", "template"].map((value) =>
                  h("option", { key: value, value: value }, value)
                )
              )
            ),
            field(
              "描述",
              h("input", {
                className: "mrp-input mrp-input-grow",
                value: meta.description,
                placeholder: "一句话说明这个包解决什么问题",
                onChange: (event) => setMeta(Object.assign({}, meta, { description: event.target.value })),
              })
            )
          ),
          h(
            "div",
            { className: "mrp-profile-include" },
            h(
              "label",
              { className: "mrp-check" },
              h("input", {
                type: "checkbox",
                checked: includeProfile && profileExists,
                disabled: profileExists !== true,
                onChange: (event) => setIncludeProfile(event.target.checked === true),
                "aria-label": "包含认知画像",
              }),
              h("span", null, "包含认知画像")
            ),
            profileExists
              ? includeProfile
                ? h(
                    "span",
                    { className: "mrp-meta-item" },
                    "画像：" + profileInfo.sentence + " · " + profileInfo.count + " 条判断"
                  )
                : null
              : h("span", { className: "mrp-hint" }, "先去「蒸馏」生成一份画像")
          ),
          h(
            "div",
            { className: "mrp-form-actions" },
            button(
              isBusy("pack.export")
                ? "导出中…"
                : selectedIds.length > 0
                  ? "导出 " + selectedIds.length + " 条记忆为记忆包"
                  : packExportAvailability(0, includeProfile, profileExists).allowed
                    ? "仅导出认知画像"
                    : "先选择记忆或勾选画像",
              null,
              {
                primary: true,
                submit: true,
                disabled: !packExportAvailability(selectedIds.length, includeProfile, profileExists).allowed || isBusy("pack.export"),
              }
            )
          ),
          exportPath
            ? h(
                "div",
                { className: "mrp-export-path" },
                "已导出：" + exportPath + (exportHasProfile === null ? "" : "（含画像：" + (exportHasProfile ? "是" : "否") + "）")
              )
            : null
        );
      }

      useEffect(() => {
        if (props.highlightRecord !== true) return;
        if (typeof document === "undefined" || !document.querySelector) return;
        const card = document.querySelector(".mrp-record-card");
        if (card && typeof card.scrollIntoView === "function") {
          card.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      }, [props.highlightRecord]);

      function renderAdvanced() {
        return h(
          "section",
          { className: "mrp-section mrp-advanced" },
          h(
            "button",
            {
              type: "button",
              className: "mrp-fold-head",
              "aria-expanded": advancedOpen ? "true" : "false",
              onClick: () => setAdvancedOpen((value) => !value),
              title: "展开/收起导入与导出记忆包文件",
            },
            "高级：记忆包文件",
            h("span", { className: "mrp-fold-chevron", "aria-hidden": "true" }, advancedOpen ? "▴" : "▾")
          ),
          advancedOpen ? h("div", { className: "mrp-advanced-body" }, renderImport(), renderExport()) : null
        );
      }

      return h("div", { className: "mrp-stack" }, renderRecordDistill(), renderPacks(), renderAdvanced());
    }

    // ------------------------------------------------------------------
    // 待确认 Tab（冲突裁决 + 陈旧复核）
    // ------------------------------------------------------------------

    function PendingTab(props) {
      const conflicts = asArray(props.conflicts);
      const stale = asArray(props.stale);
      const act = props.act;
      const notify = props.notify;
      const isBusy = props.isBusy;

      const open = conflicts.filter((conflict) => !conflict.resolved);
      const done = conflicts.filter((conflict) => conflict.resolved);

      // R10：质量体检条（打开本 Tab 时懒加载；SSR/测试可注入 initialQuality）
      const [quality, setQuality] = useState(() => {
        if (!props.initialQuality) return null;
        return props.initialQuality === true ? normalizeQualityReport({}) : normalizeQualityReport(props.initialQuality);
      });
      const [qualityLoading, setQualityLoading] = useState(!props.initialQuality);
      const [qualityError, setQualityError] = useState("");

      // R13：经验可达性（quality.benchmark）
      const [benchmark, setBenchmark] = useState(() =>
        props.initialBenchmark ? normalizeBenchmark(props.initialBenchmark) : null
      );
      const [benchmarkOpen, setBenchmarkOpen] = useState(props.initialBenchmarkOpen === true);
      const [benchmarkLoading, setBenchmarkLoading] = useState(false);
      const [benchmarkError, setBenchmarkError] = useState(str(props.initialBenchmarkError));

      // R15：数据备份 / 诊断包
      const [backups, setBackups] = useState(() => (props.initialBackups ? normalizeBackups(props.initialBackups) : null));
      const [backupOpen, setBackupOpen] = useState(props.initialBackupOpen === true);
      const [backupLoading, setBackupLoading] = useState(false);
      const [backupBusy, setBackupBusy] = useState("");
      const [backupError, setBackupError] = useState(str(props.initialBackupError));
      const [restoreConfirm, setRestoreConfirm] = useState(str(props.initialRestoreConfirm));
      const [diagnosticsPath, setDiagnosticsPath] = useState(str(props.initialDiagnosticsPath));

      // R11：冲突分组批量裁决 + 近似重复合并
      const refresh = props.refresh;
      const [batchConfirm, setBatchConfirm] = useState(() => (props.initialBatchConfirm ? asObject(props.initialBatchConfirm) : null));
      const [batchRunning, setBatchRunning] = useState("");
      const [duplicates, setDuplicates] = useState(() =>
        props.initialDuplicates ? normalizeDuplicates(props.initialDuplicates) : null
      );
      const [duplicatesOpen, setDuplicatesOpen] = useState(props.initialDuplicatesOpen === true);
      const [duplicatesLoading, setDuplicatesLoading] = useState(false);
      const [duplicatesError, setDuplicatesError] = useState(str(props.initialDuplicatesError));
      const [duplicateConfirm, setDuplicateConfirm] = useState(() =>
        props.initialDuplicateConfirm ? asObject(props.initialDuplicateConfirm) : null
      );

      const conflictGroups = useMemo(() => {
        const map = new Map();
        for (const conflict of open) {
          const group = conflictGroupOf(conflict);
          if (!map.has(group.key)) map.set(group.key, { key: group.key, label: group.label, items: [] });
          map.get(group.key).items.push(conflict);
        }
        return Array.from(map.values());
      }, [conflicts]);

      async function loadDuplicates() {
        setDuplicatesLoading(true);
        setDuplicatesError("");
        try {
          const result = await qualityDuplicates();
          setDuplicates(normalizeDuplicates(result));
        } catch (duplicateError) {
          setDuplicatesError(describeError(duplicateError));
        } finally {
          setDuplicatesLoading(false);
        }
      }

      function toggleDuplicates() {
        const next = !duplicatesOpen;
        setDuplicatesOpen(next);
        if (next && !duplicates && !duplicatesLoading) void loadDuplicates();
      }

      async function runBenchmark() {
        setBenchmarkOpen(true);
        setBenchmarkLoading(true);
        setBenchmarkError("");
        try {
          const result = await qualityBenchmark(5, props.scope);
          setBenchmark(normalizeBenchmark(result));
        } catch (benchmarkFailure) {
          setBenchmarkError(describeError(benchmarkFailure));
        } finally {
          setBenchmarkLoading(false);
        }
      }

      // R15：备份 / 恢复 / 诊断包
      async function loadBackups() {
        setBackupLoading(true);
        setBackupError("");
        try {
          const result = await backupListAll();
          setBackups(normalizeBackups(result));
        } catch (backupFailure) {
          setBackupError(describeError(backupFailure));
        } finally {
          setBackupLoading(false);
        }
      }

      function toggleBackupPanel() {
        const next = !backupOpen;
        setBackupOpen(next);
        if (next && !backups && !backupLoading) void loadBackups();
      }

      async function createBackupNow() {
        setBackupBusy("create");
        try {
          const result = await backupCreate("面板手动备份");
          if (result) {
            notify("已创建备份：" + (str(result.name) || str(result.path) || "—"));
            await loadBackups();
            if (typeof refresh === "function") await refresh({ silent: true });
          }
        } catch (createError) {
          notify(describeError(createError), "error");
        } finally {
          setBackupBusy("");
        }
      }

      async function restoreBackup(backup) {
        setBackupBusy("restore:" + backup.name);
        try {
          const result = await backupRestore({ name: backup.name });
          if (result) {
            setRestoreConfirm("");
            notify(
              "已恢复到 " +
                (str(backup.name) || "备份") +
                "；原数据已另存：" +
                (str(result.safetyCopy) || "—") +
                "。请刷新页面以加载恢复后的数据。"
            );
            if (typeof refresh === "function") await refresh({ silent: true });
            await loadBackups();
          }
        } catch (restoreError) {
          notify(describeError(restoreError), "error");
        } finally {
          setBackupBusy("");
        }
      }

      async function exportDiagnostics() {
        setBackupBusy("diagnostics");
        try {
          const result = await diagnosticsExport();
          const mdPath = str(result && result.mdPath);
          setDiagnosticsPath(mdPath);
          notify(mdPath ? "已导出诊断包：" + mdPath : "已导出诊断包");
        } catch (diagnosticsError) {
          notify(describeError(diagnosticsError), "error");
        } finally {
          setBackupBusy("");
        }
      }

      function renderBackupCard() {
        const list = backups ? backups.backups : [];
        return h(
          "section",
          { className: "mrp-section mrp-backup" },
          h(
            "button",
            {
              type: "button",
              className: "mrp-fold-head",
              "aria-expanded": backupOpen ? "true" : "false",
              onClick: toggleBackupPanel,
              title: "展开/收起数据备份与诊断",
            },
            "🛟 数据与诊断",
            h("span", { className: "mrp-fold-chevron", "aria-hidden": "true" }, backupOpen ? "▴" : "▾")
          ),
          h("p", { className: "mrp-hint" }, backupSummary(list)),
          backupOpen
            ? h(
                "div",
                { className: "mrp-backup-body" },
                h(
                  "div",
                  { className: "mrp-form-actions" },
                  button(backupBusy === "create" ? "备份中…" : "立即备份", () => void createBackupNow(), {
                    primary: true,
                    key: "backup-create",
                    disabled: backupBusy !== "",
                  }),
                  button(backupLoading ? "读取中…" : "列出备份", () => void loadBackups(), {
                    subtle: true,
                    key: "backup-list",
                    disabled: backupLoading || backupBusy !== "",
                  }),
                  button(backupBusy === "diagnostics" ? "导出中…" : "导出诊断包", () => void exportDiagnostics(), {
                    subtle: true,
                    key: "diagnostics-export",
                    disabled: backupBusy !== "",
                  })
                ),
                backupError ? banner(backupError, "error", () => setBackupError("")) : null,
                diagnosticsPath
                  ? h("p", { className: "mrp-diagnostics-path mrp-mono" }, "已导出诊断包：" + diagnosticsPath)
                  : null,
                list.length === 0
                  ? h("p", { className: "mrp-hint" }, "还没有备份")
                  : h(
                      "div",
                      { className: "mrp-backups" },
                      list.map((backup) => {
                        const confirming = restoreConfirm === backup.name;
                        return h(
                          "div",
                          { className: "mrp-backup-row", key: backup.name || backup.path },
                          h(
                            "div",
                            { className: "mrp-backup-main" },
                            h("span", { className: "mrp-backup-name mrp-mono" }, backup.name || backup.path),
                            h("span", { className: "mrp-meta-item" }, formatShortTimestamp(backup.createdAt)),
                            h("span", { className: "mrp-meta-item" }, formatBytes(backup.bytes)),
                            h("span", { className: "mrp-meta-item" }, num(backup.counts.memories, 0) + " 条记忆")
                          ),
                          confirming
                            ? h(
                                "div",
                                { className: "mrp-confirm" },
                                h(
                                  "span",
                                  { className: "mrp-confirm-text" },
                                  "确认恢复？当前数据会先另存为安全副本，恢复后需刷新"
                                ),
                                button(
                                  backupBusy === "restore:" + backup.name ? "恢复中…" : "确认恢复",
                                  () => void restoreBackup(backup),
                                  { danger: true, key: "restore-confirm", disabled: backupBusy !== "" }
                                ),
                                button("取消", () => setRestoreConfirm(""), { subtle: true, key: "restore-cancel" })
                              )
                            : button("恢复", () => setRestoreConfirm(backup.name), {
                                subtle: true,
                                key: "restore",
                                disabled: backupBusy !== "",
                              })
                        );
                      })
                    ),
                h(
                  "p",
                  { className: "mrp-hint mrp-backup-note" },
                  "备份存在本机 ~/.mirror/backups；诊断包不含任何记忆/文档/对话正文。"
                )
              )
            : null
        );
      }

      function hitRatePercent(rate) {
        const value = num(rate, 0);
        return Math.round((value > 1 ? value : value * 100) * 10) / 10;
      }

      function renderBenchmark() {
        if (!benchmarkOpen) return null;
        if (benchmarkLoading) return h("div", { className: "mrp-benchmark" }, h("p", { className: "mrp-hint" }, "可达性测试中…"));
        if (benchmarkError) {
          return h(
            "div",
            { className: "mrp-benchmark" },
            banner(benchmarkError, "error", () => setBenchmarkError("")),
            button("重试", () => void runBenchmark(), { subtle: true, key: "benchmark-retry" })
          );
        }
        if (!benchmark) return null;
        if (num(benchmark.total, 0) === 0) {
          return h("div", { className: "mrp-benchmark" }, h("p", { className: "mrp-hint" }, "没有经验条目（先蒸馏 experiences）"));
        }
        const rate = hitRatePercent(benchmark.hitRate);
        const baselineRate = benchmark.baseline ? hitRatePercent(benchmark.baseline.hitRate) : null;
        const improvementPoints = Math.round((num(benchmark.improvement, 0) * 100) * 10) / 10;
        return h(
          "div",
          { className: "mrp-benchmark" },
          h(
            "div",
            { className: "mrp-benchmark-head" },
            h(
              "span",
              { className: "mrp-benchmark-main" },
              "命中 " + num(benchmark.hits, 0) + "/" + num(benchmark.total, 0) + "（" + rate + "%）· top" + num(benchmark.topK, 5)
            ),
            baselineRate === null
              ? null
              : h("span", { className: "mrp-hint" }, "对照（关闭向量）：" + baselineRate + "%"),
            baselineRate === null
              ? null
              : h("span", { className: "mrp-benchmark-up" }, "提升 " + improvementPoints + " 个百分点")
          ),
          asArray(benchmark.misses)
            .slice(0, 3)
            .map((miss, index) =>
              h(
                "div",
                { className: "mrp-benchmark-miss", key: "miss-" + index },
                "未命中：" + (truncate(miss.prompt, 40) || "（空 prompt）")
              )
            )
        );
      }

      async function mergePair(pair, keepSide) {
        const keep = keepSide === "b" ? pair.b : pair.a;
        const drop = keepSide === "b" ? pair.a : pair.b;
        setBatchRunning("merge:" + pair.key);
        try {
          const result = await mergeMemories(keep.id, drop.id);
          if (result) {
            setDuplicateConfirm(null);
            notify("已合并：保留 " + str(result.kept || keep.id) + "，关闭冲突 " + num(result.conflictsClosed, 0) + " 条");
            await loadDuplicates();
            await loadQuality();
            if (typeof refresh === "function") await refresh({ silent: true });
          }
        } catch (mergeError) {
          notify(describeError(mergeError), "error");
        } finally {
          setBatchRunning("");
        }
      }

      async function runBatch(group, mode) {
        const entries = group.items.map((conflict) => ({
          id: conflict.id,
          resolution: conflictBatchResolution(conflict, mode),
        }));
        setBatchRunning(group.key + ":" + mode);
        try {
          const outcome = await resolveConflictsSequentially(entries, mode === "local" ? "批量裁决：保留本地" : "批量裁决：采用新内容");
          setBatchConfirm(null);
          notify(
            "批量裁决完成：成功 " + outcome.ok + " 条" +
              (outcome.failed > 0 ? "，失败 " + outcome.failed + " 条" : "") +
              "（" + (mode === "local" ? "保留本地" : "采用新内容") + "）",
            outcome.failed > 0 ? "warn" : "ok"
          );
          if (typeof refresh === "function") await refresh({ silent: true });
          await loadQuality();
        } catch (batchError) {
          notify(describeError(batchError), "error");
        } finally {
          setBatchRunning("");
        }
      }

      async function loadQuality() {
        setQualityLoading(true);
        setQualityError("");
        try {
          const result = await qualityReport();
          setQuality(normalizeQualityReport(result && result.report));
        } catch (reportError) {
          setQualityError(describeError(reportError));
        } finally {
          setQualityLoading(false);
        }
      }

      useEffect(() => {
        if (props.initialQuality) return;
        void loadQuality();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      function renderQuality() {
        if (!quality) {
          return qualityError
            ? h(
                "section",
                { className: "mrp-quality" },
                banner(qualityError, "error", () => setQualityError("")),
                button("重新体检", () => void loadQuality(), { subtle: true, key: "quality-retry" })
              )
            : h("section", { className: "mrp-quality" }, h("p", { className: "mrp-hint" }, "质量体检中…"));
        }
        const tone = qualityTone(quality.score);
        const metrics = [
          { key: "experiences", label: "经验", value: quality.experiences },
          { key: "untrusted", label: "外部来源", value: quality.untrusted },
          { key: "duplicates", label: "近似重复对", value: quality.nearDuplicatePairs },
          { key: "conflicts", label: "未解冲突", value: quality.openConflicts },
          { key: "stale", label: "陈旧", value: quality.stale },
        ];
        return h(
          "section",
          { className: "mrp-quality", "aria-label": "质量体检" },
          h(
            "div",
            { className: "mrp-quality-head" },
            h(
              "div",
              { className: "mrp-quality-score", "data-tone": tone, title: "干净度 0–100，越高越干净" },
              "干净度 ",
              h("span", { className: "mrp-quality-num" }, String(quality.score)),
              h("span", { className: "mrp-quality-unit" }, "/100")
            ),
            button(qualityLoading ? "体检中…" : "重新体检", () => void loadQuality(), {
              subtle: true,
              key: "quality-refresh",
              disabled: qualityLoading,
              title: "重新计算质量体检报告",
            }),
            button(benchmarkLoading ? "测试中…" : "经验可达性", () => void runBenchmark(), {
              subtle: true,
              key: "benchmark-toggle",
              disabled: benchmarkLoading,
              title: "用经验条目做可达性 benchmark（top5）",
            })
          ),
          h(
            "div",
            { className: "mrp-quality-metrics" },
            h("span", { className: "mrp-quality-metric" }, "共 " + quality.total + " 条"),
            metrics.map((metric) =>
              metric.key === "duplicates" && metric.value > 0
                ? h(
                    "button",
                    {
                      key: metric.key,
                      type: "button",
                      className: "mrp-quality-metric mrp-quality-alert mrp-quality-dupe",
                      "aria-expanded": duplicatesOpen ? "true" : "false",
                      title: "展开近似重复对，逐对合并",
                      onClick: toggleDuplicates,
                    },
                    "· 近似重复对 " + metric.value + (duplicatesOpen ? " ▴" : " ▾")
                  )
                : h(
                    "span",
                    {
                      className: "mrp-quality-metric" + (metric.value > 0 ? " mrp-quality-alert" : ""),
                      key: metric.key,
                    },
                    "· " + metric.label + " " + metric.value
                  )
            )
          ),
          duplicatesOpen ? renderDuplicates() : null,
          renderBenchmark()
        );
      }

      function renderDuplicateSide(tag, side) {
        return h(
          "div",
          { className: "mrp-dupe-side" },
          h(
            "div",
            { className: "mrp-dupe-head" },
            h("span", { className: "mrp-dupe-tag" }, tag),
            badge(authorityLabel(side.authority), AUTHORITY_TONE[side.authority] || "neutral", side.id)
          ),
          h("p", { className: "mrp-dupe-text" }, truncate(side.content, 80) || "（内容缺失）"),
          h("div", { className: "mrp-hint mrp-dupe-meta" }, [side.id, side.scope].filter(Boolean).join(" · "))
        );
      }

      function renderDuplicates() {
        if (duplicatesLoading) {
          return h("div", { className: "mrp-duplicates" }, h("p", { className: "mrp-hint" }, "读取近似重复对…"));
        }
        if (duplicatesError) {
          return h("div", { className: "mrp-duplicates" }, banner(duplicatesError, "error", () => setDuplicatesError("")));
        }
        const pairs = duplicates ? duplicates.pairs : [];
        if (pairs.length === 0) {
          return h("div", { className: "mrp-duplicates" }, h("p", { className: "mrp-hint" }, "没有需要合并的近似重复对"));
        }
        return h(
          "div",
          { className: "mrp-duplicates" },
          pairs.map((pair) => {
            const confirmState = duplicateConfirm && str(duplicateConfirm.key) === pair.key ? asObject(duplicateConfirm) : null;
            const keep = confirmState ? (str(confirmState.keep) === "b" ? "b" : "a") : "a";
            const keepTag = keep === "b" ? "B" : "A";
            const dropTag = keep === "b" ? "A" : "B";
            const busy = batchRunning === "merge:" + pair.key;
            return h(
              "article",
              { className: "mrp-dupe", key: pair.key },
              h(
                "div",
                { className: "mrp-dupe-headline" },
                h("span", { className: "mrp-dupe-sim" }, "相似度 " + num(pair.similarity, 0).toFixed(2)),
                str(pair.a.scope) === str(pair.b.scope) ? h("span", { className: "mrp-hint" }, pair.a.scope || "global") : null
              ),
              h("div", { className: "mrp-dupe-pair" }, renderDuplicateSide("A", pair.a), renderDuplicateSide("B", pair.b)),
              confirmState
                ? h(
                    "div",
                    { className: "mrp-confirm" },
                    h(
                      "span",
                      { className: "mrp-confirm-text" },
                      "确认合并？" + dropTag + " 会被标记为被 " + keepTag + " 取代（可追溯，不物理删除）"
                    ),
                    button(busy ? "合并中…" : "确认合并", () => void mergePair(pair, keep), {
                      danger: true,
                      key: "merge-confirm",
                      disabled: busy,
                    }),
                    button("取消", () => setDuplicateConfirm(null), { subtle: true, key: "merge-cancel" })
                  )
                : h(
                    "div",
                    { className: "mrp-dupe-actions" },
                    button("保留 A 合并 B", () => setDuplicateConfirm({ key: pair.key, keep: "a" }), {
                      subtle: true,
                      key: "keep-a",
                      disabled: busy,
                    }),
                    button("保留 B 合并 A", () => setDuplicateConfirm({ key: pair.key, keep: "b" }), {
                      subtle: true,
                      key: "keep-b",
                      disabled: busy,
                    })
                  )
            );
          })
        );
      }

      async function resolve(conflict, resolution) {
        const reason = resolution === "dismiss" ? "用户在面板忽略" : "";
        const result = await act(
          "conflict.resolve",
          { id: conflict.id, resolution: resolution, reason: reason },
          { key: "conflict.resolve:" + conflict.id }
        );
        if (result) notify("已记录裁决：" + resolutionLabel(resolution));
      }

      async function runStaleness() {
        const result = await act("staleness.check", {}, { key: "staleness.check" });
        if (result) notify("陈旧检测完成：检查 " + num(result.checked) + " 条，标记 " + asArray(result.stale).length + " 条待复核。");
      }

      function sideBlock(tag, side) {
        return h(
          "div",
          { className: "mrp-side", "data-side": tag.toLowerCase() },
          h("div", { className: "mrp-side-tag" }, tag + (side.isDoc ? " · 文档" : side.isPack ? " · 记忆包" : "")),
          h("div", { className: "mrp-side-content" }, side.content || "（内容缺失）"),
          h(
            "div",
            { className: "mrp-side-meta" },
            [side.categoryLabel || "", side.scope || "", side.id || ""].filter(Boolean).join(" · ")
          )
        );
      }

      function conflictCard(conflict) {
        const busyKey = "conflict.resolve:" + conflict.id;
        const disabled = conflict.resolved || isBusy(busyKey);
        return h(
          "article",
          { className: "mrp-conflict", key: conflict.id, "data-resolved": conflict.resolved ? "true" : "false" },
          h(
            "div",
            { className: "mrp-conflict-head" },
            badge(conflictTypeLabel(conflict.conflictType), conflict.conflictType === "contradiction" ? "error" : "warn"),
            h("span", { className: "mrp-conflict-time" }, "检测于 " + formatShortTimestamp(conflict.detectedAt)),
            conflict.severity ? badge("严重度 " + conflict.severity, "neutral") : null,
            conflict.resolved && conflict.resolution
              ? badge("已裁决：" + resolutionLabel(conflict.resolution), "ok")
              : badge("待裁决", "warn"),
            h("span", { className: "mrp-conflict-id mrp-mono" }, conflict.id)
          ),
          conflict.reason ? h("p", { className: "mrp-conflict-reason" }, conflict.reason) : null,
          h("div", { className: "mrp-compare" }, sideBlock("A", conflict.a), h("div", { className: "mrp-vs" }, "vs"), sideBlock("B", conflict.b)),
          h(
            "div",
            { className: "mrp-conflict-actions" },
            button("A 优先", () => resolve(conflict, "winner_a"), { subtle: true, disabled: disabled, key: "a" }),
            button("B 优先", () => resolve(conflict, "winner_b"), { subtle: true, disabled: disabled, key: "b" }),
            button("都保留", () => resolve(conflict, "both_valid"), { subtle: true, disabled: disabled, key: "both" }),
            button("都无效", () => resolve(conflict, "both_invalid"), { subtle: true, disabled: disabled, key: "invalid" }),
            button("忽略", () => resolve(conflict, "dismiss"), { subtle: true, disabled: disabled, key: "dismiss" })
          )
        );
      }

      function staleRow(memory) {
        return h(
          "div",
          { className: "mrp-stale", key: memory.id },
          h(
            "div",
            { className: "mrp-stale-main" },
            h("span", { className: "mrp-dot", "data-tone": "warn" }),
            h("span", { className: "mrp-stale-content" }, memory.content || "（内容缺失）"),
            h("span", { className: "mrp-meta-item" }, "创建于 " + formatShortTimestamp(memory.createdAt))
          ),
          h(
            "div",
            { className: "mrp-stale-actions" },
            button(
              "仍然有效",
              async () => {
                const result = await act("memory.confirm", { id: memory.id }, { key: "memory.confirm:" + memory.id });
                if (result) notify("已复核：这条记忆仍然有效。");
              },
              { subtle: true, disabled: isBusy("memory.confirm:" + memory.id), key: "confirm" }
            ),
            button(
              "已过时",
              async () => {
                const result = await act("memory.invalidate", { id: memory.id, reason: "陈旧复核：已过时" }, {
                  key: "memory.invalidate:" + memory.id,
                });
                if (result) notify("已标记失效。");
              },
              { subtle: true, disabled: isBusy("memory.invalidate:" + memory.id), key: "invalidate" }
            )
          )
        );
      }

      function renderConflictGroup(group) {
        const count = group.items.length;
        const confirming = batchConfirm && str(batchConfirm.groupKey) === group.key ? str(batchConfirm.mode) : "";
        const actions = [];
        if (count >= 2) {
          actions.push(
            button("全部保留本地", () => setBatchConfirm({ groupKey: group.key, mode: "local" }), {
              subtle: true,
              key: "batch-local",
              disabled: batchRunning !== "",
              title: "导入端输，保留你自己的记忆",
            }),
            button("全部采用新内容", () => setBatchConfirm({ groupKey: group.key, mode: "imported" }), {
              subtle: true,
              key: "batch-imported",
              disabled: batchRunning !== "",
              title: "导入端赢，采用新内容",
            })
          );
        }
        return h(
          "section",
          { className: "mrp-section", key: group.key },
          sectionHead(
            h(
              "span",
              { className: "mrp-group-title" },
              h("span", null, group.label),
              h("span", { className: "mrp-group-count" }, " · " + count + " 个冲突")
            ),
            actions,
            null
          ),
          h("p", { className: "mrp-hint mrp-group-source" }, "来源：" + conflictSourceLabel(group.key)),
          confirming
            ? h(
                "div",
                { className: "mrp-confirm" },
                h(
                  "span",
                  { className: "mrp-confirm-text" },
                  "将处理 " + count + " 条冲突（" + (confirming === "local" ? "保留本地" : "采用新内容") + "）"
                ),
                button(confirming === "local" ? "确认保留本地" : "确认采用新内容", () => void runBatch(group, confirming), {
                  danger: true,
                  key: "batch-confirm",
                  disabled: batchRunning !== "",
                }),
                button("取消", () => setBatchConfirm(null), { subtle: true, key: "batch-cancel" })
              )
            : null,
          h("div", { className: "mrp-list" }, group.items.map((conflict) => conflictCard(conflict)))
        );
      }

      return h(
        "div",
        { className: "mrp-stack" },
        renderQuality(),
        open.length === 0
          ? h(
              "section",
              { className: "mrp-section" },
              sectionHead("🤔 待裁决冲突", null, 0),
              emptyState("没有待裁决的冲突", "写入新记忆、导入记忆包或重新索引文档时，语义相反的条目会排到这里，AI 不做最终裁决。", null, "🤝")
            )
          : conflictGroups.map((group) => renderConflictGroup(group)),
        done.length
          ? h(
              "section",
              { className: "mrp-section" },
              sectionHead("已裁决（保留审计）", null, done.length),
              h("div", { className: "mrp-list" }, done.slice(0, 20).map((conflict) => conflictCard(conflict)))
            )
          : null,
        h(
          "section",
          { className: "mrp-section" },
          sectionHead(
            "⏳ 陈旧记忆",
            [button(isBusy("staleness.check") ? "检测中…" : "运行陈旧检测", runStaleness, { key: "staleness", disabled: isBusy("staleness.check") })],
            stale.length
          ),
          stale.length === 0
            ? h("p", { className: "mrp-hint" }, "没有超过 90 天未验证的记忆（冻结的记忆不参与判定）。")
            : h("div", { className: "mrp-list" }, stale.map((memory) => staleRow(memory)))
        ),
        renderBackupCard()
      );
    }

    // ------------------------------------------------------------------
    // 注入预览 Tab
    // ------------------------------------------------------------------

    function InjectTab(props) {
      const scope = props.scope;
      const [query, setQuery] = useState("");
      const [budget, setBudget] = useState("3000");
      const [result, setResult] = useState(() => (props.initialPreview ? asObject(props.initialPreview) : null));
      const [running, setRunning] = useState(false);
      const [error, setError] = useState(null);

      async function runPreview(queryOverride) {
        const nextQuery = queryOverride === undefined ? query : str(queryOverride);
        setRunning(true);
        setError(null);
        try {
          const data = await requestInjectPreview(buildInjectPreviewRequest(nextQuery, budget, scope));
          setResult(data);
        } catch (previewError) {
          setError(describeError(previewError));
          setResult(null);
        } finally {
          setRunning(false);
        }
      }

      function run(event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        return runPreview();
      }

      function useExample(example) {
        setQuery(example.label);
        void runPreview(example.label);
      }

      const sections = asArray(result && result.sections);
      const totalTokens =
        num(result && result.token_count, 0) ||
        sections.reduce((sum, section) => sum + num(section.tokens, 0), 0);
      // R12：权威裁决（新宿主才有）
      const authority = result ? normalizeInjectAuthority(result) : null;

      function renderAuthority() {
        if (!authority || !authority.mode) return null;
        const hiddenTotal = num(authority.hidden.memories, 0) + num(authority.hidden.docs, 0);
        return h(
          "div",
          { className: "mrp-authority" },
          h(
            "div",
            { className: "mrp-authority-head" },
            badge("权威模式：" + authorityModeLabel(authority.mode) + "（" + authority.mode + "）", "neutral", "注入时记忆与文档的权威顺序"),
            hiddenTotal > 0
              ? h(
                  "span",
                  { className: "mrp-authority-warn" },
                  "已按权威裁决隐藏 " +
                    hiddenTotal +
                    " 条冲突（记忆 " +
                    num(authority.hidden.memories, 0) +
                    " / 文档 " +
                    num(authority.hidden.docs, 0) +
                    "）"
                )
              : null
          ),
          authority.conflicts.length > 0
            ? h(
                "div",
                { className: "mrp-authority-list" },
                authority.conflicts.slice(0, 3).map((item, index) =>
                  h(
                    "div",
                    { className: "mrp-authority-row", key: index },
                    "[记忆] " + (truncate(item.memoryText, 40) || "（内容缺失）") + "  vs  [文档] " + (item.docPath || item.docKey || "（未知文档）") + "  →  " + item.winner + " 胜" + (item.reason ? "（" + item.reason + "）" : "")
                  )
                )
              )
            : null
        );
      }

      function sectionTone(name) {
        const key = str(name);
        if (key === "iron_rules") return "error";
        if (key === "documents") return "business";
        if (key === "preferences") return "ok";
        if (key === "pitfalls") return "warn";
        if (key === "decisions") return "business";
        return "dimmed";
      }

      function renderBudgetBar() {
        if (sections.length === 0) return null;
        return h(
          "div",
          { className: "mrp-budget-bar", role: "img", "aria-label": "注入预算分层占比" },
          sections.map((section) => {
            const tokens = num(section.tokens, 0);
            const width = totalTokens > 0 ? Math.max(2, (tokens / totalTokens) * 100) : 0;
            return h("span", {
              className: "mrp-budget-seg",
              key: str(section.name) || str(section.label),
              "data-tone": sectionTone(section.name),
              style: { width: width.toFixed(1) + "%" },
              title: str(section.label || section.name) + " " + tokens + " token / " + num(section.count, 0) + " 条",
            });
          })
        );
      }

      return h(
        "section",
        { className: "mrp-section" },
        sectionHead("🧪 注入预览", null, null),
        h(
          "p",
          { className: "mrp-hint" },
          "按当前 query 与 token 预算模拟宿主注入的文本。分层预算：铁律 40% → 文档 50%（占剩余）→ 偏好/决策/踩坑/模糊 用剩下的。"
        ),
        h(
          "div",
          { className: "mrp-examples" },
          h("span", { className: "mrp-examples-label" }, "试试："),
          INJECT_EXAMPLES.map((example) =>
            button(example.label, () => useExample(example), {
              subtle: true,
              key: example.key,
              className: "mrp-example",
              title: "用「" + example.label + "」预览注入",
              disabled: running,
            })
          )
        ),
        h(
          "form",
          { className: "mrp-inject-form", onSubmit: run },
          field(
            "检索 query",
            h("input", {
              className: "mrp-input mrp-input-grow",
              value: query,
              placeholder: "例如：接口为什么不能走 HTTP",
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
            })
          ),
          field(
            "token 预算",
            h("input", {
              className: "mrp-input mrp-input-num",
              type: "number",
              min: "200",
              step: "100",
              value: budget,
              onChange: (event) => setBudget(event.target.value),
            })
          ),
          button(running ? "预览中…" : "预览", null, { primary: true, submit: true, disabled: running, className: "mrp-inject-submit" })
        ),
        error ? banner(error, "error", () => setError(null)) : null,
        result
          ? h(
              "div",
              { className: "mrp-inject-result" },
              renderAuthority(),
              renderBudgetBar(),
              h(
                "div",
                { className: "mrp-chips" },
                h("span", { className: "mrp-chip mrp-chip-strong" }, "token 合计 " + num(result.token_count, 0)),
                h("span", { className: "mrp-chip" }, "scope " + scopeLabel(scope)),
                sections.map((section) =>
                  h(
                    "span",
                    { className: "mrp-chip", key: str(section.name) || str(section.label) },
                    str(section.label || section.name) + "：" + num(section.tokens, 0) + " token / " + num(section.count, 0) + " 条"
                  )
                )
              ),
              str(result.text)
                ? h("pre", { className: "mrp-pre mrp-preview" }, str(result.text))
                : h(
                    "p",
                    { className: "mrp-hint" },
                    "当前 query 没命中任何层：试试上面的示例，或把 token 预算调大。"
                  )
            )
          : null
      );
    }

    // ------------------------------------------------------------------
    // 样式（契约 §8.1：mrp- 前缀 + 只用 DSH 主题变量 + 每个 var() 都有 fallback）
    // ------------------------------------------------------------------

    const CSS = [
      ".mrp-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#16161a);color:var(--dsw-alias-label-primary,#e9e9ec);font-size:13px;line-height:1.55}",
      ".mrp-root *{box-sizing:border-box}",
      ".mrp-root button{font-family:inherit}",
      ".mrp-header{flex:none;padding:14px 16px 10px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a30)}",
      ".mrp-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".mrp-title{display:flex;align-items:baseline;gap:8px;font-size:15px;font-weight:600;letter-spacing:.01em;min-width:0}",
      ".mrp-title-sub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8a8a93);white-space:nowrap}",
      ".mrp-title-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mrp-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}",
      ".mrp-chip{padding:1px 8px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30);color:var(--dsw-alias-label-secondary,#b3b3bb);font-size:11px;white-space:nowrap}",
      ".mrp-chip-strong{color:var(--dsw-alias-label-primary,#e9e9ec);border-color:var(--dsw-alias-border-l2,#33333b)}",
      ".mrp-chip-ok{color:var(--dsw-alias-state-success-primary,#3fbf72);border-color:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-chip-error{color:var(--dsw-alias-state-error-primary,#f2555a);border-color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-data-dir{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-dimmed,#6b6b73);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".mrp-tabs{flex:none;display:flex;gap:2px;overflow-x:auto;padding:0 10px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a30);scrollbar-width:thin}",
      ".mrp-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:none;color:var(--dsw-alias-label-secondary,#b3b3bb);font-size:12.5px;padding:9px 10px 7px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}",
      ".mrp-tab:hover{color:var(--dsw-alias-label-primary,#e9e9ec);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}",
      ".mrp-tab[data-active=\"true\"]{color:var(--dsw-alias-label-primary,#e9e9ec);border-bottom-color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}",
      ".mrp-tab-count{font-size:10.5px;line-height:1.4;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2b2b33);color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 16px 32px;display:flex;flex-direction:column;gap:10px}",
      ".mrp-stack{display:flex;flex-direction:column;gap:18px}",
      ".mrp-section{display:flex;flex-direction:column;gap:10px}",
      ".mrp-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mrp-section-title{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-title-with-dot{display:inline-flex;align-items:center;gap:7px}",
      ".mrp-section-count{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-section-actions{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".mrp-section-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-list{display:flex;flex-direction:column;gap:8px}",
      ".mrp-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-dot[data-tone=\"error\"]{background:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-dot[data-tone=\"warn\"]{background:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-dot[data-tone=\"business\"]{background:var(--dsw-alias-state-business-primary,#4d8bfe)}",
      ".mrp-dot[data-tone=\"brand\"]{background:var(--dsw-alias-brand-primary,#7c5cff)}",
      ".mrp-dot[data-tone=\"success\"]{background:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-dot[data-tone=\"dimmed\"]{background:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-card{background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-lg,10px);padding:10px 12px;display:flex;flex-direction:column;gap:8px;transition:border-color .12s ease}",
      ".mrp-card:hover{border-color:var(--dsw-alias-border-l2,#33333b)}",
      ".mrp-card[data-status=\"superseded\"],.mrp-card[data-status=\"archived\"]{opacity:.72}",
      ".mrp-card-top{display:flex;align-items:flex-start;gap:10px}",
      ".mrp-card-main{display:flex;align-items:flex-start;gap:8px;min-width:0;flex:1 1 auto}",
      ".mrp-card-main .mrp-dot{margin-top:6px}",
      ".mrp-card-body{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".mrp-content{font-size:13px;color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-word;white-space:pre-wrap}",
      ".mrp-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-meta-item{white-space:nowrap}",
      ".mrp-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".mrp-badges{display:flex;flex-wrap:wrap;gap:5px;align-items:center}",
      ".mrp-badge{display:inline-flex;align-items:center;gap:3px;padding:0 6px;border-radius:var(--dsw-radius-sm,4px);font-size:10.5px;line-height:1.7;border:1px solid transparent;white-space:nowrap}",
      ".mrp-badge[data-tone=\"neutral\"]{background:var(--dsw-alias-bg-layer-2,#232329);border-color:var(--dsw-alias-border-l1,#2a2a30);color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-badge[data-tone=\"ok\"]{background:var(--dsw-alias-bg-layer-2,#232329);border-color:var(--dsw-alias-state-success-primary,#3fbf72);color:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-badge[data-tone=\"warn\"]{background:var(--dsw-alias-bg-layer-2,#232329);border-color:var(--dsw-alias-state-warn-primary,#e0a03a);color:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-badge[data-tone=\"error\"]{background:var(--dsw-alias-bg-layer-2,#232329);border-color:var(--dsw-alias-state-error-primary,#f2555a);color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-badge[data-tone=\"business\"]{background:var(--dsw-alias-bg-layer-2,#232329);border-color:var(--dsw-alias-state-business-primary,#4d8bfe);color:var(--dsw-alias-state-business-primary,#4d8bfe)}",
      ".mrp-tag{font-size:10.5px;padding:0 5px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-2,#232329);color:var(--dsw-alias-brand-primary,#4d6bfe);border:1px solid var(--dsw-alias-border-l1,#2a2a30)}",
      ".mrp-select-box{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93);cursor:pointer;flex:none;user-select:none}",
      ".mrp-select-box input{margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-card-actions{display:flex;flex-wrap:wrap;gap:6px;padding-top:2px}",
      ".mrp-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#232329);color:var(--dsw-alias-label-primary,#e9e9ec);font-size:12px;line-height:1.6;padding:3px 10px;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease}",
      ".mrp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));border-color:var(--dsw-alias-border-l3,#3d3d47)}",
      ".mrp-btn:disabled{opacity:.42;cursor:default}",
      ".mrp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}",
      ".mrp-btn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-bg-base,#ffffff);font-weight:500}",
      ".mrp-btn-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#3f7ef0);border-color:var(--dsw-alias-state-business-primary,#3f7ef0)}",
      ".mrp-btn-danger{border-color:var(--dsw-alias-state-error-primary,#f2555a);color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-btn-subtle{background:none;border-color:transparent;color:var(--dsw-alias-label-secondary,#b3b3bb);padding-left:6px;padding-right:6px}",
      ".mrp-btn-subtle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-input{height:30px;width:100%;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#232329);color:var(--dsw-alias-label-primary,#e9e9ec);font-size:12.5px;font-family:inherit;min-width:0}",
      ".mrp-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-input-num{width:120px}",
      ".mrp-input-grow{flex:1 1 220px;width:auto}",
      ".mrp-textarea{width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#232329);color:var(--dsw-alias-label-primary,#e9e9ec);font-size:12.5px;font-family:inherit;resize:vertical;min-height:64px}",
      ".mrp-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-select{height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#232329);color:var(--dsw-alias-label-primary,#e9e9ec);font-size:12px;cursor:pointer;font-family:inherit}",
      ".mrp-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-form{display:flex;flex-direction:column;gap:10px;padding:12px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-lg,10px)}",
      ".mrp-card-form{background:var(--dsw-alias-bg-layer-2,#232329)}",
      ".mrp-form-row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}",
      ".mrp-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:0 1 auto}",
      ".mrp-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-field-hint{font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-form-actions{display:flex;align-items:center;gap:8px}",
      ".mrp-inline-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
      ".mrp-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border:1px dashed var(--dsw-alias-state-error-primary,#f2555a);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#232329)}",
      ".mrp-confirm-text{font-size:12px;color:var(--dsw-alias-state-error-primary,#f2555a);flex:1 1 260px}",
      ".mrp-check{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb);cursor:pointer}",
      ".mrp-check input{accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-empty{display:flex;flex-direction:column;gap:4px;padding:18px 16px;border:1px dashed var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1,#1c1c21)}",
      ".mrp-empty-title{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-empty-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-banner{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);font-size:12px;border:1px solid transparent}",
      ".mrp-banner[data-tone=\"error\"]{background:var(--dsw-alias-bg-layer-1,#1c1c21);border-color:var(--dsw-alias-state-error-primary,#f2555a);color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-banner[data-tone=\"warn\"]{background:var(--dsw-alias-bg-layer-1,#1c1c21);border-color:var(--dsw-alias-state-warn-primary,#e0a03a);color:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-banner[data-tone=\"ok\"]{background:var(--dsw-alias-bg-layer-1,#1c1c21);border-color:var(--dsw-alias-state-success-primary,#3fbf72);color:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-banner-text{flex:1 1 auto;word-break:break-word;white-space:pre-wrap}",
      ".mrp-banner-close{appearance:none;border:0;background:none;color:inherit;font-size:15px;line-height:1;cursor:pointer;padding:0 2px;opacity:.7}",
      ".mrp-banner-close:hover{opacity:1}",
      ".mrp-skeleton{display:flex;flex-direction:column;gap:8px;padding-top:4px}",
      ".mrp-skeleton-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a93);margin-bottom:2px}",
      ".mrp-skeleton-row{height:34px;border-radius:var(--dsw-radius-md,8px);background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1,#1c1c21) 0%,var(--dsw-alias-bg-layer-2,#232329) 40%,var(--dsw-alias-bg-layer-1,#1c1c21) 80%);background-size:220% 100%;animation:mrp-shimmer 1.4s ease-in-out infinite}",
      ".mrp-skeleton-short{width:64%}",
      "@keyframes mrp-shimmer{0%{background-position:120% 0}100%{background-position:-40% 0}}",
      ".mrp-roots{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}",
      ".mrp-root-item{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px);flex-wrap:wrap}",
      ".mrp-root-path{font-size:12px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary,#e9e9ec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 220px;min-width:0}",
      ".mrp-root-count{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-doc-list{display:flex;flex-direction:column;gap:5px;max-height:420px;overflow-y:auto;padding:2px 0}",
      ".mrp-doc{padding:7px 10px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px);display:flex;flex-direction:column;gap:4px;flex:0 0 auto}",
      ".mrp-doc-main{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}",
      ".mrp-doc-path{font-size:12px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-all;flex:1 1 260px;min-width:0}",
      ".mrp-doc-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-doc-badges{display:flex;gap:5px;flex-wrap:wrap}",
      ".mrp-doc-error{font-size:11px;color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-links{display:flex;flex-direction:column;gap:6px}",
      ".mrp-link{display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-link-main{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0}",
      ".mrp-link-memory{font-size:12.5px;color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-word;flex:1 1 220px;min-width:0}",
      ".mrp-link-doc{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a93);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);word-break:break-all;flex:0 1 auto;max-width:100%}",
      ".mrp-link-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-results{display:flex;flex-direction:column;gap:6px}",
      ".mrp-result{background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px);overflow:hidden}",
      ".mrp-result-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;text-align:left;appearance:none;border:0;background:none;color:var(--dsw-alias-label-primary,#e9e9ec);font-family:inherit;font-size:12px;padding:8px 10px;cursor:pointer}",
      ".mrp-result-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}",
      ".mrp-result-path{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);word-break:break-all;flex:1 1 240px;min-width:0}",
      ".mrp-result-heading{font-size:11px;color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-result-score{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-result-toggle{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-snippet{margin:0;padding:0 10px 9px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb);word-break:break-word;white-space:pre-wrap}",
      ".mrp-pre{margin:0;padding:9px 10px;background:var(--dsw-alias-bg-layer-2,#232329);border-radius:var(--dsw-radius-md,8px);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#e9e9ec);white-space:pre-wrap;word-break:break-word;max-height:460px;overflow:auto}",
      ".mrp-preview{border:1px solid var(--dsw-alias-border-l1,#2a2a30)}",
      ".mrp-packs{display:flex;flex-direction:column;gap:6px}",
      ".mrp-pack{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-pack-main{display:flex;flex-wrap:wrap;align-items:center;gap:4px 9px;min-width:0;flex:1 1 320px}",
      ".mrp-pack-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-pack-version{font-size:11px;color:var(--dsw-alias-label-secondary,#b3b3bb);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".mrp-pack-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-export-path{font-size:11.5px;color:var(--dsw-alias-state-success-primary,#3fbf72);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);word-break:break-all}",
      ".mrp-conflict{display:flex;flex-direction:column;gap:9px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-lg,10px)}",
      ".mrp-conflict[data-resolved=\"true\"]{opacity:.72}",
      ".mrp-conflict-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 9px}",
      ".mrp-conflict-time{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-conflict-id{font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73);margin-left:auto}",
      ".mrp-conflict-reason{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-compare{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}",
      ".mrp-side{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#232329);border-radius:var(--dsw-radius-md,8px);border-left:2px solid var(--dsw-alias-border-l3,#3d3d47)}",
      ".mrp-side[data-side=\"a\"]{border-left-color:var(--dsw-alias-state-business-primary,#4d8bfe)}",
      ".mrp-side[data-side=\"b\"]{border-left-color:var(--dsw-alias-brand-primary,#7c5cff)}",
      ".mrp-side-tag{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a8a93);letter-spacing:.04em}",
      ".mrp-side-content{font-size:12.5px;color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-word;white-space:pre-wrap}",
      ".mrp-side-meta{font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);word-break:break-all}",
      ".mrp-vs{display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-dimmed,#6b6b73);padding:0 2px}",
      ".mrp-conflict-actions{display:flex;flex-wrap:wrap;gap:6px}",
      ".mrp-stale{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-stale-main{display:flex;align-items:center;gap:8px;flex:1 1 280px;min-width:0}",
      ".mrp-stale-content{font-size:12px;color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-word;flex:1 1 auto;min-width:0}",
      ".mrp-stale-actions{display:flex;gap:6px}",
      ".mrp-inject-form{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}",
      ".mrp-inject-form .mrp-field{flex:1 1 240px}",
      ".mrp-inject-submit{flex:none}",
      ".mrp-inject-result{display:flex;flex-direction:column;gap:8px}",
      /* ---- R2: 顶栏（品牌 / 全局搜索 / 压缩统计 / 最后更新） ---- */
      ".mrp-header{padding:10px 12px 8px}",
      ".mrp-topbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".mrp-brand{display:flex;align-items:center;gap:7px;flex:none;min-width:0}",
      ".mrp-brand-icon{display:inline-flex;color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-brand-name{font-size:14px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-brand-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93);white-space:nowrap}",
      ".mrp-search{position:relative;flex:1 1 200px;min-width:140px;max-width:360px}",
      ".mrp-search::before{content:'⌕';position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:13px;color:var(--dsw-alias-label-tertiary,#8a8a93);pointer-events:none}",
      ".mrp-search-input{width:100%;height:28px;padding:0 9px 0 24px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#232329);color:var(--dsw-alias-label-primary,#e9e9ec);font-size:12px;font-family:inherit}",
      ".mrp-search-input::placeholder{color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-search-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-search-pop{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:40;max-height:330px;overflow-y:auto;padding:6px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-lg,10px);box-shadow:var(--dsw-shadow-lv1,0 10px 28px rgba(0,0,0,.35))}",
      ".mrp-search-status{padding:10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-search-status[data-tone='error']{color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-search-group{display:flex;flex-direction:column;gap:2px;padding:2px 0}",
      ".mrp-search-group-head{padding:4px 8px 2px;font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a8a93);letter-spacing:.02em}",
      ".mrp-search-item{appearance:none;border:0;background:none;display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;padding:5px 8px;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-primary,#e9e9ec);font-family:inherit;font-size:12px;cursor:pointer}",
      ".mrp-search-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
      ".mrp-search-item-main{flex:1 1 auto;min-width:0;word-break:break-word}",
      ".mrp-search-item-meta{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-search-foot{padding:6px 8px 2px;font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73);border-top:1px solid var(--dsw-alias-border-l1,#2a2a30);margin-top:4px}",
      ".mrp-topbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mrp-updated{font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73);white-space:nowrap}",
      ".mrp-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#232329);color:var(--dsw-alias-label-primary,#e9e9ec);font-size:13px;line-height:1;cursor:pointer;padding:0}",
      ".mrp-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));border-color:var(--dsw-alias-border-l3,#3d3d47)}",
      ".mrp-icon-btn:disabled{opacity:.45;cursor:default}",
      ".mrp-select-scope{max-width:150px}",
      /* ---- R2: Tab 栏（横向滚动 + 两端渐隐 + 待确认红点） ---- */
      ".mrp-tabs-wrap{position:relative;flex:none}",
      ".mrp-tabs{display:flex;gap:2px;overflow-x:auto;padding:0 12px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a30);white-space:nowrap;scrollbar-width:none;-ms-overflow-style:none}",
      ".mrp-tabs::-webkit-scrollbar{display:none}",
      ".mrp-tab{flex:none;border-bottom:2px solid transparent}",
      ".mrp-tab[data-active='true']{border-bottom-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-tab-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#f2555a);display:inline-block;margin-left:2px;flex:none}",
      ".mrp-tabs-fade{position:absolute;top:0;bottom:1px;width:14px;pointer-events:none;z-index:2}",
      ".mrp-tabs-fade-l{left:0;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1,#1c1c21),transparent)}",
      ".mrp-tabs-fade-r{right:0;background:linear-gradient(270deg,var(--dsw-alias-bg-layer-1,#1c1c21),transparent)}",
      /* ---- R2: 批量选择操作条 ---- */
      ".mrp-selection-bar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 12px;background:var(--dsw-alias-bg-layer-2,#232329);border-bottom:1px solid var(--dsw-alias-border-l1,#2a2a30);animation:mrp-fade-in .12s ease}",
      ".mrp-selection-count{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-selection-warn{font-size:11.5px;color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-bulk-export{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;width:100%;padding-top:6px}",
      ".mrp-input-narrow{width:110px}",
      "@keyframes mrp-fade-in{from{opacity:0}to{opacity:1}}",
      /* ---- R2: 记忆卡片（3px 分类色条 + 三行截断 + 悬浮操作 + 右上徽标） ---- */
      ".mrp-card{border-left:3px solid var(--mrp-cat,var(--dsw-alias-border-l2,#33333b));padding:8px 10px;transition:border-color .12s ease,background .12s ease}",
      ".mrp-card[data-category='iron_rule']{--mrp-cat:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-card[data-category='preference']{--mrp-cat:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-card[data-category='decision']{--mrp-cat:var(--dsw-alias-state-business-primary,#4d8bfe)}",
      ".mrp-card[data-category='pitfall']{--mrp-cat:var(--dsw-alias-brand-primary,#7c5cff)}",
      ".mrp-card[data-category='fuzzy']{--mrp-cat:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-card:hover{background:var(--dsw-alias-bg-layer-2,#232329)}",
      ".mrp-card-highlight{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-alias-bg-layer-2,#232329)}",
      ".mrp-card-top{align-items:flex-start;gap:8px}",
      ".mrp-card-check{flex:none;display:inline-flex;align-items:center;padding-top:2px;cursor:pointer}",
      ".mrp-card-check input{accent-color:var(--dsw-alias-brand-primary,#4d6bfe);margin:0}",
      ".mrp-card-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:5px}",
      ".mrp-clamp3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;word-break:break-word}",
      ".mrp-card-badges{flex:none;display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;max-width:45%}",
      ".mrp-card-actions{opacity:0;pointer-events:none;transition:opacity .12s ease}",
      ".mrp-card:hover .mrp-card-actions,.mrp-card:focus-within .mrp-card-actions{opacity:1;pointer-events:auto}",
      ".mrp-meta{font-size:10.5px;gap:3px 8px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-meta-cat{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-autogrow{resize:none;overflow-y:auto}",
      /* ---- R2: 文档行展开 + 切片 ---- */
      ".mrp-doc{padding:0;overflow:hidden;flex:0 0 auto}",
      ".mrp-doc-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;width:100%;appearance:none;border:0;background:none;color:inherit;font-family:inherit;text-align:left;padding:6px 10px;cursor:pointer}",
      ".mrp-doc-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}",
      ".mrp-doc-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}",
      ".mrp-doc-caret{flex:none;width:10px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-doc-detail{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;border-top:1px dashed var(--dsw-alias-border-l2,#33333b)}",
      ".mrp-chunks{display:flex;flex-direction:column;gap:5px}",
      ".mrp-chunk{padding:6px 8px;background:var(--dsw-alias-bg-layer-2,#232329);border-radius:var(--dsw-radius-sm,4px)}",
      ".mrp-chunk-head{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-chunk-index{color:var(--dsw-alias-label-dimmed,#6b6b73);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".mrp-chunk-text{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb);white-space:pre-wrap;word-break:break-word}",
      ".mrp-doc-detail-foot{display:flex;justify-content:flex-end}",
      ".mrp-result-count{margin:0 0 2px}",
      /* ---- R2: 记忆包卡片 ---- */
      ".mrp-pack-meta-row{display:inline-flex;flex-wrap:wrap;gap:4px 9px;align-items:baseline}",
      ".mrp-pack-confirm{width:100%}",
      /* ---- R2: 统一空态 / 错误重试 / 无障碍细节 ---- */
      ".mrp-empty{align-items:flex-start;gap:5px}",
      ".mrp-empty-icon{font-size:18px;line-height:1;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-empty-title{font-size:12.5px;font-weight:600}",
      ".mrp-empty-action{margin-top:5px}",
      ".mrp-banner-retry{appearance:none;flex:none;border:1px solid currentColor;background:none;color:inherit;border-radius:var(--dsw-radius-sm,4px);font-size:11px;line-height:1.6;padding:0 7px;cursor:pointer;font-family:inherit}",
      ".mrp-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}",
      ".mrp-root ::-webkit-scrollbar{width:8px;height:8px}",
      ".mrp-root ::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3,#3d3d47);border-radius:4px}",
      ".mrp-root ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-root ::-webkit-scrollbar-track{background:transparent}",
      "@media (hover:none){.mrp-card-actions{opacity:1;pointer-events:auto}}",
      "@media (max-width:760px){.mrp-brand-sub{display:none}.mrp-meta{gap:2px 7px}.mrp-btn{height:22px;padding:0 8px;font-size:11.5px}.mrp-icon-btn{width:22px;height:22px;font-size:12px}.mrp-card-badges{max-width:100%}.mrp-topbar-actions{margin-left:0;width:100%}.mrp-search{max-width:none;flex-basis:100%}}",
      "@media (max-width:560px){.mrp-brand-sub{display:none}.mrp-updated{display:none}.mrp-tab{padding:8px 8px 6px;font-size:12px}}",
      "@media (prefers-reduced-motion:reduce){.mrp-root *{transition:none!important;animation:none!important}}",
      /* ---- R4: 常显操作 / 引导条 / 预算占比条 / 示例 ---- */
      ".mrp-btn-dimmed{color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-btn-dimmed:hover:not(:disabled){color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-card-actions{opacity:.55;pointer-events:auto}",
      ".mrp-card:hover .mrp-card-actions,.mrp-card:focus-within .mrp-card-actions{opacity:1}",
      ".mrp-intro{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-left:3px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#1c1c21);font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-intro-icon{flex:none;font-size:13px;line-height:1.6}",
      ".mrp-intro-text{flex:1 1 auto;min-width:0}",
      ".mrp-budget-bar{display:flex;width:100%;height:8px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30)}",
      ".mrp-budget-seg{display:block;height:100%;min-width:2px}",
      ".mrp-budget-seg[data-tone='error']{background:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-budget-seg[data-tone='business']{background:var(--dsw-alias-state-business-primary,#4d8bfe)}",
      ".mrp-budget-seg[data-tone='ok']{background:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-budget-seg[data-tone='warn']{background:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-budget-seg[data-tone='dimmed']{background:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-examples{display:flex;flex-wrap:wrap;align-items:center;gap:6px}",
      ".mrp-examples-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-example{font-size:11.5px}",
      /* ---- R5: 会话捕获 / 蒸馏画像 ---- */
      ".mrp-capture-stats{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:11px}",
      ".mrp-sessions{display:flex;flex-direction:column;gap:6px}",
      ".mrp-session{display:flex;flex-direction:column;gap:5px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-session-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}",
      ".mrp-session-id{flex:1 1 160px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-primary,#e9e9ec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mrp-session-turns{display:flex;flex-direction:column;gap:4px;padding-top:5px;border-top:1px dashed var(--dsw-alias-border-l2,#33333b)}",
      ".mrp-turn{display:flex;gap:6px;font-size:11.5px}",
      ".mrp-turn-role{flex:none;padding:0 5px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-1,#1c1c21);color:var(--dsw-alias-label-tertiary,#8a8a93);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".mrp-turn-role[data-role='user']{color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-turn-role[data-role='assistant']{color:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-turn-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary,#b3b3bb);white-space:pre-wrap;word-break:break-word}",
      ".mrp-distill-actions{display:flex;flex-wrap:wrap;gap:6px}",
      ".mrp-divider{height:1px;margin:2px 0;background:var(--dsw-alias-border-l1,#2a2a30)}",
      ".mrp-profile{display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-profile-summary{margin:0;font-size:12.5px;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-profile-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}",
      ".mrp-profile-group{display:flex;flex-direction:column;gap:4px;padding:7px 9px;background:var(--dsw-alias-bg-layer-2,#232329);border-left:2px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-sm,4px)}",
      ".mrp-profile-head{display:flex;align-items:center;justify-content:space-between;gap:6px}",
      ".mrp-profile-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-profile-label[data-tone='error']{color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-profile-label[data-tone='warn']{color:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-profile-label[data-tone='business']{color:var(--dsw-alias-state-business-primary,#4d8bfe)}",
      ".mrp-profile-label[data-tone='ok']{color:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-profile-label[data-tone='dimmed']{color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-profile-count{font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-profile-items{display:flex;flex-direction:column;gap:3px}",
      ".mrp-profile-item{font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb);word-break:break-word}",
      /* ---- R6: 蒸馏数据源（segmented / DSH 列表 / 来源徽标） ---- */
      ".mrp-source-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
      ".mrp-segmented{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#232329)}",
      ".mrp-seg{appearance:none;border:0;background:none;color:var(--dsw-alias-label-secondary,#b3b3bb);font-family:inherit;font-size:11.5px;line-height:1.6;padding:2px 9px;border-radius:var(--dsw-radius-sm,4px);cursor:pointer;transition:background .12s ease,color .12s ease}",
      ".mrp-seg:hover{color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-seg-active{background:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-bg-base,#ffffff)}",
      ".mrp-seg-active:hover{color:var(--dsw-alias-bg-base,#ffffff)}",
      ".mrp-source-hint{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-sources{display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-source-item{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-size:11.5px}",
      ".mrp-source-workspace{flex:1 1 160px;min-width:0;color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-word}",
      ".mrp-source-sid{color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-prep-sessions{display:flex;flex-direction:column;gap:4px;padding:8px 0 2px}",
      ".mrp-prep-session{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      /* ---- R7: authority 徽标 / AI 推断过滤 / 捕获容量 ---- */
      ".mrp-badge[data-tone='brand']{background:var(--dsw-alias-bg-layer-2,#232329);border-color:var(--dsw-alias-brand-primary,#7c5cff);color:var(--dsw-alias-brand-primary,#7c5cff)}",
      ".mrp-filter-chip{appearance:none;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:999px;background:none;color:var(--dsw-alias-label-secondary,#b3b3bb);font-family:inherit;font-size:11px;line-height:1.7;padding:0 9px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}",
      ".mrp-filter-chip:hover{color:var(--dsw-alias-label-primary,#e9e9ec);border-color:var(--dsw-alias-border-l3,#3d3d47)}",
      ".mrp-filter-chip-active{background:var(--dsw-alias-bg-layer-2,#232329);border-color:var(--dsw-alias-state-warn-primary,#e0a03a);color:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-capture-limits{margin-top:0;font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      /* ---- R8: 导出包含画像 ---- */
      ".mrp-profile-include{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:7px 9px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px);font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      /* ---- R15: 数据与诊断 / 首启引导 ---- */
      ".mrp-backup-body{display:flex;flex-direction:column;gap:8px;margin-top:8px}",
      ".mrp-backups{display:flex;flex-direction:column;gap:6px}",
      ".mrp-backup-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:7px 9px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-backup-main{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;flex:1 1 auto;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-backup-name{font-size:11.5px;color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-all}",
      ".mrp-backup-note,.mrp-diagnostics-path{font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73);word-break:break-all}",
      ".mrp-firstrun{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#33333b);border-left:3px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#1c1c21);font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-firstrun-icon{flex:none;font-size:13px}",
      ".mrp-firstrun-text{flex:1 1 auto;min-width:0}",
      ".mrp-firstrun-actions{display:flex;flex-wrap:wrap;gap:6px}",
      ".mrp-record-focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      /* ---- R9: 经验条目 / 导入拦截提示 ---- */
      ".mrp-exp{display:flex;flex-direction:column;gap:3px}",
      ".mrp-exp-row{display:flex;gap:7px;font-size:12px;line-height:1.55}",
      ".mrp-exp-label{flex:none;width:32px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a93);padding-top:1px}",
      ".mrp-exp-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-word}",
      ".mrp-exp-why{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary,#8a8a93);font-style:italic;word-break:break-word}",
      ".mrp-exp-boundary{flex:1 1 auto;min-width:0;color:var(--dsw-alias-state-warn-primary,#e0a03a);font-size:11.5px;word-break:break-word}",
      ".mrp-exp-evidence{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:11px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);word-break:break-all}",
      ".mrp-import-blocked{display:flex;flex-direction:column;gap:6px}",
      ".mrp-blocked-snippets{margin:0;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-state-error-primary,#f2555a);border-radius:var(--dsw-radius-md,8px);font-size:11px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#f2555a);white-space:pre-wrap;word-break:break-word}",
      /* ---- R10: 质量体检条 ---- */
      ".mrp-quality{display:flex;flex-direction:column;gap:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-lg,10px)}",
      ".mrp-quality-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".mrp-quality-score{display:inline-flex;align-items:baseline;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-quality-num{font-size:22px;font-weight:700;line-height:1;letter-spacing:-.02em}",
      ".mrp-quality-score[data-tone='ok'] .mrp-quality-num{color:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-quality-score[data-tone='warn'] .mrp-quality-num{color:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-quality-score[data-tone='error'] .mrp-quality-num{color:var(--dsw-alias-state-error-primary,#f2555a)}",
      ".mrp-quality-unit{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-quality-head .mrp-btn{margin-left:auto}",
      ".mrp-quality-metrics{display:flex;flex-wrap:wrap;gap:5px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-quality-metric{white-space:nowrap}",
      ".mrp-quality-alert{font-weight:600;color:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      /* ---- R11: 冲突分组 / 近似重复合并 ---- */
      ".mrp-group-title{display:inline-flex;align-items:baseline;gap:2px}",
      ".mrp-group-count{font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-group-source{margin-top:-4px;font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-quality-dupe{appearance:none;border:0;background:none;font-family:inherit;cursor:pointer;padding:0;text-align:left}",
      ".mrp-quality-dupe:hover{text-decoration:underline}",
      ".mrp-quality-dupe:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}",
      ".mrp-duplicates{display:flex;flex-direction:column;gap:8px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l2,#33333b)}",
      ".mrp-dupe{display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-dupe-headline{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-dupe-sim{font-weight:600;color:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-dupe-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".mrp-dupe-side{display:flex;flex-direction:column;gap:3px;min-width:0;padding:6px 8px;background:var(--dsw-alias-bg-layer-1,#1c1c21);border-radius:var(--dsw-radius-sm,4px)}",
      ".mrp-dupe-head{display:flex;align-items:center;gap:6px}",
      ".mrp-dupe-tag{font-size:10.5px;font-weight:600;color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-dupe-text{margin:0;font-size:11.5px;color:var(--dsw-alias-label-primary,#e9e9ec);word-break:break-word}",
      ".mrp-dupe-meta{font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73);word-break:break-all}",
      ".mrp-dupe-actions{display:flex;gap:6px;flex-wrap:wrap}",
      "@media (max-width:760px){.mrp-dupe-pair{grid-template-columns:1fr}}",
      /* ---- R12: 自动蒸馏 / 注入权威裁决 ---- */
      ".mrp-auto-distill{display:flex;flex-direction:column;gap:5px;margin-top:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-auto-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mrp-auto-head .mrp-btn{margin-left:auto}",
      ".mrp-auto-last{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-auto-note{font-size:10.5px;color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-authority{display:flex;flex-direction:column;gap:5px;padding:7px 9px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l1,#2a2a30);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-authority-head{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap}",
      ".mrp-authority-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#e0a03a)}",
      ".mrp-authority-list{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-authority-row{word-break:break-word}",
      /* ---- R13: PII 复核 / 经验可达性 ---- */
      ".mrp-review{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#232329);border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:var(--dsw-radius-md,8px)}",
      ".mrp-review-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mrp-review-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-review-block{display:flex;flex-direction:column;gap:4px}",
      ".mrp-review-row{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b3b3bb)}",
      ".mrp-review-label{font-weight:600;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-review-text{flex:1 1 auto;min-width:0;font-size:11px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-secondary,#b3b3bb);word-break:break-word}",
      ".mrp-review-toggle{flex:none;color:var(--dsw-alias-label-tertiary,#8a8a93)}",
      ".mrp-benchmark{display:flex;flex-direction:column;gap:4px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l2,#33333b)}",
      ".mrp-benchmark-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:11.5px}",
      ".mrp-benchmark-main{font-weight:600;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-benchmark-up{font-weight:600;color:var(--dsw-alias-state-success-primary,#3fbf72)}",
      ".mrp-benchmark-miss{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a93);word-break:break-word}",
      /* ---- R14: 界面瘦身（筛选行 / 折叠区 / 记录→蒸馏单卡） ---- */
      ".mrp-filter-row{display:flex;flex-wrap:wrap;gap:6px;margin:-2px 0 2px}",
      ".mrp-fold-head{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;appearance:none;border:0;background:none;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#e9e9ec);padding:2px 0;cursor:pointer;text-align:left}",
      ".mrp-fold-head:hover{color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".mrp-fold-chevron{flex:none;color:var(--dsw-alias-label-tertiary,#8a8a93);font-size:11px}",
      ".mrp-record-step{display:flex;flex-direction:column;gap:6px}",
      ".mrp-record-step-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mrp-step-no{flex:none;border:1px solid var(--dsw-alias-border-l2,#33333b);border-radius:999px;padding:0 6px;font-size:10px;letter-spacing:.05em;color:var(--dsw-alias-label-dimmed,#6b6b73)}",
      ".mrp-record-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#e9e9ec)}",
      ".mrp-advanced-body{display:flex;flex-direction:column;gap:10px;margin-top:8px}",
    ].join("");

    // ------------------------------------------------------------------
    // 挂载（契约 §8.2）
    // ------------------------------------------------------------------

    /** 宿主没有 effect 服务时直接执行并返回清理函数（自测/降级）。 */
    function mountEffect(ctx, factory, label) {
      const effect = ctx && typeof ctx.effect === "function" ? ctx.effect : null;
      if (effect) return effect(factory, label);
      const off = typeof factory === "function" ? factory() : null;
      return () => {
        if (typeof off === "function") off();
      };
    }

    function bindTranslator(ctx) {
      const locale = ctx && ctx.locale;
      if (locale && typeof locale.bind === "function") {
        try {
          return locale.bind(NS);
        } catch (bindError) {
          warn("locale.bind 失败，使用内置文案", bindError);
        }
      }
      return (key) => (COPY && COPY[key]) || String(key);
    }

    function mountStyles(ctx) {
      mountEffect(
        ctx,
        () => {
          if (typeof document === "undefined" || typeof document.createElement !== "function") return () => {};
          const previous =
            typeof document.getElementById === "function" ? document.getElementById("mirror-panel-style") : null;
          if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
          const tag = document.createElement("style");
          tag.id = "mirror-panel-style";
          tag.setAttribute("data-plugin", "mirror-dsh-adapter");
          tag.textContent = CSS;
          const host = document.head || document.body;
          host.appendChild(tag);
          return () => {
            if (tag.parentNode) tag.parentNode.removeChild(tag);
          };
        },
        "mirror: panel styles"
      );
    }

    function mountLocale(ctx) {
      const locale = ctx && ctx.locale;
      if (!locale || typeof locale.register !== "function") return;
      mountEffect(
        ctx,
        () => locale.register(NS, { zh: COPY, en: COPY }),
        "mirror: locale dictionaries"
      );
    }

    /**
     * 探测槽位后注册：ctx.slots.inject(name, cb) 只在该槽位存在时执行 cb；
     * 宿主没声明槽位就什么也不做（安静降级）。
     * 返回的清理函数同时撤掉注册与探测订阅，且可重复调用。
     */
    function observeSlot(ctx, slotName, spec, render) {
      let disposeRegister = null;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const off = disposeRegister;
        disposeRegister = null;
        if (typeof off === "function") {
          try {
            off();
          } catch (offError) {
            warn("卸载槽位 " + slotName + " 失败", offError);
          }
        }
      };
      const stopInject = ctx.slots.inject(slotName, () => {
        try {
          const off = ctx.slots.register(spec, render);
          disposeRegister = typeof off === "function" ? off : null;
        } catch (registerError) {
          warn("注册槽位 " + slotName + " 失败（宿主可能没有该槽位）", registerError);
          return () => {};
        }
        return release;
      });
      return () => {
        release();
        if (typeof stopInject === "function") {
          try {
            stopInject();
          } catch (stopError) {
            warn("撤掉槽位探测 " + slotName + " 失败", stopError);
          }
        }
      };
    }

    function safeRegister(ctx, spec, render) {
      try {
        const off = ctx.slots.register(spec, render);
        return typeof off === "function" ? off : null;
      } catch (registerError) {
        warn("注册槽位 " + spec.name + " 失败", registerError);
        return null;
      }
    }

    function mountSlots(ctx) {
      const slots = ctx && ctx.slots;
      if (!slots || typeof slots.register !== "function") {
        warn("宿主没有 slots 服务，Mirror 面板不会挂载（插件其余功能不受影响）");
        return;
      }
      const mainSpec = {
        name: "main",
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t: bindTranslator(ctx) }),
      };
      const rowSpec = {
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 10,
        label: () => COPY.nav,
        locale: NS,
      };
      const rowRender = (owner) => h(MirrorIcon, { size: owner && typeof owner.size === "number" ? owner.size : 16 });

      if (typeof slots.inject === "function") {
        mountEffect(
          ctx,
          () => observeSlot(ctx, "main", mainSpec, () => h(Panel)),
          "mirror: main panel"
        );
        mountEffect(
          ctx,
          () => observeSlot(ctx, "sidebar.panellist", rowSpec, rowRender),
          "mirror: sidebar entry"
        );
        return;
      }

      // 老宿主没有槽位探测能力：直接注册，失败就安静降级。
      mountEffect(
        ctx,
        () => {
          const offMain = safeRegister(ctx, mainSpec, () => h(Panel));
          const offRow = safeRegister(ctx, rowSpec, rowRender);
          return () => {
            if (typeof offMain === "function") offMain();
            if (typeof offRow === "function") offRow();
          };
        },
        "mirror: slots"
      );
    }

    function apply(ctx) {
      if (!ctx) {
        warn("apply(ctx) 没有收到上下文，面板不会挂载");
        return;
      }
      try {
        mountStyles(ctx);
      } catch (styleError) {
        warn("注入面板样式失败", styleError);
      }
      try {
        mountLocale(ctx);
      } catch (localeError) {
        warn("注册 locale 字典失败", localeError);
      }
      try {
        mountSlots(ctx);
      } catch (slotError) {
        warn("挂载 Mirror 面板失败（插件其余功能不受影响）", slotError);
      }
    }

    exports.name = "mirror-panel";
    exports.inject = ["slots", "locale", "theme"];
    exports.apply = apply;
    // 自测入口（tests/client-smoke.mjs 在 Node 里渲染组件用）
    exports.__Panel = Panel;
    exports.__MirrorIcon = MirrorIcon;
    exports.__internals = {
      NS: NS,
      PANEL_ID: PANEL_ID,
      API_BASE: API_BASE,
      CATEGORIES: CATEGORIES,
      TABS: TABS,
      CSS: CSS,
      api: api,
      requestJson: requestJson,
      normalizeState: normalizeState,
      normalizeMemory: normalizeMemory,
      normalizeConflict: normalizeConflict,
      normalizeLink: normalizeLink,
      normalizeCapture: normalizeCapture,
      AUTHORITY_TONE: AUTHORITY_TONE,
      AUTHORITY_TITLE: AUTHORITY_TITLE,
      formatBytes: formatBytes,
      clearCapture: clearCapture,
      pruneCapture: pruneCapture,
      normalizeDistillation: normalizeDistillation,
      normalizeProfile: normalizeProfile,
      PROFILE_GROUPS: PROFILE_GROUPS,
      DISTILL_SOURCES: DISTILL_SOURCES,
      distillSources: distillSources,
      buildDistillPayload: buildDistillPayload,
      normalizeDistillSession: normalizeDistillSession,
      updateCapture: updateCapture,
      readCapture: readCapture,
      dropCapture: dropCapture,
      captureStatus: captureStatus,
      runDistill: runDistill,
      normalizeSearchState: normalizeSearchState,
      normalizePackUpdates: normalizePackUpdates,
      normalizeExportMeta: normalizeExportMeta,
      fetchPackUpdates: fetchPackUpdates,
      searchAll: searchAll,
      exportMemories: exportMemories,
      profileSummary: profileSummary,
      packExportAvailability: packExportAvailability,
      packExportNotice: packExportNotice,
      packImportNotice: packImportNotice,
      importPack: importPack,
      importBlockedMessage: importBlockedMessage,
      normalizeQualityReport: normalizeQualityReport,
      qualityTone: qualityTone,
      qualityReport: qualityReport,
      undoDistill: undoDistill,
      distillDenoiseLines: distillDenoiseLines,
      conflictGroupOf: conflictGroupOf,
      conflictSourceLabel: conflictSourceLabel,
      isImportedSide: isImportedSide,
      conflictBatchResolution: conflictBatchResolution,
      resolveConflictsSequentially: resolveConflictsSequentially,
      normalizeDuplicates: normalizeDuplicates,
      qualityDuplicates: qualityDuplicates,
      mergeMemories: mergeMemories,
      normalizeAutoDistill: normalizeAutoDistill,
      autoDistillStatus: autoDistillStatus,
      updateAutoDistill: updateAutoDistill,
      runAutoDistillNow: runAutoDistillNow,
      normalizeInjectAuthority: normalizeInjectAuthority,
      authorityModeLabel: authorityModeLabel,
      profileEntryCount: profileEntryCount,
      normalizeStagePreview: normalizeStagePreview,
      stageDistill: stageDistill,
      listDistillReviews: listDistillReviews,
      applyDistillReview: applyDistillReview,
      discardDistillReview: discardDistillReview,
      reviewApplyNotice: reviewApplyNotice,
      normalizeBenchmark: normalizeBenchmark,
      qualityBenchmark: qualityBenchmark,
      backupCreate: backupCreate,
      backupListAll: backupListAll,
      backupRestore: backupRestore,
      diagnosticsExport: diagnosticsExport,
      importSamplePack: importSamplePack,
      normalizeBackups: normalizeBackups,
      backupSummary: backupSummary,
      SAMPLE_IMPORT_NOTICE: SAMPLE_IMPORT_NOTICE,
      isExperienceStructured: isExperienceStructured,
      normalizeExperience: normalizeExperience,
      distillSafetyNotice: distillSafetyNotice,
      normalizeSafety: normalizeSafety,
      buildScopeOptions: buildScopeOptions,
      scopeLabel: scopeLabel,
      PREFERENCE_FILTERS: PREFERENCE_FILTERS,
      moveTab: moveTab,
      dismissIntro: dismissIntro,
      resetIntro: resetIntro,
      INJECT_EXAMPLES: INJECT_EXAMPLES,
      buildInjectPreviewRequest: buildInjectPreviewRequest,
      requestInjectPreview: requestInjectPreview,
      formatTimestamp: formatTimestamp,
      formatClock: formatClock,
      autoRows: autoRows,
      formatConfidence: formatConfidence,
      describeError: describeError,
      tabCount: tabCount,
      RELATION_LABEL: RELATION_LABEL,
    };

    return module.exports;
  },
});
