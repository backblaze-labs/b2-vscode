/**
 * Adversarial input fuzz coverage for B2 object names and tool parameters.
 *
 * @module test/suite/adversarialInputs
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
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
import { TEMP_DIR_NAME } from "../../constants";
import { FileTreeItem } from "../../models/fileTreeItem";
import { FolderTreeItem } from "../../models/folderTreeItem";
import { TempFileManager } from "../../services/tempFileManager";
import {
  buildPresignedDownloadUrl,
  normalizePresignUrlExpiration,
  presignUrlOperation,
} from "../../tools/operations/presignUrl";
import { deleteFileOperation } from "../../tools/operations/deleteFile";
import { downloadFileOperation } from "../../tools/operations/downloadFile";
import { getFileInfoOperation } from "../../tools/operations/getFileInfo";
import { listFilesOperation } from "../../tools/operations/listFiles";
import {
  isPathInside,
  resolveWorkspaceRelativePath,
  safeDefaultDownloadName,
} from "../../tools/localPaths";
import type { ToolExtras } from "../../tools/types";

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
  fc.constantFrom(1, 60, 3600, 604800),
  fc.integer({ min: 1, max: 604800 }),
);

const invalidExpiresIn = fc.oneof(
  fc.constantFrom(-1, 0, 0.5, 1.25, Number.NaN, Number.POSITIVE_INFINITY, 604801),
  fc.integer({ min: -1000000, max: 0 }),
  fc.integer({ min: 604801, max: Number.MAX_SAFE_INTEGER }),
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

function assertInside(parentPath: string, candidatePath: string): void {
  assert.ok(
    isPathInside(parentPath, candidatePath),
    `${candidatePath} should remain under ${parentPath}`,
  );
}

function wellFormedUnicode(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index++;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index];
    }
  }

  return result;
}

function presignExtras(authorizationToken: string): ToolExtras {
  const testBucket = {
    async getDownloadAuthorization(fileNamePrefix: string, validDurationInSeconds: number) {
      assert.strictEqual(
        normalizePresignUrlExpiration(validDurationInSeconds),
        validDurationInSeconds,
      );
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

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function withWorkspaceFolder<T>(workspacePath: string, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    get: () => [
      {
        uri: vscode.Uri.file(workspacePath),
        name: "workspace",
        index: 0,
      },
    ],
  });

  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(vscode.workspace, "workspaceFolders", descriptor);
    } else {
      delete (vscode.workspace as unknown as { workspaceFolders?: unknown }).workspaceFolders;
    }
  }
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

  test("temp file cache never writes outside the extension temp root", async () => {
    const tempRoot = path.join(os.tmpdir(), TEMP_DIR_NAME);

    await fc.assert(
      fc.asyncProperty(hostileString, hostilePath, async (bucketName, fileName) => {
        const manager = new TempFileManager();
        try {
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

  test("workspace-relative tool local paths cannot escape the workspace", () => {
    const workspaceRoot = path.join(os.tmpdir(), "b2-vscode-fuzz-workspace");

    fc.assert(
      fc.property(hostilePath, (localPath) => {
        if (path.isAbsolute(localPath)) {
          return;
        }

        try {
          const resolved = resolveWorkspaceRelativePath(workspaceRoot, localPath);
          assertInside(workspaceRoot, resolved);
        } catch (error) {
          assert.ok(error instanceof Error);
          assert.match(error.message, /localPath must (not contain null bytes|stay within)/);
        }
      }),
      { numRuns: FUZZ_RUNS },
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

  test("tool operations tolerate hostile bucket and path strings", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-vscode-tools-"));
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

          const downloaded = await withWorkspaceFolder(outputRoot, () =>
            downloadFileOperation.execute({ bucket: bucketName, path: filePath, localPath }, extras),
          );
          assertInside(outputRoot, downloaded.localPath);

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

  test("pre-signed URLs encode hostile bucket, path, and token strings", async () => {
    await fc.assert(
      fc.asyncProperty(
        hostileString,
        hostilePath,
        hostileString,
        validExpiresIn,
        async (bucketName, filePath, authorizationToken, expiresIn) => {
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
            wellFormedUnicode(authorizationToken),
          );
          assert.strictEqual(result.expiresIn, expiresIn);

          const directUrl = buildPresignedDownloadUrl(
            DOWNLOAD_BASE_URL,
            bucketName,
            filePath,
            authorizationToken,
          );
          assert.strictEqual(result.url, directUrl);
        },
      ),
      { numRuns: ASYNC_FUZZ_RUNS },
    );
  });

  test("pre-signed URL expiration rejects invalid fuzzed values before SDK calls", async () => {
    await fc.assert(
      fc.asyncProperty(invalidExpiresIn, async (expiresIn) => {
        await assert.rejects(
          () =>
            presignUrlOperation.execute(
              { bucket: "bucket", path: "file.txt", expiresIn },
              presignExtras("token"),
            ),
          /expiresIn must be an integer/,
        );
      }),
      { numRuns: ASYNC_FUZZ_RUNS },
    );
  });
});
