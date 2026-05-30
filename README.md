# SF TeamFlow — Salesforce チーム開発オーケストレーター (VSCode 拡張)

![icon](resources/icon.png)

Salesforce のチーム開発を **「環境 / Git / CI/CD」** の 3 軸で体系化する VSCode 拡張です。
**開発初心者でも、サイドバーのボタンを上から押していくだけ**で、安全なチーム開発が始められます。

> 💡 **はじめての方へ**: コマンドパレット (Ctrl/Cmd+Shift+P) で
> **「TeamFlow: ガイド付きセットアップ」** を実行するか、左の SF TeamFlow アイコンから始めてください。
> VSCode の「ようこそ (Walkthrough)」にも手順ガイドが表示されます。

---

## 解決する課題

Salesforce のチーム開発は、ツールより**運用規約**が属人化しがちです。

| よくある事故 | SF TeamFlow の対策 |
|---|---|
| どの org が本番か分からず誤デプロイ | 🛡️ 本番 org を赤バッジ表示＋デプロイ前モーダル確認＋ステータスバー常時表示 |
| `force-app` 丸ごとデプロイで無関係な変更を巻き込む | 🔀 Git のベース ref との**差分メタデータだけ**をデプロイ |
| 「staging にデプロイ」の意味が人により違う | ⚙️ `sf-teamflow.json` に環境⇔ブランチ⇔org を定義し全員で共有 |
| Git/CI が難しくて手が出せない | 🟢 「保存してバックアップ」など**1クリックの日本語コマンド**＋CI 自動生成 |
| 複数人開発の進め方が分からない | 📘 拡張内に**チーム開発ガイド**を同梱 |

---

## 主な機能

### 🌍 Org / 環境マネージャ
- 認証済み org を **Production / Sandbox / Dev Hub / Scratch** に自動分類してツリー表示
- **本番 org を赤い盾アイコン**で警告（login.salesforce.com / My Domain を判定）
- 既定 org の切替・ブラウザで開く・Org ID コピー・認証解除をワンクリック
- ステータスバーに「現在の既定 org」「ブランチ → 環境」を常時表示

### 📦 プロジェクト作成・メタデータ取得
- **新しいプロジェクトを作成** (`sf project generate`) — 雛形を数秒で
- **メタデータを取得** — Apexクラス・オブジェクト・フロー等を一覧から選んで取り込み
- **manifest (package.xml) で取得** — 既存組織からまとめて取り込み
- **Orgにソースを反映 (push) / Orgから取り込み (pull)** — スクラッチ/Sandbox との同期

### 🔀 Git 差分デプロイ
- `origin/main` などの**ベース ref との差分**だけをデプロイ／検証（誤爆防止）
- マージベース (`base...HEAD`) でベースブランチ側の無関係な変更を除外
- コミット済み＋作業ツリー＋未追跡ファイルをすべて対象、削除は別表示で安全側に
- **本番 org へのデプロイはモーダルで二重確認**

### 💾 バックアップ・バージョン管理 (Git/GitHub)
初心者向けに、生の git コマンドではなく**目的ベースの1クリック操作**を提供します。
- **保存してバックアップ** — `add → commit → push` を1コマンドで（メッセージ入力のみ）
- **GitHubと同期** — `pull → push`（コンフリクトは警告）
- **作業ブランチを作成/切替** — 1機能=1ブランチを促す
- **GitHubに公開** — `gh repo create` でリポジトリ作成＋push
- 「バックアップ (Git)」ビューで、現在ブランチ・未バックアップ件数・変更ファイルを一目で確認

### ⚙️ チーム共有設定 (`sf-teamflow.json`)
リポジトリにコミットしてチーム全員で共有する設定ファイル。

```json
{
  "$schema": "./sf-teamflow.schema.json",
  "defaultBaseRef": "origin/main",
  "testLevel": "RunLocalTests",
  "packageDirectories": ["force-app"],
  "environments": [
    { "name": "production", "orgAlias": "prod", "branch": "main",       "type": "production", "requireValidation": true },
    { "name": "staging",    "orgAlias": "uat",  "branch": "release/*",  "type": "sandbox",    "requireValidation": true },
    { "name": "integration","orgAlias": "int",  "branch": "develop",    "type": "sandbox" }
  ]
}
```

現在のブランチが自動でいずれかの環境にマッピングされ、デプロイ先 org・ベース ref・テストレベルが決まります。

### 🚀 CI/CD スキャフォルド
チーム設定から GitHub Actions を生成します。

- `.github/workflows/sf-validate.yml` — PR 時に**差分の check-only デプロイ＋テスト**
- `.github/workflows/sf-deploy.yml` — 環境ブランチへのマージ時に**差分デプロイ**（環境ごとにジョブ）
- `.github/CODEOWNERS` — レビュー担当の雛形

認証は **JWT bearer flow**（ヘッドレス）。環境ごとに以下のシークレット／変数を設定します。

| 種別 | 名前 | 内容 |
|---|---|---|
| secret | `SF_<ENV>_CLIENT_ID` | 接続アプリの Consumer Key |
| secret | `SF_<ENV>_USERNAME`  | 連携ユーザーのユーザー名 |
| secret | `SF_<ENV>_JWT_KEY`   | PEM 秘密鍵（全文） |
| variable | `SF_<ENV>_INSTANCE_URL` | ログイン URL（既定 `https://login.salesforce.com`） |

`<ENV>` は環境名を大文字化したもの（例: `production` → `SF_PRODUCTION_CLIENT_ID`）。

### 🧪 スクラッチ Org
- 作成（有効日数指定・定義ファイル自動検出）／削除をコマンド一つで
- ローカルとの push/pull で個人の実験環境として活用

### 📘 チーム開発ガイド
複数人での進め方（ブランチ戦略・環境分離・バックアップ・スクラッチ活用）を拡張内に同梱。
「TeamFlow: チーム開発ガイドを開く」または [docs/TEAM_WORKFLOW.md](docs/TEAM_WORKFLOW.md)。

---

## クイックスタート

1. SFDX プロジェクト（`sfdx-project.json` がある）を VSCode で開く（or「新しいプロジェクトを作成」）
2. アクティビティバーの **SF TeamFlow** アイコンを開く
3. **「TeamFlow: ガイド付きセットアップ」** を実行し、表示される順に進める
   1. プロジェクト準備 → 2. Org 認証 → 3. チーム設定 → 4. CI/CD 生成 → 5. ガイド確認
4. 日々は **「保存してバックアップ」**「Git差分をデプロイ / 検証」を使う

---

## コマンド一覧

| コマンド | 説明 |
|---|---|
| `ガイド付きセットアップ` | 初心者向けに手順を順番に案内 |
| `新しいプロジェクトを作成` | `sf project generate` |
| `Org一覧を更新` / `新しいOrgを認証` | org の取得・`sf org login web` |
| `このOrgを既定に設定` / `ブラウザでOrgを開く` | 既定 org 切替・`sf org open` |
| `メタデータを取得` / `manifestで取得` | `sf project retrieve start` |
| `Orgにソースを反映 (push)` / `Orgから取り込み (pull)` | スクラッチ/Sandbox 同期 |
| `Git差分をデプロイ` / `Git差分を検証` / `差分をプレビュー` | 差分メタデータのデプロイ／検証 |
| `保存してバックアップ` | add → commit → push |
| `GitHubと同期` | pull → push |
| `作業ブランチを作成 / 切り替え` | feature ブランチ運用 |
| `GitHubに公開` | `gh repo create` |
| `チーム開発プロジェクトを初期化` | `sf-teamflow.json` 作成 |
| `CI/CD (GitHub Actions) を生成` | ワークフロー＋CODEOWNERS 生成 |
| `スクラッチOrgを作成` / `削除` | `sf org create/delete scratch` |
| `チーム開発ガイドを開く` | 複数人開発の進め方 |

## 設定 (settings)

| キー | 既定 | 説明 |
|---|---|---|
| `teamflow.deploy.baseRef` | `origin/main` | 差分の基準 ref（`sf-teamflow.json` 優先） |
| `teamflow.deploy.testLevel` | `RunLocalTests` | デプロイ／検証時のテストレベル |
| `teamflow.confirmProductionDeploy` | `true` | 本番デプロイ前に確認ダイアログ |
| `teamflow.sfCliPath` | `sf` | Salesforce CLI の実行パス |

---

## 必要環境

- VSCode 1.85 以上
- [Salesforce CLI (`sf`)](https://developer.salesforce.com/tools/salesforcecli) がインストール済みで PATH が通っていること
- Git（GitHub 公開には [GitHub CLI (`gh`)](https://cli.github.com/) があると便利）

## 開発

```bash
npm install
npm run watch      # esbuild watch（VSCode で F5 → 拡張開発ホスト）
npm run check-types
npm test           # ピュアロジックのユニットテスト (node:test, 38件)
npm run package    # .vsix を生成
```

アーキテクチャ: UI（`vscode` 依存）とドメインロジック（純粋関数）を分離。
`orgService` / `gitService` / `deployService` / `projectService` / `teamflowConfig` / `cicd/templates`
は副作用のない純粋関数として実装し、`node:test` で網羅的にテストしています。

## ライセンス

MIT
