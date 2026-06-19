/**
 * Download File operation.
 *
 * @module tools/operations/downloadFile
 */

import * as vscode from "vscode";
import type { B2ToolOperation, ToolExtras } from "../types";
import { downloadStreamToFile } from "../../services/fileTransfers";
import { b2KeyBasename, resolveContainedRelativePath } from "../../services/pathSafety";
import {
  createTransferProgressReporter,
  withCancellableTransferProgress,
} from "../../services/transferProgress";
import { B2ResourceNotFoundError } from "../../errors";

interface DownloadFileParams {
  bucket: string;
  path: string;
  localPath?: string;
}

interface DownloadFileResult {
  localPath: string;
  size: number;
  message: string;
}

function workspacePath(relativePath: string, missingWorkspaceMessage: string): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error(missingWorkspaceMessage);
  }
  return resolveContainedRelativePath(workspaceFolder.uri.fsPath, relativePath, "localPath");
}

export const downloadFileOperation: B2ToolOperation<DownloadFileParams, DownloadFileResult> = {
  async execute(
    params: DownloadFileParams,
    extras: ToolExtras,
    token?: vscode.CancellationToken,
  ): Promise<DownloadFileResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    // Determine local save path
    let savePath: string;
    if (params.localPath) {
      savePath = workspacePath(
        params.localPath,
        "No workspace folder open. Please omit localPath or use a workspace-relative localPath.",
      );
    } else {
      const fileName = b2KeyBasename(params.path);
      savePath = workspacePath(fileName, "No workspace folder open. Please specify a localPath.");
    }

    const size = await withCancellableTransferProgress(
      { title: `Downloading b2://${params.bucket}/${params.path}...`, token },
      async ({ progress, signal }) => {
        const { body } = await bucket.download(params.path, {
          signal,
          onProgress: createTransferProgressReporter(progress),
        });

        return downloadStreamToFile(body, savePath, {
          signal,
        });
      },
    );

    return {
      localPath: savePath,
      size,
      message: `Downloaded ${params.path} from ${params.bucket} to ${savePath} (${size} bytes)`,
    };
  },
};
