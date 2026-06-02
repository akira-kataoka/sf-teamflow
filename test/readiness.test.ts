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

test("computeTeamReadiness: チーム設定の接続先数が分かると認証ステップは『N/M 接続先』表示", () => {
  // 3接続先のうち1つ認証済み → ラベルに 1/3、1件以上で done
  const r = computeTeamReadiness({
    hasProject: true,
    orgCount: 1,
    configured: true,
    hasRemote: true,
    ciScaffolded: false,
    configuredAliasTotal: 3,
    configuredAliasAuthed: 1,
  });
  const auth = r.steps.find((s) => s.key === "auth")!;
  assert.match(auth.label, /1\/3 接続先/);
  assert.equal(auth.done, true, "1件でも認証済みなら done（作業開始可）");
  assert.match(auth.hint ?? "", /未認証の接続先/);
});

test("computeTeamReadiness: 接続先が0件認証なら認証ステップ未完了", () => {
  const r = computeTeamReadiness({
    hasProject: true,
    orgCount: 0,
    configured: true,
    hasRemote: true,
    ciScaffolded: false,
    configuredAliasTotal: 3,
    configuredAliasAuthed: 0,
  });
  const auth = r.steps.find((s) => s.key === "auth")!;
  assert.match(auth.label, /0\/3 接続先/);
  assert.equal(auth.done, false);
});

test("computeTeamReadiness: 全接続先認証済みなら hint 無し", () => {
  const r = computeTeamReadiness({
    hasProject: true,
    orgCount: 3,
    configured: true,
    hasRemote: true,
    ciScaffolded: true,
    configuredAliasTotal: 2,
    configuredAliasAuthed: 2,
  });
  const auth = r.steps.find((s) => s.key === "auth")!;
  assert.match(auth.label, /2\/2 接続先/);
  assert.equal(auth.done, true);
  assert.equal(auth.hint, undefined);
});

test("computeTeamReadiness: 接続先情報が無ければ従来どおりOrg数で判定", () => {
  const r = computeTeamReadiness({
    hasProject: true,
    orgCount: 2,
    configured: true,
    hasRemote: true,
    ciScaffolded: false,
    // configuredAliasTotal 未指定（0扱い）→ フォールバック
  });
  const auth = r.steps.find((s) => s.key === "auth")!;
  assert.match(auth.label, /2件/);
  assert.equal(auth.done, true);
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
