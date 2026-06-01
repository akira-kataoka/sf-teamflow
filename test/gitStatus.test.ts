import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePorcelainV2,
  conflictedFiles,
  parseCommitLog,
  baseRefCandidates,
  mergeGitignore,
  BASELINE_GITIGNORE_ENTRIES,
  pushErrorHint,
  branchNameError,
  tagNameError,
  repoNameError,
  BASELINE_GITATTRIBUTES,
} from "../src/deploy/gitService.js";

test("repoNameError: 妥当なGitHubリポジトリ名は undefined", () => {
  assert.equal(repoNameError("my-sf-project"), undefined);
  assert.equal(repoNameError("Project_1.0"), undefined);
  assert.equal(repoNameError(".github"), undefined, "先頭ドットはGitHubで許容");
  assert.equal(repoNameError("  my-app  "), undefined, "前後空白はtrim");
});

test("repoNameError: gh repo create が失敗する名前を弾く", () => {
  assert.ok(repoNameError(""), "空");
  assert.ok(repoNameError("my repo"), "スペース");
  assert.ok(repoNameError("プロジェクト"), "日本語");
  assert.ok(repoNameError("repo!"), "記号");
  assert.ok(repoNameError("."), ". 単体は不可");
  assert.ok(repoNameError(".."), ".. 単体は不可");
});

test("BASELINE_GITATTRIBUTES: 改行正規化(* text=auto)を含み、eolは強制しない", () => {
  assert.ok(BASELINE_GITATTRIBUTES.includes("* text=auto"), "text=auto を含む");
  assert.ok(!BASELINE_GITATTRIBUTES.includes("eol="), "eol は強制しない（副作用を小さく）");
  assert.ok(BASELINE_GITATTRIBUTES.endsWith("\n"), "末尾は改行で終わる");
});

test("tagNameError: 妥当なタグ名は undefined", () => {
  assert.equal(tagNameError("v1.0.0"), undefined);
  assert.equal(tagNameError("v2.3.1-rc1"), undefined);
  assert.equal(tagNameError("release_2026"), undefined);
  assert.equal(tagNameError("  v1.0.0  "), undefined, "前後空白はtrimして許容");
});

test("tagNameError: gitが弾く不正なタグ名を検出する", () => {
  assert.ok(tagNameError(""), "空");
  assert.ok(tagNameError("v1 0 0"), "スペース");
  assert.ok(tagNameError("バージョン1"), "日本語");
  assert.ok(tagNameError("v1.0.0/"), "末尾スラッシュ");
  assert.ok(tagNameError(".v1"), "先頭ドット");
  assert.ok(tagNameError("v1."), "末尾ドット");
  assert.ok(tagNameError("v1..0"), "連続ドット");
  assert.ok(tagNameError("v1.lock"), "末尾.lock");
});

test("branchNameError: 妥当なブランチ名は undefined", () => {
  assert.equal(branchNameError("feature/account-search"), undefined);
  assert.equal(branchNameError("develop"), undefined);
  assert.equal(branchNameError("release/v1.2.0"), undefined);
  assert.equal(branchNameError("hotfix/bug_123"), undefined);
  assert.equal(branchNameError("  feature/x  "), undefined, "前後空白はtrimして許容");
});

test("branchNameError: gitが弾く不正名を入力時点で検出する", () => {
  assert.ok(branchNameError(""), "空");
  assert.ok(branchNameError("   "), "空白のみ");
  assert.ok(branchNameError("feature/アカウント"), "日本語");
  assert.ok(branchNameError("feature branch"), "スペース");
  assert.ok(branchNameError("feature~1"), "記号~");
  assert.ok(branchNameError("feature/"), "末尾スラッシュ");
  assert.ok(branchNameError("/feature"), "先頭スラッシュ");
  assert.ok(branchNameError(".hidden"), "先頭ドット");
  assert.ok(branchNameError("feature."), "末尾ドット");
  assert.ok(branchNameError("feat//x"), "連続スラッシュ");
  assert.ok(branchNameError("feat..x"), "連続ドット");
  assert.ok(branchNameError("feature.lock"), "末尾.lock");
});

test("pushErrorHint maps common push failures to actionable hints", () => {
  assert.match(
    pushErrorHint("! [rejected] main -> main (non-fast-forward)") || "",
    /GitHub同期/,
    "non-fast-forward は同期を促す"
  );
  assert.match(
    pushErrorHint("refusing to allow an OAuth App ... without workflow scope") || "",
    /workflow/,
    "workflow scope を案内"
  );
  assert.match(pushErrorHint("fatal: Authentication failed") || "", /gh auth login/, "認証失敗を案内");
  assert.equal(pushErrorHint("some unrelated error"), undefined, "未知はヒント無し");
});

test("pushErrorHint: pull --ff-only の履歴分岐(diverged)を案内する", () => {
  assert.match(
    pushErrorHint("fatal: Not possible to fast-forward, aborting.") || "",
    /分かれています|分岐/,
    "ff-only失敗は分岐の解消を案内"
  );
  assert.match(
    pushErrorHint("Your branch and 'origin/main' have diverged") || "",
    /プル|マージ/,
    "diverged はプル/マージを案内"
  );
});

test("pushErrorHint: SSH鍵拒否・リポジトリ不在・ネットワーク不通も案内する", () => {
  assert.match(
    pushErrorHint("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.") || "",
    /SSH/,
    "publickey拒否はSSH案内"
  );
  assert.match(
    pushErrorHint("remote: Repository not found.\nfatal: repository 'https://...' not found") || "",
    /リモートのリポジトリが見つかりません/,
    "repository not found を案内"
  );
  assert.match(
    pushErrorHint("fatal: unable to access '...': Could not resolve host: github.com") || "",
    /ネットワーク/,
    "名前解決失敗はネットワーク案内"
  );
});

test("mergeGitignore appends only missing entries; preserves existing; no-op when all present", () => {
  // 空から: 全エントリ＋見出しコメントが入る
  const a = mergeGitignore("", BASELINE_GITIGNORE_ENTRIES);
  assert.ok(a.includes(".sf/"), ".sf/ を追加");
  assert.ok(a.includes("ci-keys/"), "ci-keys/ を追加");
  assert.ok(a.includes("coverage/"), "coverage/（Jest出力）を追加");
  // 既存に一部あり: 重複させず不足分だけ追記
  const b = mergeGitignore("node_modules/\n.sf/\n", BASELINE_GITIGNORE_ENTRIES);
  assert.equal((b.match(/^\.sf\/$/gm) || []).length, 1, ".sf/ は重複しない");
  assert.ok(b.includes("ci-keys/"), "不足の ci-keys/ は追記");
  // 全部ある: 変更なし（入力をそのまま返す）
  const full = BASELINE_GITIGNORE_ENTRIES.join("\n") + "\n";
  assert.equal(mergeGitignore(full, BASELINE_GITIGNORE_ENTRIES), full, "全て揃っていれば無変更");
});

test("baseRefCandidates: preferred first, common fallbacks, deduped", () => {
  const c = baseRefCandidates("origin/main");
  assert.equal(c[0], "origin/main");
  assert.ok(c.includes("origin/master"), "origin/master fallback present");
  assert.ok(c.includes("master"), "master fallback present");
  assert.equal(new Set(c).size, c.length, "no duplicates");
  // preferred が master でも重複せず先頭に
  const c2 = baseRefCandidates("master");
  assert.equal(c2[0], "master");
  assert.equal(new Set(c2).size, c2.length);
});

test("parseCommitLog parses hash/rel/author/subject (subject may contain tabs)", () => {
  const out = [
    "abc1234\t2 hours ago\t山田\tfeat: 取引先検索を追加",
    "def5678\tyesterday\t鈴木\tfix: 不具合\tの修正",
    "",
  ].join("\n");
  const c = parseCommitLog(out);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { hash: "abc1234", rel: "2 hours ago", author: "山田", subject: "feat: 取引先検索を追加" });
  assert.equal(c[1].author, "鈴木");
  assert.equal(c[1].subject, "fix: 不具合\tの修正");
});

test("parsePorcelainV2 reads branch and ahead/behind", () => {
  const out = [
    "# branch.oid abc123",
    "# branch.head feature/search",
    "# branch.upstream origin/feature/search",
    "# branch.ab +2 -1",
  ].join("\n");
  const s = parsePorcelainV2(out);
  assert.equal(s.branch, "feature/search");
  assert.equal(s.upstream, "origin/feature/search");
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.equal(s.changed, 0);
});

test("parsePorcelainV2 reads ordinary, untracked and renamed entries", () => {
  const out = [
    "# branch.head main",
    "1 M. N... 100644 100644 100644 aaa bbb force-app/A.cls",
    "1 .M N... 100644 100644 100644 aaa bbb force-app/B.cls",
    "? force-app/New.cls",
    "2 R. N... 100644 100644 100644 aaa bbb R100 force-app/Now.cls\tforce-app/Was.cls",
  ].join("\n");
  const s = parsePorcelainV2(out);
  assert.equal(s.changed, 4);

  const a = s.files.find((f) => f.path === "force-app/A.cls")!;
  assert.equal(a.staged, true); // index status M
  assert.equal(a.label, "変更");

  const b = s.files.find((f) => f.path === "force-app/B.cls")!;
  assert.equal(b.staged, false); // only worktree modified

  const nw = s.files.find((f) => f.path === "force-app/New.cls")!;
  assert.equal(nw.label, "未追跡");

  const renamed = s.files.find((f) => f.path === "force-app/Now.cls")!;
  assert.equal(renamed.label, "リネーム");
  assert.equal(renamed.staged, true);
});

test("parsePorcelainV2 handles empty output", () => {
  const s = parsePorcelainV2("");
  assert.equal(s.branch, "");
  assert.equal(s.changed, 0);
});

test("parsePorcelainV2: no upstream / no ab header keeps ahead=behind=0", () => {
  const s = parsePorcelainV2("# branch.head feature/x\n");
  assert.equal(s.branch, "feature/x");
  assert.equal(s.upstream, undefined);
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
});

test("parsePorcelainV2: staged+worktree (XY both set) treats it as staged", () => {
  // "MM" = modified in index AND worktree; index status wins -> staged.
  const s = parsePorcelainV2(
    "# branch.head main\n1 MM N... 100644 100644 100644 aaa bbb force-app/A.cls\n"
  );
  const a = s.files.find((f) => f.path === "force-app/A.cls");
  assert.ok(a);
  assert.equal(a.staged, true);
  assert.equal(a.label, "変更");
});

test("parsePorcelainV2: copy (status C) is parsed as modify of the new path", () => {
  const s = parsePorcelainV2(
    "# branch.head main\n2 C. N... 100644 100644 100644 aaa bbb C100 force-app/New.cls\tforce-app/Src.cls\n"
  );
  const f = s.files.find((x) => x.path === "force-app/New.cls");
  assert.ok(f);
  assert.equal(f.staged, true);
});

test("parsePorcelainV2: unmerged (u) line is a conflict and not staged", () => {
  const s = parsePorcelainV2(
    "# branch.head main\nu UU N... 100644 100644 100644 100644 h1 h2 h3 force-app/C.cls\n"
  );
  const f = s.files.find((x) => x.path === "force-app/C.cls");
  assert.ok(f, "conflict file parsed");
  assert.equal(f.label, "競合");
  assert.equal(f.staged, false);
});

test("parsePorcelainV2: ignores unrelated comment headers, counts only files", () => {
  const s = parsePorcelainV2(
    "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n? a.txt\n? b.txt\n"
  );
  assert.equal(s.changed, 2);
  assert.equal(s.files.every((f) => f.label === "未追跡"), true);
});

test("conflictedFiles extracts only unmerged (競合) files", () => {
  const s = parsePorcelainV2(
    "# branch.head main\n1 M. N... 100644 100644 100644 a b force-app/A.cls\nu UU N... 100644 100644 100644 100644 h1 h2 h3 force-app/C.cls\n? new.txt\n"
  );
  assert.deepEqual(conflictedFiles(s), ["force-app/C.cls"]);
});

test("conflictedFiles returns [] when there are no conflicts", () => {
  const s = parsePorcelainV2("# branch.head main\n? a.txt\n");
  assert.deepEqual(conflictedFiles(s), []);
});
