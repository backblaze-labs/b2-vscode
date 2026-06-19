/**
 * Helpers for private temporary directories.
 *
 * @module utils/privateTempRoot
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
