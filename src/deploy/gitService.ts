import { run } from "../util/exec.js";

export type GitStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface DiffEntry {
  path: string;
  status: GitStatus;
}

export interface ChangeSet {
  /** Source files to add/modify (deploy via --source-dir). */
  toDeploy: string[];
  /** Source files removed in this branch (candidate for destructive delete). */
  toDelete: string[];
  /** Changed files outside the package directories — reported, not deployed. */
  ignored: string[];
}

/**
 * Parse `git diff --name-status -z`? No — we use the plain (newline) form for
 * readability and split on tabs. Rename/copy lines look like:
 *   R100\told/path\tnew/path
 * We map the *new* path to a modify-style change and the *old* path to a delete.
 */
export function parseNameStatus(stdout: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\t");
    const code = parts[0]?.[0] as GitStatus | undefined;
    if (!code) {
      continue;
    }
    if ((code === "R" || code === "C") && parts.length >= 3) {
      entries.push({ path: parts[2], status: "M" });
      if (code === "R") {
        entries.push({ path: parts[1], status: "D" });
      }
    } else if (parts.length >= 2) {
      entries.push({ path: parts[1], status: code });
    }
  }
  return entries;
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isUnderPackageDirs(filePath: string, dirs: string[]): boolean {
  const p = normalize(filePath);
  return dirs.some((d) => {
    const dir = normalize(d).replace(/\/$/, "");
    return p === dir || p.startsWith(dir + "/");
  });
}

/**
 * Split a flat diff into deploy / delete / ignored buckets, scoped to the
 * package directories. `-meta.xml` companions and their source file are both
 * kept (sf resolves the bundle from either). De-duplicates paths.
 */
export function classifyChanges(entries: DiffEntry[], packageDirs: string[]): ChangeSet {
  const toDeploy = new Set<string>();
  const toDelete = new Set<string>();
  const ignored = new Set<string>();

  for (const e of entries) {
    if (!isUnderPackageDirs(e.path, packageDirs)) {
      ignored.add(e.path);
      continue;
    }
    if (e.status === "D") {
      toDelete.add(e.path);
    } else {
      toDeploy.add(e.path);
    }
  }
  // A path that was both modified and (in a rename) deleted should only deploy.
  for (const p of toDeploy) {
    toDelete.delete(p);
  }
  return {
    toDeploy: [...toDeploy].sort(),
    toDelete: [...toDelete].sort(),
    ignored: [...ignored].sort(),
  };
}

/* ----------------------------- live git calls ----------------------------- */

async function git(args: string[], cwd: string): Promise<string> {
  const res = await run("git", ["--no-optional-locks", ...args], { cwd, timeout: 30_000 });
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 10_000 });
  return res.code === 0 && res.stdout.trim() === "true";
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
}

/**
 * Files changed in the working tree relative to `baseRef`, using the merge-base
 * (`baseRef...`) so unrelated commits already on the base branch are excluded.
 * Includes committed changes; uncommitted tracked changes are added via a
 * second working-tree diff, and untracked files are appended as additions.
 */
export async function changedFiles(baseRef: string, cwd: string): Promise<DiffEntry[]> {
  const committed = parseNameStatus(
    await git(["diff", "--name-status", `${baseRef}...HEAD`], cwd)
  );
  const working = parseNameStatus(await git(["diff", "--name-status", "HEAD"], cwd));
  const untrackedRaw = await git(["ls-files", "--others", "--exclude-standard"], cwd);
  const untracked: DiffEntry[] = untrackedRaw
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean)
    .map((p) => ({ path: p, status: "A" as GitStatus }));

  const merged = new Map<string, DiffEntry>();
  for (const e of [...committed, ...working, ...untracked]) {
    const prev = merged.get(e.path);
    // A later delete should win over an add/modify and vice-versa; prefer the
    // working-tree state, which is what these are appended in order to reflect.
    if (!prev || prev.status !== "D") {
      merged.set(e.path, e);
    }
  }
  return [...merged.values()];
}
