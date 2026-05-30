import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectGenerateArgs,
  buildRetrieveArgs,
  buildScratchCreateArgs,
  buildScratchDeleteArgs,
  buildSourcePullArgs,
  buildSourcePushArgs,
} from "../src/sfProject/projectService.js";

test("buildProjectGenerateArgs sets name, template, package dir and manifest", () => {
  const args = buildProjectGenerateArgs({
    name: "my-app",
    template: "standard",
    defaultPackageDir: "force-app",
    manifest: true,
  });
  assert.deepEqual(args, [
    "project",
    "generate",
    "--name",
    "my-app",
    "--template",
    "standard",
    "--default-package-dir",
    "force-app",
    "--manifest",
  ]);
});

test("buildProjectGenerateArgs rejects empty name", () => {
  assert.throws(() => buildProjectGenerateArgs({ name: "  " }), /プロジェクト名/);
});

test("buildRetrieveArgs supports metadata, dirs and manifest", () => {
  const md = buildRetrieveArgs({ orgUsername: "u@e.com", metadata: ["ApexClass", "Flow"] });
  assert.ok(md.includes("--metadata") && md.includes("ApexClass") && md.includes("Flow"));
  assert.ok(md.includes("--target-org") && md.includes("u@e.com"));

  const man = buildRetrieveArgs({ orgUsername: "u", manifest: "manifest/package.xml" });
  assert.ok(man.includes("--manifest") && man.includes("manifest/package.xml"));
});

test("buildRetrieveArgs throws when nothing is scoped", () => {
  assert.throws(() => buildRetrieveArgs({ orgUsername: "u" }), /指定してください/);
});

test("source push/pull build deploy/retrieve commands", () => {
  assert.deepEqual(buildSourcePushArgs("u", ["force-app", "shared"]), [
    "project",
    "deploy",
    "start",
    "--target-org",
    "u",
    "--source-dir",
    "force-app",
    "--source-dir",
    "shared",
  ]);
  assert.deepEqual(buildSourcePullArgs("u"), [
    "project",
    "retrieve",
    "start",
    "--target-org",
    "u",
  ]);
});

test("scratch create/delete builders", () => {
  const c = buildScratchCreateArgs({
    alias: "scr",
    definitionFile: "config/project-scratch-def.json",
    durationDays: 7,
    setDefault: true,
  });
  assert.ok(c.includes("--alias") && c.includes("scr"));
  assert.ok(c.includes("--duration-days") && c.includes("7"));
  assert.ok(c.includes("--set-default"));

  assert.deepEqual(buildScratchDeleteArgs("u@e.com"), [
    "org",
    "delete",
    "scratch",
    "--target-org",
    "u@e.com",
    "--no-prompt",
  ]);
});

test("buildScratchCreateArgs rejects empty alias", () => {
  assert.throws(
    () => buildScratchCreateArgs({ alias: "", definitionFile: "x", durationDays: 1 }),
    /エイリアス/
  );
});
