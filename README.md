# SF TeamFlow — Salesforce チーム開発オーケストレーター (VSCode 拡張)

![icon](resources/icon.png)

Salesforce のチーム開発を **「環境 / Git / CI/CD」** の 3 軸で体系化する VSCode 拡張です。
複数人で安全に・再現性をもって開発するために必要な作業を、VSCode のサイドバーから一貫して行えます。

> 既存の Salesforce 拡張 (公式 Salesforce Extensions, SFDX) を**置き換えるのではなく補完**します。
> SF TeamFlow は「個人の開発」ではなく「**チームの運用規約**」をツール化することに焦点を当てています。

---

## なぜ作ったか — 解決する課題

Salesforce のチーム開発では、ツールではなく**運用規約**が属人化しがちです。

| よくある事故 | SF TeamFlow の対策 |
|---|---|
| どの org が本番か分からず、誤って本番にデプロイ | 🛡️ 本番 org を赤バッジ表示＋デプロイ前モーダル確認 |
| `force-app` 丸ごとデプロイして無関係な変更を巻き込む | 🔀 Git のベース ref との**差分メタデータだけ**をデプロイ |
| 「staging にデプロイ」の意味が人によって違う | ⚙️ `sf-teamflow.json` に環境⇔ブランチ⇔org を定義し全員で共有 |
| CI/CD を毎回ゼロから書く | 🚀 チーム設定から GitHub Actions を**自動生成** |

---

## 主な機能

### 🌍 Org / 環境マネージャ
- 認証済み org を **Production / Sandbox / Dev Hub / Scratch** に自動分類してツリー表示
- **本番 org を赤い盾アイコン**で警告（login.salesforce.com / My Domain を判定）
- 既定 org の切替・ブラウザで開く・Org ID コピー・認証解除をワンクリック
- 未接続 org をグレー表示

### 🔀 Git 差分デプロイ
- `origin/main` などの**ベース ref との差分**だけをデプロイ／検証（誤爆防止）
- マージベース (`base...HEAD`) を使い、ベースブランチ側の無関係な変更を除外
- コミット済み＋作業ツリー＋未追跡ファイルをすべて対象
- パッケージディレクトリ外の変更は自動で除外、削除は別表示で安全側に倒す
- **本番 org へのデプロイはモーダルで二重確認**

### ⚙️ チーム共有設定 (`sf-teamflow.json`)
リポジトリにコミットしてチーム全員で共有する設定ファイル。
環境名・org エイリアス・ブランチ（glob 可）・テストレベルを宣言します。

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

---

## クイックスタート

1. SFDX プロジェクト（`sfdx-project.json` がある）を VSCode で開く
2. アクティビティバーの **SF TeamFlow** アイコンを開く
3. コマンドパレットで **「TeamFlow: チーム開発プロジェクトを初期化」** を実行 → `sf-teamflow.json` が生成される
4. 環境と org エイリアスを自分のチームに合わせて編集
5. **「TeamFlow: CI/CD (GitHub Actions) を生成」** で CI を出力
6. 日々の開発では **「TeamFlow: Git差分をデプロイ / 検証」** を使う

---

## コマンド一覧

| コマンド | 説明 |
|---|---|
| `TeamFlow: Org一覧を更新` | 認証済み org を再取得 |
| `TeamFlow: 新しいOrgを認証` | `sf org login web` を起動 |
| `TeamFlow: このOrgを既定に設定` | `target-org` を設定 |
| `TeamFlow: ブラウザでOrgを開く` | `sf org open` |
| `TeamFlow: Git差分をデプロイ` | 差分メタデータをデプロイ |
| `TeamFlow: Git差分を検証 (デプロイなし)` | check-only デプロイ |
| `TeamFlow: デプロイ対象の差分をプレビュー` | 出力パネルに差分を表示 |
| `TeamFlow: CI/CD (GitHub Actions) を生成` | ワークフロー＋CODEOWNERS を生成 |
| `TeamFlow: チーム開発プロジェクトを初期化` | `sf-teamflow.json` を作成 |
| `TeamFlow: スクラッチOrgを作成` | `sf org create scratch` |

## 設定 (settings)

| キー | 既定 | 説明 |
|---|---|---|
| `teamflow.deploy.baseRef` | `origin/main` | 差分の基準 ref（`sf-teamflow.json` があればそちら優先） |
| `teamflow.deploy.testLevel` | `RunLocalTests` | デプロイ／検証時のテストレベル |
| `teamflow.confirmProductionDeploy` | `true` | 本番デプロイ前に確認ダイアログを出す |
| `teamflow.sfCliPath` | `sf` | Salesforce CLI の実行パス |

---

## 必要環境

- VSCode 1.85 以上
- [Salesforce CLI (`sf`)](https://developer.salesforce.com/tools/salesforcecli) がインストール済みで PATH が通っていること
- Git

## 開発

```bash
npm install
npm run watch      # esbuild watch
# VSCode で F5 → 拡張開発ホストが起動
npm run check-types
npm test           # ピュアロジックのユニットテスト (node:test)
npm run package    # .vsix を生成 (要 @vscode/vsce)
```

アーキテクチャ: UI（`vscode` 依存）とドメインロジック（純粋関数）を分離しています。
`orgService` / `gitService` / `deployService` / `teamflowConfig` / `cicd/templates` は副作用のない純粋関数として実装され、`node:test` で網羅的にテストされています。

## ライセンス

MIT
