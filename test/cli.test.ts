import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSfJson, SfCliError } from "../src/util/cli.js";

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
