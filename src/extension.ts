import * as vscode from "vscode";
import { logger } from "./util/logger.js";
import { run } from "./util/exec.js";
import { runSf, parseSfVersion, isSfVersionOutdated } from "./util/cli.js";
import { OrgTreeProvider, type TreeNode } from "./orgManager/orgTreeProvider.js";
import type { OrgInfo } from "./orgManager/orgService.js";
import { orgCategoryLabel } from "./orgManager/orgService.js";
import * as path from "node:path";
import { promises as fsp } from "node:fs";
import {
  changedFiles,
  resolveBaseRef,
  classifyChanges,
  currentBranch,
  isGitRepo,
  hasRemote,
  status,
  uncommittedInList,
} from "./deploy/gitService.js";
import {
  buildDeployArgs,
  renderCommand,
  deployConfirmKind,
  testLevelLabel,
} from "./deploy/deployService.js";
import {
  baseRefFor,
  defaultConfig,
  matchBranch,
  resolveEnvironment,
  testLevelFor,
  unauthedConfigAliases,
  type TeamflowConfig,
} from "./config/teamflowConfig.js";
import {
  CONFIG_FILENAME,
  configExists,
  configPath,
  loadConfig,
  readSfdxPackageDirs,
  saveConfig,
} from "./config/configStore.js";
import {
  cicdFiles,
  consumerKeyError,
  envSlugCollisions,
  integrationUsernameError,
  loginUrlError,
  secretPrefix,
} from "./cicd/templates.js";
import { writeScaffold } from "./cicd/scaffolder.js";
import { schemaJson } from "./config/schema.js";
import { registerGitCommands } from "./git/gitCommands.js";
import { registerProjectCommands } from "./sfProject/projectCommands.js";
import { BASELINE_FORCEIGNORE, shouldWriteBaselineForceignore } from "./sfProject/projectService.js";
import { StatusBar } from "./statusBar.js";
import type { CommandContext } from "./commandContext.js";
import { TEAM_WORKFLOW_GUIDE } from "./docs/workflowGuide.js";
import { HomeViewProvider } from "./webview/homeView.js";
import { SetupWizard } from "./webview/setupWizard.js";
import { ActivityLog, type ActivityStatus } from "./activityLog.js";

let orgTree: OrgTreeProvider;
let statusBar: StatusBar;
let homeView: HomeViewProvider;
let setupWizard: SetupWizard;
let activity: ActivityLog;
let deployTerminal: vscode.Terminal | undefined;

function recordActivity(label: string, status: ActivityStatus): void {
  activity?.record(label, status, Date.now());
  void homeView?.postState();
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cliPath(): string {
  return vscode.workspace.getConfiguration("teamflow").get<string>("sfCliPath", "sf") || "sf";
}

/**
 * 古い sf CLI は「Missing message ... Finalizing」等の不可解なクラッシュを起こすため、
 * 起動時に一度だけ検知して更新を促す。同じバージョンでは二度警告しない（naggyにしない）。
 */
async function warnIfSfOutdated(context: vscode.ExtensionContext): Promise<void> {
  try {
    const res = await run(cliPath(), ["--version"], { timeout: 15_000 });
    const out = `${res.stdout}\n${res.stderr}`;
    if (res.code !== 0 || !isSfVersionOutdated(out)) {
      return;
    }
    const v = parseSfVersion(out);
    const verStr = v ? `${v.major}.${v.minor}.${v.patch}` : "unknown";
    const KEY = "teamflow.lastSfVersionWarned";
    if (context.globalState.get<string>(KEY) === verStr) {
      return; // 同じ古いバージョンでは繰り返さない
    }
    void context.globalState.update(KEY, verStr);
    const pick = await vscode.window.showWarningMessage(
      `Salesforce CLI (sf) が古い可能性があります（${verStr}）。デプロイ時の不可解なエラー（"Finalizing" クラッシュ等）の原因になります。ターミナルで \`sf update\` を実行して更新を推奨します。`,
      "更新方法を開く"
    );
    if (pick === "更新方法を開く") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://developer.salesforce.com/tools/salesforcecli")
      );
    }
  } catch {
    /* バージョン確認は補助的なもの。失敗しても無視。 */
  }
}

function requireRoot(): string | undefined {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage("Salesforce Dev Manager: ワークスペース(フォルダ)を開いてください。");
  }
  return root;
}

function runInTerminal(command: string): void {
  if (!deployTerminal || deployTerminal.exitStatus !== undefined) {
    deployTerminal = vscode.window.createTerminal({ name: "Salesforce Dev Manager", cwd: workspaceRoot() });
  }
  deployTerminal.show(true);
  deployTerminal.sendText(command);
}

function refreshAll(): void {
  orgTree.refresh();
  void statusBar.update(workspaceRoot(), orgTree.knownOrgs);
  void homeView?.postState();
}

export function activate(context: vscode.ExtensionContext): void {
  logger.info(`Salesforce Dev Manager activated (cli=${cliPath()})`);
  void warnIfSfOutdated(context);

  orgTree = new OrgTreeProvider(cliPath, workspaceRoot);
  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);
  activity = new ActivityLog(context.globalState);
  homeView = new HomeViewProvider(
    context.extensionUri,
    orgTree,
    workspaceRoot,
    cliPath,
    refreshAll,
    () => activity.all()
  );
  setupWizard = new SetupWizard(context.extensionUri, orgTree, workspaceRoot, refreshAll);

  // Consolidated to two surfaces: the rich Home webview (primary) and the Org
  // detail tree (power right-click ops). The former Environments / Git trees
  // were redundant with Home and have been retired to reduce confusion.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HomeViewProvider.viewType, homeView),
    vscode.window.registerTreeDataProvider("teamflow.orgs", orgTree)
  );

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("teamflow.showLog", () => logger.show());

  register("teamflow.refreshOrgs", () => refreshAll());

  register("teamflow.authorizeOrg", () => void authorizeOrg());

  register("teamflow.setDefaultOrg", (node?: TreeNode) => setDefaultOrg(node));
  register("teamflow.openOrg", (node?: TreeNode) => openOrg(node));
  register("teamflow.openOrgByName", (username?: string) => openOrgByUsername(username));
  register("teamflow.reconnectOrg", (arg?: string | TreeNode) => reconnectOrg(arg));
  register("teamflow.logoutOrg", (node?: TreeNode) => logoutOrg(node));
  register("teamflow.copyOrgId", (node?: TreeNode) => copyOrgId(node));

  register("teamflow.deployDiff", () => deployOrValidate(false));
  register("teamflow.validateDiff", () => deployOrValidate(true));
  register("teamflow.previewDiff", () => previewDiff());
  register("teamflow.deployToEnvironment", () => deployToEnvironment());

  register("teamflow.scaffoldCICD", () => scaffoldCICD());
  register("teamflow.setupCicdSecrets", () => setupCicdSecrets());
  register("teamflow.initTeamProject", () => initTeamProject());
  register("teamflow.openConfig", () => openConfig());
  register("teamflow.openWorkflowGuide", () => openWorkflowGuide());
  register("teamflow.openActions", () => openGitHubActions());
  register("teamflow.setupWizard", () => setupWizard.open());
  register("teamflow.quickSettings", () => quickSettings());

  // Git and project/metadata commands live in their own modules.
  const ctx: CommandContext = {
    cliPath,
    workspaceRoot,
    runInTerminal,
    refreshAll,
    knownOrgs: () => orgTree.knownOrgs,
    recordActivity,
  };
  registerGitCommands(context, ctx);
  registerProjectCommands(context, ctx);

  // Prime the status bar and refresh it when the active editor / config changes.
  void statusBar.update(workspaceRoot(), orgTree.knownOrgs);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() =>
      statusBar.update(workspaceRoot(), orgTree.knownOrgs)
    )
  );
}

export function deactivate(): void {
  logger.dispose();
}

/** Quick toggles for the most-used settings, from the home title gear. */
async function quickSettings(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("teamflow");
  const target = vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  const level = cfg.get<string>("deploy.testLevel", "RunLocalTests");
  const confirmProd = cfg.get<boolean>("confirmProductionDeploy", true);
  const baseRef = cfg.get<string>("deploy.baseRef", "origin/main");
  const cliPathVal = cfg.get<string>("sfCliPath", "sf");

  const pick = await vscode.window.showQuickPick(
    [
      { label: "🧪 デプロイ時のテストレベル", description: level, detail: "デプロイ/検証で走らせるApexテストの範囲", action: "level" },
      {
        label: "🛑 本番デプロイ前の確認",
        description: confirmProd ? "ON（推奨）" : "OFF",
        detail: "本番環境へ送る前に確認ダイアログを出す",
        action: "confirm",
      },
      { label: "📐 差分の基準ブランチ", description: baseRef, detail: "「環境へデプロイ」で何との差分を送るかの基準", action: "baseref" },
      { label: "🔧 sf CLI のパス", description: cliPathVal, detail: "sf が PATH に無いときに実行パスを指定", action: "clipath" },
      { label: "🗂️ チーム設定 (sf-teamflow.json) を開く", detail: "環境とブランチの対応を直接編集", action: "openconfig" },
      { label: "⚙️ VSCode設定で詳しく開く", detail: "teamflow のすべての設定を一覧で", action: "vscode" },
    ],
    { title: "Salesforce Dev Manager 設定" }
  );
  if (!pick) {
    return;
  }
  if (pick.action === "level") {
    const lv = await vscode.window.showQuickPick(
      [
        { label: "RunLocalTests", description: "自環境のローカルテスト（推奨）" },
        { label: "NoTestRun", description: "テストを実行しない（速いが本番不可）" },
        { label: "RunAllTestsInOrg", description: "全テスト（時間がかかる）" },
      ],
      { title: "デプロイ時のテストレベル" }
    );
    if (lv) {
      await cfg.update("deploy.testLevel", lv.label, target);
      vscode.window.showInformationMessage(`テストレベルを ${lv.label} にしました。`);
    }
  } else if (pick.action === "confirm") {
    await cfg.update("confirmProductionDeploy", !confirmProd, target);
    vscode.window.showInformationMessage(
      `本番デプロイ前の確認を ${!confirmProd ? "ON" : "OFF"} にしました。`
    );
  } else if (pick.action === "baseref") {
    const v = await vscode.window.showInputBox({
      title: "差分の基準ブランチ",
      prompt: "例: origin/main, develop（sf-teamflow.json の環境設定があればそちらが優先）",
      value: baseRef,
    });
    if (v && v.trim()) {
      await cfg.update("deploy.baseRef", v.trim(), target);
      vscode.window.showInformationMessage(`基準ブランチを ${v.trim()} にしました。`);
    }
  } else if (pick.action === "clipath") {
    const v = await vscode.window.showInputBox({
      title: "sf CLI のパス",
      prompt: "PATH が通っていれば sf のままでOK。通っていない場合は実行ファイルの絶対パスを指定",
      value: cliPathVal,
    });
    if (v && v.trim()) {
      await cfg.update("sfCliPath", v.trim(), target);
      vscode.window.showInformationMessage(`sf CLI のパスを ${v.trim()} にしました。`);
    }
  } else if (pick.action === "openconfig") {
    await vscode.commands.executeCommand("teamflow.openConfig");
    return;
  } else if (pick.action === "vscode") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "teamflow");
    return;
  }
  refreshAll();
}

/** GitHub Actions（CI/CDの実行状況）をブラウザで開く。生成したCIの結果確認の近道。 */
async function openGitHubActions(): Promise<void> {
  const root = requireRoot();
  if (!root) {
    return;
  }
  if (!(await isGitRepo(root)) || !(await hasRemote(root))) {
    vscode.window.showInformationMessage(
      "先に「🐙 GitHubに接続」してください（GitHub上の実行状況ページを開きます）。"
    );
    return;
  }
  const url = await run("gh", ["repo", "view", "--json", "url", "-q", ".url"], {
    cwd: root,
    timeout: 15_000,
  });
  const repoUrl = url.code === 0 ? url.stdout.trim() : "";
  if (!repoUrl) {
    vscode.window.showErrorMessage(
      "リポジトリURLを取得できませんでした（GitHub CLI のログインを確認してください）。"
    );
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(`${repoUrl}/actions`));
}

async function openWorkflowGuide(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: TEAM_WORKFLOW_GUIDE,
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: true });
  await vscode.commands.executeCommand("markdown.showPreview", doc.uri).then(undefined, () => {
    /* preview extension may be unavailable */
  });
}

/* ------------------------------- org commands ----------------------------- */

async function resolveOrgFromNode(node?: TreeNode): Promise<OrgInfo | undefined> {
  if (node?.org) {
    return node.org;
  }
  const orgs = orgTree.knownOrgs;
  if (orgs.length === 0) {
    vscode.window.showInformationMessage("認証済みの環境がありません。");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    orgs.map((o) => ({
      label: `${o.isDefaultUsername ? "★ " : ""}${o.displayName}`,
      description: `${orgCategoryLabel(o.category)}${o.isProduction ? " ⚠️本番" : ""}`,
      detail: o.username,
      org: o,
    })),
    { placeHolder: "環境を選択", matchOnDetail: true, matchOnDescription: true }
  );
  return pick?.org;
}

async function setDefaultOrg(node?: TreeNode): Promise<void> {
  const org = await resolveOrgFromNode(node);
  if (!org) {
    return;
  }
  try {
    await runSf(["config", "set", `target-org=${org.username}`], {
      cliPath: cliPath(),
      cwd: workspaceRoot(),
    });
    vscode.window.showInformationMessage(`既定の環境を ${org.displayName} に設定しました。`);
    refreshAll();
  } catch (err) {
    logger.error("既定の環境設定に失敗", err);
    vscode.window.showErrorMessage(`既定の環境設定に失敗: ${String(err)}`);
  }
}

async function openOrg(node?: TreeNode): Promise<void> {
  const org = await resolveOrgFromNode(node);
  if (!org) {
    return;
  }
  const res = await run(cliPath(), ["org", "open", "--target-org", org.username], {
    cwd: workspaceRoot(),
    timeout: 30_000,
  });
  if (res.code !== 0) {
    logger.error(`org open 失敗: ${res.stderr || res.stdout}`);
    vscode.window.showErrorMessage(`環境を開けませんでした: ${org.displayName}`);
  }
}

async function reconnectOrg(arg?: string | TreeNode): Promise<void> {
  // Invoked from the webview (username string) or the tree menu (TreeNode).
  let org: OrgInfo | undefined;
  if (typeof arg === "string") {
    org = orgTree.knownOrgs.find((o) => o.username === arg);
  } else if (arg && typeof arg === "object" && "org" in arg && arg.org) {
    org = arg.org;
  } else {
    org = await resolveOrgFromNode();
  }
  if (!org) {
    return;
  }
  // Re-run the web login against the org's own host so the browser lands on the
  // right login page; keep the alias so it reconnects in place.
  const url = org.instanceUrl || org.loginUrl || "https://login.salesforce.com";
  const args = ["org", "login", "web", "--instance-url", url];
  if (org.alias) {
    args.push("--alias", org.alias);
  }
  runInTerminal(renderCommand(cliPath(), args));
  vscode.window.showInformationMessage(
    `${org.displayName} に再接続します。ブラウザでログイン後、「環境一覧を更新」してください。`
  );
}

async function openOrgByUsername(username?: string): Promise<void> {
  if (!username) {
    return;
  }
  const res = await run(cliPath(), ["org", "open", "--target-org", username], {
    cwd: workspaceRoot(),
    timeout: 30_000,
  });
  if (res.code !== 0) {
    logger.error(`org open 失敗: ${res.stderr || res.stdout}`);
    vscode.window.showErrorMessage("環境を開けませんでした。");
  }
}

async function logoutOrg(node?: TreeNode): Promise<void> {
  const org = await resolveOrgFromNode(node);
  if (!org) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `${org.displayName} の認証を解除しますか？`,
    { modal: true },
    "解除する"
  );
  if (confirm !== "解除する") {
    return;
  }
  try {
    await runSf(["org", "logout", "--target-org", org.username, "--no-prompt"], {
      cliPath: cliPath(),
      cwd: workspaceRoot(),
    });
    vscode.window.showInformationMessage(`${org.displayName} の認証を解除しました。`);
    refreshAll();
  } catch (err) {
    logger.error("logout 失敗", err);
    vscode.window.showErrorMessage(`認証解除に失敗: ${String(err)}`);
  }
}

async function copyOrgId(node?: TreeNode): Promise<void> {
  const org = await resolveOrgFromNode(node);
  if (!org?.orgId) {
    return;
  }
  await vscode.env.clipboard.writeText(org.orgId);
  vscode.window.showInformationMessage(`組織ID をコピーしました: ${org.orgId}`);
}

/* ------------------------------ deploy commands --------------------------- */

interface DeployContext {
  root: string;
  config?: TeamflowConfig;
  branch: string;
  baseRef: string;
  orgAlias: string;
  orgUsername: string;
  isProduction: boolean;
  /** 環境が sf-teamflow.json で「検証必須」に設定されているか。 */
  requireValidation?: boolean;
  testLevel: TeamflowConfig["testLevel"];
  packageDirs: string[];
}

async function buildDeployContext(): Promise<DeployContext | undefined> {
  const root = requireRoot();
  if (!root) {
    return undefined;
  }
  if (!(await isGitRepo(root))) {
    vscode.window.showErrorMessage("Salesforce Dev Manager: Gitリポジトリではありません。");
    return undefined;
  }

  let config: TeamflowConfig | undefined;
  try {
    config = await loadConfig(root);
  } catch (err) {
    vscode.window.showErrorMessage(`sf-teamflow.json が不正です: ${String(err)}`);
    return undefined;
  }

  const branch = await currentBranch(root);
  const env = config ? resolveEnvironment(config, branch) : undefined;
  const settings = vscode.workspace.getConfiguration("teamflow");

  const baseRef = config
    ? baseRefFor(config, env)
    : settings.get<string>("deploy.baseRef", "origin/main");

  const packageDirs = config?.packageDirectories ?? (await readSfdxPackageDirs(root));
  const testLevel = config
    ? testLevelFor(config, env)
    : (settings.get<string>("deploy.testLevel", "RunLocalTests") as TeamflowConfig["testLevel"]);

  // Resolve which org to deploy to.
  let orgUsername: string | undefined;
  let orgAlias: string | undefined;
  const orgs = orgTree.knownOrgs;
  if (env) {
    const match = orgs.find((o) => o.alias === env.orgAlias || o.username === env.orgAlias);
    orgAlias = env.orgAlias;
    orgUsername = match?.username ?? env.orgAlias;
  } else {
    const def = orgs.find((o) => o.isDefaultUsername);
    if (def) {
      orgAlias = def.displayName;
      orgUsername = def.username;
    } else {
      const picked = await resolveOrgFromNode();
      if (!picked) {
        return undefined;
      }
      orgAlias = picked.displayName;
      orgUsername = picked.username;
    }
  }

  const matchedOrg = orgs.find((o) => o.username === orgUsername || o.alias === orgAlias);
  const isProduction = matchedOrg?.isProduction ?? env?.type === "production";

  return {
    root,
    config,
    branch,
    baseRef,
    orgAlias: orgAlias ?? orgUsername!,
    orgUsername: orgUsername!,
    isProduction,
    requireValidation: env?.requireValidation === true,
    testLevel,
    packageDirs,
  };
}

async function computeChangeSet(ctx: DeployContext) {
  const entries = await changedFiles(ctx.baseRef, ctx.root);
  return classifyChanges(entries, ctx.packageDirs);
}

async function previewDiff(): Promise<void> {
  const ctx = await buildDeployContext();
  if (!ctx) {
    return;
  }
  const cs = await computeChangeSet(ctx);
  // executeDeploy と同様、設定値が無効でも実際に diff に使われた基準refを表示する。
  const usedBase = (await resolveBaseRef(ctx.baseRef, ctx.root)) ?? ctx.baseRef;
  logger.show();
  logger.info("──────── デプロイ差分プレビュー ────────");
  logger.info(`ブランチ: ${ctx.branch} / 基準: ${usedBase} / 対象Org: ${ctx.orgAlias}`);
  logger.info(`デプロイ対象 (${cs.toDeploy.length}件):`);
  cs.toDeploy.forEach((f) => logger.info(`  + ${f}`));
  if (cs.toDelete.length) {
    logger.info(`削除候補 (${cs.toDelete.length}件・自動削除しません):`);
    cs.toDelete.forEach((f) => logger.info(`  - ${f}`));
  }
  if (cs.ignored.length) {
    logger.info(`パッケージ外のため無視 (${cs.ignored.length}件)`);
  }
  // 変更はあるが全てパッケージ外のときは、その旨を補足して混乱を防ぐ（executeDeployと同じ方針）。
  const extra =
    cs.toDeploy.length === 0 && cs.ignored.length
      ? ` 変更 ${cs.ignored.length}件はパッケージ外(README等)のみです。`
      : "";
  vscode.window.showInformationMessage(
    `差分: デプロイ ${cs.toDeploy.length}件 / 削除候補 ${cs.toDelete.length}件 (詳細は出力パネル)。${extra}`
  );
}

async function deployOrValidate(validateOnly: boolean): Promise<void> {
  const ctx = await buildDeployContext();
  if (!ctx) {
    return;
  }
  await executeDeploy(ctx, validateOnly);
}

/**
 * 環境を認証（ブラウザログイン）。チーム設定がある場合は、まだ認証されていない
 * 接続先(orgAlias)を候補として提示し、選んだ別名で `--alias` 付き認証する。これにより
 * チームメンバーの認証が sf-teamflow.json の接続先に一致し、環境が正しく解決される
 * （別名なしだとユーザー名のままで環境に紐づかない）。
 */
async function authorizeOrg(): Promise<void> {
  let alias: string | undefined;
  const root = workspaceRoot();
  if (root) {
    let cfg: TeamflowConfig | undefined;
    try {
      cfg = await loadConfig(root);
    } catch {
      /* 設定が不正でも認証自体は続行 */
    }
    if (cfg) {
      // Org一覧が未ロードだと既認証の接続先まで「未認証」と誤判定するため、先に確実に読み込む。
      const loadedOrgs = await orgTree.ensureOrgsLoaded().catch(() => orgTree.knownOrgs);
      const knownAliases = loadedOrgs.flatMap((o) =>
        [o.alias, o.username].filter((x): x is string => !!x)
      );
      const pending = unauthedConfigAliases(cfg, knownAliases);
      if (pending.length > 0) {
        const CUSTOM = "$(pencil) 別名を自分で入力…";
        const NONE = "$(circle-slash) 別名なしで認証";
        const pick = await vscode.window.showQuickPick(
          [
            ...pending.map((a) => ({
              label: `$(plug) ${a}`,
              detail: `チーム設定の接続先「${a}」として認証（環境に紐づきます）`,
              value: a,
            })),
            { label: CUSTOM, detail: "任意の別名を付ける", value: CUSTOM },
            { label: NONE, detail: "別名を付けずにログイン", value: NONE },
          ],
          {
            title: "どの接続先として認証しますか？",
            placeHolder: "チーム設定(sf-teamflow.json)の未認証の接続先",
          }
        );
        if (!pick) {
          return;
        }
        if (pick.value === CUSTOM) {
          const v = await vscode.window.showInputBox({
            title: "別名（alias）",
            prompt: "この環境を呼ぶ短い名前（例: uat, prod）",
            validateInput: (s) =>
              /^[A-Za-z0-9._-]+$/.test(s.trim()) || s.trim() === ""
                ? undefined
                : "英数字と . - _ のみ使えます（スペース・日本語は不可）。",
          });
          alias = v?.trim() || undefined;
        } else if (pick.value !== NONE) {
          alias = pick.value;
        }
      }
    }
  }
  const args = ["org", "login", "web"];
  if (alias) {
    args.push("--alias", alias);
  }
  runInTerminal(renderCommand(cliPath(), args));
  vscode.window.showInformationMessage(
    alias
      ? `ブラウザでログインしてください（接続先「${alias}」として認証）。完了後、環境一覧を更新します。`
      : "ブラウザでログインしてください。完了後、環境一覧を更新します。"
  );
}

/**
 * Deploy the Git diff to a chosen environment (development → staging →
 * production). Lets a developer promote a change through environments from one
 * place, instead of switching the default org by hand.
 */
async function deployToEnvironment(): Promise<void> {
  const root = requireRoot();
  if (!root) {
    return;
  }
  if (!(await isGitRepo(root))) {
    vscode.window.showErrorMessage("Gitリポジトリではありません。先に変更を保存してください。");
    return;
  }
  let config: TeamflowConfig | undefined;
  try {
    config = await loadConfig(root);
  } catch (err) {
    vscode.window.showErrorMessage(`sf-teamflow.json が不正です: ${String(err)}`);
    return;
  }
  if (!config || config.environments.length === 0) {
    const go = await vscode.window.showInformationMessage(
      "環境が未設定です。セットアップウィザードで開発/ステージング/本番を設定しますか？",
      "設定する"
    );
    if (go === "設定する") {
      await vscode.commands.executeCommand("teamflow.setupWizard");
    }
    return;
  }

  const orgs = orgTree.knownOrgs;
  const TYPE_EMOJI: Record<string, string> = {
    development: "🛠️",
    staging: "🧪",
    production: "🛡️",
    sandbox: "🧪",
    dev: "🛠️",
  };
  const pick = await vscode.window.showQuickPick(
    config.environments.map((e) => {
      const matched = orgs.find((o) => o.alias === e.orgAlias || o.username === e.orgAlias);
      const emoji = TYPE_EMOJI[e.name.toLowerCase()] ?? TYPE_EMOJI[e.type] ?? "☁️";
      return {
        label: `${emoji} ${e.name}`,
        description: `${e.orgAlias}${e.type === "production" ? " ⚠️本番" : ""}${
          matched ? "" : " ❌未認証"
        }`,
        detail: `ブランチ ${e.branch}`,
        env: e,
      };
    }),
    { title: "どの環境へデプロイしますか？（開発 → ステージング → 本番）", placeHolder: "デプロイ先の環境を選択" }
  );
  if (!pick) {
    return;
  }
  const env = pick.env;
  const matched = orgs.find((o) => o.alias === env.orgAlias || o.username === env.orgAlias);
  if (!matched) {
    const go = await vscode.window.showWarningMessage(
      `環境「${env.name}」の接続先「${env.orgAlias}」は未認証です。認証しますか？`,
      "環境を認証"
    );
    if (go === "環境を認証") {
      await vscode.commands.executeCommand("teamflow.authorizeOrg");
    }
    return;
  }

  // GitHub Flow 安全策: 今いるブランチが環境の想定ブランチと食い違う場合は注意喚起（不一致時のみ）。
  // 例: feature/* のまま本番(main)へ反映＝レビュー/CIを迂回してしまう。続行は可能。
  const current = await currentBranch(root).catch(() => "");
  if (current && !matchBranch(env.branch, current)) {
    const proceed = env.type === "production" ? "本番に反映する" : "このまま反映する";
    const ans = await vscode.window.showWarningMessage(
      `現在のブランチ「${current}」は環境「${env.name}」の想定ブランチ（${env.branch}）と一致しません。`,
      {
        modal: true,
        detail:
          `通常は ${env.branch} に取り込んでから反映します（レビューやCIを通すため）。\n` +
          "今いるブランチの内容をそのまま反映しますか？",
      },
      proceed
    );
    if (ans !== proceed) {
      return;
    }
  }

  const ctx: DeployContext = {
    root,
    config,
    branch: `→ ${env.name}`,
    baseRef: baseRefFor(config, env),
    orgAlias: matched.displayName,
    orgUsername: matched.username,
    isProduction: matched.isProduction || env.type === "production",
    requireValidation: env.requireValidation === true,
    testLevel: testLevelFor(config, env),
    packageDirs: config.packageDirectories,
  };
  await executeDeploy(ctx, false);
}

async function executeDeploy(ctx: DeployContext, validateOnly: boolean): Promise<void> {
  const cs = await computeChangeSet(ctx);
  // 実際に diff に使われた基準ref（設定値が無ければ origin/master 等にフォールバック）を表示する。
  const usedBase = (await resolveBaseRef(ctx.baseRef, ctx.root)) ?? ctx.baseRef;
  if (cs.toDeploy.length === 0) {
    // 変更自体はあるがすべてパッケージ外(README等)のときは、その旨を補足して混乱を防ぐ。
    const extra = cs.ignored.length
      ? ` 変更 ${cs.ignored.length}件はパッケージ外(README等)のため対象外です。`
      : "";
    vscode.window.showInformationMessage(
      `デプロイ対象の差分がありません (基準: ${usedBase})。${extra}`
    );
    return;
  }

  const verb = validateOnly ? "検証" : "デプロイ";
  const detailLines = [
    `対象Org: ${ctx.orgAlias}${ctx.isProduction ? " ⚠️ 本番環境" : ""}`,
    `ブランチ: ${ctx.branch} (基準 ${usedBase})`,
    `テストレベル: ${testLevelLabel(ctx.testLevel)}`,
  ];
  // Show exactly which files will be sent so the user can confirm before acting.
  const MAX_LIST = 25;
  detailLines.push("", `── 対象ファイル ${cs.toDeploy.length}件 ──`);
  for (const f of cs.toDeploy.slice(0, MAX_LIST)) {
    detailLines.push(`• ${f}`);
  }
  if (cs.toDeploy.length > MAX_LIST) {
    detailLines.push(`…他 ${cs.toDeploy.length - MAX_LIST} 件`);
  }
  // 削除はこの操作に含まれない。どのファイルが対象外かを明示（黙って無視しない）。
  if (cs.toDelete.length) {
    detailLines.push("", `── 削除（この操作には含まれません）${cs.toDelete.length}件 ──`);
    for (const f of cs.toDelete.slice(0, MAX_LIST)) {
      detailLines.push(`✗ ${f}`);
    }
    if (cs.toDelete.length > MAX_LIST) {
      detailLines.push(`…他 ${cs.toDelete.length - MAX_LIST} 件`);
    }
    detailLines.push("（削除の反映は別途 destructiveChanges が必要です）");
  }

  // デプロイは未コミット/未追跡の変更も含む。対象に未バックアップのものがあれば明示し、
  // 「コミットせず反映してしまう」事故（特に本番）を防ぐ。黙って含めない。
  try {
    const st = await status(ctx.root);
    const uncommitted = uncommittedInList(cs.toDeploy, st.files.map((f) => f.path));
    if (uncommitted.length) {
      detailLines.push(
        "",
        `⚠️ うち ${uncommitted.length}件は未コミット（未バックアップ）です。この内容もそのまま反映されます。`,
        "　確実に残すなら、いったんキャンセルして「💾 バックアップ」してからの反映がおすすめです。"
      );
    }
  } catch {
    /* status 取得に失敗しても確認自体は続行（情報行を出せないだけ） */
  }

  const confirmProd = vscode.workspace
    .getConfiguration("teamflow")
    .get<boolean>("confirmProductionDeploy", true);
  const kind = deployConfirmKind({
    validateOnly,
    isProduction: ctx.isProduction,
    confirmProduction: confirmProd,
    requireValidation: ctx.requireValidation === true,
  });
  if (kind === "production") {
    // Safety: offer to dry-run (validate) first before touching production.
    const VALIDATE = "先に検証する（おすすめ）";
    const DEPLOY = "本番にデプロイする";
    const ok = await vscode.window.showWarningMessage(
      `🛑 本番環境「${ctx.orgAlias}」へデプロイします。まず検証(お試し)で安全確認するのがおすすめです。`,
      { modal: true, detail: detailLines.join("\n") },
      VALIDATE,
      DEPLOY
    );
    if (ok === VALIDATE) {
      launchDeploy(ctx, true, cs.toDeploy);
      return;
    }
    if (ok !== DEPLOY) {
      return;
    }
  } else if (kind === "validateFirst") {
    // requireValidation の環境（本番以外でも）は、まず検証を勧める。
    const VALIDATE = "先に検証する（おすすめ）";
    const DEPLOY = "このままデプロイする";
    const ok = await vscode.window.showWarningMessage(
      `環境「${ctx.orgAlias}」は「検証必須」に設定されています。まず検証(お試し)で安全確認するのがおすすめです。`,
      { modal: true, detail: detailLines.join("\n") },
      VALIDATE,
      DEPLOY
    );
    if (ok === VALIDATE) {
      launchDeploy(ctx, true, cs.toDeploy);
      return;
    }
    if (ok !== DEPLOY) {
      return;
    }
  } else {
    const ok = await vscode.window.showInformationMessage(
      `${verb}を実行しますか？`,
      { modal: true, detail: detailLines.join("\n") },
      `${verb}する`
    );
    if (ok !== `${verb}する`) {
      return;
    }
  }

  launchDeploy(ctx, validateOnly, cs.toDeploy);
}

/** Build + run the sf deploy/validate command and record the activity. */
function launchDeploy(ctx: DeployContext, validateOnly: boolean, files: string[]): void {
  const args = buildDeployArgs({
    files,
    orgAlias: ctx.orgUsername,
    testLevel: ctx.testLevel,
    validateOnly,
  });
  const command = renderCommand(cliPath(), args);
  logger.info(`実行: ${command}`);
  runInTerminal(command);
  recordActivity(
    `${validateOnly ? "検証" : "デプロイ"}: ${ctx.orgAlias}${ctx.isProduction ? " ⚠️本番" : ""}`,
    "run"
  );
}

/* ------------------------------ project commands -------------------------- */

async function openConfig(): Promise<void> {
  const root = requireRoot();
  if (!root) {
    return;
  }
  if (!(await configExists(root))) {
    const create = await vscode.window.showInformationMessage(
      "sf-teamflow.json がありません。作成しますか？",
      "作成する"
    );
    if (create !== "作成する") {
      return;
    }
    await initTeamProject();
    return;
  }
  const doc = await vscode.workspace.openTextDocument(configPath(root));
  await vscode.window.showTextDocument(doc);
}

async function initTeamProject(): Promise<void> {
  const root = requireRoot();
  if (!root) {
    return;
  }
  if (await configExists(root)) {
    const overwrite = await vscode.window.showWarningMessage(
      "sf-teamflow.json は既に存在します。上書きしますか？",
      "上書きする",
      "開く"
    );
    if (overwrite === "開く") {
      return openConfig();
    }
    if (overwrite !== "上書きする") {
      return;
    }
  }

  const packageDirs = await readSfdxPackageDirs(root);
  const config = defaultConfig(packageDirs);
  await saveConfig(root, config);

  // Write the JSON schema next to it for editor autocomplete.
  try {
    await writeScaffold(
      root,
      [{ relativePath: "sf-teamflow.schema.json", content: schemaJson() }],
      true
    );
  } catch (err) {
    logger.warn(`schema 書き込み失敗: ${String(err)}`);
  }

  // Salesforce DX 標準の .forceignore が無ければ用意（既存は尊重して上書きしない）。
  // deploy/retrieve から「デプロイ不可なノイズ（Jest/LWC設定/package.xml）」を除外する。
  try {
    const fiPath = path.join(root, ".forceignore");
    let cur: string | undefined;
    try {
      cur = await fsp.readFile(fiPath, "utf8");
    } catch {
      /* まだ無い */
    }
    if (shouldWriteBaselineForceignore(cur)) {
      await fsp.writeFile(fiPath, BASELINE_FORCEIGNORE, "utf8");
      logger.info(".forceignore を作成しました（Salesforce標準の除外）。");
    }
  } catch (err) {
    logger.warn(`.forceignore 書き込み失敗: ${String(err)}`);
  }

  refreshAll();
  const doc = await vscode.workspace.openTextDocument(configPath(root));
  await vscode.window.showTextDocument(doc);
  const next = await vscode.window.showInformationMessage(
    `${CONFIG_FILENAME} を作成しました。環境と接続先（エイリアス）を編集してください。`,
    "CI/CDも生成する"
  );
  if (next === "CI/CDも生成する") {
    await scaffoldCICD();
  }
  refreshAll();
}

/**
 * 環境名/別名が CI 上で同じ識別子(envSlug)へ collapse する衝突を検出し、あれば
 * modal で具体的に警告して true（=中止すべき）を返す。衝突なしなら false。
 * CI生成とシークレット登録の両方で、壊れた成果物を作る前に止めるために使う。
 */
async function hasBlockingEnvSlugCollision(config: TeamflowConfig): Promise<boolean> {
  const collisions = envSlugCollisions(config);
  if (collisions.length === 0) {
    return false;
  }
  const lines = collisions.map((c) => `・${c.envs.join(" / ")}（同じ識別子 ${c.slug} になります）`);
  await vscode.window.showErrorMessage(
    "環境名が CI 上で重複します。名前を変えてから実行してください。",
    {
      modal: true,
      detail:
        "次の環境は CI のジョブID/シークレット名が同じになり、ワークフローが壊れます:\n\n" +
        lines.join("\n") +
        "\n\n「① 環境設定」で名前を区別できるよう変更してください。",
    }
  );
  return true;
}

async function scaffoldCICD(): Promise<void> {
  const root = requireRoot();
  if (!root) {
    return;
  }
  let config: TeamflowConfig | undefined;
  try {
    config = await loadConfig(root);
  } catch (err) {
    vscode.window.showErrorMessage(`sf-teamflow.json が不正です: ${String(err)}`);
    return;
  }
  if (!config) {
    const init = await vscode.window.showInformationMessage(
      "先にチーム設定が必要です。初期化しますか？",
      "初期化する"
    );
    if (init === "初期化する") {
      await initTeamProject();
    }
    return;
  }

  // 環境名/別名が同じslugへ collapse するとjob ID重複・シークレット上書きでCIが壊れる。生成前に止める。
  if (await hasBlockingEnvSlugCollision(config)) {
    return;
  }

  const files = cicdFiles(config);
  const overwrite = await vscode.window.showQuickPick(
    [
      { label: "既存ファイルは残す", value: false },
      { label: "既存ファイルを上書きする", value: true },
    ],
    { placeHolder: "GitHub Actions / CODEOWNERS を生成します" }
  );
  if (!overwrite) {
    return;
  }
  const result = await writeScaffold(root, files, overwrite.value);
  logger.show();
  logger.info("CI/CD生成:");
  result.written.forEach((f) => logger.info(`  ✅ ${f}`));
  result.skipped.forEach((f) => logger.info(`  ⏭️ skip (既存) ${f}`));
  vscode.window.showInformationMessage(
    `CI/CDを生成しました (作成 ${result.written.length} / スキップ ${result.skipped.length})。` +
      " 続けて「CI/CDシークレット設定」で各環境の認証情報を登録できます。",
    "シークレットを設定"
  ).then((pick) => {
    if (pick === "シークレットを設定") {
      void vscode.commands.executeCommand("teamflow.setupCicdSecrets");
    }
  });
}

/**
 * 生成したCI/CDを“実際に動く”状態にする最後のピース。接続アプリ作成(Salesforce UI)は
 * 自動化できないが、自動化できる部分を支援する:
 *  1. JWT鍵ペアを openssl で生成（ci-keys/ は .gitignore 済み）
 *  2. 各環境の GitHub シークレット/変数を `gh secret/variable set` で登録
 *  3. 接続アプリ作成のチェックリストを提示
 */
async function setupCicdSecrets(): Promise<void> {
  const root = requireRoot();
  if (!root) {
    return;
  }
  let config: TeamflowConfig | undefined;
  try {
    config = await loadConfig(root);
  } catch (err) {
    vscode.window.showErrorMessage(`sf-teamflow.json が不正です: ${String(err)}`);
    return;
  }
  if (!config || config.environments.length === 0) {
    vscode.window.showInformationMessage("先に「① 環境設定」で環境を定義してください。");
    return;
  }
  // 衝突する環境名のままだと、同名シークレットを互いに上書きしてしまうので先に止める。
  if (await hasBlockingEnvSlugCollision(config)) {
    return;
  }
  if (!(await isGitRepo(root)) || !(await hasRemote(root))) {
    vscode.window.showInformationMessage("先に「🐙 GitHubに接続」してください（シークレットの登録先が必要）。");
    return;
  }
  const ghOk = await run("gh", ["auth", "status"], { cwd: root, timeout: 15_000 });
  if (ghOk.code !== 0) {
    vscode.window.showErrorMessage("GitHub CLI (gh) のログインが必要です。`gh auth login` を実行してください。");
    return;
  }

  // 1. JWT鍵ペア生成（接続アプリ用）。
  const keyPath = path.join(root, "ci-keys", "server.key");
  const crtPath = path.join(root, "ci-keys", "server.crt");
  let hasKey = await fsp
    .access(keyPath)
    .then(() => true)
    .catch(() => false);
  if (!hasKey) {
    const gen = await vscode.window.showInformationMessage(
      "CI認証用のJWT鍵ペア（証明書＋秘密鍵）を生成しますか？証明書(server.crt)は接続アプリにアップロードします。",
      "鍵を生成する",
      "スキップ"
    );
    if (gen === "鍵を生成する") {
      await fsp.mkdir(path.dirname(keyPath), { recursive: true });
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "JWT鍵ペアを生成中…" },
        () =>
          run(
            "openssl",
            ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", crtPath,
             "-subj", "/CN=sf-teamflow-ci", "-days", "3650"],
            { cwd: root, timeout: 60_000 }
          )
      );
      if (res.code !== 0) {
        vscode.window.showErrorMessage(
          `鍵生成に失敗しました（openssl が必要です）: ${(res.stderr || res.stdout).trim().slice(0, 200)}`
        );
        return;
      }
      await ensureGitignored(root, "ci-keys/");
      hasKey = true;
      const open = await vscode.window.showInformationMessage(
        "✅ 鍵を生成しました（ci-keys/。.gitignore済みでGitには含めません）。server.crt を接続アプリにアップロードしてください。",
        "server.crt を開く"
      );
      if (open === "server.crt を開く") {
        await vscode.window.showTextDocument(vscode.Uri.file(crtPath)).then(undefined, () => {});
      }
    }
  }

  // 2. 接続アプリ作成チェックリスト（手動・Salesforce UI）。
  await vscode.window.showInformationMessage(
    "【接続アプリの作成（各環境で1回）】\n" +
      "①設定→アプリケーションマネージャー→新規接続アプリ\n" +
      "②OAuth有効化／スコープに api, refresh_token, web\n" +
      "③「デジタル署名を使用」で server.crt をアップロード\n" +
      "④保存後の Consumer Key を控える（次で入力）",
    { modal: true },
    "OK"
  );

  // 3. 環境ごとに gh secret/variable を登録。
  let keyBody: string | undefined;
  if (hasKey) {
    keyBody = await fsp.readFile(keyPath, "utf8").catch(() => undefined);
  }
  for (const env of config.environments) {
    const prefix = secretPrefix(env);
    const go = await vscode.window.showQuickPick(
      [
        { label: `$(key) この環境のシークレットを登録`, detail: `${env.name} → ${prefix}_*`, do: true },
        { label: "$(arrow-right) スキップ", do: false },
      ],
      { title: `${env.name} (${env.orgAlias}) のCI認証情報` }
    );
    if (!go) {
      return;
    }
    if (!go.do) {
      continue;
    }
    const clientId = await vscode.window.showInputBox({
      title: `${env.name}: Consumer Key`,
      prompt: "接続アプリの Consumer Key (Client ID)",
      ignoreFocusOut: true,
      validateInput: (v) => consumerKeyError(v),
    });
    if (clientId === undefined) {
      return;
    }
    const username = await vscode.window.showInputBox({
      title: `${env.name}: 連携ユーザー`,
      prompt: "CIが使う連携ユーザーのユーザー名（例: ci@example.com）",
      ignoreFocusOut: true,
      validateInput: (v) => integrationUsernameError(v),
    });
    if (username === undefined) {
      return;
    }
    const instanceUrl = await vscode.window.showInputBox({
      title: `${env.name}: ログインURL`,
      value: env.type === "production" ? "https://login.salesforce.com" : "https://test.salesforce.com",
      ignoreFocusOut: true,
      validateInput: (v) => loginUrlError(v),
    });
    if (instanceUrl === undefined) {
      return;
    }
    const setSecret = async (name: string, value: string, isVar = false) =>
      run("gh", [isVar ? "variable" : "secret", "set", name, "-b", value], { cwd: root, timeout: 30_000 });
    const results: string[] = [];
    const r1 = await setSecret(`${prefix}_CLIENT_ID`, clientId.trim());
    results.push(`CLIENT_ID:${r1.code === 0 ? "✓" : "✗"}`);
    const r2 = await setSecret(`${prefix}_USERNAME`, username.trim());
    results.push(`USERNAME:${r2.code === 0 ? "✓" : "✗"}`);
    const r3 = await setSecret(`${prefix}_INSTANCE_URL`, instanceUrl.trim(), true);
    results.push(`INSTANCE_URL:${r3.code === 0 ? "✓" : "✗"}`);
    if (keyBody) {
      const r4 = await setSecret(`${prefix}_JWT_KEY`, keyBody);
      results.push(`JWT_KEY:${r4.code === 0 ? "✓" : "✗"}`);
    } else {
      results.push("JWT_KEY:未(鍵未生成)");
    }
    vscode.window.showInformationMessage(`${env.name}: ${results.join(" / ")}`);
  }
  // 仕上げ: CIは「ブランチ保護」で必須化しないと迂回できる。設定ページへ誘導。
  const url = await run("gh", ["repo", "view", "--json", "url", "-q", ".url"], {
    cwd: root,
    timeout: 15_000,
  });
  const repoUrl = url.code === 0 ? url.stdout.trim() : "";
  const next = await vscode.window.showInformationMessage(
    "CI/CDシークレットの設定を完了しました。PRを出すと自動検証が動きます。\n\n" +
      "仕上げに、main/develop の「ブランチ保護」を設定すると、検証通過を必須にできます（直接pushを禁止）。",
    ...(repoUrl ? ["ブランチ保護を設定"] : [])
  );
  if (next === "ブランチ保護を設定" && repoUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(`${repoUrl}/settings/branches`));
  }
}

/** Append a line to .gitignore if not already present. */
async function ensureGitignored(root: string, entry: string): Promise<void> {
  const gi = path.join(root, ".gitignore");
  let cur = "";
  try {
    cur = await fsp.readFile(gi, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (!cur.split(/\r?\n/).some((l) => l.trim() === entry)) {
    await fsp.writeFile(gi, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + `${entry}\n`, "utf8");
  }
}

