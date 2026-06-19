/**
 * Download File operation.
 *
 * @module tools/operations/downloadFile
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { B2ToolOperation, ToolExtras } from "../types";
import { downloadStreamToFile, withTransferStallTimeout } from "../../services/fileTransfers";
import {
  b2KeyBasename,
  ensureContainedDirectoryPath,
  findWorkspaceControlDirectory,
  resolveContainedRelativePath,
} from "../../services/pathSafety";
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

const WORKSPACE_REQUIRED_MESSAGE =
  "No workspace folder open. The downloadFile tool requires an open workspace folder because localPath must be workspace-relative.";

function assertNoControlDirectoryTarget(workspaceRoot: string, destinationPath: string): void {
  const blocked = findWorkspaceControlDirectory(workspaceRoot, destinationPath);
  if (blocked) {
    throw new Error(`downloadFile refuses to write inside workspace control directory: ${blocked}`);
  }
}

async function assertDestinationDoesNotExist(destinationPath: string): Promise<void> {
  try {
    await fs.promises.lstat(destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error(`downloadFile refuses to overwrite existing workspace file: ${destinationPath}`);
}

async function ensureWorkspaceDestinationDirectory(
  workspaceRoot: string,
  destinationPath: string,
): Promise<void> {
  await ensureContainedDirectoryPath(
    workspaceRoot,
    path.dirname(path.resolve(destinationPath)),
    "Workspace download directory",
  );
}

async function workspacePath(relativePath: string): Promise<string> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error(WORKSPACE_REQUIRED_MESSAGE);
  }
  const destinationPath = resolveContainedRelativePath(
    workspaceFolder.uri.fsPath,
    relativePath,
    "localPath",
  );
  assertNoControlDirectoryTarget(workspaceFolder.uri.fsPath, destinationPath);
  await assertDestinationDoesNotExist(destinationPath);
  await ensureWorkspaceDestinationDirectory(workspaceFolder.uri.fsPath, destinationPath);
  // Re-check after creating parent directories to avoid overwriting a target
  // that appeared while validation was in progress.
  await assertDestinationDoesNotExist(destinationPath);
  return destinationPath;
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
      savePath = await workspacePath(params.localPath);
    } else {
      const fileName = b2KeyBasename(params.path);
      savePath = await workspacePath(fileName);
    }

    const size = await withCancellableTransferProgress(
      { title: `Downloading b2://${params.bucket}/${params.path}...`, token },
      async ({ progress, signal }) => {
        const reporter = createTransferProgressReporter(progress);
        const { body } = await withTransferStallTimeout(
          `Download request for b2://${params.bucket}/${params.path}`,
          { signal },
          (requestSignal, markActivity) =>
            bucket.download(params.path, {
              signal: requestSignal,
              onProgress: (event) => {
                markActivity();
                reporter(event);
              },
            }),
        );

        return downloadStreamToFile(body, savePath, {
          signal,
          overwrite: false,
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
