import * as vscode from "vscode";
import type { CommandContext } from "../commandContext.js";
import { logger } from "../util/logger.js";
import {
  commit,
  createBranch,
  currentBranch,
  hasRemote,
  isGitRepo,
  listBranches,
  pull,
  push,
  stageAll,
  status,
  switchBranch,
} from "../deploy/gitService.js";

/**
 * Beginner-friendly git: each command is a small, named, end-to-end action
 * ("保存してバックアップ") rather than exposing raw git porcelain. All run with
 * progress notifications and clear Japanese success/error messages.
 */
export function registerGitCommands(
  context: vscode.ExtensionContext,
  ctx: CommandContext
): void {
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  async function ensureRepo(): Promise<string | undefined> {
    const root = ctx.workspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage("SF TeamFlow: フォルダを開いてください。");
      return undefined;
    }
    if (!(await isGitRepo(root))) {
      const init = await vscode.window.showInformationMessage(
        "このフォルダはまだGitで管理されていません。バージョン管理を始めますか？",
        "Gitを開始する"
      );
      if (init === "Gitを開始する") {
        ctx.runInTerminal("git init && git add -A && git commit -m \"初回コミット\"");
        vscode.window.showInformationMessage(
          "ターミナルでGitを初期化しました。完了したらもう一度お試しください。"
        );
      }
      return undefined;
    }
    return root;
  }

  // 保存してバックアップ: stage all → commit → push.
  reg("teamflow.gitCommitPush", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    const s = await status(root);
    if (s.changed === 0) {
      vscode.window.showInformationMessage("変更はありません。保存するものがありません。");
      return;
    }
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const defaultMsg = `作業を保存 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate()
    )} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const message = await vscode.window.showInputBox({
      title: "変更を保存 (コミット)",
      prompt: `${s.changed}件の変更を保存します。このままEnterでもOK（必要なら書き換え）。`,
      value: defaultMsg,
      valueSelection: [0, defaultMsg.length],
      validateInput: (v) => (v.trim() ? undefined : "メッセージを入力してください"),
    });
    if (!message) {
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "保存してバックアップ中…" },
      async (progress) => {
        try {
          progress.report({ message: "変更をステージング" });
          await stageAll(root);
          progress.report({ message: "コミット" });
          await commit(message, root);

          if (await hasRemote(root)) {
            progress.report({ message: "GitHubへバックアップ (push)" });
            const branch = await currentBranch(root);
            await push(root, true, branch);
            vscode.window.showInformationMessage("✅ 保存してGitHubにバックアップしました。");
          } else {
            vscode.window.showInformationMessage(
              "✅ ローカルに保存しました。GitHubに公開するには「GitHubに公開」を実行してください。"
            );
          }
        } catch (err) {
          logger.error("commit/push 失敗", err);
          vscode.window.showErrorMessage(`保存に失敗: ${String(err)}`);
          logger.show();
        } finally {
          ctx.refreshAll();
        }
      }
    );
  });

  // 同期: pull (--ff-only) then push.
  reg("teamflow.gitSync", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    if (!(await hasRemote(root))) {
      vscode.window.showInformationMessage("リモートがありません。先に「GitHubに公開」してください。");
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "GitHubと同期中…" },
      async (progress) => {
        try {
          progress.report({ message: "取り込み (pull)" });
          await pull(root);
          progress.report({ message: "バックアップ (push)" });
          const branch = await currentBranch(root);
          await push(root, true, branch);
          vscode.window.showInformationMessage("✅ GitHubと同期しました。");
        } catch (err) {
          logger.error("sync 失敗", err);
          vscode.window.showErrorMessage(
            `同期に失敗しました。コンフリクトの可能性があります: ${String(err)}`
          );
          logger.show();
        } finally {
          ctx.refreshAll();
        }
      }
    );
  });

  // 新しい作業ブランチ or 既存に切替.
  reg("teamflow.gitNewBranch", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    const NEW = "$(add) 新しい作業ブランチを作成…";
    const branches = await listBranches(root);
    const current = await currentBranch(root).catch(() => "");
    const pick = await vscode.window.showQuickPick(
      [
        NEW,
        ...branches.map((b) => (b === current ? `$(check) ${b}` : `$(git-branch) ${b}`)),
      ],
      { title: "ブランチ", placeHolder: "作成するか、切り替えるブランチを選択" }
    );
    if (!pick) {
      return;
    }
    try {
      if (pick === NEW) {
        const name = await vscode.window.showInputBox({
          title: "新しい作業ブランチ",
          prompt: "機能ごとにブランチを分けるのが安全です。",
          value: "feature/",
          validateInput: (v) =>
            /^[A-Za-z0-9._\/-]+$/.test(v.trim()) ? undefined : "英数字・/・-・_ で入力してください",
        });
        if (!name) {
          return;
        }
        await createBranch(name.trim(), root);
        vscode.window.showInformationMessage(`✅ ブランチ ${name.trim()} を作成して切り替えました。`);
      } else {
        const name = pick.replace(/^\$\([a-z-]+\)\s*/, "");
        if (name !== current) {
          await switchBranch(name, root);
          vscode.window.showInformationMessage(`✅ ${name} に切り替えました。`);
        }
      }
    } catch (err) {
      logger.error("branch 操作失敗", err);
      vscode.window.showErrorMessage(
        `ブランチ操作に失敗しました（未保存の変更があるかもしれません）: ${String(err)}`
      );
    } finally {
      ctx.refreshAll();
    }
  });

  // GitHubに公開 (gh repo create) — falls back to instructions if gh missing.
  reg("teamflow.gitPublish", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: "GitHubに公開",
      prompt: "リポジトリ名",
      value: vscode.workspace.workspaceFolders?.[0]?.name ?? "my-sf-project",
    });
    if (!name) {
      return;
    }
    const visibility = await vscode.window.showQuickPick(
      [
        { label: "$(lock) プライベート (推奨)", value: "--private" },
        { label: "$(globe) パブリック", value: "--public" },
      ],
      { title: "公開範囲" }
    );
    if (!visibility) {
      return;
    }
    ctx.runInTerminal(
      `gh repo create ${name} ${visibility.value} --source=. --remote=origin --push`
    );
    vscode.window.showInformationMessage(
      "ターミナルでGitHubに公開しています（gh CLI のログインが必要です）。"
    );
  });
}
