import type { TestLevel } from "../config/teamflowConfig.js";

export interface DeployPlan {
  files: string[];
  orgAlias: string;
  testLevel: TestLevel;
  /** true => `sf project deploy validate` (check-only), false => real deploy. */
  validateOnly: boolean;
  specifiedTests?: string[];
}

/**
 * Build the `sf` argv for a deploy or validate. Pure & unit-tested. We pass each
 * changed file as its own `-d` so sf resolves the metadata bundle from the path
 * — no manifest generation needed for the common case.
 */
export function buildDeployArgs(plan: DeployPlan): string[] {
  if (plan.files.length === 0) {
    throw new Error("デプロイ対象のファイルがありません。");
  }
  const verb = plan.validateOnly ? "validate" : "start";
  const args: string[] = ["project", "deploy", verb];
  for (const f of plan.files) {
    args.push("-d", f);
  }
  args.push("-o", plan.orgAlias);
  args.push("-l", plan.testLevel);
  if (plan.testLevel === "RunSpecifiedTests") {
    for (const t of plan.specifiedTests ?? []) {
      args.push("-t", t);
    }
  }
  return args;
}

export interface DeployConfirmInput {
  /** This run is a check-only validate (no confirmation escalation needed). */
  validateOnly: boolean;
  /** Target org is production. */
  isProduction: boolean;
  /** User setting `teamflow.confirmProductionDeploy`. */
  confirmProduction: boolean;
  /** Environment is flagged `requireValidation` in sf-teamflow.json. */
  requireValidation: boolean;
}

/**
 * Decide how strongly to confirm a deploy before running it. Pure & unit-tested
 * so the (UI) confirmation flow stays a thin switch over this decision.
 *  - "production"   … 本番＋確認ON: 検証を勧める強い確認（🛑）
 *  - "validateFirst"… 本番扱いでないが `requireValidation` の環境: 検証を勧める確認
 *  - "normal"       … 通常の実行確認
 * validate（お試し）実行自体はエスカレーション不要なので常に "normal"。
 */
export function deployConfirmKind(
  i: DeployConfirmInput
): "production" | "validateFirst" | "normal" {
  if (i.validateOnly) {
    return "normal";
  }
  if (i.isProduction && i.confirmProduction) {
    return "production";
  }
  if (i.requireValidation) {
    return "validateFirst";
  }
  return "normal";
}

/**
 * テストレベルを初心者向けに「コード値（平易な説明）」へ整形する。デプロイ確認画面など
 * 高リスクな表示で、RunLocalTests 等の専門用語に意味を添える。未知の値はそのまま返す。
 * Pure & unit-tested.
 */
export function testLevelLabel(level: string): string {
  const gloss: Record<string, string> = {
    NoTestRun: "テストなし",
    RunSpecifiedTests: "指定したテストのみ",
    RunLocalTests: "自組織のテストを実行（推奨）",
    RunAllTestsInOrg: "組織の全テスト（時間がかかる）",
  };
  const g = gloss[level];
  return g ? `${level}（${g}）` : level;
}

/** Quote an argv element for display / terminal execution. */
export function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Render a full, copy-pasteable command line for a terminal or the log. */
export function renderCommand(cliPath: string, args: string[]): string {
  return [cliPath, ...args].map(quoteArg).join(" ");
}
