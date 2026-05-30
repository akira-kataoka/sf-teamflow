## CI/CDを生成する

チーム設定をもとに **GitHub Actions** を自動生成します。

- `sf-validate.yml` … Pull Request 時に自動で検証（壊れていないか確認）
- `sf-deploy.yml` … 環境ブランチへのマージ時に自動デプロイ
- `CODEOWNERS` … レビュー担当の割り当て

認証は JWT 方式。各環境のシークレット（`SF_<ENV>_CLIENT_ID` など）を GitHub に設定してください。
