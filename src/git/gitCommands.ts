import * as vscode from "vscode";
import * as path from "node:path";
import { promises as fsp } from "node:fs";
import type { CommandContext } from "../commandContext.js";
import { logger } from "../util/logger.js";
import { run } from "../util/exec.js";
import {
  commit,
  commitFiles,
  createBranch,
  createTag,
  currentBranch,
  deleteBranch,
  deleteTag,
  hasRemote,
  hasUpstream,
  initRepo,
  mergeGitignore,
  BASELINE_GITIGNORE_ENTRIES,
  BASELINE_GITATTRIBUTES,
  pushErrorHint,
  commitErrorHint,
  branchNameError,
  tagNameError,
  repoNameError,
  isGitRepo,
  remoteUrl,
  removeRemote,
  listBranches,
  listTags,
  pull,
  push,
  pushDeleteTag,
  pushTag,
  recentCommits,
  revertCommit,
  stageAll,
  status,
  switchBranch,
} from "../deploy/gitService.js";
import { suggestNextTag } from "./tagUtils.js";
import {
  buildPullRequestArgs,
  isReleaseLikeBranch,
  isProtectedBranch,
  prBaseCandidates,
  scratchAliasForBranch,
} from "../sfProject/projectService.js";
import { renderCommand } from "../deploy/deployService.js";

/**
 * Beginner-friendly git: each command is a small, named, end-to-end action
 * ("保存してバックアップ") rather than exposing raw git porcelain. All run with
 * progress notifications and clear Japanese success/error messages.
 */

/** ベースラインの除外を .gitignore に保証する（既存は尊重し、不足分のみ追記）。 */
async function ensureBaselineGitignore(root: string): Promise<void> {
  const gi = path.join(root, ".gitignore");
  let cur = "";
  try {
    cur = await fsp.readFile(gi, "utf8");
  } catch {
    /* .gitignore がまだ無い */
  }
  const next = mergeGitignore(cur, BASELINE_GITIGNORE_ENTRIES);
  if (next !== cur) {
    await fsp.writeFile(gi, next, "utf8");
  }
}

/**
 * ベースラインの .gitattributes を保証する。既存ファイルがあれば尊重して何もしない
 * （ユーザー設定を上書きしない）。無い場合のみ作成。git init 直後（コミット前）に呼ぶことで
 * 既存ファイルの再正規化による余計な差分を避ける。
 */
async function ensureBaselineGitattributes(root: string): Promise<void> {
  const ga = path.join(root, ".gitattributes");
  try {
    await fsp.access(ga);
    return; // 既にある → 触らない
  } catch {
    /* まだ無い → 作成する */
  }
  await fsp.writeFile(ga, BASELINE_GITATTRIBUTES, "utf8");
}

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
        // ターミナルに「git init && ...」を送ると PowerShell では && が使えず失敗する。
        // 子プロセスで init→add→commit を順に実行し、そのまま元の操作を続行する。
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Gitを開始中…" },
            async () => {
              await initRepo(root);
              // 初回コミットで .sf/（認証トークンを含む）や ci-keys/（秘密鍵）等を
              // 誤って公開しないよう、ベースラインの .gitignore を先に用意する。
              await ensureBaselineGitignore(root);
              // 改行コードの揺れによる無駄な差分を防ぐ .gitattributes も用意（既存は尊重）。
              await ensureBaselineGitattributes(root);
              await stageAll(root);
              await commit("初回コミット", root);
            }
          );
          vscode.window.showInformationMessage("✅ Gitを開始しました（初回コミット作成）。");
          ctx.refreshAll();
          return root; // 初期化できたので元の操作を続行
        } catch (err) {
          logger.error("Git初期化に失敗", err);
          const hint = commitErrorHint(String(err));
          vscode.window.showErrorMessage(
            hint ? `Git初期化に失敗しました。${hint}` : `Git初期化に失敗しました: ${String(err)}`
          );
          logger.show();
        }
      }
      return undefined;
    }
    return root;
  }

  /**
   * リポジトリに .github/workflows のファイルがあり、かつ gh に workflow 権限が無いと
   * push が「workflow scope」で拒否される。push前に事前検知して、権限追加を案内する。
   * 続行してよければ true、ユーザーが権限追加を選んで中断したら false を返す。
   */
  async function ensureWorkflowScopeOk(root: string): Promise<boolean> {
    const ls = await run("git", ["ls-files", ".github/workflows"], { cwd: root, timeout: 10_000 });
    if (ls.code !== 0 || !ls.stdout.trim()) {
      return true; // workflowファイルが無ければ問題なし
    }
    const st = await run("gh", ["auth", "status"], { cwd: root, timeout: 15_000 });
    const hasScope = /workflow/i.test(`${st.stdout}\n${st.stderr}`);
    if (hasScope) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      "このリポジトリにはCI/CDのワークフロー(.github/workflows)があり、送信には GitHub CLI の『workflow』権限が必要です。先に権限を追加しますか？",
      "権限を追加する",
      "このまま試す"
    );
    if (choice === "権限を追加する") {
      ctx.runInTerminal("gh auth refresh -h github.com -s workflow");
      vscode.window.showInformationMessage(
        "ターミナルでブラウザ認証を完了したら、もう一度お試しください。"
      );
      return false;
    }
    return true; // 「このまま試す」→続行（失敗時は事後ハンドラが案内）
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
            // コミットはローカルに保存済み。workflow権限が無ければpushは拒否されるので事前検知。
            if (await ensureWorkflowScopeOk(root)) {
              progress.report({ message: "GitHubへバックアップ (push)" });
              const branch = await currentBranch(root);
              await push(root, true, branch);
              vscode.window.showInformationMessage("✅ 保存してGitHubにバックアップしました。");
            } else {
              vscode.window.showInformationMessage(
                "✅ ローカルに保存しました。権限を追加したら「GitHub同期」でGitHubへ送れます。"
              );
            }
          } else {
            vscode.window.showInformationMessage(
              "✅ ローカルに保存しました。GitHubに公開するには「GitHubに公開」を実行してください。"
            );
          }
          ctx.recordActivity("保存してバックアップ", "ok");
        } catch (err) {
          logger.error("commit/push 失敗", err);
          // commit段階(Git identity未設定 等)とpush段階の両方を拾う。
          const hint = commitErrorHint(String(err)) ?? pushErrorHint(String(err));
          vscode.window.showErrorMessage(
            hint ? `保存に失敗しました。${hint}` : `保存に失敗: ${String(err)}`
          );
          logger.show();
          ctx.recordActivity("保存してバックアップ", "error");
        } finally {
          ctx.refreshAll();
        }
      }
    );
  });

  // 取り消し(ロールバック): 選んだコミットの変更を revert（履歴を壊さない安全な取り消し）。
  reg("teamflow.rollback", async () => {
    const root = await ensureRepo();
    if (!root) {
      return;
    }
    let commits;
    try {
      commits = await recentCommits(root, 15);
    } catch (err) {
      vscode.window.showErrorMessage(`履歴を取得できませんでした: ${String(err)}`);
      return;
    }
    if (commits.length === 0) {
      vscode.window.showInformationMessage("取り消せる変更（コミット）がまだありません。");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      commits.map((c) => ({
        label: c.subject || "(メッセージなし)",
        description: `${c.author} · ${c.rel} · ${c.hash}`,
        hash: c.hash,
      })),
      { title: "取り消す変更を選択（ロールバック）", placeHolder: "この変更を打ち消す“取り消しコミット”を作ります（元に戻せます）" }
    );
    if (!pick) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `「${pick.label}」の変更を取り消します。\n\n履歴は壊さず、打ち消す新しいコミットを作ります（後で元に戻せます）。続けますか？`,
      { modal: true },
      "取り消す"
    );
    if (ok !== "取り消す") {
      return;
    }
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "取り消し中…" },
      () => revertCommit(pick.hash, root)
    );
    ctx.refreshAll();
    if (res.ok) {
      ctx.recordActivity(`取り消し: ${pick.label}`, "ok");
      const next = await vscode.window.showInformationMessage(
        "✅ 取り消しました。GitHubへ反映するなら「バックアップ」、環境へ反映するなら「環境へデプロイ」。",
        "環境へデプロイ"
      );
      if (next === "環境へデプロイ") {
        await vscode.commands.executeCommand("teamflow.deployToEnvironment");
      }
    } else if (res.conflict) {
      vscode.window.showWarningMessage(
        "競合が発生したため自動取り消しを中止しました（変更は元のままです）。手動での解消が必要です。"
      );
      ctx.recordActivity(`取り消し: ${pick.label}`, "error");
    } else {
      vscode.window.showErrorMessage(`取り消しに失敗しました: ${res.message || "不明なエラー"}`);
      ctx.recordActivity(`取り消し: ${pick.label}`, "error");
    }
  });

  // 変更履歴: 「誰が・いつ・何を変えたか」を一覧 → 選ぶと変更ファイルにドリルダウン。
  reg("teamflow.showHistory", async () => {
    const root = ctx.workspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage("フォルダを開いてください。");
      return;
    }
    if (!(await isGitRepo(root))) {
      vscode.window.showInformationMessage("まだGitで管理されていません。「💾 バックアップ」で開始できます。");
      return;
    }
    let commits;
    try {
      commits = await recentCommits(root, 30);
    } catch (err) {
      vscode.window.showErrorMessage(`履歴を取得できませんでした: ${String(err)}`);
      return;
    }
    if (commits.length === 0) {
      vscode.window.showInformationMessage("まだ変更履歴（コミット）がありません。");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      commits.map((c) => ({
        label: c.subject || "(メッセージなし)",
        description: `👤 ${c.author} · ${c.rel} · ${c.hash}`,
        hash: c.hash,
        subject: c.subject,
      })),
      { title: "変更履歴（新しい順）", placeHolder: "コミットを選ぶと、変更されたファイルを確認できます" }
    );
    if (!pick) {
      return;
    }
    let files;
    try {
      files = await commitFiles(pick.hash, root);
    } catch (err) {
      vscode.window.showErrorMessage(`変更ファイルを取得できませんでした: ${String(err)}`);
      return;
    }
    if (files.length === 0) {
      vscode.window.showInformationMessage("このコミットに変更ファイルはありません（マージコミット等）。");
      return;
    }
    const STATUS: Record<string, string> = { A: "➕ 追加", M: "✏️ 変更", D: "🗑 削除", R: "↪️ 改名", C: "📑 複製" };
    const fpick = await vscode.window.showQuickPick(
      files.map((f) => ({
        label: `${STATUS[String(f.status)[0]] || f.status} ${f.path}`,
        path: f.path,
        status: String(f.status),
      })),
      { title: `「${pick.subject}」の変更ファイル（${files.length}件）`, placeHolder: "ファイルを選ぶと開きます（最新版）" }
    );
    if (!fpick) {
      return;
    }
    if (fpick.status[0] === "D") {
      vscode.window.showInformationMessage(`「${fpick.path}」はこのコミットで削除されています。`);
      return;
    }
    const uri = vscode.Uri.file(`${root}/${fpick.path}`);
    await vscode.window
      .showTextDocument(uri)
      .then(undefined, () => vscode.window.showWarningMessage(`ファイルを開けません: ${fpick.path}`));
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
    if (!(await ensureWorkflowScopeOk(root))) {
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "GitHubと同期中…" },
      async (progress) => {
        try {
          const branch = await currentBranch(root);
          // 上流(tracking)が未設定だと git pull --ff-only は失敗する。
          // 初回は pull せず push -u で上流を確立し、2回目以降は pull→push。
          if (await hasUpstream(root)) {
            progress.report({ message: "取り込み (pull)" });
            await pull(root);
            progress.report({ message: "バックアップ (push)" });
            await push(root, false, branch);
          } else {
            progress.report({ message: "初回アップロード (push -u)" });
            await push(root, true, branch);
          }
          vscode.window.showInformationMessage("✅ GitHubと同期しました。");
          ctx.recordActivity("GitHubと同期", "ok");
        } catch (err) {
          logger.error("sync 失敗", err);
          const hint = pushErrorHint(String(err));
          vscode.window.showErrorMessage(
            hint
              ? `同期に失敗しました。${hint}`
              : `同期に失敗しました。コンフリクトの可能性があります: ${String(err)}`
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
          validateInput: (v) => branchNameError(v),
        });
        if (!name) {
          return;
        }
        await createBranch(name.trim(), root);
        vscode.window.showInformationMessage(`✅ ブランチ ${name.trim()} を作成して切り替えました。`);
        // #3 機能ブランチ↔スクラッチ連動: この機能専用の使い捨て環境を作るか提案。
        const mk = await vscode.window.showInformationMessage(
          "この機能用の使い捨て開発環境（スクラッチ）も作成しますか？（1機能=1環境で他と干渉しません）",
          "スクラッチを作成",
          "あとで"
        );
        if (mk === "スクラッチを作成") {
          await vscode.commands.executeCommand(
            "teamflow.createScratchOrg",
            scratchAliasForBranch(name.trim())
          );
        }
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
        { label: "$(arrow-right) このブランチに切り替える", description: "作業対象を切替", act: "switch" },
        { label: "$(trash) このブランチを削除する", description: "未マージ変更があると失敗(安全)", act: "delete" },
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
          {
            modal: true,
            detail: isProtectedBranch(name)
              ? "⚠️ これは共有の基準ブランチ（main/develop/release等）の可能性があります。ローカルでの削除は通常不要です。\n未マージの変更がある場合は失敗します（安全のため）。"
              : "未マージの変更がある場合は失敗します（安全のため）。",
          },
          "削除する"
        );
        if (ok !== "削除する") {
          return;
        }
        await deleteBranch(name, root, false);
        vscode.window.showInformationMessage(`✅ ブランチ ${name} を削除しました。`);
        // #3 連動: この機能用スクラッチが残っていれば一緒に掃除を提案。
        const alias = scratchAliasForBranch(name);
        const sc = ctx
          .knownOrgs()
          .find((o) => (o.alias === alias || o.username === alias) && o.category === "Scratch");
        if (sc) {
          const del = await vscode.window.showInformationMessage(
            `この機能用のスクラッチ環境「${sc.displayName}」も削除しますか？`,
            "削除する",
            "残す"
          );
          if (del === "削除する") {
            await vscode.commands.executeCommand("teamflow.deleteScratchOrg", sc.username);
          }
        }
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
      validateInput: (v) => tagNameError(v),
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
        { label: "$(cloud-upload) GitHubへプッシュ", description: "このタグを共有", act: "push" },
        { label: "$(trash) 削除（ローカル＋GitHub）", description: "取り消し不可", act: "delete" },
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
    // GitHub Flow に沿ってマージ先候補を並べる（release/hotfix は main 優先、他は develop 優先）。
    const branches = await listBranches(root);
    const uniq = prBaseCandidates(current, branches);
    // 「おすすめ」ラベルは並び順（prBaseCandidates）と一致させる。
    // release/hotfix からは main が、それ以外は develop がおすすめ。
    const desc: Record<string, string> = isReleaseLikeBranch(current)
      ? {
          main: "本番リリース用（おすすめ）",
          develop: "開発の合流先",
        }
      : {
          develop: "開発の合流先（おすすめ）",
          main: "本番リリース用（通常は release から）",
        };
    const basePick = await vscode.window.showQuickPick(
      uniq.map((b) => ({
        label: b,
        description: desc[b] || (b.startsWith("release") ? "リリース準備用" : ""),
      })),
      {
        title: `Pull Request: ${current} を取り込む先`,
        placeHolder: "マージ先（レビュー後にここへ統合）ブランチを選択",
      }
    );
    const base = basePick?.label;
    if (!base) {
      return;
    }
    // PRには現在ブランチのコミットが必要。workflow権限を事前確認してから送信する。
    if (!(await ensureWorkflowScopeOk(root))) {
      return;
    }
    try {
      await push(root, true, current);
    } catch (err) {
      // 送信失敗を握りつぶすとPRに最新コミットが入らないので明示する（続行は可）。
      const cont = await vscode.window.showWarningMessage(
        `ブランチ「${current}」の送信に失敗した可能性があります。PRに最新の変更が反映されないかもしれません。先に「GitHub同期」を試すこともできます。`,
        { detail: String(err), modal: false },
        "このままPRを作成",
        "やめる"
      );
      if (cont !== "このままPRを作成") {
        return;
      }
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
    if (!(await ensureWorkflowScopeOk(root))) {
      return;
    }
    // 既に origin がある場合 gh repo create --remote=origin は「Unable to add remote」で失敗する。
    const existingOrigin = await remoteUrl(root, "origin");
    if (existingOrigin) {
      const choice = await vscode.window.showWarningMessage(
        `既にGitHubに接続済みです（origin: ${existingOrigin}）。\n\n・このまま送るなら「GitHub同期」\n・別のリポジトリに作り直すなら、今の接続を解除してから新規作成します。`,
        { modal: true },
        "GitHub同期する",
        "接続し直す（新規作成）"
      );
      if (choice === "GitHub同期する") {
        await vscode.commands.executeCommand("teamflow.gitSync");
        return;
      }
      if (choice === "接続し直す（新規作成）") {
        try {
          await removeRemote("origin", root);
        } catch (err) {
          vscode.window.showErrorMessage(`既存の接続を解除できませんでした: ${String(err)}`);
          return;
        }
      } else {
        return;
      }
    }
    const name = await vscode.window.showInputBox({
      title: "GitHubに公開",
      prompt: "リポジトリ名",
      value: vscode.workspace.workspaceFolders?.[0]?.name ?? "my-sf-project",
      validateInput: (v) => repoNameError(v),
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
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "GitHubに公開中…" },
      () =>
        run(
          "gh",
          ["repo", "create", name, visibility.value, "--source=.", "--remote=origin", "--push"],
          { cwd: root, timeout: 120_000 }
        )
    );
    const out = `${res.stderr}\n${res.stdout}`;
    if (res.code === 0) {
      vscode.window.showInformationMessage("✅ GitHubに公開しました。以後は「GitHub同期」で送受信できます。");
      ctx.refreshAll();
      return;
    }
    // よくある失敗を分かりやすく案内する。
    if (/workflow.{0,20}scope/i.test(out)) {
      // リポジトリ作成・リモート追加は済み、CI/CDのworkflowファイルのpushだけが権限不足で拒否された。
      const choice = await vscode.window.showWarningMessage(
        "リポジトリは作成できましたが、CI/CD（.github/workflows）を送るには gh に「workflow」権限が必要です。権限を追加してから送り直します。",
        { modal: true },
        "権限を追加する"
      );
      if (choice === "権限を追加する") {
        ctx.runInTerminal("gh auth refresh -h github.com -s workflow");
        vscode.window.showInformationMessage(
          "ターミナルでブラウザ認証を完了したら、「GitHub同期」を押す（または git push -u origin <ブランチ>）と送れます。"
        );
      }
      return;
    }
    if (/unable to add remote|remote .*already exists/i.test(out)) {
      vscode.window.showWarningMessage(
        "リモート(origin)が既にあるため追加できませんでした。「接続し直す（新規作成）」で解除してから、または「GitHub同期」で送ってください。"
      );
      return;
    }
    if (/already exists|name already/i.test(out)) {
      vscode.window.showWarningMessage("同名のリポジトリが既に存在します。別名にするか、既存のものに接続してください。");
      return;
    }
    if (res.code === 127 || /not found|認識されて|is not recognized/i.test(out)) {
      vscode.window.showErrorMessage("GitHub CLI (gh) が見つかりません。インストールして再度お試しください。");
      return;
    }
    vscode.window.showErrorMessage(
      `GitHub公開に失敗しました: ${out.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" / ") || "不明なエラー"}`
    );
  });
}
