import * as vscode from "vscode";
import { isGitRepo, status } from "./deploy/gitService.js";
import { loadConfig } from "./config/configStore.js";
import { resolveEnvironment } from "./config/teamflowConfig.js";
import { formatGitStatusBar } from "./statusBarFormat.js";
import type { OrgInfo } from "./orgManager/orgService.js";

/**
 * Two status-bar items that keep the two facts a beginner most often gets wrong
 * always visible: which org am I pointed at, and which branch / environment am
 * I on. Clicking either opens the relevant action.
 */
export class StatusBar {
  private readonly orgItem: vscode.StatusBarItem;
  private readonly gitItem: vscode.StatusBarItem;

  constructor() {
    this.orgItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.orgItem.command = "teamflow.setDefaultOrg";
    this.gitItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.gitItem.command = "teamflow.gitCommitPush";
  }

  dispose(): void {
    this.orgItem.dispose();
    this.gitItem.dispose();
  }

  async update(root: string | undefined, orgs: OrgInfo[]): Promise<void> {
    const def = orgs.find((o) => o.isDefaultUsername);
    if (def && !def.connected) {
      // Default org is disconnected — surface it prominently for re-connect.
      this.orgItem.text = `$(debug-disconnect) ${def.displayName} 未接続`;
      this.orgItem.tooltip = `既定の環境「${def.username}」に接続できません。\nクリックでホームから再接続できます。`;
      this.orgItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.orgItem.show();
    } else if (def) {
      this.orgItem.text = `$(cloud) ${def.isProduction ? "⚠️ " : ""}${def.displayName}`;
      this.orgItem.tooltip = `既定の環境: ${def.username}${def.isProduction ? "（⚠️本番）" : ""}\nクリックで切替`;
      this.orgItem.backgroundColor = def.isProduction
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
      this.orgItem.show();
    } else {
      this.orgItem.text = "$(cloud) 環境未設定";
      this.orgItem.tooltip = "既定の環境が未設定です。クリックで選択。";
      this.orgItem.backgroundColor = undefined;
      this.orgItem.show();
    }

    if (root && (await isGitRepo(root))) {
      try {
        const s = await status(root);
        let env: { name: string; type: string } | undefined;
        try {
          const config = await loadConfig(root);
          env = config && s.branch ? resolveEnvironment(config, s.branch) : undefined;
        } catch {
          /* config optional */
        }
        const parts = formatGitStatusBar(s, env);
        this.gitItem.text = parts.text;
        this.gitItem.tooltip = parts.tooltip;
        // 本番環境のブランチは警告色で「いま本番ラインにいる」ことを常時可視化する。
        this.gitItem.backgroundColor = parts.isProduction
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
        this.gitItem.show();
      } catch {
        this.gitItem.hide();
      }
    } else {
      this.gitItem.hide();
    }
  }
}
