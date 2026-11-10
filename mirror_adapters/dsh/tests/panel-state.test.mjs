/**
 * 宿主 ↔ 面板 契约联调自测（Node，无需 DSH 进程、无需浏览器）。
 *
 * 与 client-smoke.mjs 的区别：这里 **不手写 fixture**，而是
 *   1. 用假 ctx + 假 webServer 把真实 lib/index.js 的 apply() 跑起来；
 *   2. 通过真实的 POST /mirror/api/action 造数据（五类记忆 + 一个冲突 + 文档目录 + 记忆包）；
 *   3. GET /mirror/api/state 拿到宿主半月真实产生的 payload；
 *   4. 用假的 window.__ModuleLoader__ 加载真实 lib/client.js，把这份 payload 喂给
 *      normalizeState + Panel，用 react-dom/server 渲染七个 Tab（R14 瘦身）。
 *
 * 断言：七个 Tab 都能渲染、铁律内容在、无统计 chips、待确认 Tab 有 A/B、文档库折叠区有 supports/contradicts；
 * 另外覆盖面板的容错：conflicts[].a/b 为 null（对端是文档）、tags 缺失、
 * documents 400 条不卡死、scope=project:xxx 的请求 URL 正确。
 *
 * 运行：node tests/panel-state.test.mjs
 * 退出码：全部通过 0，有失败 1。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterRoot = path.resolve(here, "..");
const clientPath = path.join(adapterRoot, "lib", "client.js");

// 临时数据目录：绝不污染真实 ~/.mirror
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-panel-state-"));
process.on("exit", () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------

const results = [];

function assertIncludes(haystack, needle, message) {
  const text = String(haystack);
  if (text.indexOf(needle) === -1) {
    throw new Error((message ? message + "：" : "") + "输出中缺少 " + JSON.stringify(needle));
  }
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("PASS  " + name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, message });
    console.log("FAIL  " + name + "\n      " + message.replace(/\n/g, "\n      "));
  }
}

// ---------------------------------------------------------------------------
// 假宿主（与 tests/host-integration.mjs 同形）
// ---------------------------------------------------------------------------

const routes = [];

const fakeWebServer = {
  register(route) {
    routes.push(route);
    return () => {
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
    };
  },
};

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(callback) {
    const dispose = callback();
    return typeof dispose === "function" ? dispose : () => {};
  },
  on() {
    return () => {};
  },
  tools: { register() {} },
  systemPrompt: { section() { return () => {}; } },
  inject(deps, callback) {
    if (deps.includes("webServer")) {
      callback({ effect: (cb) => cb(), webServer: fakeWebServer });
    }
  },
};

/** 调用宿主真正注册的路由；handler 必须是函数（withCore 修复后的契约）。 */
async function callRoute(method, url, body) {
  const pathname = url.split("?")[0];
  const exact = routes.find((route) => route.kind === "exact" && route.path === pathname);
  const prefix = routes
    .filter((route) => route.kind === "prefix" && (pathname === route.path || pathname.startsWith(route.path + "/")))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const route = exact || prefix;
  assert.ok(route, "没有匹配的路由：" + method + " " + url);
  assert.equal(typeof route.handler, "function", "路由 handler 必须是函数（withCore 不能再是 async 工厂）");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("路由超时：" + url)), 20000);
    const response = {
      statusCode: 0,
      headers: {},
      body: "",
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers || {};
      },
      end(text) {
        clearTimeout(timer);
        this.body = typeof text === "string" ? text : "";
        let json = null;
        try {
          json = JSON.parse(this.body);
        } catch {
          json = null;
        }
        resolve({ status: this.statusCode, json, body: this.body });
      },
    };
    const request = {
      method,
      url,
      headers: { "content-type": "application/json" },
      socket: { remoteAddress: "127.0.0.1" },
      on(event, callback) {
        if (event === "data" && body !== undefined) callback(Buffer.from(JSON.stringify(body), "utf8"));
        if (event === "end") callback();
        return this;
      },
      destroy() {},
    };
    Promise.resolve(route.handler(request, response)).catch(reject);
  });
}

async function action(type, payload) {
  const { status, json } = await callRoute("POST", "/mirror/api/action", Object.assign({ type }, payload || {}));
  assert.equal(status, 200, type + " HTTP 状态");
  assert.ok(json, type + " 返回体不是 JSON");
  return json;
}

// ---------------------------------------------------------------------------
// 加载客户端半月：真实 lib/client.js + 真实 react
// ---------------------------------------------------------------------------

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
      errors.push(root + " -> " + (error && error.code ? error.code : String(error)));
    }
  }
  throw new Error("无法解析 " + id + "：\n  " + errors.join("\n  "));
}

const React = loadModule("react");
const serverRenderer = loadModule("react-dom/server");
const h = React.createElement;

const fakeHead = {
  children: [],
  appendChild(node) {
    node.parentNode = fakeHead;
    fakeHead.children.push(node);
    return node;
  },
  removeChild(node) {
    const index = fakeHead.children.indexOf(node);
    if (index >= 0) fakeHead.children.splice(index, 1);
    node.parentNode = null;
    return node;
  },
};

globalThis.document = {
  head: fakeHead,
  body: fakeHead,
  createElement() {
    return {
      id: "",
      textContent: "",
      attributes: {},
      parentNode: null,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
    };
  },
  getElementById(id) {
    return fakeHead.children.find((node) => node.id === id) || null;
  },
};

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
};

new Function(fs.readFileSync(clientPath, "utf8"))();

const client = captured.factory((id) => loadModule(id));

// 假浏览器 fetch：默认返回空对象；需要断言的用例各自安装自己的 stub。
globalThis.fetch = async () => {
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
};

// ---------------------------------------------------------------------------
// 启动宿主半月 + 造真实数据
// ---------------------------------------------------------------------------

const host = await import("file:///" + path.join(adapterRoot, "lib", "index.js").replace(/\\/g, "/"));
host.apply(ctx, { dataDir: tmpDir, injectTokenBudget: 1200 });
await new Promise((resolve) => setTimeout(resolve, 250));

const IRON_CONTENT = "接口必须走 WebSocket，HTTP 会丢消息";
const PREP_CONTENT = "不要再用 any，改成 unknown + 类型守卫";
const CONFLICT_CONTENT = "接口不要走 WebSocket，用 HTTP 轮询即可";

const iron = await action("memory.create", { content: IRON_CONTENT, category: "iron_rule", scope: "global", tags: ["ws", "archi"] });
const preference = await action("memory.create", { content: PREP_CONTENT, category: "preference", scope: "project:myapp", tags: ["ts"] });
await action("memory.create", { content: "面板新增记忆统一走 POST /mirror/api/action", category: "decision", tags: ["api"] });
await action("memory.create", { content: "SQLite WAL 下不要在事务里再开事务", category: "pitfall", tags: ["sqlite"] });
await action("memory.create", { content: "用户在考虑把 Redux 换掉", category: "fuzzy" });
// 与第一条铁律语义相反 → 宿主侧应该产生一条 contradiction 冲突
const contradiction = await action("memory.create", { content: CONFLICT_CONTENT, category: "iron_rule", scope: "global" });

const addedRoot = await action("doc.addRoot", { path: path.join(adapterRoot, "docs") });

const exported = await action("pack.export", {
  memoryIds: [iron.memory.id],
  meta: { name: "Panel 联调演示包", version: "1.0.1", author: "panel-dev", description: "联调自测", category: "framework" },
});
const installed = await action("pack.import", { path: exported.path, strategy: "skip_conflicts" });

const state = await callRoute("GET", "/mirror/api/state", undefined);
const payload = state.json;

// ---------------------------------------------------------------------------
// 联调用例
// ---------------------------------------------------------------------------

await check("宿主路由 handler 都是函数（withCore 修复生效）", () => {
  assert.ok(routes.length >= 5, "注册路由过少：" + routes.length);
  for (const route of routes) assert.equal(typeof route.handler, "function", route.kind + ":" + route.path + " 的 handler");
});

await check("宿主半月造数据成功：五类记忆 + 冲突 + 目录 + 记忆包", () => {
  assert.equal(iron.ok, true, "iron create");
  assert.equal(preference.ok, true, "preference create");
  assert.ok(Array.isArray(contradiction.conflicts) && contradiction.conflicts.length > 0, "矛盾的两条铁律应产生冲突");
  assert.ok(addedRoot.ok && addedRoot.scan, "doc.addRoot");
  assert.ok(addedRoot.scan.added >= 1, "文档目录应至少索引到示例文档");
  assert.ok(exported.ok && exported.path, "pack.export 应返回 path");
  assert.ok(installed.ok, "pack.import");
});

await check("GET /state：形状、统计、冲突的 a/b 记忆对象", () => {
  assert.equal(state.status, 200, "HTTP 状态");
  assert.equal(payload.ok, true, "ok");
  assert.equal(payload.scope, "all", "未指定 scope 时服务端返回 all");
  assert.ok(Array.isArray(payload.memories) && payload.memories.length >= 6, "memories 数量：" + payload.memories.length);
  assert.ok(payload.conflicts.length >= 1, "conflicts 至少 1 条");
  // listConflicts 按 detectedAt 倒序：导入记忆包会新产生 pack_updated 冲突，所以要按类型找。
  const contradictionConflict = payload.conflicts.find((item) => item.conflictType === "contradiction");
  assert.ok(contradictionConflict, "应存在 contradiction 冲突，实际类型：" + JSON.stringify(payload.conflicts.map((item) => item.conflictType)));
  assert.ok(contradictionConflict.a && typeof contradictionConflict.a.content === "string", "listConflicts 应附带 a 记忆对象");
  assert.ok(contradictionConflict.b && typeof contradictionConflict.b.content === "string", "listConflicts 应附带 b 记忆对象");
  assert.ok(
    payload.conflicts.some((item) => item.conflictType === "pack_updated"),
    "导入记忆包应产生 pack_updated 冲突"
  );
  assert.equal(typeof payload.stats.memories, "number", "stats.memories");
  assert.equal(typeof payload.stats.documents, "number", "stats.documents");
  assert.ok(payload.stats.pendingConfirm >= 1, "stats.pendingConfirm");
  assert.ok(payload.stats.byCategory.iron_rule >= 2, "stats.byCategory.iron_rule");
  // R1 §10.4：/state 增加 links（listLinks 未实现时宿主也返回空数组）
  assert.ok(Array.isArray(payload.links), "links 必须是数组");
});

await check("GET /state?scope=project:myapp 只返回该作用域的 active 记忆", async () => {
  const scoped = await callRoute("GET", "/mirror/api/state?scope=project%3Amyapp", undefined);
  assert.equal(scoped.status, 200, "HTTP 状态");
  assert.equal(scoped.json.scope, "project:myapp", "scope 回显");
  assert.ok(scoped.json.memories.length >= 1, "应至少返回 1 条 project 记忆");
  for (const memory of scoped.json.memories) assert.equal(memory.scope, "project:myapp", "memory.scope：" + memory.content);
});

await check("R14：渲染真实 payload：七个 Tab + 顶栏（无统计 chips）", () => {
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "iron_rule" }));
  assertIncludes(markup, ">Mirror<", "品牌名");
  assertIncludes(markup, "我对你的理解 · v2.0", "副标题");
  assertIncludes(markup, "搜索记忆与文档（Enter）", "全局搜索框");
  for (const label of ["铁律", "偏好", "踩坑", "文档库", "记忆包", "待确认", "注入预览"]) {
    assertIncludes(markup, label, "Tab 名称：" + label);
  }
  assert(markup.indexOf('data-chip="') === -1, "顶栏不再有统计 chips");
  assertIncludes(markup, "mrp-tabs-wrap", "Tab 横向滚动容器");
});

await check("批量导出：面板参数用真实选中 id，且真实宿主接受该请求", async () => {
  const ids = payload.memories.slice(0, 2).map((memory) => memory.id);
  assert.ok(ids.length === 2, "需要至少 2 条记忆");
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, path: "C:\\tmp\\panel-export.mirrorpack" }) };
  };
  await client.__internals.exportMemories(ids, { name: "面板联调包", version: "2.3.0", author: "panel-dev" });
  assert.equal(calls.length, 1, "导出请求次数");
  assert.equal(calls[0].url, "/mirror/api/action", "action URL");
  assert.equal(calls[0].init.method, "POST", "method");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.type, "pack.export", "action type");
  assert.deepEqual(body.memoryIds, ids, "memoryIds 用选中 id");
  assert.equal(body.meta.name, "面板联调包", "meta.name");
  assert.equal(body.meta.version, "2.3.0", "meta.version");
  assert.equal(body.meta.author, "panel-dev", "meta.author");
  assert.equal(body.meta.description, "", "meta.description 默认空串");
  assert.equal(body.meta.category, "framework", "meta.category 默认值");

  // 同一份 payload 交给真实宿主动作，确认服务端确实接受面板的参数形状。
  const real = await action("pack.export", { memoryIds: ids, meta: body.meta });
  assert.equal(real.ok, true, "真实 pack.export 应成功");
  assert.ok(real.path, "真实 pack.export 应返回 path");
  assert.ok(Array.isArray(real.pack && real.pack.memories) && real.pack.memories.length >= 2, "导出包应包含选中的记忆");
});

await check("铁律 Tab：真实内容 + 元信息 + 操作按钮", () => {
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "iron_rule" }));
  assertIncludes(markup, IRON_CONTENT, "铁律内容");
  assertIncludes(markup, "置信度 100%", "置信度");
  assertIncludes(markup, "用户显式", "authority");
  assertIncludes(markup, "#ws", "tag");
  for (const label of ["编辑", "确认", "冻结", "失效", "删除"]) assertIncludes(markup, label, "卡片操作：" + label);
});

await check("待确认 Tab：A/B 两条真实内容 + 五个裁决按钮", () => {
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "pending" }));
  const conflict = payload.conflicts.find((item) => item.conflictType === "contradiction");
  assert.ok(conflict, "应存在 contradiction 冲突");
  assertIncludes(markup, conflict.a.content, "A 侧内容");
  assertIncludes(markup, conflict.b.content, "B 侧内容");
  for (const label of ["A 优先", "B 优先", "都保留", "都无效", "忽略"]) assertIncludes(markup, label, "裁决按钮：" + label);
  assertIncludes(markup, "待裁决", "状态徽标");
  assertIncludes(markup, "内容矛盾", "冲突类型");
  assertIncludes(markup, "记忆包更新", "pack_updated 冲突类型");
});

await check("文档库 Tab：真实文档路径 + 切片数 + 状态徽标", () => {
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "documents" }));
  const doc = payload.documents.find((item) => String(item.filePath).indexOf("mirror-smoke.md") >= 0) || payload.documents[0];
  const label = doc.relativePath || doc.filePath;
  assertIncludes(markup, label, "文档行（优先 relativePath）");
  assertIncludes(markup, doc.chunkCount + " 切片", "切片数");
  assertIncludes(markup, "已索引", "状态徽标");
  assertIncludes(markup, "添加目录", "添加目录入口");
  assertIncludes(markup, "重新索引全部", "重新索引入口");
});

await check("R14：记忆包 Tab 真实已安装包 + 高级区展开后导入/导出", () => {
  const markup = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: payload, initialTab: "packs", initialAdvancedOpen: true })
  );
  const pack = payload.packs[0];
  assert.ok(pack, "应有已安装记忆包");
  assertIncludes(markup, pack.packName, "包名");
  assertIncludes(markup, "v" + pack.packVersion, "版本");
  if (pack.author) assertIncludes(markup, pack.author, "作者");
  assertIncludes(markup, "卸载", "卸载按钮");
  assertIncludes(markup, "导入记忆包", "导入区");
  assertIncludes(markup, "导出选中记忆为记忆包", "导出区");
});

await check("R5：/state 带 capture/distillation 时记忆包 Tab 渲染不报错", () => {
  assert.ok(payload.capture && typeof payload.capture === "object", "/state 应返回 capture 对象");
  assert.ok(payload.capture.sessions === 0 || typeof payload.capture.sessions === "number", "capture.sessions 是数字");
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "packs" }));
  assertIncludes(markup, "记录 → 蒸馏", "单卡渲染");
  assertIncludes(markup, "第一步", "捕获第一步");
  assertIncludes(markup, "第二步", "蒸馏第二步");
  assertIncludes(markup, "打开捕获后每轮对话存到本机 ~/.mirror/sessions（不上传）", "隐私说明");
  assertIncludes(markup, "蒸馏（对话 → 认知画像）", "蒸馏步骤渲染");
  if (payload.distillation) {
    assertIncludes(markup, "最近画像", "有画像时展示最近画像");
  } else {
    assertIncludes(markup, "还没有认知画像", "无画像时给空态");
  }
});

await check("R6：/state.dshSessions 存在或缺省都安全渲染", () => {
  // 新宿主会带 dshSessions；老宿主没有该字段时按 0 处理，不报错。
  if (payload.dshSessions !== undefined) {
    assert.ok(typeof payload.dshSessions === "number", "dshSessions 是数字");
  }
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "packs" }));
  assertIncludes(markup, "插件捕获", "数据源 capture");
  assertIncludes(markup, "DSH 历史会话", "数据源 dsh");
  assertIncludes(markup, "两者都蒸馏", "数据源 all");

  const withoutField = JSON.parse(JSON.stringify(payload));
  delete withoutField.dshSessions;
  const fallback = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: withoutField, initialTab: "packs", initialDistillSource: "dsh" })
  );
  assertIncludes(fallback, "检测到 0 个 DSH 历史会话", "缺字段时安全降级为 0");
  assertIncludes(fallback, "蒸馏只在本地解析，不写回、不上传", "隐私提示");
});

await check("R7：capture 的 bytes/turns/limits 缺失时安全降级", () => {
  const sparse = JSON.parse(JSON.stringify(payload));
  sparse.capture = { enabled: false, sessions: 0 };
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: sparse, initialTab: "packs" }));
  assertIncludes(markup, "0 个会话 · 0 轮 · 0 KB", "缺失字节/轮数按 0 渲染");
  assertIncludes(markup, "单会话超过 2MB 自动只保留最近部分；最多保留 100 个会话", "limits 默认值");

  if (payload.capture && payload.capture.limits) {
    assert.ok(typeof payload.capture.limits.maxSessions === "number", "真实 capture.limits.maxSessions 是数字");
  }
});

await check("R10：质量体检 report 缺字段安全降级 + 待确认 Tab 渲染不报错", () => {
  // 真实 /state 渲染待确认 Tab（质量报告在浏览器里懒加载，SSR 下显示体检中）
  const live = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "pending" }));
  assertIncludes(live, "待裁决", "待确认 Tab 正常渲染");

  // 注入一份缺字段的 report：不报错、缺省按 0
  const sparseReport = { score: 61 };
  const markup = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: payload, initialTab: "pending", initialQuality: sparseReport })
  );
  assertIncludes(markup, "干净度", "质量条渲染");
  assertIncludes(markup, "61", "分数");
  assertIncludes(markup, "共 0 条", "缺字段 total 按 0");
  assertIncludes(markup, 'data-tone="warn"', "61 分为黄色档");
});

await check("R11：conflicts 缺 group 时按「用户记忆」兜底；duplicates 失败安全降级", () => {
  const withoutGroup = JSON.parse(JSON.stringify(payload));
  for (const conflict of withoutGroup.conflicts) delete conflict.group;
  const markup = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: withoutGroup, initialTab: "pending" })
  );
  assertIncludes(markup, "用户记忆", "缺 group 兜底为「用户记忆」");
  assertIncludes(markup, "来源：user", "来源小字兜底");

  const failing = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, {
      initialData: payload,
      initialTab: "pending",
      initialQuality: { score: 70, nearDuplicatePairs: 2 },
      initialDuplicatesOpen: true,
      initialDuplicatesError: "读取近似重复失败（模拟）",
    })
  );
  assertIncludes(failing, "读取近似重复失败（模拟）", "duplicates 失败显示错误横幅");
  assertIncludes(failing, "质量体检", "质量条仍在");
});

await check("R12：autoDistill / inject authority 缺字段安全降级", () => {
  const withoutAuto = JSON.parse(JSON.stringify(payload));
  delete withoutAuto.autoDistill;
  const packs = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: withoutAuto, initialTab: "packs" })
  );
  assertIncludes(packs, "自动蒸馏未开启", "旧宿主缺 autoDistill 时按关闭渲染");
  assertIncludes(packs, "立即运行一次", "立即运行按钮仍在");

  const inject = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, {
      initialData: payload,
      initialTab: "inject",
      initialInjectPreview: { text: "注入文本", token_count: 12, scope: "all", sections: [] },
    })
  );
  assertIncludes(inject, "token 合计 12", "注入结果正常渲染");
  assert(inject.indexOf("权威模式：") === -1, "旧宿主缺 authority 字段时不渲染裁决区");
});

await check("R13：stage / benchmark 缺字段安全降级", () => {
  const noStage = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: payload, initialTab: "packs", initialApplyOpen: true })
  );
  assertIncludes(noStage, "解析并复核", "两段式主按钮");
  assertIncludes(noStage, "跳过复核直接提交", "跳过按钮");
  assert(noStage.indexOf("PII 复核") === -1, "没有 stage 时不渲染复核面板");

  const sparseBenchmark = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, {
      initialData: payload,
      initialTab: "pending",
      initialQuality: { score: 80 },
      initialBenchmarkOpen: true,
      initialBenchmark: { hits: 1 },
    })
  );
  assertIncludes(sparseBenchmark, "没有经验条目（先蒸馏 experiences）", "缺字段 total=0 时空态");

  const failingBenchmark = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, {
      initialData: payload,
      initialTab: "pending",
      initialQuality: { score: 80 },
      initialBenchmarkOpen: true,
      initialBenchmarkError: "可达性测试失败（模拟）",
    })
  );
  assertIncludes(failingBenchmark, "可达性测试失败（模拟）", "benchmark 失败显示错误");
});

await check("R15：backups 缺字段安全降级 + 首启引导空态渲染", () => {
  const pending = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: payload, initialTab: "pending" })
  );
  assertIncludes(pending, "🛟 数据与诊断", "备份卡片标题");
  assertIncludes(pending, "还没有备份", "无 backups 字段时按无备份渲染");
  assertIncludes(pending, 'aria-expanded="false"', "备份区默认折叠");

  const empty = {
    ok: true,
    version: "2.0.0",
    scope: "global",
    stats: { memories: 0, pendingConfirm: 0, documents: 0, packs: 0, byCategory: {} },
    memories: [],
    conflicts: [],
    documents: [],
    roots: [],
    packs: [],
    stale: [],
  };
  const guide = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: empty, initialTab: "iron_rule" }));
  assertIncludes(guide, "三步开始", "空态下渲染首启引导");
  assertIncludes(guide, "导入样例包", "样例动作");

  const normal = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "iron_rule" }));
  assert(normal.indexOf("三步开始") === -1, "有记忆时不显示首启引导");
});

await check("R14：文档库 Tab 内关联折叠区（默认收起 / 展开后空态）", () => {
  const collapsed = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: payload, initialTab: "documents" }));
  assertIncludes(collapsed, "文档 ↔ 记忆关联", "折叠区标题");
  assertIncludes(collapsed, 'aria-expanded="false"', "默认收起");
  const markup = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: payload, initialTab: "documents", initialLinksOpen: true })
  );
  assertIncludes(markup, "文档 ↔ 记忆关联", "区块标题");
  assertIncludes(markup, "支持 ", "统计：支持");
  assertIncludes(markup, "矛盾 ", "统计：矛盾");
  if (payload.links.length === 0) {
    assertIncludes(markup, "文档与记忆还没有建立关联", "空态标题");
  } else {
    assertIncludes(markup, "mrp-link", "关联行");
  }
});

await check("关联 Tab：supports/contradicts 关联行（记忆内容 + 文档相对路径 + 标题路径）", () => {
  const withLinks = clone(payload);
  const doc = withLinks.documents[0];
  const first = withLinks.memories[0];
  const second = withLinks.memories[1] || withLinks.memories[0];
  withLinks.links = [
    {
      id: "lnk_test_supports",
      docId: doc.id,
      chunkId: "chk_test_1",
      memoryId: first.id,
      relation: "supports",
      detectedBy: "doc_updated",
      detectedAt: Date.now(),
      resolved: 0,
      filePath: doc.filePath,
      relativePath: doc.relativePath,
      headingPath: "Install > Setup",
      memoryContent: first.content,
      memoryCategory: first.category,
      memoryStatus: first.status,
    },
    {
      id: "lnk_test_contradicts",
      docId: doc.id,
      chunkId: "chk_test_2",
      memoryId: second.id,
      relation: "contradicts",
      detectedBy: "doc_updated",
      detectedAt: Date.now() - 1000,
      resolved: 0,
      filePath: doc.filePath,
      relativePath: doc.relativePath,
      headingPath: "",
      memoryContent: second.content,
      memoryCategory: second.category,
      memoryStatus: second.status,
    },
  ];
  const markup = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: withLinks, initialTab: "documents", initialLinksOpen: true })
  );
  assertIncludes(markup, "支持 1", "支持统计");
  assertIncludes(markup, "矛盾 1", "矛盾统计");
  assertIncludes(markup, "支持", "支持徽标");
  assertIncludes(markup, "矛盾", "矛盾徽标");
  assertIncludes(markup, first.content, "支持侧记忆内容");
  assertIncludes(markup, second.content, "矛盾侧记忆内容");
  assertIncludes(markup, doc.relativePath || doc.filePath, "文档相对路径");
  assertIncludes(markup, "Install &gt; Setup", "标题路径（HTML 转义后）");
  assertIncludes(markup, "mrp-link", "关联行类名");
});

await check("记忆包更新：stub pack.checkUpdates 返回 available=true → 显示「更新可用 v<最新版>」", async () => {
  const pack = payload.packs[0];
  assert.ok(pack, "应有已安装记忆包");
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          updates: [
            {
              packId: pack.packId,
              packName: pack.packName,
              currentVersion: pack.packVersion,
              latestVersion: "2.0.0",
              available: true,
              source: "local",
              note: "本地文件",
            },
            {
              packId: "pack_without_update",
              packName: "无更新包",
              currentVersion: "1.0.0",
              latestVersion: null,
              available: false,
              source: "local",
              note: "本地包无法检查更新（需要更新服务）",
            },
          ],
        }),
    };
  };
  const updates = await client.__internals.fetchPackUpdates();
  assert.equal(calls.length, 1, "请求次数");
  assert.equal(calls[0].url, "/mirror/api/action", "action URL");
  assert.equal(JSON.parse(calls[0].init.body).type, "pack.checkUpdates", "action type");
  assert.equal(updates.length, 1, "只保留 available=true 的包");
  assert.equal(updates[0].packId, pack.packId, "packId");

  const markup = serverRenderer.renderToStaticMarkup(
    h(client.__Panel, { initialData: payload, initialTab: "packs", initialPackUpdates: updates })
  );
  assertIncludes(markup, "更新可用 v2.0.0", "更新可用徽标");
  assertIncludes(markup, 'title="本地文件"', "note 进入徽标 title");
  assertIncludes(markup, pack.packName, "已安装包列表不受影响");
});

// ---------------------------------------------------------------------------
// 容错 / 兼容性
// ---------------------------------------------------------------------------

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

await check("兼容：conflicts[].a/b 为 null（对端是 doc:<id>）仍能渲染文档侧", () => {
  const withDoc = clone(payload);
  const doc = withDoc.documents[0];
  withDoc.conflicts = [
    {
      id: "cf_doc_null",
      memoryA: withDoc.memories[0].id,
      memoryB: "doc:" + doc.id,
      conflictType: "doc_updated",
      detectedAt: Date.now(),
      detectedBy: "doc_updated",
      resolved: false,
      resolution: null,
      severity: "high",
      a: null,
      b: null,
    },
  ];
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: withDoc, initialTab: "pending" }));
  assertIncludes(markup, "B · 文档", "文档侧标签");
  assertIncludes(markup, doc.relativePath || doc.filePath, "文档路径");
  assertIncludes(markup, "文档已更新", "冲突类型");
  assertIncludes(markup, "A 优先", "裁决按钮仍在");
});

await check("兼容：memories[].tags 缺失或为空数组不崩", () => {
  const noTags = clone(payload);
  for (const memory of noTags.memories) {
    if (Array.isArray(memory.tags) && memory.tags.length === 0) delete memory.tags;
    else if (Array.isArray(memory.tags)) memory.tags = [];
  }
  delete noTags.memories[0].tags;
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: noTags, initialTab: "iron_rule" }));
  assertIncludes(markup, IRON_CONTENT, "铁律内容仍在");
  assertIncludes(markup, "mrp-card", "卡片类名");
});

await check("兼容：documents 400 条时能渲染且不卡死（< 3s）", () => {
  const many = clone(payload);
  const base = many.documents[0];
  many.documents = [];
  for (let index = 0; index < 400; index += 1) {
    const document = clone(base);
    document.id = "doc_bulk_" + index;
    document.filePath = base.filePath.replace(/(\.[a-z]+)$/, "-" + index + "$1");
    document.relativePath = "bulk/doc-" + index + ".md";
    document.chunkCount = index;
    document.lastIndexed = document.lastModified - 1000;
    many.documents.push(document);
  }
  const started = Date.now();
  const markup = serverRenderer.renderToStaticMarkup(h(client.__Panel, { initialData: many, initialTab: "documents" }));
  const elapsed = Date.now() - started;
  assertIncludes(markup, "bulk/doc-399.md", "第 400 条文档");
  assertIncludes(markup, "399 切片", "切片数（第 400 条）");
  assert.ok(elapsed < 3000, "渲染耗时 " + elapsed + "ms，超过 3s");
  console.log("      400 条文档渲染耗时：" + elapsed + "ms（" + markup.length + " chars）");
});

await check("兼容：scope=project:xxx 时面板请求带 ?scope= 参数", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  await client.__internals.api.getState({ scope: "project:myapp" });
  assert.equal(calls.length, 1, "应当发出一次 fetch");
  assertIncludes(calls[0].url, "/mirror/api/state?", "请求路径");
  assertIncludes(calls[0].url, "scope=project%3Amyapp", "scope 参数");
  assert.equal(calls[0].init.credentials, "same-origin", "credentials");
  assert.equal(calls[0].init.cache, "no-store", "cache");
});

await check("兼容：scope 下拉来自数据（all / global / project:myapp）", () => {
  const normalized = client.__internals.normalizeState(payload);
  const options = client.__internals.buildScopeOptions(normalized);
  assert.deepEqual(options.slice(0, 2), ["all", "global"], "all 与 global 恒在");
  assert.ok(options.includes("project:myapp"), "应出现 project:myapp：" + JSON.stringify(options));
});

await check("面板挂载：apply() 注册 main(key=mirror) 与 sidebar.panellist(id=mirror)", () => {
  const registrations = [];
  const injections = [];
  const slotCtx = {
    effect(factory) {
      const off = factory();
      return () => {
        if (typeof off === "function") off();
      };
    },
    slots: {
      inject(name, callback) {
        injections.push(name);
        const off = callback();
        return () => {
          if (typeof off === "function") off();
        };
      },
      register(spec, render) {
        registrations.push({ spec, render });
        return () => {};
      },
    },
    locale: {
      register() {
        return () => {};
      },
      bind() {
        return (key) => String(key);
      },
    },
    theme: { on() { return () => {}; } },
  };
  client.apply(slotCtx);
  assert.deepEqual(injections, ["main", "sidebar.panellist"], "槽位探测顺序");
  const main = registrations.find((entry) => entry.spec.name === "main");
  const row = registrations.find((entry) => entry.spec.name === "sidebar.panellist");
  assert.ok(main, "缺少 main 槽位");
  assert.equal(main.spec.key, "mirror", "main key");
  assert.ok(row, "缺少 sidebar.panellist 槽位");
  assert.equal(row.spec.id, "mirror", "sidebar id");
  assert.equal(row.spec.order, 10, "sidebar order");
  assert.equal(row.spec.label(), "Mirror", "sidebar label");
  assert.ok(row.render({ size: 16 }), "侧栏图标可渲染");
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const passed = results.filter((entry) => entry.ok).length;
const failed = results.length - passed;
console.log("");
console.log("==== mirror-dsh-adapter 宿主 ↔ 面板契约联调 ====");
console.log("用例：" + results.length + " · PASS " + passed + " · FAIL " + failed);
console.log("临时数据目录：" + tmpDir);
if (failed > 0) {
  for (const entry of results.filter((item) => !item.ok)) console.log(" - FAIL " + entry.name + "：" + entry.message);
  console.log("结果：FAIL");
  process.exitCode = 1;
} else {
  console.log("结果：PASS（真实 /state → 面板 SSR 全链路 + 容错用例通过）");
  process.exitCode = 0;
}
