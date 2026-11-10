# Mirror · DSH 插件（mirror-dsh-adapter）

本地记忆内核 + 治理面板，作为 DSH（DeepSeek Harness）插件运行。

- 左侧栏入口 → 7 个 Tab：铁律 / 偏好（含决策·模糊筛选）/ 踩坑 / 文档库（含关联折叠）/ 记忆包 / 待确认 / 注入预览
- 逐轮注入：铁律 → 相关文档 → 偏好/决策 → 踩坑，按 token 预算分层
- 工具集：`mirror_remember` `mirror_recall` `mirror_forget` `mirror_confirm`
  `mirror_doc_ingest` `mirror_doc_index` `mirror_doc_search` `mirror_doc_list`
  `mirror_capture` `mirror_distill` `mirror_quality` `mirror_pack_list` `mirror_pack_import`

## 安装

```powershell
node bin/mirror-install.mjs --from-github gjhhjfgh/mirror-dsh-adapter@v2.2.1
node bin/mirror-doctor.mjs
```

装完重启 `dsh web`（客户端 bundle 只在进程启动时编入），刷新页面即可看到左侧栏图标。
其它安装方式（Release tarball / 本地 clone）见 [INSTALL-GITHUB](docs/INSTALL-GITHUB.md)。

## 目录

```
lib/      宿主半（工具、路由、逐轮注入）+ 浏览器 bundle（client.js）
core/     进程内 SQLite 内核：记忆治理、文档库、记忆包、蒸馏、检索、备份、诊断
bin/      mirror-install（安装） / mirror-doctor（自检）
samples/  可导入的样例包
docs/     安装说明、FAQ、变更日志
```

## 测试

```powershell
npm run test:all
```

261 项，全部离线可跑、零第三方依赖。

## 数据与隐私

- 数据目录 `~/.mirror`：`mirror.db` / `backups/` / `sessions/`（捕获开启时）/ `diagnostics/`
- 默认不联网、不上传；捕获默认关闭；诊断包不含任何正文
- License：MIT（见仓库根 LICENSE）
