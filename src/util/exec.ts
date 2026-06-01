import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  /** Hard timeout in ms. */
  timeout?: number;
  /** Max buffer for stdout/stderr (sf --json can be large). */
  maxBuffer?: number;
}

/**
 * win32 では `run` が shell 経由で実行する（.cmd シム対応）。その際、実行ファイルパスに
 * スペースが含まれる（例: ユーザーが sfCliPath に "C:\Program Files\..." を設定／OneDrive配下）と
 * 引用符なしでは cmd がパスを途中で切ってしまい起動できない。スペースを含む場合のみ引用符で囲む。
 * スペースの無い "sf"/"git" 等は **そのまま返す**（従来動作と完全一致＝一般ケースは不変）。
 * POSIX は shell:false でパスがそのまま argv[0] になるため何もしない。Pure & unit-tested.
 */
export function quoteExecutable(file: string, platform: NodeJS.Platform): string {
  if (platform !== "win32" || !/\s/.test(file) || file.startsWith('"')) {
    return file;
  }
  return `"${file}"`;
}

/**
 * Thin promise wrapper around child_process.execFile — the single choke point
 * through which every `sf` and `git` invocation flows.
 *
 * On POSIX we run with no shell (argv array, nothing reinterpreted). On Windows
 * `sf`/`git` resolve to .cmd/.exe shims that recent Node refuses to launch via
 * execFile without a shell, so we enable shell only there. Because of that, all
 * callers pass arguments that originate from the CLI's own output (org aliases,
 * usernames) or fixed literals — never raw, unsanitised user free-text — so the
 * shell has nothing dangerous to reinterpret.
 *
 * Resolves (never rejects) with the captured streams + exit code so callers can
 * branch on `code` and still read partial JSON that the CLI emitted on failure.
 */
export function run(
  file: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      quoteExecutable(file, process.platform),
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 0,
        maxBuffer: options.maxBuffer ?? 1024 * 1024 * 64,
        windowsHide: true,
        // On Windows `sf` / `git` are resolved as .cmd/.exe via PATHEXT, which
        // requires shell resolution for the .cmd shim. We pass shell:false and
        // rely on the OS resolving the executable; callers pass the resolved
        // binary name. `sf` ships a native launcher so this works cross-platform.
        shell: process.platform === "win32",
      },
      (error, stdout, stderr) => {
        const errno = error as NodeJS.ErrnoException | null;
        const code =
          errno && typeof errno.code === "number"
            ? (errno.code as number)
            : error
            ? 1
            : 0;
        let errText = stderr?.toString() ?? "";
        // spawn 自体の失敗（コマンド未インストール等）は stderr が空になりがちで、
        // 呼び出し側が「原因不明の失敗」になる。原因を stderr に載せて拾えるようにする。
        if (error && !errText) {
          errText =
            errno?.code === "ENOENT"
              ? `コマンド「${file}」が見つかりません（未インストール、または PATH 未設定の可能性があります）。`
              : error.message ?? "";
        }
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: errText,
          code,
        });
      }
    );
  });
}
