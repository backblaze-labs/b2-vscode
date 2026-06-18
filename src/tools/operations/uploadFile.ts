/**
 * Upload File operation.
 *
 * @module tools/operations/uploadFile
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError } from "../../errors";
import {
  createTransferProgressReporter,
  uploadFileFromDisk,
  withCancellableTransferProgress,
} from "../../services/b2";

interface UploadFileParams {
  localPath: string;
  bucket: string;
  remotePath?: string;
}

interface UploadFileResult {
  fileId: string;
  fileName: string;
  size: number;
  message: string;
}

export const uploadFileOperation: B2ToolOperation<UploadFileParams, UploadFileResult> = {
  async execute(
    params: UploadFileParams,
    extras: ToolExtras,
    token?: vscode.CancellationToken,
  ): Promise<UploadFileResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    // Resolve local path (workspace-relative or absolute)
    let localPath = params.localPath;
    if (!path.isAbsolute(localPath)) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        throw new Error("No workspace folder open. Please use an absolute path.");
      }
      localPath = path.join(workspaceFolder.uri.fsPath, localPath);
    }

    await fs.promises.access(localPath, fs.constants.R_OK);
    const stats = await fs.promises.stat(localPath);
    if (!stats.isFile()) {
      throw new Error(`Local path is not a file: ${localPath}`);
    }

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    // Resolve remote path
    const remotePath = params.remotePath ?? path.basename(localPath);

    const result = await withCancellableTransferProgress(
      {
        title: `Uploading ${path.basename(localPath)} to b2://${params.bucket}/${remotePath}...`,
        token,
      },
      ({ progress, signal }) =>
        uploadFileFromDisk(bucket, localPath, remotePath, {
          signal,
          onProgress: createTransferProgressReporter(progress, stats.size),
        }),
    );

    return {
      fileId: result.fileId,
      fileName: result.fileName,
      size: result.contentLength,
      message: `Uploaded ${localPath} to b2://${params.bucket}/${remotePath} (${result.contentLength} bytes, ID: ${result.fileId})`,
    };
  },
};
