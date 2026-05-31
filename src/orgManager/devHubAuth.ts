import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where the Salesforce CLI stores an org's auth record. Older `sf` builds keep
 * it under `~/.sfdx`; newer ones under `~/.sf`. We check both so the flag fix
 * works regardless of CLI version.
 */
export function devHubAuthFileCandidates(username: string, home: string = os.homedir()): string[] {
  return [
    path.join(home, ".sfdx", `${username}.json`),
    path.join(home, ".sf", `${username}.json`),
  ];
}

/**
 * Older Salesforce CLI versions cache `isDevHub` in the auth record at login
 * time, so an org whose Dev Hub was enabled *after* it was authorised keeps
 * reporting `isDevHub: false` and `org create scratch` fails with
 * "is not a Dev Hub". Once enablement has been *independently verified* (via a
 * ScratchOrgInfo query) we correct that single stale flag in place — every other
 * field, including the encrypted tokens, is round-tripped untouched.
 *
 * Returns true when an auth record was found whose flag is now `true` (whether
 * we set it or it was already correct); false when no record could be updated,
 * in which case the caller should fall back to re-authentication.
 */
export async function refreshDevHubAuthFlag(
  username: string,
  home: string = os.homedir()
): Promise<boolean> {
  for (const file of devHubAuthFileCandidates(username, home)) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue; // not at this location — try the next candidate
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // unreadable / unexpected — leave it alone
    }
    if (!json || typeof json !== "object") {
      continue;
    }
    // Guard against a filename/username mismatch before writing.
    if (typeof json.username === "string" && json.username !== username) {
      continue;
    }
    if (json.isDevHub === true) {
      return true; // already correct
    }
    json.isDevHub = true;
    await fs.writeFile(file, JSON.stringify(json, null, 2) + "\n", "utf8");
    return true;
  }
  return false;
}
