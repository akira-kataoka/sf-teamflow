import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 実行結果テキストが「コマンド未インストール／PATH未設定」を示すかを判定する。
 * run() は ENOENT 時に日本語の「見つかりません（未インストール…）」を stderr に載せるが、
 * シェル経由の場合は OS 依存メッセージ（not recognized / command not found）になり得るので
 * 両方を拾う。Pure & unit-tested.
 */
export function isCommandNotFoundError(text: string): boolean {
  return /見つかりません（未インストール|ENOENT|not recognized|command not found|no such file/i.test(
    text || ""
  );
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
 * win32 で shell 経由実行が必要か（＝`.cmd`/`.bat` シムか）。Node のセキュリティ制約で
 * `.cmd`/`.bat` は shell:true でしか起動できない（例: npm グローバルの `sf` は `sf.cmd`）。
 * 一方 shell:true は引数中の `& | < > ^ ( )` 等の cmd 特殊文字を破壊するため
 * （例: コミットメッセージ "A & B" が壊れてコミット失敗）、実exe（git/gh/openssl 等）は
 * shell:false で逐語的に引数を渡す。win32 以外は常に false。Pure & unit-tested.
 */
export function needsWinShell(file: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") {
    return false;
  }
  const base = file.replace(/^.*[\\/]/, "").toLowerCase().replace(/^"|"$/g, "");
  return base === "sf" || base.endsWith(".cmd") || base.endsWith(".bat");
}

/**
 * 1つの引数を cmd.exe 用にクォートする。`shell:true` では Node が引数をエスケープせず
 * 連結するだけなので（スペースを含む `--query "SELECT ..."` 等が単語分割されて壊れる）、
 * 自前でクォートする。スペース・cmd特殊文字・引用符を含む場合のみ二重引用符で囲み、
 * 内部の `"` は `""` にする（cmd / CommandLineToArgvW 双方で実用的）。Pure & unit-tested.
 */
export function winCmdQuote(arg: string): string {
  if (arg === "") {
    return '""';
  }
  if (!/[\s"&|<>^()%!]/.test(arg)) {
    return arg;
  }
  return '"' + arg.replace(/"/g, '""') + '"';
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
  // shell が必要なのは Windows の `.cmd`/`.bat` シム（例: `sf.cmd`）のみ。実exe（git/gh/
  // openssl 等）に shell:true を使うと、引数中の cmd 特殊文字（& | < > ^ ( )）が壊れる
  // （例: コミットメッセージ "A & B" がコマンド区切りと解釈され失敗）。実exeは shell:false で
  // 逐語的に引数を渡す。shell が要るときだけスペース対策の引用符でパスを囲む。
  const useShell = needsWinShell(file, process.platform);
  // shell:true（Windowsの.cmdシム）では Node が引数をエスケープせず連結するだけなので、
  // 自前で cmd 用にクォートしたコマンド文字列を組み立て、args は空で渡す
  // （スペース/特殊文字入りの引数＝SOQLクエリ等が単語分割される破壊を防ぐ）。
  // 実exe（shell:false）は execFile が引数を逐語的に渡すのでそのまま。
  const spawnFile = useShell
    ? [quoteExecutable(file, process.platform), ...args.map(winCmdQuote)].join(" ")
    : file;
  const spawnArgs = useShell ? [] : args;
  return new Promise((resolve) => {
    execFile(
      spawnFile,
      spawnArgs,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 0,
        maxBuffer: options.maxBuffer ?? 1024 * 1024 * 64,
        windowsHide: true,
        shell: useShell,
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
