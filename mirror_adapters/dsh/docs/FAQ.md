# 常见问题（FAQ）

> 先把我们真实踩过的坑写在这里。用户每问一次，就补一条。

## 安装

**Q：左侧栏没有 Mirror 图标？**
A：先跑 `node bin/mirror-doctor.mjs` 看 6 项检查；最常见原因是**装完没重启 dsh web**（客户端 bundle 只在进程启动时编入，刷新页面不够）。

**Q：插件路由全是 404 / 面板空白？**
A：同上——宿主还是旧进程。先确认 `doctor` 里「插件」是 PASS，再重启 `dsh web`。

**Q：`mirror-install` 报 EPERM / 文件被占用？**
A：dsh web 正在运行、锁着文件。关闭 dsh web 再跑一次；脚本已内置重试与只读文件兜底。

**Q：Node 版本不够？**
A：需要 **Node ≥ 22.5**（内核用 `node:sqlite` + FTS5）。`doctor` 会直接告诉你当前版本。

**Q：能装到别的 DSH profile 吗？**
A：`node bin/mirror-install.mjs --profile <profile 目录>`，默认找 `$DSH_HOME/profiles/web`。

**Q：不用 npm 能装吗？**
A：能，而且推荐。下载 GitHub Release 的 `.tgz` 后跑 `node bin/mirror-install.mjs --tarball <文件>`，
或直接 `--from-github <owner>/<repo>@v2.2.1`；包会放进 profile 的 `vendor/`，依赖写 `file:`，不联网装依赖。
详见 [INSTALL-GITHUB.md](INSTALL-GITHUB.md)。

## 使用

**Q：数据存在哪？会上传吗？**
A：`~/.mirror`（`mirror.db` + `backups/` + `sessions/` + `diagnostics/`）。**默认不联网、不上传任何对话**；捕获默认关闭，需你显式打开。

**Q：1–2 个字的搜索搜不到？**
A：FTS5 trigram 需要 ≥3 字符，2 字会走 LIKE 兜底；这是已知限制，已用向量召回部分补偿。

**Q：怎么备份 / 恢复？**
A：面板「待确认 → 🛟 数据与诊断」可立即备份、列出、恢复；恢复前会自动另存当前库。也可直接用 `backup.create / list / restore` action。

**Q：想给别人反馈问题，要带什么？**
A：面板「导出诊断包」→ 得到 `diag-<ts>.md`（只有版本/统计/脱敏配置/最近日志，**不含任何记忆正文**），直接贴进 issue。

**Q：怎么卸载？**
A：从 profile 依赖里移除 `mirror-dsh-adapter` 并删掉 `cordis.patch.yml` 里的 `id: mirror-memory` 段，然后重启。数据目录 `~/.mirror` 不会被自动删除（你的数据你做主）。

## 功能边界（坦诚说明）

- 目前只支持 **DSH**；不依赖任何外部模型或云服务。
- 检索是 FTS5 + 字符 n-gram 向量 + RRF，**不是神经嵌入**；语义改写能力强于纯关键词，但弱于 embedding 模型。
- 记忆包会进买家/使用者的 AI 系统提示，因此导入时默认做指令注入扫描；**可疑包默认拒绝**。
- 蒸馏质量取决于对话素材；「离线启发式」是兜底，接模型（prepare → 贴回 JSON）质量更好。
