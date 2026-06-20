/**
 * Download File operation.
 *
 * @module tools/operations/downloadFile
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { B2ToolOperation, ToolExtras } from "../types";
import {
  downloadStreamToNewFileWithinRoot,
  withTransferStallTimeout,
} from "../../services/fileTransfers";
import { findWorkspaceControlDirectory, prepareSafeFileWritePath } from "../../services/pathSafety";
import { resolveDownloadSavePath } from "../../utils/localPaths";
import {
  sanitizePathError,
  type PathMessageReplacement,
} from "../../services/pathErrorSanitization";
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

function normalizeDownloadFilePath(filePath: string): string {
  if (!filePath) {
    throw new Error("path must name a B2 object and must not be empty.");
  }

  if (filePath.includes("\0")) {
    throw new Error("path must not contain NUL bytes.");
  }

  if (filePath.endsWith("/")) {
    throw new Error("path must name a B2 object, not a folder path ending in slash.");
  }

  return filePath;
}

function relativeDisplayPath(
  workspaceRoot: string,
  absolutePath: string,
  fallback: string,
): string {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return fallback;
  }
  return relativePath;
}

function sanitizeWorkspaceDownloadError(
  error: unknown,
  destination: WorkspaceDestination,
  temporaryDirectory?: string,
): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const destinationDirectory = path.dirname(destination.path);
  const relativeDirectory = path.dirname(destination.relativePath);
  const relativeTemporaryDirectory = path.join(relativeDirectory, ".b2-vscode-transfers");
  const replacements: PathMessageReplacement[] = [
    { search: temporaryDirectory, replacement: relativeTemporaryDirectory },
    { search: destination.path, replacement: destination.relativePath },
    {
      search: destinationDirectory,
      replacement: relativeDirectory === "." ? "." : relativeDirectory,
    },
    { search: destination.workspaceRoot, replacement: "." },
  ];

  return sanitizePathError(error, replacements, (pathValue) =>
    relativeDisplayPath(destination.workspaceRoot, pathValue, destination.relativePath),
  );
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

interface WorkspaceDestination {
  readonly path: string;
  readonly relativePath: string;
  readonly workspaceRoot: string;
}

async function workspacePath(
  remotePath: string,
  localPath?: string,
): Promise<WorkspaceDestination> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error(WORKSPACE_REQUIRED_MESSAGE);
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const destinationPath = await resolveDownloadSavePath(workspaceRoot, remotePath, localPath);
  const destination = {
    path: destinationPath,
    relativePath: path.relative(workspaceRoot, destinationPath),
    workspaceRoot,
  };
  try {
    assertNoControlDirectoryTarget(workspaceRoot, destinationPath);
    await assertDestinationDoesNotExist(destinationPath);
    await prepareSafeFileWritePath(workspaceRoot, destinationPath, "downloadFile target");
    // Re-check after creating parent directories to avoid overwriting a target
    // that appeared while validation was in progress.
    await assertDestinationDoesNotExist(destinationPath);
    return destination;
  } catch (error) {
    throw sanitizeWorkspaceDownloadError(error, destination);
  }
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

    // Determine local save path before any remote request so invalid local
    // paths fail without touching B2.
    const remotePath = normalizeDownloadFilePath(params.path);
    const destination = await workspacePath(remotePath, params.localPath);
    const savePath = destination.path;

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    let size: number;
    try {
      size = await withCancellableTransferProgress(
        { title: `Downloading b2://${params.bucket}/${remotePath}...`, token },
        async ({ progress, signal }) => {
          const reporter = createTransferProgressReporter(progress);
          const { body } = await withTransferStallTimeout(
            `Download request for b2://${params.bucket}/${remotePath}`,
            { signal },
            (requestSignal, markActivity) =>
              bucket.download(remotePath, {
                signal: requestSignal,
                onProgress: (event) => {
                  markActivity();
                  reporter(event);
                },
              }),
          );

          return downloadStreamToNewFileWithinRoot(body, savePath, destination.workspaceRoot, {
            signal,
          });
        },
      );
    } catch (error) {
      throw sanitizeWorkspaceDownloadError(error, destination);
    }

    return {
      localPath: destination.relativePath,
      size,
      message: `Downloaded ${remotePath} from ${params.bucket} to ${destination.relativePath} (${size} bytes)`,
    };
  },
};
