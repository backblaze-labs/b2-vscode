/**
 * VS Code Language Model Tool adapter for B2 operations.
 *
 * Bridges vscode.LanguageModelTool to our B2ToolOperation pattern.
 *
 * @module tools/b2ToolAdapter
 */

import * as vscode from "vscode";
import type { B2ToolDefinition, B2ToolOperation, ToolExtras } from "./types";
import { formatB2ToolUserMessage } from "../errors";
import { logError } from "../logger";

function backtickDelimiter(value: string, minimumLength: number): string {
  const backtickRuns = value.match(/`+/g) ?? [];
  const delimiterLength = Math.max(minimumLength, ...backtickRuns.map((run) => run.length + 1));
  return "`".repeat(delimiterLength);
}

function formatInlineCode(value: string): string {
  const normalized = value.replace(/\r\n|\r|\n/g, "\\n");
  const delimiter = backtickDelimiter(normalized, 1);
  const padded = normalized.startsWith("`") || normalized.endsWith("`");
  const content = padded ? ` ${normalized} ` : normalized;
  return `${delimiter}${content}${delimiter}`;
}

function formatFencedCode(language: string, value: string): string {
  const delimiter = backtickDelimiter(value, 3);
  return `${delimiter}${language}\n${value}\n${delimiter}`;
}

function assertNeverRisk(risk: never): never {
  throw new Error(`Unhandled tool risk: ${String(risk)}`);
}

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
    const inputJson = formatFencedCode("json", JSON.stringify(input, null, 2));

    // Confirmation strength scales with the tool's risk. Every tool still
    // requires a confirmation, so an agent cannot run one silently; the
    // destructive and exfiltration tools additionally spell out that the
    // action is irreversible or exposes data.
    const parts: string[] = [];
    let title = this.definition.displayName;

    switch (this.definition.risk) {
      case "destructive":
        title = `Confirm: ${this.definition.displayName}`;
        parts.push(`Warning: this will ${formatInlineCode(effect ?? "delete data in B2")}.`);
        parts.push(
          "This is irreversible and **cannot be undone**. Only continue if you intended this action.",
        );
        break;
      case "exfiltration":
        title = `Confirm: ${this.definition.displayName}`;
        parts.push(
          `Warning: this will ${formatInlineCode(effect ?? "expose data outside the local workspace or B2 account")}.`,
        );
        if (this.definition.name === "b2_presignUrl") {
          parts.push(
            "Anyone who obtains the link can download authorized B2 objects until it expires, with no Backblaze login required.",
          );
        } else {
          parts.push(
            "This can expose local file contents outside your machine. Only continue if you intended to share this data.",
          );
        }
        break;
      case "write":
        parts.push(
          `This will ${formatInlineCode(effect ?? "write data to B2 or your workspace")}.`,
        );
        break;
      case "readOnly":
        parts.push(`Read-only: this will ${formatInlineCode(effect ?? "read from B2")}.`);
        parts.push("No changes are made.");
        break;
      default:
        assertNeverRisk(this.definition.risk);
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
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const result = await this.operation.execute(options.input, this.extras, token);
      const message = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        throw error;
      }
      logError(`${this.definition.displayName} tool failed`, error);
      const errorMessage = formatB2ToolUserMessage(error);
      throw new Error(`${this.definition.displayName} failed: ${errorMessage}`, {
        cause: error,
      });
    }
  }
}
