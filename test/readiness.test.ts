import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTeamReadiness } from "../src/webview/readiness.js";

const NONE = {
  hasProject: false,
  orgCount: 0,
  configured: false,
  hasRemote: false,
  ciScaffolded: false,
};

test("computeTeamReadiness: 何も無い状態は 0/5・全ステップ未完了・nextはproject", () => {
  const r = computeTeamReadiness(NONE);
  assert.equal(r.total, 5);
  assert.equal(r.doneCount, 0);
  assert.equal(r.allDone, false);
  assert.equal(r.nextKey, "project");
  // 各ステップにクリックで実行するコマンドが付く
  assert.ok(r.steps.every((s) => typeof s.command === "string" && s.command.length > 0));
  assert.deepEqual(
    r.steps.map((s) => s.key),
    ["project", "auth", "config", "github", "cicd"]
  );
});

test("computeTeamReadiness: 部分達成のカウントと次ステップ", () => {
  const r = computeTeamReadiness({
    hasProject: true,
    orgCount: 2,
    configured: true,
    hasRemote: false,
    ciScaffolded: false,
  });
  assert.equal(r.doneCount, 3);
  assert.equal(r.allDone, false);
  assert.equal(r.nextKey, "github", "未完の先頭=GitHub接続");
  // 認証済みは件数をラベルに含める
  const auth = r.steps.find((s) => s.key === "auth")!;
  const github = r.steps.find((s) => s.key === "github")!;
  assert.match(auth.label, /2件/);
  assert.equal(auth.done, true);
  assert.equal(github.done, false);
});

test("computeTeamReadiness: 全完了は 5/5・allDone=true・next無し", () => {
  const r = computeTeamReadiness({
    hasProject: true,
    orgCount: 1,
    configured: true,
    hasRemote: true,
    ciScaffolded: true,
  });
  assert.equal(r.doneCount, 5);
  assert.equal(r.allDone, true);
  assert.equal(r.nextKey, undefined);
});

test("computeTeamReadiness: 認証0件のラベルは『ログイン』、件数表記は出さない", () => {
  const r = computeTeamReadiness(NONE);
  const auth = r.steps.find((s) => s.key === "auth")!;
  assert.match(auth.label, /ログイン/);
  assert.ok(!/件/.test(auth.label));
});

test("computeTeamReadiness: doneCount は done の数と常に一致する（不変条件）", () => {
  for (const ci of [true, false]) {
    for (const rem of [true, false]) {
      const r = computeTeamReadiness({
        hasProject: true,
        orgCount: rem ? 1 : 0,
        configured: ci,
        hasRemote: rem,
        ciScaffolded: ci,
      });
      assert.equal(r.doneCount, r.steps.filter((s) => s.done).length);
      assert.equal(r.allDone, r.doneCount === r.total);
    }
  }
});
