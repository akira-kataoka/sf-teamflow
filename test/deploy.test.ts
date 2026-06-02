import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeployArgs,
  quoteArg,
  renderCommand,
  deployConfirmKind,
  testLevelLabel,
} from "../src/deploy/deployService.js";

test("buildDeployArgs builds a start command with per-file -d", () => {
  const args = buildDeployArgs({
    files: ["force-app/A.cls", "force-app/B.cls"],
    orgAlias: "uat@acme.com",
    testLevel: "RunLocalTests",
    validateOnly: false,
  });
  assert.deepEqual(args, [
    "project",
    "deploy",
    "start",
    "-d",
    "force-app/A.cls",
    "-d",
    "force-app/B.cls",
    "-o",
    "uat@acme.com",
    "-l",
    "RunLocalTests",
  ]);
});

test("buildDeployArgs uses validate verb and specified tests", () => {
  const args = buildDeployArgs({
    files: ["force-app/A.cls"],
    orgAlias: "prod",
    testLevel: "RunSpecifiedTests",
    validateOnly: true,
    specifiedTests: ["FooTest", "BarTest"],
  });
  assert.equal(args[2], "validate");
  assert.ok(args.includes("FooTest") && args.includes("BarTest"));
});

test("buildDeployArgs throws on empty file list", () => {
  assert.throws(
    () => buildDeployArgs({ files: [], orgAlias: "x", testLevel: "NoTestRun", validateOnly: false }),
    /ファイルがありません/
  );
});

test("quoteArg only quotes when needed and escapes specials", () => {
  assert.equal(quoteArg("force-app/A.cls"), "force-app/A.cls");
  assert.equal(quoteArg("with space"), '"with space"');
  assert.equal(quoteArg('a"b'), '"a\\"b"');
});

test("renderCommand joins a copy-pasteable line", () => {
  const line = renderCommand("sf", ["project", "deploy", "start", "-d", "a b/c.cls"]);
  assert.equal(line, 'sf project deploy start -d "a b/c.cls"');
});

test("buildDeployArgs RunSpecifiedTests without tests omits -t but keeps level", () => {
  const a = buildDeployArgs({
    files: ["force-app/A.cls"],
    orgAlias: "o",
    testLevel: "RunSpecifiedTests",
    validateOnly: false,
  });
  assert.ok(a.includes("-l") && a.includes("RunSpecifiedTests"));
  assert.ok(!a.includes("-t"));
});

test("quoteArg escapes a backtick by prefixing a backslash", () => {
  const bt = String.fromCharCode(96); // `
  const bs = String.fromCharCode(92); // \
  assert.equal(quoteArg("a" + bt + "b"), '"a' + bs + bt + 'b"');
});

test("testLevelLabel: 既知レベルは平易な補足付き、未知はそのまま", () => {
  assert.equal(testLevelLabel("RunLocalTests"), "RunLocalTests（自組織のテストを実行（推奨））");
  assert.equal(testLevelLabel("NoTestRun"), "NoTestRun（テストなし）");
  assert.equal(testLevelLabel("RunAllTestsInOrg"), "RunAllTestsInOrg（組織の全テスト（時間がかかる））");
  assert.equal(testLevelLabel("RunSpecifiedTests"), "RunSpecifiedTests（指定したテストのみ）");
  // 未知の値はそのまま返す（壊れない）
  assert.equal(testLevelLabel("Unknown"), "Unknown");
});

test("deployConfirmKind: 本番＋確認ONは production", () => {
  assert.equal(
    deployConfirmKind({ validateOnly: false, isProduction: true, confirmProduction: true, requireValidation: false }),
    "production"
  );
});

test("deployConfirmKind: 検証(お試し)実行は常に normal", () => {
  assert.equal(
    deployConfirmKind({ validateOnly: true, isProduction: true, confirmProduction: true, requireValidation: true }),
    "normal"
  );
});

test("deployConfirmKind: 本番以外でも requireValidation なら validateFirst", () => {
  assert.equal(
    deployConfirmKind({ validateOnly: false, isProduction: false, confirmProduction: true, requireValidation: true }),
    "validateFirst"
  );
});

test("deployConfirmKind: 本番だが確認OFF＋requireValidation は validateFirst（検証は勧める）", () => {
  assert.equal(
    deployConfirmKind({ validateOnly: false, isProduction: true, confirmProduction: false, requireValidation: true }),
    "validateFirst"
  );
});

test("deployConfirmKind: フラグ無しの通常デプロイは normal", () => {
  assert.equal(
    deployConfirmKind({ validateOnly: false, isProduction: false, confirmProduction: true, requireValidation: false }),
    "normal"
  );
});
