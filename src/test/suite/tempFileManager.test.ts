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

  test("rejects bucket and file names that escape the cache root", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-temp-manager-"));
    const manager = new TempFileManager(tempRoot);
    const traversalCases = [
      { bucketName: "bucket", fileName: "../../escape.txt" },
      { bucketName: "../escape-bucket", fileName: "file.txt" },
    ];

    try {
      for (const { bucketName, fileName } of traversalCases) {
        const escapePath = path.resolve(tempRoot, bucketName, fileName);

        await assert.rejects(
          () => manager.saveFile(bucketName, fileName, Buffer.from("escape")),
          /B2 object path must stay within the temp cache/i,
        );
        assert.strictEqual(fs.existsSync(escapePath), false);
      }
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects cache writes through symlinked parents", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-temp-manager-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-temp-outside-"));
    const manager = new TempFileManager(tempRoot);
    const bucketRoot = path.join(tempRoot, "bucket");
    const symlinkPath = path.join(bucketRoot, "link");
    const escapePath = path.join(outsideRoot, "escape.txt");

    try {
      fs.mkdirSync(bucketRoot, { recursive: true });
      fs.symlinkSync(outsideRoot, symlinkPath, process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        () => manager.saveFile("bucket", path.join("link", "escape.txt"), Buffer.from("escape")),
        /B2 object path must stay within the temp cache/i,
      );
      assert.strictEqual(fs.existsSync(escapePath), false);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
