/**
 * Type definitions for B2 Copilot Language Model Tools.
 *
 * @module tools/types
 */

/**
 * Risk class for a tool, controlling how strongly the user is prompted before
 * it runs.
 *
 * - `readOnly`: reads B2 metadata/objects; makes no changes.
 * - `write`: writes to B2 or the local workspace.
 * - `destructive`: irreversibly deletes data.
 * - `exfiltration`: exposes data outside B2 (e.g. a shareable download URL).
 */
export type ToolRisk = "readOnly" | "write" | "destructive" | "exfiltration";

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
  /** Risk class controlling confirmation strength before the tool runs. */
  risk: ToolRisk;
  /**
   * Optional: a short, human-readable description of the concrete effect, shown
   * in the confirmation prompt (e.g. "permanently delete b2://bucket/key").
   */
  describeEffect?: (input: Record<string, unknown>) => string;
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
