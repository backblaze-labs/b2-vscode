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
import {
  ensureContainedDirectoryPath,
  ensureRealDirectorySync,
  isPathInsideOrEqual,
  pathExistsAsRealDirectory,
  resolveContainedRelativePath,
} from "./pathSafety";

const STALE_TEMP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function assertManagedTempRoot(tempRoot: string): void {
  const systemTemp = path.resolve(os.tmpdir());
  if (tempRoot === systemTemp || !isPathInsideOrEqual(systemTemp, tempRoot)) {
    throw new Error(
      `Temp file cache root must be a dedicated directory inside the system temp directory: ${tempRoot}`,
    );
  }
}

async function removeStaleCacheEntries(directory: string, cutoffMs: number): Promise<void> {
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
    const entryPath = path.join(directory, entry.name);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(entryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      await removeStaleCacheEntries(entryPath, cutoffMs);
      await fs.promises.rmdir(entryPath).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") {
          throw error;
        }
      });
      continue;
    }

    if (stats.mtimeMs <= cutoffMs) {
      await fs.promises.rm(entryPath, { recursive: true, force: true });
    }
  }
}

export async function cleanupStaleTempFileCache(
  options: { readonly tempRoot?: string; readonly maxAgeMs?: number } = {},
): Promise<void> {
  const tempRoot = path.resolve(options.tempRoot ?? path.join(os.tmpdir(), TEMP_DIR_NAME));
  assertManagedTempRoot(tempRoot);
  if (!(await pathExistsAsRealDirectory(tempRoot, "Temp file cache root"))) {
    return;
  }

  const maxAgeMs = options.maxAgeMs ?? STALE_TEMP_CACHE_MAX_AGE_MS;
  const cutoffMs = Date.now() - Math.max(0, maxAgeMs);
  await removeStaleCacheEntries(tempRoot, cutoffMs);
}

/**
 * Manages a temp directory for caching B2 file downloads.
 */
export class TempFileManager implements vscode.Disposable {
  private readonly tempRoot: string;
  private readonly cache = new Map<string, string>();

  constructor(tempRoot = path.join(os.tmpdir(), TEMP_DIR_NAME)) {
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
    return this.cache.get(key);
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
    const bucketRoot = resolveContainedRelativePath(this.tempRoot, bucketName, "B2 bucket name");
    const localPath = resolveContainedRelativePath(bucketRoot, fileName, "B2 file name");
    await this.ensureCacheDirectoryPath(path.dirname(localPath));

    await downloadStreamToFile(stream, localPath, options);

    const key = `${bucketName}/${fileName}`;
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
