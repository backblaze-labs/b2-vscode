/**
 * VS Code Language Model Tool adapter for B2 operations.
 *
 * Bridges vscode.LanguageModelTool to our B2ToolOperation pattern.
 *
 * @module tools/b2ToolAdapter
 */

import * as vscode from "vscode";
import type { B2ToolDefinition, B2ToolOperation, ToolExtras } from "./types";

/**
 * Adapter that wraps a B2ToolDefinition + B2ToolOperation into a
 * vscode.LanguageModelTool for registration with vscode.lm.registerTool().
 */
export class B2ToolAdapter<TParams, TResult> implements vscode.LanguageModelTool<TParams> {
  constructor(
    private readonly definition: B2ToolDefinition,
    private readonly operation: B2ToolOperation<TParams, TResult>,
    private readonly extras: ToolExtras,
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<TParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.PreparedToolInvocation> {
    const input = (options.input ?? {}) as unknown as Record<string, unknown>;
    const effect = this.definition.describeEffect?.(input);
    const inputJson = "```json\n" + JSON.stringify(input, null, 2) + "\n```";

    // Confirmation strength scales with the tool's risk. Every tool still
    // requires a confirmation, so an agent cannot run one silently; the
    // destructive and exfiltration tools additionally spell out that the
    // action is irreversible or exposes data.
    const parts: string[] = [];
    let title = this.definition.displayName;

    switch (this.definition.risk) {
      case "destructive":
        title = `Confirm: ${this.definition.displayName}`;
        parts.push(`⚠️ This will **${effect ?? "delete data in B2"}**.`);
        parts.push(
          "This is irreversible and **cannot be undone**. Only continue if you intended this action.",
        );
        break;
      case "exfiltration":
        title = `Confirm: ${this.definition.displayName}`;
        parts.push(`⚠️ This will **${effect ?? "create a shareable download link"}**.`);
        parts.push(
          "Anyone who obtains the link can download the file until it expires, with no Backblaze login required.",
        );
        break;
      case "write":
        parts.push(`This will ${effect ?? "write data to B2 or your workspace"}.`);
        break;
      default:
        parts.push(`Read-only: this will ${effect ?? "read from B2"}. No changes are made.`);
        break;
    }
    parts.push(inputJson);

    return {
      invocationMessage: `Running ${this.definition.displayName}...`,
      confirmationMessages: {
        title,
        message: new vscode.MarkdownString(parts.join("\n\n")),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const result = await this.operation.execute(options.input, this.extras);
      const message = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.definition.displayName} failed: ${errorMessage}`);
    }
  }
}
