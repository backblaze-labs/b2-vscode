/**
 * Tests for B2 client configuration safety.
 *
 * @module test/suite/b2
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  B2Client,
  SSE_NONE,
  accountId,
  bucketId,
  fileId,
  largeFileId,
  type FileVersion,
} from "@backblaze-labs/b2-sdk";
// @ts-expect-error Classic moduleResolution does not read this package export map.
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import {
  buildCustomApiUrlWarningMessage,
  CONFIRM_CUSTOM_API_URL_LABEL,
  createB2Client,
  createConfiguredB2Client,
  DEFAULT_B2_API_URL,
  resolveB2ClientApiUrl,
  resolveB2ApiUrlFromInspection,
  type B2ApiUrlInspection,
} from "../../services/b2";
import {
  cleanupStaleDestinationTempFiles,
  cleanupStaleTransferTempFiles,
  downloadStreamToFile,
  STREAMING_UPLOAD_PART_SIZE,
  TransferStallTimeoutError,
  uploadFileFromDisk,
  type UploadBucketHandle,
} from "../../services/fileTransfers";
import { withCancellableTransferProgress } from "../../services/transferProgress";
import { TempFileManager } from "../../services/tempFileManager";
import { isPathInsideOrEqual } from "../../services/pathSafety";
import { humanSize } from "../../utils/humanSize";
import type { B2Credentials } from "../../services/authService";

const CUSTOM_API_URL = "https://b2-compatible.example.com";
const ATTACKER_API_URL = "https://attacker.example.com";
const TEST_CREDENTIALS: B2Credentials = { keyId: "key-id", appKey: "app-key" };
const TEST_VERSION = "0.0.1";

function fakeFileVersion(fileName: string, contentLength: number, id: string): FileVersion {
  return {
    accountId: accountId("account-id"),
    action: "upload",
    bucketId: bucketId("bucket-id"),
    contentLength,
    contentMd5: null,
    contentSha1: null,
    contentType: "application/octet-stream",
    fileId: fileId(id),
    fileInfo: {},
    fileName,
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    replicationStatus: null,
    serverSideEncryption: SSE_NONE,
    uploadTimestamp: 0,
  };
}

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

interface WarningMessageCall {
  readonly message: string;
  readonly options: vscode.MessageOptions | undefined;
  readonly items: readonly string[];
}

function stubB2ApiUrlInspection(inspection: B2ApiUrlInspection): () => void {
  const mutableWorkspace = vscode.workspace as unknown as {
    getConfiguration: typeof vscode.workspace.getConfiguration;
  };
  const originalGetConfiguration = mutableWorkspace.getConfiguration;

  function get<T>(_section: string): T | undefined;
  function get<T>(_section: string, defaultValue: T): T;
  function get<T>(_section: string, defaultValue?: T): T | undefined {
    return defaultValue;
  }

  const configuration: vscode.WorkspaceConfiguration = {
    get,
    has: (_section: string) => false,
    inspect: <T>(_section: string) => ({
      key: "b2.apiUrl",
      defaultValue: inspection.defaultValue as T,
      globalValue: inspection.globalValue as T,
      workspaceValue: inspection.workspaceValue as T,
      workspaceFolderValue: inspection.workspaceFolderValue as T,
    }),
    update: () => Promise.resolve(),
  };

  mutableWorkspace.getConfiguration = () => configuration;

  return () => {
    mutableWorkspace.getConfiguration = originalGetConfiguration;
  };
}

function stubB2ApiUrlConfiguration(globalValue: unknown): () => void {
  return stubB2ApiUrlInspection({
    defaultValue: DEFAULT_B2_API_URL,
    globalValue,
  });
}

function stubWarningMessage(
  choice: string | undefined,
  onCall?: (call: WarningMessageCall) => void,
): () => void {
  const mutableWindow = vscode.window as unknown as {
    showWarningMessage: typeof vscode.window.showWarningMessage;
  };
  const originalShowWarningMessage = mutableWindow.showWarningMessage;

  mutableWindow.showWarningMessage = ((
    message: string,
    optionsOrFirstItem?: vscode.MessageOptions | string,
    ...restItems: string[]
  ) => {
    const hasOptions = typeof optionsOrFirstItem === "object" && optionsOrFirstItem !== null;
    const options = hasOptions ? optionsOrFirstItem : undefined;
    const items =
      !hasOptions && optionsOrFirstItem !== undefined
        ? [optionsOrFirstItem, ...restItems]
        : restItems;

    onCall?.({ message, options, items });

    return Promise.resolve(choice);
  }) as typeof vscode.window.showWarningMessage;

  return () => {
    mutableWindow.showWarningMessage = originalShowWarningMessage;
  };
}

function stubWithProgress(
  tokenSource: vscode.CancellationTokenSource = new vscode.CancellationTokenSource(),
): () => void {
  const mutableWindow = vscode.window as unknown as {
    withProgress: typeof vscode.window.withProgress;
  };
  const originalWithProgress = mutableWindow.withProgress;

  mutableWindow.withProgress = ((_options, task) =>
    task({ report: () => undefined }, tokenSource.token)) as typeof vscode.window.withProgress;

  return () => {
    mutableWindow.withProgress = originalWithProgress;
  };
}

suite("B2 utility helpers", () => {
  test("formats fractional byte values without invalid units", () => {
    assert.strictEqual(humanSize(0.5), "1 B");
    assert.doesNotMatch(humanSize(0.5), /undefined/);
  });

  test("treats filesystem root children as contained", () => {
    const root = path.parse(process.cwd()).root;

    assert.strictEqual(isPathInsideOrEqual(root, path.join(root, "tmp")), true);
    assert.strictEqual(
      isPathInsideOrEqual(path.join(root, "tmp", "base"), path.join(root, "tmp", "base2")),
      false,
    );
  });
});

suite("B2 API URL configuration", () => {
  test("uses the default B2 API URL", () => {
    const resolved = resolveB2ApiUrlFromInspection({
      defaultValue: DEFAULT_B2_API_URL,
    });

    assert.deepStrictEqual(resolved, {
      apiUrl: DEFAULT_B2_API_URL,
      isDefault: true,
    });
  });

  test("falls back to the built-in default when configuration is absent", () => {
    const resolved = resolveB2ApiUrlFromInspection(undefined);

    assert.deepStrictEqual(resolved, {
      apiUrl: DEFAULT_B2_API_URL,
      isDefault: true,
    });
  });

  test("falls back to the built-in default when inspection has no values", () => {
    const resolved = resolveB2ApiUrlFromInspection({
      defaultValue: undefined,
      globalValue: undefined,
    });

    assert.deepStrictEqual(resolved, {
      apiUrl: DEFAULT_B2_API_URL,
      isDefault: true,
    });
  });

  test("accepts a user-level HTTPS override", () => {
    const resolved = resolveB2ApiUrlFromInspection({
      defaultValue: DEFAULT_B2_API_URL,
      globalValue: `${CUSTOM_API_URL}/`,
    });

    assert.deepStrictEqual(resolved, {
      apiUrl: CUSTOM_API_URL,
      isDefault: false,
    });
  });

  test("rejects workspace-level API URL overrides", () => {
    assert.throws(
      () =>
        resolveB2ApiUrlFromInspection({
          defaultValue: DEFAULT_B2_API_URL,
          workspaceValue: ATTACKER_API_URL,
        }),
      /user settings/,
    );
  });

  test("rejects workspace overrides before accepting a user-level API URL", () => {
    assert.throws(
      () =>
        resolveB2ApiUrlFromInspection({
          defaultValue: DEFAULT_B2_API_URL,
          globalValue: `${CUSTOM_API_URL}/`,
          workspaceValue: ATTACKER_API_URL,
        }),
      /user settings/,
    );
  });

  test("rejects workspace-folder API URL overrides", () => {
    assert.throws(
      () =>
        resolveB2ApiUrlFromInspection({
          defaultValue: DEFAULT_B2_API_URL,
          workspaceFolderValue: ATTACKER_API_URL,
        }),
      /user settings/,
    );
  });

  test("rejects invalid, credential-bearing, or non-string user API URLs", () => {
    const invalidValues = [
      "not a url",
      "http://b2-compatible.example.com",
      "https://key:secret@b2-compatible.example.com",
      "https://b2-compatible.example.com?token=value",
      "https://b2-compatible.example.com#fragment",
      "",
      null,
      42,
    ];

    for (const globalValue of invalidValues) {
      const inspection: B2ApiUrlInspection = {
        defaultValue: DEFAULT_B2_API_URL,
        globalValue,
      };

      assert.throws(() => resolveB2ApiUrlFromInspection(inspection), /b2\.apiUrl/);
    }
  });

  test("creates the SDK client for the default B2 API URL", () => {
    const client = createB2Client(TEST_CREDENTIALS, TEST_VERSION);

    assert.strictEqual(typeof client.authorize, "function");
  });

  test("resolves the default API URL for client construction", () => {
    assert.deepStrictEqual(resolveB2ClientApiUrl(), {
      apiUrl: DEFAULT_B2_API_URL,
      isDefault: true,
    });
  });

  test("configures the SDK client for a trusted custom API URL", () => {
    const client = createB2Client(TEST_CREDENTIALS, TEST_VERSION, {
      apiUrl: `${CUSTOM_API_URL}/`,
    });

    assert.strictEqual(typeof client.authorize, "function");
    assert.deepStrictEqual(resolveB2ClientApiUrl({ apiUrl: `${CUSTOM_API_URL}/` }), {
      apiUrl: CUSTOM_API_URL,
      isDefault: false,
    });
  });

  test("rejects an invalid custom API URL at client construction", () => {
    assert.throws(
      () =>
        createB2Client(TEST_CREDENTIALS, TEST_VERSION, {
          apiUrl: "http://b2-compatible.example.com",
        }),
      /HTTPS/,
    );
  });

  test("warns before credentials are sent to a non-default API URL", () => {
    const message = buildCustomApiUrlWarningMessage(CUSTOM_API_URL);

    assert.match(message, /Custom API URL configured/);
    assert.match(message, /trust this endpoint/);
    assert.match(message, /application key will be sent there/);
    assert.match(message, /https:\/\/b2-compatible\.example\.com/);
    assert.doesNotMatch(message, /key-id|app-key|secret/i);
  });

  test("redacts unsafe API URL parts from the custom endpoint warning", () => {
    const message = buildCustomApiUrlWarningMessage(
      "https://key:secret@b2-compatible.example.com/path/?token=value#fragment",
    );

    assert.match(message, /https:\/\/b2-compatible\.example\.com\/path/);
    assert.doesNotMatch(message, /key:secret|token=value|fragment/);
  });

  test("rejects authentication when the custom API URL warning is dismissed", async () => {
    const restoreConfiguration = stubB2ApiUrlConfiguration(CUSTOM_API_URL);
    const restoreWarningMessage = stubWarningMessage(undefined);

    try {
      await assert.rejects(
        () => createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION),
        /authentication canceled/,
      );
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });

  test("rejects authentication when the custom API URL warning returns another choice", async () => {
    const restoreConfiguration = stubB2ApiUrlConfiguration(CUSTOM_API_URL);
    const restoreWarningMessage = stubWarningMessage("Some Other Button");

    try {
      await assert.rejects(
        () => createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION),
        /authentication canceled/,
      );
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });

  test("propagates API URL configuration errors without showing a warning", async () => {
    const restoreConfiguration = stubB2ApiUrlInspection({
      defaultValue: DEFAULT_B2_API_URL,
      workspaceValue: ATTACKER_API_URL,
    });
    let warningWasShown = false;
    const restoreWarningMessage = stubWarningMessage(undefined, () => {
      warningWasShown = true;
    });

    try {
      await assert.rejects(
        () => createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION),
        /user settings/,
      );
      assert.strictEqual(warningWasShown, false);
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });

  test("creates a default client without showing a custom API URL warning", async () => {
    const restoreConfiguration = stubB2ApiUrlConfiguration(undefined);
    let warningWasShown = false;
    const restoreWarningMessage = stubWarningMessage(undefined, () => {
      warningWasShown = true;
    });

    try {
      const client = await createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION);

      assert.strictEqual(warningWasShown, false);
      assert.strictEqual(typeof client.authorize, "function");
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });

  test("creates a client after showing a modal custom API URL warning", async () => {
    const restoreConfiguration = stubB2ApiUrlConfiguration(CUSTOM_API_URL);
    let warningCall: WarningMessageCall | undefined;
    const restoreWarningMessage = stubWarningMessage(CONFIRM_CUSTOM_API_URL_LABEL, (call) => {
      warningCall = call;
    });

    try {
      const client = await createConfiguredB2Client(TEST_CREDENTIALS, TEST_VERSION);

      assert.ok(warningCall);
      assert.strictEqual(warningCall.options?.modal, true);
      assert.deepStrictEqual(warningCall.items, [CONFIRM_CUSTOM_API_URL_LABEL]);
      assert.match(warningCall.message, /Custom API URL configured/);
      assert.strictEqual(typeof client.authorize, "function");
    } finally {
      restoreWarningMessage();
      restoreConfiguration();
    }
  });
});

suite("B2 transfer helpers", () => {
  test("streams downloads directly to the destination file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-"));
    const destination = path.join(dir, "nested", "file.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });

    try {
      const size = await downloadStreamToFile(stream, destination);

      assert.strictEqual(size, 5);
      assert.deepStrictEqual([...fs.readFileSync(destination)], [1, 2, 3, 4, 5]);
      assert.deepStrictEqual(
        fs.readdirSync(path.dirname(destination)).filter((name) => name.endsWith(".tmp")),
        [],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overwrites existing destinations when rename reports EEXIST", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-overwrite-"));
    const destination = path.join(dir, "file.bin");
    fs.writeFileSync(destination, Buffer.from([1, 2, 3]));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([6, 7, 8]));
        controller.close();
      },
    });
    const originalRename = fs.promises.rename;
    let renameCalls = 0;
    fs.promises.rename = async (oldPath: fs.PathLike, newPath: fs.PathLike): Promise<void> => {
      renameCalls += 1;
      if (renameCalls === 1 && path.resolve(String(newPath)) === path.resolve(destination)) {
        throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
      }

      await originalRename(oldPath, newPath);
    };

    try {
      const size = await downloadStreamToFile(stream, destination);

      assert.strictEqual(size, 3);
      assert.deepStrictEqual([...fs.readFileSync(destination)], [6, 7, 8]);
      assert.strictEqual(renameCalls, 2);
      assert.strictEqual(
        fs.readdirSync(dir).some((name) => name.startsWith(".b2-replace-backup-")),
        false,
      );
    } finally {
      fs.promises.rename = originalRename;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores existing destinations when overwrite rename fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-overwrite-restore-"));
    const destination = path.join(dir, "file.bin");
    fs.writeFileSync(destination, Buffer.from([1, 2, 3]));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([6, 7, 8]));
        controller.close();
      },
    });
    const originalRename = fs.promises.rename;
    const originalCopyFile = fs.promises.copyFile;
    let backupPath = "";
    let destinationRenameAttempts = 0;
    fs.promises.copyFile = async (
      source: fs.PathLike,
      destinationCopy: fs.PathLike,
      mode?: number,
    ): Promise<void> => {
      backupPath = String(destinationCopy);
      await originalCopyFile(source, destinationCopy, mode);
    };
    fs.promises.rename = async (oldPath: fs.PathLike, newPath: fs.PathLike): Promise<void> => {
      const oldResolved = path.resolve(String(oldPath));
      const newResolved = path.resolve(String(newPath));
      const backupResolved = backupPath ? path.resolve(backupPath) : "";

      if (newResolved === path.resolve(destination) && oldResolved !== backupResolved) {
        destinationRenameAttempts += 1;
        if (destinationRenameAttempts === 1) {
          throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
        }
        throw new Error("replacement failed");
      }

      await originalRename(oldPath, newPath);
    };

    try {
      await assert.rejects(() => downloadStreamToFile(stream, destination), /replacement failed/i);

      assert.strictEqual(destinationRenameAttempts, 2);
      assert.deepStrictEqual([...fs.readFileSync(destination)], [1, 2, 3]);
      assert.strictEqual(fs.existsSync(backupPath), false);
      assert.strictEqual(
        fs.readdirSync(dir).some((name) => name.startsWith(".b2-replace-backup-")),
        false,
      );
    } finally {
      fs.promises.rename = originalRename;
      fs.promises.copyFile = originalCopyFile;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps existing destinations intact when EXDEV fallback copy fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-exdev-"));
    const destination = path.join(dir, "file.bin");
    fs.writeFileSync(destination, Buffer.from([1, 2, 3]));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([6, 7, 8]));
        controller.close();
      },
    });
    const originalRename = fs.promises.rename;
    const originalCopyFile = fs.promises.copyFile;
    let renameCalls = 0;
    let destinationTempPath = "";
    fs.promises.rename = async (oldPath: fs.PathLike, newPath: fs.PathLike): Promise<void> => {
      renameCalls += 1;
      if (renameCalls === 1 && path.resolve(String(newPath)) === path.resolve(destination)) {
        throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
      }

      await originalRename(oldPath, newPath);
    };
    fs.promises.copyFile = async (
      _source: fs.PathLike,
      destinationCopy: fs.PathLike,
      _mode?: number,
    ): Promise<void> => {
      destinationTempPath = String(destinationCopy);
      fs.writeFileSync(destinationTempPath, Buffer.from([9]));
      throw new Error("copy interrupted");
    };

    try {
      await assert.rejects(() => downloadStreamToFile(stream, destination), /copy interrupted/i);

      assert.deepStrictEqual([...fs.readFileSync(destination)], [1, 2, 3]);
      assert.strictEqual(fs.existsSync(destinationTempPath), false);
      assert.strictEqual(
        fs.readdirSync(dir).some((name) => name.startsWith(".b2-cross-device-")),
        false,
      );
    } finally {
      fs.promises.rename = originalRename;
      fs.promises.copyFile = originalCopyFile;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects symlinked transfer temp directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-transfer-symlink-"));
    const target = path.join(dir, "target");
    const linkPath = path.join(dir, "link");
    const destination = path.join(dir, "download.bin");
    fs.mkdirSync(target);
    const staleTargetFile = path.join(target, "b2-transfer-1-stale.tmp");
    fs.writeFileSync(staleTargetFile, "do not delete");
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleTargetFile, oldTime, oldTime);
    const symlinkCreated = createDirectorySymlink(target, linkPath);
    if (!symlinkCreated) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    try {
      await assert.rejects(
        () => downloadStreamToFile(stream, destination, { temporaryDirectory: linkPath }),
        /real directory|symlink/i,
      );

      assert.deepStrictEqual(fs.readdirSync(target), ["b2-transfer-1-stale.tmp"]);
      assert.strictEqual(fs.readFileSync(staleTargetFile, "utf8"), "do not delete");
      assert.strictEqual(fs.existsSync(destination), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("streams non-empty uploads through the SDK write stream", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([9, 8, 7, 6]));

    const uploaded: number[] = [];
    const bucket = {
      file(fileName: string) {
        assert.strictEqual(fileName, "remote/file.bin");
        let resolveDone: (value: FileVersion) => void = () => undefined;
        const done = new Promise<FileVersion>((resolve) => {
          resolveDone = resolve;
        });

        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>({
                write(chunk) {
                  uploaded.push(...chunk);
                },
                close() {
                  resolveDone(fakeFileVersion(fileName, uploaded.length, "uploaded-id"));
                },
              }),
              done,
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      const result = await uploadFileFromDisk(bucket, localPath, "remote/file.bin");

      assert.deepStrictEqual(uploaded, [9, 8, 7, 6]);
      assert.strictEqual(result.fileId, "uploaded-id");
      assert.strictEqual(result.contentLength, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bounds unfinished upload cleanup before streaming", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-cleanup-bound-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    const uploaded: number[] = [];
    let listCalls = 0;
    let cancelCalls = 0;

    const bucket = {
      async listUnfinishedLargeFiles() {
        listCalls += 1;
        return {
          files: [
            {
              fileId: largeFileId(`unrelated-${listCalls}`),
              fileName: "remote/file.bin-unrelated",
            },
          ],
          nextFileId: largeFileId(`next-${listCalls}`),
        };
      },
      async cancelLargeFile() {
        cancelCalls += 1;
      },
      file(fileName: string) {
        let resolveDone: (value: FileVersion) => void = () => undefined;
        const done = new Promise<FileVersion>((resolve) => {
          resolveDone = resolve;
        });

        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>({
                write(chunk) {
                  uploaded.push(...chunk);
                },
                close() {
                  resolveDone(fakeFileVersion(fileName, uploaded.length, "uploaded-id"));
                },
              }),
              done,
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      const result = await uploadFileFromDisk(bucket, localPath, "remote/file.bin", {
        unfinishedCleanupMaxPages: 2,
      });

      assert.strictEqual(result.fileId, "uploaded-id");
      assert.strictEqual(listCalls, 2);
      assert.strictEqual(cancelCalls, 0);
      assert.deepStrictEqual(uploaded, [1, 2, 3]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses single-upload path for empty files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-empty-upload-"));
    const localPath = path.join(dir, "empty.bin");
    fs.writeFileSync(localPath, "");
    let uploadWasCalled = false;

    const bucket = {
      async upload(options) {
        uploadWasCalled = true;
        assert.strictEqual(options.fileName, "remote/empty.bin");
        return fakeFileVersion(options.fileName, 0, "empty-id");
      },
      file() {
        assert.fail("Expected empty files to avoid the streaming write path");
      },
    } satisfies UploadBucketHandle;

    try {
      const result = await uploadFileFromDisk(bucket, localPath, "remote/empty.bin");

      assert.strictEqual(uploadWasCalled, true);
      assert.strictEqual(result.fileId, "empty-id");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans up unfinished multipart uploads after a part failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-multipart-fail-"));
    const localPath = path.join(dir, "large.bin");
    fs.writeFileSync(localPath, Buffer.alloc(STREAMING_UPLOAD_PART_SIZE + 1, 7));

    const sim = new B2Simulator({
      minimumPartSize: 1024,
      recommendedPartSize: STREAMING_UPLOAD_PART_SIZE,
    });
    const client = new B2Client({
      applicationKeyId: "test",
      applicationKey: "test",
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    });
    await client.authorize();
    const bucket = await client.createBucket({
      bucketName: "bucket",
      bucketType: "allPrivate",
    });
    sim.injectFailure({
      on: "b2_upload_part",
      status: 503,
      code: "service_unavailable",
      message: "simulated part failure",
      count: 1,
    });

    try {
      await assert.rejects(
        () => uploadFileFromDisk(bucket, localPath, "remote/large.bin"),
        /simulated part failure|service_unavailable/i,
      );

      const unfinished = await bucket.listUnfinishedLargeFiles({
        namePrefix: "remote/large.bin",
      });
      assert.deepStrictEqual(unfinished.files, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("observes upload done rejection when pipeTo fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-reject-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let unhandled: unknown;
    const onUnhandled = (error: unknown) => {
      unhandled = error;
    };
    process.once("unhandledRejection", onUnhandled);

    const bucket = {
      async upload() {
        assert.fail("Expected non-empty files to use the streaming upload path");
      },
      file() {
        const done = new Promise<FileVersion>((_resolve, reject) => {
          setTimeout(() => reject(new Error("done failed")), 0);
        });

        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("pipe failed");
                },
              }),
              done,
            };
          },
        };
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () => uploadFileFromDisk(bucket, localPath, "remote/file.bin"),
        /pipe failed/i,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(unhandled, undefined);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects B2 object keys that escape the temp cache", async () => {
    const manager = new TempFileManager();
    const outsidePath = path.join(os.tmpdir(), `b2-vscode-outside-${Date.now()}`, "owned.txt");
    const maliciousKey = `../../${path.basename(path.dirname(outsidePath))}/owned.txt`;

    try {
      await assert.rejects(
        () =>
          manager.saveStream(
            "bucket",
            maliciousKey,
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
              },
            }),
          ),
        /path traversal|relative path inside/i,
      );

      assert.strictEqual(fs.existsSync(outsidePath), false);
      assert.strictEqual(manager.getCachedPath("bucket", maliciousKey), undefined);
    } finally {
      manager.dispose();
      fs.rmSync(path.dirname(outsidePath), { recursive: true, force: true });
    }
  });

  test("rejects symlinked temp cache roots", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-cache-symlink-"));
    const target = path.join(dir, "target");
    const linkPath = path.join(dir, "link");
    fs.mkdirSync(target);
    const symlinkCreated = createDirectorySymlink(target, linkPath);
    if (!symlinkCreated) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    try {
      assert.throws(() => new TempFileManager(linkPath), /real directory|symlink/i);
      assert.deepStrictEqual(fs.readdirSync(target), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects temp cache roots outside system temp", () => {
    const unsafeRoot = path.parse(os.tmpdir()).root;

    assert.throws(
      () => new TempFileManager(unsafeRoot),
      /dedicated directory inside the system temp directory/i,
    );
  });

  test("rejects symlinked bucket cache directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-bucket-symlink-"));
    const tempRoot = path.join(dir, "cache");
    const target = path.join(dir, "target");
    const bucketLink = path.join(tempRoot, "bucket");
    fs.mkdirSync(tempRoot);
    fs.mkdirSync(target);
    const symlinkCreated = createDirectorySymlink(target, bucketLink);
    const manager = new TempFileManager(tempRoot);

    try {
      if (!symlinkCreated) {
        return;
      }

      await assert.rejects(
        () =>
          manager.saveStream(
            "bucket",
            "file.txt",
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
              },
            }),
          ),
        /real directory|symlink/i,
      );

      assert.deepStrictEqual(fs.readdirSync(target), []);
      assert.strictEqual(manager.getCachedPath("bucket", "file.txt"), undefined);
    } finally {
      manager.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("times out stalled downloads and leaves no destination", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-stall-"));
    const destination = path.join(dir, "stalled.bin");
    const stream = new ReadableStream<Uint8Array>();

    try {
      await assert.rejects(
        () => downloadStreamToFile(stream, destination, { stallTimeoutMs: 20 }),
        TransferStallTimeoutError,
      );
      assert.strictEqual(fs.existsSync(destination), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans stale managed transfer temp files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-transfer-cleanup-"));
    const stale = path.join(dir, "b2-transfer-1-stale.tmp");
    const fresh = path.join(dir, "b2-transfer-1-fresh.tmp");
    const complete = path.join(dir, "complete.bin");
    fs.writeFileSync(stale, "stale");
    fs.writeFileSync(fresh, "fresh");
    fs.writeFileSync(complete, "complete");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(stale, oldTime, oldTime);

    try {
      await cleanupStaleTransferTempFiles({ directory: dir, maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(stale), false);
      assert.strictEqual(fs.existsSync(fresh), true);
      assert.strictEqual(fs.existsSync(complete), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans stale destination temp files and restores orphaned backups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-cleanup-"));
    const crossDevice = path.join(dir, ".b2-cross-device-file.bin-1-abcdefabcdef.tmp");
    const orphanedBackup = path.join(dir, ".b2-replace-backup-file.bin-1-abcdefabcdef.tmp");
    const completedDestination = path.join(dir, "complete.bin");
    const completedBackup = path.join(
      dir,
      ".b2-replace-backup-complete.bin-1-abcdefabcdef.tmp",
    );
    const freshTemp = path.join(dir, ".b2-cross-device-fresh.bin-1-abcdefabcdef.tmp");
    fs.writeFileSync(crossDevice, "partial");
    fs.writeFileSync(orphanedBackup, "original");
    fs.writeFileSync(completedDestination, "new");
    fs.writeFileSync(completedBackup, "old");
    fs.writeFileSync(freshTemp, "active");
    const oldTime = new Date(Date.now() - 10_000);
    for (const filePath of [crossDevice, orphanedBackup, completedBackup]) {
      fs.utimesSync(filePath, oldTime, oldTime);
    }

    try {
      await cleanupStaleDestinationTempFiles({ directory: dir, maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(crossDevice), false);
      assert.strictEqual(fs.existsSync(orphanedBackup), false);
      assert.strictEqual(fs.readFileSync(path.join(dir, "file.bin"), "utf8"), "original");
      assert.strictEqual(fs.readFileSync(completedDestination, "utf8"), "new");
      assert.strictEqual(fs.existsSync(completedBackup), false);
      assert.strictEqual(fs.readFileSync(freshTemp, "utf8"), "active");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports only requested progress cancellations as CancellationError", async () => {
    const tokenSource = new vscode.CancellationTokenSource();
    let restore = stubWithProgress(tokenSource);

    try {
      await assert.rejects(
        () =>
          withCancellableTransferProgress({ title: "Cancel test" }, async ({ signal }) => {
            tokenSource.cancel();
            signal.throwIfAborted();
          }),
        vscode.CancellationError,
      );
    } finally {
      restore();
      tokenSource.dispose();
    }

    restore = stubWithProgress();

    try {
      await assert.rejects(
        () =>
          withCancellableTransferProgress({ title: "Abort-like failure" }, async () => {
            const error = new Error("network timeout");
            error.name = "AbortError";
            throw error;
          }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.strictEqual(error.name, "AbortError");
          assert.match(error.message, /network timeout/);
          assert.ok(!(error instanceof vscode.CancellationError));
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});
