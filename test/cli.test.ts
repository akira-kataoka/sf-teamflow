import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSfJson,
  SfCliError,
  parseSfVersion,
  isSfVersionOutdated,
  summarizeCliError,
} from "../src/util/cli.js";

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
