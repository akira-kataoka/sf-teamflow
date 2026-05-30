import { run } from "./exec.js";

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
 * Pure parser for an `sf --json` envelope. Exported so it can be unit-tested
 * without spawning the CLI. Throws SfCliError on a non-zero status or when the
 * payload is not the expected envelope.
 */
export function parseSfJson<T>(stdout: string, exitCode: number): SfJson<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SfCliError(
      "Salesforce CLI did not return JSON. Is `sf` installed and on PATH?",
      exitCode,
      stdout.slice(0, 2000)
    );
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
