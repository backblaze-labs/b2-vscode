/**
 * Download File operation.
 *
 * @module tools/operations/downloadFile
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { B2ToolOperation, ToolExtras } from "../types";
import { downloadStreamToFile } from "../../services/fileTransfers";
import {
  b2KeyBasename,
  isPathInsideOrEqual,
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
const CONTROL_DIRECTORIES = new Set([".git", ".hg", ".svn", ".vscode", ".idea"]);

function workspaceRelativeSegments(workspaceRoot: string, destinationPath: string): string[] {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(destinationPath));
  return relative.split(path.sep).filter((segment) => segment.length > 0);
}

function assertNoControlDirectoryTarget(workspaceRoot: string, destinationPath: string): void {
  const blocked = workspaceRelativeSegments(workspaceRoot, destinationPath).find((segment) =>
    CONTROL_DIRECTORIES.has(segment.toLowerCase()),
  );
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

async function ensureRealDirectory(directory: string): Promise<void> {
  let stats: fs.Stats | undefined;
  try {
    stats = await fs.promises.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (stats) {
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Workspace download directory must be a real directory, not a symlink or special file: ${directory}`,
      );
    }
    return;
  }

  await fs.promises.mkdir(directory, { recursive: false }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  });
  const createdStats = await fs.promises.lstat(directory);
  if (createdStats.isSymbolicLink() || !createdStats.isDirectory()) {
    throw new Error(
      `Workspace download directory must be a real directory, not a symlink or special file: ${directory}`,
    );
  }
}

async function ensureWorkspaceDestinationDirectory(
  workspaceRoot: string,
  destinationPath: string,
): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const parent = path.dirname(path.resolve(destinationPath));
  const workspaceRealPath = await fs.promises.realpath(workspaceRoot);
  const relative = path.relative(root, parent);
  let current = root;

  for (const segment of relative.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, segment);
    await ensureRealDirectory(current);
    const currentRealPath = await fs.promises.realpath(current);
    if (!isPathInsideOrEqual(workspaceRealPath, currentRealPath)) {
      throw new Error(
        `Workspace download directory resolves outside the open workspace: ${current}`,
      );
    }
  }
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
