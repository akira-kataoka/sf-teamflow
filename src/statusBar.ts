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
    if (def) {
      this.orgItem.text = `$(cloud) ${def.isProduction ? "⚠️ " : ""}${def.displayName}`;
      this.orgItem.tooltip = `既定Org: ${def.username}\nクリックで切替`;
      this.orgItem.backgroundColor = def.isProduction
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
      this.orgItem.show();
    } else {
      this.orgItem.text = "$(cloud) Org未設定";
      this.orgItem.tooltip = "既定Orgを設定";
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
        const sync = s.ahead > 0 ? `$(arrow-up)${s.ahead} ` : "";
        this.gitItem.text = `$(git-branch) ${s.branch}${envLabel} ${sync}${dirty}`.trim();
        this.gitItem.tooltip = "クリックで変更を保存してGitHubにバックアップ";
        this.gitItem.show();
      } catch {
        this.gitItem.hide();
      }
    } else {
      this.gitItem.hide();
    }
  }
}
