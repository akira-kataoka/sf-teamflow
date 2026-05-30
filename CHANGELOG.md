# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/) / [Semantic Versioning](https://semver.org/) に準拠します。

## [0.2.0] - 2026-05-31

チーム開発の「作る・取り込む・バックアップする・進める」を全面強化。**初心者でも直感的に**使えるUXを追加。

### Added
- 📦 **プロジェクト作成** (`sf project generate`) コマンド。
- 📥 **メタデータ取得**: 種類を選んで取得 / `package.xml` (manifest) で取得。
- 🔁 **ソース同期**: Orgにソースを反映 (push) / Orgから取り込み (pull)。
- 💾 **バックアップ (Git) ビュー** と1クリックコマンド:「保存してバックアップ」(add+commit+push)、「GitHubと同期」(pull+push)、「作業ブランチ作成/切替」、「GitHubに公開」(gh)。
- 🧪 **スクラッチOrg削除**コマンド、作成時の定義ファイル自動検出。
- 🧭 **初心者向けUX**: ガイド付きセットアップ、VSCode Walkthrough（5ステップ）、ステータスバー（既定org・ブランチ→環境）、空状態のWelcome。
- 📘 **チーム開発ガイド** (docs/TEAM_WORKFLOW.md) を同梱し拡張内から表示。複数人開発のブランチ戦略・環境分離・Branch protection 推奨設定。
- ✅ ピュアロジックのユニットテストを 28 → **38** 件に拡充（git status パーサ・project サービス）。

### Changed
- ビューを日本語名に。Org/環境マネージャに加え「バックアップ (Git)」ビューを追加。

## [0.1.0] - 2026-05-31

### Added — 初版
- 🌍 Org / 環境マネージャ（分類表示・本番赤バッジ・既定切替・open・logout）。
- 🔀 Git 差分デプロイ / 検証（マージベース差分・本番二重確認・プレビュー）。
- ⚙️ チーム共有設定 `sf-teamflow.json`（環境⇔ブランチ⇔org、JSON Schema 同梱）。
- 🚀 CI/CD スキャフォルド（GitHub Actions PR検証 / デプロイ、CODEOWNERS、JWT 認証）。
- 🧪 スクラッチ Org 作成。
- ✅ ピュアロジック 28 件のユニットテスト。
