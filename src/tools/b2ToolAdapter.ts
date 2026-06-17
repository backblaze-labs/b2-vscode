/**
 * VS Code Language Model Tool adapter for B2 operations.
 *
 * Bridges vscode.LanguageModelTool to our B2ToolOperation pattern.
 *
 * @module tools/b2ToolAdapter
 */

import * as vscode from "vscode";
import type { B2ToolDefinition, B2ToolOperation, ToolExtras } from "./types";
import { formatB2UserMessage } from "../errors";
import { logError } from "../logger";

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
    return {
      invocationMessage: `Running ${this.definition.displayName}...`,
      confirmationMessages: {
        title: this.definition.displayName,
        message: new vscode.MarkdownString(
          `Execute **${this.definition.displayName}** with:\n\n\`\`\`json\n${JSON.stringify(options.input, null, 2)}\n\`\`\``,
        ),
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
      logError(`${this.definition.displayName} tool failed`, error);
      const errorMessage = formatB2UserMessage(error);
      throw new Error(`${this.definition.displayName} failed: ${errorMessage}`);
    }
  }
}
