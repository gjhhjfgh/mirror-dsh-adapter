# 不经过 npm 的安装方式（纯 GitHub）

> 结论：**完全可以**。插件是普通目录 + 一个 `cordis.patch.yml` 条目，安装脚本负责复制与登记，
> 不需要 npm registry，甚至不需要 npm 命令。

## 方式 A：从 GitHub Release 的 .tgz 安装（推荐给普通用户）

1. 打开仓库的 **Releases**，下载 `mirror-dsh-adapter-<版本>.tgz`（顺带核对 `SHA256SUMS.txt`）。
2. 在插件目录（或任意解压了仓库的目录）里执行：

```powershell
node bin/mirror-install.mjs --tarball C:\Users\你\Downloads\mirror-dsh-adapter-2.2.1.tgz
```

脚本会：解包 → 复制到 `<profile>/node_modules/mirror-dsh-adapter` → 把包存到 `<profile>/vendor/`
→ profile 依赖写成 `file:./vendor/mirror-dsh-adapter-2.2.1.tgz`（离线可复现，无需联网装依赖）
→ 追加 `cordis.patch.yml` 条目。

3. 重启 `dsh web`，刷新页面，左侧栏出现 Mirror 图标。
4. 自检：`node bin/mirror-doctor.mjs`

## 方式 B：直接从 GitHub 拉取（最省事）

```powershell
node bin/mirror-install.mjs --from-github <owner>/<repo>@v2.2.1
```

等价于下载 `https://codeload.github.com/<owner>/<repo>/tar.gz/v2.2.1` → 找到包目录 → 打成包 → 安装。
私有仓库不支持匿名拉取，请用方式 A（下载后 `--tarball`）。

## 方式 C：git clone 后本地安装（开发/内网）

```powershell
git clone https://github.com/<owner>/<repo>.git
node <repo>\mirror_adapters\dsh\bin\mirror-install.mjs --source <repo>\mirror_adapters\dsh
```

## 安装脚本做了什么（可审计）

1. **复制**：`lib/ core/ docs/ samples/ package.json cordis.patch.yml README.md CHANGELOG.md LICENSE`
   → `<profile>/node_modules/mirror-dsh-adapter/`（幂等，可反复跑；只读文件自动去只读位）
2. **登记**：profile `package.json` 的 `dependencies` + `dsh.profile.bundles`（改前留 `.bak-mirror-install`）
3. **patch**：`cordis.patch.yml` 追加
   ```yaml
   - id: mirror-memory
     name: "mirror-dsh-adapter"
     config: { dataDir: "", injectTokenBudget: 3000 }
   ```
4. 不联网（方式 A/B 只下载一次）、不改你的数据、不需要重启它的进程（重启 `dsh web` 由你来做）。

## 维护者：怎么发版（纯 GitHub）

```powershell
node scripts/make-release.mjs
# 产物：dist/mirror-dsh-adapter-<version>.tgz + dist/SHA256SUMS.txt
gh release create v2.2.1 dist/mirror-dsh-adapter-2.2.1.tgz dist/SHA256SUMS.txt --notes-file CHANGELOG.md
```

## 常见问题

**Q：装了之后 DSH 会自动去 npm 拉包吗？**
A：不会。插件已经在 `node_modules` 里，profile 依赖写的是 `file:./vendor/…`；DSH 重启只读本地文件。

**Q：以后更新怎么办？**
A：下载新版本 tgz，再跑一次 `--tarball`；或 `--from-github <owner>/<repo>@v2.2.x`。同样的 profile 会就地更新。

**Q：如何彻底卸载？**
A：删 `<profile>/node_modules/mirror-dsh-adapter`、`<profile>/vendor/mirror-dsh-adapter-*.tgz`、
`cordis.patch.yml` 里的 `id: mirror-memory` 段与 profile `package.json` 里的依赖行，然后重启。
数据目录 `~/.mirror` 不会被删（你的数据你做主）。

**Q：为什么不用 npm？**
A：少一个中间依赖：内网、无账号、审计需求（看得到每个文件）都更省事。npm 方式仍保留作可选。
