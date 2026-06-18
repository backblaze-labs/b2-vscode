/**
 * Upload File operation.
 *
 * @module tools/operations/uploadFile
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { BufferSource } from "@backblaze-labs/b2-sdk";
import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError } from "../../errors";

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
  async execute(params: UploadFileParams, extras: ToolExtras): Promise<UploadFileResult> {
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

    fs.accessSync(localPath, fs.constants.R_OK);

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    // Resolve remote path
    const remotePath = params.remotePath ?? path.basename(localPath);

    // Read and upload
    const data = await fs.promises.readFile(localPath);
    const result = await bucket.upload({
      fileName: remotePath,
      source: new BufferSource(data),
    });

    return {
      fileId: result.fileId,
      fileName: result.fileName,
      size: result.contentLength,
      message: `Uploaded ${localPath} to b2://${params.bucket}/${remotePath} (${data.length} bytes, ID: ${result.fileId})`,
    };
  },
};
