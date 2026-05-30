import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ScaffoldFile } from "./templates.js";

export interface WriteResult {
  written: string[];
  skipped: string[];
}

/**
 * Write scaffold files relative to the workspace root, creating parent dirs.
 * Existing files are skipped unless `overwrite` is set — we never clobber a
 * team's customised CI without being asked.
 */
export async function writeScaffold(
  workspaceRoot: string,
  files: ScaffoldFile[],
  overwrite: boolean
): Promise<WriteResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const abs = path.join(workspaceRoot, file.relativePath);
    if (!overwrite) {
      try {
        await fs.access(abs);
        skipped.push(file.relativePath);
        continue;
      } catch {
        /* does not exist — proceed */
      }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, "utf8");
    written.push(file.relativePath);
  }
  return { written, skipped };
}
