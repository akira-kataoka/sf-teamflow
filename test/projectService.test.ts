import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectGenerateArgs,
  buildRetrieveArgs,
  buildRunTestsArgs,
  buildScratchCreateArgs,
  buildScratchDeleteArgs,
  resolveScratchDefinitionFile,
  buildSourcePullArgs,
  buildSourcePushArgs,
  buildDeployMetadataArgs,
  buildGenerateComponentArgs,
  buildTailLogArgs,
  componentOutputDir,
  componentMainFile,
  componentNameError,
  projectNameError,
  sobjectNameError,
  testClassNamesError,
  scratchAliasForBranch,
  prBaseCandidates,
  isReleaseLikeBranch,
  branchTypeOptions,
  isProtectedBranch,
  buildPullRequestArgs,
  buildReleaseCreateArgs,
  COMMON_METADATA_TYPES,
  buildDevHubOpenArgs,
  buildScratchOrgInfoProbeArgs,
  buildSetDefaultDevHubArgs,
  buildDevHubLoginArgs,
  DEV_HUB_SETUP_PATH,
  DEVELOPER_EDITION_SIGNUP_URL,
  BASELINE_FORCEIGNORE,
  shouldWriteBaselineForceignore,
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

test("resolveScratchDefinitionFile: 候補があれば先頭・無ければ既定でfound=false", () => {
  assert.deepEqual(resolveScratchDefinitionFile(["config/project-scratch-def.json"]), {
    file: "config/project-scratch-def.json",
    found: true,
  });
  // 空配列 → 既定パス + found=false（呼び出し側で警告できる）
  assert.deepEqual(resolveScratchDefinitionFile([]), {
    file: "config/project-scratch-def.json",
    found: false,
  });
  // 空文字のみ → found=false
  assert.equal(resolveScratchDefinitionFile(["", "  "]).found, false);
  // 複数候補は先頭の有効値
  assert.equal(
    resolveScratchDefinitionFile(["", "config/dev.json", "config/qa.json"]).file,
    "config/dev.json"
  );
});

test("sobjectNameError: 空は任意でOK・標準/カスタムオブジェクト名もOK", () => {
  assert.equal(sobjectNameError(""), undefined, "空は任意なのでOK");
  assert.equal(sobjectNameError("  "), undefined, "空白のみもOK(任意)");
  assert.equal(sobjectNameError("Account"), undefined);
  assert.equal(sobjectNameError("MyObject__c"), undefined, "カスタムオブジェクト(__c)はOK");
  assert.equal(sobjectNameError("Order_Item__c"), undefined);
});

test("sobjectNameError: 非空の不正なAPI名を弾く", () => {
  assert.ok(sobjectNameError("My Object"), "スペース");
  assert.ok(sobjectNameError("取引先"), "日本語");
  assert.ok(sobjectNameError("1Object"), "数字始まり");
  assert.ok(sobjectNameError("Obj!"), "記号");
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

test("isProtectedBranch: 共有基準ブランチ(main/master/develop/release*/hotfix*)を保護対象とする", () => {
  for (const b of ["main", "master", "develop", "release/1.0", "hotfix/x"]) {
    assert.equal(isProtectedBranch(b), true, `${b} は保護対象`);
  }
  assert.equal(isProtectedBranch("  develop  "), true, "前後空白はtrim");
  for (const b of ["feature/x", "wip", "my-branch", ""]) {
    assert.equal(isProtectedBranch(b), false, `${b} は保護対象でない`);
  }
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

test("prBaseCandidates: develop/main 上では自分自身を候補から除外する(自己PR防止)", () => {
  // develop 上 → 候補に develop は出さない（main は出る）
  const onDev = prBaseCandidates("develop", ["develop", "main", "feature/x"]);
  assert.ok(!onDev.includes("develop"), "develop上ではdevelopを候補にしない");
  assert.ok(onDev.includes("main"), "mainは候補に残る");
  // main 上 → 候補に main は出さない
  const onMain = prBaseCandidates("main", ["develop", "main"]);
  assert.ok(!onMain.includes("main"), "main上ではmainを候補にしない");
  assert.deepEqual(onMain, ["develop"]);
});

test("prBaseCandidates: current除外・develop/mainは常に含む・残りを後ろに重複なく", () => {
  const got = prBaseCandidates("feature/x", ["feature/x", "develop", "main", "release/2.0", "qa"]);
  assert.deepEqual(got, ["develop", "main", "release/2.0", "qa"]);
  assert.ok(!got.includes("feature/x"), "current は候補に出さない");
  // ブランチ一覧が空でも標準名は出す
  assert.deepEqual(prBaseCandidates("feature/y", []), ["develop", "main"]);
});

test("buildPullRequestArgs: web は --fill を付けず（PRテンプレートを活かす）、非対話は --fill を付ける", () => {
  // ブラウザ作成: --fill を付けない（GitHubのpull_request_template.mdを本文に反映させるため）
  assert.deepEqual(buildPullRequestArgs({ baseBranch: "develop", web: true }), [
    "pr", "create", "--base", "develop", "--web",
  ]);
  // 非対話作成: --fill が無いと gh が入力待ちでハングするので必須
  assert.deepEqual(buildPullRequestArgs({ baseBranch: "main" }), [
    "pr", "create", "--base", "main", "--fill",
  ]);
  // web を明示 false にしても非対話扱い
  assert.deepEqual(buildPullRequestArgs({ baseBranch: "main", web: false }), [
    "pr", "create", "--base", "main", "--fill",
  ]);
});

test("branchTypeOptions: feature/hotfix/release＋自由入力を提供し、プレフィックスは妥当な接頭辞", () => {
  const opts = branchTypeOptions();
  const prefixes = opts.map((o) => o.prefix);
  assert.deepEqual(prefixes, ["feature/", "hotfix/", "release/", ""]);
  // 末尾スラッシュ付きプレフィックス＋名前 が git ブランチ名の許容文字に収まる
  for (const o of opts) {
    const sample = o.prefix + "my-work";
    assert.ok(/^[A-Za-z0-9._/-]+$/.test(sample), `妥当な文字: ${sample}`);
    assert.ok(!sample.includes("//") && !sample.includes(".."), `不正連続なし: ${sample}`);
  }
  // 各オプションにラベルと説明がある
  assert.ok(opts.every((o) => o.label.length > 0 && o.detail.length > 0));
});

test("buildReleaseCreateArgs: 既定で --generate-notes 付き、title/latest を任意で追加", () => {
  assert.deepEqual(buildReleaseCreateArgs("v1.2.0"), [
    "release", "create", "v1.2.0", "--generate-notes",
  ]);
  assert.deepEqual(buildReleaseCreateArgs("v1.2.0", { title: "Release 1.2.0", latest: true }), [
    "release", "create", "v1.2.0", "--generate-notes", "--title", "Release 1.2.0", "--latest",
  ]);
  // generateNotes:false なら付けない／前後空白はtrim
  assert.deepEqual(buildReleaseCreateArgs("  v2.0.0  ", { generateNotes: false }), [
    "release", "create", "v2.0.0",
  ]);
});

test("buildReleaseCreateArgs: タグ名が空なら例外", () => {
  assert.throws(() => buildReleaseCreateArgs("  "), /タグ名/);
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

test("BASELINE_FORCEIGNORE は Salesforce標準のデプロイ不可ノイズのみを除外する", () => {
  // 普遍的に非デプロイなものだけ（実メタデータの取りこぼしを起こさない）。
  assert.match(BASELINE_FORCEIGNORE, /package\.xml/);
  assert.match(BASELINE_FORCEIGNORE, /\*\*\/jsconfig\.json/);
  assert.match(BASELINE_FORCEIGNORE, /\*\*\/\.eslintrc\.json/);
  assert.match(BASELINE_FORCEIGNORE, /\*\*\/__tests__\/\*\*/);
  // force-app 等の実ソースを丸ごと除外する行が無いこと（無言の未デプロイ防止）。
  assert.ok(!/^force-app/m.test(BASELINE_FORCEIGNORE));
  assert.ok(BASELINE_FORCEIGNORE.length > 0);
});

test("shouldWriteBaselineForceignore は無い/空のときだけ true（既存は尊重）", () => {
  assert.equal(shouldWriteBaselineForceignore(undefined), true);
  assert.equal(shouldWriteBaselineForceignore(""), true);
  assert.equal(shouldWriteBaselineForceignore("   \n  "), true);
  assert.equal(shouldWriteBaselineForceignore("package.xml\n"), false);
  assert.equal(shouldWriteBaselineForceignore("# 既存のユーザー設定"), false);
});
