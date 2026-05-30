import * as vscode from "vscode";
import { loadConfig } from "../config/configStore.js";
import {
  resolveEnvironment,
  type TeamEnvironment,
  type TeamflowConfig,
} from "../config/teamflowConfig.js";
import { currentBranch, isGitRepo } from "../deploy/gitService.js";
import type { OrgInfo } from "./orgService.js";
import { logger } from "../util/logger.js";

const TYPE_ICON: Record<string, string> = {
  production: "shield",
  sandbox: "beaker",
  scratch: "rocket",
  dev: "tools",
};

export class EnvNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    readonly env?: TeamEnvironment
  ) {
    super(label, collapsibleState);
  }
}

/** Renders the team's sf-teamflow.json environments, annotated with live state. */
export class EnvironmentsTreeProvider implements vscode.TreeDataProvider<EnvNode> {
  private readonly _onDidChange = new vscode.EventEmitter<EnvNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private readonly getRoot: () => string | undefined,
    private readonly getOrgs: () => OrgInfo[]
  ) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: EnvNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: EnvNode): Promise<EnvNode[]> {
    if (element) {
      return [];
    }
    const root = this.getRoot();
    if (!root) {
      return [this.hint("ワークスペースを開いてください", "folder")];
    }

    let config: TeamflowConfig | undefined;
    try {
      config = await loadConfig(root);
    } catch (err) {
      logger.error("sf-teamflow.json の読み込みに失敗", err);
      return [this.hint("sf-teamflow.json が不正です — クリックでログ", "error", "teamflow.showLog")];
    }
    if (!config) {
      return [
        this.hint(
          "未設定 — クリックでチームプロジェクトを初期化",
          "rocket",
          "teamflow.initTeamProject"
        ),
      ];
    }

    const nodes: EnvNode[] = [];

    // Header: current branch → resolved environment.
    if (await isGitRepo(root)) {
      try {
        const branch = await currentBranch(root);
        const resolved = resolveEnvironment(config, branch);
        const head = new EnvNode(
          `現在のブランチ: ${branch}`,
          vscode.TreeItemCollapsibleState.None
        );
        head.description = resolved ? `→ ${resolved.name}` : "→ (環境マッピングなし)";
        head.iconPath = new vscode.ThemeIcon("git-branch");
        head.tooltip = resolved
          ? `このブランチは「${resolved.name}」(${resolved.orgAlias}) にマップされています`
          : "このブランチにマップされた環境はありません";
        nodes.push(head);
      } catch (err) {
        logger.warn(`current branch 取得失敗: ${String(err)}`);
      }
    }

    const orgs = this.getOrgs();
    for (const env of config.environments) {
      const org = orgs.find((o) => o.alias === env.orgAlias || o.username === env.orgAlias);
      const node = new EnvNode(env.name, vscode.TreeItemCollapsibleState.None, env);
      node.description = `${env.orgAlias} · ${env.branch}`;
      node.contextValue = "teamflow.environment";
      const icon = TYPE_ICON[env.type] ?? "cloud";
      const color =
        env.type === "production"
          ? new vscode.ThemeColor("charts.red")
          : org
          ? new vscode.ThemeColor("charts.green")
          : new vscode.ThemeColor("disabledForeground");
      node.iconPath = new vscode.ThemeIcon(icon, color);
      node.tooltip = new vscode.MarkdownString(
        [
          `**${env.name}** (${env.type})`,
          `Org alias: \`${env.orgAlias}\` ${org ? "✅ 認証済み" : "❌ 未認証"}`,
          `Branch: \`${env.branch}\``,
          env.testLevel ? `Test level: ${env.testLevel}` : undefined,
          env.requireValidation ? "CI検証必須" : undefined,
        ]
          .filter(Boolean)
          .join("\n\n")
      );
      nodes.push(node);
    }
    return nodes;
  }

  private hint(label: string, icon: string, command?: string): EnvNode {
    const node = new EnvNode(label, vscode.TreeItemCollapsibleState.None);
    node.iconPath = new vscode.ThemeIcon(icon);
    if (command) {
      node.command = { command, title: label };
    }
    return node;
  }
}
