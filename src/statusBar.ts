import * as vscode from "vscode";
import { isGitRepo, status } from "./deploy/gitService.js";
import { loadConfig } from "./config/configStore.js";
import { resolveEnvironment } from "./config/teamflowConfig.js";
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
      this.orgItem.tooltip = `既定Org「${def.username}」に接続できません。\nクリックでホームから再接続できます。`;
      this.orgItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.orgItem.show();
    } else if (def) {
      this.orgItem.text = `$(cloud) ${def.isProduction ? "⚠️ " : ""}${def.displayName}`;
      this.orgItem.tooltip = `既定Org: ${def.username}${def.isProduction ? "（⚠️本番）" : ""}\nクリックで切替`;
      this.orgItem.backgroundColor = def.isProduction
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
      this.orgItem.show();
    } else {
      this.orgItem.text = "$(cloud) Org未設定";
      this.orgItem.tooltip = "既定Orgが未設定です。クリックで選択。";
      this.orgItem.backgroundColor = undefined;
      this.orgItem.show();
    }

    if (root && (await isGitRepo(root))) {
      try {
        const s = await status(root);
        let envLabel = "";
        try {
          const config = await loadConfig(root);
          const env = config && s.branch ? resolveEnvironment(config, s.branch) : undefined;
          envLabel = env ? ` → ${env.name}` : "";
        } catch {
          /* config optional */
        }
        const dirty = s.changed > 0 ? `$(pencil)${s.changed} ` : "";
        const up = s.ahead > 0 ? `$(arrow-up)${s.ahead} ` : "";
        const down = s.behind > 0 ? `$(arrow-down)${s.behind} ` : "";
        this.gitItem.text = `$(git-branch) ${s.branch}${envLabel} ${up}${down}${dirty}`.trim();
        const tip = [
          `ブランチ: ${s.branch}${envLabel ? envLabel.replace(" → ", " → 環境 ") : "（環境未割当）"}`,
          s.changed > 0 ? `未保存の変更: ${s.changed}件` : "変更なし",
          s.ahead > 0 ? `未バックアップ: ${s.ahead}件` : undefined,
          s.behind > 0 ? `取り込み待ち: ${s.behind}件` : undefined,
          "クリックで保存してGitHubにバックアップ",
        ].filter(Boolean);
        this.gitItem.tooltip = tip.join("\n");
        this.gitItem.show();
      } catch {
        this.gitItem.hide();
      }
    } else {
      this.gitItem.hide();
    }
  }
}
