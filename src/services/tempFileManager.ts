/**
 * Temporary file manager for downloaded B2 files.
 *
 * Downloads are cached locally so repeated opens don't re-fetch.
 * The temp directory is cleaned up on extension deactivation.
 *
 * @module services/tempFileManager
 */

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { TEMP_DIR_NAME } from "../constants";
import {
  downloadStreamToFile,
  TRANSFER_TEMP_DIR_NAME,
  type DownloadStreamToFileOptions,
} from "./fileTransfers";
import { log, logError } from "../logger";
import {
  ensurePrivateDirectorySync,
  isPathInsideOrEqual,
  pathExistsAsRealDirectory,
  prepareSafeFileWritePath,
  UnsafePathError,
} from "./pathSafety";
import { buildTempFilePath } from "../utils/localPaths";
import { createPrivateTempRoot, releasePrivateTempRoot } from "../utils/privateTempRoot";

const STALE_TEMP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_TEMP_CACHE_CLEANUP_BUDGET_MS = 2_000;
const STALE_TEMP_CACHE_CLEANUP_MAX_ENTRIES = 2_000;

interface StaleTempCacheCleanupOptions {
  readonly tempRoot?: string;
  readonly maxAgeMs?: number;
  readonly budgetMs?: number;
  readonly maxEntries?: number;
}

interface StaleTempCacheCleanupStats {
  scannedEntries: number;
  removedEntries: number;
  budgetHit: boolean;
  maxEntriesHit: boolean;
}

interface InFlightCacheEntry {
  readonly promise: Promise<string>;
}

function assertManagedTempRoot(tempRoot: string): void {
  const systemTemp = path.resolve(os.tmpdir());
  if (tempRoot === systemTemp || !isPathInsideOrEqual(systemTemp, tempRoot)) {
    throw new Error(
      `Temp file cache root must be a dedicated directory inside the system temp directory: ${tempRoot}`,
    );
  }
}

function assertNoPathTraversalSegments(value: string, label: string): void {
  if (value.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new UnsafePathError(`${label} must not contain path traversal segments.`);
  }
}

function cancelUnusedCacheStream(stream: ReadableStream<Uint8Array>): void {
  void stream.cancel().catch((error) => {
    logError("Could not cancel unused temp-cache download stream", error);
  });
}

function shouldStopCleanup(
  stats: StaleTempCacheCleanupStats,
  deadlineMs: number,
  maxEntries: number,
): boolean {
  if (stats.scannedEntries >= maxEntries) {
    stats.maxEntriesHit = true;
    return true;
  }
  if (Date.now() >= deadlineMs) {
    stats.budgetHit = true;
    return true;
  }
  return false;
}

async function removeStaleCacheEntries(
  directory: string,
  cutoffMs: number,
  deadlineMs: number,
  maxEntries: number,
  stats: StaleTempCacheCleanupStats,
): Promise<void> {
  if (shouldStopCleanup(stats, deadlineMs, maxEntries)) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (shouldStopCleanup(stats, deadlineMs, maxEntries)) {
      return;
    }

    const entryPath = path.join(directory, entry.name);
    let entryStats: fs.Stats;
    try {
      entryStats = await fs.promises.lstat(entryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    stats.scannedEntries += 1;

    if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
      await removeStaleCacheEntries(entryPath, cutoffMs, deadlineMs, maxEntries, stats);
      await fs.promises.rmdir(entryPath).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") {
          throw error;
        }
      });
      continue;
    }

    if (entryStats.mtimeMs <= cutoffMs) {
      await fs.promises.rm(entryPath, { recursive: true, force: true });
      stats.removedEntries += 1;
    }
  }
}

async function removeExistingCachePath(filePath: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    throw new Error(`Temp file cache path is a directory, not a cached file: ${filePath}`);
  }

  await fs.promises.rm(filePath, { force: true });
}

export async function cleanupStaleTempFileCache(
  options: StaleTempCacheCleanupOptions = {},
): Promise<void> {
  const tempRoot = path.resolve(options.tempRoot ?? path.join(os.tmpdir(), TEMP_DIR_NAME));
  assertManagedTempRoot(tempRoot);
  if (!(await pathExistsAsRealDirectory(tempRoot, "Temp file cache root"))) {
    return;
  }

  const maxAgeMs = options.maxAgeMs ?? STALE_TEMP_CACHE_MAX_AGE_MS;
  const cutoffMs = Date.now() - Math.max(0, maxAgeMs);
  const stats: StaleTempCacheCleanupStats = {
    scannedEntries: 0,
    removedEntries: 0,
    budgetHit: false,
    maxEntriesHit: false,
  };
  await removeStaleCacheEntries(
    tempRoot,
    cutoffMs,
    Date.now() + Math.max(0, options.budgetMs ?? STALE_TEMP_CACHE_CLEANUP_BUDGET_MS),
    options.maxEntries ?? STALE_TEMP_CACHE_CLEANUP_MAX_ENTRIES,
    stats,
  );
  if (stats.scannedEntries > 0 || stats.budgetHit || stats.maxEntriesHit) {
    log(
      `Stale temp file cache cleanup scanned ${stats.scannedEntries} entr${stats.scannedEntries === 1 ? "y" : "ies"}, removed ${stats.removedEntries}, budgetHit=${stats.budgetHit}, maxEntriesHit=${stats.maxEntriesHit}.`,
    );
  }
}

/**
 * Manages a temp directory for caching B2 file downloads.
 */
export class TempFileManager implements vscode.Disposable {
  private readonly tempRoot: string;
  private readonly cache = new Map<string, string>();
  private readonly inFlight = new Map<string, InFlightCacheEntry>();

  constructor(tempRoot = createPrivateTempRoot(TEMP_DIR_NAME)) {
    this.tempRoot = path.resolve(tempRoot);
    this.ensureManagedTempRoot();
    this.ensurePrivateTempRoot();
  }

  private ensureManagedTempRoot(): void {
    assertManagedTempRoot(this.tempRoot);
  }

  private ensurePrivateTempRoot(): void {
    ensurePrivateDirectorySync(this.tempRoot, "Temp file cache root", {
      recursive: true,
      mode: 0o700,
    });
  }

  dispose(): void {
    this.cleanup();
  }

  /**
   * Get the local path for a B2 file, returning cached path if available.
   */
  getCachedPath(bucketName: string, fileName: string): string | undefined {
    const key = `${bucketName}/${fileName}`;
    const cachedPath = this.cache.get(key);
    if (!cachedPath) {
      return undefined;
    }
    let cachedStats: fs.Stats;
    try {
      cachedStats = fs.lstatSync(cachedPath);
    } catch {
      this.cache.delete(key);
      return undefined;
    }
    if (!cachedStats.isFile()) {
      this.cache.delete(key);
      return undefined;
    }
    return cachedPath;
  }

  /**
   * Stream downloaded file content into the temp directory and cache the path.
   */
  async saveStream(
    bucketName: string,
    fileName: string,
    stream: ReadableStream<Uint8Array>,
    options: DownloadStreamToFileOptions = {},
  ): Promise<string> {
    const key = `${bucketName}/${fileName}`;
    const cachedPath = this.getCachedPath(bucketName, fileName);
    if (cachedPath) {
      cancelUnusedCacheStream(stream);
      return cachedPath;
    }

    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      cancelUnusedCacheStream(stream);
      return inFlight.promise;
    }

    const entry: InFlightCacheEntry = {
      promise: this.populateCache(bucketName, fileName, stream, options),
    };
    this.inFlight.set(key, entry);
    try {
      return await entry.promise;
    } finally {
      if (this.inFlight.get(key) === entry) {
        this.inFlight.delete(key);
      }
    }
  }

  private async populateCache(
    bucketName: string,
    fileName: string,
    stream: ReadableStream<Uint8Array>,
    options: DownloadStreamToFileOptions,
  ): Promise<string> {
    assertNoPathTraversalSegments(bucketName, "B2 bucket name");
    assertNoPathTraversalSegments(fileName, "B2 file name");
    const localPath = buildTempFilePath(this.tempRoot, bucketName, fileName);
    await prepareSafeFileWritePath(this.tempRoot, localPath, "Temp file cache path");
    await removeExistingCachePath(localPath);
    await prepareSafeFileWritePath(this.tempRoot, localPath, "Temp file cache path");

    await downloadStreamToFile(stream, localPath, {
      ...options,
      overwrite: false,
      allowedRootDirectory: this.tempRoot,
      temporaryDirectory: path.join(path.dirname(localPath), `.${TRANSFER_TEMP_DIR_NAME}`),
    });

    const key = `${bucketName}/${fileName}`;
    this.cache.set(key, localPath);

    return localPath;
  }

  /**
   * Remove the entire temp directory.
   */
  cleanup(): void {
    releasePrivateTempRoot(this.tempRoot);
    try {
      if (fs.existsSync(this.tempRoot)) {
        fs.rmSync(this.tempRoot, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup — ignore errors
    }
    this.cache.clear();
    this.inFlight.clear();
  }
}
