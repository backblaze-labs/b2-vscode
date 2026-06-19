/**
 * Helpers for turning B2 object names and workspace-relative input into local
 * filesystem paths without allowing path traversal.
 *
 * @module utils/localPaths
 */

import * as fs from "fs";
import * as path from "path";
import { toWellFormedString } from "./strings";

const FALLBACK_FILE_NAME = "download";
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function sanitizeLocalPathSegment(segment: string): string {
  const sanitized = toWellFormedString(segment)
    .replace(/[\u0000-\u001F<>:"|?*\\/]/g, "_")
    .replace(/[. ]+$/g, (trailing) => "_".repeat(trailing.length));

  const safeSegment = sanitized || FALLBACK_FILE_NAME;

  return WINDOWS_RESERVED_NAME.test(safeSegment) ? `_${safeSegment}` : safeSegment;
}

function splitB2Path(fileName: string): string[] {
  return fileName.split("/");
}

function safeB2FileSegments(fileName: string): string[] {
  return splitB2Path(fileName).map(sanitizeLocalPathSegment);
}

function assertNoNulPath(value: string): void {
  if (value.includes("\0")) {
    throw new Error("Local path must not contain NUL bytes.");
  }
}

function assertRelativePathInput(relativePath: string): void {
  assertNoNulPath(relativePath);

  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("Local path must be relative to the workspace.");
  }

  let depth = 0;
  for (const segment of relativePath.split(/[\\/]+/)) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (depth === 0) {
        throw new Error("Local path must stay inside the workspace.");
      }
      depth--;
    } else {
      depth++;
    }
  }
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);

  return (
    relativePath === "" ||
    (!!relativePath &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function assertLexicallyInsideRoot(rootPath: string, candidatePath: string): void {
  if (!isPathInsideRoot(path.resolve(rootPath), path.resolve(candidatePath))) {
    throw new Error("Resolved path escapes the destination directory.");
  }
}

function nearestExistingPath(candidatePath: string): string {
  let currentPath = candidatePath;
  for (;;) {
    if (fs.existsSync(currentPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }
    currentPath = parentPath;
  }
}

function resolveInsideRoot(rootPath: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);

  assertLexicallyInsideRoot(resolvedRoot, resolvedPath);
  return resolvedPath;
}

/**
 * Verify that a path to be written cannot escape `rootPath`, including through
 * existing symlinks in the path prefix. Call this immediately before writes.
 */
export function assertSafeWritePath(rootPath: string, candidatePath: string): void {
  assertNoNulPath(rootPath);
  assertNoNulPath(candidatePath);

  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  assertLexicallyInsideRoot(resolvedRoot, resolvedCandidate);

  const realRoot = fs.realpathSync.native(resolvedRoot);
  const existingPath = nearestExistingPath(resolvedCandidate);
  const realExistingPath = fs.realpathSync.native(existingPath);

  if (!isPathInsideRoot(realRoot, realExistingPath)) {
    throw new Error("Resolved path escapes the destination directory through a symlink.");
  }

  if (fs.existsSync(resolvedCandidate)) {
    const candidateStats = fs.lstatSync(resolvedCandidate);
    if (candidateStats.isSymbolicLink()) {
      throw new Error("Destination path must not be a symlink.");
    }
  }
}

/**
 * Build the temp-cache path for a downloaded B2 object.
 */
export function buildTempFilePath(tempRoot: string, bucketName: string, fileName: string): string {
  return resolveInsideRoot(
    tempRoot,
    sanitizeLocalPathSegment(bucketName),
    ...safeB2FileSegments(fileName),
  );
}

function buildDefaultDownloadFilePath(workspaceRoot: string, fileName: string): string {
  const segments = safeB2FileSegments(fileName);
  return resolveInsideRoot(workspaceRoot, segments[segments.length - 1]);
}

/**
 * Resolve a tool download destination. User-provided paths must be
 * workspace-relative and are constrained to the workspace root.
 */
export function resolveDownloadSavePath(
  workspaceRoot: string,
  remotePath: string,
  localPath?: string,
): string {
  if (!localPath) {
    const defaultPath = buildDefaultDownloadFilePath(workspaceRoot, remotePath);
    assertSafeWritePath(workspaceRoot, defaultPath);
    return defaultPath;
  }

  assertRelativePathInput(localPath);
  const resolvedPath = resolveInsideRoot(workspaceRoot, localPath);
  assertSafeWritePath(workspaceRoot, resolvedPath);
  return resolvedPath;
}
