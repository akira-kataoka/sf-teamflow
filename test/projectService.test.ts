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
  componentMainFile,
  componentNameError,
  projectNameError,
  testClassNamesError,
  scratchAliasForBranch,
  prBaseCandidates,
  isReleaseLikeBranch,
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

test("componentMainFile points at the primary editable file per kind", () => {
  const dir = "force-app/main/default/classes";
  assert.equal(componentMainFile(dir, "apexClass", "AccountService"), `${dir}/AccountService.cls`);
  assert.equal(
    componentMainFile("force-app/main/default/triggers", "apexTrigger", "AccTrg"),
    "force-app/main/default/triggers/AccTrg.trigger"
  );
  assert.equal(
    componentMainFile("force-app/main/default/lwc/", "lwc", "accountCard"),
    "force-app/main/default/lwc/accountCard/accountCard.js"
  );
  assert.equal(
    componentMainFile("force-app/main/default/aura", "aura", "accountList"),
    "force-app/main/default/aura/accountList/accountList.cmp"
  );
});

test("componentNameError: LWCは小文字camelCase必須・Apex/Auraは英字始まり_可", () => {
  // LWC: 小文字始まりのみOK、大文字始まり/アンダースコアはNG
  assert.equal(componentNameError("accountSearch", "lwc"), undefined);
  assert.ok(componentNameError("AccountSearch", "lwc"), "LWCは大文字始まりNG");
  assert.ok(componentNameError("account_search", "lwc"), "LWCはアンダースコアNG");
  // Apexクラス/トリガ: 英字始まり・_可
  assert.equal(componentNameError("AccountService", "apexClass"), undefined);
  assert.equal(componentNameError("Acc_Trigger", "apexTrigger"), undefined);
  // Aura: 大文字始まりもOK
  assert.equal(componentNameError("MyCmp", "aura"), undefined);
  // 共通: 日本語/記号/空はNG
  assert.ok(componentNameError("取引先", "apexClass"));
  assert.ok(componentNameError("", "lwc"));
});

test("componentNameError: Salesforce API名の40文字上限を検証する", () => {
  const ok40 = "A" + "a".repeat(39); // ちょうど40文字(英字始まり)
  assert.equal(ok40.length, 40);
  assert.equal(componentNameError(ok40, "apexClass"), undefined, "40文字ちょうどはOK");
  const over41 = "A" + "a".repeat(40); // 41文字
  assert.ok(componentNameError(over41, "apexClass"), "41文字はNG");
  // LWC(小文字始まり)でも上限を超えたらNG
  const lwc41 = "a" + "b".repeat(40);
  assert.equal(lwc41.length, 41);
  assert.ok(componentNameError(lwc41, "lwc"), "LWCも41文字はNG");
  // 形式エラーが先に出る場合は40文字判定より前(日本語など)
  assert.ok(componentNameError("あ".repeat(50), "apexClass"), "日本語は形式エラー");
});

test("testClassNamesError: 妥当なクラス名（カンマ区切り）はundefined", () => {
  assert.equal(testClassNamesError("AccountServiceTest"), undefined);
  assert.equal(testClassNamesError("AccountServiceTest, ContactServiceTest"), undefined);
  assert.equal(testClassNamesError("  A_Test , B_Test  "), undefined, "前後/トークンの空白は許容");
});

test("testClassNamesError: 空・不正トークンを検出する", () => {
  assert.ok(testClassNamesError(""), "空");
  assert.ok(testClassNamesError("   "), "空白のみ");
  assert.ok(testClassNamesError("AccountServiceTest.cls"), ".cls 付きはNG");
  assert.ok(testClassNamesError("取引先Test"), "日本語はNG");
  // 1つでもNGなら全体NG（該当名をメッセージに含む）
  const msg = testClassNamesError("Good_Test, bad name");
  assert.ok(msg && msg.includes("bad name"), "NGのトークン名を示す");
});

test("scratchAliasForBranch derives a safe alias, drops prefix, falls back on non-ascii", () => {
  assert.equal(scratchAliasForBranch("feature/account-search"), "scr-account-search");
  assert.equal(scratchAliasForBranch("hotfix/Bug_123"), "scr-bug-123");
  assert.equal(scratchAliasForBranch("main"), "scr-main");
  assert.equal(scratchAliasForBranch("feature/取引先検索"), "scr-feature"); // 非ASCIIはフォールバック
});

test("projectNameError: 妥当なプロジェクト名はundefined", () => {
  assert.equal(projectNameError("my-sf-project"), undefined);
  assert.equal(projectNameError("Project_1"), undefined);
  assert.equal(projectNameError("app.v2"), undefined);
  assert.equal(projectNameError("  my-app  "), undefined, "前後空白はtrim");
});

test("projectNameError: 事故になる名前を弾く(.. / .hidden / 先頭記号 / 空 / 日本語)", () => {
  assert.ok(projectNameError(""), "空");
  assert.ok(projectNameError(".."), "親ディレクトリに解決する .. は不可");
  assert.ok(projectNameError("."), ". は不可");
  assert.ok(projectNameError(".hidden"), "先頭ドット(隠しフォルダ)は不可");
  assert.ok(projectNameError("-foo"), "先頭ハイフンは不可");
  assert.ok(projectNameError("_foo"), "先頭アンダースコアは不可");
  assert.ok(projectNameError("my project"), "スペースは不可");
  assert.ok(projectNameError("プロジェクト"), "日本語は不可");
});

test("isReleaseLikeBranch: release/hotfix のみ true", () => {
  assert.equal(isReleaseLikeBranch("release/1.0"), true);
  assert.equal(isReleaseLikeBranch("hotfix/urgent"), true);
  assert.equal(isReleaseLikeBranch("feature/x"), false);
  assert.equal(isReleaseLikeBranch("develop"), false);
  assert.equal(isReleaseLikeBranch("main"), false);
  assert.equal(isReleaseLikeBranch(""), false);
  assert.equal(isReleaseLikeBranch("releasely/x"), false, "release/ で始まらない紛らわしい名前は false");
});

test("prBaseCandidates: feature系は develop 優先・release/hotfix は main 優先", () => {
  // feature ブランチ → develop が先頭
  assert.deepEqual(prBaseCandidates("feature/x", ["feature/x", "develop", "main"]), [
    "develop",
    "main",
  ]);
  // release ブランチ → main が先頭
  assert.deepEqual(prBaseCandidates("release/1.0", ["release/1.0", "develop", "main"]), [
    "main",
    "develop",
  ]);
  // hotfix も main 優先
  assert.equal(prBaseCandidates("hotfix/bug", [])[0], "main");
});

test("prBaseCandidates: current除外・develop/mainは常に含む・残りを後ろに重複なく", () => {
  const got = prBaseCandidates("feature/x", ["feature/x", "develop", "main", "release/2.0", "qa"]);
  assert.deepEqual(got, ["develop", "main", "release/2.0", "qa"]);
  assert.ok(!got.includes("feature/x"), "current は候補に出さない");
  // ブランチ一覧が空でも標準名は出す
  assert.deepEqual(prBaseCandidates("feature/y", []), ["develop", "main"]);
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
