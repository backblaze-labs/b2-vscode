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
import {
  ensurePrivateDirectorySync,
  isAbsolutePortable,
  isPathInside,
  PathContainmentError,
  resolvePathInsideReal,
  safeLocalBasename,
} from "../pathSafety";

// Leaves enough room under common 255-byte segment limits for atomic temp suffixes.
const DEFAULT_DOWNLOAD_NAME_MAX_BYTES = 180;
const EXTENSION_TEMP_ROOT = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
const SENSITIVE_WORKSPACE_DIRECTORIES = new Set([".git", ".hg", ".svn", ".vscode", ".idea"]);

export type ToolLocalPathRootKind = "workspace" | "toolsTemp";

export interface ResolvedToolLocalPath {
  readonly path: string;
  readonly allowedRoot: string;
  readonly rootKind: ToolLocalPathRootKind;
  readonly displayPath: string;
  readonly workspaceRoot?: string;
}

function rejectNullByte(value: string, parameterName: string): void {
  if (value.includes("\0")) {
    throw new B2ToolInputError(`${parameterName} must not contain null bytes.`);
  }
}

function rejectDirectoryLikePath(value: string, parameterName: string): void {
  if (/[\\/]/.test(value.slice(-1))) {
    throw new B2ToolInputError(`${parameterName} must be a file path, not a directory path.`);
  }
}

export function resolveWorkspaceRelativePath(
  workspaceRoot: string,
  relativePath: string,
  parameterName = "localPath",
): string {
  rejectNullByte(relativePath, parameterName);

  if (isAbsolutePortable(relativePath)) {
    throw new B2ToolInputError(`${parameterName} must be workspace-relative.`);
  }

  const resolved = path.resolve(workspaceRoot, relativePath);
  const contained = resolvePathInsideReal(
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
  if (!isPathInside(workspaceBase, candidatePath)) {
    return;
  }

  const segments = path
    .relative(workspaceBase, candidatePath)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  if (segments.some((segment) => SENSITIVE_WORKSPACE_DIRECTORIES.has(segment))) {
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
      if (isPathInside(tempRealPath, workspaceRealPath)) {
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

function isPotentialToolsTempPath(resolvedAbsolutePath: string): boolean {
  return toolsTempRootCandidates().some((root) => isPathInside(root, resolvedAbsolutePath));
}

function isPotentialWorkspacePath(workspaceRoot: string, resolvedAbsolutePath: string): boolean {
  return workspaceRootCandidates(workspaceRoot).some((root) =>
    isPathInside(root, resolvedAbsolutePath),
  );
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
): ResolvedToolLocalPath {
  if (!path.isAbsolute(absolutePath)) {
    throw new B2ToolInputError(
      "localPath must stay within the current workspace or extension tools temporary directory.",
    );
  }

  const allowedRoots = [
    workspaceRoot
      ? { root: workspaceRoot, kind: "workspace" as const, description: "the current workspace" }
      : undefined,
    {
      root: EXTENSION_TEMP_ROOT,
      kind: "toolsTemp" as const,
      description: "the extension tools temporary directory",
    },
  ].filter(
    (candidate): candidate is { root: string; kind: ToolLocalPathRootKind; description: string } =>
      candidate !== undefined,
  );

  const resolvedAbsolutePath = path.resolve(absolutePath);
  for (const allowedRoot of allowedRoots) {
    if (allowedRoot.root === EXTENSION_TEMP_ROOT) {
      if (!isPotentialToolsTempPath(resolvedAbsolutePath)) {
        continue;
      }
      ensurePrivateDirectorySync(EXTENSION_TEMP_ROOT);
    } else if (!isPotentialWorkspacePath(allowedRoot.root, resolvedAbsolutePath)) {
      continue;
    }

    try {
      const contained = resolvePathInsideReal(
        allowedRoot.root,
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
        allowedRoot: path.resolve(allowedRoot.root),
        rootKind: allowedRoot.kind,
        displayPath:
          allowedRoot.kind === "workspace" && workspaceRoot
            ? workspaceDisplayPath(workspaceRoot, resolved)
            : path.resolve(absolutePath),
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      };
    } catch (error) {
      if (!(error instanceof PathContainmentError)) {
        throw error;
      }
    }
  }

  throw new B2ToolInputError(
    "localPath must stay within the current workspace or extension tools temporary directory.",
  );
}

export function resolveToolLocalPathDetails(
  requestedPath: string,
  missingWorkspaceMessage: string,
): ResolvedToolLocalPath {
  rejectNullByte(requestedPath, "localPath");
  rejectDirectoryLikePath(requestedPath, "localPath");

  const workspaceRoot = currentWorkspaceRoot();
  if (isAbsolutePortable(requestedPath)) {
    return resolveAbsoluteToolPath(requestedPath, workspaceRoot);
  }

  if (!workspaceRoot) {
    throw new Error(missingWorkspaceMessage);
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
  return safeLocalBasename(remotePath, {
    fallback: "download",
    maxBytes: DEFAULT_DOWNLOAD_NAME_MAX_BYTES,
    hashInput: remotePath,
    disambiguateOnChange: true,
    preserveExtension: true,
  });
}

export { isPathInside };
