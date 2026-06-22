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

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
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

  const errnoError = error as NodeJS.ErrnoException;
  const destinationDirectory = path.dirname(destination.path);
  const relativeDirectory = path.dirname(destination.relativePath);
  const relativeTemporaryDirectory = path.join(relativeDirectory, ".b2-vscode-transfers");
  const replacements: Array<readonly [string | undefined, string]> = [
    [temporaryDirectory, relativeTemporaryDirectory],
    [destination.path, destination.relativePath],
    [destinationDirectory, relativeDirectory === "." ? "." : relativeDirectory],
    [destination.workspaceRoot, "."],
  ];
  if (typeof errnoError.path === "string") {
    replacements.unshift([
      errnoError.path,
      relativeDisplayPath(destination.workspaceRoot, errnoError.path, destination.relativePath),
    ]);
  }

  let message = error.message;
  for (const [search, replacement] of replacements) {
    message = replaceAllLiteral(message, search ?? "", replacement);
  }
  if (message === error.message) {
    return error;
  }

  const sanitized = new Error(message);
  sanitized.name = error.name;
  if (typeof errnoError.code === "string") {
    (sanitized as NodeJS.ErrnoException).code = errnoError.code;
  }
  if (typeof errnoError.errno === "number") {
    (sanitized as NodeJS.ErrnoException).errno = errnoError.errno;
  }
  if (typeof errnoError.syscall === "string") {
    (sanitized as NodeJS.ErrnoException).syscall = errnoError.syscall;
  }
  if (typeof errnoError.path === "string") {
    (sanitized as NodeJS.ErrnoException).path = relativeDisplayPath(
      destination.workspaceRoot,
      errnoError.path,
      destination.relativePath,
    );
  }
  return sanitized;
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

interface WorkspaceDestination {
  readonly path: string;
  readonly relativePath: string;
  readonly workspaceRoot: string;
}

async function workspacePath(relativePath: string): Promise<WorkspaceDestination> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error(WORKSPACE_REQUIRED_MESSAGE);
  }
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const destinationPath = resolveContainedRelativePath(workspaceRoot, relativePath, "localPath");
  const destination = {
    path: destinationPath,
    relativePath: path.relative(workspaceRoot, destinationPath),
    workspaceRoot,
  };
  try {
    assertNoControlDirectoryTarget(workspaceRoot, destinationPath);
    await assertDestinationDoesNotExist(destinationPath);
    await ensureWorkspaceDestinationDirectory(workspaceRoot, destinationPath);
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

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    // Determine local save path
    let destination: WorkspaceDestination;
    if (params.localPath) {
      destination = await workspacePath(params.localPath);
    } else {
      const fileName = b2KeyBasename(params.path);
      destination = await workspacePath(fileName);
    }
    const savePath = destination.path;
    const temporaryDirectory = path.join(path.dirname(savePath), ".b2-vscode-transfers");

    let size: number;
    try {
      size = await withCancellableTransferProgress(
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
            allowedRootDirectory: destination.workspaceRoot,
            temporaryDirectory,
          });
        },
      );
    } catch (error) {
      throw sanitizeWorkspaceDownloadError(error, destination, temporaryDirectory);
    }

    return {
      localPath: destination.relativePath,
      size,
      message: `Downloaded ${params.path} from ${params.bucket} to ${destination.relativePath} (${size} bytes)`,
    };
  },
};
