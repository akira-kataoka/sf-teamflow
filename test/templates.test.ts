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
