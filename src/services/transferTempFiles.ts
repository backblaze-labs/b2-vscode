/**
 * Transfer temporary-file placement, cleanup, and destination moves.
 *
 * @module services/transferTempFiles
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log, logError } from "../logger";
import { isWorkspaceControlDirectorySegment } from "../utils/workspaceControlDirectories";
import {
  ensureContainedDirectoryPath,
  ensurePrivateDirectory as ensurePrivateDirectoryPath,
  pathExistsAsRealDirectory,
  prepareSafeFileWritePath,
  writeNewFileNoFollow,
  writeNewFileNoFollowWithinRoot,
} from "./pathSafety";

export const TRANSFER_TEMP_DIR_NAME = "b2-vscode-transfers";
const TRANSFER_TEMP_PREFIX = "b2-transfer-";
const TRANSFER_TEMP_SUFFIX = ".tmp";
const TRANSFER_TEMP_RANDOM_BYTES = 12;
const TRANSFER_TEMP_RANDOM_HEX_LENGTH = TRANSFER_TEMP_RANDOM_BYTES * 2;
const DESTINATION_TEMP_RANDOM_BYTES = 12;
const DESTINATION_TEMP_RANDOM_HEX_LENGTH = DESTINATION_TEMP_RANDOM_BYTES * 2;
const CROSS_DEVICE_MOVE_TEMP_PREFIX = ".b2-cross-device-";
const REPLACE_BACKUP_TEMP_PREFIX = ".b2-replace-backup-";
const STALE_TRANSFER_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const STALE_CLEANUP_BUDGET_MS = 2_000;
const STALE_CLEANUP_MAX_ENTRIES = 2_000;
const MAX_CLEANUP_THROTTLE_ENTRIES = 256;

const lastCleanupByDirectory = new Map<string, number>();
let defaultTransferTempDirectory: string | undefined;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TRANSFER_TEMP_FILE_PATTERN = new RegExp(
  `^${escapeRegExp(TRANSFER_TEMP_PREFIX)}\\d+-[a-f0-9]{${TRANSFER_TEMP_RANDOM_HEX_LENGTH}}${escapeRegExp(TRANSFER_TEMP_SUFFIX)}$`,
  "u",
);
const DESTINATION_TEMP_PAYLOAD_PATTERN = new RegExp(
  `^[\\s\\S]+-\\d+-[a-f0-9]{${DESTINATION_TEMP_RANDOM_HEX_LENGTH}}$`,
  "u",
);

function defaultTransferTempDirectoryUserPart(): string {
  return typeof process.getuid === "function" ? `uid-${process.getuid()}` : "user";
}

function defaultTransferTempDirectoryPrefix(): string {
  return `${TRANSFER_TEMP_DIR_NAME}-${defaultTransferTempDirectoryUserPart()}-`;
}

function defaultTransferTempDirectoryName(): string {
  const random = crypto.randomBytes(12).toString("hex");
  return `${defaultTransferTempDirectoryPrefix()}${process.pid}-${random}`;
}

function isCurrentUserOwned(stats: fs.Stats): boolean {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function isCurrentDefaultTransferTempDirectory(directory: string): boolean {
  return (
    defaultTransferTempDirectory !== undefined &&
    path.resolve(directory) === path.resolve(defaultTransferTempDirectory)
  );
}

function isDefaultTransferTempDirectoryEntry(entry: string): boolean {
  return entry === TRANSFER_TEMP_DIR_NAME || entry.startsWith(defaultTransferTempDirectoryPrefix());
}

export function transferTempDirectory(directory?: string): string {
  if (directory !== undefined) {
    return directory;
  }

  if (defaultTransferTempDirectory === undefined) {
    defaultTransferTempDirectory = path.join(os.tmpdir(), defaultTransferTempDirectoryName());
  }
  return defaultTransferTempDirectory;
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await ensurePrivateDirectoryPath(directory, "Transfer temp directory", {
    recursive: true,
    mode: 0o700,
  });
}

async function setPrivateDirectoryPermissions(directory: string): Promise<void> {
  await fs.promises.chmod(directory, 0o700).catch((error) => {
    logError(`Could not set private permissions on transfer temp directory: ${directory}`, error);
  });
}

export async function ensureTransferTempDirectory(
  directory: string,
  allowedRootDirectory: string | undefined,
): Promise<void> {
  if (allowedRootDirectory !== undefined) {
    await ensureContainedDirectoryPath(
      allowedRootDirectory,
      directory,
      "Workspace transfer temp directory",
      { recursive: true, mode: 0o700 },
    );
    await setPrivateDirectoryPermissions(directory);
    await ensurePrivateDirectory(directory);
    return;
  }

  await ensurePrivateDirectory(directory);
}

export function transferTempPath(directory: string): string {
  const random = crypto.randomBytes(TRANSFER_TEMP_RANDOM_BYTES).toString("hex");
  return path.join(
    directory,
    `${TRANSFER_TEMP_PREFIX}${process.pid}-${random}${TRANSFER_TEMP_SUFFIX}`,
  );
}

function destinationMoveTempPath(destinationPath: string): string {
  const random = crypto.randomBytes(DESTINATION_TEMP_RANDOM_BYTES).toString("hex");
  const parsed = path.parse(destinationPath);
  return path.join(
    parsed.dir,
    `${CROSS_DEVICE_MOVE_TEMP_PREFIX}${parsed.base}-${process.pid}-${random}${TRANSFER_TEMP_SUFFIX}`,
  );
}

function destinationReplaceBackupPath(destinationPath: string): string {
  const random = crypto.randomBytes(DESTINATION_TEMP_RANDOM_BYTES).toString("hex");
  const parsed = path.parse(destinationPath);
  return path.join(
    parsed.dir,
    `${REPLACE_BACKUP_TEMP_PREFIX}${parsed.base}-${process.pid}-${random}${TRANSFER_TEMP_SUFFIX}`,
  );
}

function isTransferTempFile(name: string): boolean {
  return TRANSFER_TEMP_FILE_PATTERN.test(name);
}

function isDestinationTempFile(name: string): boolean {
  const prefix = name.startsWith(CROSS_DEVICE_MOVE_TEMP_PREFIX)
    ? CROSS_DEVICE_MOVE_TEMP_PREFIX
    : name.startsWith(REPLACE_BACKUP_TEMP_PREFIX)
      ? REPLACE_BACKUP_TEMP_PREFIX
      : undefined;
  if (prefix === undefined || !name.endsWith(TRANSFER_TEMP_SUFFIX)) {
    return false;
  }

  const payload = name.slice(prefix.length, -TRANSFER_TEMP_SUFFIX.length);
  return DESTINATION_TEMP_PAYLOAD_PATTERN.test(payload);
}

export function assertDestinationFileNameIsNotReserved(destinationPath: string): void {
  const name = path.basename(destinationPath);
  if (isTransferTempFile(name) || isDestinationTempFile(name)) {
    throw new Error(`Destination filename uses a reserved B2 transfer temp pattern: ${name}`);
  }
}

function pruneCleanupThrottle(now: number): void {
  for (const [key, previous] of lastCleanupByDirectory) {
    if (now - previous >= STALE_CLEANUP_INTERVAL_MS) {
      lastCleanupByDirectory.delete(key);
    }
  }

  while (lastCleanupByDirectory.size >= MAX_CLEANUP_THROTTLE_ENTRIES) {
    const oldestKey = lastCleanupByDirectory.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    lastCleanupByDirectory.delete(oldestKey);
  }
}

function shouldRunThrottledCleanup(key: string): boolean {
  const now = Date.now();
  pruneCleanupThrottle(now);

  const previous = lastCleanupByDirectory.get(key);
  if (previous !== undefined && now - previous < STALE_CLEANUP_INTERVAL_MS) {
    return false;
  }

  lastCleanupByDirectory.set(key, now);
  return true;
}

interface BoundedCleanupOptions {
  readonly maxEntries?: number;
  readonly budgetMs?: number;
}

interface BoundedCleanupStats {
  readonly scannedEntries: number;
  readonly budgetHit: boolean;
  readonly maxEntriesHit: boolean;
}

async function scanBoundedDirectoryEntries(
  directory: string,
  label: string,
  options: BoundedCleanupOptions,
  onEntry: (entry: string) => Promise<void>,
): Promise<BoundedCleanupStats> {
  const deadlineMs = Date.now() + Math.max(0, options.budgetMs ?? STALE_CLEANUP_BUDGET_MS);
  const maxEntries = Math.max(0, options.maxEntries ?? STALE_CLEANUP_MAX_ENTRIES);
  let scannedEntries = 0;
  let budgetHit = false;
  let maxEntriesHit = false;

  let dir: fs.Dir | undefined;
  try {
    const beforeOpenStats = await fs.promises.lstat(directory);
    if (beforeOpenStats.isSymbolicLink() || !beforeOpenStats.isDirectory()) {
      return { scannedEntries, budgetHit, maxEntriesHit };
    }
    dir = await fs.promises.opendir(directory);
    const afterOpenStats = await fs.promises.lstat(directory);
    if (afterOpenStats.isSymbolicLink() || !afterOpenStats.isDirectory()) {
      return { scannedEntries, budgetHit, maxEntriesHit };
    }
    while (true) {
      if (Date.now() >= deadlineMs) {
        budgetHit = true;
        break;
      }
      if (scannedEntries >= maxEntries) {
        maxEntriesHit = true;
        break;
      }

      const entry = await dir.read();
      if (entry === null) {
        break;
      }

      scannedEntries += 1;
      await onEntry(entry.name);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logError(`Could not inspect ${label}: ${directory}`, error);
    }
  } finally {
    if (dir !== undefined) {
      await dir.close().catch((error) => {
        logError(`Could not close ${label}: ${directory}`, error);
      });
    }
  }

  return { scannedEntries, budgetHit, maxEntriesHit };
}

function logBoundedCleanup(label: string, stats: BoundedCleanupStats): void {
  if (stats.budgetHit || stats.maxEntriesHit) {
    log(
      `${label} cleanup scanned ${stats.scannedEntries} entr${stats.scannedEntries === 1 ? "y" : "ies"}, budgetHit=${stats.budgetHit}, maxEntriesHit=${stats.maxEntriesHit}.`,
    );
  }
}

async function cleanupStaleTransferTempFile(filePath: string, cutoff: number): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (stats.mtimeMs <= cutoff) {
      await fs.promises.rm(filePath, { force: true });
      return true;
    }
  } catch (error) {
    logError(`Could not remove stale transfer temp file: ${filePath}`, error);
  }

  return false;
}

async function cleanupStaleTransferTempDirectory(
  directory: string,
  maxAgeMs: number,
  options: BoundedCleanupOptions,
): Promise<void> {
  try {
    if (!(await pathExistsAsRealDirectory(directory, "Transfer temp directory"))) {
      return;
    }
  } catch (error) {
    logError(`Could not inspect transfer temp directory: ${directory}`, error);
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  const stats = await scanBoundedDirectoryEntries(
    directory,
    "transfer temp directory",
    options,
    async (entry) => {
      if (!isTransferTempFile(entry)) {
        return;
      }

      await cleanupStaleTransferTempFile(path.join(directory, entry), cutoff);
    },
  );
  logBoundedCleanup("Transfer temp", stats);
}

async function removeEmptyTransferTempDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      logError(`Could not remove empty transfer temp directory: ${directory}`, error);
    }
  }
}

async function cleanupDefaultTransferTempDirectories(
  maxAgeMs: number,
  options: BoundedCleanupOptions,
): Promise<void> {
  const directory = os.tmpdir();
  const cutoff = Date.now() - maxAgeMs;
  const stats = await scanBoundedDirectoryEntries(
    directory,
    "system temp directory",
    options,
    async (entry) => {
      if (!isDefaultTransferTempDirectoryEntry(entry)) {
        return;
      }

      const transferDirectory = path.join(directory, entry);
      let transferDirectoryStats: fs.Stats;
      try {
        transferDirectoryStats = await fs.promises.lstat(transferDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logError(`Could not inspect transfer temp directory: ${transferDirectory}`, error);
        }
        return;
      }

      if (!transferDirectoryStats.isDirectory() || !isCurrentUserOwned(transferDirectoryStats)) {
        return;
      }

      await cleanupStaleTransferTempDirectory(transferDirectory, maxAgeMs, options);
      if (
        !isCurrentDefaultTransferTempDirectory(transferDirectory) &&
        transferDirectoryStats.mtimeMs <= cutoff
      ) {
        await removeEmptyTransferTempDirectory(transferDirectory);
      }
    },
  );
  logBoundedCleanup("Transfer temp root", stats);
}

export async function cleanupStaleTransferTempFiles(
  options: { directory?: string; maxAgeMs?: number } & BoundedCleanupOptions = {},
): Promise<void> {
  const maxAgeMs = options.maxAgeMs ?? STALE_TRANSFER_TEMP_MAX_AGE_MS;
  if (options.directory !== undefined) {
    await cleanupStaleTransferTempDirectory(options.directory, maxAgeMs, options);
    return;
  }

  await cleanupDefaultTransferTempDirectories(maxAgeMs, options);
}

async function closeDirectoryBestEffort(dir: fs.Dir): Promise<void> {
  try {
    await dir.close();
  } catch {
    // Async Dir iteration closes handles on normal completion and break.
  }
}

async function openRealDirectory(directory: string): Promise<fs.Dir | undefined> {
  const beforeOpenStats = await fs.promises.lstat(directory);
  if (beforeOpenStats.isSymbolicLink() || !beforeOpenStats.isDirectory()) {
    return undefined;
  }

  const dir = await fs.promises.opendir(directory);
  try {
    const afterOpenStats = await fs.promises.lstat(directory);
    if (afterOpenStats.isSymbolicLink() || !afterOpenStats.isDirectory()) {
      await closeDirectoryBestEffort(dir);
      return undefined;
    }
    return dir;
  } catch (error) {
    await closeDirectoryBestEffort(dir);
    throw error;
  }
}

export async function cleanupWorkspaceTransferTempFiles(options: {
  readonly workspaceRoot: string;
  readonly maxAgeMs?: number;
  readonly budgetMs?: number;
  readonly maxEntries?: number;
}): Promise<void> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  try {
    if (!(await pathExistsAsRealDirectory(workspaceRoot, "Workspace root"))) {
      return;
    }
  } catch (error) {
    logError(`Could not inspect workspace root for transfer temp cleanup: ${workspaceRoot}`, error);
    return;
  }

  const deadlineMs = Date.now() + Math.max(0, options.budgetMs ?? STALE_CLEANUP_BUDGET_MS);
  const maxEntries = Math.max(0, options.maxEntries ?? STALE_CLEANUP_MAX_ENTRIES);
  const cutoff = Date.now() - (options.maxAgeMs ?? STALE_TRANSFER_TEMP_MAX_AGE_MS);
  const stack = [workspaceRoot];
  let scannedEntries = 0;
  let cleanedFiles = 0;
  let budgetHit = false;
  let maxEntriesHit = false;

  while (stack.length > 0) {
    if (Date.now() >= deadlineMs) {
      budgetHit = true;
      break;
    }
    if (scannedEntries >= maxEntries) {
      maxEntriesHit = true;
      break;
    }

    const directory = stack.pop() as string;
    let dir: fs.Dir | undefined;
    try {
      dir = await openRealDirectory(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") {
        logError(`Could not inspect workspace directory for transfer cleanup: ${directory}`, error);
      }
      continue;
    }
    if (dir === undefined) {
      continue;
    }

    try {
      for await (const entry of dir) {
        if (Date.now() >= deadlineMs) {
          budgetHit = true;
          break;
        }
        if (scannedEntries >= maxEntries) {
          maxEntriesHit = true;
          break;
        }

        scannedEntries += 1;
        const entryPath = path.join(directory, entry.name);
        if (!entry.isDirectory() && isTransferTempFile(entry.name)) {
          if (await cleanupStaleTransferTempFile(entryPath, cutoff)) {
            cleanedFiles += 1;
          }
          continue;
        }

        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !isWorkspaceControlDirectorySegment(entry.name)
        ) {
          stack.push(entryPath);
        }
      }
    } finally {
      await closeDirectoryBestEffort(dir);
    }
  }

  if (scannedEntries > 0 || cleanedFiles > 0 || budgetHit || maxEntriesHit) {
    log(
      `Workspace transfer temp cleanup for ${workspaceRoot} scanned ${scannedEntries} entr${scannedEntries === 1 ? "y" : "ies"}, cleaned ${cleanedFiles} temp file${cleanedFiles === 1 ? "" : "s"}, budgetHit=${budgetHit}, maxEntriesHit=${maxEntriesHit}.`,
    );
  }
}

async function cleanupDestinationTempEntry(
  directory: string,
  entry: string,
  cutoff: number,
  preservedPath?: string,
): Promise<boolean> {
  if (!isDestinationTempFile(entry)) {
    return false;
  }

  const filePath = path.join(directory, entry);
  if (preservedPath !== undefined && path.resolve(filePath) === preservedPath) {
    return false;
  }

  try {
    const stats = await fs.promises.lstat(filePath);
    if (stats.mtimeMs > cutoff) {
      return false;
    }

    if (entry.startsWith(REPLACE_BACKUP_TEMP_PREFIX)) {
      log(`Discarding stale destination backup temp file without automatic restore: ${filePath}`);
    }
    await fs.promises.rm(filePath, { force: true });
    return true;
  } catch (error) {
    logError(`Could not clean stale destination temp file: ${filePath}`, error);
  }

  return false;
}

export async function cleanupStaleDestinationTempFiles(
  options: {
    directory: string;
    maxAgeMs?: number;
    preservePath?: string;
  } & BoundedCleanupOptions,
): Promise<void> {
  const directory = options.directory;
  const maxAgeMs = options.maxAgeMs ?? STALE_TRANSFER_TEMP_MAX_AGE_MS;
  const preservedPath =
    options.preservePath !== undefined ? path.resolve(options.preservePath) : undefined;

  try {
    if (!(await pathExistsAsRealDirectory(directory, "Destination directory"))) {
      return;
    }
  } catch (error) {
    logError(`Could not inspect destination directory: ${directory}`, error);
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  const stats = await scanBoundedDirectoryEntries(
    directory,
    "destination directory",
    options,
    async (entry) => {
      await cleanupDestinationTempEntry(directory, entry, cutoff, preservedPath);
    },
  );
  logBoundedCleanup("Destination temp", stats);
}

export async function cleanupWorkspaceDestinationTempFiles(options: {
  readonly workspaceRoot: string;
  readonly maxAgeMs?: number;
  readonly budgetMs?: number;
  readonly maxEntries?: number;
}): Promise<void> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  try {
    if (!(await pathExistsAsRealDirectory(workspaceRoot, "Workspace root"))) {
      return;
    }
  } catch (error) {
    logError(
      `Could not inspect workspace root for destination temp cleanup: ${workspaceRoot}`,
      error,
    );
    return;
  }

  const deadlineMs = Date.now() + Math.max(0, options.budgetMs ?? STALE_CLEANUP_BUDGET_MS);
  const maxEntries = Math.max(0, options.maxEntries ?? STALE_CLEANUP_MAX_ENTRIES);
  const cutoff = Date.now() - (options.maxAgeMs ?? STALE_TRANSFER_TEMP_MAX_AGE_MS);
  const stack = [workspaceRoot];
  let scannedEntries = 0;
  let cleanedFiles = 0;
  let budgetHit = false;
  let maxEntriesHit = false;

  while (stack.length > 0) {
    if (Date.now() >= deadlineMs) {
      budgetHit = true;
      break;
    }
    if (scannedEntries >= maxEntries) {
      maxEntriesHit = true;
      break;
    }

    const directory = stack.pop() as string;
    let dir: fs.Dir | undefined;
    try {
      dir = await openRealDirectory(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") {
        logError(
          `Could not inspect workspace directory for destination cleanup: ${directory}`,
          error,
        );
      }
      continue;
    }
    if (dir === undefined) {
      continue;
    }

    try {
      for await (const entry of dir) {
        if (Date.now() >= deadlineMs) {
          budgetHit = true;
          break;
        }
        if (scannedEntries >= maxEntries) {
          maxEntriesHit = true;
          break;
        }

        scannedEntries += 1;
        if (await cleanupDestinationTempEntry(directory, entry.name, cutoff)) {
          cleanedFiles += 1;
          continue;
        }

        if (
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !isWorkspaceControlDirectorySegment(entry.name)
        ) {
          stack.push(path.join(directory, entry.name));
        }
      }
    } finally {
      await closeDirectoryBestEffort(dir);
    }
  }

  if (scannedEntries > 0 || cleanedFiles > 0 || budgetHit || maxEntriesHit) {
    log(
      `Workspace destination temp cleanup for ${workspaceRoot} scanned ${scannedEntries} entr${scannedEntries === 1 ? "y" : "ies"}, cleaned ${cleanedFiles} temp file${cleanedFiles === 1 ? "" : "s"}, budgetHit=${budgetHit}, maxEntriesHit=${maxEntriesHit}.`,
    );
  }
}

export async function cleanupTransferTempFilesForDownload(directory: string): Promise<void> {
  if (
    isCurrentDefaultTransferTempDirectory(directory) &&
    shouldRunThrottledCleanup(`transfer-root:${defaultTransferTempDirectoryPrefix()}`)
  ) {
    await cleanupStaleTransferTempFiles();
  }

  if (shouldRunThrottledCleanup(`transfer:${path.resolve(directory)}`)) {
    await cleanupStaleTransferTempFiles({ directory });
  }
}

export async function cleanupDestinationTempFilesForDownload(
  directory: string,
  preservePath?: string,
): Promise<void> {
  if (shouldRunThrottledCleanup(`destination:${path.resolve(directory)}`)) {
    await cleanupStaleDestinationTempFiles({ directory, preservePath });
  }
}

export async function removeTempFile(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (error) {
    logError(`Could not remove transfer temp file: ${filePath}`, error);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

interface MoveIntoPlaceOptions {
  readonly overwrite?: boolean;
}

async function copyIntoPlaceNoFollow(
  sourcePath: string,
  destinationPath: string,
  options: MoveIntoPlaceOptions = {},
  allowedRootDirectory?: string,
): Promise<void> {
  if (allowedRootDirectory !== undefined) {
    if (options.overwrite !== false) {
      throw new Error("Root-bound downloads must be written without overwrite.");
    }
    await prepareSafeFileWritePath(allowedRootDirectory, destinationPath, "download target");
    if (await pathExists(destinationPath)) {
      const error = new Error(`Download destination file already exists: ${destinationPath}`);
      (error as NodeJS.ErrnoException).code = "EEXIST";
      throw error;
    }
    await prepareSafeFileWritePath(allowedRootDirectory, destinationPath, "download target");
    await publishNewFileNoOverwrite(sourcePath, destinationPath, {
      allowedRootDirectory,
      preferHardlink: false,
    });
    await removeTempFile(sourcePath);
    return;
  }

  const destinationTempPath = destinationMoveTempPath(destinationPath);
  let destinationTempCreated = false;

  try {
    await writeNewFileNoFollow(destinationTempPath, fs.createReadStream(sourcePath));
    destinationTempCreated = true;
    if (options.overwrite === false && (await pathExists(destinationPath))) {
      const error = new Error(`Download destination file already exists: ${destinationPath}`);
      (error as NodeJS.ErrnoException).code = "EEXIST";
      throw error;
    }
    if (options.overwrite === false) {
      await publishNewFileNoOverwrite(destinationTempPath, destinationPath, {
        preferHardlink: true,
      });
      await removeTempFile(destinationTempPath);
    } else {
      await renameIntoPlace(destinationTempPath, destinationPath, options);
    }
    destinationTempCreated = false;
    await removeTempFile(sourcePath);
  } catch (error) {
    if (destinationTempCreated) {
      await removeTempFile(destinationTempPath);
    }
    throw error;
  }
}

async function publishNewFileNoOverwrite(
  sourcePath: string,
  destinationPath: string,
  options: {
    readonly allowedRootDirectory?: string;
    readonly preferHardlink: boolean;
  },
): Promise<void> {
  if (options.allowedRootDirectory !== undefined) {
    await writeNewFileNoFollowWithinRoot(
      options.allowedRootDirectory,
      destinationPath,
      fs.createReadStream(sourcePath),
      {
        label: "download target",
      },
    );
    return;
  }

  if (options.preferHardlink) {
    try {
      await fs.promises.link(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!shouldFallbackToCopyAfterHardlinkError(error)) {
        throw error;
      }
    }
  }

  await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
}

async function replaceExistingDestination(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const destinationStats = await fs.promises.lstat(destinationPath);
  if (!destinationStats.isFile()) {
    throw new Error(`Download destination must be a regular file: ${destinationPath}`);
  }

  const backupPath = destinationReplaceBackupPath(destinationPath);
  try {
    await fs.promises.rename(destinationPath, backupPath);
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error) {
    try {
      if (!fs.existsSync(destinationPath) && fs.existsSync(backupPath)) {
        await fs.promises.rename(backupPath, destinationPath);
      }
    } catch (restoreError) {
      logError(
        `Could not restore original destination after failed replace: ${destinationPath}`,
        restoreError,
      );
    }
    throw error;
  }

  await removeTempFile(backupPath);
}

const HARDLINK_COPY_FALLBACK_ERROR_CODES = new Set([
  "EXDEV",
  "EPERM",
  "EOPNOTSUPP",
  "ENOTSUP",
  "EINVAL",
  "EACCES",
  "ENOSYS",
]);

function shouldFallbackToCopyAfterHardlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && HARDLINK_COPY_FALLBACK_ERROR_CODES.has(code);
}

async function renameIntoPlace(
  sourcePath: string,
  destinationPath: string,
  options: MoveIntoPlaceOptions = {},
): Promise<void> {
  try {
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM") {
      if (options.overwrite === false) {
        throw error;
      }
      await replaceExistingDestination(sourcePath, destinationPath);
      return;
    }

    throw error;
  }
}

async function moveIntoPlaceWithoutOverwrite(
  sourcePath: string,
  destinationPath: string,
  allowedRootDirectory?: string,
): Promise<void> {
  if (allowedRootDirectory !== undefined) {
    await copyIntoPlaceNoFollow(
      sourcePath,
      destinationPath,
      { overwrite: false },
      allowedRootDirectory,
    );
    return;
  }

  try {
    await fs.promises.link(sourcePath, destinationPath);
  } catch (error) {
    if (!shouldFallbackToCopyAfterHardlinkError(error)) {
      throw error;
    }

    await copyIntoPlaceNoFollow(sourcePath, destinationPath, { overwrite: false });
    return;
  }

  await removeTempFile(sourcePath);
}

export async function moveIntoPlace(
  sourcePath: string,
  destinationPath: string,
  options: MoveIntoPlaceOptions = {},
  allowedRootDirectory?: string,
): Promise<void> {
  if (options.overwrite === false) {
    await moveIntoPlaceWithoutOverwrite(sourcePath, destinationPath, allowedRootDirectory);
    return;
  }

  try {
    await renameIntoPlace(sourcePath, destinationPath, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }

    const destinationTempPath = destinationMoveTempPath(destinationPath);
    try {
      await fs.promises.copyFile(sourcePath, destinationTempPath, fs.constants.COPYFILE_EXCL);
      await renameIntoPlace(destinationTempPath, destinationPath, options);
      await removeTempFile(sourcePath);
    } catch (copyError) {
      await removeTempFile(destinationTempPath);
      throw copyError;
    }
  }
}
