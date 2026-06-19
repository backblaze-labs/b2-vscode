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

export const DEFAULT_TRANSFER_STALL_TIMEOUT_MS = 5 * 60 * 1000;
export const STREAMING_UPLOAD_PART_SIZE = 8 * 1024 * 1024;

const TRANSFER_TEMP_DIR_NAME = "b2-vscode-transfers";
const TRANSFER_TEMP_PREFIX = "b2-transfer-";
const TRANSFER_TEMP_SUFFIX = ".tmp";
const STALE_TRANSFER_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
}

export interface UploadFileFromDiskOptions extends TransferTimeoutOptions {
  readonly onProgress?: ProgressListener;
  readonly partSize?: number;
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
      signal?: AbortSignal;
      onProgress?: ProgressListener;
    }): UploadWriteHandle;
  };
  listUnfinishedLargeFiles?(options?: {
    namePrefix?: string;
    startFileId?: LargeFileId;
    pageSize?: number;
  }): Promise<{
    files: readonly { fileId: LargeFileId; fileName: string }[];
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

function transferTempDirectory(directory?: string): string {
  return directory ?? path.join(os.tmpdir(), TRANSFER_TEMP_DIR_NAME);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
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

function isTransferTempFile(name: string): boolean {
  return name.startsWith(TRANSFER_TEMP_PREFIX) && name.endsWith(TRANSFER_TEMP_SUFFIX);
}

export async function cleanupStaleTransferTempFiles(
  options: { directory?: string; maxAgeMs?: number } = {},
): Promise<void> {
  const directory = transferTempDirectory(options.directory);
  const maxAgeMs = options.maxAgeMs ?? STALE_TRANSFER_TEMP_MAX_AGE_MS;

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

async function removeTempFile(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (error) {
    logError(`Could not remove transfer temp file: ${filePath}`, error);
  }
}

async function moveIntoPlace(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }

    await fs.promises.copyFile(sourcePath, destinationPath);
    await fs.promises.rm(sourcePath, { force: true });
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
    await cleanupStaleTransferTempFiles({ directory: temporaryDirectory });
    await ensurePrivateDirectory(temporaryDirectory);
    temporaryPath = transferTempPath(temporaryDirectory);

    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

    const readable = Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
    readable.on("data", activity.markActivity);
    await pipeline(readable, fs.createWriteStream(temporaryPath, { flags: "wx" }), {
      signal: activity.signal,
    });

    const stats = await fs.promises.stat(temporaryPath);
    await moveIntoPlace(temporaryPath, destinationPath);
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

async function cancelMatchingUnfinishedUploads(
  bucket: UploadBucketHandle,
  remotePath: string,
): Promise<void> {
  if (!bucket.listUnfinishedLargeFiles || !bucket.cancelLargeFile) {
    return;
  }

  let startFileId: LargeFileId | undefined;
  do {
    const page = await bucket.listUnfinishedLargeFiles({
      namePrefix: remotePath,
      ...(startFileId !== undefined ? { startFileId } : {}),
    });

    for (const file of page.files) {
      if (file.fileName === remotePath) {
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

  await cancelMatchingUnfinishedUploads(bucket, remotePath).catch((cleanupError) => {
    logError(`Could not pre-clean unfinished upload for ${remotePath}`, cleanupError);
  });

  const activity = createActivityAbortSignal(
    options.signal,
    options.stallTimeoutMs ?? DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
    `Upload of ${localPath}`,
  );
  const { writable, done } = bucket.file(remotePath).createWriteStream({
    partSize: options.partSize ?? STREAMING_UPLOAD_PART_SIZE,
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
    await cancelMatchingUnfinishedUploads(bucket, remotePath).catch((cleanupError) => {
      logError(`Could not clean up unfinished upload for ${remotePath}`, cleanupError);
    });
    normalizeTransferError(error, activity);
  } finally {
    activity.dispose();
  }
}
