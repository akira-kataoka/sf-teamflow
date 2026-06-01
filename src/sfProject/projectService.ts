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

/* ------------------------------- Dev Hub -------------------------------- */
//
// A "Dev Hub" is not a special org you create from scratch — it is the Dev Hub
// *feature* toggled on inside an existing org (production / Developer Edition).
// A developer may enable it on as many authorised orgs as they like, so the
// extension treats Dev Hubs as a (possibly empty, possibly multiple) set and
// lets the user pick which one a scratch org is created against.

/** Salesforce Setup path for the Dev Hub enablement page. */
export const DEV_HUB_SETUP_PATH = "lightning/setup/DevHub/home";

/** Free Developer Edition signup — a fresh org on which Dev Hub can be enabled. */
export const DEVELOPER_EDITION_SIGNUP_URL = "https://developer.salesforce.com/signup";

/** Open an org's Dev Hub Setup page so the user can toggle the feature on. */
export function buildDevHubOpenArgs(orgUsername: string): string[] {
  return ["org", "open", "--target-org", orgUsername, "--path", DEV_HUB_SETUP_PATH];
}

/**
 * Probe query that only succeeds when Dev Hub is genuinely enabled — the
 * `ScratchOrgInfo` object is unavailable otherwise. Used to verify enablement
 * independently of the CLI's cached `isDevHub` flag (which can be stale when
 * Dev Hub is turned on *after* the org was authorised).
 */
export function buildScratchOrgInfoProbeArgs(orgUsername: string): string[] {
  return [
    "data",
    "query",
    "--query",
    "SELECT Id FROM ScratchOrgInfo LIMIT 1",
    "--target-org",
    orgUsername,
  ];
}

/** Register an org as the default Dev Hub for scratch-org creation. */
export function buildSetDefaultDevHubArgs(orgUsername: string): string[] {
  return ["config", "set", `target-dev-hub=${orgUsername}`];
}

/** Re-auth that refreshes the cached `isDevHub` flag and sets the default hub. */
export function buildDevHubLoginArgs(instanceUrl: string, alias?: string): string[] {
  const args = ["org", "login", "web", "--set-default-dev-hub", "--instance-url", instanceUrl];
  if (alias) {
    args.push("--alias", alias);
  }
  return args;
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

/**
 * Build `sf project deploy start` argv that pushes specific metadata TYPES
 * (rather than whole source dirs) — used when the user picks which assets to
 * deploy. Pure & unit-tested.
 */
export function buildDeployMetadataArgs(orgUsername: string, metadata: string[]): string[] {
  if (!metadata || metadata.length === 0) {
    throw new Error("反映する資材を1つ以上選択してください。");
  }
  const args = ["project", "deploy", "start", "--target-org", orgUsername];
  for (const m of metadata) {
    args.push("--metadata", m);
  }
  return args;
}

/**
 * Build `sf apex tail log` argv to stream debug logs (System.debug output) from
 * an org in real time — the "動かして確認する" step of the dev loop. Pure &
 * unit-tested.
 */
export function buildTailLogArgs(orgUsername: string): string[] {
  return ["apex", "tail", "log", "--target-org", orgUsername, "--color"];
}

export type ComponentKind = "apexClass" | "apexTrigger" | "lwc" | "aura";

/** Where each component kind is scaffolded, relative to a package directory. */
export function componentOutputDir(packageDir: string, kind: ComponentKind): string {
  const sub =
    kind === "apexClass"
      ? "classes"
      : kind === "apexTrigger"
      ? "triggers"
      : kind === "lwc"
      ? "lwc"
      : "aura";
  return `${packageDir.replace(/\/$/, "")}/main/default/${sub}`;
}

/**
 * Build `sf` argv to scaffold a new component (Apex class/trigger, LWC, Aura).
 * Pure & unit-tested.
 */
export function buildGenerateComponentArgs(
  kind: ComponentKind,
  name: string,
  outputDir: string,
  sobject?: string
): string[] {
  if (!name.trim()) {
    throw new Error("名前を入力してください。");
  }
  switch (kind) {
    case "apexClass":
      return ["apex", "generate", "class", "--name", name, "--output-dir", outputDir];
    case "apexTrigger": {
      const args = ["apex", "generate", "trigger", "--name", name, "--output-dir", outputDir];
      if (sobject) {
        args.push("--sobject", sobject);
      }
      return args;
    }
    case "lwc":
      return ["lightning", "generate", "component", "--name", name, "--type", "lwc", "--output-dir", outputDir];
    case "aura":
      return ["lightning", "generate", "component", "--name", name, "--type", "aura", "--output-dir", outputDir];
  }
}

/**
 * Apexトリガの対象オブジェクト（sObject）API名の妥当性を検証する（OKは undefined）。
 * 任意入力なので空は許容。非空なら英字始まりの英数字_（`Account` や `MyObject__c` 等）に限る。
 * sf CLI が後で弾くより前に、入力時点で分かりやすく止める。Pure & unit-tested.
 */
export function sobjectNameError(name: string): string | undefined {
  const v = (name || "").trim();
  if (!v) {
    return undefined; // 任意項目（空でトリガを作成できる）
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(v)) {
    return "オブジェクトのAPI名で入力してください（例: Account、MyObject__c）。記号・スペース・日本語は不可。空でもOK。";
  }
  return undefined;
}

/**
 * 新規プロジェクト名（＝作成されるフォルダ名）の妥当性を検証する（OKは undefined）。
 * 英数字始まりを必須にすることで、`..`（親ディレクトリに解決）や `.hidden`（隠しフォルダ）、
 * 先頭が記号の名前といった事故を入力時点で防ぐ。Pure & unit-tested.
 */
export function projectNameError(name: string): string | undefined {
  const v = (name || "").trim();
  if (!v) {
    return "プロジェクト名を入力してください（例: my-sf-project）。";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) {
    return "英数字で始まり、英数字と - _ . のみ使えます（例: my-sf-project）。スペース・日本語・先頭の記号は不可。";
  }
  return undefined;
}

/**
 * コンポーネント名の妥当性を種別ごとに検証し、NGなら日本語のエラー文を返す（OKは undefined）。
 * LWC は小文字始まりの camelCase（英数字のみ）、それ以外（Apex/Aura）は英字始まりの英数字_。
 * 加えて Salesforce の API 名上限（40文字）も検証する。
 * sf CLI が後で弾くより前に、入力時点で分かりやすく止める。Pure & unit-tested.
 */
export function componentNameError(name: string, kind: ComponentKind): string | undefined {
  const v = (name || "").trim();
  if (kind === "lwc") {
    if (!/^[a-z][A-Za-z0-9]*$/.test(v)) {
      return "小文字で始まる英数字（camelCase）で入力してください（例: accountSearch）。記号・アンダースコア・スペース・日本語は不可。";
    }
  } else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(v)) {
    return "英字で始まる英数字（_可）で入力してください（例: AccountService）。記号・スペース・日本語は不可。";
  }
  if (v.length > 40) {
    return "名前は40文字以内にしてください（Salesforceの上限）。";
  }
  return undefined;
}

/**
 * 「クラスを指定してテスト実行」のカンマ区切り入力を検証する。各トークンを Apex
 * クラス名として検証し、最初のNGに対する日本語メッセージを返す（全てOKは undefined）。
 * `.cls` 付き・日本語・記号などをCLIに渡す前に弾く。Pure & unit-tested.
 */
export function testClassNamesError(input: string): string | undefined {
  const names = (input || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    return "テストクラス名を入力してください（例: AccountServiceTest）。";
  }
  for (const n of names) {
    const err = componentNameError(n, "apexClass");
    if (err) {
      return `「${n}」: ${err}`;
    }
  }
  return undefined;
}

/**
 * Path (relative to the workspace root) of the primary editable file a scaffold
 * produces, so the command can open it right after creation — confirming to the
 * user that the file really exists. Pure & unit-tested.
 */
export function componentMainFile(outputDir: string, kind: ComponentKind, name: string): string {
  const dir = outputDir.replace(/\/$/, "");
  switch (kind) {
    case "apexClass":
      return `${dir}/${name}.cls`;
    case "apexTrigger":
      return `${dir}/${name}.trigger`;
    case "lwc":
      return `${dir}/${name}/${name}.js`;
    case "aura":
      return `${dir}/${name}/${name}.cmp`;
  }
}

/**
 * Suggested scratch-org alias for a feature branch, so「1機能=1ブランチ=1スクラッチ」
 * を名前で結びつけられる。`feature/account-search` → `scr-account-search`。
 * 非ASCII（日本語ブランチ名など）は除去し、空になれば `scr-feature` にフォールバック。
 * Pure & unit-tested.
 */
export function scratchAliasForBranch(branch: string): string {
  const base = branch.replace(/^[^/]+\//, ""); // 先頭の "feature/" 等を落とす
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return "scr-" + (slug || "feature");
}

/**
 * GitHub Flow で「本番(main)へ直接マージするのが筋」のブランチか。
 * `release/*`・`hotfix/*` が該当。PR のマージ先のおすすめ判定に使う。Pure & unit-tested.
 */
export function isReleaseLikeBranch(branch: string): boolean {
  return /^(release|hotfix)\//.test(branch || "");
}

/**
 * PR のマージ先候補を GitHub Flow に沿って並べる。
 * `release/*`・`hotfix/*` からは `main` を優先、それ以外（feature 等）は `develop` を優先。
 * develop/main は標準名なので常に候補に含め、残りの既存ブランチを後ろに付ける（current は除外・重複排除）。
 * Pure & unit-tested.
 */
export function prBaseCandidates(current: string, branches: string[]): string[] {
  const head = isReleaseLikeBranch(current) ? ["main", "develop"] : ["develop", "main"];
  const rest = branches.filter((b) => b && b !== current && b !== "develop" && b !== "main");
  return [...new Set([...head, ...rest])];
}

export interface PullRequestOptions {
  baseBranch: string;
  /** Open the PR form in the browser (true) or create non-interactively. */
  web?: boolean;
}

/** Build `gh pr create` argv. `--fill` pre-populates title/body from commits. */
export function buildPullRequestArgs(opts: PullRequestOptions): string[] {
  const args = ["pr", "create", "--base", opts.baseBranch, "--fill"];
  if (opts.web) {
    args.push("--web");
  }
  return args;
}

/** Curated metadata types shown in the retrieve / deploy pickers. */
export const COMMON_METADATA_TYPES: { label: string; type: string; detail: string }[] = [
  // --- コード ---
  { label: "Apexクラス", type: "ApexClass", detail: "コード" },
  { label: "Apexトリガ", type: "ApexTrigger", detail: "コード" },
  { label: "Lightning Web Component", type: "LightningComponentBundle", detail: "コード(LWC)" },
  { label: "Auraコンポーネント", type: "AuraDefinitionBundle", detail: "コード(Aura)" },
  { label: "Visualforceページ", type: "ApexPage", detail: "コード(VF)" },
  { label: "Visualforceコンポーネント", type: "ApexComponent", detail: "コード(VF)" },
  { label: "静的リソース", type: "StaticResource", detail: "コード" },
  // --- データモデル ---
  { label: "カスタムオブジェクト/項目", type: "CustomObject", detail: "データモデル" },
  { label: "カスタムメタデータ型", type: "CustomMetadata", detail: "データモデル" },
  { label: "カスタム設定", type: "CustomSetting__c", detail: "データモデル" },
  { label: "レコードタイプ", type: "RecordType", detail: "データモデル" },
  { label: "入力規則", type: "ValidationRule", detail: "データモデル" },
  { label: "数式/項目セット", type: "FieldSet", detail: "データモデル" },
  { label: "グローバル選択リスト", type: "GlobalValueSet", detail: "データモデル" },
  // --- 自動化 ---
  { label: "フロー", type: "Flow", detail: "自動化" },
  { label: "フロー定義", type: "FlowDefinition", detail: "自動化" },
  { label: "ワークフロー", type: "Workflow", detail: "自動化" },
  { label: "承認プロセス", type: "ApprovalProcess", detail: "自動化" },
  { label: "アサインメントルール", type: "AssignmentRules", detail: "自動化" },
  // --- UI ---
  { label: "ページレイアウト", type: "Layout", detail: "UI" },
  { label: "Lightningページ", type: "FlexiPage", detail: "UI" },
  { label: "カスタムタブ", type: "CustomTab", detail: "UI" },
  { label: "カスタムアプリケーション", type: "CustomApplication", detail: "UI" },
  { label: "クイックアクション", type: "QuickAction", detail: "UI" },
  { label: "リストビュー", type: "ListView", detail: "UI" },
  { label: "ホームページコンポーネント", type: "HomePageComponent", detail: "UI" },
  // --- セキュリティ ---
  { label: "権限セット", type: "PermissionSet", detail: "セキュリティ" },
  { label: "権限セットグループ", type: "PermissionSetGroup", detail: "セキュリティ" },
  { label: "プロファイル", type: "Profile", detail: "セキュリティ" },
  { label: "ロール", type: "Role", detail: "セキュリティ" },
  { label: "共有ルール", type: "SharingRules", detail: "セキュリティ" },
  // --- その他 ---
  { label: "カスタム表示ラベル", type: "CustomLabels", detail: "その他" },
  { label: "メールテンプレート", type: "EmailTemplate", detail: "その他" },
  { label: "レポート", type: "Report", detail: "その他" },
  { label: "ダッシュボード", type: "Dashboard", detail: "その他" },
  { label: "リモートサイト設定", type: "RemoteSiteSetting", detail: "その他" },
  { label: "名前付き資格情報", type: "NamedCredential", detail: "その他" },
  { label: "接続アプリケーション", type: "ConnectedApp", detail: "その他" },
  { label: "カスタム通知タイプ", type: "CustomNotificationType", detail: "その他" },
  { label: "翻訳", type: "Translations", detail: "その他" },
];
