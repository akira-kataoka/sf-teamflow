/**
 * チーム開発の「準備状況」を、確実に検出できる項目だけで段階表示するための
 * 純粋ロジック。ホーム画面のヒーロー（次の1手）が "今やること" を示すのに対し、
 * このパネルは "チーム開発に必要な全体像と、どこまで終わったか" を一目で示す。
 *
 * vscode 非依存（node:test でユニットテスト可能）。検出が不確実な項目
 * （CIシークレット登録・ブランチ保護）はここでは ✓ 管理せず、UI 側で
 * 「仕上げ（任意）」の導線として案内する。
 */

export interface ReadinessInput {
  /** sfdx-project.json がある */
  hasProject: boolean;
  /** 認証済みの環境(Org)数 */
  orgCount: number;
  /** sf-teamflow.json がある（環境⇔ブランチ⇔接続先を定義済み） */
  configured: boolean;
  /** GitHub リモートに接続済み */
  hasRemote: boolean;
  /** CI/CD ワークフロー（.github/workflows/sf-deploy.yml 等）を生成済み */
  ciScaffolded: boolean;
}

export interface ReadinessStep {
  key: string;
  emoji: string;
  label: string;
  done: boolean;
  /** 未完了のときにクリックで実行するコマンド（無い場合もある）。 */
  command?: string;
  /** 補足（任意）。 */
  hint?: string;
}

export interface TeamReadiness {
  steps: ReadinessStep[];
  doneCount: number;
  total: number;
  allDone: boolean;
  /** 先頭の未完了ステップ（無ければ undefined）。UIで強調する用途。 */
  nextKey?: string;
}

/**
 * チーム開発の準備ステップ（プロジェクト→環境認証→環境設定→GitHub接続→CI/CD生成）を
 * 入力フラグから組み立てて返す。Pure & unit-tested.
 */
export function computeTeamReadiness(input: ReadinessInput): TeamReadiness {
  const steps: ReadinessStep[] = [
    {
      key: "project",
      emoji: "📂",
      label: "Salesforceプロジェクト",
      done: input.hasProject,
      command: "teamflow.createProject",
    },
    {
      key: "auth",
      emoji: "🔌",
      label:
        input.orgCount > 0 ? `環境を認証（${input.orgCount}件）` : "環境を認証（ログイン）",
      done: input.orgCount > 0,
      command: "teamflow.authorizeOrg",
    },
    {
      key: "config",
      emoji: "🧭",
      label: "環境を設定（開発/ステージング/本番）",
      done: input.configured,
      command: "teamflow.setupWizard",
    },
    {
      key: "github",
      emoji: "🐙",
      label: "GitHubに接続",
      done: input.hasRemote,
      command: "teamflow.gitPublish",
    },
    {
      key: "cicd",
      emoji: "🤖",
      label: "CI/CDを生成（PR検証＋自動デプロイ）",
      done: input.ciScaffolded,
      command: "teamflow.scaffoldCICD",
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return {
    steps,
    doneCount,
    total: steps.length,
    allDone: doneCount === steps.length,
    nextKey: next?.key,
  };
}
