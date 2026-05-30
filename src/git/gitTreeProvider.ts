import * as vscode from "vscode";
import * as path from "node:path";
import { isGitRepo, status, hasRemote, type StatusSummary } from "../deploy/gitService.js";
import { loadConfig } from "../config/configStore.js";
import { resolveEnvironment } from "../config/teamflowConfig.js";
import { logger } from "../util/logger.js";

export class GitNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    readonly filePath?: string
  ) {
    super(label, collapsibleState);
  }
}

/**
 * A beginner-facing "バックアップ (Git)" view: shows at a glance which branch
 * you are on, whether it is backed up to GitHub (ahead/behind), and how many
 * changes are waiting — each row is a one-click action.
 */
export class GitTreeProvider implements vscode.TreeDataProvider<GitNode> {
  private readonly _onDidChange = new vscode.EventEmitter<GitNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly getRoot: () => string | undefined) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: GitNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GitNode): Promise<GitNode[]> {
    if (element) {
      return [];
    }
    const root = this.getRoot();
    if (!root || !(await isGitRepo(root))) {
      // Empty state handled by viewsWelcome in package.json.
      return [];
    }

    let summary: StatusSummary;
    try {
      summary = await status(root);
    } catch (err) {
      logger.error("git status 取得失敗", err);
      return [];
    }
    const remote = await hasRemote(root);

    const nodes: GitNode[] = [];

    // Branch → environment.
    const branchNode = new GitNode(
      `ブランチ: ${summary.branch || "(detached)"}`,
      vscode.TreeItemCollapsibleState.None
    );
    branchNode.iconPath = new vscode.ThemeIcon("git-branch");
    branchNode.contextValue = "teamflow.gitBranch";
    try {
      const config = await loadConfig(root);
      const env = config && summary.branch ? resolveEnvironment(config, summary.branch) : undefined;
      if (env) {
        branchNode.description = `→ ${env.name} (${env.orgAlias})`;
      }
    } catch {
      /* config optional */
    }
    branchNode.command = { command: "teamflow.gitNewBranch", title: "ブランチを切り替え/作成" };
    branchNode.tooltip = "クリックで作業ブランチを新規作成";
    nodes.push(branchNode);

    // Backup status (ahead/behind).
    if (!remote) {
      const n = new GitNode(
        "GitHubに未接続 — クリックでバックアップ",
        vscode.TreeItemCollapsibleState.None
      );
      n.iconPath = new vscode.ThemeIcon("cloud-upload", new vscode.ThemeColor("charts.orange"));
      n.command = { command: "teamflow.gitPublish", title: "GitHubに公開" };
      nodes.push(n);
    } else {
      const sync = new GitNode(
        summary.ahead === 0 && summary.behind === 0
          ? "GitHubと同期済み"
          : `未バックアップ ⬆️ ${summary.ahead}  ⬇️ ${summary.behind}`,
        vscode.TreeItemCollapsibleState.None
      );
      sync.iconPath = new vscode.ThemeIcon(
        summary.ahead === 0 && summary.behind === 0 ? "cloud" : "cloud-upload",
        new vscode.ThemeColor(
          summary.ahead === 0 && summary.behind === 0 ? "charts.green" : "charts.yellow"
        )
      );
      sync.description = summary.upstream;
      sync.command = { command: "teamflow.gitSync", title: "同期 (pull → push)" };
      sync.tooltip = "クリックで GitHub と同期 (取り込み→バックアップ)";
      nodes.push(sync);
    }

    // Changes.
    const changes = new GitNode(
      summary.changed === 0 ? "変更なし" : `${summary.changed} 件の変更 — クリックで保存`,
      summary.changed === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded
    );
    changes.iconPath = new vscode.ThemeIcon(
      summary.changed === 0 ? "check" : "edit",
      new vscode.ThemeColor(summary.changed === 0 ? "charts.green" : "charts.blue")
    );
    if (summary.changed > 0) {
      changes.command = { command: "teamflow.gitCommitPush", title: "保存してバックアップ" };
    }
    nodes.push(changes);

    for (const f of summary.files.slice(0, 50)) {
      const node = new GitNode(
        path.basename(f.path),
        vscode.TreeItemCollapsibleState.None,
        f.path
      );
      node.description = `${f.label} · ${path.dirname(f.path)}`;
      node.resourceUri = vscode.Uri.file(path.join(root, f.path));
      node.iconPath = vscode.ThemeIcon.File;
      node.command = {
        command: "vscode.open",
        title: "開く",
        arguments: [node.resourceUri],
      };
      nodes.push(node);
    }
    return nodes;
  }
}
