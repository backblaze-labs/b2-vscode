/**
 * Tests for temporary download file caching.
 *
 * @module test/suite/tempFileManager
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TempFileManager } from "../../services/tempFileManager";

suite("TempFileManager", () => {
  test("saves downloaded files, returns cached paths, and clears cache on cleanup", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-temp-manager-"));
    const manager = new TempFileManager(tempRoot);

    try {
      const localPath = await manager.saveFile(
        "bucket",
        "nested/report.txt",
        Buffer.from("cached content"),
      );
      const relativeToTempRoot = path.relative(tempRoot, localPath);

      assert.strictEqual(manager.getCachedPath("bucket", "nested/report.txt"), localPath);
      assert.strictEqual(relativeToTempRoot.startsWith(".."), false);
      assert.strictEqual(path.isAbsolute(relativeToTempRoot), false);
      assert.strictEqual(fs.readFileSync(localPath, "utf8"), "cached content");

      manager.cleanup();

      assert.strictEqual(manager.getCachedPath("bucket", "nested/report.txt"), undefined);
      assert.strictEqual(fs.existsSync(localPath), false);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
