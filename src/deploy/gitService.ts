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
/**
 * Ordered base-ref candidates to try when the configured one is missing.
 * Many repos default to `master` (not `main`), so `origin/main` (the default
 * setting) doesn't exist and `git diff origin/main...HEAD` would crash. We fall
 * back to the actual default branch. Pure & unit-tested.
 */
export function baseRefCandidates(preferred: string): string[] {
  const fallbacks = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [preferred, ...fallbacks]) {
    const v = (r || "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** First base-ref candidate that actually exists in the repo, or undefined. */
export async function resolveBaseRef(preferred: string, cwd: string): Promise<string | undefined> {
  for (const ref of baseRefCandidates(preferred)) {
    const r = await run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd,
      timeout: 10_000,
    });
    if (r.code === 0 && r.stdout.trim()) {
      return ref;
    }
  }
  return undefined;
}

export async function changedFiles(baseRef: string, cwd: string): Promise<DiffEntry[]> {
  // 設定の baseRef が存在しない場合（例: 既定 origin/main だが repo は master）に
  // 落ちないよう、実在する基準refへフォールバックする。解決できなければ committed 差分は空。
  const base = await resolveBaseRef(baseRef, cwd);
  const committed = base
    ? parseNameStatus(await git(["diff", "--name-status", `${base}...HEAD`], cwd))
    : [];
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

/* --------------------------- working-tree status -------------------------- */

export interface StatusFile {
  path: string;
  /** Human label for the change, e.g. "変更", "新規", "削除". */
  label: string;
  staged: boolean;
}

export interface StatusSummary {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: StatusFile[];
  /** Convenience: total changed paths (staged or not, incl. untracked). */
  get changed(): number;
}

function changeLabel(code: string): string {
  switch (code) {
    case "M":
      return "変更";
    case "A":
      return "新規";
    case "D":
      return "削除";
    case "R":
      return "リネーム";
    case "C":
      return "コピー";
    case "?":
      return "未追跡";
    case "U":
      return "競合";
    default:
      return code;
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z`? We use the newline form for
 * testability. Handles branch headers, ordinary (1), rename/copy (2) and
 * untracked (?) records. Exported pure for unit testing.
 */
export function parsePorcelainV2(stdout: string): StatusSummary {
  let branch = "";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: StatusFile[] = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) {
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(8).join(" ");
      files.push(toStatusFile(xy, path));
    } else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      // path<TAB>origPath after the 9th field.
      const rest = parts.slice(9).join(" ");
      const path = rest.split("\t")[0];
      files.push(toStatusFile(xy, path));
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), label: changeLabel("?"), staged: false });
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      files.push({ path: parts.slice(10).join(" "), label: changeLabel("U"), staged: false });
    }
  }

  const summary = {
    branch,
    upstream,
    ahead,
    behind,
    files,
    get changed() {
      return this.files.length;
    },
  };
  return summary;
}

function toStatusFile(xy: string, path: string): StatusFile {
  const index = xy[0] ?? ".";
  const work = xy[1] ?? ".";
  const staged = index !== "." && index !== "?";
  const code = staged ? index : work;
  return { path, label: changeLabel(code), staged };
}

/**
 * Files currently in a merge conflict (unmerged, status "競合"). Pure helper so
 * the UI can surface "コンフリクト解決中" and offer to open each file. Exported
 * for unit testing.
 */
export function conflictedFiles(summary: StatusSummary): string[] {
  return summary.files.filter((f) => f.label === "競合").map((f) => f.path);
}

/** Live working-tree status (branch, ahead/behind, changed files). */
export async function status(cwd: string): Promise<StatusSummary> {
  const out = await git(["status", "--porcelain=v2", "--branch"], cwd);
  return parsePorcelainV2(out);
}

/** True when the current branch has an upstream (tracking) branch set. */
export async function hasUpstream(cwd: string): Promise<boolean> {
  const res = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd,
    timeout: 10_000,
  });
  return res.code === 0 && res.stdout.trim().length > 0;
}

/** URL of a named remote, or undefined if it doesn't exist. */
export async function remoteUrl(cwd: string, name = "origin"): Promise<string | undefined> {
  const res = await run("git", ["remote", "get-url", name], { cwd, timeout: 10_000 });
  return res.code === 0 ? res.stdout.trim() : undefined;
}

export async function removeRemote(name: string, cwd: string): Promise<void> {
  await git(["remote", "remove", name], cwd);
}

export async function hasRemote(cwd: string): Promise<boolean> {
  const res = await run("git", ["remote"], { cwd, timeout: 10_000 });
  return res.code === 0 && res.stdout.trim().length > 0;
}

export async function listBranches(cwd: string): Promise<string[]> {
  const out = await git(["branch", "--format=%(refname:short)"], cwd);
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean);
}

/** Local tags, newest first (by creation). */
export async function listTags(cwd: string): Promise<string[]> {
  const out = await git(["tag", "--sort=-creatordate"], cwd);
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean);
}

export interface CommitInfo {
  hash: string;
  rel: string;
  author: string;
  subject: string;
}

/** Parse `git log --pretty=%h\t%cr\t%an\t%s` output. Pure & unit-tested. */
export function parseCommitLog(stdout: string): CommitInfo[] {
  return stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean)
    .map((l) => {
      const [hash, rel, author, ...rest] = l.split("\t");
      return { hash: hash ?? "", rel: rel ?? "", author: author ?? "", subject: rest.join("\t") };
    })
    .filter((c) => c.hash);
}

/** Most recent commits (newest first) for the rollback / history pickers. */
export async function recentCommits(cwd: string, limit = 15): Promise<CommitInfo[]> {
  const out = await git(["log", `-n${limit}`, "--pretty=format:%h%x09%cr%x09%an%x09%s"], cwd);
  return parseCommitLog(out);
}

/** Files changed in a single commit (name-status), for the history drill-down. */
export async function commitFiles(hash: string, cwd: string): Promise<DiffEntry[]> {
  const out = await git(["show", "--name-status", "--format=", hash], cwd);
  return parseNameStatus(out);
}

/**
 * Safely roll back by reverting a commit — creates a NEW "undo" commit, never
 * rewrites history, so it's reversible. On conflict we abort and report it
 * rather than leaving the tree half-reverted.
 */
export async function revertCommit(
  hash: string,
  cwd: string
): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  const res = await run("git", ["--no-optional-locks", "revert", "--no-edit", hash], {
    cwd,
    timeout: 30_000,
  });
  if (res.code === 0) {
    return { ok: true, conflict: false, message: res.stdout.trim() };
  }
  const out = (res.stderr + res.stdout).toLowerCase();
  const conflict = out.includes("conflict");
  if (conflict) {
    // leave the tree clean — the user can resolve manually if they want
    await run("git", ["--no-optional-locks", "revert", "--abort"], { cwd, timeout: 30_000 });
  }
  return { ok: false, conflict, message: (res.stderr || res.stdout).trim() };
}

/** 初回コミットで誤って公開すると危険な、Salesforce開発の定番除外エントリ。 */
export const BASELINE_GITIGNORE_ENTRIES = [
  ".sf/", // org認証トークンを含む
  ".sfdx/", // 旧CLIの認証/キャッシュ
  "ci-keys/", // CI用のJWT秘密鍵
  "node_modules/",
  ".DS_Store",
];

/**
 * 既存の .gitignore 内容に、未記載のベースラインエントリだけを追記して返す。
 * 既にあるものは重複させない。変更不要なら入力をそのまま返す。Pure & unit-tested.
 */
export function mergeGitignore(current: string, entries: string[]): string {
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const missing = entries.filter((e) => !lines.includes(e.trim()));
  if (missing.length === 0) {
    return current;
  }
  const prefix = current && !current.endsWith("\n") ? current + "\n" : current;
  return (
    prefix +
    "\n# Salesforce Dev Manager — 認証情報/秘密鍵などを誤公開しないための除外\n" +
    missing.join("\n") +
    "\n"
  );
}

/* ------------------------------- git mutations ---------------------------- */
/* These wrap git and THROW on failure so command handlers can surface errors. */

export async function initRepo(cwd: string): Promise<void> {
  await git(["init"], cwd);
}

export async function stageAll(cwd: string): Promise<void> {
  await git(["add", "-A"], cwd);
}

export async function commit(message: string, cwd: string): Promise<void> {
  await git(["commit", "-m", message], cwd);
}

export async function push(cwd: string, setUpstream: boolean, branch?: string): Promise<string> {
  const args = ["push"];
  if (setUpstream && branch) {
    args.push("--set-upstream", "origin", branch);
  }
  return git(args, cwd);
}

export async function pull(cwd: string): Promise<string> {
  return git(["pull", "--ff-only"], cwd);
}

export async function createBranch(name: string, cwd: string): Promise<void> {
  await git(["switch", "-c", name], cwd);
}

export async function switchBranch(name: string, cwd: string): Promise<void> {
  await git(["switch", name], cwd);
}

export async function deleteBranch(name: string, cwd: string, force: boolean): Promise<void> {
  await git(["branch", force ? "-D" : "-d", name], cwd);
}

/** Create an annotated tag (used for release tagging). */
export async function createTag(name: string, message: string, cwd: string): Promise<void> {
  await git(["tag", "-a", name, "-m", message || name], cwd);
}

export async function deleteTag(name: string, cwd: string): Promise<void> {
  await git(["tag", "-d", name], cwd);
}

export async function pushTag(name: string, cwd: string): Promise<string> {
  return git(["push", "origin", name], cwd);
}

export async function pushDeleteTag(name: string, cwd: string): Promise<string> {
  return git(["push", "origin", "--delete", name], cwd);
}
