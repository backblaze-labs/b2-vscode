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
  assertUploadSourcePathUnchanged,
  closeUploadSource,
  openUploadSourceFile,
  sameFileIdentity,
  uploadFileFromDisk,
  type UploadSourceFile,
} from "../../services/fileTransfers";
import {
  findWorkspaceControlDirectory,
  isPathInsideOrEqual,
  resolveContainedRelativePath,
} from "../../services/pathSafety";
import {
  createTransferProgressReporter,
  withCancellableTransferProgress,
} from "../../services/transferProgress";

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

function assertNoControlDirectoryRead(workspaceRoot: string, localPath: string): void {
  const blocked = findWorkspaceControlDirectory(workspaceRoot, localPath);
  if (blocked) {
    throw new Error(`uploadFile refuses to read inside workspace control directory: ${blocked}`);
  }
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

function sanitizeWorkspaceLocalError(
  error: unknown,
  relativePath: string,
  absolutePaths: ReadonlyArray<string | undefined>,
): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const displayPath = relativePath || ".";
  const errnoError = error as NodeJS.ErrnoException;
  let message = error.message;
  const pathsToReplace = [
    ...absolutePaths,
    typeof errnoError.path === "string" ? errnoError.path : undefined,
  ];
  for (const absolutePath of pathsToReplace) {
    message = replaceAllLiteral(message, absolutePath ?? "", displayPath);
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
    (sanitized as NodeJS.ErrnoException).path = displayPath;
  }
  return sanitized;
}

async function workspaceUploadSource(relativePath: string): Promise<UploadSourceFile> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("No workspace folder open. The uploadFile tool only reads workspace files.");
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const lexicalPath = resolveContainedRelativePath(workspaceRoot, relativePath, "localPath");
  assertNoControlDirectoryRead(workspaceRoot, lexicalPath);

  let workspaceRealPath: string | undefined;
  let localRealPath: string | undefined;
  let source: UploadSourceFile | undefined;
  try {
    [workspaceRealPath, localRealPath] = await Promise.all([
      fs.promises.realpath(workspaceRoot),
      fs.promises.realpath(lexicalPath),
    ]);
    if (!isPathInsideOrEqual(workspaceRealPath, localRealPath)) {
      throw new Error(`localPath resolves outside the open workspace: ${relativePath}`);
    }
    assertNoControlDirectoryRead(workspaceRealPath, localRealPath);
    const localRealStats = await fs.promises.stat(localRealPath);
    source = await openUploadSourceFile(lexicalPath);
    if (!sameFileIdentity(source.stats, localRealStats)) {
      throw new Error(`localPath changed while opening upload source: ${relativePath}`);
    }

    return source;
  } catch (error) {
    if (source) {
      await closeUploadSource(source);
    }
    throw sanitizeWorkspaceLocalError(error, relativePath, [
      lexicalPath,
      localRealPath,
      workspaceRealPath,
      workspaceRoot,
    ]);
  }
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

    const source = await workspaceUploadSource(params.localPath);
    let sourceConsumed = false;

    try {
      const bucket = await client.getBucket(params.bucket);
      if (!bucket) {
        throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
      }

      // Resolve remote path
      const remotePath = params.remotePath ?? path.basename(source.path);
      await assertUploadSourcePathUnchanged(source);

      const result = await withCancellableTransferProgress(
        {
          title: `Uploading ${path.basename(source.path)} to b2://${params.bucket}/${remotePath}...`,
          token,
        },
        ({ progress, signal }) => {
          sourceConsumed = true;
          return uploadFileFromDisk(bucket, source, remotePath, {
            signal,
            onProgress: createTransferProgressReporter(progress, source.stats.size),
          });
        },
      );

      return {
        fileId: result.fileId,
        fileName: result.fileName,
        size: result.contentLength,
        message: `Uploaded ${params.localPath} to b2://${params.bucket}/${remotePath} (${result.contentLength} bytes, ID: ${result.fileId})`,
      };
    } finally {
      if (!sourceConsumed) {
        await closeUploadSource(source);
      }
    }
  },
};
