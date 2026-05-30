import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseRefFor,
  ConfigError,
  defaultConfig,
  lintTeamflowConfig,
  matchBranch,
  parseTeamflowConfig,
  resolveEnvironment,
  testLevelFor,
} from "../src/config/teamflowConfig.js";

test("parseTeamflowConfig applies defaults", () => {
  const c = parseTeamflowConfig({ environments: [] });
  assert.equal(c.defaultBaseRef, "origin/main");
  assert.equal(c.testLevel, "RunLocalTests");
  assert.deepEqual(c.packageDirectories, ["force-app"]);
  assert.deepEqual(c.environments, []);
});

test("parseTeamflowConfig normalises environments and unknown enums", () => {
  const c = parseTeamflowConfig({
    testLevel: "Bogus",
    packageDirectories: ["force-app", "shared"],
    environments: [
      { name: "prod", orgAlias: "p", branch: "main", type: "production" },
      { name: "qa", orgAlias: "q", branch: "develop", type: "weird", testLevel: "NoTestRun" },
    ],
  });
  assert.equal(c.testLevel, "RunLocalTests"); // bogus -> default
  assert.equal(c.environments[1].type, "sandbox"); // weird -> sandbox
  assert.equal(c.environments[1].testLevel, "NoTestRun");
});

test("parseTeamflowConfig rejects bad input", () => {
  assert.throws(() => parseTeamflowConfig(null), ConfigError);
  assert.throws(() => parseTeamflowConfig({ environments: [{ orgAlias: "x", branch: "b", type: "dev" }] }), ConfigError);
  assert.throws(
    () =>
      parseTeamflowConfig({
        environments: [
          { name: "dup", orgAlias: "a", branch: "main", type: "dev" },
          { name: "dup", orgAlias: "b", branch: "develop", type: "dev" },
        ],
      }),
    /重複/
  );
});

test("matchBranch handles exact and glob", () => {
  assert.equal(matchBranch("main", "main"), true);
  assert.equal(matchBranch("main", "develop"), false);
  assert.equal(matchBranch("release/*", "release/1.2"), true);
  assert.equal(matchBranch("release/*", "releases/1.2"), false);
  assert.equal(matchBranch("feature/*", "feature/a/b"), true); // * crosses '/'
});

test("resolveEnvironment prefers exact then longest glob", () => {
  const c = parseTeamflowConfig({
    environments: [
      { name: "prod", orgAlias: "p", branch: "main", type: "production" },
      { name: "rel", orgAlias: "u", branch: "release/*", type: "sandbox" },
      { name: "relhot", orgAlias: "h", branch: "release/hotfix-*", type: "sandbox" },
    ],
  });
  assert.equal(resolveEnvironment(c, "main")?.name, "prod");
  assert.equal(resolveEnvironment(c, "release/1.0")?.name, "rel");
  assert.equal(resolveEnvironment(c, "release/hotfix-9")?.name, "relhot"); // longest wins
  assert.equal(resolveEnvironment(c, "feature/x"), undefined);
});

test("lintTeamflowConfig: healthy config (defaultConfig with all orgs known)", () => {
  const c = defaultConfig();
  const aliases = c.environments.map((e) => e.orgAlias);
  assert.deepEqual(lintTeamflowConfig(c, aliases), []);
});

test("lintTeamflowConfig flags empty environments", () => {
  const c = parseTeamflowConfig({ environments: [] });
  const w = lintTeamflowConfig(c, []);
  assert.equal(w.length, 1);
  assert.match(w[0], /環境が未定義/);
});

test("lintTeamflowConfig flags duplicate branch, unknown org, no production", () => {
  const c = parseTeamflowConfig({
    environments: [
      { name: "dev", orgAlias: "d", branch: "develop", type: "sandbox" },
      { name: "dev2", orgAlias: "x", branch: "develop", type: "sandbox" },
    ],
  });
  const w = lintTeamflowConfig(c, ["d"]);
  assert.ok(w.some((m) => /重複/.test(m)), "duplicate branch");
  assert.ok(w.some((m) => /「x」が未認証/.test(m)), "unknown org x");
  assert.ok(!w.some((m) => /「d」が未認証/.test(m)), "d is known");
  assert.ok(w.some((m) => /本番.*定義されていません/.test(m)), "no production");
});

test("lintTeamflowConfig skips org check when no known aliases", () => {
  const c = parseTeamflowConfig({
    environments: [{ name: "prod", orgAlias: "p", branch: "main", type: "production" }],
  });
  assert.deepEqual(lintTeamflowConfig(c, []), []);
});

test("baseRefFor and testLevelFor fall back to config defaults", () => {
  const c = defaultConfig();
  const prod = resolveEnvironment(c, "main");
  assert.equal(baseRefFor(c, prod), "origin/main");
  assert.equal(testLevelFor(c, undefined), "RunLocalTests");
});
