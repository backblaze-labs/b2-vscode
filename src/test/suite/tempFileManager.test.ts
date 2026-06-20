/**
 * Tests for temporary download file caching.
 *
 * @module test/suite/tempFileManager
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { DownloadSizeLimitError } from "../../services/fileTransfers";
import { TempFileManager } from "../../services/tempFileManager";
import { streamFromText } from "../../testSupport/streams";
import { tempDir } from "../../testSupport/tempDir";

function createDirectorySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "ENOTSUP" || code === "EPERM") {
      return false;
    }
    throw error;
  }
}

suite("TempFileManager", () => {
  test("saves downloaded streams, returns cached paths, and clears cache on cleanup", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);

    try {
      const localPath = await manager.saveStream(
        "bucket",
        "nested/report.txt",
        streamFromText("cached content"),
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

  test("drops cached paths when the cached file is gone", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);

    try {
      const localPath = await manager.saveStream("bucket", "old.txt", streamFromText("old"));
      assert.strictEqual(manager.getCachedPath("bucket", "old.txt"), localPath);

      fs.rmSync(localPath, { force: true });

      assert.strictEqual(manager.getCachedPath("bucket", "old.txt"), undefined);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects oversized cached downloads without caching partial files", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);

    try {
      await assert.rejects(
        () =>
          manager.saveStream("bucket", "large.txt", streamFromText("too large"), {
            maxBytes: 3,
          }),
        DownloadSizeLimitError,
      );

      assert.strictEqual(manager.getCachedPath("bucket", "large.txt"), undefined);
      assert.strictEqual(fs.existsSync(path.join(tempRoot, "bucket", "large.txt")), false);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects bucket and file names that escape the cache root", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);
    const traversalCases = [
      { bucketName: "bucket", fileName: "../../escape.txt" },
      { bucketName: "../escape-bucket", fileName: "file.txt" },
    ];

    try {
      for (const { bucketName, fileName } of traversalCases) {
        const escapePath = path.resolve(tempRoot, bucketName, fileName);

        await assert.rejects(
          () => manager.saveStream(bucketName, fileName, streamFromText("escape")),
          /B2 .* must not contain path traversal segments/i,
        );
        assert.strictEqual(fs.existsSync(escapePath), false);
      }
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("rejects cache writes through symlinked parents", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const outsideRoot = tempDir("b2-vscode-temp-outside-");
    const manager = new TempFileManager(tempRoot);
    const bucketRoot = path.join(tempRoot, "bucket");
    const symlinkPath = path.join(bucketRoot, "link");
    const escapePath = path.join(outsideRoot, "escape.txt");

    try {
      fs.mkdirSync(bucketRoot, { recursive: true });
      if (!createDirectorySymlink(outsideRoot, symlinkPath)) {
        return;
      }

      await assert.rejects(
        () =>
          manager.saveStream("bucket", path.join("link", "escape.txt"), streamFromText("escape")),
        /Temp file cache directory must be a real directory/i,
      );
      assert.strictEqual(fs.existsSync(escapePath), false);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("rejects symlinked parents introduced during directory creation", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const outsideRoot = tempDir("b2-vscode-temp-outside-");
    const manager = new TempFileManager(tempRoot);
    const symlinkPath = path.join(tempRoot, "bucket", "new", "link");
    const outsideSubdir = path.join(outsideRoot, "sub");
    const capabilityLink = path.join(tempRoot, "symlink-capability");
    const originalMkdir = fs.promises.mkdir;
    const mutablePromises = fs.promises as unknown as { mkdir: typeof fs.promises.mkdir };
    let symlinkInjected = false;

    mutablePromises.mkdir = (async (...args: Parameters<typeof fs.promises.mkdir>) => {
      const targetPath = path.resolve(String(args[0]));
      if (!symlinkInjected && targetPath === symlinkPath) {
        symlinkInjected = true;
        createDirectorySymlink(outsideRoot, symlinkPath);
      }
      return originalMkdir(...args);
    }) as typeof fs.promises.mkdir;

    try {
      if (!createDirectorySymlink(outsideRoot, capabilityLink)) {
        return;
      }
      fs.rmSync(capabilityLink, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });

      await assert.rejects(
        () =>
          manager.saveStream(
            "bucket",
            path.join("new", "link", "sub", "escape.txt"),
            streamFromText("escape"),
          ),
        /EEXIST|real directory|outside the allowed root/i,
      );
      assert.strictEqual(symlinkInjected, true);
      assert.strictEqual(fs.existsSync(outsideSubdir), false);
    } finally {
      mutablePromises.mkdir = originalMkdir;
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("rejects cache parent symlink swaps before the final move", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const outsideRoot = tempDir("b2-vscode-temp-outside-");
    const manager = new TempFileManager(tempRoot);
    const symlinkPath = path.join(tempRoot, "bucket", "link");
    const outsideFile = path.join(outsideRoot, "escape.txt");
    const capabilityLink = path.join(tempRoot, "symlink-capability");
    const originalMkdir = fs.promises.mkdir;
    const mutablePromises = fs.promises as unknown as { mkdir: typeof fs.promises.mkdir };
    let symlinkInjected = false;
    let targetMkdirCalls = 0;

    mutablePromises.mkdir = (async (...args: Parameters<typeof fs.promises.mkdir>) => {
      const result = await originalMkdir(...args);
      const targetPath = path.resolve(String(args[0]));
      if (targetPath === symlinkPath) {
        targetMkdirCalls += 1;
      }
      if (!symlinkInjected && targetPath === symlinkPath && targetMkdirCalls === 2) {
        fs.rmSync(symlinkPath, { recursive: true, force: true });
        symlinkInjected = createDirectorySymlink(outsideRoot, symlinkPath);
      }
      return result;
    }) as typeof fs.promises.mkdir;

    try {
      if (!createDirectorySymlink(outsideRoot, capabilityLink)) {
        return;
      }
      fs.rmSync(capabilityLink, { recursive: true, force: true });

      await assert.rejects(
        () =>
          manager.saveStream("bucket", path.join("link", "escape.txt"), streamFromText("escape")),
        /Destination directory.*real directory|outside the allowed root/i,
      );
      assert.strictEqual(symlinkInjected, true);
      assert.strictEqual(fs.existsSync(outsideFile), false);
      assert.strictEqual(
        manager.getCachedPath("bucket", path.join("link", "escape.txt")),
        undefined,
      );
    } finally {
      mutablePromises.mkdir = originalMkdir;
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked cache root", () => {
    const tempParent = tempDir("b2-vscode-temp-parent-");
    const outsideRoot = tempDir("b2-vscode-temp-outside-");
    const symlinkRoot = path.join(tempParent, "b2-vscode");

    try {
      if (!createDirectorySymlink(outsideRoot, symlinkRoot)) {
        return;
      }

      assert.throws(
        () => new TempFileManager(symlinkRoot),
        /Temp file cache root must be a real directory/i,
      );
    } finally {
      fs.rmSync(tempParent, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
