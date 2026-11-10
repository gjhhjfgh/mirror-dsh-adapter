# Mirror — AI の記憶ガバナンス層
**中文** · [English](README.en.md) · [日本語](README.ja.md) · [Español](README.es.md)

> AI に「もっと覚えさせる」のではなく、**正しいこと**を覚え、**間違い**を忘れ、情報が衝突したときに**どちらが優先か**を分からせる。

Mirror は DSH (DeepSeek Harness) のプラグインです。会話を構造化された「認知プロファイル」に蒸留し、ガバナンス規則で記憶が荒れないようにします。

- **ローカル優先**：SQLite（`~/.mirror`）。既定でネットワークを使わず、会話をアップロードしません
- **ガバナンス**：各記憶に権威・信頼度・スコープ・矛盾関係。衝突は人間が裁定し、AI は勝手に上書きしません
- **パッケージ化**：`.mirrorpack` として書き出し可能（経験には境界と根拠を含む）
- **検証可能**：`quality.benchmark` が各経験の検索可能性を測り、比較用のベースラインも出します

## インストール（npm 不要）

```powershell
# A) Releases から mirror-dsh-adapter-x.y.z.tgz を取得して実行
node bin/mirror-install.mjs --tarball <ダウンロードした tgz>

# B) GitHub から直接（公開リポジトリ）
node bin/mirror-install.mjs --from-github gjhhjfgh/mirror-dsh-adapter@v2.2.1

# セルフチェック（dsh web を再起動してからページを更新）
node bin/mirror-doctor.mjs
```

パッケージは DSH プロファイルの `node_modules` に配置され、依存は `file:./vendor/…` として記録されます（レジストリ不要）。
[インストール手順](docs/INSTALL-GITHUB.en.md) · [FAQ](docs/FAQ.en.md)

## 最小の使い方

1. パネル「記憶パック」→ 会話キャプチャを有効化（既定はオフ・ローカルのみ）
2. 数ターン会話する、またはルールを直接追加
3. 「蒸留」→ 嗜好 / ルール / パターン / スキル / 避けること / 経験
4. 「保留」→ 品質スコア、衝突の裁定、重複の統合
5. 「注入プレビュー」→ 次のターンに実際に渡る内容を確認

## 主な機能

| 機能 | 説明 |
|---|---|
| 経験エントリ | 状況 → 行動 → 理由 → 境界 → 根拠。「負の経験」が最も価値がある |
| 権威裁定 | 記憶と文書が矛盾する場合、`user_first` で片側だけを残す |
| 検索 | FTS5 + 文字 n-gram ベクトル + RRF。オフラインで動作 |
| 安全性 | 外部コンテンツは「指示ではなくデータ」として枠付け。怪しいパックは既定で拒否 |
| 運用 | ワンコマンド導入/自己診断、バックアップと復元、本文を含まない診断パッケージ |

## テスト

```powershell
node /tests/core.test.mjs
# または: cd  && npm run test:all
```

261 項目、オフライン、サードパーティ依存ゼロ。

## ライセンス

MIT（[LICENSE](LICENSE)）。パックの内容は作者に帰属し、本プロジェクトはユーザーデータを収集しません。
