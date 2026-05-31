import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { OrgTreeProvider } from "../orgManager/orgTreeProvider.js";
import { scratchRemainingLabel, isScratchExpired } from "../orgManager/orgService.js";
import {
  isGitRepo,
  status,
  hasRemote,
  listBranches,
  switchBranch,
  changedFiles,
  classifyChanges,
  conflictedFiles,
} from "../deploy/gitService.js";
import { configExists, loadConfig, readSfdxPackageDirs } from "../config/configStore.js";
import { baseRefFor, lintTeamflowConfig, resolveEnvironment } from "../config/teamflowConfig.js";
import { runSf } from "../util/cli.js";
import { logger } from "../util/logger.js";
import { relativeTime, computeStats, type ActivityEntry } from "../activityLog.js";

interface HomeOrg {
  username: string;
  displayName: string;
  category: string;
  isProduction: boolean;
  isDefault: boolean;
  connected: boolean;
  /** For scratch orgs: "残り5日" / "期限切れ" — undefined otherwise. */
  expires?: string;
  /** True when a scratch org is past its expiration date (gray out + cleanup). */
  expired?: boolean;
}

interface HomeState {
  /** A folder is open in VS Code. */
  hasFolder: boolean;
  /** The open folder is an SFDX project (sfdx-project.json exists). */
  hasProject: boolean;
  configured: boolean;
  hasRepo: boolean;
  hasRemote: boolean;
  defaultOrg: HomeOrg | null;
  orgs: HomeOrg[];
  branch: string;
  branches: string[];
  env: { name: string; type: string } | null;
  changes: number;
  ahead: number;
  behind: number;
  /** Working-tree changed files, for the "保存される変更" preview. */
  files: { path: string; label: string }[];
  /** Metadata files that a Git-diff deploy would push (vs base ref). */
  deployCount: number;
  /** Recent actions (newest first) for the "最近の操作" list. */
  activity: { label: string; status: string; rel: string }[];
  /** Config lint warnings (empty = healthy). */
  warnings: string[];
  /** Files currently in a merge conflict (relative paths). */
  conflicts: string[];
  /** Handy dev metrics: deploys(リリース)/tests/saves + connected org count. */
  stats: { deploys: number; tests: number; saves: number; orgs: number };
  /** Environment pipeline for the visual (dev → staging → prod). */
  pipeline: { name: string; type: string; orgAlias: string; purpose?: string; current: boolean; connected: boolean }[];
}

/**
 * The primary, click-first interface: a sidebar webview that organises the day's
 * work into a numbered flow (① develop with the org → ② save/back up → ③ release)
 * instead of a flat wall of buttons, and surfaces a single recommended "next
 * action" so a junior dev always knows what to click. Heavy logic stays in the
 * tested command/service layer; this view dispatches to it and renders state.
 */
export class HomeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "teamflow.home";
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orgTree: OrgTreeProvider,
    private readonly getRoot: () => string | undefined,
    private readonly getCliPath: () => string,
    private readonly requestRefresh: () => void,
    private readonly getActivity: () => ActivityEntry[] = () => []
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.postState();
      }
    });
  }

  /** Recompute + push state to the webview (called on any refresh). */
  async postState(): Promise<void> {
    if (!this.view) {
      return;
    }
    try {
      const state = await this.getState();
      await this.view.webview.postMessage({ type: "state", payload: state });
    } catch (err) {
      logger.error("home state 取得失敗", err);
    }
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "ready":
        await this.postState();
        return;
      case "refresh":
        await this.orgTree.ensureOrgsLoaded(true);
        this.requestRefresh();
        await this.postState();
        return;
      case "command":
        if (typeof msg.command === "string") {
          await vscode.commands.executeCommand(msg.command);
          // Give terminal/input-driven commands a beat, then refresh.
          setTimeout(() => void this.postState(), 800);
        }
        return;
      case "setOrg":
        await this.setDefaultOrg(msg.username);
        return;
      case "openOrg":
        await vscode.commands.executeCommand("teamflow.openOrgByName", msg.username);
        return;
      case "reconnect":
        await vscode.commands.executeCommand("teamflow.reconnectOrg", msg.username);
        return;
      case "deleteScratch":
        await vscode.commands.executeCommand("teamflow.deleteScratchOrg", msg.username);
        setTimeout(() => void this.postState(), 800);
        return;
      case "switchBranch":
        await this.doSwitchBranch(msg.name);
        return;
      case "openFile":
        await this.openFile(msg.path);
        return;
    }
  }

  private async openFile(relPath: string): Promise<void> {
    const root = this.getRoot();
    if (!root || !relPath) {
      return;
    }
    const uri = vscode.Uri.file(`${root}/${relPath}`);
    await vscode.window.showTextDocument(uri).then(undefined, (err) => {
      logger.error(`ファイルを開けません: ${relPath}`, err);
    });
  }

  private async setDefaultOrg(username: string): Promise<void> {
    const root = this.getRoot();
    try {
      await runSf(["config", "set", `target-org=${username}`], {
        cliPath: this.getCliPath(),
        cwd: root,
      });
      this.requestRefresh();
      await this.orgTree.ensureOrgsLoaded(true);
      await this.postState();
    } catch (err) {
      logger.error("既定Org設定に失敗", err);
      vscode.window.showErrorMessage(`既定Org設定に失敗: ${String(err)}`);
    }
  }

  private async doSwitchBranch(name: string): Promise<void> {
    const root = this.getRoot();
    if (!root || !name) {
      return;
    }
    try {
      await switchBranch(name, root);
      this.requestRefresh();
      await this.postState();
    } catch (err) {
      vscode.window.showErrorMessage(`ブランチ切替に失敗（未保存の変更があるかも）: ${String(err)}`);
    }
  }

  private async getState(): Promise<HomeState> {
    const root = this.getRoot();
    const hasFolder = !!root;
    // An SFDX project is identified by sfdx-project.json at the workspace root.
    const hasProject = !!root && fs.existsSync(path.join(root, "sfdx-project.json"));
    const orgsRaw = await this.orgTree.ensureOrgsLoaded().catch(() => []);
    const orgs: HomeOrg[] = orgsRaw.map((o) => ({
      username: o.username,
      displayName: o.displayName,
      category: o.category,
      isProduction: o.isProduction,
      isDefault: o.isDefaultUsername === true,
      connected: o.connected,
      expires: scratchRemainingLabel(o.category, o.expirationDate, Date.now()),
      expired: isScratchExpired(o.category, o.expirationDate, Date.now()),
    }));

    let configured = false;
    let hasRepo = false;
    let remote = false;
    let branch = "";
    let branches: string[] = [];
    let env: { name: string; type: string } | null = null;
    let changes = 0;
    let ahead = 0;
    let behind = 0;
    let files: { path: string; label: string }[] = [];
    let deployCount = 0;
    let conflicts: string[] = [];
    let pipeline: HomeState["pipeline"] = [];

    if (root) {
      configured = await configExists(root);
      hasRepo = await isGitRepo(root);
      if (hasRepo) {
        try {
          const s = await status(root);
          branch = s.branch;
          changes = s.changed;
          ahead = s.ahead;
          behind = s.behind;
          files = s.files.slice(0, 40).map((f) => ({ path: f.path, label: f.label }));
          conflicts = conflictedFiles(s);
        } catch {
          /* ignore */
        }
        remote = await hasRemote(root).catch(() => false);
        branches = await listBranches(root).catch(() => []);
        const cfg = configured ? await loadConfig(root).catch(() => undefined) : undefined;
        if (cfg && branch) {
          const e = resolveEnvironment(cfg, branch);
          if (e) {
            env = { name: e.name, type: e.type };
          }
        }
        // Count metadata files a diff-deploy would push (best-effort; the base
        // ref may not exist locally, in which case we just show no badge).
        try {
          const e = cfg && branch ? resolveEnvironment(cfg, branch) : undefined;
          const baseRef = cfg ? baseRefFor(cfg, e) : "origin/main";
          const pkgDirs = cfg?.packageDirectories ?? (await readSfdxPackageDirs(root));
          const entries = await changedFiles(baseRef, root);
          deployCount = classifyChanges(entries, pkgDirs).toDeploy.length;
        } catch {
          deployCount = 0;
        }
      }
    }

    // Lint the team config + build the environment pipeline visual.
    let warnings: string[] = [];
    if (root && configured) {
      try {
        const cfg2 = await loadConfig(root);
        if (cfg2) {
          warnings = lintTeamflowConfig(
            cfg2,
            orgsRaw.map((o) => o.alias || o.username)
          );
          pipeline = cfg2.environments.map((e) => ({
            name: e.name,
            type: e.type,
            orgAlias: e.orgAlias,
            purpose: e.purpose,
            current: env?.name === e.name,
            connected: orgs.some((o) => o.username === e.orgAlias || o.displayName === e.orgAlias),
          }));
        }
      } catch {
        /* invalid config — surfaced elsewhere */
      }
    }

    const allActivity = this.getActivity();
    return {
      hasFolder,
      hasProject,
      configured,
      hasRepo,
      hasRemote: remote,
      defaultOrg: orgs.find((o) => o.isDefault) ?? null,
      orgs,
      branch,
      branches,
      env,
      changes,
      ahead,
      behind,
      files,
      deployCount,
      activity: allActivity.slice(0, 3).map((a) => ({
        label: a.label,
        status: a.status,
        rel: relativeTime(a.time, Date.now()),
      })),
      warnings,
      conflicts,
      stats: { ...computeStats(allActivity), orgs: orgs.length },
      pipeline,
    };
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceString();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 8px 24px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 13px; font-size: 11.5px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.prod { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); outline: 1px solid #e55; }
  .chip.dim { opacity: .6; }
  .caption { font-size: 11px; font-weight: 600; opacity: .7; margin: 10px 2px 4px; }
  .stats { display: flex; gap: 6px; margin-bottom: 10px; }
  .stat { flex: 1; text-align: center; padding: 7px 4px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 8px; }
  .stat .n { font-size: 17px; font-weight: 700; line-height: 1.1; }
  .stat .n .u { font-size: 10px; font-weight: 400; opacity: .6; margin-left: 1px; }
  .stat .l { font-size: 10px; opacity: .65; margin-top: 2px; }
  /* 環境数は「回数」とは別物なので、左側に区切りを入れて視覚的に分ける。 */
  .stat.env { border-color: var(--vscode-focusBorder, #4aa3df88); margin-left: 4px; }
  .pipeline { display: flex; align-items: stretch; gap: 0; margin-bottom: 12px; }
  .pipeline .penv { flex: 1; text-align: center; padding: 7px 3px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 8px; font-size: 10.5px; position: relative; }
  .pipeline .penv.cur { outline: 2px solid var(--vscode-focusBorder); }
  .pipeline .penv.prod { border-color: #e55; }
  .pipeline .penv .pe { font-size: 15px; }
  .pipeline .penv .pn { font-weight: 600; margin-top: 1px; }
  .pipeline .penv .po { opacity: .6; }
  .pipeline .penv .pp { opacity: .55; font-size: 9.5px; margin-top: 2px; }
  .pipeline .arrow { display: flex; align-items: center; padding: 0 3px; opacity: .5; font-size: 12px; }
  .chip.clickable { cursor: pointer; }
  .chip.clickable:hover { filter: brightness(1.2); }
  [tabindex="0"]:focus-visible, button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }

  /* next-action hero */
  .hero { display: flex; align-items: center; gap: 10px; padding: 12px; border-radius: 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; margin-bottom: 12px; }
  .hero .em { font-size: 26px; line-height: 1; }
  .hero .tx { flex: 1; }
  .hero .t1 { font-size: 11px; opacity: .85; }
  .hero .t2 { font-size: 14px; font-weight: 600; margin-top: 2px; }
  .hero .go { font-size: 18px; opacity: .85; }
  .hero.calm { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); cursor: default; }
  .situation { font-size: 11.5px; opacity: .72; margin: -4px 2px 12px; line-height: 1.6; }
  .situation .link { cursor: pointer; color: var(--vscode-textLink-foreground, #4daafc); margin-left: 4px; white-space: nowrap; }
  .situation .link:hover { text-decoration: underline; }
  .situation .note { margin-top: 4px; opacity: .85; }
  .statuslist { display: flex; flex-direction: column; gap: 3px; }
  .statuslist .slrow { display: flex; gap: 8px; }
  .statuslist .slk { flex: 0 0 96px; opacity: .75; }
  .statuslist .slv { flex: 1; }
  .statuslist .prodtag { color: #e5534b; font-weight: 600; }
  .warnbox { border: 1px solid var(--vscode-inputValidation-warningBorder, #c80); background: var(--vscode-inputValidation-warningBackground, #5a4a1d); border-radius: 8px; padding: 8px 10px; margin: 0 2px 12px; font-size: 11.5px; cursor: pointer; }
  .warnbox .wh { font-weight: 600; margin-bottom: 4px; }
  .warnbox .wi { padding: 1px 0; opacity: .9; }
  .conflictbox { border: 1px solid #e55; background: var(--vscode-inputValidation-errorBackground, #5a1d1d); border-radius: 8px; padding: 8px 10px; margin: 0 2px 12px; font-size: 11.5px; }
  .conflictbox .ch { font-weight: 600; margin-bottom: 4px; }
  .conflictbox .ci { padding: 2px 0; cursor: pointer; }
  .conflictbox .ci:hover { text-decoration: underline; }
  .conflictbox .done { margin-top: 6px; cursor: pointer; opacity: .85; }
  .conflictbox .done:hover { opacity: 1; text-decoration: underline; }
  .activity { font-size: 11px; margin: -6px 2px 12px; }
  .activity .alabel { opacity: .55; margin-bottom: 2px; }
  .activity .ai { display: flex; gap: 6px; padding: 1px 0; opacity: .85; }
  .activity .ai .rel { opacity: .55; margin-left: auto; }
  .activity .ai.error { color: #e66; }
  .activity .ai.ok { color: #3fb950; }
  .activity .ai.loglink { cursor: pointer; opacity: .7; margin-top: 4px; }
  .activity .ai.loglink:hover { opacity: 1; text-decoration: underline; }

  /* sections */
  section { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 8px 8px 10px; margin-bottom: 10px; }
  /* 折りたたみ可能なワークフローのセクション。 */
  .secfold { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 8px 8px 10px; margin-bottom: 10px; }
  .secfold > summary { list-style: none; cursor: pointer; }
  .secfold > summary::-webkit-details-marker { display: none; }
  .secfold:not([open]) > summary.sechead { margin-bottom: 2px; }
  .caret { display: inline-block; font-size: 10px; opacity: .6; transition: transform .12s; flex: 0 0 auto; }
  .secfold[open] > summary .caret { transform: rotate(90deg); }
  .sechead { display: flex; align-items: center; gap: 8px; margin: 2px 2px 8px; }
  .stepno { width: 20px; height: 20px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; font-weight: 600; }
  .sectitle { font-size: 12.5px; font-weight: 600; }
  .sechint { font-size: 11px; opacity: .6; margin-left: auto; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .grid.three { grid-template-columns: 1fr 1fr 1fr; }
  button.tile { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 11px 4px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 9px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); cursor: pointer; font-size: 11.5px; line-height: 1.2; min-height: 58px; text-align: center; }
  button.tile:hover:not(:disabled) { filter: brightness(1.15); }
  button.tile.primary { outline: 2px solid var(--vscode-focusBorder); }
  button.tile .em { font-size: 19px; }
  button.tile:disabled { opacity: .35; cursor: default; }
  .badge { position: absolute; top: 5px; right: 7px; background: var(--vscode-activityBarBadge-background, #d33); color: var(--vscode-activityBarBadge-foreground,#fff); border-radius: 9px; padding: 0 6px; font-size: 11px; }

  /* org cards + branch */
  .card { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 8px; margin-bottom: 6px; cursor: pointer; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card.active { outline: 2px solid var(--vscode-focusBorder); }
  .card .dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
  .card .name { flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .cat { font-size: 10.5px; opacity: .6; }
  .card .open { font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border,#8884); background: transparent; color: var(--vscode-foreground); cursor: pointer; white-space: nowrap; }
  .card.disc { border-color: var(--vscode-inputValidation-warningBorder, #c80); }
  .card .open.reconnect { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  /* 期限切れスクラッチ: グレーアウトして「掃除」だけ目立たせる。 */
  .card.expired { opacity: .5; border-style: dashed; }
  .card.expired:hover { opacity: .75; }
  .card .expiredtag { color: var(--vscode-inputValidation-errorBorder, #e5534b); font-weight: 600; }
  .card .open.delscratch { border-color: var(--vscode-inputValidation-errorBorder, #e5534b); color: var(--vscode-inputValidation-errorBorder, #e5534b); }
  .card .open.delscratch:hover { background: var(--vscode-inputValidation-errorBorder, #e5534b); color: #fff; }
  .row { display: flex; gap: 6px; align-items: center; }
  select { flex: 1; padding: 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 6px; }
  .iconbtn { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--vscode-panel-border,#8884); background: var(--vscode-button-secondaryBackground,#3a3d41); color: var(--vscode-button-secondaryForeground,#fff); cursor: pointer; white-space: nowrap; }
  .empty { opacity: .6; font-size: 11.5px; padding: 4px 2px; }
  .step { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; cursor: pointer; border: 1px dashed var(--vscode-panel-border, #8884); margin-bottom: 6px; }
  .step:hover { background: var(--vscode-list-hoverBackground); }
  .step .mk { font-size: 15px; }

  details.changed { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 9px; padding: 6px 10px; margin-bottom: 12px; }
  details.changed > summary { cursor: pointer; font-size: 12px; list-style: none; display: flex; align-items: center; gap: 6px; }
  details.changed > summary::-webkit-details-marker { display: none; }
  details.changed > summary .caret { transition: transform .15s; opacity: .6; }
  details.changed[open] > summary .caret { transform: rotate(90deg); }
  .filelist { margin-top: 6px; max-height: 180px; overflow: auto; }
  .fileitem { display: flex; align-items: center; gap: 7px; padding: 3px 2px; font-size: 11.5px; }
  .filetag { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); flex: 0 0 auto; }
  .filepath { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; direction: rtl; text-align: left; }

  details.more { margin: 2px 0 10px; }
  details.more > summary { cursor: pointer; font-size: 12.5px; padding: 8px 10px; border: 1px dashed var(--vscode-panel-border, #8884); border-radius: 8px; opacity: .85; list-style: none; }
  details.more > summary::-webkit-details-marker { display: none; }
  details.more[open] > summary { opacity: 1; margin-bottom: 8px; }
  .addorg { margin-bottom: 8px; }
  details.orgfold { margin-top: 2px; }
  details.orgfold > summary { cursor: pointer; font-size: 11px; opacity: .7; padding: 2px 0 6px; list-style: none; }
  details.orgfold > summary::-webkit-details-marker { display: none; }
  details.orgfold > summary:hover { opacity: 1; }
  .footer { display: flex; gap: 14px; justify-content: center; margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, #8884); }
  .footer .fitem { cursor: pointer; font-size: 12px; opacity: .75; }
  .footer .fitem:hover { opacity: 1; text-decoration: underline; }
  .setupbar { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 8px 10px; margin-bottom: 12px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 8px; opacity: .9; }
  .setupbar .done { color: #3fb950; }
  .setupbar .now { font-weight: 700; }
  .setupbar .sep { opacity: .5; }
</style>
</head>
<body>
  <div id="status" class="chips"></div>
  <div class="caption">📊 開発サマリ</div>
  <div id="stats" class="stats"></div>
  <div class="caption" id="pipecap">🗺️ 環境構成</div>
  <div id="pipeline" class="pipeline"></div>
  <div id="hero"></div>
  <div id="situation" class="situation"></div>
  <div id="conflicts"></div>
  <div id="warnings"></div>
  <div id="activity" class="activity"></div>
  <div id="setup"></div>
  <div id="changedbox"></div>
  <div id="sections"></div>
  <section>
    <div class="sechead"><span class="stepno">🌿</span><span class="sectitle">ブランチ</span></div>
    <div id="branchbox"></div>
  </section>
  <section>
    <div class="sechead"><span class="stepno">☁️</span><span class="sectitle">環境</span></div>
    <div id="orgs"></div>
  </section>

  <div class="footer">
    <span class="fitem" data-cmd="teamflow.openWorkflowGuide" role="button" tabindex="0">📘 ガイド</span>
    <span class="fitem" data-cmd="teamflow.quickSettings" role="button" tabindex="0">⚙️ 設定</span>
    <span class="fitem" data-cmd="teamflow.refreshOrgs" role="button" tabindex="0">🔄 更新</span>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function send(type, extra) { vscode.postMessage(Object.assign({ type }, extra || {})); }
  function cmd(c) { send('command', { command: c }); }

  // 機能ごとに分けた、番号付きの開発サイクル。各グループは明確なタイトルで
  // 常時表示（あいまいな「応用操作」折りたたみは廃止）。まれにしか使わない
  // スクラッチ環境だけ SCRATCH_SECTION として折りたたみに入れる。
  const SECTIONS = [
    { no: '①', title: 'プロジェクト', three: true, tiles: [
      { c: 'teamflow.createProject', em: '📂', label: 'プロジェクト作成', desc: 'フォルダごと新規作成して自動で開きます（最初はこれ）' },
      { c: 'teamflow.setupWizard', em: '🧭', label: '環境設定', need: 'project', desc: '開発/ステージング/本番を割り当て・編集します（環境の認証・追加は下の「環境」から）' },
    ]},
    { no: '②', title: '開発', three: true, tiles: [
      { c: 'teamflow.createComponent', em: '✨', label: '資材作成', need: 'project', desc: 'Apexクラス/トリガ/LWC/Aura を作成' },
      { c: 'teamflow.sourcePull', em: '⬇️', label: '資材取込', need: 'org', desc: '環境側の変更をローカルに取り込みます' },
      { c: 'teamflow.sourcePush', em: '⬆️', label: '資材反映', need: 'org', desc: 'ローカルの変更を「自分の開発環境」へ直接反映して動作確認（共有環境へはデプロイ）' },
      { c: 'teamflow.retrieveMetadata', em: '📥', label: 'メタデータ取得', need: 'org', desc: '既存環境から種類を選んで取り込み' },
    ]},
    { no: '③', title: '保存', three: true, tiles: [
      { c: 'teamflow.gitCommitPush', em: '💾', label: 'バックアップ', need: 'project', badge: 'changes', desc: '変更を保存してGitHubに送ります（未管理なら自動でGit初期化を案内）' },
      { c: 'teamflow.gitPublish', em: '🐙', label: 'GitHubに接続', need: 'project', desc: 'GitHubにリポジトリを作って公開（初回の接続。gh連携）' },
      { c: 'teamflow.gitSync', em: '🔄', label: 'GitHub同期', need: 'remote', badge: 'ahead', desc: '取り込み→バックアップ（接続済みのとき）' },
    ]},
    { no: '④', title: 'テスト・リリース', three: true, tiles: [
      { c: 'teamflow.runTests', em: '🧪', label: 'テスト', need: 'org', desc: 'Apexテストを実行します' },
      { c: 'teamflow.tailLog', em: '📜', label: 'ログ', need: 'org', desc: 'System.debug出力をリアルタイム表示' },
      { c: 'teamflow.validateDiff', em: '✅', label: 'デプロイ前チェック', need: 'repo', badge: 'deploy', desc: '本番に送らず「問題なく送れるか」だけ確認（お試し・dry-run）' },
      { c: 'teamflow.deployToEnvironment', em: '🚀', label: '環境へデプロイ', need: 'repo', badge: 'deploy', desc: 'ステージング/本番など「共有環境」へ配布。※資材反映=自分の環境用 / デプロイ=共有環境用' },
      { c: 'teamflow.scaffoldCICD', em: '🤖', label: 'CI/CD生成', need: 'repo', desc: 'GitHub Actionsを生成。PRで自動検証(＋PMD/Jest)／mergeで自動デプロイ（feature→develop→main）' },
      { c: 'teamflow.setupCicdSecrets', em: '🔑', label: 'CI/CD設定', need: 'remote', desc: 'CI/CDを動かす認証情報を登録（JWT鍵生成＋GitHubシークレット設定）' },
    ]},
    { no: '⑤', title: 'バージョン管理', three: true, tiles: [
      { c: 'teamflow.manageBranches', em: '🌿', label: 'ブランチ管理', need: 'repo', desc: '切替/作成/削除' },
      { c: 'teamflow.createPullRequest', em: '🔀', label: 'Pull Request', need: 'repo', desc: 'レビュー依頼(develop等へ)' },
      { c: 'teamflow.manageTags', em: '🏷️', label: 'タグ管理', need: 'repo', desc: 'リリースの目印' },
      { c: 'teamflow.rollback', em: '⏪', label: '取り消し', need: 'repo', desc: '前の変更を取り消す（履歴を壊さない安全な取り消し。元に戻せます）' },
      { c: 'teamflow.showHistory', em: '🕘', label: '変更履歴', need: 'repo', desc: '誰が・いつ・何を変えたかを一覧（選ぶと変更ファイルを確認）' },
    ]},
  ];

  // スクラッチ環境の作成系。「環境」セクションの操作として一緒に見せる。
  const SCRATCH_SECTION = { three: true, tiles: [
    { c: 'teamflow.setupDevHub', em: '🌳', label: 'Dev Hub 準備', desc: 'スクラッチ作成の前に親組織(Dev Hub)を用意（複数可）' },
    { c: 'teamflow.createScratchOrg', em: '🌱', label: 'スクラッチ作成', need: 'project', desc: '使い捨て開発Org（Dev Hubから作成）' },
  ]};

  function nextAction(s) {
    // Single, unambiguous "what to do next". The ordered first-run flow is:
    //   ⓪ プロジェクトを準備 → ① Orgを認証 → ② 環境を設定。
    // git は「保存」時に自動で開始するのでここでは別アクションとして出さない。
    if (!s.hasFolder) return { em:'📂', t1:'はじめに（1）', t2:'新しいプロジェクトを作成する', c:'teamflow.createProject' };
    if (!s.hasProject) return { em:'📂', t1:'はじめに（1）', t2:'Salesforceプロジェクトを作成する', c:'teamflow.createProject' };
    if (s.defaultOrg && !s.defaultOrg.connected) return { em:'🔌', t1:'接続が切れています', t2:s.defaultOrg.displayName+' に再接続する', reconnect:s.defaultOrg.username };
    if (s.orgs.length === 0) return { em:'🔌', t1:'はじめに（2）', t2:'環境を認証する（ログイン）', c:'teamflow.authorizeOrg' };
    if (!s.configured) return { em:'🧭', t1:'はじめに（3）', t2:'環境を設定する（開発/ステージング/本番）', c:'teamflow.setupWizard' };
    if (s.changes > 0) return { em:'💾', t1:'次にやること', t2:'変更 '+s.changes+'件をバックアップ', c:'teamflow.gitCommitPush' };
    if (s.ahead > 0) return { em:'🔄', t1:'次にやること', t2:'未バックアップ '+s.ahead+'件をGitHubへ', c:'teamflow.gitSync' };
    return { em:'✅', t1:'準備OK', t2:'いまやる操作はありません', calm:true };
  }

  function render(s) {
    // status chips
    const chips = [];
    if (s.defaultOrg) {
      // Clickable when connected → opens the org in the browser.
      const clickable = s.defaultOrg.connected
        ? ' clickable" data-open="'+escapeAttr(s.defaultOrg.username)+'" title="クリックでブラウザで開く'
        : '';
      chips.push('<span class="chip ' + (s.defaultOrg.isProduction?'prod':'') + clickable + '">☁️ ' +
        (s.defaultOrg.isProduction?'⚠️ ':'') + escapeHtml(s.defaultOrg.displayName) +
        (s.defaultOrg.connected?' 🔗':'') + '</span>');
    } else {
      chips.push('<span class="chip dim">☁️ 環境未選択</span>');
    }
    if (s.hasRepo) {
      let b = '🌿 ' + escapeHtml(s.branch || '(なし)');
      if (s.env) b += ' → ' + escapeHtml(s.env.name);
      chips.push('<span class="chip">' + b + '</span>');
    }
    $('status').innerHTML = chips.join('');

    // これまでの操作回数（リリース/テスト/保存）と、接続中の環境数。回数と
    // 環境数は別物なので、回数には「回」を付け、環境数は区切って別枠で見せる。
    const st = s.stats || { deploys:0, tests:0, saves:0, orgs:0 };
    const u = '<span class="u">回</span>';
    $('stats').innerHTML =
      '<div class="stat"><div class="n">'+st.deploys+u+'</div><div class="l">🚀 リリース</div></div>'+
      '<div class="stat"><div class="n">'+st.tests+u+'</div><div class="l">🧪 テスト</div></div>'+
      '<div class="stat"><div class="n">'+st.saves+u+'</div><div class="l">💾 保存</div></div>'+
      '<div class="stat env"><div class="n">'+st.orgs+'</div><div class="l">☁️ 環境</div></div>';

    // environment pipeline visual (dev → staging → prod)
    if (s.pipeline && s.pipeline.length>0) {
      const EM = { development:'🛠️', staging:'🧪', production:'🛡️', sandbox:'🧪', dev:'🛠️', scratch:'🌱' };
      const cells = s.pipeline.map(p => {
        const emoji = EM[p.name.toLowerCase()] || EM[p.type] || '☁️';
        const purpose = p.purpose ? '<div class="pp">'+escapeHtml(p.purpose)+'</div>' : '';
        return '<div class="penv'+(p.current?' cur':'')+(p.type==='production'?' prod':'')+'" title="'+escapeAttr((p.purpose?p.purpose+' / ':'')+p.orgAlias)+'">'+
          '<div class="pe">'+emoji+'</div><div class="pn">'+escapeHtml(p.name)+'</div>'+
          '<div class="po">'+escapeHtml(p.orgAlias)+(p.connected?'':' ❌')+'</div>'+purpose+'</div>';
      });
      $('pipeline').innerHTML = cells.join('<div class="arrow">→</div>');
      $('pipecap').style.display = '';
    } else {
      $('pipeline').innerHTML = '';
      $('pipecap').style.display = 'none';
    }

    // next-action hero
    const na = nextAction(s);
    const heroAttr = na.reconnect ? 'data-reconnect="'+escapeAttr(na.reconnect)+'"' : (na.c?'data-cmd="'+na.c+'"':'');
    const heroA11y = (na.c||na.reconnect) ? ' role="button" tabindex="0" aria-label="'+escapeAttr(na.t1+' '+na.t2)+'"' : '';
    $('hero').innerHTML = '<div class="hero '+(na.calm?'calm':'')+'" '+heroAttr+heroA11y+'>'+
      '<span class="em">'+na.em+'</span><span class="tx"><div class="t1">'+na.t1+'</div>'+
      '<div class="t2">'+escapeHtml(na.t2)+'</div></span>'+((na.c||na.reconnect)?'<span class="go">▶</span>':'')+'</div>';

    // plain-language one-liner: where you are and what is pending.
    // In the empty/onboarding state, show a friendly welcome + guide link.
    if (s.hasRepo && (s.orgs.length>0 || s.configured)) {
      // 専門用語を避け、3項目を箇条書きに（読み下し文より一目で分かる）。
      const br = escapeHtml(s.branch||'(ブランチなし)') + (s.env?'（'+escapeHtml(s.env.name)+'環境）':'');
      const chg = s.changes>0
        ? '未保存 '+s.changes+'件'+(s.ahead>0?'・未バックアップ '+s.ahead+'件':'')
        : (s.ahead>0?'未バックアップ '+s.ahead+'件':'なし');
      const dep = s.defaultOrg
        ? escapeHtml(s.defaultOrg.displayName)+(s.defaultOrg.isProduction?' <span class="prodtag">⚠️本番</span>':'')
        : '未選択';
      const rows =
        '<div class="slrow"><span class="slk">📍 作業中</span><span class="slv">'+br+'</span></div>'+
        '<div class="slrow"><span class="slk">✏️ 変更</span><span class="slv">'+chg+'</span></div>'+
        '<div class="slrow"><span class="slk">☁️ 反映する環境</span><span class="slv">'+dep+'</span></div>';
      let note = '';
      if (s.configured && !s.env && s.branch) {
        note = '<div class="note">ℹ️ 作業用ブランチ（デプロイ先は都度選択）</div>';
      }
      $('situation').innerHTML = '<div class="statuslist">'+rows+'</div>'+note;
    } else if (s.orgs.length===0 || !s.configured) {
      $('situation').innerHTML = '👋 「次にやること」から順に進めましょう。'+
        '<span class="link" data-cmd="teamflow.openWorkflowGuide" role="button" tabindex="0">📘 ガイド</span>';
    } else {
      $('situation').innerHTML = '';
    }

    // merge conflicts — most urgent; show files and a path to resolve them
    if (s.conflicts && s.conflicts.length>0) {
      const rows = s.conflicts.map(p =>
        '<div class="ci" data-openfile="'+escapeAttr(p)+'">📄 '+escapeHtml(p)+'</div>').join('');
      $('conflicts').innerHTML = '<div class="conflictbox">'+
        '<div class="ch">⚠️ コンフリクト解決中（'+s.conflicts.length+'件）</div>'+
        '<div>各ファイルを開き、どちらの変更を残すか決めて保存してください。</div>'+rows+
        '<div class="done" data-cmd="teamflow.gitCommitPush">✅ 解決したら「バックアップ」</div></div>';
    } else {
      $('conflicts').innerHTML = '';
    }

    // config lint warnings (click → open sf-teamflow.json)
    if (s.warnings && s.warnings.length>0) {
      $('warnings').innerHTML = '<div class="warnbox" data-cmd="teamflow.openConfig" role="button" tabindex="0">'+
        '<div class="wh">⚠️ 設定の確認</div>'+
        s.warnings.map(w => '<div class="wi">• '+escapeHtml(w)+'</div>').join('')+'</div>';
    } else {
      $('warnings').innerHTML = '';
    }

    // recent activity (newest first) + always-available "出力ログを開く"
    let actHtml = '';
    if (s.activity && s.activity.length>0) {
      const ic = { ok:'✓', error:'✗', run:'▶' };
      actHtml += '<div class="alabel">最近の操作</div>'+
        s.activity.map(a => '<div class="ai '+escapeAttr(a.status)+'">'+(ic[a.status]||'•')+' '+
          escapeHtml(a.label)+'<span class="rel">'+escapeHtml(a.rel)+'</span></div>').join('');
    }
    if (s.hasRepo || (s.activity && s.activity.length>0)) {
      actHtml += '<div class="ai loglink" data-cmd="teamflow.showLog" role="button" tabindex="0" aria-label="実行ログを開く">🔎 実行ログ</div>';
    }
    $('activity').innerHTML = actHtml;

    // setup progress strip (non-clickable) — the hero above is the single CTA,
    // so there is no duplicate "始める" button to confuse. Shows where you are
    // in the 2-step setup. Git is NOT a step here; it starts automatically the
    // first time you press 保存してバックアップ.
    if (!s.hasProject || s.orgs.length===0 || !s.configured) {
      const d0 = s.hasProject, d1 = s.orgs.length>0, d2 = s.configured;
      const cls = (done, prevDone) => done ? 'done' : (prevDone ? 'now' : '');
      $('setup').innerHTML = '<div class="setupbar">'+
        '<span class="'+(d0?'done':'now')+'">'+(d0?'✓':'①')+' プロジェクト作成</span><span class="sep">→</span>'+
        '<span class="'+cls(d1,d0)+'">'+(d1?'✓':'②')+' 環境を認証</span><span class="sep">→</span>'+
        '<span class="'+cls(d2,d1)+'">'+(d2?'✓':'③')+' 環境を設定</span></div>';
    } else {
      $('setup').innerHTML = '';
    }

    // changed-files preview (what "保存してバックアップ" will save) — collapsed by default
    if (s.hasRepo && s.files && s.files.length>0) {
      const rows = s.files.map(f =>
        '<div class="fileitem"><span class="filetag">'+escapeHtml(f.label)+'</span>'+
        '<span class="filepath">'+escapeHtml(f.path)+'</span></div>').join('');
      $('changedbox').innerHTML = '<details class="changed"><summary><span class="caret">▶</span>'+
        '📝 保存される変更 '+s.files.length+'件</summary><div class="filelist">'+rows+'</div></details>';
    } else {
      $('changedbox').innerHTML = '';
    }

    // grouped action sections — progressive disclosure:
    //  * brand-new project (no repo / no org / no config): hide all actions,
    //    the hero + checklist alone guide the first run.
    //  * otherwise: show the daily essentials (core) and tuck the rest behind
    //    a "もっと操作" expander so the screen is not a wall of buttons.
    function tileEnabled(t) {
      if (t.need==='project' && !s.hasProject) return false;
      if (t.need==='repo' && !s.hasRepo) return false;
      if (t.need==='remote' && !s.hasRemote) return false;
      if (t.need==='org' && s.orgs.length===0) return false;
      return true;
    }
    function tileHtml(t) {
      const disabled = !tileEnabled(t);
      let badge = '';
      if (t.badge==='changes' && s.changes>0) badge = '<span class="badge">'+s.changes+'</span>';
      if (t.badge==='ahead' && s.ahead>0) badge = '<span class="badge">'+s.ahead+'</span>';
      if (t.badge==='deploy' && s.deployCount>0) badge = '<span class="badge">'+s.deployCount+'</span>';
      const tip = t.desc ? ' title="'+escapeAttr(t.desc)+'"' : '';
      return '<button class="tile '+(na.c===t.c?'primary':'')+'" data-cmd="'+t.c+'" '+(disabled?'disabled':'')+tip+'>'+
        badge+'<span class="em">'+t.em+'</span><span>'+escapeHtml(t.label)+'</span></button>';
    }
    function renderSec(sec) {
      const hint = sec.hint ? '<span class="sechint">'+sec.hint+'</span>' : '';
      // 今の状態で1つも使えないグループは初期状態で畳む（煩雑さ低減・段階的開示）。
      // セットアップが進むと自然に開く。ユーザーはいつでも展開できる。
      const open = sec.tiles.some(tileEnabled) ? ' open' : '';
      return '<details class="secfold"'+open+'><summary class="sechead"><span class="caret">▸</span><span class="stepno">'+sec.no+'</span>'+
        '<span class="sectitle">'+sec.title+'</span>'+hint+'</summary>'+
        '<div class="grid '+(sec.three?'three':'')+'">'+sec.tiles.map(tileHtml).join('')+'</div></details>';
    }
    {
      // 機能ごとのグループを明確なタイトルで全表示。スクラッチ作成系は
      // 「環境」セクションの操作としてそちらに置く。
      $('sections').innerHTML = SECTIONS.map(renderSec).join('');
    }

    // branch — 今いる作業ブランチの切替・新規作成。
    if (s.hasRepo) {
      const opts = s.branches.map(b => '<option '+(b===s.branch?'selected':'')+'>'+escapeHtml(b)+'</option>').join('');
      $('branchbox').innerHTML = '<div class="row"><select id="branchsel">'+opts+'</select>'+
        '<button class="iconbtn" id="newbranch" title="新しい作業ブランチ">＋ 新規</button></div>';
      $('branchsel').addEventListener('change', (e)=> send('switchBranch', { name: e.target.value }));
      $('newbranch').addEventListener('click', ()=> cmd('teamflow.gitNewBranch'));
    } else {
      $('branchbox').innerHTML = '<div class="empty">「③ 保存 → 💾 バックアップ」でGitを始めると、ここで作業ブランチを切り替えられます。</div>';
    }

    // 環境一覧 + 環境を作る操作（追加 / Dev Hub準備 / スクラッチ作成）をまとめる。
    const addBtn = '<button class="iconbtn addorg" data-cmd="teamflow.authorizeOrg">＋ 環境を追加</button>'+
      SCRATCH_SECTION.tiles.map(t => '<button class="iconbtn" data-cmd="'+t.c+'" title="'+escapeAttr(t.desc)+'">'+t.em+' '+escapeHtml(t.label)+'</button>').join('');
    if (s.orgs.length===0) {
      $('orgs').innerHTML = '<div class="empty">まだ環境がありません。「＋ 環境を追加」でログインします。</div>' + addBtn;
    } else {
      const colors = { Production:'#e5534b', Sandbox:'#4aa3df', DevHub:'#b07cf0', Scratch:'#3fb950', Other:'#888' };
      // 種別を日本語の説明で表示（英語のカテゴリ名だと初心者に伝わらないため）。
      const KIND = { Production:'本番（お客様が使う）', Sandbox:'検証用（本番のコピー）', DevHub:'スクラッチの親（使い捨て環境を作る元）', Scratch:'使い捨ての開発環境', Other:'その他' };
      const cards = s.orgs.map(o => {
        // 期限切れスクラッチは操作不能なので「掃除（削除）」だけ出す。
        const action = o.expired
          ? '<button class="open delscratch" data-delscratch="'+escapeAttr(o.username)+'">🗑 掃除</button>'
          : (o.connected
            ? '<button class="open" data-open="'+escapeAttr(o.username)+'">開く</button>'
            : '<button class="open reconnect" data-reconnect="'+escapeAttr(o.username)+'">再接続</button>');
        const expiryTag = o.expired
          ? ' · <span class="expiredtag">⏳期限切れ</span>'
          : (o.expires?' · ⏳'+escapeHtml(o.expires):'');
        return '<div class="card '+(o.isDefault?'active':'')+(o.connected?'':' disc')+(o.expired?' expired':'')+'" data-org="'+escapeAttr(o.username)+'" role="button" tabindex="0" aria-label="'+escapeAttr(o.displayName+' を既定に設定')+'">'+
          '<span class="dot" style="background:'+(colors[o.category]||'#888')+'"></span>'+
          '<span class="name">'+(o.isDefault?'★ ':'')+escapeHtml(o.displayName)+
            (o.isProduction?' ⚠️':'')+(o.connected?'':' 🔌未接続')+
            '<div class="cat">'+escapeHtml(KIND[o.category]||o.category)+expiryTag+'</div></span>'+
          action+
        '</div>';
      }).join('');
      $('orgs').innerHTML = addBtn +
        '<details class="orgfold" open><summary>一覧（'+s.orgs.length+'）— クリックで開閉</summary>'+
        '<div class="orglist">'+cards+'</div></details>';
    }
  }

  function escapeHtml(s){ return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function escapeAttr(s){ return String(s).replace(/"/g,'&quot;'); }

  // Shared activation so mouse click and keyboard (Enter/Space) behave the same.
  function activateFrom(target) {
    const rc = target.closest('[data-reconnect]');
    if (rc) { send('reconnect', { username: rc.getAttribute('data-reconnect') }); return true; }
    const del = target.closest('[data-delscratch]');
    if (del) { send('deleteScratch', { username: del.getAttribute('data-delscratch') }); return true; }
    const open = target.closest('[data-open]');
    if (open) { send('openOrg', { username: open.getAttribute('data-open') }); return true; }
    const of = target.closest('[data-openfile]');
    if (of) { send('openFile', { path: of.getAttribute('data-openfile') }); return true; }
    const tile = target.closest('[data-cmd]');
    if (tile && !tile.disabled) { cmd(tile.getAttribute('data-cmd')); return true; }
    const card = target.closest('[data-org]');
    if (card) { send('setOrg', { username: card.getAttribute('data-org') }); return true; }
    return false;
  }
  document.addEventListener('click', (e)=>{ activateFrom(e.target); });
  document.addEventListener('keydown', (e)=>{
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Native <button>/<select> already handle their own keys.
    const t = e.target;
    if (t && (t.tagName === 'BUTTON' || t.tagName === 'SELECT')) return;
    if (activateFrom(t)) { e.preventDefault(); }
  });

  window.addEventListener('message', (e)=>{ if (e.data?.type==='state') render(e.data.payload); });
  send('ready');
</script>
</body>
</html>`;
  }
}

function nonceString(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
