import { test } from "node:test";
import assert from "node:assert/strict";
import {
  branchCondition,
  cicdFiles,
  codeowners,
  deployWorkflow,
  prValidationWorkflow,
  secretPrefix,
  envSlug,
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
});

test("codeowners lists the package directories", () => {
  const co = codeowners(defaultConfig());
  assert.ok(co.includes("force-app/ @your-team"));
});

test("cicdFiles returns the three expected paths", () => {
  const files = cicdFiles(defaultConfig()).map((f) => f.relativePath).sort();
  assert.deepEqual(files, [
    ".github/CODEOWNERS",
    ".github/workflows/sf-deploy.yml",
    ".github/workflows/sf-validate.yml",
  ]);
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

test("cicdFiles returns workflows + CODEOWNERS with non-empty content", () => {
  const files = cicdFiles(defaultConfig());
  const paths = files.map((f) => f.relativePath).sort();
  assert.deepEqual(paths, [
    ".github/CODEOWNERS",
    ".github/workflows/sf-deploy.yml",
    ".github/workflows/sf-validate.yml",
  ]);
  assert.ok(files.every((f) => f.content.length > 0));
});
