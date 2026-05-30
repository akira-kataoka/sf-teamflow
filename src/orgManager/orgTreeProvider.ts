import * as vscode from "vscode";
import {
  CATEGORY_ORDER,
  listOrgs,
  type OrgCategory,
  type OrgInfo,
} from "./orgService.js";
import { logger } from "../util/logger.js";

const CATEGORY_ICON: Record<OrgCategory, string> = {
  Production: "shield",
  Sandbox: "beaker",
  DevHub: "package",
  Scratch: "rocket",
  Other: "question",
};

const CATEGORY_LABEL: Record<OrgCategory, string> = {
  Production: "🛡️ Production",
  Sandbox: "🧪 Sandbox",
  DevHub: "📦 Dev Hub",
  Scratch: "🚀 Scratch",
  Other: "❔ Other",
};

/** Either a category grouping node or a concrete org node. */
export class TreeNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    readonly kind: "category" | "org",
    readonly org?: OrgInfo
  ) {
    super(label, collapsibleState);
  }
}

export class OrgTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private orgs: OrgInfo[] = [];
  private loaded = false;
  private loadError: string | undefined;

  constructor(private readonly getCliPath: () => string, private readonly getCwd: () => string | undefined) {}

  refresh(): void {
    this.loaded = false;
    this._onDidChange.fire(undefined);
  }

  /** All currently-known orgs (used by commands needing the picker). */
  get knownOrgs(): OrgInfo[] {
    return this.orgs;
  }

  /** Force/ensure orgs are loaded and return them (used by the home webview). */
  async ensureOrgsLoaded(force = false): Promise<OrgInfo[]> {
    if (force) {
      this.loaded = false;
    }
    await this.ensureLoaded();
    return this.orgs;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loadError = undefined;
    try {
      this.orgs = await listOrgs({ cliPath: this.getCliPath(), cwd: this.getCwd() });
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      logger.error("Org一覧の取得に失敗", err);
      this.orgs = [];
    }
    this.loaded = true;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    await this.ensureLoaded();

    if (!element) {
      if (this.loadError) {
        const node = new TreeNode(
          "Org取得エラー — クリックでログを表示",
          vscode.TreeItemCollapsibleState.None,
          "category"
        );
        node.iconPath = new vscode.ThemeIcon("error");
        node.tooltip = this.loadError;
        node.command = { command: "teamflow.showLog", title: "Show log" };
        return [node];
      }
      if (this.orgs.length === 0) {
        const node = new TreeNode(
          "認証済みOrgがありません — ＋で認証",
          vscode.TreeItemCollapsibleState.None,
          "category"
        );
        node.iconPath = new vscode.ThemeIcon("info");
        return [node];
      }
      const categories = [...new Set(this.orgs.map((o) => o.category))].sort(
        (a, b) => CATEGORY_ORDER[a] - CATEGORY_ORDER[b]
      );
      return categories.map((cat) => {
        const count = this.orgs.filter((o) => o.category === cat).length;
        const node = new TreeNode(
          CATEGORY_LABEL[cat],
          vscode.TreeItemCollapsibleState.Expanded,
          "category"
        );
        node.description = `${count}`;
        node.iconPath = new vscode.ThemeIcon(CATEGORY_ICON[cat]);
        node.contextValue = "teamflow.category";
        node.id = `cat:${cat}`;
        return node;
      });
    }

    if (element.kind === "category") {
      const cat = labelToCategory(element.label as string);
      return this.orgs
        .filter((o) => o.category === cat)
        .map((o) => this.orgNode(o));
    }
    return [];
  }

  private orgNode(o: OrgInfo): TreeNode {
    const isDefault = o.isDefaultUsername === true;
    const label = `${isDefault ? "★ " : ""}${o.displayName}`;
    const node = new TreeNode(label, vscode.TreeItemCollapsibleState.None, "org", o);
    node.id = `org:${o.username}`;
    const userPart = o.alias && o.alias !== o.username ? o.username : undefined;
    // Reflect connection state in the tree row, and switch the contextValue so
    // the "再接続" right-click action only appears on disconnected orgs.
    node.description = o.connected
      ? userPart
      : `${userPart ? userPart + " · " : ""}🔌未接続`;
    node.contextValue = o.connected ? "teamflow.org" : "teamflow.orgDisconnected";
    node.command = {
      command: "teamflow.openOrg",
      title: "Open Org",
      arguments: [node],
    };

    const lines = [
      `**${o.displayName}**`,
      `ユーザー名: ${o.username}`,
      o.orgId ? `Org ID: ${o.orgId}` : undefined,
      o.instanceUrl ? `Instance: ${o.instanceUrl}` : undefined,
      `区分: ${o.category}`,
      o.expirationDate ? `有効期限: ${o.expirationDate}` : undefined,
      isDefault ? "★ 既定Org" : undefined,
      o.isProduction ? "⚠️ 本番Org — デプロイ時は要注意" : undefined,
      o.connected ? undefined : "🔌 未接続 — 再認証が必要かもしれません",
    ].filter(Boolean);
    node.tooltip = new vscode.MarkdownString(lines.join("\n\n"));

    if (!o.connected) {
      node.iconPath = new vscode.ThemeIcon(
        "debug-disconnect",
        new vscode.ThemeColor("disabledForeground")
      );
    } else if (o.isProduction) {
      node.iconPath = new vscode.ThemeIcon(
        "shield",
        new vscode.ThemeColor("charts.red")
      );
    } else {
      node.iconPath = new vscode.ThemeIcon(
        isDefault ? "star-full" : "cloud",
        new vscode.ThemeColor(isDefault ? "charts.yellow" : "charts.blue")
      );
    }
    return node;
  }
}

function labelToCategory(label: string): OrgCategory {
  for (const [cat, lbl] of Object.entries(CATEGORY_LABEL)) {
    if (lbl === label) {
      return cat as OrgCategory;
    }
  }
  return "Other";
}
