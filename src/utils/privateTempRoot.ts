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
const PRIVATE_TEMP_ROOT_CLEANUP_BUDGET_MS = 2_000;
const PRIVATE_TEMP_ROOT_CLEANUP_MAX_ENTRIES = 2_000;

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

interface ChildActivityScanBudget {
  readonly deadlineMs: number;
  readonly maxEntries: number;
  scannedEntries: number;
  capHit: boolean;
}

async function hasRecentChildActivity(
  rootPath: string,
  cutoff: number,
  budget: ChildActivityScanBudget,
): Promise<boolean> {
  const pending = [rootPath];
  while (pending.length > 0) {
    if (Date.now() >= budget.deadlineMs || budget.scannedEntries >= budget.maxEntries) {
      budget.capHit = true;
      return true;
    }

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
      if (Date.now() >= budget.deadlineMs || budget.scannedEntries >= budget.maxEntries) {
        budget.capHit = true;
        return true;
      }

      const candidate = path.join(current, entry);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.lstat(candidate);
      } catch {
        continue;
      }
      budget.scannedEntries += 1;

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
  options: { maxAgeMs?: number; budgetMs?: number; maxEntries?: number } = {},
): Promise<void> {
  assertSimpleTempPrefix(prefix);

  const tempRoot = os.tmpdir();
  const entryPrefix = `${prefix}-`;
  const cutoff = Date.now() - (options.maxAgeMs ?? STALE_PRIVATE_TEMP_ROOT_MAX_AGE_MS);
  const scanBudget: ChildActivityScanBudget = {
    deadlineMs: Date.now() + Math.max(0, options.budgetMs ?? PRIVATE_TEMP_ROOT_CLEANUP_BUDGET_MS),
    maxEntries: Math.max(0, options.maxEntries ?? PRIVATE_TEMP_ROOT_CLEANUP_MAX_ENTRIES),
    scannedEntries: 0,
    capHit: false,
  };
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tempRoot);
  } catch {
    return;
  }

  const mkdtempEntryPattern = new RegExp(`^${escapeRegExp(entryPrefix)}[A-Za-z0-9]{6}$`);
  for (const entry of entries) {
    if (Date.now() >= scanBudget.deadlineMs || scanBudget.scannedEntries >= scanBudget.maxEntries) {
      scanBudget.capHit = true;
      break;
    }

    if (!mkdtempEntryPattern.test(entry)) {
      continue;
    }
    scanBudget.scannedEntries += 1;

    const candidate = path.join(tempRoot, entry);
    try {
      const stats = await fs.promises.lstat(candidate);
      if (stats.mtimeMs > cutoff) {
        continue;
      }
      if (
        stats.isDirectory() &&
        ((await hasLiveOwnerMarker(candidate, cutoff)) ||
          (await hasRecentChildActivity(candidate, cutoff, scanBudget)))
      ) {
        continue;
      }
      await fs.promises.rm(candidate, { recursive: true, force: true });
    } catch {
      // Best effort: another extension host may have already removed it.
    }
  }

  if (scanBudget.capHit) {
    void import("../logger")
      .then(({ log }) => {
        log(
          `Stale private temp-root cleanup stopped after scanning ${scanBudget.scannedEntries} entr${scanBudget.scannedEntries === 1 ? "y" : "ies"} because a cleanup cap was reached.`,
        );
      })
      .catch(() => undefined);
  }
}
