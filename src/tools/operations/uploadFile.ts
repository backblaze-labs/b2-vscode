/**
 * Upload File operation.
 *
 * @module tools/operations/uploadFile
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError, B2ToolInputError } from "../../errors";
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
  findWorkspaceSecretPath,
  isPathInsideOrEqual,
} from "../../services/pathSafety";
import { sanitizePathError } from "../../services/pathErrorSanitization";
import {
  createTransferProgressReporter,
  withCancellableTransferProgress,
} from "../../services/transferProgress";
import { resolveToolLocalPathDetails, type ResolvedToolLocalPath } from "../localPaths";

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
    throw new B2ToolInputError(
      `uploadFile refuses to read inside workspace control directory: ${blocked}`,
    );
  }
  const secret = findWorkspaceSecretPath(workspaceRoot, localPath);
  if (secret) {
    throw new B2ToolInputError(`uploadFile refuses to read sensitive workspace path: ${secret}`);
  }
}

function sanitizeWorkspaceLocalError(
  error: unknown,
  displayPath: string,
  absolutePaths: ReadonlyArray<string | undefined>,
): unknown {
  const replacementPath = displayPath || ".";
  return sanitizePathError(
    error,
    absolutePaths.map((absolutePath) => ({ search: absolutePath, replacement: replacementPath })),
    () => replacementPath,
  );
}

interface ResolvedUploadSource {
  readonly source: UploadSourceFile;
  readonly displayPath: string;
}

function allowedRootDescription(resolvedPath: ResolvedToolLocalPath): string {
  return resolvedPath.rootKind === "workspace"
    ? "the open workspace"
    : "the extension tools temporary directory";
}

async function workspaceUploadSource(requestedPath: string): Promise<ResolvedUploadSource> {
  const resolvedPath = resolveToolLocalPathDetails(
    requestedPath,
    "No workspace folder open. The uploadFile tool requires an open workspace folder for localPath inputs.",
    { allowToolsTemp: false },
  );
  if (resolvedPath.rootKind === "workspace") {
    assertNoControlDirectoryRead(resolvedPath.allowedRoot, resolvedPath.path);
  }

  let allowedRootRealPath: string | undefined;
  let localRealPath: string | undefined;
  let source: UploadSourceFile | undefined;
  try {
    [allowedRootRealPath, localRealPath] = await Promise.all([
      fs.promises.realpath(resolvedPath.allowedRoot),
      fs.promises.realpath(resolvedPath.path),
    ]);
    if (!isPathInsideOrEqual(allowedRootRealPath, localRealPath)) {
      throw new B2ToolInputError(
        `localPath resolves outside ${allowedRootDescription(resolvedPath)}: ${
          resolvedPath.displayPath
        }`,
      );
    }
    if (resolvedPath.rootKind === "workspace") {
      assertNoControlDirectoryRead(allowedRootRealPath, localRealPath);
    }
    const localRealStats = await fs.promises.stat(localRealPath);
    source = await openUploadSourceFile(resolvedPath.path);
    if (!sameFileIdentity(source.stats, localRealStats)) {
      throw new B2ToolInputError(
        `localPath changed while opening upload source: ${resolvedPath.displayPath}`,
      );
    }

    return { source, displayPath: resolvedPath.displayPath };
  } catch (error) {
    if (source) {
      await closeUploadSource(source);
    }
    throw sanitizeWorkspaceLocalError(error, resolvedPath.displayPath, [
      resolvedPath.path,
      localRealPath,
      allowedRootRealPath,
      resolvedPath.allowedRoot,
      resolvedPath.workspaceRoot,
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

    const uploadSource = await workspaceUploadSource(params.localPath);
    const { source } = uploadSource;
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
        message: `Uploaded ${uploadSource.displayPath} to b2://${params.bucket}/${remotePath} (${result.contentLength} bytes, ID: ${result.fileId})`,
      };
    } finally {
      if (!sourceConsumed) {
        await closeUploadSource(source);
      }
    }
  },
};
