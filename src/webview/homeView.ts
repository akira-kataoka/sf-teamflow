import * as vscode from "vscode";
import { OrgTreeProvider } from "../orgManager/orgTreeProvider.js";
import {
  isGitRepo,
  status,
  hasRemote,
  listBranches,
  switchBranch,
  changedFiles,
  classifyChanges,
} from "../deploy/gitService.js";
import { configExists, loadConfig, readSfdxPackageDirs } from "../config/configStore.js";
import { baseRefFor, resolveEnvironment } from "../config/teamflowConfig.js";
import { runSf } from "../util/cli.js";
import { logger } from "../util/logger.js";

interface HomeOrg {
  username: string;
  displayName: string;
  category: string;
  isProduction: boolean;
  isDefault: boolean;
  connected: boolean;
}

interface HomeState {
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
    private readonly requestRefresh: () => void
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
      case "switchBranch":
        await this.doSwitchBranch(msg.name);
        return;
    }
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
    const orgsRaw = await this.orgTree.ensureOrgsLoaded().catch(() => []);
    const orgs: HomeOrg[] = orgsRaw.map((o) => ({
      username: o.username,
      displayName: o.displayName,
      category: o.category,
      isProduction: o.isProduction,
      isDefault: o.isDefaultUsername === true,
      connected: o.connected,
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

    return {
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

  /* next-action hero */
  .hero { display: flex; align-items: center; gap: 10px; padding: 12px; border-radius: 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; margin-bottom: 12px; }
  .hero .em { font-size: 26px; line-height: 1; }
  .hero .tx { flex: 1; }
  .hero .t1 { font-size: 11px; opacity: .85; }
  .hero .t2 { font-size: 14px; font-weight: 600; margin-top: 2px; }
  .hero .go { font-size: 18px; opacity: .85; }
  .hero.calm { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); cursor: default; }

  /* sections */
  section { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 8px 8px 10px; margin-bottom: 10px; }
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
  .card .open { font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border,#8884); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
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
  .setupbar { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 8px 10px; margin-bottom: 12px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 8px; opacity: .9; }
  .setupbar .done { color: #3fb950; }
  .setupbar .now { font-weight: 700; }
  .setupbar .sep { opacity: .5; }
</style>
</head>
<body>
  <div id="status" class="chips"></div>
  <div id="hero"></div>
  <div id="setup"></div>
  <div id="changedbox"></div>
  <div id="sections"></div>
  <section>
    <div class="sechead"><span class="stepno">🌿</span><span class="sectitle">作業ブランチ</span></div>
    <div id="branchbox"></div>
  </section>
  <section>
    <div class="sechead"><span class="stepno">☁️</span><span class="sectitle">接続中の Org</span><span class="sechint">クリックで切替</span></div>
    <div id="orgs"></div>
  </section>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function send(type, extra) { vscode.postMessage(Object.assign({ type }, extra || {})); }
  function cmd(c) { send('command', { command: c }); }

  // Grouped, numbered workflow — the core of the "structured, not a wall of buttons" design.
  const SECTIONS = [
    { no: '1', title: '開発する', hint: 'Orgと同期', tier: 'core', tiles: [
      { c: 'teamflow.sourcePull', em: '⬇️', label: 'Orgから取込', need: 'org', desc: 'Org側の変更をローカルに取り込みます' },
      { c: 'teamflow.sourcePush', em: '⬆️', label: 'Orgへ反映', need: 'org', desc: 'ローカルの変更をOrgに反映します' },
    ]},
    { no: '2', title: '保存する', hint: 'バックアップ', tier: 'core', tiles: [
      { c: 'teamflow.gitCommitPush', em: '💾', label: '保存してバックアップ', need: 'repo', badge: 'changes', desc: '変更を保存してGitHubに送ります' },
      { c: 'teamflow.gitSync', em: '🔄', label: 'GitHubと同期', need: 'remote', badge: 'ahead', desc: '取り込み→バックアップ' },
    ]},
    { no: '3', title: 'テスト・リリース', hint: '品質確認', tier: 'more', three: true, tiles: [
      { c: 'teamflow.runTests', em: '🧪', label: 'テスト実行', need: 'org', desc: 'Apexテストを実行します' },
      { c: 'teamflow.validateDiff', em: '✅', label: '検証（お試し）', need: 'repo', badge: 'deploy', desc: 'デプロイせず差分を検証' },
      { c: 'teamflow.deployToEnvironment', em: '🚀', label: '環境へデプロイ', need: 'repo', badge: 'deploy', desc: '開発/ステージング/本番を選んでデプロイ' },
    ]},
    { no: '4', title: 'バージョン管理', hint: 'ブランチ/タグ', tier: 'more', tiles: [
      { c: 'teamflow.manageBranches', em: '🌿', label: 'ブランチ管理', need: 'repo', desc: '切替/作成/削除' },
      { c: 'teamflow.manageTags', em: '🏷️', label: 'タグ管理', need: 'repo', desc: 'リリースの目印' },
    ]},
    { no: '⋯', title: 'その他', hint: '', tier: 'more', three: true, tiles: [
      { c: 'teamflow.retrieveMetadata', em: '📥', label: 'メタデータ取得', need: 'org', desc: '既存Orgから取り込み' },
      { c: 'teamflow.createScratchOrg', em: '🌱', label: 'スクラッチ作成', desc: '使い捨て開発Org' },
      { c: 'teamflow.openWorkflowGuide', em: '📘', label: 'ガイド', desc: '進め方を見る' },
    ]},
  ];

  function nextAction(s) {
    // Single, unambiguous "what to do next". Setup is one ordered flow:
    //   ① Orgを認証 → ② 環境を設定。git は「保存」時に自動で開始するので
    // ここでは別アクションとして出さない（重複ラベルの混乱を避ける）。
    if (s.orgs.length === 0) return { em:'🔌', t1:'はじめに（1/2）', t2:'Orgを認証する', c:'teamflow.authorizeOrg' };
    if (!s.configured) return { em:'🧭', t1:'はじめに（2/2）', t2:'環境を設定する（開発/ステージング/本番）', c:'teamflow.setupWizard' };
    if (s.changes > 0) return { em:'💾', t1:'次にやること', t2:'変更 '+s.changes+'件を保存してバックアップ', c:'teamflow.gitCommitPush' };
    if (s.ahead > 0) return { em:'🔄', t1:'次にやること', t2:'未バックアップ '+s.ahead+'件をGitHubへ', c:'teamflow.gitSync' };
    return { em:'✅', t1:'準備OK', t2:'変更を加えたら自動でここに表示されます', calm:true };
  }

  function render(s) {
    // status chips
    const chips = [];
    if (s.defaultOrg) {
      chips.push('<span class="chip ' + (s.defaultOrg.isProduction?'prod':'') + '">☁️ ' +
        (s.defaultOrg.isProduction?'⚠️ ':'') + escapeHtml(s.defaultOrg.displayName) + '</span>');
    } else {
      chips.push('<span class="chip dim">☁️ Org未選択</span>');
    }
    if (s.hasRepo) {
      let b = '🌿 ' + escapeHtml(s.branch || '(なし)');
      if (s.env) b += ' → ' + escapeHtml(s.env.name);
      chips.push('<span class="chip">' + b + '</span>');
    }
    $('status').innerHTML = chips.join('');

    // next-action hero
    const na = nextAction(s);
    $('hero').innerHTML = '<div class="hero '+(na.calm?'calm':'')+'" '+(na.c?'data-cmd="'+na.c+'"':'')+'>'+
      '<span class="em">'+na.em+'</span><span class="tx"><div class="t1">'+na.t1+'</div>'+
      '<div class="t2">'+escapeHtml(na.t2)+'</div></span>'+(na.c?'<span class="go">▶</span>':'')+'</div>';

    // setup progress strip (non-clickable) — the hero above is the single CTA,
    // so there is no duplicate "始める" button to confuse. Shows where you are
    // in the 2-step setup. Git is NOT a step here; it starts automatically the
    // first time you press 保存してバックアップ.
    if (s.orgs.length===0 || !s.configured) {
      const d1 = s.orgs.length>0, d2 = s.configured;
      $('setup').innerHTML = '<div class="setupbar"><span class="'+(d1?'done':'now')+'">'+
        (d1?'✓':'①')+' Org認証</span><span class="sep">→</span><span class="'+(d2?'done':(d1?'now':''))+'">'+
        (d2?'✓':'②')+' 環境設定</span></div>';
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
    function renderSec(sec) {
      const tiles = sec.tiles.map(t => {
        let disabled = false;
        if (t.need==='repo' && !s.hasRepo) disabled = true;
        if (t.need==='remote' && !s.hasRemote) disabled = true;
        if (t.need==='org' && s.orgs.length===0) disabled = true;
        let badge = '';
        if (t.badge==='changes' && s.changes>0) badge = '<span class="badge">'+s.changes+'</span>';
        if (t.badge==='ahead' && s.ahead>0) badge = '<span class="badge">'+s.ahead+'</span>';
        if (t.badge==='deploy' && s.deployCount>0) badge = '<span class="badge">'+s.deployCount+'</span>';
        const tip = t.desc ? ' title="'+escapeAttr(t.desc)+'"' : '';
        return '<button class="tile '+(na.c===t.c?'primary':'')+'" data-cmd="'+t.c+'" '+(disabled?'disabled':'')+tip+'>'+
          badge+'<span class="em">'+t.em+'</span><span>'+escapeHtml(t.label)+'</span></button>';
      }).join('');
      const hint = sec.hint ? '<span class="sechint">'+sec.hint+'</span>' : '';
      return '<section><div class="sechead"><span class="stepno">'+sec.no+'</span>'+
        '<span class="sectitle">'+sec.title+'</span>'+hint+'</div>'+
        '<div class="grid '+(sec.three?'three':'')+'">'+tiles+'</div></section>';
    }
    const fresh = s.orgs.length===0 && !s.configured;
    if (fresh) {
      $('sections').innerHTML = '';
    } else {
      const core = SECTIONS.filter(x=>x.tier==='core').map(renderSec).join('');
      const more = SECTIONS.filter(x=>x.tier==='more').map(renderSec).join('');
      $('sections').innerHTML = core +
        '<details class="more"><summary>▸ もっと操作（テスト / デプロイ / タグ / Org追加）</summary>'+more+'</details>';
    }

    // branch
    if (s.hasRepo) {
      const opts = s.branches.map(b => '<option '+(b===s.branch?'selected':'')+'>'+escapeHtml(b)+'</option>').join('');
      $('branchbox').innerHTML = '<div class="row"><select id="branchsel">'+opts+'</select>'+
        '<button class="iconbtn" id="newbranch" title="新しい作業ブランチ">＋ 新規</button></div>';
      $('branchsel').addEventListener('change', (e)=> send('switchBranch', { name: e.target.value }));
      $('newbranch').addEventListener('click', ()=> cmd('teamflow.gitNewBranch'));
    } else {
      $('branchbox').innerHTML = '<div class="empty">「セットアップを始める」で開始できます。</div>';
    }

    // orgs
    const addBtn = '<button class="iconbtn addorg" data-cmd="teamflow.authorizeOrg">＋ Orgを追加</button>';
    if (s.orgs.length===0) {
      $('orgs').innerHTML = '<div class="empty">まだOrgがありません。</div>' + addBtn;
    } else {
      const colors = { Production:'#e5534b', Sandbox:'#4aa3df', DevHub:'#b07cf0', Scratch:'#3fb950', Other:'#888' };
      $('orgs').innerHTML = addBtn + s.orgs.map(o =>
        '<div class="card '+(o.isDefault?'active':'')+'" data-org="'+escapeAttr(o.username)+'">'+
          '<span class="dot" style="background:'+(colors[o.category]||'#888')+'"></span>'+
          '<span class="name">'+(o.isDefault?'★ ':'')+escapeHtml(o.displayName)+
            (o.isProduction?' ⚠️':'')+(o.connected?'':' 🔌')+
            '<div class="cat">'+o.category+'</div></span>'+
          '<button class="open" data-open="'+escapeAttr(o.username)+'">開く</button>'+
        '</div>').join('');
    }
  }

  function escapeHtml(s){ return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function escapeAttr(s){ return String(s).replace(/"/g,'&quot;'); }

  document.addEventListener('click', (e)=>{
    const tile = e.target.closest('[data-cmd]');
    if (tile && !tile.disabled) { cmd(tile.getAttribute('data-cmd')); return; }
    const open = e.target.closest('[data-open]');
    if (open) { e.stopPropagation(); send('openOrg', { username: open.getAttribute('data-open') }); return; }
    const card = e.target.closest('[data-org]');
    if (card) { send('setOrg', { username: card.getAttribute('data-org') }); return; }
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
