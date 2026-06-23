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
import {
  assertSafeFileWritePath,
  findWorkspaceControlDirectory,
  findWorkspaceSecretPath,
  prepareSafeFileWritePath,
} from "../../services/pathSafety";
import {
  sanitizePathError,
  type PathMessageReplacement,
} from "../../services/pathErrorSanitization";
import {
  createTransferProgressReporter,
  withCancellableTransferProgress,
} from "../../services/transferProgress";
import { B2ResourceNotFoundError, B2ToolInputError } from "../../errors";
import { normalizeB2ObjectNameInput } from "../b2ObjectName";
import { sanitizeLocalPathSegment } from "../../utils/localPaths";
import { isWorkspaceControlDirectorySegment } from "../../utils/workspaceControlDirectories";
import {
  resolveToolLocalPathDetails,
  safeDefaultDownloadName,
  type ResolvedToolLocalPath,
} from "../localPaths";

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
  "No workspace folder open. The downloadFile tool requires an open workspace folder when localPath is omitted or relative.";
const LM_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;

function existingDestinationError(savePath: string): Error {
  const error = new Error(
    `File already exists at ${savePath}. Choose a different localPath.`,
  ) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}

function assertNoSensitiveWorkspaceTarget(destination: DownloadDestination): void {
  if (destination.rootKind !== "workspace") {
    return;
  }

  const blocked = findWorkspaceControlDirectory(destination.allowedRoot, destination.path);
  if (blocked) {
    throw new B2ToolInputError(
      `downloadFile refuses to write inside workspace control directories: ${blocked}`,
    );
  }

  const secret = findWorkspaceSecretPath(destination.allowedRoot, destination.path);
  if (secret) {
    throw new B2ToolInputError(`downloadFile refuses to write sensitive workspace path: ${secret}`);
  }
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

function sanitizeWorkspaceDownloadError(error: unknown, destination: DownloadDestination): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  if (destination.rootKind !== "workspace") {
    return error;
  }

  const destinationDirectory = path.dirname(destination.path);
  const relativeDirectory = path.dirname(destination.displayPath);
  const replacements: PathMessageReplacement[] = [
    { search: destination.path, replacement: destination.displayPath },
    {
      search: destinationDirectory,
      replacement: relativeDirectory === "." ? "." : relativeDirectory,
    },
    { search: destination.allowedRoot, replacement: "." },
  ];
  if (destination.workspaceRoot) {
    replacements.push({ search: destination.workspaceRoot, replacement: "." });
  }

  return sanitizePathError(error, replacements, (pathValue) =>
    relativeDisplayPath(destination.allowedRoot, pathValue, destination.displayPath),
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

  throw existingDestinationError(destinationPath);
}

type DownloadDestination = ResolvedToolLocalPath;

function normalizeRelativeDownloadLocalPath(requestedPath: string): string {
  if (requestedPath.includes("\0")) {
    throw new B2ToolInputError("localPath must not contain null bytes.");
  }
  if (path.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath)) {
    return requestedPath;
  }

  const segments = requestedPath.split(/[\\/]/);
  const finalSegment = segments[segments.length - 1];
  if (
    segments.length === 0 ||
    requestedPath.length === 0 ||
    /[\\/]/.test(requestedPath.slice(-1)) ||
    finalSegment === ".." ||
    segments.some((segment) => segment.length === 0 || segment === ".")
  ) {
    throw new B2ToolInputError("localPath must be a file path, not a directory path.");
  }
  if (segments.some((segment) => segment === "..")) {
    throw new B2ToolInputError(
      "localPath must stay within the current workspace or extension tools temporary directory.",
    );
  }
  const controlDirectory = segments.find(isWorkspaceControlDirectorySegment);
  if (controlDirectory !== undefined) {
    throw new B2ToolInputError(
      `downloadFile refuses to write inside workspace control directories: ${controlDirectory}`,
    );
  }

  return segments.map(sanitizeLocalPathSegment).join(path.sep);
}

async function workspacePath(
  remotePath: string,
  localPath?: string,
  options: { readonly createParentDirectories: boolean } = { createParentDirectories: true },
): Promise<DownloadDestination> {
  const destination = resolveToolLocalPathDetails(
    normalizeRelativeDownloadLocalPath(
      localPath !== undefined ? localPath : safeDefaultDownloadName(remotePath),
    ),
    WORKSPACE_REQUIRED_MESSAGE,
  );
  try {
    assertNoSensitiveWorkspaceTarget(destination);
    await assertDestinationDoesNotExist(destination.path);
    if (options.createParentDirectories) {
      await prepareSafeFileWritePath(
        destination.allowedRoot,
        destination.path,
        "downloadFile target",
      );
    } else {
      await assertSafeFileWritePath(
        destination.allowedRoot,
        destination.path,
        "downloadFile target",
      );
    }
    await assertDestinationDoesNotExist(destination.path);
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
    const remotePath = normalizeB2ObjectNameInput(params.path);
    let destination = await workspacePath(remotePath, params.localPath, {
      createParentDirectories: false,
    });

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    destination = await workspacePath(remotePath, destination.path, {
      createParentDirectories: true,
    });
    const savePath = destination.path;

    let size: number;
    try {
      size = await withCancellableTransferProgress(
        { title: `Downloading b2://${params.bucket}/${remotePath}...`, token },
        async ({ progress, signal }) => {
          const reporter = createTransferProgressReporter(progress);
          const download = await withTransferStallTimeout(
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

          return downloadStreamToNewFileWithinRoot(
            download.body,
            savePath,
            destination.allowedRoot,
            {
              signal,
              maxBytes: LM_DOWNLOAD_MAX_BYTES,
              knownBytes: download.headers?.contentLength,
            },
          );
        },
      );
    } catch (error) {
      throw sanitizeWorkspaceDownloadError(error, destination);
    }

    return {
      localPath: destination.displayPath,
      size,
      message: `Downloaded ${remotePath} from ${params.bucket} to ${destination.displayPath} (${size} bytes)`,
    };
  },
};
