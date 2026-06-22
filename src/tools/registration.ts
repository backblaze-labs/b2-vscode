/**
 * Registers all B2 Language Model Tools with VS Code Copilot.
 *
 * @module tools/registration
 */

import * as vscode from "vscode";
import type { B2Client } from "@backblaze-labs/b2-sdk";
import { B2ToolAdapter } from "./b2ToolAdapter";
import type { B2ToolDefinition, B2ToolOperation, ToolExtras } from "./types";

// Definitions
import { listBucketsTool } from "./definitions/listBuckets";
import { listFilesTool } from "./definitions/listFiles";
import { getFileInfoTool } from "./definitions/getFileInfo";
import { downloadFileTool } from "./definitions/downloadFile";
import { uploadFileTool } from "./definitions/uploadFile";
import { deleteFileTool } from "./definitions/deleteFile";
import { presignUrlTool } from "./definitions/presignUrl";

// Operations
import { listBucketsOperation } from "./operations/listBuckets";
import { listFilesOperation } from "./operations/listFiles";
import { getFileInfoOperation } from "./operations/getFileInfo";
import { downloadFileOperation } from "./operations/downloadFile";
import { uploadFileOperation } from "./operations/uploadFile";
import { deleteFileOperation } from "./operations/deleteFile";
import { presignUrlOperation } from "./operations/presignUrl";

/**
 * All tool definition + operation pairs.
 */
interface ToolPair {
  definition: B2ToolDefinition;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  operation: B2ToolOperation<any, any>;
}

const allTools: ToolPair[] = [
  { definition: listBucketsTool, operation: listBucketsOperation },
  { definition: listFilesTool, operation: listFilesOperation },
  { definition: getFileInfoTool, operation: getFileInfoOperation },
  { definition: downloadFileTool, operation: downloadFileOperation },
  { definition: uploadFileTool, operation: uploadFileOperation },
  { definition: deleteFileTool, operation: deleteFileOperation },
  { definition: presignUrlTool, operation: presignUrlOperation },
];

/**
 * Register all B2 tools with VS Code's Language Model API.
 *
 * Requires `vscode.lm.registerTool` which is available in VS Code 1.95+.
 */
export function registerB2Tools(
  context: vscode.ExtensionContext,
  getClient: () => B2Client | null,
): void {
  // Check if the API is available (VS Code 1.95+)
  if (!vscode.lm || typeof vscode.lm.registerTool !== "function") {
    console.warn(
      "[B2] vscode.lm.registerTool not available — Copilot tools will not be registered.",
    );
    return;
  }

  const extras: ToolExtras = {
    getClient,
  };

  for (const { definition, operation } of allTools) {
    try {
      const adapter = new B2ToolAdapter(definition, operation, extras);
      context.subscriptions.push(vscode.lm.registerTool(definition.name, adapter));
      console.log(`[B2] Registered tool: ${definition.name}`);
    } catch (error) {
      console.error(`[B2] Failed to register tool ${definition.name}:`, error);
    }
  }
}
