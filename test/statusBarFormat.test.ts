import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGitStatusBar } from "../src/statusBarFormat.js";

const clean = { branch: "feature/x", changed: 0, ahead: 0, behind: 0 };

test("formatGitStatusBar: 環境未割当はブランチのみ・本番フラグは立たない", () => {
  const p = formatGitStatusBar(clean, undefined);
  assert.equal(p.isProduction, false);
  assert.match(p.text, /\$\(git-branch\) feature\/x/);
  assert.match(p.tooltip, /（環境未割当）/);
});

test("formatGitStatusBar: 変更/未バックアップ/取り込み待ちのカウンタを表示", () => {
  const p = formatGitStatusBar(
    { branch: "develop", changed: 3, ahead: 2, behind: 1 },
    { name: "開発", type: "sandbox" }
  );
  assert.match(p.text, /\$\(arrow-up\)2/);
  assert.match(p.text, /\$\(arrow-down\)1/);
  assert.match(p.text, /\$\(pencil\)3/);
  assert.match(p.text, /→ 開発/);
  assert.equal(p.isProduction, false, "sandbox は本番ではない");
  assert.match(p.tooltip, /未保存の変更: 3件/);
  assert.match(p.tooltip, /未バックアップ: 2件/);
  assert.match(p.tooltip, /取り込み待ち: 1件/);
});

test("formatGitStatusBar: 本番環境のブランチは ⚠️ を付け、isProduction を立てる", () => {
  const p = formatGitStatusBar(
    { branch: "main", changed: 0, ahead: 0, behind: 0 },
    { name: "本番", type: "production" }
  );
  assert.equal(p.isProduction, true);
  assert.match(p.text, /→ ⚠️ 本番/);
  assert.match(p.tooltip, /このブランチは本番環境です/);
});

test("formatGitStatusBar: クリーン時のツールチップは「変更なし」", () => {
  const p = formatGitStatusBar(clean, undefined);
  assert.match(p.tooltip, /変更なし/);
  assert.doesNotMatch(p.tooltip, /未バックアップ/);
});
