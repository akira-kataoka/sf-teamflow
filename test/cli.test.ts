import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSfJson, SfCliError, parseSfVersion, isSfVersionOutdated } from "../src/util/cli.js";

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
