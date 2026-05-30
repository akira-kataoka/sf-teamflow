import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { OrgTreeProvider } from "../orgManager/orgTreeProvider.js";
import { isGitRepo } from "../deploy/gitService.js";
import {
  configExists,
  readSfdxPackageDirs,
  saveConfig,
} from "../config/configStore.js";
import {
  parseTeamflowConfig,
  type EnvironmentType,
  type TeamEnvironment,
} from "../config/teamflowConfig.js";
import { schemaJson } from "../config/schema.js";
import { cicdFiles } from "../cicd/templates.js";
import { writeScaffold } from "../cicd/scaffolder.js";
import { logger } from "../util/logger.js";

interface WizardEnvInput {
  name: string;
  orgAlias: string;
  branch: string;
  type: EnvironmentType;
  enabled: boolean;
  requireValidation?: boolean;
}

/**
 * A full-panel, step-by-step wizard that lets a beginner set up team
 * development — split into 開発 / ステージング / 本番 environments — almost
 * entirely by clicking (org chosen from a dropdown of authorised orgs, branch
 * from presets). It writes the same sf-teamflow.json the rest of the extension
 * reads, so there is one source of truth.
 */
export class SetupWizard {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orgTree: OrgTreeProvider,
    private readonly getRoot: () => string | undefined,
    private readonly requestRefresh: () => void
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      await this.sendInit();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "teamflow.setupWizard",
      "Salesforce Dev Manager セットアップ",
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [this.extensionUri], retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "ready":
        await this.sendInit();
        return;
      case "authorize":
        await vscode.commands.executeCommand("teamflow.authorizeOrg");
        return;
      case "refreshOrgs":
        await this.orgTree.ensureOrgsLoaded(true);
        await this.sendInit();
        return;
      case "command":
        if (typeof msg.command === "string") {
          await vscode.commands.executeCommand(msg.command);
          // Project/org/repo state may have changed — re-check after a beat.
          setTimeout(() => void this.sendInit(), 800);
        }
        return;
      case "create":
        await this.create(msg.environments as WizardEnvInput[], Boolean(msg.generateCI));
        return;
    }
  }

  private async sendInit(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const root = this.getRoot();
    const orgs = await this.orgTree.ensureOrgsLoaded().catch(() => []);
    let hasProject = false;
    if (root) {
      hasProject = await fs
        .access(path.join(root, "sfdx-project.json"))
        .then(() => true)
        .catch(() => false);
    }
    const payload = {
      hasRoot: Boolean(root),
      hasProject,
      hasRepo: root ? await isGitRepo(root) : false,
      alreadyConfigured: root ? await configExists(root) : false,
      orgs: orgs.map((o) => ({
        value: o.alias || o.username,
        label: o.displayName,
        category: o.category,
        isProduction: o.isProduction,
      })),
    };
    await this.panel.webview.postMessage({ type: "init", payload });
  }

  private async create(envInputs: WizardEnvInput[], generateCI: boolean): Promise<void> {
    const root = this.getRoot();
    if (!root) {
      vscode.window.showErrorMessage("フォルダを開いてください。");
      return;
    }
    const enabled = (envInputs || []).filter((e) => e.enabled && e.orgAlias && e.branch);
    if (enabled.length === 0) {
      this.panel?.webview.postMessage({
        type: "error",
        message: "少なくとも1つの環境にOrgとブランチを設定してください。",
      });
      return;
    }

    const packageDirs = await readSfdxPackageDirs(root);
    const environments: TeamEnvironment[] = enabled.map((e) => ({
      name: e.name,
      orgAlias: e.orgAlias,
      branch: e.branch,
      type: e.type,
      testLevel: "RunLocalTests",
      requireValidation: e.type === "production" || e.requireValidation === true,
    }));

    // Validate through the same parser used at load time.
    let config;
    try {
      config = parseTeamflowConfig({
        version: 1,
        defaultBaseRef: "origin/main",
        testLevel: "RunLocalTests",
        packageDirectories: packageDirs,
        environments,
      });
    } catch (err) {
      this.panel?.webview.postMessage({ type: "error", message: String(err) });
      return;
    }

    try {
      await saveConfig(root, config);
      await writeScaffold(
        root,
        [{ relativePath: "sf-teamflow.schema.json", content: schemaJson() }],
        true
      );
      let ciResult = "";
      if (generateCI) {
        const res = await writeScaffold(root, cicdFiles(config), false);
        ciResult = `CI/CD: 作成 ${res.written.length} / スキップ ${res.skipped.length}`;
      }
      this.requestRefresh();
      this.panel?.webview.postMessage({
        type: "done",
        message: `sf-teamflow.json を作成しました（${config.environments.length}環境）。${ciResult}`,
      });
      // Open the generated config so they can see the result.
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(`${root}/sf-teamflow.json`)
      );
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } catch (err) {
      logger.error("設定の作成に失敗", err);
      this.panel?.webview.postMessage({ type: "error", message: String(err) });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceString();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); max-width: 760px; margin: 0 auto; padding: 24px 20px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { opacity: .7; font-size: 13px; margin-bottom: 20px; }
  .steps { display: flex; gap: 8px; margin-bottom: 22px; }
  .stepdot { display: flex; align-items: center; gap: 7px; font-size: 12.5px; opacity: .5; }
  .stepdot.active { opacity: 1; font-weight: 600; }
  .stepdot .n { width: 22px; height: 22px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); display: flex; align-items: center; justify-content: center; font-size: 12px; }
  .stepdot.active .n { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .stepdot .arrow { opacity: .4; margin: 0 2px; }
  .page { display: none; }
  .page.show { display: block; }
  .panel { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 16px; margin-bottom: 14px; }
  .check { display: flex; align-items: center; gap: 10px; padding: 8px 0; font-size: 13.5px; }
  .check .ic { font-size: 18px; }
  .envcard { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  .envcard.off { opacity: .55; }
  .envhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .envhead .emoji { font-size: 20px; }
  .envhead .title { font-size: 15px; font-weight: 600; }
  .envhead .desc { font-size: 12px; opacity: .65; }
  .envhead label { margin-left: auto; font-size: 12px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .field { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
  .field > .lbl { width: 92px; font-size: 12.5px; opacity: .8; flex: 0 0 auto; }
  select, input[type=text] { flex: 1; padding: 7px 8px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 6px; font-size: 13px; }
  .row { display: flex; justify-content: space-between; gap: 10px; margin-top: 18px; }
  button { padding: 9px 18px; border-radius: 7px; border: none; cursor: pointer; font-size: 13.5px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  button:disabled { opacity: .4; cursor: default; }
  .hint { font-size: 12px; opacity: .7; margin: 6px 0 0; }
  pre { background: var(--vscode-textCodeBlock-background, #00000033); padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; }
  .warn { color: var(--vscode-inputValidation-warningForeground, #d80); }
  .err { color: #e66; font-size: 13px; margin-top: 8px; }
  .ok { color: #3fb950; }
  label.chk { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 10px; cursor: pointer; }
  .toggle { width: 16px; height: 16px; }
  .nextstep { display: flex; align-items: flex-start; gap: 10px; padding: 10px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 8px; margin-bottom: 8px; cursor: pointer; }
  .nextstep:hover { background: var(--vscode-list-hoverBackground); }
  .nextstep > span { width: 22px; height: 22px; flex: 0 0 auto; border-radius: 50%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); display: flex; align-items: center; justify-content: center; font-size: 12px; }
  .nextstep b { font-size: 13.5px; }
</style>
</head>
<body>
  <h1>🧭 チーム開発セットアップ</h1>
  <div class="sub">3ステップで、開発 / ステージング / 本番 の環境を分けたチーム開発を設定します。</div>

  <div class="steps">
    <div class="stepdot active" data-dot="1"><span class="n">1</span>準備の確認</div>
    <span class="arrow">›</span>
    <div class="stepdot" data-dot="2"><span class="n">2</span>環境を分ける</div>
    <span class="arrow">›</span>
    <div class="stepdot" data-dot="3"><span class="n">3</span>確認して作成</div>
  </div>

  <!-- STEP 1 -->
  <div class="page show" data-page="1">
    <div class="panel" id="checks"></div>
    <p class="hint">Org が未認証でも先に進めます（後でホーム画面から追加できます）。</p>
    <div class="row"><span></span><button class="primary" id="to2">次へ ›</button></div>
  </div>

  <!-- STEP 2 -->
  <div class="page" data-page="2">
    <p class="hint">それぞれの環境に、使う Org とブランチを選びます。使わない環境はオフにできます。</p>
    <div id="envs"></div>
    <div class="row"><button class="secondary" id="back2">‹ 戻る</button><button class="primary" id="to3">次へ ›</button></div>
  </div>

  <!-- STEP 3 -->
  <div class="page" data-page="3">
    <p class="hint">この内容で <code>sf-teamflow.json</code> を作成します。</p>
    <pre id="preview"></pre>
    <label class="chk"><input type="checkbox" class="toggle" id="genci" checked> GitHub Actions の CI/CD も生成する（PR検証・自動デプロイ）</label>
    <div id="err" class="err"></div>
    <div id="result"></div>
    <div class="row"><button class="secondary" id="back3">‹ 戻る</button><button class="primary" id="create">この内容で作成する</button></div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  let ORGS = [];

  const ENV_DEFS = [
    { key:'development', emoji:'🛠️', title:'開発 (Development)', desc:'各開発者が日々使う環境', type:'sandbox', branch:'develop', on:true },
    { key:'staging', emoji:'🧪', title:'ステージング (Staging)', desc:'本番前の受入テスト', type:'sandbox', branch:'release/*', on:true },
    { key:'production', emoji:'🛡️', title:'本番 (Production)', desc:'お客様が使う環境', type:'production', branch:'main', on:true },
  ];
  const BRANCH_PRESETS = ['develop','release/*','main','feature/*','hotfix/*'];

  function showPage(n) {
    $$('.page').forEach(p => p.classList.toggle('show', p.dataset.page == n));
    $$('.stepdot').forEach(d => d.classList.toggle('active', d.dataset.dot == n));
    if (n == 3) renderPreview();
  }

  function orgOptions(selected) {
    const none = '<option value="">（未設定 / 後で）</option>';
    return none + ORGS.map(o => '<option value="'+esc(o.value)+'" '+(o.value===selected?'selected':'')+'>'+
      esc(o.label)+' — '+o.category+(o.isProduction?' ⚠️本番':'')+'</option>').join('');
  }
  function branchOptions(selected) {
    const has = BRANCH_PRESETS.includes(selected);
    return BRANCH_PRESETS.map(b => '<option '+(b===selected?'selected':'')+'>'+esc(b)+'</option>').join('') +
      (has?'':'<option selected>'+esc(selected)+'</option>');
  }

  function renderEnvs() {
    $('#envs').innerHTML = ENV_DEFS.map((e,i) =>
      '<div class="envcard '+(e.on?'':'off')+'" data-env="'+i+'">'+
        '<div class="envhead"><span class="emoji">'+e.emoji+'</span>'+
          '<span><div class="title">'+e.title+'</div><div class="desc">'+e.desc+'</div></span>'+
          '<label><input type="checkbox" class="toggle enable" data-i="'+i+'" '+(e.on?'checked':'')+'> 使う</label></div>'+
        '<div class="field"><span class="lbl">Org</span><select class="org" data-i="'+i+'">'+orgOptions(e.orgAlias)+'</select></div>'+
        '<div class="field"><span class="lbl">ブランチ</span><select class="branch" data-i="'+i+'">'+branchOptions(e.branch)+'</select></div>'+
      '</div>').join('');
    $$('.enable').forEach(el => el.addEventListener('change', (ev)=>{ ENV_DEFS[ev.target.dataset.i].on = ev.target.checked; renderEnvs(); }));
    $$('.org').forEach(el => el.addEventListener('change', (ev)=>{ ENV_DEFS[ev.target.dataset.i].orgAlias = ev.target.value; }));
    $$('.branch').forEach(el => el.addEventListener('change', (ev)=>{ ENV_DEFS[ev.target.dataset.i].branch = ev.target.value; }));
  }

  function collect() {
    return ENV_DEFS.map(e => ({ name:e.key, orgAlias:e.orgAlias||'', branch:e.branch, type:e.type, enabled:e.on, requireValidation: e.type!=='sandbox' }));
  }

  function renderPreview() {
    const envs = collect().filter(e => e.enabled && e.orgAlias && e.branch).map(e => ({
      name:e.name, orgAlias:e.orgAlias, branch:e.branch, type:e.type, testLevel:'RunLocalTests',
      requireValidation: e.type==='production' || e.requireValidation
    }));
    const cfg = { "$schema":"./sf-teamflow.schema.json", version:1, defaultBaseRef:"origin/main", testLevel:"RunLocalTests", packageDirectories:["force-app"], environments: envs };
    $('#preview').textContent = JSON.stringify(cfg, null, 2);
    $('#create').disabled = envs.length === 0;
  }

  function renderChecks(s) {
    // btn: { act } posts {type:act}; { cmd } posts {type:'command', command}.
    const line = (ok, okTxt, ngTxt, btn) =>
      '<div class="check"><span class="ic">'+(ok?'✅':'⭕')+'</span><span>'+(ok?okTxt:ngTxt)+'</span>'+
      (ok||!btn?'':' <button class="secondary" style="margin-left:auto" '+
        (btn.cmd?('data-cmd="'+btn.cmd+'"'):('data-act="'+btn.act+'"'))+'>'+btn.label+'</button>')+'</div>';
    $('#checks').innerHTML =
      line(s.hasProject, 'Salesforceプロジェクトが準備できています', 'プロジェクト(sfdx-project.json)がありません',
        { cmd:'teamflow.createProject', label:'プロジェクトを作成' }) +
      line(s.hasRepo, 'バージョン管理(Git)が有効です', 'Gitはまだ無効です（後で開始できます）', null) +
      line(s.orgs.length>0, s.orgs.length+'個のOrgを認証済み', 'Orgが未認証です', {act:'authorize', label:'Orgを認証'}) +
      (s.alreadyConfigured ? '<div class="check"><span class="ic warn">⚠️</span><span class="warn">既に設定済み — 作成すると上書きされます</span></div>' : '');
    $$('#checks [data-act]').forEach(b => b.addEventListener('click', ()=> vscode.postMessage({type:b.dataset.act})));
    $$('#checks [data-cmd]').forEach(b => b.addEventListener('click', ()=> vscode.postMessage({type:'command', command:b.dataset.cmd})));
  }

  function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  $('#to2').addEventListener('click', ()=>{ renderEnvs(); showPage(2); });
  $('#back2').addEventListener('click', ()=> showPage(1));
  $('#to3').addEventListener('click', ()=> showPage(3));
  $('#back3').addEventListener('click', ()=> showPage(2));
  $('#create').addEventListener('click', ()=>{
    $('#err').textContent='';
    vscode.postMessage({ type:'create', environments: collect(), generateCI: $('#genci').checked });
  });

  window.addEventListener('message', (e)=>{
    const m = e.data;
    if (m.type==='init') { ORGS = m.payload.orgs || []; renderChecks(m.payload); if ($('.page[data-page="2"]').classList.contains('show')) renderEnvs(); }
    else if (m.type==='error') { $('#err').textContent = '⚠️ ' + m.message; }
    else if (m.type==='done') {
      $('#create').disabled = true;
      $('#result').innerHTML =
        '<div class="check"><span class="ic ok">✅</span><span class="ok">'+esc(m.message)+'</span></div>'+
        '<div class="panel" style="margin-top:14px"><div style="font-weight:600;margin-bottom:8px">🚀 チーム開発を始める</div>'+
        '<div class="hint" style="margin:0 0 10px">チームのメンバーが同じ環境で開発できるよう、次の3つを行いましょう。</div>'+
        '<div class="nextstep" data-cmd="teamflow.gitPublish"><span>1</span><div><b>GitHubに公開</b><div class="hint">コードを共有リポジトリに置く（gh 連携）</div></div></div>'+
        '<div class="nextstep" data-cmd="teamflow.scaffoldCICD"><span>2</span><div><b>CI/CDを生成・シークレット設定</b><div class="hint">PR検証/自動デプロイ。SF_&lt;ENV&gt;_CLIENT_ID 等をGitHubに登録</div></div></div>'+
        '<div class="nextstep" data-cmd="teamflow.openWorkflowGuide"><span>3</span><div><b>チーム開発ガイドを開く</b><div class="hint">ブランチ運用・メンバー招待・Branch protection</div></div></div>'+
        '</div>';
      $$('#result .nextstep').forEach(b => b.addEventListener('click', ()=> vscode.postMessage({type:'command', command:b.dataset.cmd})));
    }
  });

  vscode.postMessage({ type:'ready' });
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
