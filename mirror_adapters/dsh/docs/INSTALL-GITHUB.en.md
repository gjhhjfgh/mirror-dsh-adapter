# Install without npm (GitHub only)

> You do **not** need an npm registry — or the npm CLI — to install Mirror.
> The plugin is a plain directory plus one `cordis.patch.yml` entry; the installer copies files and registers them.

## A. From a GitHub Release tarball (recommended)

1. Open **Releases** and download `mirror-dsh-adapter-<version>.tgz` (optionally verify `SHA256SUMS.txt`).
2. Run:

```powershell
node bin/mirror-install.mjs --tarball C:\Users\you\Downloads\mirror-dsh-adapter-2.2.1.tgz
```

The installer unpacks it, copies into `<profile>/node_modules/mirror-dsh-adapter`, stores the tarball in
`<profile>/vendor/`, records the dependency as `file:./vendor/…` (reproducible offline) and appends the
`cordis.patch.yml` entry.

3. Restart `dsh web`, refresh the page, and the Mirror icon appears in the sidebar.
4. Self-check: `node bin/mirror-doctor.mjs`

## B. Straight from GitHub

```powershell
node bin/mirror-install.mjs --from-github <owner>/<repo>@v2.2.1
```

Equivalent to downloading `https://codeload.github.com/<owner>/<repo>/tar.gz/v2.2.1`, locating the package,
packing it and installing. Private repos need method A.

## C. Clone and install locally

```powershell
git clone https://github.com/<owner>/<repo>.git
node <repo>\mirror_adapters\dsh\bin\mirror-install.mjs --source <repo>\mirror_adapters\dsh
```

## What the installer does (auditable)

1. **Copy** `lib/ core/ docs/ samples/ package.json cordis.patch.yml README.md CHANGELOG.md LICENSE`
   into `<profile>/node_modules/mirror-dsh-adapter/` (idempotent; read-only files are handled).
2. **Register** the dependency and `dsh.profile.bundles` in the profile `package.json` (backup written first).
3. **Patch** `cordis.patch.yml` with:

```yaml
- id: mirror-memory
  name: "mirror-dsh-adapter"
  config: { dataDir: "", injectTokenBudget: 3000 }
```

No network at runtime, no data touched. You restart `dsh web` yourself.

## Maintainer release flow

```powershell
node scripts/make-release.mjs
# outputs dist/mirror-dsh-adapter-<version>.tgz + dist/SHA256SUMS.txt
gh release create v2.2.1 dist/*.tgz dist/SHA256SUMS.txt --notes-file CHANGELOG.md
```

## FAQ

**Does DSH pull from npm later?** No — the plugin is already in `node_modules` and the dependency points at `file:./vendor/…`.

**How to update?** Download the new tarball and run `--tarball` again, or `--from-github <owner>/<repo>@v2.2.x`.

**How to uninstall?** Remove `node_modules/mirror-dsh-adapter`, `vendor/mirror-dsh-adapter-*.tgz`, the `mirror-memory`
block in `cordis.patch.yml` and the dependency line; restart. `~/.mirror` is never deleted automatically.
