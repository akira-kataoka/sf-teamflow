/**
 * ホーム画面ヒーロー（「次にやること」）の決定ロジック。状況から “今やるべき1手” を
 * 一意に選ぶ。従来はクライアントJS内にあり未テストだったため、ホスト側の純粋関数に
 * 切り出して node:test で検証可能にした（vscode 非依存）。
 *
 * 初回フロー: ⓪プロジェクト → ①環境認証 → ②環境設定。その後は日々のループ
 * （保存→同期）。さらに GitHub Flow の次の一歩として、feature ブランチを push 済みで
 * 保留が無いときは「Pull Request 作成（レビュー依頼）」へ導く。
 */

export interface NextActionInput {
  hasFolder: boolean;
  hasProject: boolean;
  /** 既定環境の接続状態。既定環境が無ければ null。 */
  defaultOrgConnected: boolean | null;
  defaultOrgName?: string;
  defaultOrgUsername?: string;
  orgCount: number;
  configured: boolean;
  changes: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  branch: string;
  /** 現在ブランチが共有の基準ブランチ(main/develop 等)か。 */
  onBaseBranch: boolean;
}

export interface NextAction {
  em: string;
  t1: string;
  t2: string;
  /** 実行するコマンド（クリックで起動）。 */
  command?: string;
  /** 再接続対象のユーザー名（reconnect 専用導線）。 */
  reconnect?: string;
  /** 操作不要の落ち着いた状態。 */
  calm?: boolean;
}

/**
 * 状況に応じた唯一の「次にやること」を返す。Pure & unit-tested.
 */
export function computeNextAction(s: NextActionInput): NextAction {
  if (!s.hasFolder) {
    return { em: "📂", t1: "はじめに（1）", t2: "新しいプロジェクトを作成する", command: "teamflow.createProject" };
  }
  if (!s.hasProject) {
    return { em: "📂", t1: "はじめに（1）", t2: "Salesforceプロジェクトを作成する", command: "teamflow.createProject" };
  }
  if (s.defaultOrgConnected === false) {
    return {
      em: "🔌",
      t1: "接続が切れています",
      t2: (s.defaultOrgName ?? "既定の環境") + " に再接続する",
      reconnect: s.defaultOrgUsername,
    };
  }
  if (s.orgCount === 0) {
    return { em: "🔌", t1: "はじめに（2）", t2: "環境を認証する（ログイン）", command: "teamflow.authorizeOrg" };
  }
  if (!s.configured) {
    return { em: "🧭", t1: "はじめに（3）", t2: "環境を設定する（開発/ステージング/本番）", command: "teamflow.setupWizard" };
  }
  if (s.changes > 0) {
    return { em: "💾", t1: "次にやること", t2: "変更 " + s.changes + "件をバックアップ", command: "teamflow.gitCommitPush" };
  }
  if (s.ahead > 0) {
    return { em: "🔄", t1: "次にやること", t2: "未バックアップ " + s.ahead + "件をGitHubへ", command: "teamflow.gitSync" };
  }
  if (s.behind > 0) {
    return { em: "🔄", t1: "次にやること", t2: "リモートの更新 " + s.behind + "件を取り込む", command: "teamflow.gitSync" };
  }
  // 保留なし。feature ブランチ（共有の基準ブランチ以外）を push 済みなら、
  // GitHub Flow の次の一歩としてレビュー依頼（PR）へ導く。
  if (s.hasRemote && !!s.branch && !s.onBaseBranch) {
    return {
      em: "🔀",
      t1: "次にやること",
      t2: "レビュー依頼（Pull Request）を作成",
      command: "teamflow.createPullRequest",
    };
  }
  return { em: "✅", t1: "準備OK", t2: "いまやる操作はありません", calm: true };
}
