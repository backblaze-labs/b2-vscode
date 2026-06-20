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
import { downloadStreamToFile, type DownloadStreamToFileOptions } from "./fileTransfers";
import { log } from "../logger";
import {
  ensureContainedDirectoryPath,
  ensureRealDirectorySync,
  isPathInsideOrEqual,
  pathExistsAsRealDirectory,
  resolveContainedRelativePath,
} from "./pathSafety";

const STALE_TEMP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_TEMP_CACHE_CLEANUP_BUDGET_MS = 2_000;
const STALE_TEMP_CACHE_CLEANUP_MAX_ENTRIES = 2_000;

function defaultTempRoot(): string {
  return path.join(os.tmpdir(), TEMP_DIR_NAME);
}

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

function assertManagedTempRoot(tempRoot: string): void {
  const systemTemp = path.resolve(os.tmpdir());
  if (tempRoot === systemTemp || !isPathInsideOrEqual(systemTemp, tempRoot)) {
    throw new Error(
      `Temp file cache root must be a dedicated directory inside the system temp directory: ${tempRoot}`,
    );
  }
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
  const tempRoot = path.resolve(options.tempRoot ?? defaultTempRoot());
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

  constructor(tempRoot = defaultTempRoot()) {
    this.tempRoot = path.resolve(tempRoot);
    this.ensureManagedTempRoot();
    this.ensurePrivateTempRoot();
  }

  private ensureManagedTempRoot(): void {
    assertManagedTempRoot(this.tempRoot);
  }

  private ensurePrivateTempRoot(): void {
    ensureRealDirectorySync(this.tempRoot, "Temp file cache root", {
      recursive: true,
      mode: 0o700,
    });

    try {
      fs.chmodSync(this.tempRoot, 0o700);
    } catch {
      // Best effort: existing directories may not allow chmod on every platform.
    }
  }

  private async ensureCacheDirectoryPath(directory: string): Promise<void> {
    await ensureContainedDirectoryPath(this.tempRoot, directory, "Temp file cache directory", {
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
    if (!fs.existsSync(cachedPath)) {
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
      await stream.cancel().catch(() => undefined);
      return cachedPath;
    }

    const bucketRoot = resolveContainedRelativePath(this.tempRoot, bucketName, "B2 bucket name");
    const localPath = resolveContainedRelativePath(bucketRoot, fileName, "B2 file name");
    await this.ensureCacheDirectoryPath(path.dirname(localPath));
    await removeExistingCachePath(localPath);

    await downloadStreamToFile(stream, localPath, {
      ...options,
      overwrite: false,
      allowedRootDirectory: this.tempRoot,
    });

    this.cache.set(key, localPath);

    return localPath;
  }

  /**
   * Remove the entire temp directory.
   */
  cleanup(): void {
    try {
      if (fs.existsSync(this.tempRoot)) {
        fs.rmSync(this.tempRoot, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup — ignore errors
    }
    this.cache.clear();
  }
}
