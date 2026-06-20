/**
 * Helpers for private temporary directories.
 *
 * @module utils/privateTempRoot
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const STALE_PRIVATE_TEMP_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRIVATE_TEMP_ROOT_OWNER_FILE = ".b2-vscode-owner.json";
const PRIVATE_TEMP_ROOT_HEARTBEAT_MS = 60 * 1000;

const privateTempRootHeartbeats = new Map<string, NodeJS.Timeout>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSimpleTempPrefix(prefix: string): void {
  if (!prefix || path.isAbsolute(prefix) || prefix.includes("/") || prefix.includes("\\")) {
    throw new Error("Temporary directory prefix must be a simple name.");
  }
}

function ownerMarkerPath(tempRoot: string): string {
  return path.join(tempRoot, PRIVATE_TEMP_ROOT_OWNER_FILE);
}

function writeOwnerMarkerSync(tempRoot: string): void {
  const marker = {
    pid: process.pid,
    createdAt: Date.now(),
  };
  fs.writeFileSync(ownerMarkerPath(tempRoot), JSON.stringify(marker), { mode: 0o600 });
}

function refreshOwnerMarker(tempRoot: string): void {
  const now = new Date();
  void fs.promises.utimes(ownerMarkerPath(tempRoot), now, now).catch(() => undefined);
}

function startOwnerHeartbeat(tempRoot: string): void {
  const resolvedRoot = path.resolve(tempRoot);
  if (privateTempRootHeartbeats.has(resolvedRoot)) {
    return;
  }

  const timer = setInterval(() => refreshOwnerMarker(resolvedRoot), PRIVATE_TEMP_ROOT_HEARTBEAT_MS);
  timer.unref?.();
  privateTempRootHeartbeats.set(resolvedRoot, timer);
}

export function createPrivateTempRoot(prefix: string): string {
  assertSimpleTempPrefix(prefix);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  try {
    fs.chmodSync(tempRoot, 0o700);
  } catch {
    // Best effort on filesystems where POSIX mode bits are unsupported.
  }
  writeOwnerMarkerSync(tempRoot);
  startOwnerHeartbeat(tempRoot);
  return tempRoot;
}

export function releasePrivateTempRoot(tempRoot: string): void {
  const resolvedRoot = path.resolve(tempRoot);
  const timer = privateTempRootHeartbeats.get(resolvedRoot);
  if (timer !== undefined) {
    clearInterval(timer);
    privateTempRootHeartbeats.delete(resolvedRoot);
  }
}

async function hasLiveOwnerMarker(tempRoot: string, cutoff: number): Promise<boolean> {
  const markerPath = ownerMarkerPath(tempRoot);
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(markerPath);
  } catch {
    return false;
  }

  if (!stats.isFile()) {
    return false;
  }
  if (stats.mtimeMs > cutoff) {
    return true;
  }

  return false;
}

async function hasRecentChildActivity(rootPath: string, cutoff: number): Promise<boolean> {
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }

    let entries: string[];
    try {
      entries = await fs.promises.readdir(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidate = path.join(current, entry);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.lstat(candidate);
      } catch {
        continue;
      }

      if (stats.mtimeMs > cutoff) {
        return true;
      }
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        pending.push(candidate);
      }
    }
  }

  return false;
}

export async function cleanupStalePrivateTempRoots(
  prefix: string,
  options: { maxAgeMs?: number } = {},
): Promise<void> {
  assertSimpleTempPrefix(prefix);

  const tempRoot = os.tmpdir();
  const entryPrefix = `${prefix}-`;
  const cutoff = Date.now() - (options.maxAgeMs ?? STALE_PRIVATE_TEMP_ROOT_MAX_AGE_MS);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tempRoot);
  } catch {
    return;
  }

  const mkdtempEntryPattern = new RegExp(`^${escapeRegExp(entryPrefix)}[A-Za-z0-9]{6}$`);
  for (const entry of entries) {
    if (!mkdtempEntryPattern.test(entry)) {
      continue;
    }

    const candidate = path.join(tempRoot, entry);
    try {
      const stats = await fs.promises.lstat(candidate);
      if (stats.mtimeMs > cutoff) {
        continue;
      }
      if (
        stats.isDirectory() &&
        ((await hasLiveOwnerMarker(candidate, cutoff)) ||
          (await hasRecentChildActivity(candidate, cutoff)))
      ) {
        continue;
      }
      await fs.promises.rm(candidate, { recursive: true, force: true });
    } catch {
      // Best effort: another extension host may have already removed it.
    }
  }
}
