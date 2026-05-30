/**
 * Type definitions for B2 Copilot Language Model Tools.
 *
 * @module tools/types
 */

/**
 * Definition of a single B2 tool for Copilot integration.
 */
export interface B2ToolDefinition {
  /** Unique tool name registered with vscode.lm (e.g., "b2_listBuckets"). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description shown to the language model. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Tags for categorization. */
  tags: string[];
}

/**
 * A tool operation that executes the actual B2 logic.
 */
export interface B2ToolOperation<TParams, TResult> {
  /** Execute the operation with validated parameters. */
  execute(params: TParams, extras: ToolExtras): Promise<TResult>;
}

/**
 * Extra context passed to tool operations.
 */
export interface ToolExtras {
  /** The authenticated B2 client. */
  getClient: () => import("@backblaze-labs/b2-sdk").B2Client | null;
}
