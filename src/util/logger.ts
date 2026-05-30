import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

function out(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("SF TeamFlow");
  }
  return channel;
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export const logger = {
  info(message: string): void {
    out().appendLine(`[${stamp()}] ${message}`);
  },
  warn(message: string): void {
    out().appendLine(`[${stamp()}] WARN  ${message}`);
  },
  error(message: string, err?: unknown): void {
    out().appendLine(`[${stamp()}] ERROR ${message}`);
    if (err instanceof Error) {
      out().appendLine(err.stack ?? err.message);
    } else if (err !== undefined) {
      out().appendLine(String(err));
    }
  },
  show(): void {
    out().show(true);
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
