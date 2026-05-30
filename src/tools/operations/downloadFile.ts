/**
 * Download File operation.
 *
 * @module tools/operations/downloadFile
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { B2ToolOperation, ToolExtras } from "../types";
import { streamToBuffer } from "../../services/b2";

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

export const downloadFileOperation: B2ToolOperation<DownloadFileParams, DownloadFileResult> = {
  async execute(params: DownloadFileParams, extras: ToolExtras): Promise<DownloadFileResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new Error(`Bucket "${params.bucket}" not found.`);
    }

    // Determine local save path
    let savePath: string;
    if (params.localPath) {
      savePath = params.localPath;
    } else {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        throw new Error("No workspace folder open. Please specify a localPath.");
      }
      const fileName = path.basename(params.path);
      savePath = path.join(workspaceFolder.uri.fsPath, fileName);
    }

    // Download and collect the streaming body
    const { body } = await bucket.download(params.path);
    const data = await streamToBuffer(body);

    // Ensure directory exists and write
    const dir = path.dirname(savePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(savePath, data);

    return {
      localPath: savePath,
      size: data.length,
      message: `Downloaded ${params.path} from ${params.bucket} to ${savePath} (${data.length} bytes)`,
    };
  },
};
