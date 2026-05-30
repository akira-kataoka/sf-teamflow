import * as vscode from "vscode";
import { logger } from "./util/logger.js";
import { run } from "./util/exec.js";
import { runSf } from "./util/cli.js";
import { OrgTreeProvider, type TreeNode } from "./orgManager/orgTreeProvider.js";
import { EnvironmentsTreeProvider } from "./orgManager/environmentsTreeProvider.js";
import type { OrgInfo } from "./orgManager/orgService.js";
import {
  changedFiles,
  classifyChanges,
  currentBranch,
  isGitRepo,
} from "./deploy/gitService.js";
import { buildDeployArgs, renderCommand } from "./deploy/deployService.js";
import {
  baseRefFor,
  defaultConfig,
  resolveEnvironment,
  testLevelFor,
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
import { cicdFiles } from "./cicd/templates.js";
import { writeScaffold } from "./cicd/scaffolder.js";
import { schemaJson } from "./config/schema.js";

let orgTree: OrgTreeProvider;
let envTree: EnvironmentsTreeProvider;
let deployTerminal: vscode.Terminal | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cliPath(): string {
  return vscode.workspace.getConfiguration("teamflow").get<string>("sfCliPath", "sf") || "sf";
}

function requireRoot(): string | undefined {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage("SF TeamFlow: ワークスペース(フォルダ)を開いてください。");
  }
  return root;
}

function runInTerminal(command: string): void {
  if (!deployTerminal || deployTerminal.exitStatus !== undefined) {
    deployTerminal = vscode.window.createTerminal({ name: "SF TeamFlow", cwd: workspaceRoot() });
  }
  deployTerminal.show(true);
  deployTerminal.sendText(command);
}

export function activate(context: vscode.ExtensionContext): void {
  logger.info(`SF TeamFlow activated (cli=${cliPath()})`);

  orgTree = new OrgTreeProvider(cliPath, workspaceRoot);
  envTree = new EnvironmentsTreeProvider(workspaceRoot, () => orgTree.knownOrgs);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("teamflow.orgs", orgTree),
    vscode.window.registerTreeDataProvider("teamflow.environments", envTree)
  );

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("teamflow.showLog", () => logger.show());

  register("teamflow.refreshOrgs", () => {
    orgTree.refresh();
    envTree.refresh();
  });

  register("teamflow.authorizeOrg", () => {
    runInTerminal(`${cliPath()} org login web`);
    vscode.window.showInformationMessage(
      "ブラウザでログインしてください。完了後、Org一覧を更新します。"
    );
  });

  register("teamflow.setDefaultOrg", (node?: TreeNode) => setDefaultOrg(node));
  register("teamflow.openOrg", (node?: TreeNode) => openOrg(node));
  register("teamflow.logoutOrg", (node?: TreeNode) => logoutOrg(node));
  register("teamflow.copyOrgId", (node?: TreeNode) => copyOrgId(node));

  register("teamflow.deployDiff", () => deployOrValidate(false));
  register("teamflow.validateDiff", () => deployOrValidate(true));
  register("teamflow.previewDiff", () => previewDiff());

  register("teamflow.scaffoldCICD", () => scaffoldCICD());
  register("teamflow.initTeamProject", () => initTeamProject());
  register("teamflow.openConfig", () => openConfig());
  register("teamflow.createScratchOrg", () => createScratchOrg());
}

export function deactivate(): void {
  logger.dispose();
}

/* ------------------------------- org commands ----------------------------- */

async function resolveOrgFromNode(node?: TreeNode): Promise<OrgInfo | undefined> {
  if (node?.org) {
    return node.org;
  }
  const orgs = orgTree.knownOrgs;
  if (orgs.length === 0) {
    vscode.window.showInformationMessage("認証済みのOrgがありません。");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    orgs.map((o) => ({
      label: `${o.isDefaultUsername ? "★ " : ""}${o.displayName}`,
      description: `${o.category}${o.isProduction ? " ⚠️本番" : ""}`,
      detail: o.username,
      org: o,
    })),
    { placeHolder: "Orgを選択" }
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
    vscode.window.showInformationMessage(`既定Orgを ${org.displayName} に設定しました。`);
    orgTree.refresh();
    envTree.refresh();
  } catch (err) {
    logger.error("既定Org設定に失敗", err);
    vscode.window.showErrorMessage(`既定Org設定に失敗: ${String(err)}`);
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
    vscode.window.showErrorMessage(`Orgを開けませんでした: ${org.displayName}`);
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
    orgTree.refresh();
    envTree.refresh();
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
  vscode.window.showInformationMessage(`Org ID をコピーしました: ${org.orgId}`);
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
  testLevel: TeamflowConfig["testLevel"];
  packageDirs: string[];
}

async function buildDeployContext(): Promise<DeployContext | undefined> {
  const root = requireRoot();
  if (!root) {
    return undefined;
  }
  if (!(await isGitRepo(root))) {
    vscode.window.showErrorMessage("SF TeamFlow: Gitリポジトリではありません。");
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
  logger.show();
  logger.info("──────── デプロイ差分プレビュー ────────");
  logger.info(`ブランチ: ${ctx.branch} / 基準: ${ctx.baseRef} / 対象Org: ${ctx.orgAlias}`);
  logger.info(`デプロイ対象 (${cs.toDeploy.length}件):`);
  cs.toDeploy.forEach((f) => logger.info(`  + ${f}`));
  if (cs.toDelete.length) {
    logger.info(`削除候補 (${cs.toDelete.length}件・自動削除しません):`);
    cs.toDelete.forEach((f) => logger.info(`  - ${f}`));
  }
  if (cs.ignored.length) {
    logger.info(`パッケージ外のため無視 (${cs.ignored.length}件)`);
  }
  vscode.window.showInformationMessage(
    `差分: デプロイ ${cs.toDeploy.length}件 / 削除候補 ${cs.toDelete.length}件 (詳細は出力パネル)`
  );
}

async function deployOrValidate(validateOnly: boolean): Promise<void> {
  const ctx = await buildDeployContext();
  if (!ctx) {
    return;
  }
  const cs = await computeChangeSet(ctx);
  if (cs.toDeploy.length === 0) {
    vscode.window.showInformationMessage(
      `デプロイ対象の差分がありません (基準: ${ctx.baseRef})。`
    );
    return;
  }

  const verb = validateOnly ? "検証" : "デプロイ";
  const detailLines = [
    `対象Org: ${ctx.orgAlias}${ctx.isProduction ? " ⚠️ 本番" : ""}`,
    `ブランチ: ${ctx.branch} (基準 ${ctx.baseRef})`,
    `テストレベル: ${ctx.testLevel}`,
    `ファイル ${cs.toDeploy.length}件`,
  ];
  if (cs.toDelete.length) {
    detailLines.push(`※ ${cs.toDelete.length}件の削除はこの操作に含まれません`);
  }

  const confirmProd = vscode.workspace
    .getConfiguration("teamflow")
    .get<boolean>("confirmProductionDeploy", true);
  if (!validateOnly && ctx.isProduction && confirmProd) {
    const ok = await vscode.window.showWarningMessage(
      `⚠️ 本番Org「${ctx.orgAlias}」へデプロイしようとしています。`,
      { modal: true, detail: detailLines.join("\n") },
      "本番にデプロイする"
    );
    if (ok !== "本番にデプロイする") {
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

  const args = buildDeployArgs({
    files: cs.toDeploy,
    orgAlias: ctx.orgUsername,
    testLevel: ctx.testLevel,
    validateOnly,
  });
  const command = renderCommand(cliPath(), args);
  logger.info(`実行: ${command}`);
  runInTerminal(command);
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

  envTree.refresh();
  const doc = await vscode.workspace.openTextDocument(configPath(root));
  await vscode.window.showTextDocument(doc);
  const next = await vscode.window.showInformationMessage(
    `${CONFIG_FILENAME} を作成しました。環境とOrgエイリアスを編集してください。`,
    "CI/CDも生成する"
  );
  if (next === "CI/CDも生成する") {
    await scaffoldCICD();
  }
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
      " 各環境の SF_<ENV>_CLIENT_ID / _USERNAME / _JWT_KEY シークレットを設定してください。"
  );
}

async function createScratchOrg(): Promise<void> {
  const root = requireRoot();
  if (!root) {
    return;
  }
  const alias = await vscode.window.showInputBox({
    prompt: "スクラッチOrgのエイリアス",
    value: "scratch-dev",
    validateInput: (v) => (v.trim() ? undefined : "エイリアスを入力してください"),
  });
  if (!alias) {
    return;
  }
  const days = await vscode.window.showInputBox({
    prompt: "有効日数 (1-30)",
    value: "7",
    validateInput: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 30 ? undefined : "1〜30の整数";
    },
  });
  if (!days) {
    return;
  }
  const command = renderCommand(cliPath(), [
    "org",
    "create",
    "scratch",
    "--definition-file",
    "config/project-scratch-def.json",
    "--alias",
    alias,
    "--duration-days",
    days,
    "--set-default",
  ]);
  runInTerminal(command);
  vscode.window.showInformationMessage(
    "スクラッチOrgを作成中です。完了後、Org一覧を更新してください。"
  );
}
