/**
 * Argument builders for `sf project ...` and scratch-org commands. Pure &
 * unit-tested; the command handlers run the rendered command line in a terminal
 * so beginners see live progress and the same command they could type by hand.
 */

export interface ProjectGenerateOptions {
  name: string;
  template?: "standard" | "empty" | "analytics";
  defaultPackageDir?: string;
  manifest?: boolean;
}

export function buildProjectGenerateArgs(opts: ProjectGenerateOptions): string[] {
  if (!opts.name.trim()) {
    throw new Error("プロジェクト名を入力してください。");
  }
  const args = ["project", "generate", "--name", opts.name];
  args.push("--template", opts.template ?? "standard");
  if (opts.defaultPackageDir) {
    args.push("--default-package-dir", opts.defaultPackageDir);
  }
  if (opts.manifest) {
    args.push("--manifest");
  }
  return args;
}

export interface RetrieveOptions {
  orgUsername: string;
  /** Metadata type names, e.g. ["ApexClass", "Flow:My_Flow"]. */
  metadata?: string[];
  /** Source directories to retrieve into / from. */
  sourceDir?: string[];
  /** package.xml manifest path. */
  manifest?: string;
}

export function buildRetrieveArgs(opts: RetrieveOptions): string[] {
  const args = ["project", "retrieve", "start", "--target-org", opts.orgUsername];
  let scoped = false;
  for (const m of opts.metadata ?? []) {
    args.push("--metadata", m);
    scoped = true;
  }
  for (const d of opts.sourceDir ?? []) {
    args.push("--source-dir", d);
    scoped = true;
  }
  if (opts.manifest) {
    args.push("--manifest", opts.manifest);
    scoped = true;
  }
  if (!scoped) {
    throw new Error("取得対象 (メタデータ / ディレクトリ / manifest) を指定してください。");
  }
  return args;
}

/** Source sync for tracking-enabled (scratch / sandbox) orgs. */
export function buildSourcePushArgs(orgUsername: string, packageDirs: string[]): string[] {
  const args = ["project", "deploy", "start", "--target-org", orgUsername];
  for (const d of packageDirs) {
    args.push("--source-dir", d);
  }
  return args;
}

export function buildSourcePullArgs(orgUsername: string): string[] {
  return ["project", "retrieve", "start", "--target-org", orgUsername];
}

export interface ScratchCreateOptions {
  alias: string;
  definitionFile: string;
  durationDays: number;
  setDefault?: boolean;
  devhubUsername?: string;
}

export function buildScratchCreateArgs(opts: ScratchCreateOptions): string[] {
  if (!opts.alias.trim()) {
    throw new Error("エイリアスを入力してください。");
  }
  const args = [
    "org",
    "create",
    "scratch",
    "--definition-file",
    opts.definitionFile,
    "--alias",
    opts.alias,
    "--duration-days",
    String(opts.durationDays),
  ];
  if (opts.setDefault) {
    args.push("--set-default");
  }
  if (opts.devhubUsername) {
    args.push("--target-dev-hub", opts.devhubUsername);
  }
  return args;
}

export function buildScratchDeleteArgs(orgUsername: string): string[] {
  return ["org", "delete", "scratch", "--target-org", orgUsername, "--no-prompt"];
}

export interface RunTestsOptions {
  orgUsername: string;
  /** When set, run only these classes (RunSpecifiedTests); else use `level`. */
  classNames?: string[];
  level?: "RunLocalTests" | "RunAllTestsInOrg";
}

/**
 * Build `sf apex run test` argv. Human-readable result + code coverage so a
 * beginner sees pass/fail and % at a glance. Pure & unit-tested.
 */
export function buildRunTestsArgs(opts: RunTestsOptions): string[] {
  const args = [
    "apex",
    "run",
    "test",
    "--target-org",
    opts.orgUsername,
    "--result-format",
    "human",
    "--code-coverage",
    "--wait",
    "30",
  ];
  if (opts.classNames && opts.classNames.length > 0) {
    for (const c of opts.classNames) {
      args.push("--class-names", c);
    }
  } else {
    args.push("--test-level", opts.level || "RunLocalTests");
  }
  return args;
}

/** Curated metadata types shown in the retrieve picker (label + sf type name). */
export const COMMON_METADATA_TYPES: { label: string; type: string; detail: string }[] = [
  { label: "Apexクラス", type: "ApexClass", detail: "ApexClass" },
  { label: "Apexトリガ", type: "ApexTrigger", detail: "ApexTrigger" },
  { label: "Lightning Web Component", type: "LightningComponentBundle", detail: "LWC" },
  { label: "Auraコンポーネント", type: "AuraDefinitionBundle", detail: "Aura" },
  { label: "カスタムオブジェクト", type: "CustomObject", detail: "項目・オブジェクト" },
  { label: "フロー", type: "Flow", detail: "Flow" },
  { label: "権限セット", type: "PermissionSet", detail: "PermissionSet" },
  { label: "プロファイル", type: "Profile", detail: "Profile" },
  { label: "カスタム表示ラベル", type: "CustomLabels", detail: "CustomLabels" },
  { label: "静的リソース", type: "StaticResource", detail: "StaticResource" },
  { label: "ページレイアウト", type: "Layout", detail: "Layout" },
  { label: "カスタムタブ", type: "CustomTab", detail: "CustomTab" },
  { label: "カスタムアプリケーション", type: "CustomApplication", detail: "CustomApplication" },
  { label: "メールテンプレート", type: "EmailTemplate", detail: "EmailTemplate" },
];
