import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorcelainV2 } from "../src/deploy/gitService.js";

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
