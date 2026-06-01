import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mergeBranch } from "../src/deploy/gitService.js";

/** Run git in a temp repo with a fixed identity (no reliance on global config). */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=Tester", ...args], {
    cwd,
    stdio: "pipe",
  });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sftf-merge-"));
  git(dir, "init", "-b", "main");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  return dir;
}

test("mergeBranch: 競合しない取り込みは ok（feature の変更を main に統合）", async () => {
  const dir = initRepo();
  // feature: 別ファイルを追加
  git(dir, "switch", "-c", "feature/x");
  fs.writeFileSync(path.join(dir, "feature.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat");
  // main に戻り、別ファイルを変更（衝突しない）
  git(dir, "switch", "main");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\nmore\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "main change");

  const r = await mergeBranch("feature/x", dir);
  assert.equal(r.ok, true, "競合なしでマージ成功");
  assert.equal(r.conflict, false);
  assert.ok(fs.existsSync(path.join(dir, "feature.txt")), "featureの変更が取り込まれる");
});

test("mergeBranch: fast-forward（自分のブランチを最新に追従）も ok で取り込める", async () => {
  const dir = initRepo();
  // feature を base から作成（まだ何もしない）
  git(dir, "switch", "-c", "feature/z");
  // main 側が進む（feature は遅れる＝diverge していない）
  git(dir, "switch", "main");
  fs.writeFileSync(path.join(dir, "newfile.txt"), "from main\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "main advances");
  // feature に戻り、main を取り込む → fast-forward で追従
  git(dir, "switch", "feature/z");
  assert.ok(!fs.existsSync(path.join(dir, "newfile.txt")), "取り込み前はmainの新ファイルは無い");
  const r = await mergeBranch("main", dir);
  assert.equal(r.ok, true, "fast-forwardは成功");
  assert.equal(r.conflict, false);
  assert.ok(fs.existsSync(path.join(dir, "newfile.txt")), "mainの最新が取り込まれる");
});

test("mergeBranch: 存在しないブランチは ok=false・conflict=false（mergeErrorHintで案内できる失敗）", async () => {
  const dir = initRepo();
  const r = await mergeBranch("no-such-branch", dir);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, false, "競合ではなく通常の失敗");
  assert.match(r.message.toLowerCase(), /not something we can merge|did not match|merge/, "原因がmessageに入る");
  // マージは始まっていない（MERGE_HEAD は無い）
  assert.equal(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD")), false);
});

test("mergeBranch: 同一行の衝突は conflict=true でマージ状態を維持（abortしない）", async () => {
  const dir = initRepo();
  git(dir, "switch", "-c", "feature/y");
  fs.writeFileSync(path.join(dir, "base.txt"), "feature version\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat edit");
  git(dir, "switch", "main");
  fs.writeFileSync(path.join(dir, "base.txt"), "main version\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "main edit");

  const r = await mergeBranch("feature/y", dir);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true, "同一行編集は競合として検出");
  // マージ状態が維持されている（MERGE_HEAD が存在＝abortしていない）
  assert.ok(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD")), "マージ状態を維持(競合解決UIに繋ぐ)");
});
