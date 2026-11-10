# Changelog

本项目遵循语义化版本（主版本 = 数据结构/接口不兼容；次版本 = 新能力；修订 = 修复）。

## 2.2.3 — 2026-11-10

修复文档库列表在条目较多时被压扁、内容不可见的问题。

### 修复
- 文档行在滚动容器里不再被 flex 压缩（`flex:0 0 auto`），列表恢复为逐行可读并正常滚动。
- 文档列表顶部补 2px 内边距，首行不再被上方栏位裁切。
- 目录与记忆包输入框的占位文案改为通用提示，不再使用像真实路径的示例。

### 影响
- 纯前端样式修复；数据、检索、注入逻辑不变。

## 2.2.2 — 2026-11-10

发布包精简：移除未启用的可选字段与相关文案，统一为纯本地用法。

### 变更
- 精简包格式里的可选字段（解析、导出、文件输出三处同步）。
- `installed_packs.source` 默认值改为 `local`；记忆包只记录本地来源。
- 更新检查文案改为「本地包没有可对比的新版本」。
- 样例数据与代码注释同步精简。
- LICENSE 补充说明改为中性表述（只说明包内容归属与合规责任）。

### 兼容性
- 旧包若含该可选字段，解析时会被忽略（向后兼容，不会报错）。

## 2.2.1 — 2026-11-10

不经过 npm registry 的分发链路（纯 GitHub）。

### 新增
- **GitHub 安装**：`mirror-install --tarball <文件|URL>` 与 `--from-github owner/repo[@ref]`。
  包会放进 `<profile>/vendor/`，profile 依赖写成 `file:./vendor/mirror-dsh-adapter-<ver>.tgz`，离线可复现。
- **零依赖 tar.gz 读写**（`bin/lib/tar.mjs`）：打包/解包 + tar-slip 防护；不依赖 npm 或系统 tar。
- **发版脚本**：`node scripts/make-release.mjs` → `dist/*.tgz` + `SHA256SUMS.txt` + `gh release create` 命令提示。
- 文档：`docs/INSTALL-GITHUB.md`（三种安装方式、审计说明、维护者发版流程）。

### 修复
- 安装脚本遇到带 UTF-8 BOM 的 profile `package.json` 会崩溃 → 现在剥 BOM，解析失败也不再中断安装（只跳过依赖登记）。
- 安装脚本顶层异常改为可读错误 + 退出码 1（不再抛栈）。

### 测试
- `tests/install-doctor.test.mjs` 扩到 13 项（tarball 打包/解包、tar-slip 拒绝、GitHub tarball 安装、BOM 清单）。

## 2.2.0 — 2026-11-10

基础能力版本：数据安全、可诊断、可上手。

### 新增
- **备份与恢复**：`backup.create/list/restore`。用 SQLite `VACUUM INTO` 生成一致快照到 `<dataDir>/backups/mirror-<ts>/`，
  带 `manifest.json`（版本/计数/备注）；恢复前自动另存 `mirror.db.before-restore-<ts>`，只保留最近 20 份。
- **诊断包导出**：`diagnostics.export` → `<dataDir>/diagnostics/diag-<ts>.{json,md}`，
  只含统计、脱敏配置（路径只留末段）、最近 50 条日志，**不含任何记忆/文档/对话正文**。
- **一键导入样例包**：`pack.importSample`（内置 `samples/godot-2d-pipeline.mirrorpack`，走完整安全扫描）。
- **首启引导**：面板空态引导「打开捕获 → 蒸馏 → 看注入预览」，可一键导入样例。
- 面板「待确认」Tab 底部新增「🛟 数据与诊断」：立即备份 / 备份列表 / 恢复（二次确认）/ 导出诊断包。

### 变更
- 宿主日志加 50 条环形缓冲（仅内存，供诊断包使用）。
- 版本号 2.2.0；面板删掉一批无引用的旧样式。

### 测试
- 新增 `tests/backup-diagnostics.test.mjs`（9 项）：快照/恢复/安全副本/无效备份拒绝/诊断包不含正文/配置脱敏/宿主 action。

## 2.1.0 — 2026-11-10

首个可运营版本。核心是「记录 → 蒸馏 → 治理 → 打包」闭环，并补齐装机与自检链路。

### 新增
- **会话捕获**（默认关闭）：本地 `sessions/*.jsonl`，容量治理（单会话 2MB 滚动截断、最多 100 会话、一键清空）。
- **DSH 历史会话蒸馏**：直接读 `$DSH_HOME/sessions` 的多帧 zstd 日志（自写帧扫描器，零依赖）。
- **蒸馏质量闸门**：空话条目丢弃、密钥/邮箱/手机号/路径脱敏、无证据经验降置信度、批内近似去重。
- **经验条目（Experience）**：情境 → 做法 → 理由 → 边界 → 证据，落库带 `structured.kind='experience'`。
- **PII 复核**：`distill.stage` 暂存 → 逐条「还原原文 / 保留丢弃项」→ `distill.review.apply`。
- **记忆包带画像**：`.mirrorpack` 可携带 profile 六段（不含原始对话）；导入画像落成 distillation。
- **质量体检**：干净度分数（重复对/冲突/陈旧/未确认推断）、近似重复一键合并、撤销一次蒸馏导入。
- **权威裁决**：记忆与文档矛盾时按 `user_first`（可配 `doc_first` / `memory_first`）只保留一侧。
- **检索**：FTS5 + 字符 n-gram 向量 + RRF 融合（离线、无模型）；无关查询有共享 token 硬门禁。
- **自动蒸馏**：每 N 轮轮末后台跑一次启发式蒸馏，默认关闭。
- **安全**：外部导入内容注入时加「是数据不是指令」框架；含指令注入样式的包默认拒绝导入；导入永不 supersede 用户确认的记忆。
- **CLI**：`mirror-install`（装进 DSH profile，幂等）与 `mirror-doctor`（装机自检）。
- **样例包**：`samples/godot-2d-pipeline.mirrorpack`。

### 变更
- 面板从 10 Tab 收到 **7 Tab**：铁律 / 偏好（含决策、模糊筛选）/ 踩坑 / 文档库（含关联折叠）/ 记忆包 / 待确认 / 注入预览。
- 顶栏去掉与 Tab 重复的统计 chip；捕获与蒸馏合并为「记录 → 蒸馏」单卡；导入/导出折进「高级：记忆包文件」。
- 常驻注入层只收 `user_explicit / user_confirmed`，AI 推断与包导入内容不再占常驻预算。
- 包版本号改为 2.1.0；`engines.node >= 22.5`（`node:sqlite`）。

### 修复
- `memory.update` 平铺传 `content` 时静默成功但未修改 → 现在兼容平铺字段，空 patch 直接报错。
- 捕获与 `/state` 的性能问题：DSH 会话扫描加 30s 缓存；自动蒸馏关闭时不写盘。
- `sync.ps1` 在清单文件被运行时占用时不再整体失败（降级为警告）。

## 2.0.0 — 2026-11-09

- 首个 DSH 插件版本：进程内 SQLite 内核、文档库、记忆包、逐轮注入、左侧栏面板。

### 测试
- 234 项自动化测试（13 个套件），全部离线可跑、零第三方依赖。
