import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectGenerateArgs,
  buildRetrieveArgs,
  buildRunTestsArgs,
  buildScratchCreateArgs,
  buildScratchDeleteArgs,
  buildSourcePullArgs,
  buildSourcePushArgs,
  buildDeployMetadataArgs,
  buildGenerateComponentArgs,
  buildTailLogArgs,
  componentOutputDir,
  buildPullRequestArgs,
  COMMON_METADATA_TYPES,
  buildDevHubOpenArgs,
  buildScratchOrgInfoProbeArgs,
  buildSetDefaultDevHubArgs,
  buildDevHubLoginArgs,
  DEV_HUB_SETUP_PATH,
  DEVELOPER_EDITION_SIGNUP_URL,
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

test("buildRunTestsArgs uses test level by default and code coverage", () => {
  const a = buildRunTestsArgs({ orgUsername: "u@e.com" });
  assert.ok(a.includes("apex") && a.includes("run") && a.includes("test"));
  assert.ok(a.includes("--test-level") && a.includes("RunLocalTests"));
  assert.ok(a.includes("--code-coverage") && a.includes("--result-format") && a.includes("human"));
});

test("buildRunTestsArgs runs specified classes when given", () => {
  const a = buildRunTestsArgs({ orgUsername: "u", classNames: ["FooTest", "BarTest"] });
  assert.ok(a.includes("--class-names") && a.includes("FooTest") && a.includes("BarTest"));
  assert.ok(!a.includes("--test-level"), "class run should not pass test-level");
});

test("buildDeployMetadataArgs deploys selected metadata types", () => {
  const a = buildDeployMetadataArgs("u@e.com", ["ApexClass", "Flow"]);
  assert.deepEqual(a, [
    "project", "deploy", "start", "--target-org", "u@e.com",
    "--metadata", "ApexClass", "--metadata", "Flow",
  ]);
  assert.throws(() => buildDeployMetadataArgs("u", []), /資材を1つ以上/);
});

test("COMMON_METADATA_TYPES is a rich, de-duplicated list", () => {
  assert.ok(COMMON_METADATA_TYPES.length >= 30, "should offer many types");
  const types = COMMON_METADATA_TYPES.map((m) => m.type);
  assert.equal(new Set(types).size, types.length, "no duplicate types");
  for (const t of ["ApexClass", "Flow", "PermissionSet", "FlexiPage", "ValidationRule"]) {
    assert.ok(types.includes(t), "missing " + t);
  }
});

test("componentOutputDir maps kinds to source subdirs", () => {
  assert.equal(componentOutputDir("force-app", "apexClass"), "force-app/main/default/classes");
  assert.equal(componentOutputDir("force-app/", "lwc"), "force-app/main/default/lwc");
  assert.equal(componentOutputDir("pkg", "apexTrigger"), "pkg/main/default/triggers");
  assert.equal(componentOutputDir("pkg", "aura"), "pkg/main/default/aura");
});

test("buildGenerateComponentArgs builds apex/lwc/trigger commands", () => {
  assert.deepEqual(buildGenerateComponentArgs("apexClass", "AccountService", "d"), [
    "apex", "generate", "class", "--name", "AccountService", "--output-dir", "d",
  ]);
  const lwc = buildGenerateComponentArgs("lwc", "accountCard", "d");
  assert.ok(lwc.includes("lightning") && lwc.includes("--type") && lwc.includes("lwc"));
  const trg = buildGenerateComponentArgs("apexTrigger", "AccTrg", "d", "Account");
  assert.ok(trg.includes("--sobject") && trg.includes("Account"));
  assert.throws(() => buildGenerateComponentArgs("apexClass", " ", "d"), /名前/);
});

test("buildPullRequestArgs targets a base branch with --fill", () => {
  assert.deepEqual(buildPullRequestArgs({ baseBranch: "develop", web: true }), [
    "pr", "create", "--base", "develop", "--fill", "--web",
  ]);
  assert.deepEqual(buildPullRequestArgs({ baseBranch: "main" }), [
    "pr", "create", "--base", "main", "--fill",
  ]);
});

test("buildScratchCreateArgs rejects empty alias", () => {
  assert.throws(
    () => buildScratchCreateArgs({ alias: "", definitionFile: "x", durationDays: 1 }),
    /エイリアス/
  );
});

test("buildTailLogArgs streams debug logs from the target org", () => {
  assert.deepEqual(buildTailLogArgs("u@e.com"), [
    "apex", "tail", "log", "--target-org", "u@e.com", "--color",
  ]);
});

test("buildScratchCreateArgs targets a specific Dev Hub when given", () => {
  const args = buildScratchCreateArgs({
    alias: "s1",
    definitionFile: "config/project-scratch-def.json",
    durationDays: 7,
    setDefault: true,
    devhubUsername: "hub@e.com",
  });
  assert.deepEqual(args, [
    "org", "create", "scratch",
    "--definition-file", "config/project-scratch-def.json",
    "--alias", "s1",
    "--duration-days", "7",
    "--set-default",
    "--target-dev-hub", "hub@e.com",
  ]);
});

test("buildScratchCreateArgs omits --target-dev-hub when no hub is given", () => {
  const args = buildScratchCreateArgs({
    alias: "s1",
    definitionFile: "d.json",
    durationDays: 1,
  });
  assert.ok(!args.includes("--target-dev-hub"));
});

test("buildDevHubOpenArgs opens the org's Dev Hub setup page", () => {
  assert.deepEqual(buildDevHubOpenArgs("u@e.com"), [
    "org", "open", "--target-org", "u@e.com", "--path", DEV_HUB_SETUP_PATH,
  ]);
});

test("buildScratchOrgInfoProbeArgs queries ScratchOrgInfo on the target org", () => {
  assert.deepEqual(buildScratchOrgInfoProbeArgs("u@e.com"), [
    "data", "query", "--query", "SELECT Id FROM ScratchOrgInfo LIMIT 1", "--target-org", "u@e.com",
  ]);
});

test("buildSetDefaultDevHubArgs sets target-dev-hub config", () => {
  assert.deepEqual(buildSetDefaultDevHubArgs("u@e.com"), [
    "config", "set", "target-dev-hub=u@e.com",
  ]);
});

test("buildDevHubLoginArgs re-auths as default dev hub, with optional alias", () => {
  assert.deepEqual(buildDevHubLoginArgs("https://x.my.salesforce.com", "hub"), [
    "org", "login", "web", "--set-default-dev-hub", "--instance-url", "https://x.my.salesforce.com", "--alias", "hub",
  ]);
  assert.deepEqual(buildDevHubLoginArgs("https://x.my.salesforce.com"), [
    "org", "login", "web", "--set-default-dev-hub", "--instance-url", "https://x.my.salesforce.com",
  ]);
});

test("DEVELOPER_EDITION_SIGNUP_URL points at the Salesforce signup page", () => {
  assert.match(DEVELOPER_EDITION_SIGNUP_URL, /developer\.salesforce\.com\/signup/);
});
