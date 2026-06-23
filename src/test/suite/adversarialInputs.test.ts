/**
 * Adversarial input fuzz coverage for B2 object names and tool parameters.
 *
 * @module test/suite/adversarialInputs
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as fc from "fast-check";
import {
  SSE_NONE,
  accountId,
  bucketId,
  fileId,
  type B2Client,
  type Bucket,
  type FileVersion,
} from "@backblaze-labs/b2-sdk";
import { TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME } from "../../constants";
import { FileTreeItem } from "../../models/fileTreeItem";
import { FolderTreeItem } from "../../models/folderTreeItem";
import { TempFileManager } from "../../services/tempFileManager";
import { encodeUrlComponent as encodeSharedUrlComponent } from "../../utils/urlEncoding";
import { presignUrlOperation } from "../../tools/operations/presignUrl";
import { deleteFileOperation } from "../../tools/operations/deleteFile";
import { downloadFileOperation } from "../../tools/operations/downloadFile";
import { getFileInfoOperation } from "../../tools/operations/getFileInfo";
import { listFilesOperation } from "../../tools/operations/listFiles";
import { uploadFileOperation } from "../../tools/operations/uploadFile";
import { MAX_PRESIGN_URL_EXPIRES_IN_SECONDS } from "../../tools/presignUrlLimits";
import {
  resolveWorkspaceRelativePath,
  resolveToolLocalPath,
  resolveToolLocalPathDetails,
  safeDefaultDownloadName,
} from "../../tools/localPaths";
import {
  encodeUrlComponent,
  encodeUrlPathSegment,
  ensureToolPrivateDirectory,
  isToolPathInside,
  readFileNoFollow,
  sanitizeToolLocalPathSegment,
  sweepStaleAtomicTempFiles,
  toWellFormedUnicode,
  writeBufferAtomically,
  writeReadableStreamAtomically,
} from "../../toolPathSafety";
import type { ToolExtras } from "../../tools/types";
import { withWorkspaceFolder } from "../../testSupport/workspace";

const FUZZ_RUNS = 80;
const ASYNC_FUZZ_RUNS = 40;
const TOOL_OPERATION_FUZZ_RUNS = 25;
const DOWNLOAD_BASE_URL = "https://download.example.com";

const hostileConstants = fc.constantFrom(
  "",
  ".",
  "..",
  "/",
  "\\",
  "../escape.txt",
  "..\\escape.txt",
  "/absolute/path.txt",
  " leading and trailing ",
  "query?x=1&Authorization=bad",
  "fragment#section",
  "line\nbreak",
  "carriage\rreturn",
  "tab\tname",
  "null\0byte",
  "unicode/雪/δοκιμή/archivo.txt",
  "emoji/😀/file.txt",
  "percent%2Fencoded",
  "x".repeat(4096),
);

const hostileString = fc.oneof(
  fc.string({ maxLength: 256 }),
  hostileConstants,
  fc.array(hostileConstants, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/")),
);

const hostilePath = fc.oneof(
  hostileString,
  fc.array(hostileString, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/")),
);

const validExpiresIn = fc.oneof(
  fc.constantFrom(1, 60, 3600, MAX_PRESIGN_URL_EXPIRES_IN_SECONDS),
  fc.integer({ min: 1, max: MAX_PRESIGN_URL_EXPIRES_IN_SECONDS }),
);

const invalidExpiresIn = fc.oneof(
  fc.constantFrom(
    -1,
    0,
    0.5,
    1.25,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_PRESIGN_URL_EXPIRES_IN_SECONDS + 1,
  ),
  fc.integer({ min: -1000000, max: 0 }),
  fc.integer({ min: MAX_PRESIGN_URL_EXPIRES_IN_SECONDS + 1, max: Number.MAX_SAFE_INTEGER }),
);

function file(fileName: string): FileVersion {
  return {
    accountId: accountId("account-id"),
    fileName,
    action: "upload",
    bucketId: bucketId("bucket-id"),
    contentLength: 12,
    contentMd5: null,
    contentSha1: null,
    contentType: "text/plain",
    fileId: fileId("file-id"),
    fileInfo: {},
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    replicationStatus: null,
    serverSideEncryption: SSE_NONE,
    uploadTimestamp: 0,
  };
}

function bucket(name = "bucket"): Bucket {
  return {
    id: "bucket-id",
    name,
    info: { bucketType: "allPrivate" },
  } as unknown as Bucket;
}

function realPathForContainment(candidatePath: string): string {
  const missingSegments: string[] = [];
  let current = path.resolve(candidatePath);

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(candidatePath);
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }

  return path.join(fs.realpathSync.native(current), ...missingSegments);
}

function assertInside(parentPath: string, candidatePath: string): void {
  const parent = realPathForContainment(parentPath);
  const candidate = realPathForContainment(candidatePath);
  assert.ok(isToolPathInside(parent, candidate), `${candidatePath} should remain under ${parent}`);
}

function tempRootFor(manager: TempFileManager): string {
  return (manager as unknown as { readonly tempRoot: string }).tempRoot;
}

function hasUrlDotSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === "." || segment === "..");
}

function isInvalidB2ObjectNameInput(value: string): boolean {
  return !value || /\p{Cc}/u.test(value) || value.endsWith("/");
}

function hasPathTraversalSegment(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment === "..");
}

function presignExtras(authorizationToken: string): ToolExtras {
  const testBucket = {
    async listFileNames(options: { prefix: string; pageSize: number }) {
      assert.strictEqual(options.pageSize, 2);
      return { files: [file(options.prefix)], nextFileName: null };
    },
    async getDownloadAuthorization(fileNamePrefix: string, validDurationInSeconds: number) {
      assert.ok(validDurationInSeconds >= 1);
      assert.ok(validDurationInSeconds <= MAX_PRESIGN_URL_EXPIRES_IN_SECONDS);
      return { authorizationToken, fileNamePrefix, validDurationInSeconds };
    },
  } as unknown as Bucket;
  const client = {
    accountInfo: { getDownloadUrl: () => DOWNLOAD_BASE_URL },
    async getBucket() {
      return testBucket;
    },
  } as unknown as B2Client;

  return { getClient: () => client };
}

function presignExtrasThatFailsBeforeSdkCalls(): ToolExtras {
  const client = {
    accountInfo: { getDownloadUrl: () => DOWNLOAD_BASE_URL },
    async getBucket() {
      assert.fail("Expected expiresIn validation before B2 SDK calls");
    },
  } as unknown as B2Client;

  return { getClient: () => client };
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function operationExtras(bucketName: string, fileName: string): ToolExtras {
  const testBucket = {
    async getFileInfoByName(requestedPath: string) {
      assert.strictEqual(requestedPath, fileName);
      return file(fileName);
    },
    async deleteFileVersion(requestedPath: string) {
      assert.strictEqual(requestedPath, fileName);
    },
    async listFileNames(options: { prefix?: string; startFileName?: string }) {
      assert.strictEqual(options.prefix, fileName);
      assert.strictEqual(options.startFileName, fileName || undefined);
      return { files: [file(fileName)], nextFileName: null };
    },
    async download(requestedPath: string) {
      assert.strictEqual(requestedPath, fileName);
      return { body: streamFromBytes(new Uint8Array([1, 2, 3])) };
    },
  } as unknown as Bucket;
  const client = {
    async getBucket(requestedBucket: string) {
      assert.strictEqual(requestedBucket, bucketName);
      return testBucket;
    },
  } as unknown as B2Client;

  return { getClient: () => client };
}

suite("Adversarial untrusted input fuzzing", () => {
  test("tree items tolerate hostile object names without resource URI injection", () => {
    fc.assert(
      fc.property(hostilePath, (fileName) => {
        const item = new FileTreeItem(bucket(), file(fileName));
        assert.strictEqual(item.resourceUri?.scheme, "b2");
        assert.strictEqual(item.resourceUri?.authority, "bucket");
        assert.strictEqual(item.resourceUri?.query, "");
        assert.strictEqual(item.resourceUri?.fragment, "");

        const folder = new FolderTreeItem(bucket(), fileName);
        assert.strictEqual(folder.bucketName, "bucket");
      }),
      { numRuns: FUZZ_RUNS },
    );
  });

  test("temp file cache never writes outside the extension cache root", async () => {
    await fc.assert(
      fc.asyncProperty(hostileString, hostilePath, async (bucketName, fileName) => {
        const manager = new TempFileManager();
        try {
          if (hasPathTraversalSegment(bucketName) || hasPathTraversalSegment(fileName)) {
            await assert.rejects(
              () => manager.saveStream(bucketName, fileName, streamFromBytes(Buffer.from("ok"))),
              /path traversal/i,
            );
            return;
          }

          const tempRoot = tempRootFor(manager);
          const savedPath = await manager.saveStream(
            bucketName,
            fileName,
            streamFromBytes(Buffer.from("ok")),
          );
          assertInside(tempRoot, savedPath);
          assert.strictEqual(await fs.promises.readFile(savedPath, "utf8"), "ok");
          assert.strictEqual(manager.getCachedPath(bucketName, fileName), savedPath);
        } finally {
          manager.cleanup();
        }
      }),
      { numRuns: ASYNC_FUZZ_RUNS },
    );
  });

  test("temp cache handles dot-only and padded dot segments as files under temp root", async () => {
    const dotNames = [" . ", " .. ", ".", ".."];
    const manager = new TempFileManager();
    const tempRoot = tempRootFor(manager);

    try {
      for (const name of dotNames) {
        if (name === "..") {
          await assert.rejects(
            () => manager.saveStream(name, name, streamFromBytes(Buffer.from(name))),
            /path traversal/i,
          );
          continue;
        }

        const savedPath = await manager.saveStream(name, name, streamFromBytes(Buffer.from(name)));
        assertInside(tempRoot, savedPath);
        assert.strictEqual((await fs.promises.stat(savedPath)).isFile(), true);
        assert.notStrictEqual(path.basename(savedPath), ".");
        assert.notStrictEqual(path.basename(savedPath), "..");

        const normalPath = await manager.saveStream(
          name,
          "normal.txt",
          streamFromBytes(Buffer.from("normal")),
        );
        assertInside(tempRoot, normalPath);
        assert.strictEqual(await fs.promises.readFile(normalPath, "utf8"), "normal");
      }
    } finally {
      manager.cleanup();
    }
  });

  test("temp cache sanitized filenames preserve extensions after truncation", async () => {
    const manager = new TempFileManager();
    const tempRoot = tempRootFor(manager);

    try {
      const savedPath = await manager.saveStream(
        "bucket",
        `${"x".repeat(300)}.xlsx`,
        streamFromBytes(Buffer.from("ok")),
      );
      assertInside(tempRoot, savedPath);
      assert.match(path.basename(savedPath), /\.xlsx$/);
      assert.strictEqual(await fs.promises.readFile(savedPath, "utf8"), "ok");
    } finally {
      manager.cleanup();
    }
  });

  test("sanitized temp and default download names strip trailing dots", async () => {
    const manager = new TempFileManager();
    const tempRoot = tempRootFor(manager);

    try {
      const defaultName = safeDefaultDownloadName("folder/file.");
      assert.ok(defaultName.length > 0);
      assert.strictEqual(defaultName.endsWith("."), false);

      const savedPath = await manager.saveStream(
        "bucket.",
        "file.",
        streamFromBytes(Buffer.from("ok")),
      );
      assertInside(tempRoot, savedPath);
      const relativeSegments = path
        .relative(realPathForContainment(tempRoot), realPathForContainment(savedPath))
        .split(path.sep);
      assert.ok(relativeSegments.every((segment) => !segment.endsWith(".")));
      assert.strictEqual(await fs.promises.readFile(savedPath, "utf8"), "ok");
    } finally {
      manager.cleanup();
    }
  });

  test("temp cache root is private before writing B2 bytes", async () => {
    if (process.platform === "win32") {
      return;
    }

    const manager = new TempFileManager();
    const tempRoot = tempRootFor(manager);

    try {
      const savedPath = await manager.saveStream(
        "bucket",
        "secret.txt",
        streamFromBytes(Buffer.from("secret")),
      );
      const rootMode = (await fs.promises.stat(tempRoot)).mode & 0o077;

      assert.strictEqual(rootMode, 0);
      assertInside(tempRoot, savedPath);
      assert.strictEqual(await fs.promises.readFile(savedPath, "utf8"), "secret");
    } finally {
      manager.cleanup();
    }
  });

  test("temp cache cleanup does not remove extension tool outputs", async () => {
    const toolRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    await ensureToolPrivateDirectory(toolRoot);
    const toolOutputDir = await fs.promises.mkdtemp(path.join(toolRoot, "persist-"));
    const toolOutput = path.join(toolOutputDir, "output.txt");
    const manager = new TempFileManager();

    try {
      await fs.promises.writeFile(toolOutput, "tool output");
      const cachePath = await manager.saveStream(
        "bucket",
        "file.txt",
        streamFromBytes(Buffer.from("cache")),
      );

      manager.cleanup();

      assert.strictEqual(fs.existsSync(cachePath), false);
      assert.strictEqual(await fs.promises.readFile(toolOutput, "utf8"), "tool output");
    } finally {
      manager.cleanup();
      await fs.promises.rm(toolOutputDir, { recursive: true, force: true });
    }
  });

  test("private directory validation errors use safe local codes", async () => {
    if (process.platform === "win32") {
      return;
    }

    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-private-"));
    const targetDir = path.join(outputRoot, "target");
    const linkPath = path.join(outputRoot, "cache-link");

    try {
      await fs.promises.mkdir(targetDir);
      await fs.promises.symlink(targetDir, linkPath, "dir");

      await assert.rejects(
        () => ensureToolPrivateDirectory(linkPath),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("must be a directory") &&
          (error as NodeJS.ErrnoException).code === "ENOTDIR",
      );
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("concurrent temp cache writes cannot expose a torn file", async () => {
    const manager = new TempFileManager();
    const first = Buffer.alloc(256 * 1024, "a");
    const second = Buffer.alloc(256 * 1024, "b");

    try {
      const [firstPath, secondPath] = await Promise.all([
        manager.saveStream("bucket", "same.txt", streamFromBytes(first)),
        manager.saveStream("bucket", "same.txt", streamFromBytes(second)),
      ]);
      assert.strictEqual(firstPath, secondPath);

      const saved = await fs.promises.readFile(firstPath);
      assert.ok(saved.equals(first) || saved.equals(second));
    } finally {
      manager.cleanup();
    }
  });

  test("workspace-relative tool local paths cannot escape the workspace", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-fuzz-workspace-"));

    try {
      fc.assert(
        fc.property(hostilePath, (localPath) => {
          try {
            const resolved = resolveWorkspaceRelativePath(workspaceRoot, localPath);
            assertInside(workspaceRoot, resolved);
          } catch (error) {
            assert.ok(error instanceof Error);
            assert.match(
              error.message,
              /localPath (must (not be empty|not contain (null bytes|path traversal segments)|not target workspace control directories|be workspace-relative|stay within)|is too long)/,
            );
          }
        }),
        { numRuns: FUZZ_RUNS },
      );
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("workspace-relative tool local paths reject Windows absolute paths", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-ws-"));

    try {
      assert.throws(
        () => resolveWorkspaceRelativePath(workspaceRoot, String.raw`C:\temp\file.txt`),
        /localPath must be workspace-relative/,
      );
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("workspace containment resolves symlinks before allowing local paths", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-ws-"));
    const outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-out-"));
    const linkPath = path.join(workspaceRoot, "out");

    try {
      await fs.promises.symlink(outsideRoot, linkPath, "dir");

      assert.throws(
        () => resolveWorkspaceRelativePath(workspaceRoot, "out/secret.txt"),
        /localPath must stay within the current workspace/,
      );
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
      await fs.promises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("workspace containment validates symlinks while preserving lexical local paths", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-ws-"));
    const realRoot = path.join(workspaceRoot, "real");
    const linkPath = path.join(workspaceRoot, "link");

    try {
      await fs.promises.mkdir(realRoot);
      await fs.promises.symlink(realRoot, linkPath, "dir");

      assert.strictEqual(
        resolveWorkspaceRelativePath(workspaceRoot, "link/file.txt"),
        path.join(linkPath, "file.txt"),
      );
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("workspace control directories are rejected as tool local paths", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-ws-"));

    try {
      assert.throws(
        () => resolveWorkspaceRelativePath(workspaceRoot, ".git/config"),
        /workspace control directories/,
      );
      assert.throws(
        () => resolveWorkspaceRelativePath(workspaceRoot, ".vscode/settings.json"),
        /workspace control directories/,
      );
      assert.throws(
        () => resolveWorkspaceRelativePath(workspaceRoot, ".git./config"),
        /workspace control directories/,
      );
      assert.throws(
        () => resolveWorkspaceRelativePath(workspaceRoot, ".vscode /settings.json"),
        /workspace control directories/,
      );
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("download tool rejects workspace control file destinations", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-ws-"));
    let downloadCalled = false;
    const testBucket = {
      async download() {
        downloadCalled = true;
        return { body: streamFromBytes(new Uint8Array([1, 2, 3])) };
      },
    } as unknown as Bucket;
    const client = {
      async getBucket() {
        return testBucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceRoot, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "bucket", path: "payload", localPath: ".git/config" },
              { getClient: () => client },
            ),
          /workspace control directories/,
        );
      });
      assert.strictEqual(downloadCalled, false);
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("absolute local paths outside the allow-list are rejected", () => {
    const sensitivePath = path.join(os.homedir(), ".ssh", "authorized_keys");
    const arbitraryTempPath = path.join(os.tmpdir(), "session-token.txt");
    const toolRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);

    try {
      fs.rmSync(toolRoot, { recursive: true, force: true });
      assert.throws(
        () => resolveToolLocalPath(sensitivePath, "workspace required"),
        /localPath must stay within the current workspace or extension tools temporary directory/,
      );
      assert.throws(
        () => resolveToolLocalPath(arbitraryTempPath, "workspace required"),
        /localPath must stay within the current workspace or extension tools temporary directory/,
      );
      assert.strictEqual(fs.existsSync(toolRoot), false);
    } finally {
      fs.rmSync(toolRoot, { recursive: true, force: true });
    }
  });

  test("absolute workspace misses reject oversized outside paths by scope first", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-ws-probe-"));
    const outsidePath = path.join(
      os.tmpdir(),
      "b2-vscode-outside-probe",
      "x".repeat(300),
      "secret.txt",
    );

    try {
      await withWorkspaceFolder(workspaceRoot, async () => {
        assert.throws(
          () => resolveToolLocalPath(outsidePath, "workspace required"),
          /localPath must stay within the current workspace or extension tools temporary directory/,
        );
      });
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("tool local path resolution treats Windows absolute paths as absolute", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-ws-"));

    try {
      await withWorkspaceFolder(workspaceRoot, async () => {
        assert.throws(
          () => resolveToolLocalPath(String.raw`C:\temp\file.txt`, "workspace required"),
          /localPath must stay within the current workspace or extension tools temporary directory/,
        );
      });
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("tool local path resolution rejects directory aliases", () => {
    for (const directoryAlias of ["", ".", "..", "nested/.", "nested/..", "nested/"] as const) {
      assert.throws(
        () => resolveToolLocalPath(directoryAlias, "workspace required"),
        /localPath must be a file path, not a directory path/,
      );
    }
  });

  test("absolute workspace local paths do not initialize the tools temp root", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "b2-vscode-absolute-workspace-"),
    );
    const toolRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    const workspacePath = path.join(workspaceRoot, "download.bin");

    try {
      await fs.promises.rm(toolRoot, { recursive: true, force: true });
      const resolved = await withWorkspaceFolder(workspaceRoot, async () =>
        resolveToolLocalPath(workspacePath, "workspace required"),
      );

      assert.strictEqual(resolved, path.join(workspaceRoot, "download.bin"));
      assert.strictEqual(fs.existsSync(toolRoot), false);
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
      await fs.promises.rm(toolRoot, { recursive: true, force: true });
    }
  });

  test("absolute local paths may target the extension tools temp root", () => {
    const toolRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    const allowedPath = path.join(toolRoot, "tool-output.bin");
    const resolved = resolveToolLocalPath(allowedPath, "workspace required");

    assert.strictEqual(resolved, allowedPath);
  });

  test("absolute tools temp aliases keep matched roots for containment", () => {
    const lexicalToolRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    const realToolRoot = path.join(
      fs.realpathSync.native(os.tmpdir()),
      TEMP_DIR_NAME,
      TEMP_TOOLS_DIR_NAME,
    );
    if (path.resolve(lexicalToolRoot) === path.resolve(realToolRoot)) {
      return;
    }

    const allowedPath = path.join(realToolRoot, "tool-output.bin");

    try {
      fs.rmSync(lexicalToolRoot, { recursive: true, force: true });
      const resolved = resolveToolLocalPathDetails(allowedPath, "workspace required");

      assert.strictEqual(resolved.path, allowedPath);
      assert.strictEqual(resolved.allowedRoot, path.resolve(realToolRoot));
      assert.strictEqual(resolved.rootKind, "toolsTemp");
      assert.strictEqual(resolved.displayPath, allowedPath);
    } finally {
      fs.rmSync(lexicalToolRoot, { recursive: true, force: true });
    }
  });

  test("absolute tools temp aliases create the matched root before containment", () => {
    const lexicalToolRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    const fakeTempParent = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-real-temp-"));
    const fakeOsTempRoot = path.join(fakeTempParent, "real-tmp");
    const fakeToolRoot = path.join(fakeOsTempRoot, TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    const allowedPath = path.join(fakeToolRoot, "tool-output.bin");
    const originalNativeRealpath = fs.realpathSync.native;
    const callNativeRealpath = originalNativeRealpath as (input: string | Buffer | URL) => string;

    try {
      (
        fs.realpathSync as typeof fs.realpathSync & {
          native: typeof fs.realpathSync.native;
        }
      ).native = ((input: string | Buffer | URL) => {
        if (path.resolve(input.toString()) === path.resolve(os.tmpdir())) {
          return fakeOsTempRoot;
        }
        return callNativeRealpath(input);
      }) as typeof fs.realpathSync.native;

      fs.rmSync(lexicalToolRoot, { recursive: true, force: true });
      const resolved = resolveToolLocalPathDetails(allowedPath, "workspace required");

      assert.strictEqual(resolved.path, allowedPath);
      assert.strictEqual(resolved.allowedRoot, path.resolve(fakeToolRoot));
      assert.strictEqual(fs.existsSync(fakeToolRoot), true);
    } finally {
      (
        fs.realpathSync as typeof fs.realpathSync & {
          native: typeof fs.realpathSync.native;
        }
      ).native = originalNativeRealpath;
      fs.rmSync(lexicalToolRoot, { recursive: true, force: true });
      fs.rmSync(fakeTempParent, { recursive: true, force: true });
    }
  });

  test("absolute workspace aliases keep matched roots for containment", async () => {
    if (process.platform === "win32") {
      return;
    }

    const realWorkspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "b2-vscode-real-ws-"),
    );
    const linkParent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-link-ws-"));
    const workspaceLink = path.join(linkParent, "workspace-link");
    const requestedPath = path.join(realWorkspaceRoot, "nested", "download.bin");

    try {
      await fs.promises.symlink(realWorkspaceRoot, workspaceLink, "dir");
      const resolved = await withWorkspaceFolder(workspaceLink, async () =>
        resolveToolLocalPathDetails(requestedPath, "workspace required"),
      );

      assert.strictEqual(resolved.path, requestedPath);
      assert.strictEqual(resolved.allowedRoot, path.resolve(realWorkspaceRoot));
      assert.strictEqual(resolved.rootKind, "workspace");
      assert.strictEqual(resolved.displayPath, path.join("nested", "download.bin"));
    } finally {
      await fs.promises.rm(linkParent, { recursive: true, force: true });
      await fs.promises.rm(realWorkspaceRoot, { recursive: true, force: true });
    }
  });

  test("absolute local path resolution preserves non-containment errors", () => {
    const tooLongPath = path.join(
      os.tmpdir(),
      TEMP_DIR_NAME,
      TEMP_TOOLS_DIR_NAME,
      "x".repeat(300),
      "download.bin",
    );

    assert.throws(
      () => resolveToolLocalPath(tooLongPath, "workspace required"),
      /localPath is too long/,
    );
  });

  test("default download names are safe workspace-relative file names", () => {
    fc.assert(
      fc.property(hostilePath, (remotePath) => {
        const fileName = safeDefaultDownloadName(remotePath);
        assert.ok(fileName.length > 0);
        assert.ok(!path.isAbsolute(fileName));
        assert.strictEqual(fileName.includes("/"), false);
        assert.strictEqual(fileName.includes("\\"), false);
        assert.strictEqual(fileName.includes("\0"), false);
        assert.notStrictEqual(fileName, ".");
        assert.notStrictEqual(fileName, "..");
      }),
      { numRuns: FUZZ_RUNS },
    );
  });

  test("default download names disambiguate sanitized names and preserve extensions", () => {
    const queryName = safeDefaultDownloadName("reports/a?b.txt");
    const colonName = safeDefaultDownloadName("reports/a:b.txt");
    const longName = safeDefaultDownloadName(`reports/${"x".repeat(300)}.xlsx`);
    const multibyteName = safeDefaultDownloadName(`reports/${"😀".repeat(80)}.json`);

    assert.notStrictEqual(queryName, colonName);
    assert.match(queryName, /\.txt$/);
    assert.match(colonName, /\.txt$/);
    assert.match(longName, /\.xlsx$/);
    assert.match(multibyteName, /\.json$/);
    assert.ok(Buffer.byteLength(longName, "utf8") <= 180);
    assert.ok(Buffer.byteLength(multibyteName, "utf8") <= 180);
  });

  test("default download names avoid Windows reserved device basenames", () => {
    for (const remotePath of [
      "reports/CON",
      "reports/NUL.txt",
      "reports/AUX.",
      "reports/com1.csv",
      "reports/Lpt1.log",
    ]) {
      const fileName = safeDefaultDownloadName(remotePath);

      assert.doesNotMatch(fileName, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    }
  });

  test("local filename fitting cannot reintroduce Windows reserved basenames", () => {
    for (const fileName of [
      sanitizeToolLocalPathSegment("CON", {
        fallback: "download",
        maxBytes: 180,
      }),
      sanitizeToolLocalPathSegment("", {
        fallback: "NUL.txt",
        maxBytes: 180,
      }),
      sanitizeToolLocalPathSegment("", {
        fallback: "CON",
        maxBytes: 3,
      }),
      sanitizeToolLocalPathSegment(`${"conspiracy".repeat(20)}.txt`, {
        fallback: "download",
        maxBytes: 24,
        preserveExtension: true,
      }),
    ]) {
      assert.doesNotMatch(fileName, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    }

    assert.ok(
      Buffer.byteLength(
        sanitizeToolLocalPathSegment("", {
          fallback: "CON",
          maxBytes: 3,
        }),
        "utf8",
      ) <= 3,
    );
    assert.ok(
      Buffer.byteLength(
        sanitizeToolLocalPathSegment(`${"conspiracy".repeat(20)}.txt`, {
          fallback: "download",
          maxBytes: 24,
          preserveExtension: true,
        }),
        "utf8",
      ) <= 24,
    );
  });

  test("download operation uses safe default file names", async () => {
    const unsafeRemotePaths = [
      "reports/CON",
      "data/NUL.txt",
      "reports/a:b.txt",
      "folder/file.",
      `reports/${"x".repeat(300)}.xlsx`,
    ];
    const testBucket = {
      async download() {
        return { body: streamFromBytes(new Uint8Array([1, 2, 3])) };
      },
    } as unknown as Bucket;
    const client = {
      async getBucket() {
        return testBucket;
      },
    } as unknown as B2Client;

    for (const remotePath of unsafeRemotePaths) {
      const workspaceRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "b2-vscode-default-safe-"),
      );
      try {
        const result = await withWorkspaceFolder(workspaceRoot, () =>
          downloadFileOperation.execute(
            { bucket: "bucket", path: remotePath },
            { getClient: () => client },
          ),
        );

        const basename = path.basename(result.localPath);
        assert.strictEqual(result.localPath, basename);
        assert.ok(basename.length > 0);
        assert.ok(Buffer.byteLength(basename, "utf8") <= 180);
        assert.doesNotMatch(basename, /[\0-\x1f\x7f<>:"|?*\\/]/);
        assert.doesNotMatch(basename, /[. ]$/);
        assert.doesNotMatch(basename, /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
        assert.deepStrictEqual(
          await fs.promises.readFile(path.join(workspaceRoot, result.localPath)),
          Buffer.from([1, 2, 3]),
        );
      } finally {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
      }
    }
  });

  test("download tools temp errors preserve absolute local paths", async () => {
    const toolRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    const destinationPath = path.join(toolRoot, "existing-download.bin");
    const client = {
      async getBucket(): Promise<Bucket | undefined> {
        throw new Error("download should not reach B2 for an existing localPath");
      },
    } as unknown as B2Client;

    try {
      await fs.promises.rm(toolRoot, { recursive: true, force: true });
      await fs.promises.mkdir(toolRoot, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(destinationPath, "already here");
      const escapedDestinationPath = destinationPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      await assert.rejects(
        () =>
          downloadFileOperation.execute(
            { bucket: "bucket", path: "payload.bin", localPath: destinationPath },
            { getClient: () => client },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(escapedDestinationPath));
          assert.doesNotMatch(error.message, /\.\/existing-download\.bin/);
          return true;
        },
      );
    } finally {
      await fs.promises.rm(toolRoot, { recursive: true, force: true });
    }
  });

  test("atomic non-overwrite writes preserve existing download targets", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-atomic-"));
    const targetPath = path.join(outputRoot, "download.bin");

    try {
      await writeBufferAtomically(targetPath, Buffer.from("old"));
      await assert.rejects(
        () =>
          writeReadableStreamAtomically(targetPath, streamFromBytes(new Uint8Array([1, 2, 3])), {
            overwrite: false,
          }),
        /EEXIST/,
      );
      assert.strictEqual(await fs.promises.readFile(targetPath, "utf8"), "old");
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("upload rejects out-of-allow-list absolute paths before lstat", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "b2-vscode-upload-probe-"),
    );
    const outsideRoot = path.join(os.tmpdir(), "b2-vscode-upload-outside-probe");
    const outsidePath = path.join(outsideRoot, "secret.txt");
    const originalLstat = fs.promises.lstat;
    let probedOutside = false;
    const client = {
      async getBucket() {
        assert.fail("Expected source validation before bucket lookup");
      },
    } as unknown as B2Client;

    fs.promises.lstat = (async (target: fs.PathLike, ...args: unknown[]) => {
      if (isToolPathInside(outsideRoot, path.resolve(String(target)))) {
        probedOutside = true;
        throw new Error("outside path was probed");
      }
      return (originalLstat as unknown as (...callArgs: unknown[]) => Promise<unknown>)(
        target,
        ...args,
      );
    }) as typeof fs.promises.lstat;

    try {
      await withWorkspaceFolder(workspaceRoot, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "bucket", localPath: outsidePath, remotePath: "remote/secret.txt" },
              { getClient: () => client },
            ),
          /current workspace/i,
        );
      });
      assert.strictEqual(probedOutside, false);
    } finally {
      fs.promises.lstat = originalLstat;
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("upload operation rejects a symlink swap before streaming", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-swap-"));
    const outsideRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-secret-"));
    const localPath = path.join(workspaceRoot, "payload.txt");
    const secretPath = path.join(outsideRoot, "secret.txt");
    let streamOpened = false;
    const testBucket = {
      file() {
        streamOpened = true;
        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>(),
              done: Promise.resolve(file("remote/payload.txt")),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } as unknown as Bucket;
    const client = {
      async getBucket() {
        await fs.promises.rm(localPath);
        await fs.promises.symlink(secretPath, localPath);
        return testBucket;
      },
    } as unknown as B2Client;

    try {
      await fs.promises.writeFile(localPath, "safe");
      await fs.promises.writeFile(secretPath, "secret");

      await withWorkspaceFolder(workspaceRoot, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "bucket", localPath: "payload.txt", remotePath: "remote/payload.txt" },
              { getClient: () => client },
            ),
          /symbolic link|ELOOP|changed before upload/i,
        );
      });

      assert.strictEqual(streamOpened, false);
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
      await fs.promises.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("atomic non-overwrite writes fall back when hard links fail", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-copy-"));
    const targetPath = path.join(outputRoot, "download.bin");
    const originalLink = fs.promises.link;
    let linkCalled = false;

    try {
      (fs.promises as unknown as { link: typeof fs.promises.link }).link = (async () => {
        linkCalled = true;
        const error = new Error("hard link unavailable") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      }) as typeof fs.promises.link;

      await writeBufferAtomically(targetPath, Buffer.from("copied"), { overwrite: false });

      assert.strictEqual(linkCalled, true);
      assert.strictEqual(await fs.promises.readFile(targetPath, "utf8"), "copied");
    } finally {
      (fs.promises as unknown as { link: typeof fs.promises.link }).link = originalLink;
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("atomic stream writes retry short file writes", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-short-"));
    const targetPath = path.join(outputRoot, "download.bin");
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const originalOpen = fs.promises.open;
    let writeCalls = 0;

    try {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = (async (
        ...args: Parameters<typeof fs.promises.open>
      ) => {
        const handle = await originalOpen(...args);
        const originalWrite = handle.write.bind(handle);

        (handle as unknown as { write: typeof handle.write }).write = (async (
          buffer: Buffer,
          offset?: number,
          length?: number,
          position?: number,
        ) => {
          const requested = length ?? buffer.byteLength - (offset ?? 0);
          const forcedLength = requested > 1 ? Math.ceil(requested / 2) : requested;
          writeCalls++;
          return originalWrite(buffer, offset, forcedLength, position);
        }) as typeof handle.write;

        return handle;
      }) as typeof fs.promises.open;

      const size = await writeReadableStreamAtomically(targetPath, streamFromBytes(bytes));

      assert.strictEqual(size, bytes.byteLength);
      assert.deepStrictEqual(await fs.promises.readFile(targetPath), Buffer.from(bytes));
      assert.ok(writeCalls > 1);
    } finally {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = originalOpen;
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("atomic stream writes cancel the reader on write failure", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-cancel-"));
    const targetPath = path.join(outputRoot, "download.bin");
    const originalOpen = fs.promises.open;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });

    try {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = (async (
        ...args: Parameters<typeof fs.promises.open>
      ) => {
        const handle = await originalOpen(...args);
        (handle as unknown as { write: typeof handle.write }).write = (async () => {
          throw new Error("forced write failure");
        }) as typeof handle.write;
        return handle;
      }) as typeof fs.promises.open;

      await assert.rejects(
        () => writeReadableStreamAtomically(targetPath, stream),
        /forced write failure/,
      );
      assert.strictEqual(cancelled, true);
    } finally {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = originalOpen;
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("atomic stream writes cancel the reader on setup failure", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-cancel-"));
    const targetPath = path.join(outputRoot, "download.bin");
    const originalOpen = fs.promises.open;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    try {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = (async () => {
        throw new Error("forced open failure");
      }) as typeof fs.promises.open;

      await assert.rejects(
        () => writeReadableStreamAtomically(targetPath, stream),
        /forced open failure/,
      );
      assert.strictEqual(cancelled, true);
    } finally {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = originalOpen;
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("atomic stream writes time out stalled readers and clean up", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-timeout-"));
    const targetPath = path.join(outputRoot, "download.bin");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    try {
      await assert.rejects(
        () => writeReadableStreamAtomically(targetPath, stream, { idleTimeoutMs: 5 }),
        /Download stream stalled/,
      );
      assert.strictEqual(cancelled, true);
      assert.strictEqual(
        (await fs.promises.readdir(outputRoot)).some((entry) => entry.endsWith(".tmp")),
        false,
      );
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("stale atomic temp files are swept without removing fresh writes", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-sweep-"));
    const oldTemp = path.join(outputRoot, ".download.bin.1.1.abcdefabcdefabcd.tmp");
    const freshTemp = path.join(outputRoot, ".download.bin.1.2.abcdefabcdefabce.tmp");
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);

    try {
      await fs.promises.writeFile(oldTemp, "old");
      await fs.promises.writeFile(freshTemp, "fresh");
      await fs.promises.utimes(oldTemp, oldDate, oldDate);

      await sweepStaleAtomicTempFiles(outputRoot, 60 * 60 * 1000);

      assert.strictEqual(fs.existsSync(oldTemp), false);
      assert.strictEqual(fs.existsSync(freshTemp), true);
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("stale atomic temp sweep ignores concurrently removed files", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-sweep-race-"));
    const disappearingTemp = path.join(outputRoot, ".download.bin.1.1.abcdefabcdefabcd.tmp");
    const freshTemp = path.join(outputRoot, ".download.bin.1.2.abcdefabcdefabce.tmp");
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const originalStat = fs.promises.stat;
    let forcedRace = false;

    try {
      await fs.promises.writeFile(disappearingTemp, "old");
      await fs.promises.writeFile(freshTemp, "fresh");
      await fs.promises.utimes(disappearingTemp, oldDate, oldDate);

      (fs.promises as unknown as { stat: typeof fs.promises.stat }).stat = (async (
        ...args: Parameters<typeof fs.promises.stat>
      ) => {
        if (args[0].toString() === disappearingTemp && !forcedRace) {
          forcedRace = true;
          await fs.promises.rm(disappearingTemp, { force: true });
          const error = new Error("missing temp file") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return originalStat(...args);
      }) as typeof fs.promises.stat;

      await sweepStaleAtomicTempFiles(outputRoot, 60 * 60 * 1000);

      assert.strictEqual(forcedRace, true);
      assert.strictEqual(fs.existsSync(freshTemp), true);
    } finally {
      (fs.promises as unknown as { stat: typeof fs.promises.stat }).stat = originalStat;
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("no-follow reads reject symlink-swapped upload targets", async () => {
    if (process.platform === "win32") {
      return;
    }

    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-nofollow-"));
    const outsideFile = path.join(outputRoot, "outside.txt");
    const linkPath = path.join(outputRoot, "link.txt");

    try {
      await fs.promises.writeFile(outsideFile, "secret");
      await fs.promises.symlink(outsideFile, linkPath);

      await assert.rejects(
        () => readFileNoFollow(linkPath),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("symbolic link") &&
          (error as NodeJS.ErrnoException).code === "ERR_B2_TOOL_INPUT",
      );
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("no-follow reads omit O_NOFOLLOW on Windows", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-nofollow-"));
    const localPath = path.join(outputRoot, "upload.txt");
    const originalOpen = fs.promises.open;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    let openFlags: string | number | undefined;

    try {
      await fs.promises.writeFile(localPath, "safe");
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = (async (
        ...args: Parameters<typeof fs.promises.open>
      ) => {
        openFlags = args[1];
        return originalOpen(...args);
      }) as typeof fs.promises.open;

      assert.deepStrictEqual(await readFileNoFollow(localPath), Buffer.from("safe"));
      assert.strictEqual(typeof openFlags, "number");
      assert.strictEqual(((openFlags as number) & fs.constants.O_NOFOLLOW) === 0, true);
    } finally {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = originalOpen;
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("no-follow reads reject non-file upload targets", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-nofollow-"));
    const directoryPath = path.join(outputRoot, "directory");

    try {
      await fs.promises.mkdir(directoryPath);

      await assert.rejects(
        () => readFileNoFollow(directoryPath),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("regular file") &&
          (error as NodeJS.ErrnoException).code === "ERR_B2_TOOL_INPUT",
      );
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("no-follow reads reject files swapped while opening", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-nofollow-"));
    const localPath = path.join(outputRoot, "upload.txt");
    const replacementPath = path.join(outputRoot, "replacement.txt");
    const originalOpen = fs.promises.open;
    let swapped = false;

    try {
      await fs.promises.writeFile(localPath, "safe");
      await fs.promises.writeFile(replacementPath, "different");

      (fs.promises as unknown as { open: typeof fs.promises.open }).open = (async (
        ...args: Parameters<typeof fs.promises.open>
      ) => {
        const handle = await originalOpen(...args);
        if (args[0].toString() === localPath && !swapped) {
          swapped = true;
          await fs.promises.rm(localPath, { force: true });
          await fs.promises.copyFile(replacementPath, localPath);
        }
        return handle;
      }) as typeof fs.promises.open;

      await assert.rejects(
        () => readFileNoFollow(localPath),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("changed while opening") &&
          (error as NodeJS.ErrnoException).code === "ERR_B2_TOOL_INPUT",
      );
      assert.strictEqual(swapped, true);
    } finally {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = originalOpen;
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("no-follow reads recheck symlinks after opening", async () => {
    if (process.platform === "win32") {
      return;
    }

    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-nofollow-"));
    const localPath = path.join(outputRoot, "upload.txt");
    const outsideFile = path.join(outputRoot, "outside.txt");
    const originalOpen = fs.promises.open;
    let swapped = false;

    try {
      await fs.promises.writeFile(localPath, "safe");
      await fs.promises.writeFile(outsideFile, "secret");

      (fs.promises as unknown as { open: typeof fs.promises.open }).open = (async (
        ...args: Parameters<typeof fs.promises.open>
      ) => {
        const handle = await originalOpen(...args);
        if (args[0].toString() === localPath && !swapped) {
          swapped = true;
          await fs.promises.rm(localPath, { force: true });
          await fs.promises.symlink(outsideFile, localPath);
        }
        return handle;
      }) as typeof fs.promises.open;

      await assert.rejects(
        () => readFileNoFollow(localPath),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("symbolic link") &&
          (error as NodeJS.ErrnoException).code === "ERR_B2_TOOL_INPUT",
      );
      assert.strictEqual(swapped, true);
    } finally {
      (fs.promises as unknown as { open: typeof fs.promises.open }).open = originalOpen;
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("default downloads detect existing targets before downloading", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-default-"));
    const targetPath = path.join(outputRoot, "file.txt");
    let downloadCalled = false;
    const testBucket = {
      async download() {
        downloadCalled = true;
        return { body: streamFromBytes(new Uint8Array([1, 2, 3])) };
      },
    } as unknown as Bucket;
    const client = {
      async getBucket() {
        return testBucket;
      },
    } as unknown as B2Client;

    try {
      await fs.promises.writeFile(targetPath, "old");
      await withWorkspaceFolder(outputRoot, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "bucket", path: "file.txt" },
              { getClient: () => client },
            ),
          /File already exists .*Choose a different localPath/,
        );
      });

      assert.strictEqual(downloadCalled, false);
      assert.strictEqual(await fs.promises.readFile(targetPath, "utf8"), "old");
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("explicit downloads do not overwrite existing local files", async () => {
    const tempRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    await ensureToolPrivateDirectory(tempRoot);
    const outputRoot = await fs.promises.mkdtemp(path.join(tempRoot, "explicit-"));
    const targetPath = path.join(outputRoot, "file.txt");
    let downloadCalled = false;
    const testBucket = {
      async download() {
        downloadCalled = true;
        return { body: streamFromBytes(new Uint8Array([1, 2, 3])) };
      },
    } as unknown as Bucket;
    const client = {
      async getBucket() {
        return testBucket;
      },
    } as unknown as B2Client;

    try {
      await fs.promises.writeFile(targetPath, "old");
      await withWorkspaceFolder(outputRoot, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "bucket", path: "file.txt", localPath: "file.txt" },
              { getClient: () => client },
            ),
          /File already exists .*Choose a different localPath/,
        );
      });

      assert.strictEqual(downloadCalled, false);
      assert.strictEqual(await fs.promises.readFile(targetPath, "utf8"), "old");
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("tool operations tolerate hostile bucket and path strings", async () => {
    const tempRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    await ensureToolPrivateDirectory(tempRoot);
    const outputRoot = await fs.promises.mkdtemp(path.join(tempRoot, "tools-"));
    let downloadIndex = 0;

    try {
      await fc.assert(
        fc.asyncProperty(hostileString, hostilePath, async (bucketName, filePath) => {
          const extras = operationExtras(bucketName, filePath);
          const localPath = path.join("downloads", `download-${downloadIndex++}.bin`);

          const info = await getFileInfoOperation.execute(
            { bucket: bucketName, path: filePath },
            extras,
          );
          assert.strictEqual(info.fileName, filePath);

          const listed = await listFilesOperation.execute(
            {
              bucket: bucketName,
              prefix: filePath,
              continuationToken: filePath,
              limit: 1,
            },
            extras,
          );
          assert.strictEqual(listed.files[0]?.name, filePath);

          if (isInvalidB2ObjectNameInput(filePath)) {
            await withWorkspaceFolder(outputRoot, () =>
              assert.rejects(
                () =>
                  downloadFileOperation.execute(
                    { bucket: bucketName, path: filePath, localPath },
                    extras,
                  ),
                /path must/i,
              ),
            );
          } else {
            const downloaded = await withWorkspaceFolder(outputRoot, () =>
              downloadFileOperation.execute(
                { bucket: bucketName, path: filePath, localPath },
                extras,
              ),
            );
            assertInside(outputRoot, path.join(outputRoot, downloaded.localPath));
          }

          const deleted = await deleteFileOperation.execute(
            { bucket: bucketName, path: filePath },
            extras,
          );
          assert.match(deleted.message, /Deleted /);
        }),
        { numRuns: TOOL_OPERATION_FUZZ_RUNS },
      );
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  test("path safety URL encoding matches the shared RFC3986 encoder", () => {
    const value = "report !'()* /雪.pdf";

    assert.strictEqual(encodeUrlComponent(value), encodeSharedUrlComponent(value));
    assert.strictEqual(encodeUrlPathSegment(value), encodeSharedUrlComponent(value));
    assert.match(encodeUrlComponent(value), /%21%27%28%29%2A/);
  });

  test("pre-signed URLs encode hostile bucket, path, and token strings", async () => {
    await fc.assert(
      fc.asyncProperty(
        hostileString,
        hostilePath,
        hostileString,
        validExpiresIn,
        async (bucketName, filePath, authorizationToken, expiresIn) => {
          if (isInvalidB2ObjectNameInput(filePath)) {
            await assert.rejects(
              () =>
                presignUrlOperation.execute(
                  { bucket: bucketName, path: filePath, expiresIn },
                  presignExtrasThatFailsBeforeSdkCalls(),
                ),
              /path must/i,
            );
            return;
          }

          if (hasUrlDotSegment(bucketName) || hasUrlDotSegment(filePath)) {
            await assert.rejects(
              () =>
                presignUrlOperation.execute(
                  { bucket: bucketName, path: filePath, expiresIn },
                  presignExtrasThatFailsBeforeSdkCalls(),
                ),
              (error: unknown) =>
                error instanceof Error &&
                error.message.includes('must not contain "." or ".."') &&
                (error as NodeJS.ErrnoException).code === "ERR_B2_TOOL_INPUT",
            );
            return;
          }

          const result = await presignUrlOperation.execute(
            { bucket: bucketName, path: filePath, expiresIn },
            presignExtras(authorizationToken),
          );
          const parsed = new URL(result.url);

          assert.strictEqual(parsed.origin, DOWNLOAD_BASE_URL);
          assert.strictEqual(parsed.hash, "");
          assert.strictEqual(parsed.username, "");
          assert.strictEqual(parsed.password, "");
          assert.deepStrictEqual(Array.from(parsed.searchParams.keys()), ["Authorization"]);
          assert.strictEqual(
            parsed.searchParams.get("Authorization"),
            toWellFormedUnicode(authorizationToken),
          );
          assert.strictEqual(result.expiresIn, expiresIn);
          assert.strictEqual(result.message.includes(result.url), false);
        },
      ),
      { numRuns: ASYNC_FUZZ_RUNS },
    );
  });

  test("pre-signed URLs reject dot segments before SDK calls", async () => {
    const cases = [
      { bucket: "bucket", path: "../escape.txt" },
      { bucket: "bucket", path: "safe/../../target.txt" },
      { bucket: "bucket", path: "." },
      { bucket: "bucket", path: ".." },
      { bucket: "bucket", path: "./../notes.txt" },
      { bucket: "..", path: "file.txt" },
    ];

    for (const entry of cases) {
      await assert.rejects(
        () => presignUrlOperation.execute(entry, presignExtrasThatFailsBeforeSdkCalls()),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('must not contain "." or ".."') &&
          (error as NodeJS.ErrnoException).code === "ERR_B2_TOOL_INPUT",
      );
    }

    const legitimateDots = await presignUrlOperation.execute(
      { bucket: "bucket", path: ".../notes.txt" },
      presignExtras("token"),
    );
    assert.strictEqual(new URL(legitimateDots.url).pathname, "/file/bucket/.../notes.txt");
  });

  test("pre-signed URL messages do not duplicate the bearer token URL", async () => {
    const result = await presignUrlOperation.execute(
      { bucket: "bucket", path: "file.txt" },
      presignExtras("secret-token"),
    );

    assert.match(result.url, /secret-token/);
    assert.doesNotMatch(result.message, /secret-token/);
    assert.doesNotMatch(result.message, /https:\/\/download\.example\.com/);
  });

  test("pre-signed URL expiration rejects invalid fuzzed values before SDK calls", async () => {
    await fc.assert(
      fc.asyncProperty(invalidExpiresIn, async (expiresIn) => {
        await assert.rejects(
          () =>
            presignUrlOperation.execute(
              { bucket: "bucket", path: "file.txt", expiresIn },
              presignExtrasThatFailsBeforeSdkCalls(),
            ),
          /expiresIn must be an integer/,
        );
      }),
      { numRuns: ASYNC_FUZZ_RUNS },
    );
  });
});
