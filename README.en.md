# Mirror — Memory Governance for AI Agents
**中文** · [English](README.en.md) · [日本語](README.ja.md) · [Español](README.es.md)

> Not "make AI remember more", but "make AI remember the **right** things, forget the wrong ones, and know **who wins** when sources disagree".

Mirror is a plugin for DSH (DeepSeek Harness): it distills conversations into a structured *cognitive profile*, then applies governance rules so the memory does not rot.

- **Local-first**: SQLite at `~/.mirror`; no network, no uploaded conversations
- **Governed**: every memory has authority, confidence, scope and conflict relations; conflicts are yours to arbitrate — AI never silently overwrites
- **Packable**: export a `.mirrorpack` (experiences carry boundaries and evidence)
- **Measurable**: `quality.benchmark` checks whether each experience can be retrieved, with a baseline

## Install (npm not required)

```powershell
# A) download mirror-dsh-adapter-x.y.z.tgz from Releases, then
node bin/mirror-install.mjs --tarball <downloaded.tgz>

# B) or install straight from GitHub (public repo)
node bin/mirror-install.mjs --from-github gjhhjfgh/mirror-dsh-adapter@v2.2.1

# self-check (restart dsh web, then refresh the page)
node bin/mirror-doctor.mjs
```

The package is copied into the DSH profile's `node_modules`; the dependency is recorded as `file:./vendor/…`, so no registry is needed.
See [install guide](mirror_adapters/dsh/docs/INSTALL-GITHUB.en.md) · [FAQ](mirror_adapters/dsh/docs/FAQ.en.md).

## Smallest useful loop

1. Panel → *Memory packs* → enable conversation capture (off by default, local only)
2. Chat for a few turns, or add rules directly
3. Click **Distill** → preferences / rules / patterns / skills / avoid / experiences
4. *Pending* → quality score, arbitrate conflicts, merge duplicates
5. *Injection preview* → what the next turn will actually receive

## At a glance

| Capability | What it does |
|---|---|
| Experience entries | trigger → action → why → boundary → evidence; negative experience matters most |
| Authority resolution | memory vs docs: keep one side per `user_first`, never show contradictions |
| Retrieval | FTS5 + character n-gram vectors + RRF, fully offline |
| Safety | imported content framed as data, not instructions; suspicious packs rejected |
| Ops | one-command install/doctor, backup & restore, diagnostics without content |

## Docs

- Plugin reference: [mirror_adapters/dsh/README.md](mirror_adapters/dsh/README.md)
- Install: [INSTALL-GITHUB](mirror_adapters/dsh/docs/INSTALL-GITHUB.en.md) · FAQ: [FAQ](mirror_adapters/dsh/docs/FAQ.en.md)
- Changelog: [CHANGELOG](mirror_adapters/dsh/CHANGELOG.md)

## Tests

```powershell
node mirror_adapters/dsh/tests/core.test.mjs
# or: cd mirror_adapters/dsh && npm run test:all
```

261 checks, offline, zero third-party dependencies.

## License

MIT — see [LICENSE](LICENSE). Pack content belongs to its author; the project collects no user data.
