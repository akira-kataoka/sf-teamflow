import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseTeamflowConfig, type TeamflowConfig } from "./teamflowConfig.js";

export const CONFIG_FILENAME = "sf-teamflow.json";

export function configPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG_FILENAME);
}

export async function configExists(workspaceRoot: string): Promise<boolean> {
  try {
    await fs.access(configPath(workspaceRoot));
    return true;
  } catch {
    return false;
  }
}

/** Load + validate sf-teamflow.json. Returns undefined if the file is absent. */
export async function loadConfig(workspaceRoot: string): Promise<TeamflowConfig | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(workspaceRoot), "utf8");
  } catch {
    return undefined;
  }
  return parseTeamflowConfig(JSON.parse(raw));
}

export async function saveConfig(workspaceRoot: string, config: TeamflowConfig): Promise<void> {
  const payload = {
    $schema: "./sf-teamflow.schema.json",
    ...config,
  };
  await fs.writeFile(configPath(workspaceRoot), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

/**
 * Read package directories from sfdx-project.json so generated config / CI
 * targets the real source dirs. Falls back to ["force-app"].
 */
export async function readSfdxPackageDirs(workspaceRoot: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, "sfdx-project.json"), "utf8");
    const parsed = JSON.parse(raw) as { packageDirectories?: { path?: string }[] };
    const dirs = (parsed.packageDirectories ?? [])
      .map((d) => d.path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    return dirs.length > 0 ? dirs : ["force-app"];
  } catch {
    return ["force-app"];
  }
}
