import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNextAction, type NextActionInput } from "../src/webview/nextStep.js";

/** Fully set-up, clean, on a feature branch with remote (the “after backup” state). */
function base(): NextActionInput {
  return {
    hasFolder: true,
    hasProject: true,
    defaultOrgConnected: true,
    defaultOrgName: "dev",
    defaultOrgUsername: "dev@x.com",
    orgCount: 2,
    configured: true,
    changes: 0,
    ahead: 0,
    behind: 0,
    hasRemote: true,
    branch: "feature/x",
    onBaseBranch: false,
  };
}

test("computeNextAction: 初回フロー（フォルダ→プロジェクト→認証→設定）の順に導く", () => {
  assert.equal(computeNextAction({ ...base(), hasFolder: false }).command, "teamflow.createProject");
  assert.equal(computeNextAction({ ...base(), hasProject: false }).command, "teamflow.createProject");
  assert.equal(
    computeNextAction({ ...base(), orgCount: 0 }).command,
    "teamflow.authorizeOrg"
  );
  assert.equal(
    computeNextAction({ ...base(), configured: false }).command,
    "teamflow.setupWizard"
  );
});

test("computeNextAction: 既定環境の接続切れは再接続(reconnect)を最優先で促す", () => {
  const na = computeNextAction({ ...base(), defaultOrgConnected: false });
  assert.equal(na.reconnect, "dev@x.com");
  assert.match(na.t2, /再接続/);
  assert.equal(na.command, undefined, "再接続はcommandではなくreconnect導線");
});

test("computeNextAction: 認証0件でも、既定環境が無ければ(null)再接続は出さない", () => {
  const na = computeNextAction({ ...base(), defaultOrgConnected: null, orgCount: 0 });
  assert.equal(na.command, "teamflow.authorizeOrg");
});

test("computeNextAction: 日々のループ（保存→同期）を順に促す", () => {
  assert.equal(computeNextAction({ ...base(), changes: 3 }).command, "teamflow.gitCommitPush");
  assert.equal(computeNextAction({ ...base(), ahead: 2 }).command, "teamflow.gitSync");
  assert.equal(computeNextAction({ ...base(), behind: 1 }).command, "teamflow.gitSync");
});

test("computeNextAction: feature ブランチを push 済み・保留なしなら PR 作成へ導く（GitHub Flow）", () => {
  const na = computeNextAction(base());
  assert.equal(na.command, "teamflow.createPullRequest");
  assert.match(na.t2, /Pull Request/);
});

test("computeNextAction: 基準ブランチ(develop等)で保留なしは『作業ブランチを作る』へ導く（行き止まりにしない）", () => {
  const na = computeNextAction({ ...base(), branch: "develop", onBaseBranch: true });
  assert.equal(na.command, "teamflow.gitNewBranch");
  assert.match(na.t2, /作業ブランチ/);
  assert.notEqual(na.calm, true);
});

test("computeNextAction: リモート未接続の feature は PR を勧めず calm", () => {
  const na = computeNextAction({ ...base(), hasRemote: false });
  assert.equal(na.calm, true);
});

test("computeNextAction: 変更ありは基準ブランチでもまず保存（新ブランチ提案より優先）", () => {
  const na = computeNextAction({ ...base(), branch: "develop", onBaseBranch: true, changes: 2 });
  assert.equal(na.command, "teamflow.gitCommitPush");
});

test("computeNextAction: 変更ありは PR より先にバックアップを優先（順序）", () => {
  // feature ブランチ＋変更あり → まず保存
  assert.equal(computeNextAction({ ...base(), changes: 1 }).command, "teamflow.gitCommitPush");
});
