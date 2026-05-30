import * as vscode from "vscode";
import { OrgTreeProvider } from "../orgManager/orgTreeProvider.js";
import {
  isGitRepo,
  status,
  hasRemote,
  listBranches,
  switchBranch,
} from "../deploy/gitService.js";
import { configExists, loadConfig } from "../config/configStore.js";
import { resolveEnvironment } from "../config/teamflowConfig.js";
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
}

/**
 * The primary, click-first interface: a sidebar webview that surfaces the few
 * actions a junior dev does daily as big buttons, the orgs as selectable cards,
 * and the branch as a dropdown — so almost nothing needs to be typed and there
 * is little to read. The heavy logic still lives in the tested command/service
 * layer; this view just dispatches to it and renders live state.
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
        } catch {
          /* ignore */
        }
        remote = await hasRemote(root).catch(() => false);
        branches = await listBranches(root).catch(() => []);
        if (configured && branch) {
          try {
            const cfg = await loadConfig(root);
            const e = cfg ? resolveEnvironment(cfg, branch) : undefined;
            if (e) {
              env = { name: e.name, type: e.type };
            }
          } catch {
            /* config optional */
          }
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 10px 8px 24px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; margin: 16px 2px 6px; font-weight: 600; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 14px; font-size: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.prod { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); outline: 1px solid #e55; }
  .chip.dim { opacity: .6; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  button.tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 14px 6px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); cursor: pointer; font-size: 12px; line-height: 1.2; min-height: 64px; transition: filter .1s; }
  button.tile:hover:not(:disabled) { filter: brightness(1.15); }
  button.tile .em { font-size: 22px; }
  button.tile.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button.tile:disabled { opacity: .4; cursor: default; }
  .badge { background: var(--vscode-activityBarBadge-background, #d33); color: var(--vscode-activityBarBadge-foreground,#fff); border-radius: 9px; padding: 0 6px; font-size: 11px; margin-left: 2px; }
  .card { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 8px; margin-bottom: 6px; cursor: pointer; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card.active { outline: 2px solid var(--vscode-focusBorder); }
  .card .dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; }
  .card .name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .cat { font-size: 11px; opacity: .6; }
  .card .open { font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border,#8884); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
  .row { display: flex; gap: 6px; align-items: center; }
  select { flex: 1; padding: 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 6px; }
  .iconbtn { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--vscode-panel-border,#8884); background: var(--vscode-button-secondaryBackground,#3a3d41); color: var(--vscode-button-secondaryForeground,#fff); cursor: pointer; }
  .step { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
  .step:hover { background: var(--vscode-list-hoverBackground); }
  .step .mk { font-size: 16px; }
  .step.done { opacity: .55; }
  .empty { opacity: .6; font-size: 12px; padding: 6px 2px; }
</style>
</head>
<body>
  <div id="status" class="chips"></div>
  <div id="setup"></div>

  <h2>クイック操作</h2>
  <div id="actions" class="grid"></div>

  <h2>ブランチ</h2>
  <div id="branchbox"></div>

  <h2>接続中の Org</h2>
  <div id="orgs"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function send(type, extra) { vscode.postMessage(Object.assign({ type }, extra || {})); }
  function cmd(c) { send('command', { command: c }); }

  const TILES = [
    { c: 'teamflow.gitCommitPush', em: '💾', label: '保存して\\nバックアップ', primary: true, need: 'repo', badge: 'changes' },
    { c: 'teamflow.gitSync',       em: '🔄', label: 'GitHubと同期', need: 'remote' },
    { c: 'teamflow.deployDiff',    em: '☁️', label: 'デプロイ', need: 'repo' },
    { c: 'teamflow.validateDiff',  em: '✅', label: '検証 (お試し)', need: 'repo' },
    { c: 'teamflow.sourcePull',    em: '⬇️', label: 'Orgから取込', need: 'org' },
    { c: 'teamflow.sourcePush',    em: '⬆️', label: 'Orgへ反映', need: 'org' },
    { c: 'teamflow.retrieveMetadata', em: '📥', label: 'メタデータ取得', need: 'org' },
    { c: 'teamflow.createScratchOrg', em: '🧪', label: 'スクラッチ作成' },
    { c: 'teamflow.authorizeOrg',  em: '🔌', label: 'Orgを追加' },
    { c: 'teamflow.openWorkflowGuide', em: '📘', label: 'ガイド' },
  ];

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
      if (s.ahead>0||s.behind>0) chips.push('<span class="chip">⬆️'+s.ahead+' ⬇️'+s.behind+'</span>');
    }
    $('status').innerHTML = chips.join('');

    // setup checklist (only when something is missing)
    const setupSteps = [];
    if (!s.hasRepo) setupSteps.push({ done:false, mk:'⭕', label:'バージョン管理を始める', c:'teamflow.guidedSetup' });
    if (s.orgs.length===0) setupSteps.push({ done:false, mk:'⭕', label:'Orgを認証する', c:'teamflow.authorizeOrg' });
    if (!s.configured) setupSteps.push({ done:false, mk:'⭕', label:'チーム設定を作る', c:'teamflow.initTeamProject' });
    if (setupSteps.length>0) {
      $('setup').innerHTML = '<h2>はじめの設定</h2>' + setupSteps.map(st =>
        '<div class="step" data-cmd="'+st.c+'"><span class="mk">'+st.mk+'</span><span>'+st.label+'</span></div>').join('');
    } else { $('setup').innerHTML = ''; }

    // action tiles
    $('actions').innerHTML = TILES.map(t => {
      let disabled = false;
      if (t.need==='repo' && !s.hasRepo) disabled = true;
      if (t.need==='remote' && !s.hasRemote) disabled = true;
      if (t.need==='org' && s.orgs.length===0) disabled = true;
      let badge = '';
      if (t.badge==='changes' && s.changes>0) badge = '<span class="badge">'+s.changes+'</span>';
      return '<button class="tile '+(t.primary?'primary':'')+'" data-cmd="'+t.c+'" '+(disabled?'disabled':'')+'>'+
        '<span class="em">'+t.em+'</span><span>'+t.label.replace(/\\n/g,'<br>')+badge+'</span></button>';
    }).join('');

    // branch
    if (s.hasRepo) {
      const opts = s.branches.map(b => '<option '+(b===s.branch?'selected':'')+'>'+escapeHtml(b)+'</option>').join('');
      $('branchbox').innerHTML = '<div class="row"><select id="branchsel">'+opts+'</select>'+
        '<button class="iconbtn" id="newbranch" title="新しい作業ブランチ">＋ 新規</button></div>';
      $('branchsel').addEventListener('change', (e)=> send('switchBranch', { name: e.target.value }));
      $('newbranch').addEventListener('click', ()=> cmd('teamflow.gitNewBranch'));
    } else {
      $('branchbox').innerHTML = '<div class="empty">バージョン管理を始めると表示されます。</div>';
    }

    // orgs
    if (s.orgs.length===0) {
      $('orgs').innerHTML = '<div class="empty">「Orgを追加」から認証してください。</div>';
    } else {
      const colors = { Production:'#e5534b', Sandbox:'#4aa3df', DevHub:'#b07cf0', Scratch:'#3fb950', Other:'#888' };
      $('orgs').innerHTML = s.orgs.map(o =>
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
