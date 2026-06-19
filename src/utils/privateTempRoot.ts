/**
 * Helpers for private temporary directories.
 *
 * @module utils/privateTempRoot
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function createPrivateTempRoot(prefix: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  fs.chmodSync(tempRoot, 0o700);
  return tempRoot;
}
