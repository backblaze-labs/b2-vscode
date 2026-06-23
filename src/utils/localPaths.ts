/**
 * Helpers for turning B2 object names and workspace-relative input into local
 * filesystem paths. Containment and safe-write primitives live in
 * services/pathSafety.
 *
 * @module utils/localPaths
 */

import { Buffer } from "buffer";
import { createHash } from "crypto";
import * as path from "path";
import { toWellFormedString } from "./strings";
import {
  assertNoNul,
  assertSafeFileWritePath,
  isAbsolutePortable,
  resolveInsideRoot,
  UnsafePathError,
} from "../services/pathSafety";
import { isWorkspaceControlDirectorySegment } from "./workspaceControlDirectories";

const ENCODED_SEGMENT_PREFIX = "__b2_";
const HASHED_ENCODED_SEGMENT_PREFIX = "__b2h_";
const MAX_ENCODED_SEGMENT_LENGTH = 120;
const MAX_NATURAL_SEGMENT_BYTES = 180;
const LONG_SEGMENT_HASH_LENGTH = 16;
const HASHED_SEGMENT_HEX_PREFIX_LENGTH = 32;
const UNSAFE_LOCAL_PATH_CHARACTERS = /[\u0000-\u001F\u007F<>:"|?*\\/]/g;
const UNSAFE_BIDI_CONTROL_CHARACTERS = /[\u202A-\u202E\u2066-\u2069]/g;
const UNSAFE_LOCAL_PATH_TRAILING_CHARACTERS = /[. ]+$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function encodeRawLocalPathSegment(segment: string): string {
  if (!segment) {
    return `${ENCODED_SEGMENT_PREFIX}empty`;
  }

  const bytes = Buffer.from(segment, "utf8");
  const hex = bytes.toString("hex");
  const encoded = `${ENCODED_SEGMENT_PREFIX}${hex}`;
  if (encoded.length <= MAX_ENCODED_SEGMENT_LENGTH) {
    return encoded;
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${HASHED_ENCODED_SEGMENT_PREFIX}${hex.slice(0, HASHED_SEGMENT_HEX_PREFIX_LENGTH)}_${digest}`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let usedBytes = 0;

  for (const character of value) {
    const characterBytes = byteLength(character);
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    usedBytes += characterBytes;
  }

  return result;
}

function safeExtensionForSegment(segment: string): string {
  const extension = path.posix.extname(segment);
  if (
    !extension ||
    extension === segment ||
    byteLength(extension) > Math.floor(MAX_NATURAL_SEGMENT_BYTES / 3)
  ) {
    return "";
  }

  return extension;
}

function fitLongNaturalSegment(segment: string, hashInput: string): string {
  const extension = safeExtensionForSegment(segment);
  const stem = extension ? segment.slice(0, -extension.length) : segment;
  const digest = createHash("sha256")
    .update(Buffer.from(hashInput, "utf8"))
    .digest("hex")
    .slice(0, LONG_SEGMENT_HASH_LENGTH);
  const suffix = `-${digest}${extension}`;
  const maxStemBytes = Math.max(1, MAX_NATURAL_SEGMENT_BYTES - byteLength(suffix));
  return `${truncateUtf8(stem, maxStemBytes) || "file"}${suffix}`;
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
    isWorkspaceControlDirectorySegment(sanitized) ||
    sanitized.startsWith(ENCODED_SEGMENT_PREFIX) ||
    sanitized.startsWith(HASHED_ENCODED_SEGMENT_PREFIX)
  ) {
    return encodeRawLocalPathSegment(wellFormedSegment);
  }

  if (byteLength(sanitized) > MAX_NATURAL_SEGMENT_BYTES) {
    return fitLongNaturalSegment(sanitized, wellFormedSegment);
  }

  return sanitized;
}

export function portablePathBasename(filePath: string, fallback = ""): string {
  const segments = filePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? fallback;
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
    throw new UnsafePathError(
      "localPath must be a relative path inside the allowed directory and relative to the workspace.",
    );
  }

  const segments = localPath.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new UnsafePathError("localPath must not contain path traversal segments.");
  }
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    throw new UnsafePathError("localPath must not contain empty or dot segments.");
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
