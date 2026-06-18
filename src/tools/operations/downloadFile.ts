/**
 * Download File operation.
 *
 * @module tools/operations/downloadFile
 */

import * as vscode from "vscode";
import * as path from "path";
import type { B2ToolOperation, ToolExtras } from "../types";
import {
  createTransferProgressReporter,
  downloadStreamToFile,
  withCancellableTransferProgress,
} from "../../services/b2";
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
  return path.join(workspaceFolder.uri.fsPath, relativePath);
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
      savePath = path.isAbsolute(params.localPath)
        ? params.localPath
        : workspacePath(
            params.localPath,
            "No workspace folder open. Please use an absolute localPath.",
          );
    } else {
      const fileName = path.basename(params.path);
      savePath = workspacePath(fileName, "No workspace folder open. Please specify a localPath.");
    }

    const size = await withCancellableTransferProgress(
      { title: `Downloading b2://${params.bucket}/${params.path}...`, token },
      async ({ progress, signal }) => {
        const { body, headers } = await bucket.download(params.path, {
          signal,
          onProgress: createTransferProgressReporter(progress),
        });

        const writtenBytes = await downloadStreamToFile(body, savePath, {
          signal,
        });
        return writtenBytes || headers.contentLength;
      },
    );

    return {
      localPath: savePath,
      size,
      message: `Downloaded ${params.path} from ${params.bucket} to ${savePath} (${size} bytes)`,
    };
  },
};
