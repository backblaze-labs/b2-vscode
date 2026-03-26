/**
 * Centralized logging via a VS Code OutputChannel.
 *
 * @module logger
 */

import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel("Backblaze B2");
  return channel;
}

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  channel?.appendLine(line);
  console.log(`[B2] ${message}`);
}

export function logError(message: string, error?: unknown): void {
  const errStr = error instanceof Error ? error.message : String(error ?? "");
  const line = `[${new Date().toISOString()}] ERROR: ${message}${errStr ? ` — ${errStr}` : ""}`;
  channel?.appendLine(line);
  console.error(`[B2] ${message}`, error);
}
