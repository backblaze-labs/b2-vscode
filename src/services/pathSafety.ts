/**
 * Local filesystem path safety helpers.
 *
 * @module services/pathSafety
 */

import * as fs from "fs";
import * as path from "path";
import { Buffer } from "buffer";
import type { FileHandle } from "fs/promises";
import { isWorkspaceControlDirectorySegment } from "../utils/workspaceControlDirectories";

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

export function isAbsolutePortable(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function assertNoNul(value: string, label: string): void {
  if (value.includes("\0")) {
    throw new UnsafePathError(`${label} must not contain NUL bytes.`);
  }
}

function portableSegments(relativePath: string, label: string): string[] {
  assertNoNul(relativePath, label);
  if (isAbsolutePortable(relativePath)) {
    throw new UnsafePathError(`${label} must be a relative path inside the allowed directory.`);
  }

  const segments = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    throw new UnsafePathError(`${label} must not be empty.`);
  }
  if (segments.some((segment) => segment === "..")) {
    throw new UnsafePathError(`${label} must not contain path traversal segments.`);
  }

  return segments;
}

export interface EnsureRealDirectoryOptions {
  readonly mode?: number;
  readonly recursive?: boolean;
}

export function assertRealDirectory(stats: fs.Stats, directory: string, label: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `${label} must be a real directory, not a symlink or special file: ${directory}`,
    );
  }
}

export async function pathExistsAsRealDirectory(
  directory: string,
  label: string,
): Promise<boolean> {
  try {
    assertRealDirectory(await fs.promises.lstat(directory), directory, label);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function ensureRealDirectorySync(
  directory: string,
  label: string,
  options: EnsureRealDirectoryOptions = {},
): void {
  let stats: fs.Stats | undefined;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (stats) {
    assertRealDirectory(stats, directory, label);
    return;
  }

  fs.mkdirSync(directory, {
    recursive: options.recursive ?? false,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
  assertRealDirectory(fs.lstatSync(directory), directory, label);
}

export async function ensureRealDirectory(
  directory: string,
  label: string,
  options: EnsureRealDirectoryOptions = {},
): Promise<void> {
  if (await pathExistsAsRealDirectory(directory, label)) {
    return;
  }

  await fs.promises.mkdir(directory, {
    recursive: options.recursive ?? false,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
  assertRealDirectory(await fs.promises.lstat(directory), directory, label);
}

function assertPrivateDirectoryStats(stats: fs.Stats, directory: string, label: string): void {
  assertRealDirectory(stats, directory, label);

  if (process.platform === "win32") {
    return;
  }

  const getuid = process.getuid;
  if (typeof getuid === "function" && stats.uid !== getuid()) {
    throw new UnsafePathError(`${label} must be owned by the current user: ${directory}`);
  }

  if ((stats.mode & 0o077) !== 0) {
    throw new UnsafePathError(
      `${label} must not be readable or writable by other users: ${directory}`,
    );
  }
}

export async function ensurePrivateDirectory(
  directory: string,
  label: string,
  options: EnsureRealDirectoryOptions = {},
): Promise<void> {
  await ensureRealDirectory(directory, label, {
    recursive: options.recursive ?? true,
    mode: options.mode ?? 0o700,
  });

  let chmodFailed = false;
  try {
    await fs.promises.chmod(directory, options.mode ?? 0o700);
  } catch {
    chmodFailed = true;
  }

  try {
    assertPrivateDirectoryStats(await fs.promises.lstat(directory), directory, label);
  } catch (error) {
    if (chmodFailed) {
      throw new UnsafePathError(`${label} permissions could not be restricted: ${directory}`);
    }
    throw error;
  }
}

export function ensurePrivateDirectorySync(
  directory: string,
  label: string,
  options: EnsureRealDirectoryOptions = {},
): void {
  ensureRealDirectorySync(directory, label, {
    recursive: options.recursive ?? true,
    mode: options.mode ?? 0o700,
  });

  let chmodFailed = false;
  try {
    fs.chmodSync(directory, options.mode ?? 0o700);
  } catch {
    chmodFailed = true;
  }

  try {
    assertPrivateDirectoryStats(fs.lstatSync(directory), directory, label);
  } catch (error) {
    if (chmodFailed) {
      throw new UnsafePathError(`${label} permissions could not be restricted: ${directory}`);
    }
    throw error;
  }
}

export async function ensureContainedDirectoryPath(
  rootPath: string,
  targetDirectory: string,
  label: string,
  options: EnsureRealDirectoryOptions = {},
): Promise<void> {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetDirectory);
  if (!isPathInsideOrEqual(root, target)) {
    throw new Error(`${label} resolves outside the allowed root: ${targetDirectory}`);
  }

  const rootRealPath = await fs.promises.realpath(rootPath);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, segment);
    await ensureRealDirectory(current, label, options);
    const currentRealPath = await fs.promises.realpath(current);
    if (!isPathInsideOrEqual(rootRealPath, currentRealPath)) {
      throw new Error(`${label} resolves outside the allowed root: ${current}`);
    }
  }
}

export function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const parentPrefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(parentPrefix);
}

async function lstatIfExists(candidatePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

interface ExistingPath {
  readonly path: string;
  readonly stats: fs.Stats;
}

function isSameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function writeStreamChunk(fileHandle: FileHandle, chunk: unknown): Promise<void> {
  if (typeof chunk === "string") {
    await fileHandle.write(chunk);
    return;
  }
  if (chunk instanceof Uint8Array) {
    await fileHandle.write(chunk);
    return;
  }

  throw new TypeError("Safe file write streams must yield string or Uint8Array chunks.");
}

export async function openFileNoFollow(filePath: string, label = "file"): Promise<FileHandle> {
  const beforeStats = await fs.promises.lstat(filePath);
  if (beforeStats.isSymbolicLink() || !beforeStats.isFile()) {
    throw new UnsafePathError(`${label} must be a real file, not a symlink or special file.`);
  }

  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fileHandle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollowFlag);
  let completed = false;

  try {
    const [openedStats, afterStats] = await Promise.all([
      fileHandle.stat(),
      fs.promises.lstat(filePath),
    ]);
    if (afterStats.isSymbolicLink() || !afterStats.isFile() || !openedStats.isFile()) {
      throw new UnsafePathError(`${label} must be a real file, not a symlink or special file.`);
    }
    if (
      !isSameFilesystemEntry(beforeStats, openedStats) ||
      !isSameFilesystemEntry(afterStats, openedStats)
    ) {
      throw new UnsafePathError(`${label} changed while it was being opened.`);
    }

    completed = true;
    return fileHandle;
  } finally {
    if (!completed) {
      await fileHandle.close().catch(() => undefined);
    }
  }
}

async function nearestExistingPath(candidatePath: string): Promise<ExistingPath> {
  let currentPath = candidatePath;
  for (;;) {
    const stats = await lstatIfExists(currentPath);
    if (stats) {
      return { path: currentPath, stats };
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return { path: currentPath, stats: await fs.promises.lstat(currentPath) };
    }
    currentPath = parentPath;
  }
}

export function resolveInsideRoot(rootPath: string, ...segments: string[]): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...segments);

  if (!isPathInsideOrEqual(root, resolved)) {
    throw new UnsafePathError(`Path resolves outside the allowed root: ${resolved}`);
  }

  return resolved;
}

export async function assertSafeWritePath(
  rootPath: string,
  candidatePath: string,
  label = "path",
): Promise<void> {
  assertNoNul(rootPath, "Root path");
  assertNoNul(candidatePath, label);

  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (!isPathInsideOrEqual(root, candidate)) {
    throw new UnsafePathError(`${label} resolves outside the allowed root.`);
  }

  const realRoot = await fs.promises.realpath(root);
  const existingPath = await nearestExistingPath(candidate);
  if (path.resolve(existingPath.path) !== root && existingPath.stats.isSymbolicLink()) {
    throw new UnsafePathError(`${label} resolves through a symlink.`);
  }

  const realExistingPath = await fs.promises.realpath(existingPath.path);
  if (!isPathInsideOrEqual(realRoot, realExistingPath)) {
    throw new UnsafePathError(`${label} resolves outside the allowed root through a symlink.`);
  }

  const candidateStats = await lstatIfExists(candidate);
  if (candidateStats?.isSymbolicLink()) {
    throw new UnsafePathError(`${label} must not be a symlink.`);
  }
}

export async function assertSafeFileWritePath(
  rootPath: string,
  candidatePath: string,
  label = "path",
): Promise<void> {
  const candidate = path.resolve(candidatePath);
  await assertSafeWritePath(rootPath, candidate, label);

  const candidateStats = await lstatIfExists(candidate);
  if (candidateStats?.isDirectory()) {
    throw new UnsafePathError(`${label} must be a file path, not a directory.`);
  }
}

export async function prepareSafeFileWritePath(
  rootPath: string,
  candidatePath: string,
  label = "path",
): Promise<void> {
  const candidate = path.resolve(candidatePath);
  const parentPath = path.dirname(candidate);

  await assertSafeWritePath(rootPath, parentPath, `${label} parent`);
  await fs.promises.mkdir(parentPath, { recursive: true });
  await assertSafeWritePath(rootPath, parentPath, `${label} parent`);
  await assertSafeFileWritePath(rootPath, candidate, label);
}

export async function writeFileNoFollow(
  filePath: string,
  data: string | Uint8Array | NodeJS.ReadableStream,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const overwriteFlag = options.overwrite === false ? fs.constants.O_EXCL : fs.constants.O_TRUNC;
  const fileHandle = await fs.promises.open(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | overwriteFlag | noFollowFlag,
    0o600,
  );
  let completed = false;

  try {
    if (typeof data === "string" || data instanceof Uint8Array) {
      await fileHandle.writeFile(typeof data === "string" ? data : Buffer.from(data));
    } else {
      for await (const chunk of data) {
        await writeStreamChunk(fileHandle, chunk);
      }
    }
    completed = true;
  } finally {
    try {
      await fileHandle.close();
    } finally {
      if (!completed && options.overwrite === false) {
        await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      }
    }
  }
}

export async function writeFileNoFollowWithinRoot(
  rootPath: string,
  filePath: string,
  data: string | Uint8Array | NodeJS.ReadableStream,
  options: { overwrite?: boolean; label?: string } = {},
): Promise<void> {
  const label = options.label ?? "path";
  if (options.overwrite !== false) {
    throw new UnsafePathError(`${label} must be written with overwrite disabled.`);
  }

  await assertSafeFileWritePath(rootPath, filePath, label);

  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fileHandle = await fs.promises.open(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
    0o600,
  );
  let completed = false;

  try {
    await assertSafeFileWritePath(rootPath, filePath, label);
    if (typeof data === "string" || data instanceof Uint8Array) {
      await fileHandle.writeFile(typeof data === "string" ? data : Buffer.from(data));
    } else {
      for await (const chunk of data) {
        await writeStreamChunk(fileHandle, chunk);
      }
    }
    completed = true;
  } finally {
    try {
      await fileHandle.close();
    } finally {
      if (!completed && options.overwrite === false) {
        await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      }
    }
  }
}

export function findWorkspaceControlDirectory(
  workspaceRoot: string,
  candidatePath: string,
): string | undefined {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(candidatePath));
  return relative
    .split(path.sep)
    .filter((segment) => segment.length > 0)
    .find(isWorkspaceControlDirectorySegment);
}

export function resolveContainedRelativePath(
  basePath: string,
  relativePath: string,
  label: string,
): string {
  const base = path.resolve(basePath);
  const resolved = path.resolve(base, ...portableSegments(relativePath, label));

  if (!isPathInsideOrEqual(base, resolved)) {
    throw new UnsafePathError(`${label} resolves outside the allowed directory.`);
  }

  return resolved;
}
