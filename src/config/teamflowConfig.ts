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
