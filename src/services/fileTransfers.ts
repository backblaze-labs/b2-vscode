/**
 * Filesystem-backed B2 transfer helpers.
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
import { logError } from "../logger";
import { humanSize } from "../utils/humanSize";
import {
  ensureContainedDirectoryPath,
  ensureRealDirectory,
  pathExistsAsRealDirectory,
} from "./pathSafety";

export const DEFAULT_TRANSFER_STALL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const STREAMING_UPLOAD_PART_SIZE = 8 * 1024 * 1024;

const TRANSFER_TEMP_DIR_NAME = "b2-vscode-transfers";
const TRANSFER_TEMP_PREFIX = "b2-transfer-";
const TRANSFER_TEMP_SUFFIX = ".tmp";
const CROSS_DEVICE_MOVE_TEMP_PREFIX = ".b2-cross-device-";
const REPLACE_BACKUP_TEMP_PREFIX = ".b2-replace-backup-";
const STALE_TRANSFER_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const STALE_CLEANUP_THROTTLE_MAX_ENTRIES = 256;
const UNFINISHED_UPLOAD_CLEANUP_MAX_PAGES = 20;
const UNFINISHED_UPLOAD_CLEANUP_MAX_CANCELS = 10;
const UNFINISHED_UPLOAD_CLEANUP_TIMEOUT_MS = 10_000;
const UNFINISHED_UPLOAD_CLEANUP_BUDGET_MS = 30_000;
const UPLOAD_OWNER_INFO_KEY = "b2-vscode-upload-owner";
const UPLOAD_SESSION_ID_INFO_KEY = "b2-vscode-upload-session-id";
const UPLOAD_STARTED_MS_INFO_KEY = "b2-vscode-upload-started-ms";
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

export class TransferStallTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferStallTimeoutError";
  }
}

export class DownloadSizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadSizeLimitError";
  }
}

export interface TransferTimeoutOptions {
  readonly signal?: AbortSignal;
  readonly stallTimeoutMs?: number;
}

export interface DownloadStreamToFileOptions extends TransferTimeoutOptions {
  readonly temporaryDirectory?: string;
  readonly overwrite?: boolean;
  readonly allowedRootDirectory?: string;
  readonly maxBytes?: number;
}

export interface UploadFileFromDiskOptions extends TransferTimeoutOptions {
  readonly onProgress?: ProgressListener;
  readonly partSize?: number;
  readonly unfinishedCleanupMaxPages?: number;
  readonly unfinishedCleanupMaxCancels?: number;
  readonly unfinishedCleanupTimeoutMs?: number;
  readonly unfinishedCleanupBudgetMs?: number;
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
    files: readonly {
      fileId: LargeFileId;
      fileName: string;
      fileInfo?: Record<string, string>;
    }[];
    nextFileId: LargeFileId | null;
  }>;
  cancelLargeFile?(fileId: LargeFileId, options?: { signal?: AbortSignal }): Promise<unknown>;
}

type UnfinishedLargeFile = {
  fileId: LargeFileId;
  fileName: string;
  fileInfo?: Record<string, string>;
};

export interface UploadSourceFile {
  readonly path: string;
  readonly handle: fs.promises.FileHandle;
  readonly stats: fs.Stats;
}

interface ActivityAbortSignal {
  readonly signal: AbortSignal;
  markActivity(): void;
  timeoutError(): TransferStallTimeoutError | undefined;
  dispose(): void;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function createActivityAbortSignal(
  parentSignal: AbortSignal | undefined,
  stallTimeoutMs: number,
  description: string,
): ActivityAbortSignal {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut: TransferStallTimeoutError | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const markActivity = () => {
    clearTimer();
    if (stallTimeoutMs <= 0 || controller.signal.aborted) {
      return;
    }

    timer = setTimeout(() => {
      timedOut = new TransferStallTimeoutError(
        `${description} stalled for ${stallTimeoutMs} ms with no transfer activity.`,
      );
      controller.abort(timedOut);
    }, stallTimeoutMs);
    timer.unref?.();
  };

  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    markActivity();
  }

  return {
    signal: controller.signal,
    markActivity,
    timeoutError: () => timedOut,
    dispose() {
      clearTimer();
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function normalizeTransferError(error: unknown, activity: ActivityAbortSignal): never {
  const timeoutError = activity.timeoutError();
  if (timeoutError && (activity.signal.aborted || isAbortLikeError(error))) {
    throw timeoutError;
  }

  throw error;
}

function normalizedMaxBytes(maxBytes: number | undefined): number {
  const normalized = maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error("Download maximum byte count must be a non-negative finite number.");
  }
  return normalized;
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

function abortPromise(signal: AbortSignal): Promise<never> {
  const abortReason = () => signal.reason ?? new DOMException("Aborted", "AbortError");

  if (signal.aborted) {
    return Promise.reject(abortReason());
  }

  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortReason()), { once: true });
  });
}

export async function withTransferStallTimeout<T>(
  description: string,
  options: TransferTimeoutOptions,
  run: (signal: AbortSignal, markActivity: () => void) => Promise<T>,
): Promise<T> {
  const activity = createActivityAbortSignal(
    options.signal,
    options.stallTimeoutMs ?? DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
    description,
  );

  try {
    return await Promise.race([
      run(activity.signal, activity.markActivity),
      abortPromise(activity.signal),
    ]);
  } catch (error) {
    normalizeTransferError(error, activity);
  } finally {
    activity.dispose();
  }
}

function transferTempDirectory(directory?: string): string {
  return directory ?? path.join(os.tmpdir(), TRANSFER_TEMP_DIR_NAME);
}

async function setPrivateDirectoryPermissions(directory: string): Promise<void> {
  await fs.promises.chmod(directory, 0o700).catch((error) => {
    logError(`Could not set private permissions on transfer temp directory: ${directory}`, error);
  });
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await ensureRealDirectory(directory, "Transfer temp directory", {
    recursive: true,
    mode: 0o700,
  });

  await setPrivateDirectoryPermissions(directory);
}

async function ensureTransferTempDirectory(
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
    return;
  }

  await ensurePrivateDirectory(directory);
}

function transferTempPath(directory: string): string {
  const random = crypto.randomBytes(12).toString("hex");
  return path.join(
    directory,
    `${TRANSFER_TEMP_PREFIX}${process.pid}-${random}${TRANSFER_TEMP_SUFFIX}`,
  );
}

function destinationMoveTempPath(destinationPath: string): string {
  const random = crypto.randomBytes(12).toString("hex");
  const parsed = path.parse(destinationPath);
  return path.join(
    parsed.dir,
    `${CROSS_DEVICE_MOVE_TEMP_PREFIX}${parsed.base}-${process.pid}-${random}${TRANSFER_TEMP_SUFFIX}`,
  );
}

function destinationReplaceBackupPath(destinationPath: string): string {
  const random = crypto.randomBytes(12).toString("hex");
  const parsed = path.parse(destinationPath);
  return path.join(
    parsed.dir,
    `${REPLACE_BACKUP_TEMP_PREFIX}${parsed.base}-${process.pid}-${random}${TRANSFER_TEMP_SUFFIX}`,
  );
}

function isTransferTempFile(name: string): boolean {
  return name.startsWith(TRANSFER_TEMP_PREFIX) && name.endsWith(TRANSFER_TEMP_SUFFIX);
}

function isDestinationTempFile(name: string): boolean {
  return (
    (name.startsWith(CROSS_DEVICE_MOVE_TEMP_PREFIX) ||
      name.startsWith(REPLACE_BACKUP_TEMP_PREFIX)) &&
    name.endsWith(TRANSFER_TEMP_SUFFIX)
  );
}

function backupDestinationPath(directory: string, name: string): string | undefined {
  if (!name.startsWith(REPLACE_BACKUP_TEMP_PREFIX) || !name.endsWith(TRANSFER_TEMP_SUFFIX)) {
    return undefined;
  }

  const encoded = name.slice(
    REPLACE_BACKUP_TEMP_PREFIX.length,
    name.length - TRANSFER_TEMP_SUFFIX.length,
  );
  const match = /^(.*)-\d+-[a-f0-9]+$/u.exec(encoded);
  return match ? path.join(directory, match[1]) : undefined;
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
  const directory = transferTempDirectory(options.directory);
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

    const filePath = path.join(directory, entry);
    try {
      const stats = await fs.promises.lstat(filePath);
      if (stats.mtimeMs <= cutoff) {
        await fs.promises.rm(filePath, { force: true });
      }
    } catch (error) {
      logError(`Could not remove stale transfer temp file: ${filePath}`, error);
    }
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

  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logError(`Could not inspect destination directory: ${directory}`, error);
    }
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!isDestinationTempFile(entry)) {
      continue;
    }

    const filePath = path.join(directory, entry);
    try {
      const stats = await fs.promises.lstat(filePath);
      const restorePath = backupDestinationPath(directory, entry);
      if (restorePath && !fs.existsSync(restorePath)) {
        if (!stats.isFile()) {
          if (stats.mtimeMs <= cutoff) {
            await fs.promises.rm(filePath, { force: true });
          }
          continue;
        }
        await fs.promises.rename(filePath, restorePath);
      } else if (stats.mtimeMs <= cutoff) {
        await fs.promises.rm(filePath, { force: true });
      } else {
        continue;
      }
    } catch (error) {
      logError(`Could not clean stale destination temp file: ${filePath}`, error);
    }
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

export function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
): Promise<void> {
  try {
    await fs.promises.link(sourcePath, destinationPath);
    await removeTempFile(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }

    const destinationTempPath = destinationMoveTempPath(destinationPath);
    try {
      await fs.promises.copyFile(sourcePath, destinationTempPath, fs.constants.COPYFILE_EXCL);
      await fs.promises.link(destinationTempPath, destinationPath);
      await removeTempFile(sourcePath);
      await removeTempFile(destinationTempPath);
    } catch (copyError) {
      await removeTempFile(destinationTempPath);
      throw copyError;
    }
  }
}

async function moveIntoPlace(
  sourcePath: string,
  destinationPath: string,
  options: MoveIntoPlaceOptions = {},
): Promise<void> {
  if (options.overwrite === false) {
    await moveIntoPlaceWithoutOverwrite(sourcePath, destinationPath);
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
    await ensureContainedDirectoryPath(
      allowedRootDirectory,
      destinationDirectory,
      "Workspace download directory",
    );
  } else {
    await ensureRealDirectory(destinationDirectory, "Download destination directory", {
      recursive: true,
    });
  }
  return destinationDirectory;
}

export async function downloadStreamToFile(
  stream: ReadableStream<Uint8Array>,
  destinationPath: string,
  options: DownloadStreamToFileOptions = {},
): Promise<number> {
  const activity = createActivityAbortSignal(
    options.signal,
    options.stallTimeoutMs ?? DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
    `Download to ${destinationPath}`,
  );
  const temporaryDirectory = transferTempDirectory(options.temporaryDirectory);
  let temporaryPath = "";

  try {
    const maxBytes = normalizedMaxBytes(options.maxBytes);
    const destinationDirectory = await ensureDownloadDestinationDirectory(
      destinationPath,
      options.allowedRootDirectory,
    );

    await cleanupDestinationTempFilesForDownload(destinationDirectory);
    await ensureTransferTempDirectory(temporaryDirectory, options.allowedRootDirectory);
    await cleanupTransferTempFilesForDownload(temporaryDirectory);

    temporaryPath = transferTempPath(temporaryDirectory);
    const readable = Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
    readable.on("data", activity.markActivity);
    await pipeline(
      readable,
      createDownloadSizeLimitTransform(maxBytes, destinationPath),
      fs.createWriteStream(temporaryPath, { flags: "wx" }),
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
    );
    temporaryPath = "";
    return stats.size;
  } catch (error) {
    if (temporaryPath) {
      await removeTempFile(temporaryPath);
    }
    normalizeTransferError(error, activity);
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

export async function openUploadSourceFile(localPath: string): Promise<UploadSourceFile> {
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

    const pathStats = await fs.promises.stat(localPath);
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

function remainingCleanupBudget(startedAt: number, budgetMs: number): number {
  return Math.max(0, startedAt + budgetMs - Date.now());
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
): Promise<void> {
  await runSerializedUnfinishedUploadCleanup("Owned unfinished upload", () =>
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

async function runSerializedUnfinishedUploadCleanup(
  _description: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  if (unfinishedUploadCleanupPendingCount > 0) {
    unfinishedUploadCleanupDiagnostics.queuedOwnedCleanupCount += 1;
  }

  unfinishedUploadCleanupPendingCount += 1;
  const previous = unfinishedUploadCleanupChain.catch(() => undefined);
  const current = previous.then(cleanup);
  unfinishedUploadCleanupChain = current.catch(() => undefined);

  try {
    await current;
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
  > = {},
  description: string,
  shouldCancel: (file: UnfinishedLargeFile) => boolean,
): Promise<void> {
  if (!bucket.listUnfinishedLargeFiles || !bucket.cancelLargeFile) {
    return;
  }

  let startFileId: LargeFileId | undefined;
  let pagesScanned = 0;
  let cancelsAttempted = 0;
  const startedAt = Date.now();
  const maxPages = options.unfinishedCleanupMaxPages ?? UNFINISHED_UPLOAD_CLEANUP_MAX_PAGES;
  const maxCancels = options.unfinishedCleanupMaxCancels ?? UNFINISHED_UPLOAD_CLEANUP_MAX_CANCELS;
  const timeoutMs = options.unfinishedCleanupTimeoutMs ?? UNFINISHED_UPLOAD_CLEANUP_TIMEOUT_MS;
  const budgetMs = options.unfinishedCleanupBudgetMs ?? UNFINISHED_UPLOAD_CLEANUP_BUDGET_MS;
  do {
    if (pagesScanned >= maxPages) {
      const cleanupTarget = remotePath ?? "bucket";
      logError(
        `Unfinished upload cleanup for ${cleanupTarget} reached the ${maxPages} page limit`,
        new Error(`Unfinished upload cleanup exceeded ${maxPages} page(s).`),
      );
      return;
    }

    const listBudgetMs = Math.min(timeoutMs, remainingCleanupBudget(startedAt, budgetMs));
    if (listBudgetMs <= 0) {
      logError(
        `${description} cleanup stopped after reaching the ${budgetMs} ms wall-clock budget`,
        new Error("Unfinished-upload cleanup budget exhausted."),
      );
      return;
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
      } else {
        logError(`${description} list failed`, error);
      }
      return;
    }
    pagesScanned += 1;

    for (const file of page.files) {
      if (!shouldCancel(file)) {
        continue;
      }
      if (cancelsAttempted >= maxCancels) {
        logError(
          `${description} cleanup reached the ${maxCancels} cancel limit`,
          new Error("Unfinished-upload cleanup cancel limit exhausted."),
        );
        return;
      }
      const cancelBudgetMs = Math.min(timeoutMs, remainingCleanupBudget(startedAt, budgetMs));
      if (cancelBudgetMs <= 0) {
        logError(
          `${description} cleanup stopped after reaching the ${budgetMs} ms wall-clock budget`,
          new Error("Unfinished-upload cleanup budget exhausted."),
        );
        return;
      }
      cancelsAttempted += 1;
      await withAbortableTimeout(
        (signal) => bucket.cancelLargeFile?.(file.fileId, { signal }) ?? Promise.resolve(),
        cancelBudgetMs,
        `${description} cancel`,
      ).catch((error) => {
        if (error instanceof CleanupOperationTimeoutError) {
          recordUnfinishedUploadCleanupTimeout(`${description} cancel`, error);
        } else {
          logError(`Could not cancel unfinished upload ${file.fileId}`, error);
        }
      });
    }

    startFileId = page.nextFileId ?? undefined;
  } while (startFileId !== undefined);
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
  let uploadSessionId: string | undefined;

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

    uploadSessionId = crypto.randomUUID();
    const { writable, done } = bucket.file(remotePath).createWriteStream({
      partSize: options.partSize ?? STREAMING_UPLOAD_PART_SIZE,
      fileInfo: {
        [UPLOAD_OWNER_INFO_KEY]: "b2-vscode",
        [UPLOAD_SESSION_ID_INFO_KEY]: uploadSessionId,
        [UPLOAD_STARTED_MS_INFO_KEY]: String(Date.now()),
      },
      signal: activity.signal,
      onProgress: withActivityProgress(options.onProgress, activity.markActivity),
    });
    void done.catch((error) => {
      logError(`Upload finalize failed for ${remotePath}`, error);
    });

    const readableStream = source.handle.createReadStream({ autoClose: false, start: 0 });
    readableStream.on("data", activity.markActivity);
    const readable = Readable.toWeb(readableStream) as ReadableStream<Uint8Array>;

    await readable.pipeTo(writable, { signal: activity.signal });
    return await done;
  } catch (error) {
    if (uploadSessionId !== undefined) {
      await cleanupOwnedUnfinishedUpload(bucket, remotePath, uploadSessionId, options).catch(
        (cleanupError) => {
          logError(`Could not clean up unfinished upload for ${remotePath}`, cleanupError);
        },
      );
    }
    normalizeTransferError(error, activity);
  } finally {
    activity.dispose();
    await closeUploadSource(source);
  }
}
