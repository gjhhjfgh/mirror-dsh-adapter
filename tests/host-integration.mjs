/**
 * 宿主端集成自测（不需要 DSH 进程，也不需要浏览器）
 *
 * 用一个假 ctx / 假 webServer 把 lib/index.js 的 apply() 跑起来，验证：
 *   1. 工具注册齐全；
 *   2. 工具真的能写库（mirror_remember → 重复 → duplicate）；
 *   3. HTTP 路由真的能返回 JSON（/health /state /action /inject.preview）；
 *   4. 卸载时清理干净。
 *
 * 运行：node tests/host-integration.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-host-test-"));
process.on("exit", () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
    console.log(`  PASS  ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`  FAIL  ${label}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`  PASS  ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`  FAIL  ${label}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

const tools = new Map();
const routes = [];
const sections = [];
const disposers = [];
const handlers = new Map();

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
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  },
  on(event, handler) {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool);
    },
  },
  systemPrompt: {
    section(spec) {
      sections.push(spec);
      return () => {};
    },
  },
  inject(deps, callback) {
    if (deps.includes("webServer")) {
      callback({
        effect(cb) {
          const dispose = cb();
          if (typeof dispose === "function") disposers.push(dispose);
          return dispose;
        },
        webServer: fakeWebServer,
      });
    }
  },
};

/** 调用已注册的 HTTP 路由，返回 { status, json }。 */
function callRoute(method, url, body) {
  const pathname = url.split("?")[0];
  // 与 dsh-host-webserver 一致：先 exact，再最长 prefix。
  const exact = routes.find((route) => route.kind === "exact" && route.path === pathname);
  const prefix = routes
    .filter((route) => route.kind === "prefix" && (pathname === route.path || pathname.startsWith(`${route.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const route = exact ?? prefix;
  assert.ok(route, `没有匹配的路由：${method} ${url}（已注册 ${routes.map((r) => `${r.kind}:${r.path}`).join(", ")}）`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`路由超时：${url}`)), 8000);
    const response = {
      statusCode: 0,
      headers: {},
      headersSent: false,
      body: "",
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = { ...headers };
        this.headersSent = true;
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
        resolve({ status: this.statusCode, json, body: this.body, headers: this.headers });
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
    try {
      route.handler(request, response);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function callAction(type, payload = {}) {
  const { json } = await callRoute("POST", "/mirror/api/action", { type, ...payload });
  assert.ok(json, "action 返回体不是 JSON");
  return json;
}

// ---------------------------------------------------------------------------

const { apply, inject, name } = await import("../lib/index.js");

console.log("Mirror 宿主端集成自测");
console.log(`  临时数据目录：${tmpDir}`);
console.log(`  插件导出：name=${name} inject=${JSON.stringify(inject)}`);

await checkAsync("apply() 不抛错", async () => {
  apply(ctx, { dataDir: tmpDir, injectTokenBudget: 1200 });
  await new Promise((resolve) => setTimeout(resolve, 50));
});

check("工具注册齐全", () => {
  const expected = [
    "mirror_remember",
    "mirror_recall",
    "mirror_forget",
    "mirror_confirm",
    "mirror_doc_index",
    "mirror_doc_search",
    "mirror_doc_list",
    "mirror_pack_list",
    "mirror_pack_import",
  ];
  for (const toolName of expected) {
    assert.ok(tools.has(toolName), `缺少工具 ${toolName}，实际：${[...tools.keys()].join(", ")}`);
  }
});

check("注册了 HTTP 路由", () => {
  const paths = routes.map((route) => route.path);
  for (const expected of ["/mirror/api/health", "/mirror/api/state", "/mirror/api/search", "/mirror/api/action"]) {
    assert.ok(paths.includes(expected), `缺少路由 ${expected}，实际：${paths.join(", ")}`);
  }
});

check("注册了系统提示 section", () => {
  assert.equal(sections.length, 1);
  assert.equal(typeof sections[0].text, "function");
  assert.equal(typeof sections[0].text({}), "string");
});

let firstMemoryId = "";

await checkAsync("mirror_remember 写入铁律", async () => {
  const tool = tools.get("mirror_remember");
  const result = await tool.execute(
    { content: "接口必须走 WebSocket，HTTP 会丢消息", category: "iron_rule" },
    { agent: { session: { id: "test-session" } } },
  );
  assert.equal(result.status, "created", JSON.stringify(result));
  assert.equal(result.created, 1);
  firstMemoryId = result.memory_ids[0];
  assert.ok(firstMemoryId, "没有拿到 memory id");
});

await checkAsync("重复写入被去重", async () => {
  const tool = tools.get("mirror_remember");
  const result = await tool.execute(
    { content: "接口必须走 WebSocket，HTTP 会丢消息", category: "iron_rule" },
    { agent: { session: { id: "test-session" } } },
  );
  assert.equal(result.status, "duplicate", JSON.stringify(result));
});

await checkAsync("/health 返回 ready", async () => {
  const { status, json } = await callRoute("GET", "/mirror/api/health");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.core, "ready");
});

await checkAsync("/state 带出刚写入的记忆与统计", async () => {
  const { status, json } = await callRoute("GET", "/mirror/api/state");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.memories));
  assert.ok(json.memories.some((memory) => memory.id === firstMemoryId));
  assert.ok(json.stats.memories >= 1, `stats.memories=${json.stats.memories}`);
  assert.ok(json.stats.byCategory.iron_rule >= 1);
  assert.ok(Array.isArray(json.conflicts));
  assert.ok(Array.isArray(json.documents));
  assert.ok(Array.isArray(json.packs));
});

await checkAsync("/action memory.create 能写偏好", async () => {
  const json = await callAction("memory.create", { content: "我偏好用中文注释，变量名用英文", category: "preference" });
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.ok(json.memory?.id);
  assert.equal(json.memory.category, "preference");
});

await checkAsync("/action memory.confirm 提升权威", async () => {
  const json = await callAction("memory.confirm", { id: firstMemoryId });
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.equal(json.memory.authority, "user_confirmed");
});

await checkAsync("/action memory.freeze 冻结", async () => {
  const json = await callAction("memory.freeze", { id: firstMemoryId, frozen: true });
  assert.equal(json.ok, true);
  assert.equal(json.memory.frozen, true);
});

await checkAsync("/state 支持 scope 过滤", async () => {
  const { json } = await callRoute("GET", "/mirror/api/state?scope=project:demo");
  assert.equal(json.ok, true);
  assert.equal(json.scope, "project:demo");
});

await checkAsync("/search 中文能命中", async () => {
  const { json } = await callRoute("GET", `/mirror/api/search?q=${encodeURIComponent("WebSocket")}`);
  assert.equal(json.ok, true);
  assert.ok(json.memories.length >= 1, JSON.stringify(json));
});

await checkAsync("/state 带出文档-记忆关联数组（§10.4）", async () => {
  const { json } = await callRoute("GET", "/mirror/api/state");
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.links), "state.links 应为数组");
});

await checkAsync("/action inject.preview 生成分层注入文本", async () => {
  const json = await callAction("inject.preview", { query: "WebSocket 怎么用", tokenBudget: 800 });
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.ok(typeof json.text === "string");
  assert.ok(json.text.includes("铁律"), `注入文本缺少铁律段：${json.text.slice(0, 200)}`);
  assert.ok(Array.isArray(json.sections));
});

await checkAsync("文档库：添加临时目录并索引", async () => {
  const docsDir = path.join(tmpDir, "docs-src");
  fs.mkdirSync(path.join(docsDir, "guide"), { recursive: true });
  fs.writeFileSync(
    path.join(docsDir, "guide", "install.md"),
    "# 安装\n\n## 依赖\n\n需要 Node 22 以上。\n\n## 步骤\n\n运行 pnpm install 安装依赖。\n",
    "utf8",
  );
  fs.writeFileSync(path.join(docsDir, "api.ts"), "export function fetchUser(id: string) {\n  return fetch(`/api/user/${id}`)\n}\n", "utf8");
  const json = await callAction("doc.addRoot", { path: docsDir });
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.ok(json.scan.added >= 2, JSON.stringify(json.scan));
  assert.ok(json.roots.length >= 1);
  const search = await callAction("doc.search", { q: "安装" });
  assert.equal(search.ok, true);
  assert.ok(search.results.length >= 1, JSON.stringify(search));
});

await checkAsync("文档自然语言查询能命中（§10.2）", async () => {
  const search = await callAction("doc.search", { q: "安装依赖怎么跑" });
  assert.equal(search.ok, true);
  assert.ok(search.results.length >= 1, `自然语言 0 命中：${JSON.stringify(search.results)}`);
});

await checkAsync("注入里能带出相关文档层（§10.2 + §10.7）", async () => {
  const json = await callAction("inject.preview", { query: "安装依赖怎么跑", tokenBudget: 1200 });
  assert.equal(json.ok, true, JSON.stringify(json));
  const names = (json.sections || []).map((section) => section.name);
  assert.ok(names.includes("documents"), `注入缺少 documents 层，实际：${names.join(",")}`);
});

await checkAsync("/action doc.ingest 手写文档直接入库（文档先行）", async () => {
  const json = await callAction("doc.ingest", {
    topic: "godot-test",
    title: "GDScript 基础",
    sourceUrl: "manual://test",
    content: "# GDScript 基础\n\n## 静态类型\n\n从 Godot 4 开始支持静态类型：`var speed: float = 10.0`。\n\n- 类型标注可选\n- 静态类型能提前发现错误\n",
  });
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.ok((json.files || []).length >= 1, "应写入至少 1 个文件");
  assert.ok((json.scan?.added || 0) + (json.scan?.updated || 0) >= 1, `索引未生效：${JSON.stringify(json.scan)}`);
  const search = await callAction("doc.search", { q: "静态类型" });
  assert.ok((search.results || []).length >= 1, "入库后检索不到");
});
await checkAsync("pack.export 与 pack.import 往返", async () => {
  const exported = await callAction("pack.export", {
    memoryIds: [firstMemoryId],
    meta: { name: "测试包", version: "0.0.1", author: "lead", description: "自测" },
  });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.ok(fs.existsSync(exported.path), `导出文件不存在：${exported.path}`);
  const imported = await callAction("pack.import", { path: exported.path, strategy: "skip_conflicts" });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const list = await callAction("pack.uninstall", { packId: imported.packId, deleteMemories: false });
  assert.equal(list.ok, true, JSON.stringify(list));
});

await checkAsync("pack.checkUpdates 返回更新列表（§10.5）", async () => {
  const json = await callAction("pack.checkUpdates", {});
  assert.equal(json.ok, true, JSON.stringify(json));
  assert.ok(Array.isArray(json.updates), "updates 应为数组");
});

await checkAsync("拒绝非法动作", async () => {
  const json = await callAction("nope.unknown", {});
  assert.equal(json.ok, false);
  assert.match(json.error, /未知动作/);
});

await checkAsync("卸载流程清理 disposer", async () => {
  assert.ok(disposers.length >= 3, `disposer 数量 ${disposers.length}`);
  for (const dispose of disposers.splice(0)) {
    if (typeof dispose === "function") dispose();
  }
  assert.equal(routes.length, 0, "路由没有随卸载移除");
});

const failed = results.filter((result) => !result.ok);
console.log("");
if (failed.length === 0) {
  console.log(`全部通过：${results.length} 项`);
  process.exit(0);
}
console.log(`失败 ${failed.length} / ${results.length} 项`);
process.exit(1);
