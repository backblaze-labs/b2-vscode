/**
 * Pure helpers for turning B2 object names and workspace-relative input into
 * local filesystem paths without allowing path traversal.
 *
 * @module utils/localPaths
 */

import * as path from "path";

const FALLBACK_FILE_NAME = "download";

function toWellFormedUtf8(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

function encodeLocalPathSegment(segment: string): string {
  const encoded = encodeURIComponent(toWellFormedUtf8(segment)).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  if (!encoded || encoded === "." || encoded === "..") {
    return `_${encoded.replace(/\./g, "%2E") || FALLBACK_FILE_NAME}`;
  }

  return encoded;
}

function splitB2Path(fileName: string): string[] {
  return fileName.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function safeB2FileSegments(fileName: string): string[] {
  const segments = splitB2Path(fileName).map(encodeLocalPathSegment);
  return segments.length > 0 ? segments : [FALLBACK_FILE_NAME];
}

function assertRelativePathInput(relativePath: string): void {
  if (relativePath.includes("\0")) {
    throw new Error("Local path must not contain NUL bytes.");
  }

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

/**
 * Return true when `candidatePath` resolves to `rootPath` or a child of it.
 */
export function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const relativePath = path.relative(resolvedRoot, resolvedCandidate);

  return (
    relativePath === "" ||
    (!!relativePath &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Resolve path segments below `rootPath`, rejecting any result outside it.
 */
export function resolveInsideRoot(rootPath: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);

  if (!isPathInsideRoot(resolvedRoot, resolvedPath)) {
    throw new Error("Resolved path escapes the destination directory.");
  }

  return resolvedPath;
}

/**
 * Build the temp-cache path for a downloaded B2 object.
 */
export function buildTempFilePath(tempRoot: string, bucketName: string, fileName: string): string {
  return resolveInsideRoot(
    tempRoot,
    encodeLocalPathSegment(bucketName),
    ...safeB2FileSegments(fileName),
  );
}

/**
 * Derive a safe default filename for a B2 object downloaded into a workspace.
 */
export function buildDefaultDownloadFilePath(workspaceRoot: string, fileName: string): string {
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
    return buildDefaultDownloadFilePath(workspaceRoot, remotePath);
  }

  assertRelativePathInput(localPath);
  return resolveInsideRoot(workspaceRoot, localPath);
}
