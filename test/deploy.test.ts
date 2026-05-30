import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeployArgs, quoteArg, renderCommand } from "../src/deploy/deployService.js";

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
