/**
 * 生成面板静态预览：docs/panel-preview.html
 *
 * 用真实的 lib/client.js + react-dom/server，把九个 Tab 各渲染一遍，套上模拟 DSH
 * 深色主题的 CSS 变量，写成一个可以直接双击打开的 HTML。
 *
 * 用途：插件本体要等 dsh web 重启后才进 GUI，这份预览让人马上能看到面板长什么样
 * （假数据、不可交互）。
 *
 * 运行：node scripts/preview.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterRoot = path.resolve(here, "..");
const clientPath = path.join(adapterRoot, "lib", "client.js");
const outputPath = path.join(adapterRoot, "docs", "panel-preview.html");

const MODULE_ROOTS = [
  "$DSH_HOME\\profiles\\node_modules",
  "<dsh>\\dsh_plugins\\image-gen\\node_modules",
  "<dsh>\\dsh_plugins\\media-preview\\node_modules",
  "$DSH_HOME/profiles/web\\node_modules",
  adapterRoot,
];

function loadModule(id) {
  const errors = [];
  for (const root of MODULE_ROOTS) {
    try {
      return createRequire(path.join(root, "noop.js"))(id);
    } catch (error) {
      errors.push(`${root} -> ${error && error.code ? error.code : String(error)}`);
    }
  }
  throw new Error(`无法解析 ${id}：\n  ${errors.join("\n  ")}`);
}

const React = loadModule("react");
const { renderToStaticMarkup } = loadModule("react-dom/server");
const h = React.createElement;

// ---------------------------------------------------------------------------
// 假 window / document，把 client.js 当 classic script 执行
// ---------------------------------------------------------------------------

const head = {
  children: [],
  appendChild(node) {
    node.parentNode = head;
    head.children.push(node);
    return node;
  },
  removeChild(node) {
    const index = head.children.indexOf(node);
    if (index >= 0) head.children.splice(index, 1);
    return node;
  },
};

globalThis.document = {
  head,
  body: head,
  createElement(tag) {
    return {
      tagName: tag,
      id: "",
      textContent: "",
      setAttribute() {},
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
    };
  },
  getElementById(id) {
    return head.children.find((node) => node.id === id) || null;
  },
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (definition) => (captured = definition) } };
globalThis.fetch = async () => {
  throw new Error("预览模式不发网络请求");
};

new Function(fs.readFileSync(clientPath, "utf8"))();

// ---------------------------------------------------------------------------
// apply(ctx)：拿到样式与 locale 注册
// ---------------------------------------------------------------------------

const disposers = [];
/** apply() 期间面板会 register 一次字典；预览用它把 t(key) 翻成中文。 */
let dictionaries = null;
const NS_KEY = {};

function interpolate(text, params) {
  if (!params || typeof text !== "string") return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(callback, _label) {
    const dispose = callback();
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  },
  slots: {
    inject(_name, callback) {
      callback({});
      return () => {};
    },
    register(_spec, _component) {
      return () => {};
    },
  },
  locale: {
    register(namespace, dicts) {
      NS_KEY.name = namespace;
      dictionaries = dicts;
    },
    bind(namespace) {
      return (key, params) => {
        const table =
          (dictionaries && (dictionaries.zh || dictionaries["zh-CN"])) ||
          (dictionaries && (dictionaries.en || dictionaries[namespace])) ||
          {};
        const text = table[key];
        return interpolate(typeof text === "string" ? text : key, params);
      };
    },
  },
  theme: {
    on() {
      return () => {};
    },
    getTheme() {
      return "dark";
    },
  },
};

const exports_ = captured.factory((id) => loadModule(id));
exports_.apply(fakeCtx);

const styleNode = head.children.find((node) => node.id === "mirror-panel-style");
if (!styleNode) throw new Error("面板没有注入 <style id=mirror-panel-style>");

// ---------------------------------------------------------------------------
// 演示数据（形状与 /mirror/api/state 一致）
// ---------------------------------------------------------------------------

const now = Date.now();
const DAY = 86400_000;

function memory(overrides) {
  return {
    id: overrides.id,
    category: "preference",
    layer: "strategy",
    content: "",
    structured: null,
    confidence: 0.9,
    authority: "user_explicit",
    sourceType: "conversation",
    sourceRef: "11/02 对话#51",
    createdAt: now - 3 * DAY,
    lastVerifiedAt: now - 2 * DAY,
    lastAccessedAt: now - DAY,
    accessCount: 12,
    validFrom: now - 30 * DAY,
    validTo: null,
    expiresAt: null,
    frozen: false,
    causalParent: null,
    causalChildren: [],
    status: "active",
    supersededBy: null,
    scope: "global",
    tags: [],
    packId: null,
    packVersion: null,
    sourceDoc: null,
    docConflict: null,
    ...overrides,
  };
}

const memories = [
  memory({
    id: "m-iron-1",
    category: "iron_rule",
    content: "接口必须走 WebSocket，HTTP 轮询会丢消息",
    confidence: 1,
    authority: "user_explicit",
    sourceRef: "11/02 对话#51",
    tags: ["realtime", "架构"],
  }),
  memory({
    id: "m-iron-2",
    category: "iron_rule",
    content: "不用 any，用 unknown + 类型守卫",
    confidence: 0.97,
    authority: "user_confirmed",
    sourceRef: "10/28 对话#43",
    tags: ["typescript"],
  }),
  memory({
    id: "m-iron-3",
    category: "iron_rule",
    content: "高并发场景禁用方案A（8 万 QPS 下丢单）",
    confidence: 0.95,
    authority: "imported",
    sourceRef: "记忆包 · 支付系统红线 v1.2.0",
    packId: "pack_payment_redline",
    packVersion: "1.2.0",
    tags: ["支付", "并发"],
  }),
  memory({
    id: "m-pref-1",
    category: "preference",
    content: "我偏好中文注释 + 英文变量名，注释只写「为什么」不写「是什么」",
    confidence: 0.9,
    scope: "project:myapp",
    sourceRef: "11/05 对话#58",
    tags: ["style"],
  }),
  memory({
    id: "m-pref-2",
    category: "preference",
    content: "提交信息用 Conventional Commits，正文写影响面",
    confidence: 0.85,
    tags: ["git"],
  }),
  memory({
    id: "m-dec-1",
    category: "decision",
    content: "选 Vite 而不是 Webpack：冷启动 0.4s vs 8s，团队机器都吃得下",
    confidence: 0.9,
    layer: "fact",
    scope: "project:myapp",
    sourceRef: "11/06 决策记录",
    tags: ["构建"],
  }),
  memory({
    id: "m-pit-1",
    category: "pitfall",
    content: "Next.js 15 的 cookies() 已改成异步，忘记 await 会在构建期静默拿到空对象",
    confidence: 0.92,
    layer: "fragment",
    sourceRef: "11/07 踩坑",
    tags: ["nextjs", "breaking-change"],
    docConflict: "contradict",
    sourceDoc: "docs/next15-upgrade.md",
  }),
  memory({
    id: "m-fuzzy-1",
    category: "fuzzy",
    content: "你最近好像在考虑把状态管理从 Redux 换成 Zustand？",
    confidence: 0.55,
    authority: "inferred",
    sourceRef: "11/06 对话推断",
    pending: true,
  }),
];

const documents = [
  {
    id: "doc-1",
    filePath: "D:\\projects\\myapp\\docs\\next15-upgrade.md",
    relativePath: "docs/next15-upgrade.md",
    project: "myapp",
    fileType: "md",
    sizeBytes: 8421,
    lastModified: now - 2 * DAY,
    lastIndexed: now - 2 * DAY,
    chunkCount: 18,
    status: "active",
  },
  {
    id: "doc-2",
    filePath: "D:\\projects\\myapp\\docs\\coding-style.md",
    relativePath: "docs/coding-style.md",
    project: "myapp",
    fileType: "md",
    lastModified: now - 6 * DAY,
    lastIndexed: now - 6 * DAY,
    chunkCount: 9,
    status: "active",
  },
  {
    id: "doc-3",
    filePath: "D:\\projects\\myapp\\src\\api\\gateway.ts",
    relativePath: "src/api/gateway.ts",
    project: "myapp",
    fileType: "code",
    sizeBytes: 22_144,
    lastModified: now - 4 * 3600_000,
    lastIndexed: now - 3 * DAY,
    chunkCount: 27,
    status: "active",
    pendingStale: true,
  },
];

const conflicts = [
  {
    id: "c-1",
    memoryA: "m-pref-1",
    memoryB: "m-dec-1",
    conflictType: "contradiction",
    detectedAt: now - DAY,
    detectedBy: "arbiter",
    resolved: 0,
    resolution: null,
    resolutionReason: "分数接近（0.82 vs 0.79），需用户裁决",
    a: memories.find((m) => m.id === "m-pref-1"),
    b: memories.find((m) => m.id === "m-dec-1"),
  },
  {
    id: "c-2",
    memoryA: "m-pit-1",
    memoryB: "doc:doc-1",
    conflictType: "doc_updated",
    detectedAt: now - 2 * 3600_000,
    detectedBy: "doc_updated",
    resolved: 0,
    resolution: null,
    a: memories.find((m) => m.id === "m-pit-1"),
    b: null,
  },
];

const packs = [
  {
    id: "p-1",
    packId: "pack_payment_redline",
    packVersion: "1.2.0",
    packName: "支付系统安全红线",
    author: "pay-team",
    installedAt: now - 9 * DAY,
    scope: "global",
    memoryCount: 14,
    status: "active",
    source: "local",
  },
  {
    id: "p-2",
    packId: "pack_pythonic",
    packVersion: "0.8.0",
    packName: "Pythonic 风格",
    author: "community",
    installedAt: now - 20 * DAY,
    scope: "global",
    memoryCount: 9,
    status: "active",
    source: "local",
  },
];

const byCategory = { iron_rule: 3, preference: 2, decision: 1, pitfall: 1, fuzzy: 1 };

/** 文档 ↔ 记忆关联（/state.links，§10.3）：支持/矛盾各一条。 */
const links = [
  {
    id: "lnk-1",
    docId: "doc-2",
    chunkId: "chunk-2-4",
    memoryId: "m-iron-2",
    relation: "supports",
    detectedBy: "doc_updated",
    detectedAt: now - 3 * DAY,
    resolved: false,
    filePath: "D:\\projects\\myapp\\docs\\coding-style.md",
    relativePath: "docs/coding-style.md",
    headingPath: "TypeScript > 类型守卫",
    memoryContent: "不用 any，用 unknown + 类型守卫",
    memoryCategory: "iron_rule",
    memoryStatus: "active",
  },
  {
    id: "lnk-2",
    docId: "doc-1",
    chunkId: "chunk-1-12",
    memoryId: "m-pit-1",
    relation: "contradicts",
    detectedBy: "doc_updated",
    detectedAt: now - 2 * 3600_000,
    resolved: false,
    filePath: "D:\\projects\\myapp\\docs\\next15-upgrade.md",
    relativePath: "docs/next15-upgrade.md",
    headingPath: "Next.js 15 > cookies",
    memoryContent: "Next.js 15 的 cookies() 已改成异步，忘记 await 会在构建期静默拿到空对象",
    memoryCategory: "pitfall",
    memoryStatus: "active",
  },
];

const state = {
  ok: true,
  version: "2.0.0",
  scope: "all",
  dataDir: "C:\\Users\\me\\.mirror",
  stats: {
    memories: 8,
    active: 8,
    pendingConfirm: 2,
    conflicts: 2,
    documents: 3,
    chunks: 54,
    packs: 2,
    roots: 1,
    byCategory,
  },
  memories,
  conflicts,
  documents,
  roots: [{ path: "D:\\projects\\myapp", fileCount: 3, addedAt: now - 9 * DAY }],
  packs,
  links,
  stale: [memories.find((m) => m.id === "m-fuzzy-1")],
};

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const TABS = [
  ["iron_rule", "铁律"],
  ["preference", "偏好"],
  ["decision", "决策"],
  ["pitfall", "踩坑"],
  ["fuzzy", "模糊"],
  ["documents", "文档库"],
  ["links", "关联"],
  ["packs", "记忆包"],
  ["pending", "待确认"],
  ["inject", "注入预览"],
];

const sections = TABS.map(([tab, label]) => {
  let markup;
  try {
    markup = renderToStaticMarkup(h(exports_.__Panel, { initialData: state, initialTab: tab }));
  } catch (error) {
    markup = `<pre style="color:#f66">Tab ${tab} 渲染失败：${String(error && error.message ? error.message : error)}</pre>`;
  }
  return `<section class="preview-tab" id="tab-${tab}">
  <h2 class="preview-tab-title">${label} <span class="preview-tab-key">tab=${tab}</span></h2>
  <div class="preview-frame">${markup}</div>
</section>`;
}).join("\n");

/** 模拟 DSH 深色主题变量（真实值由宿主注入，这里只用于预览观感）。 */
const THEME_VARS = `
  --dsw-alias-bg-base: #17171a;
  --dsw-alias-bg-layer-1: #1e1e22;
  --dsw-alias-bg-layer-2: #24242a;
  --dsw-alias-bg-layer-3: #2b2b32;
  --dsw-alias-bg-module-platform: #202027;
  --dsw-alias-border-l1: #2e2e36;
  --dsw-alias-border-l2: #3a3a44;
  --dsw-alias-border-l3: #474753;
  --dsw-alias-border-l4: #575764;
  --dsw-alias-label-primary: #ececf1;
  --dsw-alias-label-secondary: #a8a8b4;
  --dsw-alias-label-tertiary: #7c7c88;
  --dsw-alias-label-dimmed: #5e5e6a;
  --dsw-alias-label-primary-foreground: #ffffff;
  --dsw-alias-brand-primary: #6ea8fe;
  --dsw-alias-link: #7cb0ff;
  --dsw-alias-button-primary-fill: #3b6fd4;
  --dsw-alias-interactive-bg-hover: #ffffff10;
  --dsw-alias-state-error-primary: #ff7b72;
  --dsw-alias-state-success-primary: #5bd18a;
  --dsw-alias-state-warn-primary: #f0b849;
  --dsw-alias-state-business-primary: #8b7bff;
  --dsw-alias-settings-card-fill: #22222a;
  --dsw-alias-settings-card-stroke: #33333d;
  --dsw-radius-sm: 6px;
  --dsw-radius-md: 10px;
  --dsw-radius-lg: 14px;
  --dsw-radius-xl: 18px;
  --dsw-shadow-lv1: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.25);
  --ds-font-family-code: ui-monospace, "Cascadia Code", Consolas, monospace;
`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Mirror 面板静态预览</title>
<style>
:root {${THEME_VARS}
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 24px 80px;
  background: #101013;
  color: var(--dsw-alias-label-primary);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.preview-head { max-width: 1120px; margin: 0 auto 28px; }
.preview-head h1 { font-size: 20px; margin: 0 0 6px; }
.preview-head p { margin: 0; color: var(--dsw-alias-label-secondary); }
.preview-note { margin-top: 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.preview-nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 0; }
.preview-nav a {
  color: var(--dsw-alias-label-secondary);
  text-decoration: none;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
}
.preview-nav a:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l3); }
.preview-tab { max-width: 1120px; margin: 0 auto 40px; }
.preview-tab-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
  margin: 0 0 10px;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.preview-tab-key { font: 11px var(--ds-font-family-code); color: var(--dsw-alias-label-dimmed); }
.preview-frame {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  min-height: 420px;
  overflow: hidden;
}
${styleNode.textContent}
</style>
</head>
<body>
<header class="preview-head">
  <h1>Mirror · 我对你的理解 — 面板静态预览</h1>
  <p>用真实 <code>lib/client.js</code> + <code>react-dom/server</code> 渲染，九个 Tab 各一份，数据是演示用的假数据。</p>
  <p class="preview-note">真实插件装进 DSH 后，这个面板出现在中央列，入口是左侧栏的 Mirror 图标；样式变量由宿主主题注入，这里用近似的深色值模拟。</p>
  <nav class="preview-nav">
    ${TABS.map(([tab, label]) => `<a href="#tab-${tab}">${label}</a>`).join("\n    ")}
  </nav>
</header>
${sections}
</body>
</html>
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html, "utf8");

const size = fs.statSync(outputPath).size;
console.log(`已生成：${outputPath}（${(size / 1024).toFixed(1)} KB，${TABS.length} 个 Tab）`);
for (const dispose of disposers) dispose();
