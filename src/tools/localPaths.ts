/**
 * Local filesystem path helpers for B2 language model tools.
 *
 * @module tools/localPaths
 */

import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { isPathInside, resolvePathInsideReal, sanitizeLocalPathSegment } from "../pathSafety";

const DEFAULT_DOWNLOAD_NAME_MAX_BYTES = 180;

function rejectNullByte(value: string, parameterName: string): void {
  if (value.includes("\0")) {
    throw new Error(`${parameterName} must not contain null bytes.`);
  }
}

export function resolveWorkspaceRelativePath(
  workspaceRoot: string,
  relativePath: string,
  parameterName = "localPath",
): string {
  rejectNullByte(relativePath, parameterName);

  if (path.isAbsolute(relativePath)) {
    throw new Error(`${parameterName} must be workspace-relative.`);
  }

  const resolved = path.resolve(workspaceRoot, relativePath);
  return resolvePathInsideReal(workspaceRoot, resolved, parameterName, "the current workspace");
}

function currentWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isContainmentError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(" must stay within ");
}

function resolveAbsoluteToolPath(absolutePath: string, workspaceRoot: string | undefined): string {
  const allowedRoots = [
    workspaceRoot ? { root: workspaceRoot, description: "the current workspace" } : undefined,
    { root: os.tmpdir(), description: "the system temporary directory" },
  ].filter(
    (candidate): candidate is { root: string; description: string } => candidate !== undefined,
  );

  for (const allowedRoot of allowedRoots) {
    try {
      return resolvePathInsideReal(
        allowedRoot.root,
        absolutePath,
        "localPath",
        allowedRoot.description,
      );
    } catch (error) {
      if (!isContainmentError(error)) {
        throw error;
      }
    }
  }

  throw new Error(
    "localPath must stay within the current workspace or system temporary directory.",
  );
}

export function resolveToolLocalPath(
  requestedPath: string,
  missingWorkspaceMessage: string,
): string {
  rejectNullByte(requestedPath, "localPath");

  const workspaceRoot = currentWorkspaceRoot();
  if (path.isAbsolute(requestedPath)) {
    return resolveAbsoluteToolPath(requestedPath, workspaceRoot);
  }

  if (!workspaceRoot) {
    throw new Error(missingWorkspaceMessage);
  }

  return resolveWorkspaceRelativePath(workspaceRoot, requestedPath);
}

export function safeDefaultDownloadName(remotePath: string): string {
  const basename = path.posix.basename(remotePath.replace(/\\/g, "/"));
  return sanitizeLocalPathSegment(basename, {
    fallback: "download",
    maxBytes: DEFAULT_DOWNLOAD_NAME_MAX_BYTES,
    hashInput: remotePath,
    disambiguateOnChange: true,
    preserveExtension: true,
  });
}

export { isPathInside };
