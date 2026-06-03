import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSfJson,
  SfCliError,
  parseSfVersion,
  isSfVersionOutdated,
  summarizeCliError,
  sfDeployErrorHint,
  summarizeCiRun,
} from "../src/util/cli.js";

test("summarizeCiRun: 完了の結論を日本語アイコンに（成功/失敗/キャンセル/スキップ）", () => {
  const ok = summarizeCiRun(
    JSON.stringify([{ status: "completed", conclusion: "success", workflowName: "CI", headBranch: "main" }])
  );
  assert.equal(ok?.icon, "✅");
  assert.equal(ok?.label, "成功");
  assert.equal(ok?.failed, false);
  assert.equal(ok?.workflow, "CI");
  assert.equal(ok?.branch, "main");

  const ng = summarizeCiRun(JSON.stringify([{ status: "completed", conclusion: "failure" }]));
  assert.equal(ng?.icon, "❌");
  assert.equal(ng?.failed, true);
  assert.equal(summarizeCiRun(JSON.stringify([{ status: "completed", conclusion: "cancelled" }]))?.label, "キャンセル");
  assert.equal(summarizeCiRun(JSON.stringify([{ status: "completed", conclusion: "skipped" }]))?.label, "スキップ");
});

test("summarizeCiRun: 未完了は実行中/待機中（failed=false）", () => {
  assert.equal(summarizeCiRun(JSON.stringify([{ status: "in_progress" }]))?.label, "実行中");
  assert.equal(summarizeCiRun(JSON.stringify([{ status: "queued" }]))?.label, "待機中");
  assert.equal(summarizeCiRun(JSON.stringify([{ status: "in_progress" }]))?.icon, "🟡");
});

test("summarizeCiRun: 実行なし・不正JSONは undefined", () => {
  assert.equal(summarizeCiRun("[]"), undefined);
  assert.equal(summarizeCiRun("not json"), undefined);
  assert.equal(summarizeCiRun(""), undefined);
});

test("sfDeployErrorHint: よくあるデプロイ/テスト失敗を初心者向けの対処に翻訳", () => {
  assert.match(
    sfDeployErrorHint("Your code coverage is 0%. You need at least 75% coverage") || "",
    /カバレッジ/
  );
  assert.match(sfDeployErrorHint("INVALID_FIELD: No such column 'Foo__c'") || "", /項目/);
  assert.match(sfDeployErrorHint("INSUFFICIENT_ACCESS_OR_READONLY") || "", /権限/);
  assert.match(sfDeployErrorHint("DUPLICATE_DEVELOPER_NAME: duplicate value found") || "", /重複/);
  assert.match(sfDeployErrorHint("Test failure: System.AssertException") || "", /テスト/);
  assert.match(sfDeployErrorHint("Variable does not exist: acc (line 12)") || "", /コンパイル/);
});

test("sfDeployErrorHint: 該当しない/空は undefined", () => {
  assert.equal(sfDeployErrorHint("Deploy succeeded"), undefined);
  assert.equal(sfDeployErrorHint(""), undefined);
});

test("summarizeCliError: stderr優先・update availableノイズ除去・末尾3行を連結", () => {
  assert.equal(summarizeCliError("ERR a", "OUT b"), "ERR a", "stderr優先");
  assert.equal(summarizeCliError("", "OUT only"), "OUT only", "stderr空ならstdout");
  assert.equal(
    summarizeCliError("Warning: update available 2.99\nReal error here", ""),
    "Real error here",
    "update available行は除去"
  );
  assert.equal(summarizeCliError("l1\nl2\nl3\nl4\nl5", ""), "l3 / l4 / l5", "末尾3行のみ");
  assert.equal(summarizeCliError("", ""), "", "空入力は空文字");
  assert.equal(summarizeCliError("   ", ""), "", "空白のみは空文字");
});

test("summarizeCliError: Nodeの警告ノイズを除外し本当のエラーを残す", () => {
  // node警告が末尾に並ぶと、従来は本当のエラーが末尾3行から押し出されていた
  const noisy = [
    "ERROR: 本当のエラー（デプロイ失敗）",
    "(node:12345) ExperimentalWarning: VM Modules is an experimental feature",
    "(node:12345) [DEP0040] DeprecationWarning: punycode",
    "Warning: @salesforce/cli update available 2.99",
  ].join("\n");
  assert.equal(summarizeCliError(noisy, ""), "ERROR: 本当のエラー（デプロイ失敗）", "ノイズ除外で本エラーが残る");
  // DeprecationWarning 単体行も除外（行頭が (node:) でなくても語で判定）
  assert.equal(
    summarizeCliError("DeprecationWarning: x\n本当の理由", ""),
    "本当の理由"
  );
});

test("parseSfVersion extracts version; isSfVersionOutdated flags old CLIs", () => {
  const out = "@salesforce/cli/2.25.7 win32-x64 node-v20.10.0";
  assert.deepEqual(parseSfVersion(out), { major: 2, minor: 25, patch: 7 });
  assert.equal(isSfVersionOutdated(out), true, "2.25 は下限(2.40)未満で古い");
  assert.equal(isSfVersionOutdated("@salesforce/cli/2.60.1 ..."), false, "2.60 は新しい");
  assert.equal(isSfVersionOutdated("@salesforce/cli/3.0.0 ..."), false, "major 3 は新しい");
  assert.equal(parseSfVersion("no version here"), undefined);
  assert.equal(isSfVersionOutdated("no version here"), false, "parse不能は警告しない");
});

test("parseSfJson returns the envelope on status 0", () => {
  const env = parseSfJson<{ ok: boolean }>('{"status":0,"result":{"ok":true}}', 0);
  assert.equal(env.status, 0);
  assert.deepEqual(env.result, { ok: true });
});

test("parseSfJson throws on non-zero status with message", () => {
  assert.throws(
    () => parseSfJson('{"status":1,"message":"No org found"}', 1),
    (e: unknown) => e instanceof SfCliError && /No org found/.test(e.message)
  );
});

test("parseSfJson throws on non-JSON output", () => {
  assert.throws(() => parseSfJson("command not found", 127), SfCliError);
});

test("parseSfJson throws on a non-envelope object", () => {
  assert.throws(() => parseSfJson('{"foo":1}', 0), SfCliError);
});

test("parseSfJson: JSON前の警告/更新通知行を読み飛ばして本体をパースする", () => {
  const noisy =
    "Warning: @salesforce/cli update available from 2.40.0 to 2.50.0.\n" +
    '{"status":0,"result":{"ok":true}}';
  const env = parseSfJson<{ ok: boolean }>(noisy, 0);
  assert.equal(env.status, 0);
  assert.deepEqual(env.result, { ok: true });
});

test("parseSfJson: JSON後ろの付随テキストがあっても本体をパースする", () => {
  const noisy = '{"status":0,"result":{"n":1}}\n(node:123) ExperimentalWarning: ...';
  const env = parseSfJson<{ n: number }>(noisy, 0);
  assert.deepEqual(env.result, { n: 1 });
});

test("parseSfJson: ノイズ混在でもエラー(非ゼロstatus)は正しく伝播する", () => {
  const noisy = 'Update available!\n{"status":1,"message":"No org found"}';
  assert.throws(
    () => parseSfJson(noisy, 1),
    (e: unknown) => e instanceof SfCliError && /No org found/.test(e.message)
  );
});

test("parseSfJson: 波括弧の無い純テキストは従来どおり throw", () => {
  assert.throws(() => parseSfJson("command not found", 127), SfCliError);
});
