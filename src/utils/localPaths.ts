/**
 * Helpers for turning B2 object names and workspace-relative input into local
 * filesystem paths without allowing path traversal.
 *
 * @module utils/localPaths
 */

import * as fs from "fs";
import * as path from "path";
import { Buffer } from "buffer";
import { toWellFormedString } from "./strings";

const ENCODED_SEGMENT_PREFIX = "__b2_";
const UNSAFE_LOCAL_PATH_CHARACTERS = /[\u0000-\u001F<>:"|?*\\/]/g;
const UNSAFE_LOCAL_PATH_TRAILING_CHARACTERS = /[. ]+$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function encodeRawLocalPathSegment(segment: string): string {
  return `${ENCODED_SEGMENT_PREFIX}${segment ? Buffer.from(segment, "utf8").toString("hex") : "empty"}`;
}

function sanitizeLocalPathSegment(segment: string): string {
  const wellFormedSegment = toWellFormedString(segment);
  const sanitized = wellFormedSegment
    .replace(UNSAFE_LOCAL_PATH_CHARACTERS, "_")
    .replace(UNSAFE_LOCAL_PATH_TRAILING_CHARACTERS, (trailing) => "_".repeat(trailing.length));

  if (
    !wellFormedSegment ||
    sanitized !== wellFormedSegment ||
    WINDOWS_RESERVED_NAME.test(sanitized) ||
    sanitized.startsWith(ENCODED_SEGMENT_PREFIX)
  ) {
    return encodeRawLocalPathSegment(wellFormedSegment);
  }

  return sanitized;
}

function safeB2FileSegments(fileName: string): string[] {
  return fileName.split("/").map(sanitizeLocalPathSegment);
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
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isPathInsideRoot(resolvedRoot, resolvedCandidate)) {
    throw pathSafetyError(
      "Resolved path escapes the destination directory.",
      resolvedRoot,
      resolvedCandidate,
      "lexical_escape",
    );
  }
}

function pathSafetyError(
  message: string,
  rootPath: string,
  candidatePath: string,
  reason: string,
): Error {
  const error = new Error(
    `${message} (reason=${reason}; root=${JSON.stringify(path.resolve(rootPath))}; candidate=${JSON.stringify(path.resolve(candidatePath))})`,
  ) as Error & { code?: string };
  error.code = `B2_PATH_${reason.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  return error;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.promises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingPath(candidatePath: string): Promise<string> {
  let currentPath = candidatePath;
  for (;;) {
    if (await pathExists(currentPath)) {
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
export async function assertSafeWritePath(rootPath: string, candidatePath: string): Promise<void> {
  assertNoNulPath(rootPath);
  assertNoNulPath(candidatePath);

  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  assertLexicallyInsideRoot(resolvedRoot, resolvedCandidate);

  const realRoot = await fs.promises.realpath(resolvedRoot);
  const existingPath = await nearestExistingPath(resolvedCandidate);
  const realExistingPath = await fs.promises.realpath(existingPath);

  if (!isPathInsideRoot(realRoot, realExistingPath)) {
    throw pathSafetyError(
      "Resolved path escapes the destination directory through a symlink.",
      realRoot,
      realExistingPath,
      "symlink_escape",
    );
  }

  if (await pathExists(resolvedCandidate)) {
    const candidateStats = await fs.promises.lstat(resolvedCandidate);
    if (candidateStats.isSymbolicLink()) {
      throw pathSafetyError(
        "Destination path must not be a symlink.",
        resolvedRoot,
        resolvedCandidate,
        "final_symlink",
      );
    }
  }
}

/**
 * Verify that a file write target is safely contained and is not a directory.
 */
export async function assertSafeFileWritePath(
  rootPath: string,
  candidatePath: string,
): Promise<void> {
  const resolvedCandidate = path.resolve(candidatePath);
  await assertSafeWritePath(rootPath, resolvedCandidate);

  if (await pathExists(resolvedCandidate)) {
    const candidateStats = await fs.promises.lstat(resolvedCandidate);
    if (candidateStats.isDirectory()) {
      throw pathSafetyError(
        "Destination must be a file path, not a directory.",
        rootPath,
        resolvedCandidate,
        "directory_target",
      );
    }
  }
}

/**
 * Create the parent directory for a safe file write, then re-check containment
 * after mkdir so a concurrently-created symlink cannot redirect the write.
 */
export async function prepareSafeFileWritePath(
  rootPath: string,
  candidatePath: string,
): Promise<void> {
  const resolvedCandidate = path.resolve(candidatePath);
  const parentPath = path.dirname(resolvedCandidate);

  await assertSafeWritePath(rootPath, parentPath);
  await fs.promises.mkdir(parentPath, { recursive: true });
  await assertSafeWritePath(rootPath, parentPath);
  await assertSafeFileWritePath(rootPath, resolvedCandidate);
}

/**
 * Write a file after opening the final path with symlink-following disabled
 * when the platform supports O_NOFOLLOW.
 */
export async function writeFileNoFollow(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fileHandle = await fs.promises.open(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollowFlag,
    0o600,
  );

  try {
    await fileHandle.writeFile(data);
  } finally {
    await fileHandle.close();
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

  assertRelativePathInput(localPath);
  const resolvedPath = resolveInsideRoot(workspaceRoot, localPath);
  await assertSafeFileWritePath(workspaceRoot, resolvedPath);
  return resolvedPath;
}
