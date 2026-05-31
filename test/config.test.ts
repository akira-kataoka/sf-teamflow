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

test("parseTeamflowConfig is stable under serialize→parse (保存→読込の往復で壊れない)", () => {
  // ウィザードが書く sf-teamflow.json と同等。日本語名/glob/purpose/requireValidation を含む。
  const cfg = parseTeamflowConfig({
    version: 1,
    defaultBaseRef: "origin/main",
    testLevel: "RunLocalTests",
    packageDirectories: ["force-app"],
    environments: [
      { name: "開発環境", orgAlias: "scratch-dev", branch: "feature/*", type: "scratch", purpose: "各開発者が日々使う" },
      { name: "ステージング環境", orgAlias: "myDevOrg", branch: "release/*", type: "sandbox", purpose: "受入" },
      { name: "本番環境", orgAlias: "mfg-dev", branch: "main", type: "production", requireValidation: true },
    ],
  });
  // JSONに直列化して読み直しても等価（保存→読込ラウンドトリップの不変条件）。
  const round = parseTeamflowConfig(JSON.parse(JSON.stringify(cfg)));
  assert.deepEqual(round, cfg);
  // 主要フィールドが保持される。
  assert.equal(round.environments[0].name, "開発環境");
  assert.equal(round.environments[0].branch, "feature/*");
  assert.equal(round.environments[0].purpose, "各開発者が日々使う");
  assert.equal(round.environments[2].requireValidation, true);
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

test("testLevelFor: 本番はNoTestRunを許さずRunLocalTestsに引き上げる", () => {
  const c = parseTeamflowConfig({
    testLevel: "NoTestRun",
    environments: [
      { name: "dev", orgAlias: "d", branch: "develop", type: "sandbox", testLevel: "NoTestRun" },
      { name: "prod", orgAlias: "p", branch: "main", type: "production", testLevel: "NoTestRun" },
    ],
  });
  const dev = resolveEnvironment(c, "develop");
  const prod = resolveEnvironment(c, "main");
  // 非本番は設定どおり NoTestRun を許容
  assert.equal(testLevelFor(c, dev), "NoTestRun");
  // 本番は NoTestRun を RunLocalTests に引き上げ（Salesforceが拒否するため）
  assert.equal(testLevelFor(c, prod), "RunLocalTests");
});

test("matchBranch: edge globs (prefix, suffix, multiple stars, empty)", () => {
  assert.equal(matchBranch("*", "anything/here"), true);
  assert.equal(matchBranch("release/*", "release/"), true);
  assert.equal(matchBranch("*/fix", "hotfix/fix"), true);
  assert.equal(matchBranch("feature/*/wip", "feature/a/wip"), true);
  assert.equal(matchBranch("feature/*/wip", "feature/a/b/wip"), true);
  assert.equal(matchBranch("main", ""), false);
  assert.equal(matchBranch("release/*", "release"), false);
});

test("matchBranch: regex metacharacters in pattern are treated literally", () => {
  assert.equal(matchBranch("v1.0", "v1.0"), true);
  assert.equal(matchBranch("v1.0", "v1x0"), false); // '.' must be literal
});

test("resolveEnvironment: exact wins over glob even if glob is longer", () => {
  const c = parseTeamflowConfig({
    environments: [
      { name: "byGlob", orgAlias: "g", branch: "release/*-long", type: "sandbox" },
      { name: "byExact", orgAlias: "e", branch: "release/x", type: "sandbox" },
    ],
  });
  // "release/x" matches the exact one only; ensure exact is chosen.
  assert.equal(resolveEnvironment(c, "release/x")?.name, "byExact");
});

test("resolveEnvironment: among globs, the longest pattern wins", () => {
  const c = parseTeamflowConfig({
    environments: [
      { name: "short", orgAlias: "s", branch: "feature/*", type: "sandbox" },
      { name: "long", orgAlias: "l", branch: "feature/api/*", type: "sandbox" },
    ],
  });
  assert.equal(resolveEnvironment(c, "feature/api/x")?.name, "long");
  assert.equal(resolveEnvironment(c, "feature/ui/x")?.name, "short");
});

test("resolveEnvironment: no match returns undefined", () => {
  const c = parseTeamflowConfig({
    environments: [{ name: "p", orgAlias: "p", branch: "main", type: "production" }],
  });
  assert.equal(resolveEnvironment(c, "develop"), undefined);
});
