# Changelog

このプロジェクトのすべての注目すべき変更を記録します。
形式は [Keep a Changelog](https://keepachangelog.com/) に準拠し、
[Semantic Versioning](https://semver.org/) を採用します。

## [0.1.0] - 2026-05-31

### Added — 初版

- 🌍 **Org / 環境マネージャ**: 認証済み org を Production / Sandbox / Dev Hub / Scratch に分類してツリー表示。本番 org の赤バッジ警告、既定 org 切替、ブラウザで開く、Org ID コピー、認証解除。
- 🔀 **Git 差分デプロイ / 検証**: ベース ref とのマージベース差分メタデータのみをデプロイ。本番は二重確認。差分プレビュー。
- ⚙️ **チーム共有設定 `sf-teamflow.json`**: 環境⇔ブランチ(glob 可)⇔org エイリアス⇔テストレベルを宣言。現在ブランチからの自動マッピング。JSON Schema 同梱。
- 🚀 **CI/CD スキャフォルド**: チーム設定から GitHub Actions (PR 検証 / マージ時デプロイ) と CODEOWNERS を生成。JWT bearer flow 認証。
- 🧪 **スクラッチ Org 作成** コマンド。
- ✅ ピュアロジック 28 件のユニットテスト (node:test)。
