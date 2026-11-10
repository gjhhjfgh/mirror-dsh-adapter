# FAQ

## Installation

**The Mirror icon does not appear.**
Run `node bin/mirror-doctor.mjs` first. The most common cause is **not restarting dsh web** — the client bundle is only composed at process start, a page refresh is not enough.

**All plugin routes return 404 / the panel is blank.**
Same cause: the host is still the old process. Confirm the plugin check passes in `doctor`, then restart `dsh web`.

**`mirror-install` fails with EPERM / file in use.**
`dsh web` is running and holding files. Close it and run again; the installer retries and handles read-only files.

**Node version too old?**
Requires **Node ≥ 22.5** (`node:sqlite` + FTS5). `doctor` prints your version.

## Usage

**Where is my data? Is it uploaded?**
`~/.mirror` (`mirror.db`, `backups/`, `sessions/`, `diagnostics/`). No network by default, nothing uploaded; capture is off unless you enable it.

**Searching 1–2 Chinese characters returns nothing.**
FTS5 trigram needs ≥3 characters; shorter queries fall back to LIKE (partially compensated by vector recall).

**How do I back up / restore?**
Panel → Pending → *Data & diagnostics*: back up, list, restore (a safety copy of the current DB is written first).

**How do I report a problem?**
Panel → export diagnostics → `diag-<ts>.md` (version, counts, redacted config, recent logs; **no memory/doc/chat content**).

**Uninstall?**
Remove the `node_modules` copy, the `mirror-memory` patch block and the dependency line, then restart. `~/.mirror` is yours to keep.

## Honest limits

- DSH only; no external model or cloud dependency.
- Retrieval is FTS5 + character n-gram vectors + RRF — **not neural embeddings**.
- Packs can end up in the AI's system prompt, so imports are scanned for injection and suspicious packs are rejected.
- Distillation quality depends on the source conversations; the offline heuristic is a fallback, an LLM via prepare→apply is better.
