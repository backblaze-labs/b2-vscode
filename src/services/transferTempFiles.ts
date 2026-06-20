/**
 * Transfer temporary-file placement, cleanup, and destination moves.
 *
 * @module services/transferTempFiles
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logError } from "../logger";
import {
  ensurePrivateDirectory as ensurePrivateDirectoryPath,
  pathExistsAsRealDirectory,
} from "./pathSafety";

const TRANSFER_TEMP_DIR_NAME = "b2-vscode-transfers";
const TRANSFER_TEMP_PREFIX = "b2-transfer-";
const TRANSFER_TEMP_SUFFIX = ".tmp";
const CROSS_DEVICE_MOVE_TEMP_PREFIX = ".b2-cross-device-";
const REPLACE_BACKUP_TEMP_PREFIX = ".b2-replace-backup-";
const STALE_TRANSFER_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_CLEANUP_THROTTLE_ENTRIES = 256;

const lastCleanupByDirectory = new Map<string, number>();

export function transferTempDirectory(directory?: string): string {
  return directory ?? path.join(os.tmpdir(), TRANSFER_TEMP_DIR_NAME);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await ensurePrivateDirectoryPath(directory, "Transfer temp directory", {
    recursive: true,
    mode: 0o700,
  });
}

export function transferTempPath(directory: string): string {
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

function isCrossDeviceMoveTempFile(name: string): boolean {
  return name.startsWith(CROSS_DEVICE_MOVE_TEMP_PREFIX) && name.endsWith(TRANSFER_TEMP_SUFFIX);
}

function isReplaceBackupTempFile(name: string): boolean {
  return name.startsWith(REPLACE_BACKUP_TEMP_PREFIX) && name.endsWith(TRANSFER_TEMP_SUFFIX);
}

function isDestinationTempFile(name: string): boolean {
  return isCrossDeviceMoveTempFile(name) || isReplaceBackupTempFile(name);
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
    if (!isCrossDeviceMoveTempFile(entry)) {
      continue;
    }

    const filePath = path.join(directory, entry);
    try {
      const stats = await fs.promises.lstat(filePath);
      if (stats.mtimeMs > cutoff) {
        continue;
      }

      await fs.promises.rm(filePath, { force: true });
    } catch (error) {
      logError(`Could not clean stale destination temp file: ${filePath}`, error);
    }
  }
}

export async function cleanupTransferTempFilesForDownload(directory: string): Promise<void> {
  if (shouldRunThrottledCleanup(`transfer:${path.resolve(directory)}`)) {
    await cleanupStaleTransferTempFiles({ directory });
  }
}

export async function cleanupDestinationTempFilesForDownload(directory: string): Promise<void> {
  if (shouldRunThrottledCleanup(`destination:${path.resolve(directory)}`)) {
    await cleanupStaleDestinationTempFiles({ directory });
  }
}

export function assertDestinationFileNameIsNotReserved(destinationPath: string): void {
  const name = path.basename(destinationPath);
  if (isTransferTempFile(name) || isDestinationTempFile(name)) {
    throw new Error(`Destination filename uses a reserved B2 transfer temp pattern: ${name}`);
  }
}

export async function removeTempFile(filePath: string): Promise<void> {
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

export async function moveIntoPlace(
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
