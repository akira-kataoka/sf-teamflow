import { test } from "node:test";
import assert from "node:assert/strict";
import { run, quoteExecutable, needsWinShell, winCmdQuote } from "../src/util/exec.js";

test("quoteExecutable: スペース無しの一般ケースは不変(従来動作維持)", () => {
  assert.equal(quoteExecutable("sf", "win32"), "sf");
  assert.equal(quoteExecutable("git", "win32"), "git");
  assert.equal(quoteExecutable("C:\\tools\\sf.cmd", "win32"), "C:\\tools\\sf.cmd", "スペース無しパスも不変");
});

test("quoteExecutable: win32 でスペースを含むパスは引用符で囲む", () => {
  assert.equal(
    quoteExecutable("C:\\Program Files\\sf\\bin\\sf.cmd", "win32"),
    '"C:\\Program Files\\sf\\bin\\sf.cmd"'
  );
  // 既に引用済みは二重に囲まない
  assert.equal(quoteExecutable('"C:\\Program Files\\sf.cmd"', "win32"), '"C:\\Program Files\\sf.cmd"');
});

test("quoteExecutable: 非win32(POSIX)は何もしない(shell:falseのため)", () => {
  assert.equal(quoteExecutable("/usr/local/bin/with space/sf", "linux"), "/usr/local/bin/with space/sf");
  assert.equal(quoteExecutable("/opt/sf", "darwin"), "/opt/sf");
});

test("needsWinShell: win32 では .cmd/.bat と bare sf のみ shell 必須、実exeは false", () => {
  // shell 必須（.cmd シム）
  assert.equal(needsWinShell("sf", "win32"), true, "bare sf は sf.cmd の可能性");
  assert.equal(needsWinShell("C:\\Users\\u\\AppData\\npm\\sf.cmd", "win32"), true);
  assert.equal(needsWinShell("foo.bat", "win32"), true);
  assert.equal(needsWinShell('"C:\\p ath\\sf.cmd"', "win32"), true, "引用符付きでも判定");
  // 実exe は shell:false（引数を逐語的に渡し特殊文字を壊さない）
  assert.equal(needsWinShell("git", "win32"), false);
  assert.equal(needsWinShell("gh", "win32"), false);
  assert.equal(needsWinShell("openssl", "win32"), false);
  assert.equal(needsWinShell("C:\\Program Files\\Git\\cmd\\git.exe", "win32"), false);
  // 非 win32 は常に false（POSIX は shell:false）
  assert.equal(needsWinShell("sf", "linux"), false);
  assert.equal(needsWinShell("foo.cmd", "darwin"), false);
});

test("winCmdQuote: スペース/特殊文字を含む引数だけ二重引用符で囲む", () => {
  // 安全な単語はそのまま（過剰クォートしない）
  assert.equal(winCmdQuote("data"), "data");
  assert.equal(winCmdQuote("--target-org"), "--target-org");
  assert.equal(winCmdQuote("me@example.com"), "me@example.com");
  assert.equal(winCmdQuote("config/project-scratch-def.json"), "config/project-scratch-def.json");
  // スペースを含む SOQL クエリは囲む（単語分割されないように）
  assert.equal(winCmdQuote("SELECT Id FROM ScratchOrgInfo LIMIT 1"), '"SELECT Id FROM ScratchOrgInfo LIMIT 1"');
  // cmd 特殊文字を含む場合も囲む
  assert.equal(winCmdQuote("A & B"), '"A & B"');
  assert.equal(winCmdQuote("a|b"), '"a|b"');
  // 内部の " は "" にエスケープ
  assert.equal(winCmdQuote('say "hi"'), '"say ""hi"""');
  // 空文字は ""（空の引数を保持）
  assert.equal(winCmdQuote(""), '""');
});

test("run: 存在しないコマンドは原因をstderrに載せて非ゼロで返す(rejectしない)", async () => {
  const res = await run("sf-teamflow-no-such-binary-xyz", ["--version"], { timeout: 10_000 });
  assert.notEqual(res.code, 0, "失敗は非ゼロのexit code");
  assert.ok(res.stderr.length > 0, "原因がstderrに入る（原因不明の失敗を避ける）");
});

test("run: 正常コマンド(node --version)は code 0 と stdout を返す", async () => {
  // PATH 解決の "node"（スペース無し）を使う。フルパスはWindowsのshell経由でスペース問題になるため。
  const res = await run("node", ["--version"], { timeout: 10_000 });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^v?\d+\.\d+\.\d+/);
});
