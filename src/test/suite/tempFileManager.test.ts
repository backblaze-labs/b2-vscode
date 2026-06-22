/**
 * Tests for temporary download file caching.
 *
 * @module test/suite/tempFileManager
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_DOWNLOAD_MAX_BYTES, DownloadSizeLimitError } from "../../services/fileTransfers";
import { cleanupStaleTempFileCache, TempFileManager } from "../../services/tempFileManager";
import { createDirectorySymlink } from "../../testSupport/symlinks";
import { streamFromText } from "../../testSupport/streams";
import { tempDir } from "../../testSupport/tempDir";

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

  test("does not let saveStream options overwrite live cached files", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);
    let canceled = false;

    try {
      const localPath = await manager.saveStream("bucket", "cached.txt", streamFromText("old"));
      const replacement = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });

      const cachedPath = await manager.saveStream("bucket", "cached.txt", replacement, {
        overwrite: true,
      });

      assert.strictEqual(cachedPath, localPath);
      assert.strictEqual(canceled, true);
      assert.strictEqual(fs.readFileSync(localPath, "utf8"), "old");
      assert.strictEqual(manager.getCachedPath("bucket", "cached.txt"), localPath);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("coalesces concurrent saveStream calls for the same B2 object", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);
    let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const firstStream = new ReadableStream<Uint8Array>({
      start(controller) {
        firstController = controller;
      },
    });
    let secondCanceled = false;
    let secondPulled = false;
    const secondStream = new ReadableStream<Uint8Array>({
      pull() {
        secondPulled = true;
      },
      cancel() {
        secondCanceled = true;
      },
    });

    try {
      const firstSave = manager.saveStream("bucket", "same.txt", firstStream);
      const secondSave = manager.saveStream("bucket", "same.txt", secondStream);

      firstController?.enqueue(Buffer.from("cached once"));
      firstController?.close();

      const [firstPath, secondPath] = await Promise.all([firstSave, secondSave]);

      assert.strictEqual(firstPath, secondPath);
      assert.strictEqual(secondCanceled, true);
      assert.strictEqual(secondPulled, false);
      assert.strictEqual(fs.readFileSync(firstPath, "utf8"), "cached once");
      assert.strictEqual(manager.getCachedPath("bucket", "same.txt"), firstPath);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("replaces stale on-disk cache files missing from memory", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);
    const localPath = path.join(tempRoot, "bucket", "cached.txt");

    try {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, "stale");

      const savedPath = await manager.saveStream("bucket", "cached.txt", streamFromText("fresh"));

      assert.strictEqual(savedPath, localPath);
      assert.strictEqual(fs.readFileSync(localPath, "utf8"), "fresh");
      assert.strictEqual(manager.getCachedPath("bucket", "cached.txt"), localPath);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("refuses stale cache directory collisions without deleting children", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);
    const directoryPath = path.join(tempRoot, "bucket", "folder");
    const childPath = path.join(directoryPath, "child.txt");

    try {
      fs.mkdirSync(directoryPath, { recursive: true });
      fs.writeFileSync(childPath, "keep");

      await assert.rejects(
        () => manager.saveStream("bucket", "folder", streamFromText("fresh")),
        /cache path is a directory/i,
      );

      assert.strictEqual(fs.readFileSync(childPath, "utf8"), "keep");
      assert.strictEqual(manager.getCachedPath("bucket", "folder"), undefined);
    } finally {
      manager.dispose();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("cleans stale temp cache files left by older sessions", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const staleFile = path.join(tempRoot, "bucket", "stale.txt");
    const freshFile = path.join(tempRoot, "bucket", "fresh.txt");
    const staleTime = new Date(Date.now() - 10_000);

    try {
      fs.mkdirSync(path.dirname(staleFile), { recursive: true });
      fs.writeFileSync(staleFile, "stale");
      fs.writeFileSync(freshFile, "fresh");
      fs.utimesSync(staleFile, staleTime, staleTime);

      await cleanupStaleTempFileCache({ tempRoot, maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(staleFile), false);
      assert.strictEqual(fs.readFileSync(freshFile, "utf8"), "fresh");
    } finally {
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

  test("does not apply the LM download byte cap to cached open-file streams", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const manager = new TempFileManager(tempRoot);

    try {
      const localPath = await manager.saveStream("bucket", "large.txt", streamFromText("cached"), {
        knownBytes: DEFAULT_DOWNLOAD_MAX_BYTES + 1,
      });

      assert.strictEqual(fs.readFileSync(localPath, "utf8"), "cached");
      assert.strictEqual(manager.getCachedPath("bucket", "large.txt"), localPath);
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

  test("rejects cache parent symlink swaps before final publish", async () => {
    const tempRoot = tempDir("b2-vscode-temp-manager-");
    const outsideRoot = tempDir("b2-vscode-temp-outside-");
    const manager = new TempFileManager(tempRoot);
    const symlinkPath = path.join(tempRoot, "bucket", "link");
    const outsideFile = path.join(outsideRoot, "escape.txt");
    const capabilityLink = path.join(tempRoot, "symlink-capability");
    const originalRealpath = fs.promises.realpath;
    const mutablePromises = fs.promises as unknown as { realpath: typeof fs.promises.realpath };
    let realpathChecks = 0;
    let symlinkInjected = false;

    mutablePromises.realpath = (async (...args: Parameters<typeof fs.promises.realpath>) => {
      if (path.resolve(String(args[0])) === path.resolve(symlinkPath)) {
        realpathChecks += 1;
      }
      if (!symlinkInjected && realpathChecks > 1) {
        fs.rmSync(symlinkPath, { recursive: true, force: true });
        symlinkInjected = createDirectorySymlink(outsideRoot, symlinkPath);
      }
      return originalRealpath(...args);
    }) as typeof fs.promises.realpath;

    try {
      if (!createDirectorySymlink(outsideRoot, capabilityLink)) {
        return;
      }
      fs.rmSync(capabilityLink, { recursive: true, force: true });

      await assert.rejects(
        () =>
          manager.saveStream("bucket", path.join("link", "escape.txt"), streamFromText("escape")),
        /Temp file cache directory|Workspace download directory|outside the allowed root|real directory|ENOENT|no such file/i,
      );
      assert.strictEqual(symlinkInjected, true);
      assert.strictEqual(fs.existsSync(outsideFile), false);
      assert.strictEqual(
        manager.getCachedPath("bucket", path.join("link", "escape.txt")),
        undefined,
      );
    } finally {
      mutablePromises.realpath = originalRealpath;
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
