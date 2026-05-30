/**
 * `sf-teamflow.json` is the per-repository contract that the whole team shares
 * (committed to git). It maps Salesforce orgs to git branches and deploy
 * policy, so "deploy to staging" means the same thing on every machine and in
 * CI. Everything in this module is pure so it can be unit-tested and reused by
 * the CI templates.
 */

export type EnvironmentType = "production" | "sandbox" | "scratch" | "dev";

export type TestLevel =
  | "NoTestRun"
  | "RunSpecifiedTests"
  | "RunLocalTests"
  | "RunAllTestsInOrg";

export interface TeamEnvironment {
  /** Human label, e.g. "production", "uat", "integration". */
  name: string;
  /** sf org alias this environment deploys to. */
  orgAlias: string;
  /** git branch (or glob, e.g. "release/*") that maps to this environment. */
  branch: string;
  type: EnvironmentType;
  /** Git ref a feature deploy is diffed against. Falls back to defaultBaseRef. */
  baseRef?: string;
  testLevel?: TestLevel;
  /** If true, merges to this branch run validate-only in CI before deploy. */
  requireValidation?: boolean;
}

export interface TeamflowConfig {
  version: number;
  defaultBaseRef: string;
  testLevel: TestLevel;
  packageDirectories: string[];
  environments: TeamEnvironment[];
}

const VALID_TYPES: EnvironmentType[] = ["production", "sandbox", "scratch", "dev"];
const VALID_TEST_LEVELS: TestLevel[] = [
  "NoTestRun",
  "RunSpecifiedTests",
  "RunLocalTests",
  "RunAllTestsInOrg",
];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new ConfigError(`"${field}" は空でない文字列である必要があります。`);
  }
  return v;
}

/**
 * Validate + normalise raw parsed JSON into a TeamflowConfig, applying
 * defaults. Throws ConfigError with a Japanese message on malformed input.
 */
export function parseTeamflowConfig(raw: unknown): TeamflowConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("sf-teamflow.json はオブジェクトである必要があります。");
  }
  const obj = raw as Record<string, unknown>;

  const defaultBaseRef =
    typeof obj.defaultBaseRef === "string" && obj.defaultBaseRef.trim()
      ? obj.defaultBaseRef
      : "origin/main";

  const testLevel =
    typeof obj.testLevel === "string" && VALID_TEST_LEVELS.includes(obj.testLevel as TestLevel)
      ? (obj.testLevel as TestLevel)
      : "RunLocalTests";

  const packageDirectories = Array.isArray(obj.packageDirectories)
    ? obj.packageDirectories.filter((d): d is string => typeof d === "string")
    : ["force-app"];

  const rawEnvs = Array.isArray(obj.environments) ? obj.environments : [];
  const environments: TeamEnvironment[] = rawEnvs.map((e, i) => {
    if (typeof e !== "object" || e === null) {
      throw new ConfigError(`environments[${i}] はオブジェクトである必要があります。`);
    }
    const env = e as Record<string, unknown>;
    const type = VALID_TYPES.includes(env.type as EnvironmentType)
      ? (env.type as EnvironmentType)
      : "sandbox";
    const envTestLevel =
      typeof env.testLevel === "string" &&
      VALID_TEST_LEVELS.includes(env.testLevel as TestLevel)
        ? (env.testLevel as TestLevel)
        : undefined;
    return {
      name: asString(env.name, `environments[${i}].name`),
      orgAlias: asString(env.orgAlias, `environments[${i}].orgAlias`),
      branch: asString(env.branch, `environments[${i}].branch`),
      type,
      baseRef: typeof env.baseRef === "string" ? env.baseRef : undefined,
      testLevel: envTestLevel,
      requireValidation: env.requireValidation === true,
    };
  });

  const names = new Set<string>();
  for (const env of environments) {
    if (names.has(env.name)) {
      throw new ConfigError(`environment 名が重複しています: "${env.name}"`);
    }
    names.add(env.name);
  }

  return { version: 1, defaultBaseRef, testLevel, packageDirectories, environments };
}

/**
 * Glob match where `*` matches any run of characters within a single path
 * segment boundary is NOT enforced (branches use `/` freely, e.g.
 * "release/*" must match "release/1.2"). `*` therefore matches across `/`.
 */
export function matchBranch(pattern: string, branch: string): boolean {
  if (pattern === branch) {
    return true;
  }
  if (!pattern.includes("*")) {
    return false;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(branch);
}

/**
 * Resolve which environment a branch deploys to. Exact-match patterns win over
 * glob patterns; among globs, the longest (most specific) pattern wins.
 */
export function resolveEnvironment(
  config: TeamflowConfig,
  branch: string
): TeamEnvironment | undefined {
  const matches = config.environments.filter((e) => matchBranch(e.branch, branch));
  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((a, b) => {
    const aExact = a.branch === branch ? 1 : 0;
    const bExact = b.branch === branch ? 1 : 0;
    if (aExact !== bExact) {
      return bExact - aExact;
    }
    return b.branch.length - a.branch.length;
  });
  return matches[0];
}

/** The base ref a feature deploy targeting this environment should diff against. */
export function baseRefFor(config: TeamflowConfig, env?: TeamEnvironment): string {
  return env?.baseRef || config.defaultBaseRef;
}

export function testLevelFor(config: TeamflowConfig, env?: TeamEnvironment): TestLevel {
  return env?.testLevel || config.testLevel;
}

/**
 * Lint a team config for common mistakes, returning human-readable warnings
 * (empty = healthy). `knownAliases` are the currently-authorised org aliases;
 * pass [] to skip the unauthorised-org check (e.g. before orgs have loaded).
 * Pure & unit-tested.
 */
export function lintTeamflowConfig(config: TeamflowConfig, knownAliases: string[]): string[] {
  const warnings: string[] = [];
  if (config.environments.length === 0) {
    warnings.push("環境が未定義です。セットアップウィザードで設定してください。");
    return warnings;
  }
  const counts = new Map<string, number>();
  for (const e of config.environments) {
    counts.set(e.branch, (counts.get(e.branch) ?? 0) + 1);
  }
  for (const [branch, n] of counts) {
    if (n > 1) {
      warnings.push(`ブランチ「${branch}」が${n}個の環境に重複して割り当てられています。`);
    }
  }
  if (knownAliases.length > 0) {
    const set = new Set(knownAliases);
    for (const e of config.environments) {
      if (!set.has(e.orgAlias)) {
        warnings.push(`環境「${e.name}」のOrg「${e.orgAlias}」が未認証です。`);
      }
    }
  }
  if (!config.environments.some((e) => e.type === "production")) {
    warnings.push("本番(production)環境が定義されていません。");
  }
  return warnings;
}

/** Default config written by the init command. */
export function defaultConfig(packageDirectories: string[] = ["force-app"]): TeamflowConfig {
  return {
    version: 1,
    defaultBaseRef: "origin/main",
    testLevel: "RunLocalTests",
    packageDirectories,
    environments: [
      {
        name: "production",
        orgAlias: "prod",
        branch: "main",
        type: "production",
        baseRef: "origin/main",
        testLevel: "RunLocalTests",
        requireValidation: true,
      },
      {
        name: "staging",
        orgAlias: "uat",
        branch: "release/*",
        type: "sandbox",
        testLevel: "RunLocalTests",
        requireValidation: true,
      },
      {
        name: "integration",
        orgAlias: "int",
        branch: "develop",
        type: "sandbox",
        testLevel: "RunLocalTests",
      },
    ],
  };
}
