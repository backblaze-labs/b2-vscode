/**
 * Filesystem-backed B2 transfer helpers.
 *
 * @module services/fileTransfers
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  BufferSource,
  type FileVersion,
  type LargeFileId,
  type ProgressListener,
  type UploadWriteHandle,
} from "@backblaze-labs/b2-sdk";
import { logError } from "../logger";
import { ensureRealDirectory, pathExistsAsRealDirectory } from "./pathSafety";

export const DEFAULT_TRANSFER_STALL_TIMEOUT_MS = 5 * 60 * 1000;
export const STREAMING_UPLOAD_PART_SIZE = 8 * 1024 * 1024;

const TRANSFER_TEMP_DIR_NAME = "b2-vscode-transfers";
const TRANSFER_TEMP_PREFIX = "b2-transfer-";
const TRANSFER_TEMP_SUFFIX = ".tmp";
const CROSS_DEVICE_MOVE_TEMP_PREFIX = ".b2-cross-device-";
const REPLACE_BACKUP_TEMP_PREFIX = ".b2-replace-backup-";
const STALE_TRANSFER_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const UNFINISHED_UPLOAD_CLEANUP_MAX_PAGES = 3;
const UNFINISHED_UPLOAD_CLEANUP_TIMEOUT_MS = 10_000;
const STALE_UNFINISHED_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UPLOAD_SESSION_STARTED_INFO_KEY = "b2-vscode-upload-started-ms";
const UPLOAD_SESSION_ID_INFO_KEY = "b2-vscode-upload-session-id";

const lastCleanupByDirectory = new Map<string, number>();

export class TransferStallTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferStallTimeoutError";
  }
}

export interface TransferTimeoutOptions {
  readonly signal?: AbortSignal;
  readonly stallTimeoutMs?: number;
}

export interface DownloadStreamToFileOptions extends TransferTimeoutOptions {
  readonly temporaryDirectory?: string;
  readonly overwrite?: boolean;
}

export interface UploadFileFromDiskOptions extends TransferTimeoutOptions {
  readonly onProgress?: ProgressListener;
  readonly partSize?: number;
  readonly unfinishedCleanupMaxPages?: number;
  readonly unfinishedCleanupTimeoutMs?: number;
  readonly unfinishedCleanupMaxAgeMs?: number;
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
  }): Promise<{
    files: readonly {
      fileId: LargeFileId;
      fileName: string;
      fileInfo?: Record<string, string>;
    }[];
    nextFileId: LargeFileId | null;
  }>;
  cancelLargeFile?(fileId: LargeFileId): Promise<unknown>;
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

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await ensureRealDirectory(directory, "Transfer temp directory", {
    recursive: true,
    mode: 0o700,
  });

  await fs.promises.chmod(directory, 0o700).catch((error) => {
    logError(`Could not set private permissions on transfer temp directory: ${directory}`, error);
  });
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
      if (stats.mtimeMs > cutoff) {
        continue;
      }

      const restorePath = backupDestinationPath(directory, entry);
      if (restorePath && !fs.existsSync(restorePath)) {
        await fs.promises.rename(filePath, restorePath);
      } else {
        await fs.promises.rm(filePath, { force: true });
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

async function replaceExistingDestination(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const backupPath = destinationReplaceBackupPath(destinationPath);
  try {
    await fs.promises.copyFile(destinationPath, backupPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    await removeTempFile(backupPath);
    throw error;
  }

  let destinationRemoved = false;
  try {
    await fs.promises.rm(destinationPath, { force: true });
    destinationRemoved = true;
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error) {
    if (destinationRemoved) {
      try {
        await fs.promises.rename(backupPath, destinationPath);
      } catch (restoreError) {
        logError(
          `Could not restore original destination after failed replace: ${destinationPath}`,
          restoreError,
        );
      }
    } else {
      await removeTempFile(backupPath);
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
    await ensurePrivateDirectory(temporaryDirectory);
    await cleanupTransferTempFilesForDownload(temporaryDirectory);

    const destinationDirectory = path.dirname(destinationPath);
    await fs.promises.mkdir(destinationDirectory, { recursive: true });
    await cleanupDestinationTempFilesForDownload(destinationDirectory);

    temporaryPath = transferTempPath(temporaryDirectory);
    const readable = Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
    readable.on("data", activity.markActivity);
    await pipeline(readable, fs.createWriteStream(temporaryPath, { flags: "wx" }), {
      signal: activity.signal,
    });

    const stats = await fs.promises.stat(temporaryPath);
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

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

interface StaleUnfinishedUploadCleanupOptions extends Pick<
  UploadFileFromDiskOptions,
  "unfinishedCleanupMaxAgeMs" | "unfinishedCleanupMaxPages" | "unfinishedCleanupTimeoutMs"
> {
  readonly remotePath?: string;
}

function startedMsFromFileInfo(fileInfo: Record<string, string> | undefined): number | undefined {
  const startedMs = Number(fileInfo?.[UPLOAD_SESSION_STARTED_INFO_KEY]);
  return Number.isFinite(startedMs) ? startedMs : undefined;
}

export async function cleanupStaleUnfinishedUploads(
  bucket: UploadBucketHandle,
  options: StaleUnfinishedUploadCleanupOptions = {},
): Promise<void> {
  if (!bucket.listUnfinishedLargeFiles || !bucket.cancelLargeFile) {
    return;
  }

  let startFileId: LargeFileId | undefined;
  let pagesScanned = 0;
  const maxPages = options.unfinishedCleanupMaxPages ?? UNFINISHED_UPLOAD_CLEANUP_MAX_PAGES;
  const timeoutMs = options.unfinishedCleanupTimeoutMs ?? UNFINISHED_UPLOAD_CLEANUP_TIMEOUT_MS;
  const cutoff =
    Date.now() - (options.unfinishedCleanupMaxAgeMs ?? STALE_UNFINISHED_UPLOAD_MAX_AGE_MS);
  do {
    if (pagesScanned >= maxPages) {
      throw new Error(`Unfinished upload cleanup exceeded ${maxPages} page(s).`);
    }

    const page = await withTimeout(
      bucket.listUnfinishedLargeFiles({
        ...(options.remotePath !== undefined ? { namePrefix: options.remotePath } : {}),
        pageSize: 100,
        ...(startFileId !== undefined ? { startFileId } : {}),
      }),
      timeoutMs,
      "Unfinished upload cleanup",
    );
    pagesScanned += 1;

    for (const file of page.files) {
      const startedMs = startedMsFromFileInfo(file.fileInfo);
      if (
        startedMs !== undefined &&
        startedMs <= cutoff &&
        (options.remotePath === undefined || file.fileName === options.remotePath)
      ) {
        await bucket.cancelLargeFile(file.fileId);
      }
    }

    startFileId = page.nextFileId ?? undefined;
  } while (startFileId !== undefined);
}

async function cleanupOwnedUnfinishedUpload(
  bucket: UploadBucketHandle,
  remotePath: string,
  uploadSessionId: string,
  options: Pick<
    UploadFileFromDiskOptions,
    "unfinishedCleanupMaxPages" | "unfinishedCleanupTimeoutMs"
  > = {},
): Promise<void> {
  if (!bucket.listUnfinishedLargeFiles || !bucket.cancelLargeFile) {
    return;
  }

  let startFileId: LargeFileId | undefined;
  let pagesScanned = 0;
  const maxPages = options.unfinishedCleanupMaxPages ?? UNFINISHED_UPLOAD_CLEANUP_MAX_PAGES;
  const timeoutMs = options.unfinishedCleanupTimeoutMs ?? UNFINISHED_UPLOAD_CLEANUP_TIMEOUT_MS;
  do {
    if (pagesScanned >= maxPages) {
      throw new Error(`Owned unfinished upload cleanup exceeded ${maxPages} page(s).`);
    }

    const page = await withTimeout(
      bucket.listUnfinishedLargeFiles({
        namePrefix: remotePath,
        pageSize: 100,
        ...(startFileId !== undefined ? { startFileId } : {}),
      }),
      timeoutMs,
      "Owned unfinished upload cleanup",
    );
    pagesScanned += 1;

    for (const file of page.files) {
      if (
        file.fileName === remotePath &&
        file.fileInfo?.[UPLOAD_SESSION_ID_INFO_KEY] === uploadSessionId
      ) {
        await bucket.cancelLargeFile(file.fileId);
      }
    }

    startFileId = page.nextFileId ?? undefined;
  } while (startFileId !== undefined);
}

export async function uploadFileFromDisk(
  bucket: UploadBucketHandle,
  localPath: string,
  remotePath: string,
  options: UploadFileFromDiskOptions = {},
): Promise<FileVersion> {
  const stats = await fs.promises.stat(localPath);

  if (stats.size === 0) {
    return bucket.upload({
      fileName: remotePath,
      source: new BufferSource(new Uint8Array(0)),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    });
  }

  await cleanupStaleUnfinishedUploads(bucket, { ...options, remotePath }).catch((cleanupError) => {
    logError(`Could not pre-clean unfinished upload for ${remotePath}`, cleanupError);
  });

  const activity = createActivityAbortSignal(
    options.signal,
    options.stallTimeoutMs ?? DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
    `Upload of ${localPath}`,
  );
  const uploadSessionId = crypto.randomUUID();
  const { writable, done } = bucket.file(remotePath).createWriteStream({
    partSize: options.partSize ?? STREAMING_UPLOAD_PART_SIZE,
    fileInfo: {
      [UPLOAD_SESSION_STARTED_INFO_KEY]: String(Date.now()),
      [UPLOAD_SESSION_ID_INFO_KEY]: uploadSessionId,
    },
    signal: activity.signal,
    onProgress: withActivityProgress(options.onProgress, activity.markActivity),
  });
  void done.catch(() => undefined);

  try {
    const readableStream = fs.createReadStream(localPath);
    readableStream.on("data", activity.markActivity);
    const readable = Readable.toWeb(readableStream) as ReadableStream<Uint8Array>;

    await readable.pipeTo(writable, { signal: activity.signal });
    return await done;
  } catch (error) {
    await cleanupOwnedUnfinishedUpload(bucket, remotePath, uploadSessionId, options).catch(
      (cleanupError) => {
        logError(`Could not clean up unfinished upload for ${remotePath}`, cleanupError);
      },
    );
    normalizeTransferError(error, activity);
  } finally {
    activity.dispose();
  }
}
