import * as vscode from "vscode";
import type { CommandContext } from "../commandContext.js";
import { logger } from "../util/logger.js";
import {
  commit,
  createBranch,
  createTag,
  currentBranch,
  deleteBranch,
  deleteTag,
  hasRemote,
  isGitRepo,
  listBranches,
  listTags,
  pull,
  push,
  pushDeleteTag,
  pushTag,
  stageAll,
  status,
  switchBranch,
} from "../deploy/gitService.js";
import { suggestNextTag } from "./tagUtils.js";
import { buildPullRequestArgs } from "../sfProject/projectService.js";
import { renderCommand } from "../deploy/deployService.js";

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
      vscode.window.showErrorMessage("Salesforce Dev Manager: フォルダを開いてください。");
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
    // Pick an intent first (one click), then optionally add a one-line detail.
    const ASIS = "__asis__";
    const FREE = "__free__";
    const kind = await vscode.window.showQuickPick(
      [
        { label: "$(add) 機能を追加した", prefix: "機能を追加: " },
        { label: "$(bug) 不具合を直した", prefix: "不具合を修正: " },
        { label: "$(paintcan) 画面・見た目を調整した", prefix: "画面を調整: " },
        { label: "$(book) ドキュメントを更新した", prefix: "ドキュメントを更新: " },
        { label: "$(history) コードを整理した", prefix: "コードを整理: " },
        { label: "$(edit) 自分でメッセージを書く", prefix: FREE },
        { label: "$(check) そのまま保存（日時のみ）", prefix: ASIS },
      ],
      { title: `変更 ${s.changed}件を保存`, placeHolder: "何をしたか選ぶ（クリックだけでもOK）" }
    );
    if (!kind) {
      return;
    }
    let message: string;
    if (kind.prefix === ASIS) {
      message = defaultMsg;
    } else {
      const base = kind.prefix === FREE ? "" : kind.prefix;
      const input = await vscode.window.showInputBox({
        title: "ひとことメモ（任意）",
        prompt: "具体的に何をしたか。空でもOK（種別だけで保存します）。",
        value: base,
        valueSelection: [base.length, base.length],
        placeHolder: "例: 取引先一覧に検索ボタンを追加",
      });
      if (input === undefined) {
        return;
      }
      message = input.trim() || base.trim() || defaultMsg;
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
          ctx.recordActivity("保存してバックアップ", "ok");
        } catch (err) {
          logger.error("commit/push 失敗", err);
          vscode.window.showErrorMessage(`保存に失敗: ${String(err)}`);
          logger.show();
          ctx.recordActivity("保存してバックアップ", "error");
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
          ctx.recordActivity("GitHubと同期", "ok");
        } catch (err) {
          logger.error("sync 失敗", err);
          vscode.window.showErrorMessage(
            `同期に失敗しました。コンフリクトの可能性があります: ${String(err)}`
          );
          logger.show();
          ctx.recordActivity("GitHubと同期", "error");
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

  // ブランチ管理: 切り替え / 新規作成 / 削除（クリック中心）.
  reg("teamflow.manageBranches", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    const NEW = "$(add) 新しい作業ブランチを作成…";
    const current = await currentBranch(root).catch(() => "");
    const branches = await listBranches(root);
    const pick = await vscode.window.showQuickPick(
      [NEW, ...branches.map((b) => (b === current ? `$(check) ${b}（現在）` : `$(git-branch) ${b}`))],
      { title: "ブランチ管理", placeHolder: "操作するブランチを選択" }
    );
    if (!pick) {
      return;
    }
    if (pick === NEW) {
      await vscode.commands.executeCommand("teamflow.gitNewBranch");
      return;
    }
    const name = pick.replace(/^\$\([a-z-]+\)\s*/, "").replace(/（現在）$/, "");
    if (name === current) {
      vscode.window.showInformationMessage(`「${name}」は現在のブランチです。`);
      return;
    }
    const action = await vscode.window.showQuickPick(
      [
        { label: "$(arrow-right) このブランチに切り替える", act: "switch" },
        { label: "$(trash) このブランチを削除する", act: "delete" },
      ],
      { title: `ブランチ: ${name}` }
    );
    if (!action) {
      return;
    }
    try {
      if (action.act === "switch") {
        await switchBranch(name, root);
        vscode.window.showInformationMessage(`✅ ${name} に切り替えました。`);
      } else {
        const ok = await vscode.window.showWarningMessage(
          `ブランチ「${name}」を削除しますか？`,
          { modal: true, detail: "未マージの変更がある場合は失敗します（安全のため）。" },
          "削除する"
        );
        if (ok !== "削除する") {
          return;
        }
        await deleteBranch(name, root, false);
        vscode.window.showInformationMessage(`✅ ブランチ ${name} を削除しました。`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`ブランチ操作に失敗: ${String(err)}`);
    } finally {
      ctx.refreshAll();
    }
  });

  // タグ作成（リリースの目印）→ GitHubへプッシュ.
  reg("teamflow.createTag", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    const existing = await listTags(root).catch(() => []);
    const suggested = suggestNextTag(existing);
    const name = await vscode.window.showInputBox({
      title: "リリースタグを作成",
      prompt: "バージョンの目印（例: v1.0.0）。このままEnterでもOK。",
      value: suggested,
      validateInput: (v) =>
        /^[\w.\/-]+$/.test(v.trim()) ? undefined : "英数字・.・-・/ で入力してください",
    });
    if (!name) {
      return;
    }
    const message = await vscode.window.showInputBox({
      title: "タグの説明（任意）",
      prompt: "このリリースの内容（空でもOK）",
      value: `Release ${name.trim()}`,
    });
    if (message === undefined) {
      return;
    }
    try {
      await createTag(name.trim(), message, root);
      if (await hasRemote(root)) {
        await pushTag(name.trim(), root);
        vscode.window.showInformationMessage(`✅ タグ ${name.trim()} を作成しGitHubへプッシュしました。`);
      } else {
        vscode.window.showInformationMessage(`✅ タグ ${name.trim()} を作成しました（ローカル）。`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`タグ作成に失敗: ${String(err)}`);
    } finally {
      ctx.refreshAll();
    }
  });

  // タグ管理: 一覧 → プッシュ / 削除.
  reg("teamflow.manageTags", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    const NEW = "$(add) 新しいリリースタグを作成…";
    const tags = await listTags(root);
    const pick = await vscode.window.showQuickPick(
      [NEW, ...tags.map((t) => `$(tag) ${t}`)],
      { title: "タグ管理", placeHolder: tags.length ? "操作するタグを選択" : "まだタグがありません" }
    );
    if (!pick) {
      return;
    }
    if (pick === NEW) {
      await vscode.commands.executeCommand("teamflow.createTag");
      return;
    }
    const name = pick.replace(/^\$\(tag\)\s*/, "");
    const action = await vscode.window.showQuickPick(
      [
        { label: "$(cloud-upload) GitHubへプッシュ", act: "push" },
        { label: "$(trash) 削除（ローカル＋GitHub）", act: "delete" },
      ],
      { title: `タグ: ${name}` }
    );
    if (!action) {
      return;
    }
    try {
      if (action.act === "push") {
        await pushTag(name, root);
        vscode.window.showInformationMessage(`✅ タグ ${name} をGitHubへプッシュしました。`);
      } else {
        const ok = await vscode.window.showWarningMessage(
          `タグ「${name}」を削除しますか？`,
          { modal: true },
          "削除する"
        );
        if (ok !== "削除する") {
          return;
        }
        await deleteTag(name, root);
        if (await hasRemote(root)) {
          await pushDeleteTag(name, root).catch(() => undefined);
        }
        vscode.window.showInformationMessage(`✅ タグ ${name} を削除しました。`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`タグ操作に失敗: ${String(err)}`);
    } finally {
      ctx.refreshAll();
    }
  });

  // Pull Request を作成 (gh pr create) — レビュー依頼の導線.
  reg("teamflow.createPullRequest", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    if (!(await hasRemote(root))) {
      vscode.window.showInformationMessage("先に「GitHubに公開」してください。");
      return;
    }
    const current = await currentBranch(root).catch(() => "");
    // Suggest sensible base branches; default to develop if it exists.
    const branches = (await listBranches(root)).filter((b) => b !== current);
    const candidates = ["develop", "main", ...branches.filter((b) => b !== "develop" && b !== "main")];
    const uniq = [...new Set(candidates)];
    const base = await vscode.window.showQuickPick(uniq, {
      title: `Pull Request: ${current} を取り込む先`,
      placeHolder: "マージ先（レビュー後にここへ統合）ブランチを選択",
    });
    if (!base) {
      return;
    }
    // First push the current branch so the PR has commits, then open the form.
    try {
      await push(root, true, current);
    } catch {
      /* may already be pushed */
    }
    ctx.runInTerminal(renderCommand("gh", buildPullRequestArgs({ baseBranch: base, web: true })));
    vscode.window.showInformationMessage(
      `${current} → ${base} の Pull Request を作成します（ブラウザで内容を確認）。`
    );
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
