/**
 * Local filesystem path helpers for B2 language model tools.
 *
 * @module tools/localPaths
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as vscode from "vscode";
import { TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME } from "../constants";
import {
  ensurePrivateDirectorySync,
  isPathInside,
  PathContainmentError,
  resolvePathInsideReal,
  safeLocalBasename,
} from "../pathSafety";

// Leaves enough room under common 255-byte segment limits for atomic temp suffixes.
const DEFAULT_DOWNLOAD_NAME_MAX_BYTES = 180;
const EXTENSION_TEMP_ROOT = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
const SENSITIVE_WORKSPACE_DIRECTORIES = new Set([".git", ".hg", ".svn", ".vscode", ".idea"]);

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
  const contained = resolvePathInsideReal(
    workspaceRoot,
    resolved,
    parameterName,
    "the current workspace",
  );
  rejectSensitiveWorkspacePath(workspaceRoot, contained);
  return contained;
}

function currentWorkspaceRoot(): string | undefined {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    fs.lstatSync(workspaceRoot);
    return workspaceRoot;
  } catch {
    return undefined;
  }
}

function rejectSensitiveWorkspacePath(workspaceRoot: string, candidatePath: string): void {
  const workspaceBase = fs.realpathSync.native(workspaceRoot);
  if (!isPathInside(workspaceBase, candidatePath)) {
    return;
  }

  const segments = path
    .relative(workspaceBase, candidatePath)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  if (segments.some((segment) => SENSITIVE_WORKSPACE_DIRECTORIES.has(segment))) {
    throw new Error(
      "localPath must not target workspace control directories such as .git or .vscode.",
    );
  }
}

function resolveAbsoluteToolPath(absolutePath: string, workspaceRoot: string | undefined): string {
  ensurePrivateDirectorySync(EXTENSION_TEMP_ROOT);
  const allowedRoots = [
    workspaceRoot ? { root: workspaceRoot, description: "the current workspace" } : undefined,
    { root: EXTENSION_TEMP_ROOT, description: "the extension tools temporary directory" },
  ].filter(
    (candidate): candidate is { root: string; description: string } => candidate !== undefined,
  );

  for (const allowedRoot of allowedRoots) {
    try {
      const resolved = resolvePathInsideReal(
        allowedRoot.root,
        absolutePath,
        "localPath",
        allowedRoot.description,
      );
      if (workspaceRoot && allowedRoot.root === workspaceRoot) {
        rejectSensitiveWorkspacePath(workspaceRoot, resolved);
      }
      return resolved;
    } catch (error) {
      if (!(error instanceof PathContainmentError)) {
        throw error;
      }
    }
  }

  throw new Error(
    "localPath must stay within the current workspace or extension tools temporary directory.",
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
  return safeLocalBasename(remotePath, {
    fallback: "download",
    maxBytes: DEFAULT_DOWNLOAD_NAME_MAX_BYTES,
    hashInput: remotePath,
    disambiguateOnChange: true,
    preserveExtension: true,
  });
}

export { isPathInside };
