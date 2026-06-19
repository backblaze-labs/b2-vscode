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
import { resolveContainedRelativePath } from "./pathSafety";

/**
 * Manages a temp directory for caching B2 file downloads.
 */
export class TempFileManager implements vscode.Disposable {
  private readonly tempRoot: string;
  private readonly cache = new Map<string, string>();

  constructor(tempRoot = path.join(os.tmpdir(), TEMP_DIR_NAME)) {
    this.tempRoot = tempRoot;
    this.ensurePrivateTempRoot();
  }

  private ensurePrivateTempRoot(): void {
    let stats: fs.Stats | undefined;
    try {
      stats = fs.lstatSync(this.tempRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (stats) {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Temp file cache root must be a real directory, not a symlink or special file: ${this.tempRoot}`,
        );
      }
    } else {
      fs.mkdirSync(this.tempRoot, { recursive: true, mode: 0o700 });
      const createdStats = fs.lstatSync(this.tempRoot);
      if (createdStats.isSymbolicLink() || !createdStats.isDirectory()) {
        throw new Error(
          `Temp file cache root must be a real directory, not a symlink or special file: ${this.tempRoot}`,
        );
      }
    }

    try {
      fs.chmodSync(this.tempRoot, 0o700);
    } catch {
      // Best effort: existing directories may not allow chmod on every platform.
    }
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
