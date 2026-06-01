import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/util/exec.js";

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
