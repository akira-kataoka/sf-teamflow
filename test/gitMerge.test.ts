import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  mergeBranch,
  pullMerge,
  mergedBranches,
  revertCommit,
  commitFiles,
  abortMerge,
  changedFiles,
  recentCommits,
  commit,
  stageAll,
  createBranch,
  switchBranch,
  listBranches,
  deleteBranch,
  currentBranch,
  createTag,
  listTags,
  status,
  conflictedFiles,
} from "../src/deploy/gitService.js";

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

test("abortMerge: 競合状態を中止して取り込み前(main)の内容へ戻す", async () => {
  const dir = initRepo();
  git(dir, "switch", "-c", "feature/c");
  fs.writeFileSync(path.join(dir, "base.txt"), "feature version\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat edit");
  git(dir, "switch", "main");
  fs.writeFileSync(path.join(dir, "base.txt"), "main version\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "main edit");

  const m = await mergeBranch("feature/c", dir);
  assert.equal(m.conflict, true, "前提: 競合中");
  assert.ok(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD")));

  const a = await abortMerge(dir);
  assert.equal(a.ok, true, "中止に成功");
  // マージ状態が解消され、main の内容に戻る
  assert.equal(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD")), false, "MERGE_HEADが消える");
  // 改行コード(CRLF/LF)はGit設定で揺れるため正規化して比較。
  const restored = fs.readFileSync(path.join(dir, "base.txt"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(restored, "main version\n", "取り込み前(main)の内容へ復帰");
});

test("abortMerge: マージ中でないときは ok=false（中止対象なし）", async () => {
  const dir = initRepo();
  const a = await abortMerge(dir);
  assert.equal(a.ok, false, "マージ中でないので中止は失敗（無害）");
});

test("changedFiles: 追加/変更/削除（コミット済み）＋未追跡をまとめて拾う（デプロイ対象の基礎）", async () => {
  const dir = initRepo(); // main + base.txt
  // main にもう1ファイル追加（feature で削除する対象）
  fs.writeFileSync(path.join(dir, "todelete.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "add todelete");
  // feature ブランチで 追加 / 変更 / 削除 をコミット
  git(dir, "switch", "-c", "feature/d");
  fs.writeFileSync(path.join(dir, "feature.cls"), "class A {}\n"); // 追加
  fs.writeFileSync(path.join(dir, "base.txt"), "changed\n"); // 変更
  fs.rmSync(path.join(dir, "todelete.txt")); // 削除
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat changes");
  // 未追跡（コミットしない）
  fs.writeFileSync(path.join(dir, "untracked.txt"), "u\n");

  const entries = await changedFiles("main", dir);
  const byPath: Record<string, string> = {};
  for (const e of entries) {
    byPath[e.path] = e.status;
  }
  assert.equal(byPath["feature.cls"], "A", "追加は A");
  assert.equal(byPath["base.txt"], "M", "変更は M");
  assert.equal(byPath["todelete.txt"], "D", "削除は D");
  assert.ok("untracked.txt" in byPath, "未追跡ファイルも含む");
});

test("status: 実gitでブランチ名・変更/新規ファイル・件数を正しく読む（porcelain v2）", async () => {
  const dir = initRepo(); // main, base.txt コミット済み
  // 変更（既存ファイル）＋新規（未追跡）
  fs.writeFileSync(path.join(dir, "base.txt"), "edited\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
  const s = await status(dir);
  assert.equal(s.branch, "main", "ブランチ名");
  assert.ok(s.changed >= 2, "変更＋新規で2件以上");
  const paths = s.files.map((f) => f.path);
  assert.ok(paths.includes("base.txt"), "変更ファイルを検出");
  assert.ok(paths.includes("new.txt"), "未追跡ファイルを検出");
  // クリーンな状態では競合なし
  assert.deepEqual(conflictedFiles(s), [], "競合なし");
});

test("status: マージ競合を conflictedFiles で検出する", async () => {
  const dir = initRepo();
  git(dir, "switch", "-c", "feature/cf");
  fs.writeFileSync(path.join(dir, "base.txt"), "feature\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat");
  git(dir, "switch", "main");
  fs.writeFileSync(path.join(dir, "base.txt"), "main\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "main");
  const m = await mergeBranch("feature/cf", dir);
  assert.equal(m.conflict, true);
  const s = await status(dir);
  assert.ok(conflictedFiles(s).includes("base.txt"), "競合ファイルを検出");
});

test("ブランチ操作: 作成→一覧→切替→削除が実gitで一貫して動く（shell:false解決の確認）", async () => {
  const dir = initRepo();
  await createBranch("feature/abc", dir);
  assert.equal(await currentBranch(dir), "feature/abc", "作成して切り替わる");
  let branches = await listBranches(dir);
  assert.ok(branches.includes("feature/abc") && branches.includes("main"), "一覧に両方");
  await switchBranch("main", dir);
  assert.equal(await currentBranch(dir), "main", "切替できる");
  await deleteBranch("feature/abc", dir, true);
  branches = await listBranches(dir);
  assert.ok(!branches.includes("feature/abc"), "削除される");
});

test("タグ操作: 作成→一覧（注釈メッセージに特殊文字を含んでも壊れない）", async () => {
  const dir = initRepo();
  // 注釈メッセージにも cmd 特殊文字を入れて shell:false で壊れないことを確認
  await createTag("v1.0.0", "Release v1.0.0 (A & B)", dir);
  const tags = await listTags(dir);
  assert.ok(tags.includes("v1.0.0"), "作成したタグが一覧に出る");
});

test("commit: cmd特殊文字を含むメッセージでも壊れず保存される（Windows shell:true）", async () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
  await stageAll(dir);
  // & | < > ^ ! % ( ) など cmd.exe が特別扱いする文字を含む実際にありそうなメッセージ
  const msg = "fix: A & B (100%) <urgent> ^caret! | done";
  await commit(msg, dir);
  const commits = await recentCommits(dir, 3);
  assert.equal(
    commits[0].subject,
    msg,
    "特殊文字を含むコミットメッセージが正確に保存・取得できる"
  );
});

test("recentCommits: 実gitのログを正しくパースする（pretty=format の % がshellで壊れない）", async () => {
  const dir = initRepo(); // 1件目 "base"
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "機能を追加: 取引先検索");
  const commits = await recentCommits(dir, 5);
  assert.ok(commits.length >= 2, "コミットが取得できる");
  // 最新が先頭。hash/author/subject/isMerge が壊れずパースできていること
  assert.equal(commits[0].subject, "機能を追加: 取引先検索", "subjectが正しく取れる(タブ%x09が機能)");
  assert.ok(/^[0-9a-f]{4,}$/.test(commits[0].hash), "短縮hashが取れる");
  assert.ok(commits[0].author.length > 0, "authorが取れる");
  assert.equal(commits[0].isMerge, false, "通常コミットは非マージ");
  assert.ok(commits[0].rel.length > 0, "相対日時が取れる");
});

test("pullMerge: 分岐した履歴をマージで取り込む（競合なし＝ok・両方の変更が残る）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sftf-div-"));
  const remote = path.join(tmp, "remote.git");
  git(tmp, "init", "--bare", "-b", "main", remote);
  // 作業リポA: base を push
  const a = path.join(tmp, "a");
  git(tmp, "clone", remote, a);
  git(a, "config", "user.email", "t@e.com");
  git(a, "config", "user.name", "Tester");
  fs.writeFileSync(path.join(a, "base.txt"), "base\n");
  git(a, "add", "-A");
  git(a, "commit", "-m", "base");
  git(a, "push", "-u", "origin", "main");
  // 作業リポB: clone（base を取得）。マージコミット用に identity を local config へ。
  const b = path.join(tmp, "b");
  git(tmp, "clone", remote, b);
  git(b, "config", "user.email", "t@e.com");
  git(b, "config", "user.name", "Tester");
  // A が前進（afile を push）
  fs.writeFileSync(path.join(a, "afile.txt"), "A\n");
  git(a, "add", "-A");
  git(a, "commit", "-m", "a-change");
  git(a, "push");
  // B が分岐（bfile をコミット・未push）→ ahead1/behind1
  fs.writeFileSync(path.join(b, "bfile.txt"), "B\n");
  git(b, "add", "-A");
  git(b, "commit", "-m", "b-change");

  const m = await pullMerge(b);
  assert.equal(m.ok, true, "分岐していてもマージで取り込める");
  assert.equal(m.conflict, false, "別ファイルなので競合なし");
  assert.ok(fs.existsSync(path.join(b, "afile.txt")), "リモート(A)の変更を取り込んだ");
  assert.ok(fs.existsSync(path.join(b, "bfile.txt")), "自分(B)の変更も残る");
});

test("pullMerge: 同じ行の分岐は conflict=true（作業ツリーはマージ状態のまま）", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sftf-divc-"));
  const remote = path.join(tmp, "remote.git");
  git(tmp, "init", "--bare", "-b", "main", remote);
  const a = path.join(tmp, "a");
  git(tmp, "clone", remote, a);
  git(a, "config", "user.email", "t@e.com");
  git(a, "config", "user.name", "Tester");
  fs.writeFileSync(path.join(a, "f.txt"), "base\n");
  git(a, "add", "-A");
  git(a, "commit", "-m", "base");
  git(a, "push", "-u", "origin", "main");
  const b = path.join(tmp, "b");
  git(tmp, "clone", remote, b);
  git(b, "config", "user.email", "t@e.com");
  git(b, "config", "user.name", "Tester");
  // A と B が同じファイルの同じ箇所を別内容に変更
  fs.writeFileSync(path.join(a, "f.txt"), "from-A\n");
  git(a, "add", "-A");
  git(a, "commit", "-m", "a");
  git(a, "push");
  fs.writeFileSync(path.join(b, "f.txt"), "from-B\n");
  git(b, "add", "-A");
  git(b, "commit", "-m", "b");

  const m = await pullMerge(b);
  assert.equal(m.ok, false);
  assert.equal(m.conflict, true, "同一行の分岐は競合として返す");
  const s = await status(b);
  assert.ok(conflictedFiles(s).includes("f.txt"), "競合ファイルがホームの一覧で解決できる");
});

test("mergedBranches: 取り込み済みブランチだけを返す（現在ブランチ・未マージは含まない）", async () => {
  const dir = initRepo(); // main
  // feature/done を作って main に取り込む（マージ済みになる）
  git(dir, "switch", "-c", "feature/done");
  fs.writeFileSync(path.join(dir, "done.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "done");
  git(dir, "switch", "main");
  git(dir, "merge", "--no-edit", "feature/done");
  // feature/wip は未マージのまま残す
  git(dir, "switch", "-c", "feature/wip");
  fs.writeFileSync(path.join(dir, "wip.txt"), "y\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "wip");
  git(dir, "switch", "main");

  const merged = await mergedBranches(dir);
  assert.ok(merged.includes("feature/done"), "取り込み済みは含む");
  assert.ok(!merged.includes("feature/wip"), "未マージは含まない");
  assert.ok(!merged.includes("main"), "現在ブランチ(*)は含まない");
});

test("changedFiles: 基準refが存在しなくても落ちない（committed差分は空・作業ツリーは拾う）", async () => {
  const dir = initRepo();
  // 追跡ファイルを変更（未コミット）＋未追跡
  fs.writeFileSync(path.join(dir, "base.txt"), "edited\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
  // 存在しない基準ref を渡してもフォールバックで落ちない
  const entries = await changedFiles("origin/does-not-exist", dir);
  const paths = entries.map((e) => e.path);
  assert.ok(paths.includes("base.txt"), "作業ツリーの変更は拾う");
  assert.ok(paths.includes("new.txt"), "未追跡も拾う");
});
