import { test } from "node:test";
import assert from "node:assert/strict";
import {
  branchCondition,
  cicdFiles,
  codeowners,
  consumerKeyError,
  deployWorkflow,
  integrationUsernameError,
  loginUrlError,
  prValidationWorkflow,
  pullRequestTemplate,
  secretPrefix,
  envSlug,
  envSlugCollisions,
} from "../src/cicd/templates.js";
import { defaultConfig } from "../src/config/teamflowConfig.js";

test("日本語のみの環境名でもjob id/secretが衝突しない(orgAliasへフォールバック)", () => {
  const cfg = {
    version: 1 as const,
    defaultBaseRef: "origin/main",
    testLevel: "RunLocalTests" as const,
    packageDirectories: ["force-app"],
    environments: [
      { name: "開発環境", orgAlias: "scratch-dev", branch: "develop", type: "scratch" as const },
      { name: "ステージング環境", orgAlias: "myDevOrg", branch: "release/*", type: "sandbox" as const },
      { name: "本番環境", orgAlias: "mfg-dev", branch: "main", type: "production" as const },
    ],
  };
  // envSlug は orgAlias 由来でユニーク
  const slugs = cfg.environments.map(envSlug);
  assert.deepEqual(slugs, ["scratch-dev", "mydevorg", "mfg-dev"]);
  assert.equal(new Set(slugs).size, 3, "slug が一意");
  // secretPrefix も一意
  const prefixes = cfg.environments.map(secretPrefix);
  assert.deepEqual(prefixes, ["SF_SCRATCH_DEV", "SF_MYDEVORG", "SF_MFG_DEV"]);
  assert.equal(new Set(prefixes).size, 3, "secretPrefix が一意");
  // deploy job id も一意（YAML破損しない）
  const yml = deployWorkflow(cfg);
  const jobIds = [...yml.matchAll(/^  (deploy-[^:]*):/gm)].map((m) => m[1]);
  assert.equal(jobIds.length, 3);
  assert.equal(new Set(jobIds).size, 3, "deploy job id が一意");
});

test("envSlug: ASCII名はそのまま / 非ASCIIはorgAliasへ", () => {
  assert.equal(envSlug({ name: "uat-eu", orgAlias: "u", branch: "b", type: "sandbox" }), "uat-eu");
  assert.equal(envSlug({ name: "開発", orgAlias: "scratch-dev", branch: "b", type: "scratch" }), "scratch-dev");
});

test("branchCondition emits exact vs startsWith for globs", () => {
  assert.equal(
    branchCondition({ name: "p", orgAlias: "p", branch: "main", type: "production" }),
    "github.ref == 'refs/heads/main'"
  );
  assert.equal(
    branchCondition({ name: "r", orgAlias: "u", branch: "release/*", type: "sandbox" }),
    "startsWith(github.ref, 'refs/heads/release/')"
  );
});

test("deployWorkflow: 本番ジョブは NoTestRun 設定でも RunLocalTests でデプロイ(testLevelFor経由)", () => {
  const cfg = {
    version: 1 as const,
    defaultBaseRef: "origin/main",
    testLevel: "NoTestRun" as const,
    packageDirectories: ["force-app"],
    environments: [
      { name: "prod", orgAlias: "p", branch: "main", type: "production" as const, testLevel: "NoTestRun" as const },
    ],
  };
  const yml = deployWorkflow(cfg);
  assert.ok(yml.includes("--test-level RunLocalTests"), "本番はRunLocalTestsに引き上げ");
  assert.ok(!yml.includes("--test-level NoTestRun"), "本番でNoTestRunは出さない");
});

test("deployWorkflow: 初回(親コミット無し)はパッケージ全体をデプロイし取りこぼさない", () => {
  const yml = deployWorkflow(defaultConfig());
  // 親が無ければ CHANGED にパッケージdirを入れる分岐がある
  assert.ok(yml.includes('BEFORE=$(git rev-parse HEAD~1 2>/dev/null || echo "")'), "親無しは空に");
  assert.ok(yml.includes('CHANGED="force-app"'), "初回はパッケージ全体をデプロイ");
});

test("deployWorkflow/prValidation: 複数パッケージdirでも全dirをスコープし取りこぼさない", () => {
  const cfg = {
    version: 1 as const,
    defaultBaseRef: "origin/main",
    testLevel: "RunLocalTests" as const,
    packageDirectories: ["force-app", "shared"],
    environments: [{ name: "prod", orgAlias: "p", branch: "main", type: "production" as const }],
  };
  const dep = deployWorkflow(cfg);
  // 初回(親無し)は両dirをデプロイ対象に
  assert.ok(dep.includes('CHANGED="force-app shared"'), "初回は全パッケージdirをデプロイ");
  // 差分deployも両dirスコープ
  assert.ok(dep.includes("HEAD -- force-app shared"), "差分deployは全dirスコープ");
  // デプロイは diff で得たファイルを -d で個別に渡す（--source-dir 列挙ではない）
  assert.ok(dep.includes("for f in") && dep.includes('DIRS="$DIRS -d $f"'), "差分ファイルを-dで渡す");
  // 削除パスは存在チェックで除外（sfの「Path does not exist」失敗を防ぐ）／削除のみはスキップ
  assert.ok(dep.includes('[ -e "$f" ] && DIRS="$DIRS -d $f"'), "存在するファイルのみ-dに渡す");
  assert.ok(dep.includes('if [ -z "$DIRS" ]'), "削除のみのときはデプロイをスキップ");
  // PR検証: 差分も両dirスコープ / PMDスキャナの--targetも両dir / pathsフィルタも両dir
  const pr = prValidationWorkflow(cfg);
  assert.ok(pr.includes('"origin/$BASE...HEAD" -- force-app shared'), "PR検証diffは全dirスコープ");
  assert.ok(pr.includes('--target "force-app,shared"'), "PMDスキャナも全dirを対象");
  assert.ok(pr.includes('"force-app/**"') && pr.includes('"shared/**"'), "pathsフィルタも全dir");
  // PR検証も削除パスを除外し、削除のみならスキップ
  assert.ok(pr.includes('[ -e "$f" ] && DIRS="$DIRS -d $f"'), "PR検証も存在するファイルのみ-dに渡す");
  assert.ok(pr.includes('if [ -z "$DIRS" ]'), "PR検証も削除のみのときはスキップ");
});

test("prValidation: JS系ジョブ(Jest/ESLint/Prettier)はLWC/設定が無ければスキップ(Apex専用でCIが失敗しない)", () => {
  const yml = prValidationWorkflow(defaultConfig());
  // Jest: LWC ディレクトリが無ければスキップ
  assert.ok(yml.includes("-name lwc"), "Jestは lwc ディレクトリ有無で分岐");
  assert.ok(yml.includes("LWC コンポーネントが無いためスキップします"), "LWC無しはJestスキップ");
  // Prettier: 設定が無ければスキップ
  assert.ok(yml.includes("Prettier 設定が無いためスキップします"), "設定無しはPrettierスキップ");
  // ESLint: LWC/Aura かつ設定が無ければスキップ
  assert.ok(yml.includes("ESLint 設定 または LWC/Aura が無いためスキップします"), "条件未満はESLintスキップ");
  // いずれも「設定/対象があるときだけ npm 実行」で、無条件 npm run はしない
  assert.ok(!/^\s*- name: .*\n\s*run: npm run (lint|test:unit)\s*$/m.test(yml), "無条件のnpm run は無い");
});

test("deployWorkflow contains a job per environment with its org + auth secrets", () => {
  const c = defaultConfig();
  const yml = deployWorkflow(c);
  for (const env of c.environments) {
    assert.ok(yml.includes(`Deploy → ${env.name}`), `missing job for ${env.name}`);
    assert.ok(yml.includes(`--target-org ${env.orgAlias}`), `missing org ${env.orgAlias}`);
    assert.ok(yml.includes(`${secretPrefix(env)}_JWT_KEY`), `missing secret for ${env.name}`);
  }
  assert.ok(yml.includes("on:\n  push:"));
});

test("prValidationWorkflow validates (check-only) on pull_request", () => {
  const yml = prValidationWorkflow(defaultConfig());
  assert.ok(yml.includes("on:\n  pull_request:"));
  assert.ok(yml.includes("sf project deploy validate"));
  // base取得に不正な --depth=0 を使わない（gitは正の整数のみ→fetch失敗で検証が空振り）。
  assert.ok(!yml.includes("--depth=0"), "不正な --depth=0 を使わない");
  assert.ok(yml.includes('git fetch origin "$BASE" || true'), "baseを通常fetchする");
});

test("prValidationWorkflow includes PMD static analysis and LWC Jest jobs", () => {
  const yml = prValidationWorkflow(defaultConfig());
  assert.ok(yml.includes("apex-pmd:"), "PMD job present");
  assert.ok(yml.includes("sf scanner run"), "runs the scanner (PMD)");
  assert.ok(yml.includes("--engine pmd"), "uses the pmd engine");
  assert.ok(yml.includes("lwc-jest:"), "Jest job present");
  assert.ok(yml.includes("sfdx-lwc-jest") || yml.includes("test:unit"), "runs LWC jest");
  assert.ok(yml.includes("format-check:"), "Prettier format-check job present");
  assert.ok(yml.includes("prettier --check"), "runs prettier --check");
  assert.ok(yml.includes("cancel-in-progress: true"), "PR検証に並行制御(古い実行のキャンセル)");
  assert.ok(yml.includes("lint-lwc:"), "ESLint job present");
  assert.ok(yml.includes("npm run lint"), "runs eslint via npm run lint");
});

test("envSlugCollisions: 同じslugへcollapseする環境を検出する", () => {
  // "UAT EU" と "UAT-EU" はどちらも slug "uat-eu" → 衝突
  const colliding = {
    version: 1 as const,
    defaultBaseRef: "origin/main",
    testLevel: "RunLocalTests" as const,
    packageDirectories: ["force-app"],
    environments: [
      { name: "UAT EU", orgAlias: "a", branch: "develop", type: "sandbox" as const },
      { name: "UAT-EU", orgAlias: "b", branch: "release/*", type: "sandbox" as const },
      { name: "prod", orgAlias: "p", branch: "main", type: "production" as const },
    ],
  };
  const hits = envSlugCollisions(colliding);
  assert.equal(hits.length, 1, "1つの衝突グループ");
  assert.equal(hits[0].slug, "uat-eu");
  assert.deepEqual(hits[0].envs.sort(), ["UAT EU", "UAT-EU"]);
});

test("envSlugCollisions: 既定設定など一意なら空配列", () => {
  assert.deepEqual(envSlugCollisions(defaultConfig()), []);
});

test("両ワークフローの全ジョブに timeout-minutes（ハング暴走の安全網）がある", () => {
  for (const [name, yml] of [
    ["validate", prValidationWorkflow(defaultConfig())],
    ["deploy", deployWorkflow(defaultConfig())],
  ] as const) {
    const runsOn = (yml.match(/^ {4}runs-on:/gm) || []).length;
    const timeouts = (yml.match(/^ {4}timeout-minutes:/gm) || []).length;
    assert.ok(runsOn > 0, `${name}: ジョブがある`);
    assert.equal(timeouts, runsOn, `${name}: 全ジョブに timeout-minutes がある`);
  }
});

test("両ワークフローは最小権限(permissions: contents: read)を宣言する", () => {
  const pr = prValidationWorkflow(defaultConfig());
  const dep = deployWorkflow(defaultConfig());
  for (const [name, yml] of [["validate", pr], ["deploy", dep]] as const) {
    assert.ok(yml.includes("permissions:"), `${name}: permissions ブロックがある`);
    assert.ok(
      /permissions:\s*\n\s+contents: read/.test(yml),
      `${name}: contents: read を宣言する`
    );
    // 書き込み権限を不用意に付けていないこと
    assert.ok(!yml.includes("contents: write"), `${name}: contents: write は付けない`);
  }
});

test("codeowners lists the package directories", () => {
  const co = codeowners(defaultConfig());
  assert.ok(co.includes("force-app/ @your-team"));
});

test("cicdFiles returns the expected paths (workflows + CODEOWNERS + PRテンプレート)", () => {
  const files = cicdFiles(defaultConfig()).map((f) => f.relativePath).sort();
  assert.deepEqual(files, [
    ".github/CODEOWNERS",
    ".github/pull_request_template.md",
    ".github/workflows/sf-deploy.yml",
    ".github/workflows/sf-validate.yml",
  ]);
});

test("pullRequestTemplate は Salesforce のレビュー観点（テスト/カバレッジ・破壊的変更）を含む", () => {
  const t = pullRequestTemplate();
  assert.match(t, /## 概要/);
  assert.match(t, /Apexテスト/);
  assert.match(t, /カバレッジ/);
  assert.match(t, /破壊的変更/);
  // チェックボックス（GitHubのタスクリスト）を含む
  assert.match(t, /- \[ \]/);
  assert.ok(t.length > 0);
});

test("secretPrefix uppercases and replaces non-alphanumerics with underscores", () => {
  assert.equal(secretPrefix({ name: "uat-eu", orgAlias: "u", branch: "b", type: "sandbox" }), "SF_UAT_EU");
  // A run of non-[A-Z0-9] collapses to a single underscore.
  assert.equal(secretPrefix({ name: "ua t-eu", orgAlias: "u", branch: "b", type: "sandbox" }), "SF_UA_T_EU");
  // ASCII alphanumerics survive; everything else (incl. multibyte) → "_".
  assert.equal(secretPrefix({ name: "v2-本番", orgAlias: "p", branch: "main", type: "production" }), "SF_V2_");
});

test("branchCondition glob uses startsWith with the literal prefix", () => {
  assert.equal(
    branchCondition({ name: "h", orgAlias: "h", branch: "hotfix/*", type: "sandbox" }),
    "startsWith(github.ref, 'refs/heads/hotfix/')"
  );
});

test("prValidationWorkflow triggers on pull_request and filters package dirs", () => {
  const yml = prValidationWorkflow(defaultConfig());
  assert.match(yml, /on:\n {2}pull_request:/);
  assert.ok(yml.includes('"force-app/**"'));
  assert.ok(yml.includes("sf project deploy validate"));
});

test("deployWorkflow triggers on push and has concurrency guard per env", () => {
  const c = defaultConfig();
  const yml = deployWorkflow(c);
  assert.match(yml, /on:\n {2}push:/);
  assert.ok(yml.includes("concurrency:"));
  // one deploy job per environment
  for (const e of c.environments) {
    assert.ok(yml.includes("deploy-" + e.name.toLowerCase()), "job for " + e.name);
  }
});

test("codeowners references every package directory", () => {
  const c = defaultConfig();
  const co = codeowners(c);
  for (const d of c.packageDirectories) {
    assert.ok(co.includes(d + "/ @your-team"), "owns " + d);
  }
});

test("codeowners はプレースホルダをコメント化し『unknown owner』を避ける", () => {
  const co = codeowners(defaultConfig());
  // 有効な(行頭が#でない)所有者行が無いこと＝置き換えるまで無効
  const activeOwnerLine = co
    .split("\n")
    .some((l) => !l.trimStart().startsWith("#") && l.includes("@your-team"));
  assert.equal(activeOwnerLine, false, "プレースホルダ所有者は有効行にしない");
});

test("cicdFiles returns workflows + CODEOWNERS with non-empty content", () => {
  const files = cicdFiles(defaultConfig());
  const paths = files.map((f) => f.relativePath).sort();
  assert.deepEqual(paths, [
    ".github/CODEOWNERS",
    ".github/pull_request_template.md",
    ".github/workflows/sf-deploy.yml",
    ".github/workflows/sf-validate.yml",
  ]);
  assert.ok(files.every((f) => f.content.length > 0));
});

test("consumerKeyError は空・空白文字を弾き、正常値は通す", () => {
  assert.ok(consumerKeyError(""));
  assert.ok(consumerKeyError("   "));
  assert.ok(consumerKeyError("3MVG9 abc")); // 内部空白はNG
  assert.equal(consumerKeyError("3MVG9aBcDeF0123456789"), undefined);
  assert.equal(consumerKeyError("  3MVG9key  "), undefined); // 前後空白はtrimされOK
});

test("integrationUsernameError は空・空白入りを弾き、正常値は通す", () => {
  assert.ok(integrationUsernameError(""));
  assert.ok(integrationUsernameError("   "));
  assert.ok(integrationUsernameError("ci user@example.com"));
  assert.equal(integrationUsernameError("ci@example.com"), undefined);
  assert.equal(integrationUsernameError("ci@example.com.sandbox"), undefined);
});

test("loginUrlError は https:// 以外を弾き、正しいログインURLは通す", () => {
  assert.ok(loginUrlError(""));
  assert.ok(loginUrlError("login.salesforce.com")); // スキームなし
  assert.ok(loginUrlError("http://login.salesforce.com")); // httpはNG
  assert.ok(loginUrlError("https://my domain.salesforce.com")); // 空白入りはNG
  assert.equal(loginUrlError("https://login.salesforce.com"), undefined);
  assert.equal(loginUrlError("https://test.salesforce.com"), undefined);
  assert.equal(loginUrlError("https://mycompany.my.salesforce.com"), undefined);
});
