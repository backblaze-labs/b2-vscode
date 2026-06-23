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
import { B2ToolInputError } from "../errors";
import { isWorkspaceControlDirectorySegment } from "../utils/workspaceControlDirectories";
import {
  ensureToolPrivateDirectorySync,
  isToolAbsolutePath,
  isToolPathInside,
  resolveToolPathInsideRealRoot,
  safeToolLocalBasename,
  ToolPathContainmentError,
} from "../toolPathSafety";

// Leaves enough room under common 255-byte segment limits for atomic temp suffixes.
const DEFAULT_DOWNLOAD_NAME_MAX_BYTES = 180;
const EXTENSION_TEMP_ROOT = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);

export type ToolLocalPathRootKind = "workspace" | "toolsTemp";

export interface ResolvedToolLocalPath {
  readonly path: string;
  readonly allowedRoot: string;
  readonly rootKind: ToolLocalPathRootKind;
  readonly displayPath: string;
  readonly workspaceRoot?: string;
}

export interface ResolveToolLocalPathOptions {
  readonly allowToolsTemp?: boolean;
}

function rejectNullByte(value: string, parameterName: string): void {
  if (value.includes("\0")) {
    throw new B2ToolInputError(`${parameterName} must not contain null bytes.`);
  }
}

function rejectDirectoryLikePath(value: string, parameterName: string): void {
  const portableSegments = value.split(/[\\/]+/).filter(Boolean);
  const finalSegment = portableSegments[portableSegments.length - 1];
  if (/[\\/]/.test(value.slice(-1))) {
    throw new B2ToolInputError(`${parameterName} must be a file path, not a directory path.`);
  }
  if (value.length === 0 || finalSegment === "." || finalSegment === "..") {
    throw new B2ToolInputError(`${parameterName} must be a file path, not a directory path.`);
  }
}

function portableRelativePathSegments(relativePath: string, parameterName: string): string[] {
  rejectNullByte(relativePath, parameterName);

  if (isToolAbsolutePath(relativePath)) {
    throw new B2ToolInputError(`${parameterName} must be workspace-relative.`);
  }

  const rawSegments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (rawSegments.some((segment) => segment === "..")) {
    throw new B2ToolInputError(`${parameterName} must not contain path traversal segments.`);
  }

  const segments = rawSegments.filter((segment) => segment !== ".");
  if (segments.length === 0) {
    throw new B2ToolInputError(`${parameterName} must not be empty.`);
  }

  return segments;
}

export function resolveWorkspaceRelativePath(
  workspaceRoot: string,
  relativePath: string,
  parameterName = "localPath",
): string {
  const resolved = path.resolve(
    workspaceRoot,
    ...portableRelativePathSegments(relativePath, parameterName),
  );
  const contained = resolveToolPathInsideRealRoot(
    workspaceRoot,
    resolved,
    parameterName,
    "the current workspace",
  );
  rejectSensitiveWorkspacePath(workspaceRoot, contained);
  return resolved;
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
  if (!isToolPathInside(workspaceBase, candidatePath)) {
    return;
  }

  const segments = path.relative(workspaceBase, candidatePath).split(path.sep).filter(Boolean);

  if (segments.some(isWorkspaceControlDirectorySegment)) {
    throw new B2ToolInputError(
      "localPath must not target workspace control directories such as .git or .vscode.",
    );
  }
}

function toolsTempRootCandidates(): string[] {
  const roots = [EXTENSION_TEMP_ROOT];
  try {
    roots.push(path.join(fs.realpathSync.native(os.tmpdir()), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME));
  } catch {
    // If the system temp directory cannot be resolved, the lexical root check still applies.
  }

  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function workspaceRootCandidates(workspaceRoot: string): string[] {
  const roots: string[] = [];
  try {
    const workspaceRealPath = fs.realpathSync.native(workspaceRoot);
    roots.push(workspaceRealPath);
    try {
      const tempRealPath = fs.realpathSync.native(os.tmpdir());
      if (isToolPathInside(tempRealPath, workspaceRealPath)) {
        roots.push(
          path.join(path.resolve(os.tmpdir()), path.relative(tempRealPath, workspaceRealPath)),
        );
      }
    } catch {
      // The direct workspace candidates still cover non-symlinked temp roots.
    }
  } catch {
    // The later realpath containment check will surface workspace root errors.
  }
  roots.push(workspaceRoot);

  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function workspaceDisplayPath(workspaceRoot: string, resolvedPath: string): string {
  const roots = workspaceRootCandidates(workspaceRoot);
  for (const root of roots) {
    const relativePath = path.relative(root, resolvedPath);
    if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return relativePath;
    }
    if (relativePath === "") {
      return ".";
    }
  }

  return path.relative(workspaceRoot, resolvedPath) || ".";
}

function resolveAbsoluteToolPath(
  absolutePath: string,
  workspaceRoot: string | undefined,
  options: Required<ResolveToolLocalPathOptions>,
): ResolvedToolLocalPath {
  const allowedScope = options.allowToolsTemp
    ? "the current workspace or extension tools temporary directory"
    : "the current workspace";

  if (!path.isAbsolute(absolutePath)) {
    throw new B2ToolInputError(`localPath must stay within ${allowedScope}.`);
  }

  const allowedRoots = [
    workspaceRoot
      ? {
          roots: workspaceRootCandidates(workspaceRoot),
          kind: "workspace" as const,
          description: "the current workspace",
        }
      : undefined,
    options.allowToolsTemp
      ? {
          roots: toolsTempRootCandidates(),
          kind: "toolsTemp" as const,
          description: "the extension tools temporary directory",
        }
      : undefined,
  ].filter(
    (
      candidate,
    ): candidate is {
      roots: string[];
      kind: ToolLocalPathRootKind;
      description: string;
    } => candidate !== undefined,
  );

  const resolvedAbsolutePath = path.resolve(absolutePath);
  for (const allowedRoot of allowedRoots) {
    const matchedRoot = allowedRoot.roots.find((root) =>
      isToolPathInside(root, resolvedAbsolutePath),
    );
    if (matchedRoot === undefined) {
      continue;
    }

    if (allowedRoot.kind === "toolsTemp") {
      ensureToolPrivateDirectorySync(EXTENSION_TEMP_ROOT);
      ensureToolPrivateDirectorySync(matchedRoot);
    }

    try {
      const contained = resolveToolPathInsideRealRoot(
        matchedRoot,
        absolutePath,
        "localPath",
        allowedRoot.description,
      );
      const resolved = path.resolve(absolutePath);
      if (workspaceRoot && allowedRoot.kind === "workspace") {
        rejectSensitiveWorkspacePath(workspaceRoot, contained);
      }
      return {
        path: resolved,
        allowedRoot: path.resolve(matchedRoot),
        rootKind: allowedRoot.kind,
        displayPath:
          allowedRoot.kind === "workspace" && workspaceRoot
            ? workspaceDisplayPath(workspaceRoot, resolved)
            : path.resolve(absolutePath),
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      };
    } catch (error) {
      if (!(error instanceof ToolPathContainmentError)) {
        throw error;
      }
    }
  }

  throw new B2ToolInputError(`localPath must stay within ${allowedScope}.`);
}

export function resolveToolLocalPathDetails(
  requestedPath: string,
  missingWorkspaceMessage: string,
  options: ResolveToolLocalPathOptions = {},
): ResolvedToolLocalPath {
  rejectNullByte(requestedPath, "localPath");
  rejectDirectoryLikePath(requestedPath, "localPath");
  const resolvedOptions = { allowToolsTemp: options.allowToolsTemp !== false };

  const workspaceRoot = currentWorkspaceRoot();
  if (!workspaceRoot && !resolvedOptions.allowToolsTemp) {
    throw new B2ToolInputError(missingWorkspaceMessage);
  }

  if (isToolAbsolutePath(requestedPath)) {
    return resolveAbsoluteToolPath(requestedPath, workspaceRoot, resolvedOptions);
  }

  if (!workspaceRoot) {
    throw new B2ToolInputError(missingWorkspaceMessage);
  }

  const resolved = resolveWorkspaceRelativePath(workspaceRoot, requestedPath);
  return {
    path: resolved,
    allowedRoot: path.resolve(workspaceRoot),
    rootKind: "workspace",
    displayPath: workspaceDisplayPath(workspaceRoot, resolved),
    workspaceRoot,
  };
}

export function resolveToolLocalPath(
  requestedPath: string,
  missingWorkspaceMessage: string,
): string {
  return resolveToolLocalPathDetails(requestedPath, missingWorkspaceMessage).path;
}

export function safeDefaultDownloadName(remotePath: string): string {
  return safeToolLocalBasename(remotePath, {
    fallback: "download",
    maxBytes: DEFAULT_DOWNLOAD_NAME_MAX_BYTES,
    hashInput: remotePath,
    disambiguateOnChange: true,
    preserveExtension: true,
  });
}

export { isToolPathInside };
