/**
 * Local filesystem path helpers for B2 language model tools.
 *
 * @module tools/localPaths
 */

import * as path from "path";
import * as crypto from "crypto";
import * as vscode from "vscode";

const MAX_LOCAL_FILE_NAME_LENGTH = 96;

function contentHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function rejectNullByte(value: string, parameterName: string): void {
  if (value.includes("\0")) {
    throw new Error(`${parameterName} must not contain null bytes.`);
  }
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);

  return (
    relative === "" ||
    (!!relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function resolveWorkspaceRelativePath(
  workspaceRoot: string,
  relativePath: string,
  parameterName = "localPath",
): string {
  rejectNullByte(relativePath, parameterName);

  if (path.isAbsolute(relativePath)) {
    return path.normalize(relativePath);
  }

  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!isPathInside(workspaceRoot, resolved)) {
    throw new Error(`${parameterName} must stay within the current workspace.`);
  }

  return resolved;
}

export function resolveToolLocalPath(
  requestedPath: string,
  missingWorkspaceMessage: string,
): string {
  rejectNullByte(requestedPath, "localPath");

  if (path.isAbsolute(requestedPath)) {
    return path.normalize(requestedPath);
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error(missingWorkspaceMessage);
  }

  return resolveWorkspaceRelativePath(workspaceFolder.uri.fsPath, requestedPath);
}

export function safeDefaultDownloadName(remotePath: string): string {
  const basename = path.posix.basename(remotePath.replace(/\\/g, "/"));
  const sanitized = basename
    .replace(/[\0-\x1f\x7f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "download";
  }
  if (sanitized.length <= MAX_LOCAL_FILE_NAME_LENGTH) {
    return sanitized;
  }

  return `${sanitized.slice(0, MAX_LOCAL_FILE_NAME_LENGTH)}-${contentHash(remotePath)}`;
}
