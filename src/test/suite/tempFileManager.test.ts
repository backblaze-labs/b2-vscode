/**
 * Tests for temporary download file caching.
 *
 * @module test/suite/tempFileManager
 */

import * as assert from "assert";
import * as fs from "fs";
import { TempFileManager } from "../../services/tempFileManager";

suite("TempFileManager", () => {
  test("saves downloaded files, returns cached paths, and clears cache on cleanup", async () => {
    const manager = new TempFileManager();

    try {
      manager.cleanup();

      const localPath = await manager.saveFile(
        "bucket",
        "nested/report.txt",
        Buffer.from("cached content"),
      );

      assert.strictEqual(manager.getCachedPath("bucket", "nested/report.txt"), localPath);
      assert.strictEqual(fs.readFileSync(localPath, "utf8"), "cached content");

      manager.cleanup();

      assert.strictEqual(manager.getCachedPath("bucket", "nested/report.txt"), undefined);
      assert.strictEqual(fs.existsSync(localPath), false);
    } finally {
      manager.dispose();
    }
  });
});
