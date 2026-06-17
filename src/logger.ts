/**
 * Centralized logging via a VS Code OutputChannel.
 *
 * @module logger
 */

import * as vscode from "vscode";
import { formatB2DiagnosticMessage, formatB2DiagnosticStack, redactSensitiveText } from "./errors";

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel("Backblaze B2");
  return channel;
}

export function log(message: string): void {
  const safeMessage = redactSensitiveText(message);
  const line = `[${new Date().toISOString()}] ${safeMessage}`;
  channel?.appendLine(line);
  console.log(`[B2] ${safeMessage}`);
}

export function logError(message: string, error?: unknown): void {
  const safeMessage = redactSensitiveText(message);
  const errStr = error === undefined ? "" : formatB2DiagnosticMessage(error);
  const stack = error === undefined ? undefined : formatB2DiagnosticStack(error);
  const line = `[${new Date().toISOString()}] ERROR: ${safeMessage}${errStr ? ` — ${errStr}` : ""}`;
  channel?.appendLine(line);
  if (stack) {
    channel?.appendLine(stack);
  }
  console.error(`[B2] ${safeMessage}${errStr ? ` — ${errStr}` : ""}`);
  if (stack) {
    console.error(stack);
  }
}
