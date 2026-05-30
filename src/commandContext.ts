import type { OrgInfo } from "./orgManager/orgService.js";

/** Shared services passed to the per-area command registrars. */
export interface CommandContext {
  cliPath(): string;
  workspaceRoot(): string | undefined;
  /** Run a rendered command line in the shared SF TeamFlow terminal. */
  runInTerminal(command: string): void;
  /** Refresh all trees + status bar. */
  refreshAll(): void;
  /** Orgs currently known to the org tree (may be empty before first load). */
  knownOrgs(): OrgInfo[];
}
