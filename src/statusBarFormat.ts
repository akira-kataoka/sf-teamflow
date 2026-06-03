/**
 * ステータスバー（ブランチ → 環境 表示）のテキスト/ツールチップ/本番判定を組み立てる
 * 純粋ロジック。vscode 依存を排して `node:test` で検証できるようにし、表示の不変条件
 * （本番ブランチの ⚠️ 強調など）を固定する。アイコンは VS Code の $(...) 記法。
 */

export interface GitBarStatus {
  branch: string;
  changed: number;
  ahead: number;
  behind: number;
}

export interface GitBarEnv {
  name: string;
  type: string;
}

export interface GitBarParts {
  text: string;
  tooltip: string;
  /** 現在ブランチが本番環境に割り当たっているか（警告色の付与に使う）。 */
  isProduction: boolean;
}

/**
 * ブランチ状態と（割当があれば）環境から、ステータスバー表示を組み立てる。
 * 本番環境のブランチは ⚠️ を付け、`isProduction` を立てて呼び出し側が警告色にできるようにする。
 * Pure & unit-tested.
 */
export function formatGitStatusBar(s: GitBarStatus, env: GitBarEnv | undefined): GitBarParts {
  const prod = env?.type === "production";
  const envLabel = env ? ` → ${prod ? "⚠️ " : ""}${env.name}` : "";
  const up = s.ahead > 0 ? `$(arrow-up)${s.ahead} ` : "";
  const down = s.behind > 0 ? `$(arrow-down)${s.behind} ` : "";
  const dirty = s.changed > 0 ? `$(pencil)${s.changed} ` : "";
  const text = `$(git-branch) ${s.branch}${envLabel} ${up}${down}${dirty}`.trim();
  const tip = [
    `ブランチ: ${s.branch}${env ? ` → 環境 ${env.name}` : "（環境未割当）"}`,
    prod ? "⚠️ このブランチは本番環境です（変更は原則 Pull Request 経由で）" : undefined,
    s.changed > 0 ? `未保存の変更: ${s.changed}件` : "変更なし",
    s.ahead > 0 ? `未バックアップ: ${s.ahead}件` : undefined,
    s.behind > 0 ? `取り込み待ち: ${s.behind}件` : undefined,
    "クリックで保存してGitHubにバックアップ",
  ].filter(Boolean);
  return { text, tooltip: tip.join("\n"), isProduction: prod };
}
