import { test } from "node:test";
import assert from "node:assert/strict";
import {
  branchCondition,
  cicdFiles,
  codeowners,
  deployWorkflow,
  prValidationWorkflow,
  secretPrefix,
} from "../src/cicd/templates.js";
import { defaultConfig } from "../src/config/teamflowConfig.js";

test("secretPrefix uppercases and sanitises env name", () => {
  assert.equal(secretPrefix({ name: "uat-eu", orgAlias: "u", branch: "b", type: "sandbox" }), "SF_UAT_EU");
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
