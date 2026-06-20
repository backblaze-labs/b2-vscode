/**
 * Helpers for turning B2 object names and workspace-relative input into local
 * filesystem paths. Containment and safe-write primitives live in
 * services/pathSafety.
 *
 * @module utils/localPaths
 */

import { Buffer } from "buffer";
import { toWellFormedString } from "./strings";
import {
  assertNoNul,
  assertSafeFileWritePath,
  isAbsolutePortable,
  resolveInsideRoot,
  UnsafePathError,
} from "../services/pathSafety";

const ENCODED_SEGMENT_PREFIX = "__b2_";
const UNSAFE_LOCAL_PATH_CHARACTERS = /[\u0000-\u001F\u007F<>:"|?*\\/]/g;
const UNSAFE_BIDI_CONTROL_CHARACTERS = /[\u202A-\u202E\u2066-\u2069]/g;
const UNSAFE_LOCAL_PATH_TRAILING_CHARACTERS = /[. ]+$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WORKSPACE_CONTROL_DIRECTORY_SEGMENTS = new Set([".git", ".hg", ".svn", ".vscode", ".idea"]);

function encodeRawLocalPathSegment(segment: string): string {
  return `${ENCODED_SEGMENT_PREFIX}${segment ? Buffer.from(segment, "utf8").toString("hex") : "empty"}`;
}

export function sanitizeLocalPathSegment(segment: string): string {
  const wellFormedSegment = toWellFormedString(segment);
  const sanitized = wellFormedSegment
    .replace(UNSAFE_LOCAL_PATH_CHARACTERS, "_")
    .replace(UNSAFE_BIDI_CONTROL_CHARACTERS, "_")
    .replace(UNSAFE_LOCAL_PATH_TRAILING_CHARACTERS, (trailing) => "_".repeat(trailing.length));

  if (
    !wellFormedSegment ||
    sanitized !== wellFormedSegment ||
    WINDOWS_RESERVED_NAME.test(sanitized) ||
    WORKSPACE_CONTROL_DIRECTORY_SEGMENTS.has(sanitized.toLowerCase()) ||
    sanitized.startsWith(ENCODED_SEGMENT_PREFIX)
  ) {
    return encodeRawLocalPathSegment(wellFormedSegment);
  }

  return sanitized;
}

function safeB2FileSegments(fileName: string): string[] {
  return fileName.split("/").map(sanitizeLocalPathSegment);
}

function assertFilePathInput(localPath: string): void {
  if (/[\\/]/.test(localPath.slice(-1))) {
    throw new UnsafePathError("localPath must be a file path, not a directory path.");
  }
}

function safeLocalPathInputSegments(localPath: string): string[] {
  assertNoNul(localPath, "localPath");
  assertFilePathInput(localPath);
  if (isAbsolutePortable(localPath)) {
    throw new UnsafePathError("localPath must be relative to the workspace.");
  }

  const segments = localPath.split(/[\\/]+/);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new UnsafePathError("localPath must not contain empty or traversal segments.");
  }

  return segments.map(sanitizeLocalPathSegment);
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
export async function resolveDownloadSavePath(
  workspaceRoot: string,
  remotePath: string,
  localPath?: string,
): Promise<string> {
  if (!localPath) {
    const defaultPath = buildDefaultDownloadFilePath(workspaceRoot, remotePath);
    await assertSafeFileWritePath(workspaceRoot, defaultPath);
    return defaultPath;
  }

  const resolvedPath = resolveInsideRoot(workspaceRoot, ...safeLocalPathInputSegments(localPath));
  await assertSafeFileWritePath(workspaceRoot, resolvedPath);
  return resolvedPath;
}
