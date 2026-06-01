import * as vscode from "vscode";
import * as path from "node:path";
import type { CommandContext } from "../commandContext.js";
import { renderCommand } from "../deploy/deployService.js";
import { run } from "../util/exec.js";
import { runSf, summarizeCliError } from "../util/cli.js";
import { readSfdxPackageDirs } from "../config/configStore.js";
import type { OrgInfo } from "../orgManager/orgService.js";
import { refreshDevHubAuthFlag } from "../orgManager/devHubAuth.js";
import {
  buildProjectGenerateArgs,
  buildRetrieveArgs,
  buildScratchCreateArgs,
  buildScratchDeleteArgs,
  resolveScratchDefinitionFile,
  buildSourcePullArgs,
  buildSourcePushArgs,
  buildRunTestsArgs,
  buildDeployMetadataArgs,
  buildGenerateComponentArgs,
  componentOutputDir,
  componentMainFile,
  componentNameError,
  projectNameError,
  sobjectNameError,
  testClassNamesError,
  buildTailLogArgs,
  buildDevHubOpenArgs,
  buildScratchOrgInfoProbeArgs,
  buildSetDefaultDevHubArgs,
  buildDevHubLoginArgs,
  DEVELOPER_EDITION_SIGNUP_URL,
  type ComponentKind,
  COMMON_METADATA_TYPES,
} from "./projectService.js";

export function registerProjectCommands(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // メタデータ取得など「手元を上書きし得る」操作の前に、未保存のローカル変更を警告する。
  // 続行してよければ true、ユーザーが中断したら false。
  async function confirmNoUncommittedOverwrite(): Promise<boolean> {
    const root = ctx.workspaceRoot();
    if (!root) {
      return true;
    }
    const dirs = await readSfdxPackageDirs(root).catch(() => ["force-app"]);
    const st = await run("git", ["status", "--porcelain", "--", ...dirs], {
      cwd: root,
      timeout: 10_000,
    });
    if (st.code !== 0 || !st.stdout.trim()) {
      return true; // gitでない or 変更なし → そのまま続行
    }
    const go = await vscode.window.showWarningMessage(
      "未保存のローカル変更があります。取得すると手元のファイルが上書きされる可能性があります。先にバックアップしますか？",
      { modal: true },
      "先にバックアップ",
      "このまま取得"
    );
    if (go === "先にバックアップ") {
      await vscode.commands.executeCommand("teamflow.gitCommitPush");
      return false; // バックアップ後、改めて取得してもらう
    }
    return go === "このまま取得";
  }

  async function pickOrg(placeHolder: string, filter?: (o: OrgInfo) => boolean): Promise<OrgInfo | undefined> {
    const orgs = ctx.knownOrgs().filter((o) => (filter ? filter(o) : true));
    if (orgs.length === 0) {
      vscode.window.showInformationMessage("対象の環境がありません。先に認証してください。");
      return undefined;
    }
    const def = orgs.find((o) => o.isDefaultUsername);
    const pick = await vscode.window.showQuickPick(
      orgs.map((o) => ({
        label: `${o.isDefaultUsername ? "★ " : ""}${o.displayName}`,
        description: `${o.category}${o.isProduction ? " ⚠️本番" : ""}`,
        detail: o.username,
        org: o,
      })),
      { placeHolder: def ? `${placeHolder} (既定: ${def.displayName})` : placeHolder }
    );
    return pick?.org;
  }

  /** Authorised orgs the CLI currently flags as Dev Hubs (may be empty / many). */
  function devHubOrgs(): OrgInfo[] {
    return ctx
      .knownOrgs()
      .filter((o) => o.isDevHub || o.category === "DevHub" || o.isDefaultDevHubUsername);
  }

  /** Multi-select metadata types (with a free-text "other" entry). Shared by 取得/反映. */
  async function pickMetadataTypes(title: string): Promise<string[] | undefined> {
    const CUSTOM = "$(edit) その他のメタデータ名を入力…";
    const picks = await vscode.window.showQuickPick(
      [
        ...COMMON_METADATA_TYPES.map((m) => ({
          label: m.label,
          description: m.type,
          detail: m.detail,
          type: m.type,
        })),
        { label: CUSTOM, description: "", detail: "例: Flow, CustomObject:Account", type: CUSTOM },
      ],
      { title, placeHolder: "種類を選択（複数可・絞り込み入力できます）", canPickMany: true }
    );
    if (!picks || picks.length === 0) {
      return undefined;
    }
    const metadata: string[] = [];
    for (const p of picks) {
      if (p.type === CUSTOM) {
        const custom = await vscode.window.showInputBox({
          title: "メタデータ名",
          prompt: "カンマ区切りで複数指定できます",
          placeHolder: "ApexClass, CustomObject:Account",
        });
        if (custom) {
          metadata.push(...custom.split(",").map((s) => s.trim()).filter(Boolean));
        }
      } else {
        metadata.push(p.type);
      }
    }
    return metadata;
  }

  // 新しいプロジェクトを作成 (sf project generate).
  // 名前と作成場所を尋ね、生成が終わったら自動でそのフォルダを開く（初心者が
  // 「作ったのに次に何をすればいいか分からない」状態にならないように）。
  reg("teamflow.createProject", async () => {
    const name = await vscode.window.showInputBox({
      title: "新しいSalesforceプロジェクト (1/3)",
      prompt: "プロジェクト名 (フォルダ名になります)",
      placeHolder: "my-sf-project",
      validateInput: (v) => projectNameError(v),
    });
    if (!name) {
      return;
    }
    const template = await vscode.window.showQuickPick(
      [
        { label: "標準 (standard)", description: "通常のプロジェクト（おすすめ）", value: "standard" as const },
        { label: "空 (empty)", description: "最小構成", value: "empty" as const },
      ],
      { title: "新しいSalesforceプロジェクト (2/3) — テンプレート" }
    );
    if (!template) {
      return;
    }

    // どこに作るか（親フォルダ）を選ぶ。既定は今開いているフォルダの親 or ホーム。
    const root = ctx.workspaceRoot();
    const defaultParent = root ? vscode.Uri.file(path.dirname(root)) : undefined;
    const picked = await vscode.window.showOpenDialog({
      title: "新しいSalesforceプロジェクト (3/3) — どこに作りますか？（親フォルダを選択）",
      openLabel: "ここに作成",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: defaultParent,
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const parentDir = picked[0].fsPath;
    const projectName = name.trim();
    const projectDir = path.join(parentDir, projectName);

    const args = buildProjectGenerateArgs({
      name: projectName,
      template: template.value,
      defaultPackageDir: "force-app",
      manifest: true,
    });

    // 生成を同期実行して、完了したら自動でフォルダを開く。
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `プロジェクト「${projectName}」を作成中…` },
      async () => {
        const res = await run(ctx.cliPath(), args, { cwd: parentDir, timeout: 120_000 });
        if (res.code !== 0) {
          // 失敗時は同じコマンドをターミナルにも出して、原因を見えるようにする。
          ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
          vscode.window.showErrorMessage(
            `プロジェクト作成に失敗しました。ターミナルの出力を確認してください: ${res.stderr || res.stdout}`
          );
          throw new Error("createProject failed");
        }
      }
    ).then(
      async () => {
        const openChoice = await vscode.window.showInformationMessage(
          `プロジェクト「${projectName}」を作成しました 🎉 そのフォルダを開きますか？`,
          { modal: false },
          "開く（このウィンドウ）",
          "新しいウィンドウで開く"
        );
        if (openChoice) {
          await vscode.commands.executeCommand(
            "vscode.openFolder",
            vscode.Uri.file(projectDir),
            { forceNewWindow: openChoice === "新しいウィンドウで開く" }
          );
        }
      },
      () => {
        /* 失敗時は上で通知済み */
      }
    );
  });

  // 新しいコンポーネントを作成 (Apexクラス/トリガ/LWC/Aura).
  reg("teamflow.createComponent", async () => {
    const root = ctx.workspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage("フォルダを開いてください。");
      return;
    }
    const kindPick = await vscode.window.showQuickPick(
      [
        { label: "$(symbol-class) Apexクラス", detail: "ビジネスロジック", ckind: "apexClass" as ComponentKind },
        { label: "$(zap) Apexトリガ", detail: "レコード操作時の処理", ckind: "apexTrigger" as ComponentKind },
        { label: "$(symbol-method) Lightning Web Component", detail: "画面部品(LWC)", ckind: "lwc" as ComponentKind },
        { label: "$(symbol-namespace) Auraコンポーネント", detail: "画面部品(Aura)", ckind: "aura" as ComponentKind },
      ],
      { title: "新しいコンポーネントを作成", placeHolder: "種類を選択" }
    );
    if (!kindPick) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: `${kindPick.label.replace(/^\$\([a-z-]+\)\s*/, "")} の名前`,
      prompt:
        kindPick.ckind === "lwc" ? "小文字始まり (例: accountSearch)" : "英字始まり (例: AccountService)",
      validateInput: (v) => componentNameError(v, kindPick.ckind),
    });
    if (!name) {
      return;
    }
    let sobject: string | undefined;
    if (kindPick.ckind === "apexTrigger") {
      sobject = await vscode.window.showInputBox({
        title: "対象オブジェクト (任意)",
        prompt: "例: Account（空でもOK）",
        validateInput: (v) => sobjectNameError(v),
      });
      if (sobject === undefined) {
        return;
      }
    }
    const dirs = await readSfdxPackageDirs(root);
    const outputDir = componentOutputDir(dirs[0] || "force-app", kindPick.ckind);
    const args = buildGenerateComponentArgs(kindPick.ckind, name.trim(), outputDir, sobject || undefined);
    // 共有ターミナル経由(fire-and-forget)はターミナルがビジーだと無言で失敗するため、
    // 子プロセスで実行して成否を確実に捕捉する。
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${name.trim()} を作成中…` },
      () => run(ctx.cliPath(), args, { cwd: root, timeout: 120_000 })
    );
    if (res.code !== 0) {
      const detail = summarizeCliError(res.stderr, res.stdout);
      vscode.window.showErrorMessage(
        `作成に失敗しました: ${detail || "不明なエラー（sf CLI が見つからない可能性）"}`
      );
      ctx.recordActivity(`新規作成: ${name.trim()}`, "error");
      return;
    }
    ctx.recordActivity(`新規作成: ${name.trim()}`, "ok");
    ctx.refreshAll();
    // 生成された主要ファイルを開いて「本当にできた」ことを確認できるようにする。
    try {
      const mainFile = path.join(root, componentMainFile(outputDir, kindPick.ckind, name.trim()));
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainFile));
      await vscode.window.showTextDocument(doc);
    } catch {
      /* 生成はできたがファイルを開けないだけ — 無視 */
    }
    vscode.window.showInformationMessage(`✅ ${name.trim()} を ${outputDir} に作成しました。`);
  });

  // メタデータを取得 (種類を選んで sf project retrieve).
  reg("teamflow.retrieveMetadata", async () => {
    const org = await pickOrg("取得元の環境を選択");
    if (!org) {
      return;
    }
    // 取得は手元のファイルを上書きし得る。未保存のローカル変更があれば警告する（データ損失防止）。
    if (!(await confirmNoUncommittedOverwrite())) {
      return;
    }
    const metadata = await pickMetadataTypes(`「${org.displayName}」から取得する種類を選択`);
    if (!metadata || metadata.length === 0) {
      return;
    }
    const args = buildRetrieveArgs({ orgUsername: org.username, metadata });
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
  });

  // package.xml (manifest) で取得.
  reg("teamflow.retrieveByManifest", async () => {
    const org = await pickOrg("取得元の環境を選択");
    if (!org) {
      return;
    }
    if (!(await confirmNoUncommittedOverwrite())) {
      return;
    }
    const found = await vscode.workspace.findFiles("**/*package*.xml", "**/node_modules/**", 20);
    let manifest: string | undefined;
    if (found.length === 0) {
      vscode.window.showInformationMessage(
        "manifest (package.xml) が見つかりません。manifest/package.xml を作成してください。"
      );
      return;
    } else if (found.length === 1) {
      manifest = vscode.workspace.asRelativePath(found[0]);
    } else {
      const pick = await vscode.window.showQuickPick(
        found.map((u) => vscode.workspace.asRelativePath(u)),
        { title: "manifest を選択" }
      );
      manifest = pick;
    }
    if (!manifest) {
      return;
    }
    const args = buildRetrieveArgs({ orgUsername: org.username, manifest });
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
  });

  // Apexテストを実行（既定: ローカルテスト全件）.
  reg("teamflow.runTests", async () => {
    const org = await pickOrg("テストを実行する環境を選択");
    if (!org) {
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        { label: "$(beaker) ローカルテストを全部実行", detail: "推奨", mode: "local" },
        { label: "$(symbol-class) クラスを指定して実行", detail: "テストクラス名を入力", mode: "class" },
        { label: "$(globe) 組織の全テストを実行", detail: "時間がかかります", mode: "all" },
      ],
      { title: `「${org.displayName}」でApexテスト` }
    );
    if (!choice) {
      return;
    }
    let classNames: string[] | undefined;
    let level: "RunLocalTests" | "RunAllTestsInOrg" = "RunLocalTests";
    if (choice.mode === "class") {
      const input = await vscode.window.showInputBox({
        title: "テストクラス名",
        prompt: "カンマ区切りで複数可",
        placeHolder: "AccountServiceTest, ContactServiceTest",
        // 入力時点で不正なクラス名（.cls付き・日本語・記号など）を弾き、CLIの不可解な失敗を防ぐ。
        validateInput: (v) => testClassNamesError(v),
      });
      if (!input) {
        return;
      }
      classNames = input.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (choice.mode === "all") {
      level = "RunAllTestsInOrg";
    }
    ctx.runInTerminal(
      renderCommand(ctx.cliPath(), buildRunTestsArgs({ orgUsername: org.username, classNames, level }))
    );
    ctx.recordActivity(`テスト実行: ${org.displayName}`, "run");
  });

  // デバッグログを確認（System.debug出力をリアルタイム表示）.
  reg("teamflow.tailLog", async () => {
    const org = await pickOrg("ログを確認する環境を選択");
    if (!org) {
      return;
    }
    ctx.runInTerminal(renderCommand(ctx.cliPath(), buildTailLogArgs(org.username)));
    ctx.recordActivity(`ログ確認: ${org.displayName}`, "run");
  });

  // 反映してテスト: スクラッチ/Sandbox に push してから即テスト（高速ループ）.
  reg("teamflow.pushAndTest", async () => {
    const root = ctx.workspaceRoot();
    if (!root) {
      return;
    }
    const org = await pickOrg("反映＆テストする環境（スクラッチ/Sandbox）");
    if (!org) {
      return;
    }
    const dirs = await readSfdxPackageDirs(root);
    // 「push && test」をターミナルに送ると PowerShell で && が使えず失敗するため、
    // 反映は run() で実行し、成功したときだけテストをターミナル（ライブ出力）で走らせる。
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${org.displayName} へ反映中…` },
      () => run(ctx.cliPath(), buildSourcePushArgs(org.username, dirs), { cwd: root, timeout: 300_000 })
    );
    if (res.code !== 0) {
      const detail = summarizeCliError(res.stderr, res.stdout);
      vscode.window.showErrorMessage(`反映に失敗しました（テストは実行しません）: ${detail || "不明なエラー"}`);
      ctx.recordActivity(`反映してテスト: ${org.displayName}`, "error");
      return;
    }
    ctx.runInTerminal(
      renderCommand(ctx.cliPath(), buildRunTestsArgs({ orgUsername: org.username, level: "RunLocalTests" }))
    );
    ctx.recordActivity(`反映してテスト: ${org.displayName}`, "run");
  });

  // 環境(Org)にローカルソースを反映 — 全部 or 資材を選んで.
  reg("teamflow.sourcePush", async () => {
    const root = ctx.workspaceRoot();
    if (!root) {
      return;
    }
    const org = await pickOrg("反映先の環境を選択");
    if (!org) {
      return;
    }
    const scope = await vscode.window.showQuickPick(
      [
        { label: "$(check-all) すべて反映する", detail: "ローカルのソース全体", mode: "all" },
        { label: "$(list-selection) 資材を選んで反映する", detail: "メタデータ種別を選択", mode: "pick" },
      ],
      { title: `「${org.displayName}」へ反映` }
    );
    if (!scope) {
      return;
    }
    if (scope.mode === "all") {
      const dirs = await readSfdxPackageDirs(root);
      ctx.runInTerminal(renderCommand(ctx.cliPath(), buildSourcePushArgs(org.username, dirs)));
      ctx.recordActivity(`環境へ反映(全部): ${org.displayName}`, "run");
      return;
    }
    const metadata = await pickMetadataTypes(`「${org.displayName}」へ反映する資材を選択`);
    if (!metadata || metadata.length === 0) {
      return;
    }
    ctx.runInTerminal(renderCommand(ctx.cliPath(), buildDeployMetadataArgs(org.username, metadata)));
    ctx.recordActivity(`環境へ反映(${metadata.length}件): ${org.displayName}`, "run");
  });

  // 環境(Org) の変更をローカルに取り込む (pull).
  reg("teamflow.sourcePull", async () => {
    const org = await pickOrg("取り込み元の環境を選択");
    if (!org) {
      return;
    }
    // 取り込み(pull)も手元のファイルを上書きし得る。未保存変更があれば警告する。
    if (!(await confirmNoUncommittedOverwrite())) {
      return;
    }
    const args = buildSourcePullArgs(org.username);
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
    ctx.recordActivity(`環境から取込: ${org.displayName}`, "run");
  });

  // Dev Hub を準備する (スクラッチOrgの親組織). 既存Orgで有効化 or 無料DEを新規取得.
  // 何度でも実行でき、複数のOrgをDev Hubにできる (上限分散やチーム別運用のため).
  reg("teamflow.setupDevHub", async () => {
    const existing = devHubOrgs();
    const how = await vscode.window.showQuickPick(
      [
        {
          label: "$(server) 認証済みの環境をDev Hubにする",
          detail: "開発者組織/本番組織などでDev Hubを有効化します（おすすめ）",
          action: "existing" as const,
        },
        {
          label: "$(globe) 無料の開発者組織を新規取得してDev Hubにする",
          detail: "ブラウザでDeveloper Editionに登録 → 認証 → 有効化",
          action: "signup" as const,
        },
      ],
      {
        title: "Dev Hub を準備",
        placeHolder:
          existing.length > 0
            ? `現在のDev Hub: ${existing.map((o) => o.displayName).join(", ")} — さらに追加できます`
            : "スクラッチ組織を作るための親組織(Dev Hub)を用意します",
      }
    );
    if (!how) {
      return;
    }

    if (how.action === "signup") {
      await vscode.env.openExternal(vscode.Uri.parse(DEVELOPER_EDITION_SIGNUP_URL));
      const next = await vscode.window.showInformationMessage(
        "ブラウザで開発者組織を登録し、確認メールから有効化してください。完了したら、その組織を認証 → もう一度「Dev Hubを準備」で有効化します。",
        "この組織を認証する"
      );
      if (next === "この組織を認証する") {
        await vscode.commands.executeCommand("teamflow.authorizeOrg");
      }
      return;
    }

    // --- 既存Orgを Dev Hub にする ---
    const org = await pickOrg("Dev Hubにする組織を選択", (o) => o.category !== "Scratch");
    if (!org) {
      return;
    }

    // 1. Dev Hub設定ページをブラウザで開く.
    ctx.runInTerminal(renderCommand(ctx.cliPath(), buildDevHubOpenArgs(org.username)));
    const confirmed = await vscode.window.showInformationMessage(
      `「${org.displayName}」の設定画面を開きました。\n\n` +
        "［設定］→ クイック検索に「Dev Hub」→「Dev Hub」を開き、" +
        "「Dev Hubの有効化（Enable Dev Hub）」を ON にして保存してください。\n\n" +
        "※ 一度ONにするとOFFには戻せません。\n\n完了したら［有効化を確認］を押してください。",
      { modal: true },
      "有効化を確認"
    );
    if (confirmed !== "有効化を確認") {
      return;
    }

    // 2. ScratchOrgInfo を引けるか試して「本当に有効か」を検証 (キャッシュに依存しない).
    const verified = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Dev Hubの有効化を確認中…" },
      async () => {
        try {
          await runSf(buildScratchOrgInfoProbeArgs(org.username), {
            cliPath: ctx.cliPath(),
            cwd: ctx.workspaceRoot(),
            timeout: 60_000,
          });
          return true;
        } catch {
          return false;
        }
      }
    );
    if (!verified) {
      const retry = await vscode.window.showWarningMessage(
        "まだDev Hubが有効になっていないようです。設定で「Dev Hubの有効化」をONにして保存後、もう一度お試しください。",
        "設定をもう一度開く"
      );
      if (retry === "設定をもう一度開く") {
        ctx.runInTerminal(renderCommand(ctx.cliPath(), buildDevHubOpenArgs(org.username)));
      }
      return;
    }

    // 3. 既定Dev Hubに登録 + stale な isDevHub キャッシュを修復.
    try {
      await runSf(buildSetDefaultDevHubArgs(org.username), {
        cliPath: ctx.cliPath(),
        cwd: ctx.workspaceRoot(),
      });
    } catch {
      // 既定設定に失敗しても、作成時に --target-dev-hub で個別指定できるので続行.
    }
    const refreshed = await refreshDevHubAuthFlag(org.username).catch(() => false);
    ctx.refreshAll();
    ctx.recordActivity(`Dev Hub 準備: ${org.displayName}`, "ok");

    if (refreshed) {
      const go = await vscode.window.showInformationMessage(
        `✅ ${org.displayName} をDev Hubとして準備しました。スクラッチ組織を作成できます。`,
        "スクラッチ組織を作成"
      );
      if (go === "スクラッチ組織を作成") {
        await vscode.commands.executeCommand("teamflow.createScratchOrg");
      }
    } else {
      // フラグを書き換えられなかった場合は再認証で反映 (CLIのキャッシュ更新).
      const re = await vscode.window.showInformationMessage(
        `Dev Hubを確認しました。反映のため「${org.displayName}」の再認証が必要な場合があります。`,
        "再認証する",
        "そのまま試す"
      );
      if (re === "再認証する") {
        const url = org.instanceUrl || org.loginUrl || "https://login.salesforce.com";
        ctx.runInTerminal(renderCommand(ctx.cliPath(), buildDevHubLoginArgs(url, org.alias)));
      }
    }
  });

  // スクラッチOrgを作成 (definition file 自動判定). suggestedAlias はブランチ連動時の初期値。
  reg("teamflow.createScratchOrg", async (suggestedAlias?: string) => {
    const root = ctx.workspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage("フォルダを開いてください。");
      return;
    }

    // スクラッチOrgには Dev Hub (親組織) が必須。0件なら準備に誘導、複数なら選ばせる。
    const hubs = devHubOrgs();
    let devhubUsername: string | undefined;
    if (hubs.length === 0) {
      const go = await vscode.window.showInformationMessage(
        "スクラッチ組織には「Dev Hub」が有効な親組織が必要です。先にDev Hubを準備しますか？",
        { modal: true },
        "Dev Hubを準備する",
        "このまま作成を試す"
      );
      if (go === "Dev Hubを準備する") {
        await vscode.commands.executeCommand("teamflow.setupDevHub");
        return;
      }
      if (go !== "このまま作成を試す") {
        return;
      }
      // 「このまま試す」: 既定Dev Hub (あれば) に委ねる。
    } else if (hubs.length === 1) {
      devhubUsername = hubs[0].username;
    } else {
      const pick = await vscode.window.showQuickPick(
        hubs.map((o) => ({
          label: `${o.isDefaultDevHubUsername ? "★ " : ""}${o.displayName}`,
          description: o.isDefaultDevHubUsername ? "既定のDev Hub" : "",
          detail: o.username,
          org: o,
        })),
        { title: "どのDev Hubで作成しますか？", placeHolder: "親組織(Dev Hub)を選択" }
      );
      if (!pick) {
        return;
      }
      devhubUsername = pick.org.username;
    }

    const alias = await vscode.window.showInputBox({
      title: "スクラッチ環境を作成",
      prompt: "エイリアス (分かりやすい名前)",
      value: typeof suggestedAlias === "string" && suggestedAlias.trim() ? suggestedAlias.trim() : "scratch-dev",
      validateInput: (v) => (v.trim() ? undefined : "分かりやすい名前を入力してください（例: scratch-dev）。"),
    });
    if (!alias) {
      return;
    }
    const days = await vscode.window.showInputBox({
      title: "有効日数",
      prompt: "1〜30日",
      value: "7",
      validateInput: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 30
          ? undefined
          : "1〜30 の数字を入れてください（例: 7）。";
      },
    });
    if (!days) {
      return;
    }
    const defCandidates = await vscode.workspace.findFiles(
      "**/*scratch-def.json",
      "**/node_modules/**",
      5
    );
    const def = resolveScratchDefinitionFile(
      defCandidates.map((u) => vscode.workspace.asRelativePath(u))
    );
    if (!def.found) {
      // 定義ファイルがどこにも無い＝既定パスも存在しないので sf は確実に失敗する。事前に案内。
      const cont = await vscode.window.showWarningMessage(
        "スクラッチ定義ファイル(*scratch-def.json)が見つかりません。通常は config/project-scratch-def.json にあり、プロジェクト作成時に生成されます。このまま作成を試しますか？",
        { modal: true },
        "このまま試す"
      );
      if (cont !== "このまま試す") {
        return;
      }
    }
    const args = buildScratchCreateArgs({
      alias: alias.trim(),
      definitionFile: def.file,
      durationDays: Number(days),
      setDefault: true,
      devhubUsername,
    });
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
    vscode.window.showInformationMessage(
      "スクラッチ環境を作成中です。完了後「環境一覧を更新」してください。"
    );
  });

  // 不要なスクラッチOrgを削除.
  reg("teamflow.deleteScratchOrg", async (usernameArg?: string) => {
    // ホームの期限切れカードから username 指定で直接呼ばれることがある。
    let org =
      typeof usernameArg === "string"
        ? ctx.knownOrgs().find((o) => o.username === usernameArg && o.category === "Scratch")
        : undefined;
    if (!org) {
      org = await pickOrg("削除するスクラッチ環境", (o) => o.category === "Scratch");
    }
    if (!org) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `スクラッチ環境「${org.displayName}」を削除しますか？`,
      { modal: true },
      "削除する"
    );
    if (ok !== "削除する") {
      return;
    }
    ctx.runInTerminal(renderCommand(ctx.cliPath(), buildScratchDeleteArgs(org.username)));
  });

  // ガイド付きセットアップ (初心者向けウィザード).
  reg("teamflow.guidedSetup", async () => {
    const steps = [
      {
        label: "$(repo) 1. プロジェクトを準備",
        detail: "既存プロジェクトを開く or 新規作成",
        action: async () => {
          const sub = await vscode.window.showQuickPick(
            ["新しいプロジェクトを作成する", "既にプロジェクトがある（スキップ）"],
            { title: "プロジェクト" }
          );
          if (sub === "新しいプロジェクトを作成する") {
            await vscode.commands.executeCommand("teamflow.createProject");
          }
        },
      },
      {
        label: "$(plug) 2. 環境を認証",
        detail: "開発/本番などの環境にログイン",
        action: () => vscode.commands.executeCommand("teamflow.authorizeOrg"),
      },
      {
        label: "$(settings-gear) 3. 環境を設定（開発/ステージング/本番）",
        detail: "ウィザードで環境⇔ブランチ⇔接続先を定義 (sf-teamflow.json)",
        action: () => vscode.commands.executeCommand("teamflow.setupWizard"),
      },
      {
        label: "$(rocket) 4. CI/CDを生成",
        detail: "GitHub Actions を出力",
        action: () => vscode.commands.executeCommand("teamflow.scaffoldCICD"),
      },
      {
        label: "$(book) 5. チーム開発ガイドを読む",
        detail: "複数人での進め方を確認",
        action: () => vscode.commands.executeCommand("teamflow.openWorkflowGuide"),
      },
    ];
    const pick = await vscode.window.showQuickPick(
      steps.map((s) => ({ label: s.label, detail: s.detail, action: s.action })),
      {
        title: "Salesforce Dev Manager ガイド付きセットアップ",
        placeHolder: "上から順に実行するのがおすすめです",
      }
    );
    if (pick) {
      await pick.action();
    }
  });
}
