/**
 * Helpers for private temporary directories.
 *
 * @module utils/privateTempRoot
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const STALE_PRIVATE_TEMP_ROOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSimpleTempPrefix(prefix: string): void {
  if (!prefix || path.isAbsolute(prefix) || prefix.includes("/") || prefix.includes("\\")) {
    throw new Error("Temporary directory prefix must be a simple name.");
  }
}

export function createPrivateTempRoot(prefix: string): string {
  assertSimpleTempPrefix(prefix);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  try {
    fs.chmodSync(tempRoot, 0o700);
  } catch {
    // Best effort on filesystems where POSIX mode bits are unsupported.
  }
  return tempRoot;
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
      if (stats.isDirectory() || stats.isSymbolicLink()) {
        await fs.promises.rm(candidate, { recursive: true, force: true });
      }
    } catch {
      // Best effort: another extension host may have already removed it.
    }
  }
}
