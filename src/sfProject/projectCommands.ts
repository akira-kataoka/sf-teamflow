import * as vscode from "vscode";
import type { CommandContext } from "../commandContext.js";
import { renderCommand } from "../deploy/deployService.js";
import { readSfdxPackageDirs } from "../config/configStore.js";
import type { OrgInfo } from "../orgManager/orgService.js";
import {
  buildProjectGenerateArgs,
  buildRetrieveArgs,
  buildScratchCreateArgs,
  buildScratchDeleteArgs,
  buildSourcePullArgs,
  buildSourcePushArgs,
  buildRunTestsArgs,
  COMMON_METADATA_TYPES,
} from "./projectService.js";

export function registerProjectCommands(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  async function pickOrg(placeHolder: string, filter?: (o: OrgInfo) => boolean): Promise<OrgInfo | undefined> {
    const orgs = ctx.knownOrgs().filter((o) => (filter ? filter(o) : true));
    if (orgs.length === 0) {
      vscode.window.showInformationMessage("対象のOrgがありません。先に認証してください。");
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

  // 新しいプロジェクトを作成 (sf project generate).
  reg("teamflow.createProject", async () => {
    const name = await vscode.window.showInputBox({
      title: "新しいSalesforceプロジェクト",
      prompt: "プロジェクト名 (フォルダ名になります)",
      placeHolder: "my-sf-project",
      validateInput: (v) =>
        /^[A-Za-z0-9._-]+$/.test(v.trim()) ? undefined : "英数字・-・_・. で入力してください",
    });
    if (!name) {
      return;
    }
    const template = await vscode.window.showQuickPick(
      [
        { label: "標準 (standard)", description: "通常のプロジェクト", value: "standard" as const },
        { label: "空 (empty)", description: "最小構成", value: "empty" as const },
      ],
      { title: "テンプレート" }
    );
    if (!template) {
      return;
    }
    const args = buildProjectGenerateArgs({
      name: name.trim(),
      template: template.value,
      defaultPackageDir: "force-app",
      manifest: true,
    });
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
    vscode.window.showInformationMessage(
      `プロジェクト「${name.trim()}」を作成中です。完了後 File > Open でそのフォルダを開いてください。`
    );
  });

  // メタデータを取得 (種類を選んで sf project retrieve).
  reg("teamflow.retrieveMetadata", async () => {
    const org = await pickOrg("取得元のOrgを選択");
    if (!org) {
      return;
    }
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
      {
        title: `「${org.displayName}」からメタデータを取得`,
        placeHolder: "取得する種類を選択 (複数可)",
        canPickMany: true,
      }
    );
    if (!picks || picks.length === 0) {
      return;
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
    if (metadata.length === 0) {
      return;
    }
    const args = buildRetrieveArgs({ orgUsername: org.username, metadata });
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
  });

  // package.xml (manifest) で取得.
  reg("teamflow.retrieveByManifest", async () => {
    const org = await pickOrg("取得元のOrgを選択");
    if (!org) {
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
    const org = await pickOrg("テストを実行するOrgを選択");
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
  });

  // 反映してテスト: スクラッチ/Sandbox に push してから即テスト（高速ループ）.
  reg("teamflow.pushAndTest", async () => {
    const root = ctx.workspaceRoot();
    if (!root) {
      return;
    }
    const org = await pickOrg("反映＆テストするOrg（スクラッチ/Sandbox）");
    if (!org) {
      return;
    }
    const dirs = await readSfdxPackageDirs(root);
    const push = renderCommand(ctx.cliPath(), buildSourcePushArgs(org.username, dirs));
    const test = renderCommand(
      ctx.cliPath(),
      buildRunTestsArgs({ orgUsername: org.username, level: "RunLocalTests" })
    );
    // Run sequentially in the terminal; tests only run if the deploy succeeds.
    ctx.runInTerminal(`${push} && ${test}`);
  });

  // スクラッチ/Sandbox にローカルソースを反映 (push).
  reg("teamflow.sourcePush", async () => {
    const root = ctx.workspaceRoot();
    if (!root) {
      return;
    }
    const org = await pickOrg("反映先のOrgを選択 (スクラッチ/Sandbox)");
    if (!org) {
      return;
    }
    const dirs = await readSfdxPackageDirs(root);
    const args = buildSourcePushArgs(org.username, dirs);
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
  });

  // Org の変更をローカルに取り込む (pull).
  reg("teamflow.sourcePull", async () => {
    const org = await pickOrg("取り込み元のOrgを選択");
    if (!org) {
      return;
    }
    const args = buildSourcePullArgs(org.username);
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
  });

  // スクラッチOrgを作成 (definition file 自動判定).
  reg("teamflow.createScratchOrg", async () => {
    const root = ctx.workspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage("フォルダを開いてください。");
      return;
    }
    const alias = await vscode.window.showInputBox({
      title: "スクラッチOrgを作成",
      prompt: "エイリアス (分かりやすい名前)",
      value: "scratch-dev",
      validateInput: (v) => (v.trim() ? undefined : "エイリアスを入力してください"),
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
        return Number.isInteger(n) && n >= 1 && n <= 30 ? undefined : "1〜30の整数";
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
    const definitionFile =
      defCandidates.length > 0
        ? vscode.workspace.asRelativePath(defCandidates[0])
        : "config/project-scratch-def.json";
    const args = buildScratchCreateArgs({
      alias: alias.trim(),
      definitionFile,
      durationDays: Number(days),
      setDefault: true,
    });
    ctx.runInTerminal(renderCommand(ctx.cliPath(), args));
    vscode.window.showInformationMessage(
      "スクラッチOrgを作成中です。完了後「Org一覧を更新」してください。"
    );
  });

  // 不要なスクラッチOrgを削除.
  reg("teamflow.deleteScratchOrg", async () => {
    const org = await pickOrg("削除するスクラッチOrg", (o) => o.category === "Scratch");
    if (!org) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `スクラッチOrg「${org.displayName}」を削除しますか？`,
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
        label: "$(plug) 2. Orgを認証",
        detail: "開発/本番などのOrgにログイン",
        action: () => vscode.commands.executeCommand("teamflow.authorizeOrg"),
      },
      {
        label: "$(settings-gear) 3. 環境を設定（開発/ステージング/本番）",
        detail: "ウィザードで環境⇔ブランチ⇔Orgを定義 (sf-teamflow.json)",
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
