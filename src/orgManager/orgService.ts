import { runSf } from "../util/cli.js";

/** Raw org record as emitted by `sf org list --json`. */
export interface RawOrg {
  username: string;
  orgId?: string;
  alias?: string;
  instanceUrl?: string;
  loginUrl?: string;
  connectedStatus?: string;
  status?: string;
  isDefaultUsername?: boolean;
  isDefaultDevHubUsername?: boolean;
  isScratchOrg?: boolean;
  isDevHub?: boolean;
  isSandbox?: boolean;
  expirationDate?: string;
  namespacePrefix?: string;
}

export interface OrgListResult {
  nonScratchOrgs?: RawOrg[];
  scratchOrgs?: RawOrg[];
  sandboxes?: RawOrg[];
  devHubs?: RawOrg[];
  other?: RawOrg[];
}

export type OrgCategory = "Scratch" | "Sandbox" | "DevHub" | "Production" | "Other";

export interface OrgInfo extends RawOrg {
  category: OrgCategory;
  isProduction: boolean;
  displayName: string;
  connected: boolean;
}

/**
 * Heuristic: is this org a *real* production / developer-edition org that a
 * misfired deploy could damage? Scratch and sandbox orgs are explicitly safe.
 * We key off the login URL (test.salesforce.com == sandbox) and the My Domain
 * host. It is intentionally conservative — when unsure we DO flag it, so the
 * worst case is an extra confirmation, never a silent production deploy.
 */
export function isProductionOrg(o: RawOrg): boolean {
  if (o.isScratchOrg || o.isSandbox) {
    return false;
  }
  const login = (o.loginUrl || "").toLowerCase();
  if (login.includes("test.salesforce.com")) {
    return false;
  }
  const instance = (o.instanceUrl || "").toLowerCase();
  if (login.includes("login.salesforce.com")) {
    return true;
  }
  // A My Domain host that is not flagged sandbox/scratch is treated as prod.
  return /\.my\.salesforce\.com/.test(instance) && !/sandbox|scratch/.test(instance);
}

export function categorize(o: RawOrg): OrgCategory {
  if (o.isScratchOrg) {
    return "Scratch";
  }
  if (o.isSandbox) {
    return "Sandbox";
  }
  if (o.isDevHub) {
    return "DevHub";
  }
  if (isProductionOrg(o)) {
    return "Production";
  }
  return "Other";
}

function toOrgInfo(o: RawOrg): OrgInfo {
  const connected =
    (o.connectedStatus ?? o.status ?? "").toLowerCase() === "connected" ||
    // Scratch orgs report "Active" rather than "Connected".
    (o.connectedStatus ?? o.status ?? "").toLowerCase() === "active" ||
    Boolean(o.isScratchOrg);
  return {
    ...o,
    category: categorize(o),
    isProduction: isProductionOrg(o),
    displayName: o.alias || o.username,
    connected,
  };
}

/**
 * Flatten the `sf org list` envelope into a de-duplicated, categorised list.
 * De-dup key is username (an org can appear in more than one bucket across
 * CLI versions). Exported as a pure function for unit testing.
 */
export function parseOrgList(result: OrgListResult): OrgInfo[] {
  const buckets = [
    result.nonScratchOrgs,
    result.scratchOrgs,
    result.sandboxes,
    result.devHubs,
    result.other,
  ];
  const byUser = new Map<string, OrgInfo>();
  for (const bucket of buckets) {
    if (!bucket) {
      continue;
    }
    for (const raw of bucket) {
      if (!raw?.username) {
        continue;
      }
      const existing = byUser.get(raw.username);
      // Merge so later buckets can fill in flags missing from earlier ones.
      const merged = existing ? { ...existing, ...raw } : raw;
      byUser.set(raw.username, toOrgInfo(merged));
    }
  }
  return [...byUser.values()].sort((a, b) => {
    if (a.category !== b.category) {
      return CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Scratch-org expiry as a short Japanese label ("残り5日" / "期限切れ"), or
 * undefined for non-scratch / unknown. Pure & unit-tested; shared by the home
 * cards and the Org detail tree.
 */
export function scratchRemainingLabel(
  category: OrgCategory | string,
  expirationDate: string | undefined,
  nowMs: number
): string | undefined {
  if (category !== "Scratch" || !expirationDate) {
    return undefined;
  }
  const exp = new Date(expirationDate).getTime();
  if (Number.isNaN(exp)) {
    return undefined;
  }
  const days = Math.ceil((exp - nowMs) / 86_400_000);
  return days < 0 ? "期限切れ" : `残り${days}日`;
}

/**
 * True when a scratch org's expiration date has passed. Used to gray out and
 * offer cleanup of dead scratch orgs in the home view. Pure & unit-tested.
 */
export function isScratchExpired(
  category: OrgCategory | string,
  expirationDate: string | undefined,
  nowMs: number
): boolean {
  if (category !== "Scratch" || !expirationDate) {
    return false;
  }
  const exp = new Date(expirationDate).getTime();
  return !Number.isNaN(exp) && exp < nowMs;
}

/**
 * True when a scratch org is still valid but expires within `thresholdDays`
 * (default 2) — i.e. nearly out of time. 失効前に「巻き取る/延長する」よう促すための
 * 警告表示用。既に期限切れ（isScratchExpired）のものは含めない。Pure & unit-tested.
 */
export function isScratchExpiringSoon(
  category: OrgCategory | string,
  expirationDate: string | undefined,
  nowMs: number,
  thresholdDays = 2
): boolean {
  if (category !== "Scratch" || !expirationDate) {
    return false;
  }
  const exp = new Date(expirationDate).getTime();
  if (Number.isNaN(exp) || exp < nowMs) {
    return false;
  }
  const days = Math.ceil((exp - nowMs) / 86_400_000);
  return days <= thresholdDays;
}

export const CATEGORY_ORDER: Record<OrgCategory, number> = {
  Production: 0,
  Sandbox: 1,
  DevHub: 2,
  Scratch: 3,
  Other: 4,
};

/**
 * 環境カテゴリを初心者向けの日本語ラベルにする（英語の category 名だと伝わりにくいため）。
 * 環境選択ピッカーなどで使用。英語名も併記して検索性は保つ用途を想定。未知値はそのまま返す。
 * Pure & unit-tested.
 */
export function orgCategoryLabel(category: OrgCategory | string): string {
  const gloss: Record<OrgCategory, string> = {
    Production: "本番（お客様が使う）",
    Sandbox: "Sandbox（検証用）",
    DevHub: "Dev Hub（使い捨て環境の親）",
    Scratch: "スクラッチ（使い捨て）",
    Other: "その他",
  };
  return (gloss as Record<string, string>)[category] ?? category;
}

export interface OrgServiceOptions {
  cliPath?: string;
  cwd?: string;
}

/** Live fetch of the authorised orgs from the Salesforce CLI. */
export async function listOrgs(options: OrgServiceOptions = {}): Promise<OrgInfo[]> {
  const result = await runSf<OrgListResult>(["org", "list"], {
    cliPath: options.cliPath,
    cwd: options.cwd,
    timeout: 60_000,
  });
  return parseOrgList(result);
}
