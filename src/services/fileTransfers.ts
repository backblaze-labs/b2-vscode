/**
 * Filesystem-backed B2 transfer helpers.
 *
 * This module intentionally keeps transfer timeout, local staging, placement,
 * upload-session markers, and multipart cleanup orchestration together while
 * the transfer contract depends on their ordering. Split the marker/cleanup
 * cluster once it can own a stable bucket abstraction and its own diagnostics
 * without exposing staging internals back to callers.
 *
 * @module services/fileTransfers
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import {
  BufferSource,
  type FileVersion,
  type LargeFileId,
  type ProgressListener,
  type UploadWriteHandle,
} from "@backblaze-labs/b2-sdk";
import { log, logError } from "../logger";
import { humanSize } from "../utils/humanSize";
import { isWorkspaceControlDirectorySegment } from "../utils/workspaceControlDirectories";
import {
  ensureContainedDirectoryPath,
  assertPrivateDirectory,
  ensurePrivateDirectory,
  ensureRealDirectory,
  pathExistsAsRealDirectory,
  prepareSafeFileWritePath,
  writeNewFileNoFollow,
  writeNewFileNoFollowWithinRoot,
} from "./pathSafety";
import {
  DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
  abortPromise,
  createActivityAbortSignal,
  normalizeTransferError,
  type TransferTimeoutOptions,
} from "./transferTimeout";

export {
  DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
  TransferStallTimeoutError,
  abortPromise,
  createActivityAbortSignal,
  normalizeTransferError,
  withTransferStallTimeout,
  type ActivityAbortSignal,
  type TransferTimeoutOptions,
} from "./transferTimeout";

export const DEFAULT_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const STREAMING_UPLOAD_PART_SIZE = 8 * 1024 * 1024;

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
const WORKSPACE_TRANSFER_TEMP_CLEANUP_BUDGET_MS = 2_000;
const WORKSPACE_TRANSFER_TEMP_CLEANUP_MAX_ENTRIES = 2_000;
const WORKSPACE_DESTINATION_CLEANUP_BUDGET_MS = 2_000;
const WORKSPACE_DESTINATION_CLEANUP_MAX_ENTRIES = 2_000;
const STALE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const STALE_CLEANUP_THROTTLE_MAX_ENTRIES = 256;
const UNFINISHED_UPLOAD_CLEANUP_MAX_PAGES = 20;
const UNFINISHED_UPLOAD_CLEANUP_MAX_CANCELS = 10;
const UNFINISHED_UPLOAD_CLEANUP_TIMEOUT_MS = 10_000;
const UNFINISHED_UPLOAD_CLEANUP_BUDGET_MS = 30_000;
const UNFINISHED_UPLOAD_STALE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_UNFINISHED_UPLOAD_MAX_AGE_MS = UNFINISHED_UPLOAD_STALE_MIN_AGE_MS;
const STALE_UPLOAD_SESSION_MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_OWNER_INFO_KEY = "b2-vscode-upload-owner";
const UPLOAD_SESSION_ID_INFO_KEY = "b2-vscode-upload-session-id";
const UPLOAD_STARTED_MS_INFO_KEY = "b2-vscode-upload-started-ms";
const UPLOAD_SESSION_MARKER_DIR_NAME = "b2-vscode-upload-sessions";
const UPLOAD_SESSION_MARKER_PREFIX = "session-";
const UPLOAD_SESSION_MARKER_SUFFIX = ".json";
const NOFOLLOW_OPEN_FLAG = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;

const lastCleanupByDirectory = new Map<string, number>();
let unfinishedUploadCleanupChain: Promise<void> = Promise.resolve();
let unfinishedUploadCleanupPendingCount = 0;

export interface UnfinishedUploadCleanupDiagnostics {
  readonly queuedOwnedCleanupCount: number;
  readonly timedOutCleanupCount: number;
}

const unfinishedUploadCleanupDiagnostics = {
  queuedOwnedCleanupCount: 0,
  timedOutCleanupCount: 0,
};

export function getUnfinishedUploadCleanupDiagnostics(): UnfinishedUploadCleanupDiagnostics {
  return { ...unfinishedUploadCleanupDiagnostics };
}

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

export class DownloadSizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadSizeLimitError";
  }
}

export interface DownloadStreamToFileOptions extends TransferTimeoutOptions {
  readonly temporaryDirectory?: string;
  readonly overwrite?: boolean;
  readonly allowedRootDirectory?: string;
  readonly maxBytes?: number;
  readonly knownBytes?: number;
}

export interface DownloadStreamToNewFileWithinRootOptions extends TransferTimeoutOptions {
  readonly temporaryDirectory?: string;
  readonly maxBytes?: number;
  readonly knownBytes?: number;
}

export interface UploadFileFromDiskOptions extends TransferTimeoutOptions {
  readonly onProgress?: ProgressListener;
  readonly partSize?: number;
  readonly unfinishedCleanupMaxPages?: number;
  readonly unfinishedCleanupMaxCancels?: number;
  readonly unfinishedCleanupTimeoutMs?: number;
  readonly unfinishedCleanupBudgetMs?: number;
  readonly unfinishedCleanupMinAgeMs?: number;
}

export interface StaleUnfinishedUploadCleanupOptions extends Pick<
  UploadFileFromDiskOptions,
  | "unfinishedCleanupMaxPages"
  | "unfinishedCleanupMaxCancels"
  | "unfinishedCleanupTimeoutMs"
  | "unfinishedCleanupBudgetMs"
> {
  readonly remotePath?: string;
  readonly unfinishedCleanupMaxAgeMs?: number;
  readonly skipUploadSessionMarkerCleanup?: boolean;
  readonly onMissingCapability?: (description: string, error: unknown) => void;
}

export interface StaleUnfinishedUploadCleanupResult {
  readonly reclaimedOwnedStaleUploadCount: number;
  readonly ignoredUnownedStaleUploadCount: number;
}

interface UnfinishedLargeFile {
  readonly fileId: LargeFileId;
  readonly fileName: string;
  readonly fileInfo?: Record<string, string>;
}

export interface UploadBucketHandle {
  upload(options: {
    fileName: string;
    source: BufferSource;
    signal?: AbortSignal;
    onProgress?: ProgressListener;
  }): Promise<FileVersion>;
  file(fileName: string): {
    createWriteStream(options?: {
      partSize?: number;
      fileInfo?: Record<string, string>;
      signal?: AbortSignal;
      onProgress?: ProgressListener;
    }): UploadWriteHandle;
  };
  listUnfinishedLargeFiles?(options?: {
    namePrefix?: string;
    startFileId?: LargeFileId;
    pageSize?: number;
    signal?: AbortSignal;
  }): Promise<{
    files: readonly UnfinishedLargeFile[];
    nextFileId: LargeFileId | null;
  }>;
  cancelLargeFile?(fileId: LargeFileId, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface UploadSourceFile {
  readonly path: string;
  readonly handle: fs.promises.FileHandle;
  readonly stats: fs.Stats;
}

function normalizedMaxBytes(maxBytes: number | undefined): number {
  const normalized = maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error("Download maximum byte count must be a non-negative finite number.");
  }
  return normalized;
}

function assertKnownDownloadSizeWithinLimit(
  knownBytes: number | undefined,
  maxBytes: number,
  destinationPath: string,
): void {
  if (knownBytes === undefined) {
    return;
  }

  if (!Number.isFinite(knownBytes) || knownBytes < 0) {
    throw new Error("Download known byte count must be a non-negative finite number.");
  }

  if (knownBytes > maxBytes) {
    throw new DownloadSizeLimitError(
      `Download to ${path.basename(destinationPath)} is ${humanSize(knownBytes)}, exceeding the configured size limit of ${humanSize(maxBytes)}.`,
    );
  }
}

function createDownloadSizeLimitTransform(
  maxBytes: number,
  destinationPath: string,
  onBytes?: (bytes: number) => void,
): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      onBytes?.(bytes);
      if (bytes > maxBytes) {
        callback(
          new DownloadSizeLimitError(
            `Download to ${path.basename(destinationPath)} exceeded the ${humanSize(maxBytes)} limit.`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function transferTempDirectory(
  directory: string | undefined,
  defaultDirectory: string,
): {
  readonly directory: string;
  readonly requiresPrivateDirectory: boolean;
} {
  if (directory !== undefined) {
    return { directory, requiresPrivateDirectory: true };
  }

  return { directory: defaultDirectory, requiresPrivateDirectory: false };
}

async function ensureTransferTempDirectory(
  directory: string,
  allowedRootDirectory: string | undefined,
  requiresPrivateDirectory: boolean,
): Promise<void> {
  if (allowedRootDirectory !== undefined) {
    await ensureContainedDirectoryPath(
      allowedRootDirectory,
      directory,
      "Workspace transfer temp directory",
      { recursive: true },
    );
  }

  if (requiresPrivateDirectory) {
    await ensurePrivateDirectory(directory, "Transfer temp directory", {
      recursive: true,
      mode: 0o700,
    });
    return;
  }

  await ensureRealDirectory(directory, "Transfer temp directory", { recursive: true });
}

function transferTempPath(directory: string): string {
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

function shouldRunThrottledCleanup(key: string): boolean {
  const now = Date.now();
  for (const [trackedKey, lastRun] of lastCleanupByDirectory) {
    if (now - lastRun >= STALE_CLEANUP_INTERVAL_MS * 2) {
      lastCleanupByDirectory.delete(trackedKey);
    }
  }
  while (lastCleanupByDirectory.size >= STALE_CLEANUP_THROTTLE_MAX_ENTRIES) {
    const oldestKey = lastCleanupByDirectory.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      break;
    }
    lastCleanupByDirectory.delete(oldestKey);
  }

  const previous = lastCleanupByDirectory.get(key);
  if (previous !== undefined && now - previous < STALE_CLEANUP_INTERVAL_MS) {
    return false;
  }

  lastCleanupByDirectory.set(key, now);
  return true;
}

export async function cleanupStaleTransferTempFiles(
  options: { directory?: string; maxAgeMs?: number } = {},
): Promise<void> {
  const directory = options.directory ?? path.join(os.tmpdir(), TRANSFER_TEMP_DIR_NAME);
  const maxAgeMs = options.maxAgeMs ?? STALE_TRANSFER_TEMP_MAX_AGE_MS;

  try {
    if (!(await pathExistsAsRealDirectory(directory, "Transfer temp directory"))) {
      return;
    }
  } catch (error) {
    logError(`Could not inspect transfer temp directory: ${directory}`, error);
    return;
  }

  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logError(`Could not inspect transfer temp directory: ${directory}`, error);
    }
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!isTransferTempFile(entry)) {
      continue;
    }

    await cleanupStaleTransferTempFile(path.join(directory, entry), cutoff);
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

  const deadlineMs =
    Date.now() + Math.max(0, options.budgetMs ?? WORKSPACE_TRANSFER_TEMP_CLEANUP_BUDGET_MS);
  const maxEntries = Math.max(0, options.maxEntries ?? WORKSPACE_TRANSFER_TEMP_CLEANUP_MAX_ENTRIES);
  const stack = [workspaceRoot];
  let scannedEntries = 0;
  let cleanedDirectories = 0;
  let cleanedFiles = 0;
  let budgetHit = false;
  let maxEntriesHit = false;
  const cutoff = Date.now() - (options.maxAgeMs ?? STALE_TRANSFER_TEMP_MAX_AGE_MS);

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
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") {
        logError(`Could not inspect workspace directory for transfer cleanup: ${directory}`, error);
      }
      continue;
    }

    for (const entry of entries) {
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

      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }

      if (entry.name === `.${TRANSFER_TEMP_DIR_NAME}`) {
        await cleanupStaleTransferTempFiles({
          directory: entryPath,
          maxAgeMs: options.maxAgeMs,
        });
        cleanedDirectories += 1;
        continue;
      }
      stack.push(entryPath);
    }
  }

  if (
    scannedEntries > 0 ||
    cleanedDirectories > 0 ||
    cleanedFiles > 0 ||
    budgetHit ||
    maxEntriesHit
  ) {
    log(
      `Workspace transfer temp cleanup scanned ${scannedEntries} entr${scannedEntries === 1 ? "y" : "ies"}, cleaned ${cleanedDirectories} director${cleanedDirectories === 1 ? "y" : "ies"} and ${cleanedFiles} loose temp file${cleanedFiles === 1 ? "" : "s"}, budgetHit=${budgetHit}, maxEntriesHit=${maxEntriesHit}.`,
    );
  }
}

async function cleanupDestinationTempEntry(
  directory: string,
  entry: string,
  cutoff: number,
): Promise<boolean> {
  if (!isDestinationTempFile(entry)) {
    return false;
  }

  const filePath = path.join(directory, entry);
  try {
    const stats = await fs.promises.lstat(filePath);
    if (stats.mtimeMs > cutoff) {
      return false;
    }

    if (entry.startsWith(REPLACE_BACKUP_TEMP_PREFIX)) {
      await fs.promises.rm(filePath, { force: true });
      return true;
    }

    await fs.promises.rm(filePath, { force: true });
    return true;
  } catch (error) {
    logError(`Could not clean stale destination temp file: ${filePath}`, error);
  }

  return false;
}

async function closeDirectoryBestEffort(dir: fs.Dir): Promise<void> {
  try {
    await dir.close();
  } catch {
    // The async iterator closes Dir on normal completion and break. This close
    // is a defensive fallback for early exits and errors.
  }
}

export async function cleanupStaleDestinationTempFiles(options: {
  directory: string;
  maxAgeMs?: number;
}): Promise<void> {
  const directory = options.directory;
  const maxAgeMs = options.maxAgeMs ?? STALE_TRANSFER_TEMP_MAX_AGE_MS;

  try {
    if (!(await pathExistsAsRealDirectory(directory, "Destination directory"))) {
      return;
    }
  } catch (error) {
    logError(`Could not inspect destination directory: ${directory}`, error);
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  try {
    const dir = await fs.promises.opendir(directory);
    try {
      for await (const entry of dir) {
        await cleanupDestinationTempEntry(directory, entry.name, cutoff);
      }
    } finally {
      await closeDirectoryBestEffort(dir);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logError(`Could not inspect destination directory: ${directory}`, error);
    }
  }
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

  const deadlineMs =
    Date.now() + Math.max(0, options.budgetMs ?? WORKSPACE_DESTINATION_CLEANUP_BUDGET_MS);
  const maxEntries = Math.max(0, options.maxEntries ?? WORKSPACE_DESTINATION_CLEANUP_MAX_ENTRIES);
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
    let dir: fs.Dir;
    try {
      dir = await fs.promises.opendir(directory);
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

async function cleanupTransferTempFilesForDownload(directory: string): Promise<void> {
  if (shouldRunThrottledCleanup(`transfer:${path.resolve(directory)}`)) {
    await cleanupStaleTransferTempFiles({ directory });
  }
}

async function cleanupDestinationTempFilesForDownload(directory: string): Promise<void> {
  if (shouldRunThrottledCleanup(`destination:${path.resolve(directory)}`)) {
    await cleanupStaleDestinationTempFiles({ directory });
  }
}

async function removeTempFile(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (error) {
    logError(`Could not remove transfer temp file: ${filePath}`, error);
  }
}

async function cancelUnconsumedDownloadStream(
  stream: ReadableStream<Uint8Array>,
  error: unknown,
): Promise<void> {
  try {
    await stream.cancel(error);
  } catch (cancelError) {
    logError("Could not cancel rejected download stream", cancelError);
  }
}

export function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function copyIntoPlaceNoFollow(
  sourcePath: string,
  destinationPath: string,
  options: MoveIntoPlaceOptions = {},
  allowedRootDirectory?: string,
): Promise<void> {
  const destinationTempPath = destinationMoveTempPath(destinationPath);
  let destinationTempCreated = false;

  try {
    if (allowedRootDirectory !== undefined) {
      if (options.overwrite !== false) {
        throw new Error("Root-bound downloads must be written without overwrite.");
      }
      await writeNewFileNoFollowWithinRoot(
        allowedRootDirectory,
        destinationTempPath,
        fs.createReadStream(sourcePath),
        {
          label: "download target temp file",
        },
      );
    } else {
      await writeNewFileNoFollow(destinationTempPath, fs.createReadStream(sourcePath));
    }

    destinationTempCreated = true;
    if (allowedRootDirectory !== undefined) {
      await prepareSafeFileWritePath(allowedRootDirectory, destinationPath, "download target");
    }
    if (options.overwrite === false && (await pathExists(destinationPath))) {
      const error = new Error(`Download destination file already exists: ${destinationPath}`);
      (error as NodeJS.ErrnoException).code = "EEXIST";
      throw error;
    }
    if (allowedRootDirectory !== undefined) {
      await prepareSafeFileWritePath(allowedRootDirectory, destinationPath, "download target");
    }
    if (options.overwrite === false) {
      await publishNewFileNoOverwrite(
        destinationTempPath,
        destinationPath,
        allowedRootDirectory === undefined,
      );
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
  preferHardlink: boolean,
): Promise<void> {
  if (preferHardlink) {
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

interface MoveIntoPlaceOptions {
  readonly overwrite?: boolean;
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

async function moveIntoPlace(
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

async function ensureDownloadDestinationDirectory(
  destinationPath: string,
  allowedRootDirectory: string | undefined,
): Promise<string> {
  const destinationDirectory = path.dirname(destinationPath);
  if (allowedRootDirectory !== undefined) {
    await prepareSafeFileWritePath(allowedRootDirectory, destinationPath, "download target");
  } else {
    await ensureRealDirectory(destinationDirectory, "Download destination directory", {
      recursive: true,
    });
  }
  return destinationDirectory;
}

function isNoSpaceError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOSPC";
}

function downloadStagingSpaceError(destinationPath: string, cause: unknown): Error {
  const error = new Error(
    `Not enough disk space to stage download near destination: ${destinationPath}. Free space on the destination volume or choose a destination with enough capacity.`,
  );
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export async function downloadStreamToFile(
  stream: ReadableStream<Uint8Array>,
  destinationPath: string,
  options: DownloadStreamToFileOptions = {},
): Promise<number> {
  return downloadStreamToFileInternal(stream, destinationPath, options);
}

export async function downloadStreamToNewFileWithinRoot(
  stream: ReadableStream<Uint8Array>,
  destinationPath: string,
  rootPath: string,
  options: DownloadStreamToNewFileWithinRootOptions = {},
): Promise<number> {
  return downloadStreamToFileInternal(stream, destinationPath, {
    ...options,
    overwrite: false,
    allowedRootDirectory: rootPath,
  });
}

async function downloadStreamToFileInternal(
  stream: ReadableStream<Uint8Array>,
  destinationPath: string,
  options: DownloadStreamToFileOptions = {},
): Promise<number> {
  const activity = createActivityAbortSignal(
    options.signal,
    options.stallTimeoutMs ?? DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
    `Download to ${destinationPath}`,
  );
  let temporaryRoot:
    | {
        readonly directory: string;
        readonly requiresPrivateDirectory: boolean;
      }
    | undefined;
  let temporaryPath = "";
  let sourceStreamOwnedByPipeline = false;

  try {
    const maxBytes = normalizedMaxBytes(options.maxBytes);
    assertKnownDownloadSizeWithinLimit(options.knownBytes, maxBytes, destinationPath);
    const destinationDirectory = await ensureDownloadDestinationDirectory(
      destinationPath,
      options.allowedRootDirectory,
    );
    await cleanupDestinationTempFilesForDownload(destinationDirectory);

    temporaryRoot = transferTempDirectory(options.temporaryDirectory, destinationDirectory);
    const temporaryDirectory = temporaryRoot.directory;
    await ensureTransferTempDirectory(
      temporaryDirectory,
      options.allowedRootDirectory,
      temporaryRoot.requiresPrivateDirectory,
    );
    await cleanupTransferTempFilesForDownload(temporaryDirectory);

    temporaryPath = transferTempPath(temporaryDirectory);
    const readable = Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
    sourceStreamOwnedByPipeline = true;
    readable.on("data", activity.markActivity);
    await pipeline(
      readable,
      createDownloadSizeLimitTransform(maxBytes, destinationPath),
      fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      {
        signal: activity.signal,
      },
    );

    const stats = await fs.promises.stat(temporaryPath);
    // Deliberately re-validate the parent directory after streaming so a
    // directory swap during the download is caught before path-based placement.
    await ensureDownloadDestinationDirectory(destinationPath, options.allowedRootDirectory);
    await moveIntoPlace(
      temporaryPath,
      destinationPath,
      options.overwrite !== undefined ? { overwrite: options.overwrite } : {},
      options.allowedRootDirectory,
    );
    temporaryPath = "";
    return stats.size;
  } catch (error) {
    if (!sourceStreamOwnedByPipeline) {
      await cancelUnconsumedDownloadStream(stream, error);
    }
    if (temporaryPath) {
      await removeTempFile(temporaryPath);
    }
    return normalizeTransferError(
      isNoSpaceError(error) ? downloadStagingSpaceError(destinationPath, error) : error,
      activity,
    );
  } finally {
    activity.dispose();
  }
}

function withActivityProgress(
  listener: ProgressListener | undefined,
  markActivity: () => void,
): ProgressListener {
  return (event) => {
    markActivity();
    listener?.(event);
  };
}

async function assertRealUploadSourcePath(localPath: string): Promise<fs.Stats> {
  const pathStats = await fs.promises.lstat(localPath);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`Local upload source must be a real file, not a symlink: ${localPath}`);
  }
  if (!pathStats.isFile()) {
    throw new Error(`Local path is not a file: ${localPath}`);
  }
  return pathStats;
}

export async function openUploadSourceFile(localPath: string): Promise<UploadSourceFile> {
  await assertRealUploadSourcePath(localPath);

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(localPath, fs.constants.O_RDONLY | NOFOLLOW_OPEN_FLAG);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Local upload source must be a real file, not a symlink: ${localPath}`);
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Local path is not a file: ${localPath}`);
    }

    const pathStats = await assertRealUploadSourcePath(localPath);
    if (!sameFileIdentity(stats, pathStats)) {
      throw new Error(`Local path changed while opening upload source: ${localPath}`);
    }

    return { path: localPath, handle, stats };
  } catch (error) {
    await handle.close().catch((closeError) => {
      logError(`Could not close upload source after validation failure: ${localPath}`, closeError);
    });
    throw error;
  }
}

export async function uploadFileHandle(
  bucket: UploadBucketHandle,
  fileHandle: fs.promises.FileHandle,
  localPath: string,
  remotePath: string,
  options: UploadFileFromDiskOptions = {},
): Promise<FileVersion> {
  const stats = await fileHandle.stat();
  if (!stats.isFile()) {
    throw new Error(`Local path is not a file: ${localPath}`);
  }

  const pathStats = await assertRealUploadSourcePath(localPath);
  if (!sameFileIdentity(stats, pathStats)) {
    throw new Error(`Local path changed while opening upload source: ${localPath}`);
  }

  return uploadFileFromDisk(
    bucket,
    { path: localPath, handle: fileHandle, stats },
    remotePath,
    options,
  );
}

export async function assertUploadSourcePathUnchanged(source: UploadSourceFile): Promise<void> {
  const pathStats = await fs.promises.stat(source.path);
  if (!sameFileIdentity(source.stats, pathStats)) {
    throw new Error(`Local path changed before upload: ${source.path}`);
  }
}

export async function closeUploadSource(source: UploadSourceFile): Promise<void> {
  await source.handle.close().catch((error) => {
    logError(`Could not close upload source: ${source.path}`, error);
  });
}

function isUploadSourceFile(value: string | UploadSourceFile): value is UploadSourceFile {
  return typeof value !== "string";
}

class CleanupOperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupOperationTimeoutError";
  }
}

async function observeImmediateUploadDoneError(
  done: Promise<FileVersion> | undefined,
): Promise<unknown | undefined> {
  if (done === undefined) {
    return undefined;
  }

  return Promise.race([
    done.then(
      () => undefined,
      (error) => error,
    ),
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 0);
      timer.unref?.();
    }),
  ]);
}

async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation(new AbortController().signal);
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new CleanupOperationTimeoutError(
        `${description} timed out after ${timeoutMs} ms.`,
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function recordUnfinishedUploadCleanupTimeout(description: string, error: unknown): void {
  unfinishedUploadCleanupDiagnostics.timedOutCleanupCount += 1;
  logError(
    `${description} timed out; unfinished-upload cleanup will continue to be retried`,
    error,
  );
}

function isMissingCapabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const details = error as Error & { code?: string };
  return String(details.code ?? "").toLowerCase() === "missing_capability";
}

function recordUnfinishedUploadCleanupMissingCapability(
  description: string,
  error: unknown,
  onMissingCapability: ((description: string, error: unknown) => void) | undefined,
): void {
  if (onMissingCapability) {
    onMissingCapability(description, error);
    return;
  }

  log(
    `${description} cleanup skipped because the B2 key lacks the required unfinished-upload listing capability.`,
  );
}

function remainingCleanupBudget(startedAt: number, budgetMs: number): number {
  return Math.max(0, startedAt + budgetMs - Date.now());
}

function startedMsFromFileInfo(fileInfo: Record<string, string> | undefined): number | undefined {
  const startedMs = Number(fileInfo?.[UPLOAD_STARTED_MS_INFO_KEY]);
  return Number.isFinite(startedMs) ? startedMs : undefined;
}

interface UploadSessionMarker {
  readonly remotePath: string;
  readonly uploadSessionId: string;
  readonly startedMs: number;
}

function uploadSessionMarkerDirectory(): string {
  return path.join(os.tmpdir(), UPLOAD_SESSION_MARKER_DIR_NAME);
}

function uploadSessionMarkerPath(remotePath: string, uploadSessionId: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(remotePath)
    .update("\0")
    .update(uploadSessionId)
    .digest("hex");
  return path.join(
    uploadSessionMarkerDirectory(),
    `${UPLOAD_SESSION_MARKER_PREFIX}${digest}${UPLOAD_SESSION_MARKER_SUFFIX}`,
  );
}

export async function cleanupStaleUploadSessionMarkers(
  maxAgeMs = STALE_UPLOAD_SESSION_MARKER_MAX_AGE_MS,
): Promise<void> {
  const directory = uploadSessionMarkerDirectory();
  try {
    if (!(await pathExistsAsRealDirectory(directory, "Upload session marker directory"))) {
      return;
    }
    await assertPrivateDirectory(directory, "Upload session marker directory");
  } catch (error) {
    logError(`Could not inspect upload session marker directory: ${directory}`, error);
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch (error) {
    logError(`Could not list upload session marker directory: ${directory}`, error);
    return;
  }

  for (const entry of entries) {
    if (
      !entry.startsWith(UPLOAD_SESSION_MARKER_PREFIX) ||
      !entry.endsWith(UPLOAD_SESSION_MARKER_SUFFIX)
    ) {
      continue;
    }

    const markerPath = path.join(directory, entry);
    try {
      const stats = await fs.promises.lstat(markerPath);
      if ((!stats.isFile() && !stats.isSymbolicLink()) || stats.mtimeMs > cutoff) {
        continue;
      }

      await fs.promises.rm(markerPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logError(`Could not remove stale upload session marker: ${markerPath}`, error);
      }
    }
  }
}

async function writeUploadSessionMarker(marker: UploadSessionMarker): Promise<void> {
  const directory = uploadSessionMarkerDirectory();
  await ensurePrivateDirectory(directory, "Upload session marker directory", {
    recursive: true,
    mode: 0o700,
  });
  await writeNewFileNoFollow(
    uploadSessionMarkerPath(marker.remotePath, marker.uploadSessionId),
    JSON.stringify(marker),
  );
}

async function removeUploadSessionMarker(
  remotePath: string,
  uploadSessionId: string,
): Promise<void> {
  await fs.promises
    .rm(uploadSessionMarkerPath(remotePath, uploadSessionId), { force: true })
    .catch((error) => {
      logError(`Could not remove upload session marker for ${remotePath}`, error);
    });
}

async function hasMatchingUploadSessionMarker(
  remotePath: string,
  uploadSessionId: string | undefined,
  startedMs: number | undefined,
): Promise<boolean> {
  if (uploadSessionId === undefined || startedMs === undefined) {
    return false;
  }

  try {
    const directory = uploadSessionMarkerDirectory();
    await assertPrivateDirectory(directory, "Upload session marker directory");
    const markerPath = uploadSessionMarkerPath(remotePath, uploadSessionId);
    const marker = await readUploadSessionMarker(markerPath);
    return (
      marker.remotePath === remotePath &&
      marker.uploadSessionId === uploadSessionId &&
      marker.startedMs === startedMs
    );
  } catch {
    return false;
  }
}

async function readUploadSessionMarker(markerPath: string): Promise<Partial<UploadSessionMarker>> {
  const stats = await fs.promises.lstat(markerPath);
  if (!stats.isFile()) {
    throw new Error(`Upload session marker must be a regular file: ${markerPath}`);
  }

  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fileHandle = await fs.promises.open(markerPath, fs.constants.O_RDONLY | noFollowFlag);
  try {
    const openedStats = await fileHandle.stat();
    if (!openedStats.isFile()) {
      throw new Error(`Upload session marker must be a regular file: ${markerPath}`);
    }
    return JSON.parse(await fileHandle.readFile("utf8")) as Partial<UploadSessionMarker>;
  } finally {
    await fileHandle.close();
  }
}

async function cancelLargeFileSafely(
  bucket: UploadBucketHandle,
  fileId: LargeFileId,
  timeoutMs: number,
  description: string,
): Promise<boolean> {
  if (!bucket.cancelLargeFile) {
    return false;
  }

  try {
    await withAbortableTimeout(
      (signal) => bucket.cancelLargeFile?.(fileId, { signal }) ?? Promise.resolve(),
      timeoutMs,
      description,
    );
    return true;
  } catch (error) {
    if (error instanceof CleanupOperationTimeoutError) {
      recordUnfinishedUploadCleanupTimeout(description, error);
      return false;
    }
    logError(`Could not cancel unfinished large file ${fileId}`, error);
    return false;
  }
}

/**
 * Reclaims stale unfinished uploads only when forgeable B2 metadata matches a
 * locally persisted upload-session marker. Unowned stale uploads are audited
 * but not canceled.
 */
export async function cleanupStaleUnfinishedUploads(
  bucket: UploadBucketHandle,
  options: StaleUnfinishedUploadCleanupOptions = {},
): Promise<StaleUnfinishedUploadCleanupResult> {
  if (!options.skipUploadSessionMarkerCleanup) {
    await cleanupStaleUploadSessionMarkers().catch((error) => {
      logError("Could not clean stale upload session markers", error);
    });
  }

  const cutoff =
    Date.now() - (options.unfinishedCleanupMaxAgeMs ?? STALE_UNFINISHED_UPLOAD_MAX_AGE_MS);
  let ignoredUnownedStaleUploadCount = 0;
  const reclaimedOwnedStaleUploadCount = await cleanupMatchingUnfinishedUploads(
    bucket,
    options.remotePath,
    options,
    "Locally owned stale unfinished upload",
    async (file) => {
      const startedMs = startedMsFromFileInfo(file.fileInfo);
      const uploadSessionId = file.fileInfo?.[UPLOAD_SESSION_ID_INFO_KEY];
      if (
        startedMs === undefined ||
        startedMs > cutoff ||
        (options.remotePath !== undefined && file.fileName !== options.remotePath)
      ) {
        return;
      }

      if (await hasMatchingUploadSessionMarker(file.fileName, uploadSessionId, startedMs)) {
        return true;
      }

      ignoredUnownedStaleUploadCount += 1;
      return false;
    },
  );

  if (reclaimedOwnedStaleUploadCount > 0) {
    log(`Reclaimed ${reclaimedOwnedStaleUploadCount} locally owned stale unfinished upload(s).`);
  }

  if (ignoredUnownedStaleUploadCount > 0) {
    log(
      `Ignored ${ignoredUnownedStaleUploadCount} unowned stale unfinished upload(s); local owner marker is required before cancellation.`,
    );
  }

  return {
    reclaimedOwnedStaleUploadCount,
    ignoredUnownedStaleUploadCount,
  };
}

async function cleanupOwnedUnfinishedUpload(
  bucket: UploadBucketHandle,
  remotePath: string,
  uploadSessionId: string,
  options: Pick<
    UploadFileFromDiskOptions,
    | "unfinishedCleanupMaxPages"
    | "unfinishedCleanupMaxCancels"
    | "unfinishedCleanupTimeoutMs"
    | "unfinishedCleanupBudgetMs"
  > = {},
): Promise<number> {
  return runSerializedUnfinishedUploadCleanup(() =>
    cleanupMatchingUnfinishedUploads(
      bucket,
      remotePath,
      options,
      "Owned unfinished upload",
      (file) => {
        return (
          file.fileName === remotePath &&
          file.fileInfo?.[UPLOAD_SESSION_ID_INFO_KEY] === uploadSessionId
        );
      },
    ),
  );
}

async function cleanupStaleSameKeyUnfinishedUploads(
  bucket: UploadBucketHandle,
  remotePath: string,
  options: Pick<
    UploadFileFromDiskOptions,
    | "unfinishedCleanupMaxPages"
    | "unfinishedCleanupMaxCancels"
    | "unfinishedCleanupTimeoutMs"
    | "unfinishedCleanupBudgetMs"
    | "unfinishedCleanupMinAgeMs"
  > = {},
): Promise<void> {
  const minAgeMs = options.unfinishedCleanupMinAgeMs ?? UNFINISHED_UPLOAD_STALE_MIN_AGE_MS;
  const cutoffMs = Date.now() - Math.max(0, minAgeMs);
  const canceledCount = await cleanupMatchingUnfinishedUploads(
    bucket,
    remotePath,
    options,
    "Stale same-key unfinished upload",
    (file) => {
      const startedMs = startedMsFromFileInfo(file.fileInfo);
      return (
        file.fileName === remotePath &&
        file.fileInfo?.[UPLOAD_OWNER_INFO_KEY] === "b2-vscode" &&
        startedMs !== undefined &&
        startedMs <= cutoffMs
      );
    },
  );
  if (canceledCount > 0) {
    log(`Canceled ${canceledCount} stale same-key unfinished upload(s) for ${remotePath}.`);
  }
}

async function runSerializedUnfinishedUploadCleanup<T>(cleanup: () => Promise<T>): Promise<T> {
  if (unfinishedUploadCleanupPendingCount > 0) {
    unfinishedUploadCleanupDiagnostics.queuedOwnedCleanupCount += 1;
  }

  unfinishedUploadCleanupPendingCount += 1;
  const previous = unfinishedUploadCleanupChain.catch(() => undefined);
  const current = previous.then(cleanup);
  unfinishedUploadCleanupChain = current.then(
    () => undefined,
    () => undefined,
  );

  try {
    return await current;
  } finally {
    unfinishedUploadCleanupPendingCount -= 1;
  }
}

async function cleanupMatchingUnfinishedUploads(
  bucket: UploadBucketHandle,
  remotePath: string | undefined,
  options: Pick<
    UploadFileFromDiskOptions,
    | "unfinishedCleanupMaxPages"
    | "unfinishedCleanupMaxCancels"
    | "unfinishedCleanupTimeoutMs"
    | "unfinishedCleanupBudgetMs"
  > &
    Pick<StaleUnfinishedUploadCleanupOptions, "onMissingCapability"> = {},
  description: string,
  shouldCancel: (file: UnfinishedLargeFile) => boolean | undefined | Promise<boolean | undefined>,
): Promise<number> {
  if (!bucket.listUnfinishedLargeFiles || !bucket.cancelLargeFile) {
    return 0;
  }

  let startFileId: LargeFileId | undefined;
  let pagesScanned = 0;
  let cancelsAttempted = 0;
  const startedAt = Date.now();
  const maxPages = options.unfinishedCleanupMaxPages ?? UNFINISHED_UPLOAD_CLEANUP_MAX_PAGES;
  const maxCancels = options.unfinishedCleanupMaxCancels ?? UNFINISHED_UPLOAD_CLEANUP_MAX_CANCELS;
  const timeoutMs = options.unfinishedCleanupTimeoutMs ?? UNFINISHED_UPLOAD_CLEANUP_TIMEOUT_MS;
  const budgetMs = options.unfinishedCleanupBudgetMs ?? UNFINISHED_UPLOAD_CLEANUP_BUDGET_MS;
  let canceledCount = 0;
  do {
    if (pagesScanned >= maxPages) {
      const cleanupTarget = remotePath ?? "bucket";
      logError(
        `Unfinished upload cleanup for ${cleanupTarget} reached the ${maxPages} page limit`,
        new Error(`Unfinished upload cleanup exceeded ${maxPages} page(s).`),
      );
      return canceledCount;
    }

    const listBudgetMs = Math.min(timeoutMs, remainingCleanupBudget(startedAt, budgetMs));
    if (listBudgetMs <= 0) {
      logError(
        `${description} cleanup stopped after reaching the ${budgetMs} ms wall-clock budget`,
        new Error("Unfinished-upload cleanup budget exhausted."),
      );
      return canceledCount;
    }

    let page: {
      files: readonly UnfinishedLargeFile[];
      nextFileId: LargeFileId | null;
    };
    try {
      page = await withAbortableTimeout(
        (signal) =>
          bucket.listUnfinishedLargeFiles?.({
            ...(remotePath !== undefined ? { namePrefix: remotePath } : {}),
            pageSize: 100,
            ...(startFileId !== undefined ? { startFileId } : {}),
            signal,
          }) ?? Promise.reject(new Error("Bucket cannot list unfinished uploads.")),
        listBudgetMs,
        `${description} list`,
      );
    } catch (error) {
      if (error instanceof CleanupOperationTimeoutError) {
        recordUnfinishedUploadCleanupTimeout(`${description} list`, error);
      } else if (isMissingCapabilityError(error)) {
        recordUnfinishedUploadCleanupMissingCapability(
          `${description} list`,
          error,
          options.onMissingCapability,
        );
      } else {
        logError(`${description} list failed`, error);
      }
      return canceledCount;
    }
    pagesScanned += 1;

    for (const file of page.files) {
      if (!(await shouldCancel(file))) {
        continue;
      }
      if (cancelsAttempted >= maxCancels) {
        logError(
          `${description} cleanup reached the ${maxCancels} cancel limit`,
          new Error("Unfinished-upload cleanup cancel limit exhausted."),
        );
        return canceledCount;
      }
      const cancelBudgetMs = Math.min(timeoutMs, remainingCleanupBudget(startedAt, budgetMs));
      if (cancelBudgetMs <= 0) {
        logError(
          `${description} cleanup stopped after reaching the ${budgetMs} ms wall-clock budget`,
          new Error("Unfinished-upload cleanup budget exhausted."),
        );
        return canceledCount;
      }
      cancelsAttempted += 1;
      const canceled = await cancelLargeFileSafely(
        bucket,
        file.fileId,
        cancelBudgetMs,
        `${description} cancel`,
      );
      if (canceled) {
        canceledCount += 1;
        const uploadSessionId = file.fileInfo?.[UPLOAD_SESSION_ID_INFO_KEY];
        if (uploadSessionId !== undefined) {
          await removeUploadSessionMarker(file.fileName, uploadSessionId);
        }
      }
    }

    startFileId = page.nextFileId ?? undefined;
  } while (startFileId !== undefined);

  return canceledCount;
}

/**
 * Upload a local file path or a pre-opened source file. Passing an
 * UploadSourceFile transfers ownership of its handle to this function; the
 * handle is always closed before the promise settles.
 */
export async function uploadFileFromDisk(
  bucket: UploadBucketHandle,
  localPathOrSource: string | UploadSourceFile,
  remotePath: string,
  options: UploadFileFromDiskOptions = {},
): Promise<FileVersion> {
  const source = isUploadSourceFile(localPathOrSource)
    ? localPathOrSource
    : await openUploadSourceFile(localPathOrSource);
  const localPath = source.path;
  const stats = source.stats;

  const activity = createActivityAbortSignal(
    options.signal,
    options.stallTimeoutMs ?? DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
    `Upload of ${localPath}`,
  );
  const uploadSessionId = crypto.randomUUID();
  const uploadStartedMs = Date.now();
  let uploadSessionMarkerWritten = false;
  let uploadDoneError: unknown;
  let uploadDone: Promise<FileVersion> | undefined;
  let uploadStreamWasCreated = false;

  try {
    if (stats.size === 0) {
      return await Promise.race([
        bucket.upload({
          fileName: remotePath,
          source: new BufferSource(new Uint8Array(0)),
          signal: activity.signal,
          ...(options.onProgress !== undefined
            ? { onProgress: withActivityProgress(options.onProgress, activity.markActivity) }
            : {}),
        }),
        abortPromise(activity.signal),
      ]);
    }

    await cleanupStaleSameKeyUnfinishedUploads(bucket, remotePath, options).catch((error) => {
      logError(`Could not clean stale unfinished uploads for ${remotePath}`, error);
    });
    try {
      await writeUploadSessionMarker({ remotePath, uploadSessionId, startedMs: uploadStartedMs });
      uploadSessionMarkerWritten = true;
    } catch (error) {
      logError(
        `Could not write upload session marker for ${remotePath}; upload will continue without restart cleanup marker.`,
        error,
      );
    }

    const { writable, done } = bucket.file(remotePath).createWriteStream({
      partSize: options.partSize ?? STREAMING_UPLOAD_PART_SIZE,
      fileInfo: {
        [UPLOAD_OWNER_INFO_KEY]: "b2-vscode",
        [UPLOAD_SESSION_ID_INFO_KEY]: uploadSessionId,
        [UPLOAD_STARTED_MS_INFO_KEY]: String(uploadStartedMs),
      },
      signal: activity.signal,
      onProgress: withActivityProgress(options.onProgress, activity.markActivity),
    });
    uploadDone = done;
    uploadStreamWasCreated = true;
    void done.catch((error) => {
      uploadDoneError = error;
      logError(`B2 upload stream failed for ${remotePath}`, error);
    });

    const readableStream = source.handle.createReadStream({ autoClose: false, start: 0 });
    readableStream.on("data", activity.markActivity);
    const readable = Readable.toWeb(readableStream) as ReadableStream<Uint8Array>;

    await readable.pipeTo(writable, { signal: activity.signal });
    const result = await done;
    if (uploadSessionMarkerWritten) {
      await removeUploadSessionMarker(remotePath, uploadSessionId);
    }
    return result;
  } catch (error) {
    let canceledCount = 0;
    if (uploadStreamWasCreated) {
      canceledCount = await cleanupOwnedUnfinishedUpload(
        bucket,
        remotePath,
        uploadSessionId,
        options,
      ).catch((cleanupError) => {
        logError(`Could not clean up unfinished upload for ${remotePath}`, cleanupError);
        return 0;
      });
    }
    if (uploadSessionMarkerWritten && (!uploadStreamWasCreated || canceledCount > 0)) {
      await removeUploadSessionMarker(remotePath, uploadSessionId);
    }
    normalizeTransferError(
      uploadDoneError ?? (await observeImmediateUploadDoneError(uploadDone)) ?? error,
      activity,
    );
  } finally {
    activity.dispose();
    await closeUploadSource(source);
  }
}
