import { run } from "./exec.js";

export interface SfVersion {
  major: number;
  minor: number;
  patch: number;
}

/** `sf --version`（例: "@salesforce/cli/2.25.7 win32-x64 node-v20.10.0"）からバージョンを抽出。 */
export function parseSfVersion(out: string): SfVersion | undefined {
  const m = out.match(/@salesforce\/cli\/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    return undefined;
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * 既知の不具合(例: 2.25系の "Missing message ... Finalizing" クラッシュ)を避けるための
 * 下限を下回るかを判定。floor は「最新」ではなく安全な下限。parse不能なら false(警告しない)。
 * Pure & unit-tested.
 */
export function isSfVersionOutdated(out: string, floorMajor = 2, floorMinor = 40): boolean {
  const v = parseSfVersion(out);
  if (!v) {
    return false;
  }
  return v.major < floorMajor || (v.major === floorMajor && v.minor < floorMinor);
}

/**
 * sf CLI のエラー出力（stderr 優先、無ければ stdout）から初心者向けに簡潔な要約を作る。
 * ノイズ行（「update available」更新通知、Node の `(node:…)` 警告や
 * Experimental/DeprecationWarning）を除いてから末尾3行を「 / 」で連結する。
 * こうしたノイズが多いと本当のエラーが末尾3行から押し出されるのを防ぐ。空なら ""。Pure & unit-tested.
 */
export function summarizeCliError(stderr: string, stdout: string): string {
  return (stderr || stdout || "")
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/update available/i.test(l) &&
        !/^\(node:\d+\)/.test(l) &&
        !/\b(?:ExperimentalWarning|DeprecationWarning)\b/.test(l)
    )
    .slice(-3)
    .join(" / ");
}

export interface CiRunSummary {
  /** 状態アイコン（✅/❌/⏹/⏭/🟡）。 */
  icon: string;
  /** 日本語の状態ラベル（成功/失敗/実行中 など）。 */
  label: string;
  /** ワークフロー名（取得できれば）。 */
  workflow?: string;
  /** 対象ブランチ（取得できれば）。 */
  branch?: string;
  /** 完了して失敗しているか（UIの強調に使う）。 */
  failed: boolean;
}

/**
 * `gh run list --json status,conclusion,workflowName,headBranch` の出力（配列JSON）から、
 * 最新のCI実行を初心者向けに要約する。完了前は実行中/待機中、完了後は結論を日本語化。
 * 実行が無い/JSON不正なら undefined。Pure & unit-tested.
 */
export function summarizeCiRun(jsonStr: string): CiRunSummary | undefined {
  let arr: unknown;
  try {
    arr = JSON.parse(jsonStr);
  } catch {
    return undefined;
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    return undefined;
  }
  const r = arr[0] as Record<string, unknown>;
  const status = String(r.status ?? "");
  const conclusion = String(r.conclusion ?? "");
  const workflow = typeof r.workflowName === "string" ? r.workflowName : undefined;
  const branch = typeof r.headBranch === "string" ? r.headBranch : undefined;
  if (status !== "completed") {
    const label = status === "queued" ? "待機中" : "実行中";
    return { icon: "🟡", label, workflow, branch, failed: false };
  }
  const map: Record<string, { icon: string; label: string; failed: boolean }> = {
    success: { icon: "✅", label: "成功", failed: false },
    failure: { icon: "❌", label: "失敗", failed: true },
    cancelled: { icon: "⏹", label: "キャンセル", failed: false },
    timed_out: { icon: "❌", label: "タイムアウト", failed: true },
    skipped: { icon: "⏭", label: "スキップ", failed: false },
  };
  const m = map[conclusion] ?? { icon: "ℹ️", label: conclusion || "完了", failed: false };
  return { icon: m.icon, label: m.label, workflow, branch, failed: m.failed };
}

/**
 * Salesforce のデプロイ/テスト失敗出力から、初心者向けの「次にどうするか」を1行で返す
 * （該当しなければ undefined）。生のCLI要約（summarizeCliError）に添えて表示する用途。
 * よくある原因を日本語の対処に翻訳する。Pure & unit-tested.
 */
export function sfDeployErrorHint(output: string): string | undefined {
  const t = (output || "").toLowerCase();
  if (/coverage/.test(t) && /(75|below|less than|0%|insufficient|requires)/.test(t)) {
    return "テストカバレッジが不足しています（本番デプロイには全体75%以上が必要）。テストクラスを追加・実行してから再度お試しください。";
  }
  if (/invalid_field|invalid field|no such column|field .* does not exist|invalid_field_for_insert_update/.test(t)) {
    return "存在しない項目（フィールド）を参照しています。対象Orgにその項目があるか、API参照名が正しいか確認してください。";
  }
  if (/insufficient access|insufficient_access|insufficient privileges|insufficient permissions/.test(t)) {
    return "権限が不足しています。デプロイ先Orgの権限（プロファイル/権限セット）を確認してください。";
  }
  if (/duplicate value|duplicate_developer_name|duplicate_value/.test(t)) {
    return "同じ名前/値が既に存在します（重複）。名前を変えるか、既存のものを確認してください。";
  }
  if (/tests? failed|test failure|run_test.*fail|methodname.*fail|system\.assert/.test(t)) {
    return "Apexテストが失敗しました。出力ログで失敗したテスト・行を確認して修正してください。";
  }
  if (/dependent class is invalid|variable does not exist|method does not exist|unexpected token|expecting .* found/.test(t)) {
    return "Apexのコンパイルエラーです。出力ログのクラス名・行番号を確認して修正してください。";
  }
  if (/required_field_missing|required field is missing|missing required field/.test(t)) {
    return "必須項目が不足しています。メタデータに必要な項目が含まれているか確認してください。";
  }
  return undefined;
}

/** Shape of every `sf ... --json` envelope. */
export interface SfJson<T> {
  status: number;
  result: T;
  warnings?: string[];
  message?: string;
  name?: string;
}

export class SfCliError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly raw: string
  ) {
    super(message);
    this.name = "SfCliError";
  }
}

/**
 * 文字列から最初の "{" 〜 最後の "}" までを切り出す（無ければ undefined）。
 * sf の JSON 出力は単一のトップレベルオブジェクトなので、前後に紛れた
 * 非JSONテキスト（警告・更新通知）を取り除く用途。波括弧が無ければ undefined。
 */
function extractJsonObject(s: string): string | undefined {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }
  return s.slice(start, end + 1);
}

/**
 * Pure parser for an `sf --json` envelope. Exported so it can be unit-tested
 * without spawning the CLI. Throws SfCliError on a non-zero status or when the
 * payload is not the expected envelope.
 */
export function parseSfJson<T>(stdout: string, exitCode: number): SfJson<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // sf は稀に JSON 本体の前後に非JSONの行を混ぜる（"Warning: ... update available"
    // などの更新通知や Node の deprecation 警告）。その場合でも本体は有効なので、
    // 先頭の "{" から末尾の "}" までを切り出して再パースを試みる。
    const sliced = extractJsonObject(stdout);
    if (sliced !== undefined) {
      try {
        parsed = JSON.parse(sliced);
      } catch {
        parsed = undefined;
      }
    }
    if (parsed === undefined) {
      throw new SfCliError(
        "Salesforce CLI did not return JSON. Is `sf` installed and on PATH?",
        exitCode,
        stdout.slice(0, 2000)
      );
    }
  }
  if (typeof parsed !== "object" || parsed === null || !("status" in parsed)) {
    throw new SfCliError("Unexpected sf JSON envelope.", exitCode, stdout.slice(0, 2000));
  }
  const env = parsed as SfJson<T>;
  if (env.status !== 0) {
    throw new SfCliError(env.message ?? `sf exited with status ${env.status}`, env.status, stdout);
  }
  return env;
}

export interface SfRunOptions {
  cliPath?: string;
  cwd?: string;
  timeout?: number;
}

/**
 * Run an `sf` command with `--json` appended and return the parsed `result`.
 * Always appends `--json` if the caller has not already.
 */
export async function runSf<T>(args: string[], options: SfRunOptions = {}): Promise<T> {
  const cli = options.cliPath || "sf";
  const finalArgs = args.includes("--json") ? args : [...args, "--json"];
  const res = await run(cli, finalArgs, { cwd: options.cwd, timeout: options.timeout });
  // sf prints JSON to stdout on both success and most failures.
  const env = parseSfJson<T>(res.stdout || res.stderr, res.code);
  return env.result;
}
