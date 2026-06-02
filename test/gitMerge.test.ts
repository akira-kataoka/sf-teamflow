import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mergeBranch, revertCommit, commitFiles } from "../src/deploy/gitService.js";

/** Capture git stdout (trimmed) from a temp repo with a fixed identity. */
function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=Tester", ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

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

test("revertCommit: マージコミット(PR取り込み)も -m 1 で取り消せる（is a merge but no -m を回避）", async () => {
  const dir = initRepo();
  // feature を作り、別ファイルを追加
  git(dir, "switch", "-c", "feature/m");
  fs.writeFileSync(path.join(dir, "feature.txt"), "from feature\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat");
  // main に戻り、--no-ff で必ずマージコミットを作る（PR取り込み相当）
  git(dir, "switch", "main");
  git(dir, "merge", "--no-ff", "--no-edit", "feature/m");
  const mergeHash = gitOut(dir, "rev-parse", "HEAD");
  assert.ok(fs.existsSync(path.join(dir, "feature.txt")), "マージで取り込まれている");

  // このマージコミットを取り消す（従来は -m 無しで失敗していた）
  const r = await revertCommit(mergeHash, dir);
  assert.equal(r.ok, true, "マージコミットの取り消しが成功する");
  assert.equal(r.conflict, false);
  // 取り消しコミットが新たに積まれ（履歴は壊さない）、feature の変更が消える
  assert.ok(!fs.existsSync(path.join(dir, "feature.txt")), "取り込んだ変更が打ち消される");
  assert.notEqual(gitOut(dir, "rev-parse", "HEAD"), mergeHash, "新しい取り消しコミットができている");
});

test("commitFiles: マージコミットでも取り込んだ変更ファイルが見える（--first-parent）", async () => {
  const dir = initRepo();
  git(dir, "switch", "-c", "feature/h");
  fs.writeFileSync(path.join(dir, "feature.txt"), "from feature\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat");
  git(dir, "switch", "main");
  git(dir, "merge", "--no-ff", "--no-edit", "feature/h");
  const mergeHash = gitOut(dir, "rev-parse", "HEAD");

  const files = await commitFiles(mergeHash, dir);
  // 既定の combined diff だと空になりがち。--first-parent で feature.txt が見える。
  assert.ok(
    files.some((f) => f.path === "feature.txt"),
    "マージで取り込んだファイルが変更履歴に表示される"
  );
});

test("commitFiles: 通常コミットは従来どおり変更ファイルを返す", async () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "y.txt"), "y\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "add y");
  const hash = gitOut(dir, "rev-parse", "HEAD");
  const files = await commitFiles(hash, dir);
  assert.ok(files.some((f) => f.path === "y.txt" && f.status === "A"));
});

test("revertCommit: 通常コミットも従来どおり取り消せる（-m を付けない）", async () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "add x");
  const hash = gitOut(dir, "rev-parse", "HEAD");
  const r = await revertCommit(hash, dir);
  assert.equal(r.ok, true);
  assert.equal(r.conflict, false);
  assert.ok(!fs.existsSync(path.join(dir, "x.txt")), "通常コミットの変更が打ち消される");
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
