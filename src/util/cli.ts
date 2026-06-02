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
 * 「update available」等のノイズ行を除き、末尾3行を「 / 」で連結する。空なら ""。Pure & unit-tested.
 */
export function summarizeCliError(stderr: string, stdout: string): string {
  return (stderr || stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l && !/update available/i.test(l))
    .slice(-3)
    .join(" / ");
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
