/**
 * Tests for B2 client configuration safety.
 *
 * @module test/suite/b2
 */

import * as assert from "assert";
import * as crypto from "crypto";
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
  cleanupStaleUnfinishedUploads,
  cleanupWorkspaceDestinationTempFiles,
  cleanupWorkspaceTransferTempFiles,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  downloadStreamToNewFileWithinRoot,
  DownloadSizeLimitError,
  downloadStreamToFile,
  getUnfinishedUploadCleanupDiagnostics,
  openUploadSourceFile,
  STREAMING_UPLOAD_PART_SIZE,
  TRANSFER_TEMP_DIR_NAME,
  TransferStallTimeoutError,
  UploadIndeterminateError,
  uploadEmptyObject,
  uploadFileHandle,
  uploadFileFromDisk,
  withTransferStallTimeout,
  type UploadBucketHandle,
} from "../../services/fileTransfers";
import { withCancellableTransferProgress } from "../../services/transferProgress";
import { createActivityAbortSignal, withTimeout } from "../../services/transferTimeout";
import { cleanupStaleTempFileCache, TempFileManager } from "../../services/tempFileManager";
import {
  assertSafeFileWritePath,
  ensurePrivateDirectory,
  ensurePrivateDirectorySync,
  isPathInsideOrEqual,
} from "../../services/pathSafety";
import { humanSize } from "../../utils/humanSize";
import {
  cleanupStalePrivateTempRoots,
  createPrivateTempRoot,
  releasePrivateTempRoot,
} from "../../utils/privateTempRoot";
import { B2ToolInputError } from "../../errors";
import type { B2Credentials } from "../../services/authService";
import {
  cleanupStaleUnfinishedUploadsForClient,
  STALE_UNFINISHED_UPLOAD_SWEEP_BUDGET_MS,
  STALE_UNFINISHED_UPLOAD_SWEEP_MAX_BUCKETS,
} from "../../extension";
import { stubWarningMessage, type WarningMessageCall } from "./windowStubs";

const CUSTOM_API_URL = "https://b2-compatible.example.com";
const ATTACKER_API_URL = "https://attacker.example.com";
const TEST_CREDENTIALS: B2Credentials = { keyId: "key-id", appKey: "app-key" };
const TEST_VERSION = "0.0.1";

function uploadSessionMarkerPathForTest(remotePath: string, uploadSessionId: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(remotePath)
    .update("\0")
    .update(uploadSessionId)
    .digest("hex");
  return path.join(os.tmpdir(), "b2-vscode-upload-sessions", `session-${digest}.json`);
}

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

function createFileSymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "ENOTSUP" || code === "EPERM") {
      return false;
    }
    throw error;
  }
}

async function captureConsoleErrors(run: () => Promise<void>): Promise<unknown[][]> {
  const originalError = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  try {
    await run();
    return calls;
  } finally {
    console.error = originalError;
  }
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

function stubWithProgress(tokenSource?: vscode.CancellationTokenSource): () => void {
  const ownedTokenSource = tokenSource ?? new vscode.CancellationTokenSource();
  const mutableWindow = vscode.window as unknown as {
    withProgress: typeof vscode.window.withProgress;
  };
  const originalWithProgress = mutableWindow.withProgress;

  mutableWindow.withProgress = ((_options, task) =>
    task({ report: () => undefined }, ownedTokenSource.token)) as typeof vscode.window.withProgress;

  return () => {
    mutableWindow.withProgress = originalWithProgress;
    if (!tokenSource) {
      ownedTokenSource.dispose();
    }
  };
}

suite("B2 utility helpers", () => {
  test("formats fractional byte values without invalid units", () => {
    assert.strictEqual(humanSize(0.5), "1 B");
    assert.strictEqual(humanSize(-1), "0 B");
    assert.strictEqual(humanSize(Number.NaN), "0 B");
    assert.strictEqual(humanSize(Number.POSITIVE_INFINITY), "0 B");
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

  test("rejects safe write paths through symlinked parents", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-safe-write-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-safe-write-outside-"));
    const linkPath = path.join(workspaceDir, "linked");
    const symlinkCreated = createDirectorySymlink(outsideDir, linkPath);

    try {
      if (!symlinkCreated) {
        return;
      }

      await assert.rejects(
        () => assertSafeFileWritePath(workspaceDir, path.join(linkPath, "file.txt")),
        /outside the workspace|outside the allowed root|real workspace directory|symlink/i,
      );
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
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

  test("refuses existing destinations when overwrite is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-no-overwrite-"));
    const destination = path.join(dir, "file.bin");
    fs.writeFileSync(destination, Buffer.from([1, 2, 3]));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([6, 7, 8]));
        controller.close();
      },
    });

    try {
      await assert.rejects(
        () => downloadStreamToFile(stream, destination, { overwrite: false }),
        /EEXIST|file already exists/i,
      );

      assert.deepStrictEqual([...fs.readFileSync(destination)], [1, 2, 3]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes partial downloads when the byte limit is exceeded", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-limit-"));
    const destination = path.join(dir, "limited.bin");
    const tempDir = path.join(dir, "tmp");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(4, 1));
        controller.enqueue(Buffer.alloc(4, 2));
        controller.enqueue(Buffer.alloc(1, 3));
        controller.close();
      },
    });

    try {
      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            maxBytes: 8,
            temporaryDirectory: tempDir,
          }),
        (error) => {
          assert.ok(error instanceof DownloadSizeLimitError);
          assert.match(error.message, /Download to limited\.bin exceeded the 8 B limit/i);
          assert.strictEqual(error.message.includes(dir), false);
          return true;
        },
      );

      assert.strictEqual(fs.existsSync(destination), false);
      assert.deepStrictEqual(
        fs.existsSync(tempDir)
          ? fs.readdirSync(tempDir).filter((name) => name.startsWith("b2-transfer-"))
          : [],
        [],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects known oversized downloads without waiting for stream cancel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-known-limit-"));
    const destination = path.join(dir, "known-limited.bin");
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
        return new Promise(() => undefined);
      },
    });

    try {
      await assert.rejects(
        () =>
          withTimeout(
            () =>
              downloadStreamToFile(stream, destination, {
                knownBytes: 9,
                maxBytes: 8,
              }),
            100,
            "known oversized download rejection",
          ),
        DownloadSizeLimitError,
      );

      assert.strictEqual(cancelCalled, true);
      assert.strictEqual(fs.existsSync(destination), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects destination filenames reserved for transfer internals", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-reserved-download-"));
    const destination = path.join(dir, ".b2-replace-backup-.env-1-deadbeef.tmp");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    try {
      await assert.rejects(
        () => downloadStreamToFile(stream, destination),
        /reserved B2 transfer temp pattern/i,
      );

      assert.strictEqual(fs.existsSync(destination), false);
      assert.strictEqual(fs.existsSync(path.join(dir, ".env")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("documents the default download size cap", () => {
    assert.strictEqual(DEFAULT_DOWNLOAD_MAX_BYTES, 1024 * 1024 * 1024);
  });

  test("reports invalid download byte limits as tool input errors", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-limit-input-"));
    const destination = path.join(dir, "limited.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("not used"));
        controller.close();
      },
    });

    try {
      await assert.rejects(
        () => downloadStreamToFile(stream, destination, { maxBytes: 0 }),
        (error) => {
          assert.ok(error instanceof B2ToolInputError);
          assert.strictEqual((error as NodeJS.ErrnoException).code, "ERR_B2_TOOL_INPUT");
          assert.match((error as Error).message, /positive integer/i);
          return true;
        },
      );
      assert.strictEqual(fs.existsSync(destination), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("validates destination parent before creating adjacent temp directory", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-temp-bind-"));
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "b2-vscode-download-temp-bind-outside-"),
    );
    const downloadDir = path.join(workspaceDir, "downloads");
    const destination = path.join(downloadDir, "payload.bin");
    const tempDir = path.join(downloadDir, ".b2-vscode-transfers");
    const outsideTempDir = path.join(outsideDir, ".b2-vscode-transfers");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("do not create temp outside"));
        controller.close();
      },
    });

    try {
      const symlinkSupported = createDirectorySymlink(outsideDir, downloadDir);
      if (!symlinkSupported) {
        return;
      }

      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            allowedRootDirectory: workspaceDir,
            temporaryDirectory: tempDir,
          }),
        (error) => {
          assert.strictEqual((error as NodeJS.ErrnoException).code, "ERR_B2_TOOL_INPUT");
          assert.match(
            (error as Error).message,
            /inside Workspace download directory|real directory|symlink/i,
          );
          return true;
        },
      );

      assert.strictEqual(fs.existsSync(outsideTempDir), false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("does not write outside when destination parent is swapped after reservation", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-bind-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-bind-outside-"));
    const downloadDir = path.join(workspaceDir, "downloads");
    const movedDownloadDir = path.join(workspaceDir, "downloads-original");
    const destination = path.join(downloadDir, "payload.bin");
    const outsideTarget = path.join(outsideDir, "payload.bin");
    const probeLink = path.join(workspaceDir, "probe");
    fs.mkdirSync(downloadDir);
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    let swapped = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!swapped) {
          swapped = true;
          fs.renameSync(downloadDir, movedDownloadDir);
          fs.symlinkSync(
            outsideDir,
            downloadDir,
            process.platform === "win32" ? "junction" : "dir",
          );
          controller.enqueue(Buffer.from("do not escape"));
        }
        controller.close();
      },
    });

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { recursive: true, force: true });

      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            allowedRootDirectory: workspaceDir,
            overwrite: false,
          }),
        (error) => {
          assert.strictEqual((error as NodeJS.ErrnoException).code, "ERR_B2_TOOL_INPUT");
          assert.match((error as Error).message, /changed during transfer|real directory|symlink/i);
          return true;
        },
      );

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.existsSync(outsideTarget), false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects parent symlink swaps before no-overwrite publish", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-publish-bind-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-publish-outside-"));
    const downloadDir = path.join(workspaceDir, "downloads");
    const movedDownloadDir = path.join(workspaceDir, "downloads-original");
    const destination = path.join(downloadDir, "payload.bin");
    const outsideTarget = path.join(outsideDir, "payload.bin");
    const probeLink = path.join(workspaceDir, "probe");
    fs.mkdirSync(downloadDir);
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    const originalLstat = fs.promises.lstat;
    const mutablePromises = fs.promises as unknown as {
      lstat: typeof fs.promises.lstat;
    };
    let downloaded = false;
    let swapped = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        downloaded = true;
        controller.enqueue(Buffer.from("do not publish outside"));
        controller.close();
      },
    });

    mutablePromises.lstat = (async (...args: Parameters<typeof fs.promises.lstat>) => {
      if (downloaded && !swapped && path.resolve(String(args[0])) === path.resolve(destination)) {
        swapped = true;
        fs.renameSync(downloadDir, movedDownloadDir);
        fs.symlinkSync(outsideDir, downloadDir, process.platform === "win32" ? "junction" : "dir");
      }
      return originalLstat(...args);
    }) as typeof fs.promises.lstat;

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { recursive: true, force: true });

      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            allowedRootDirectory: workspaceDir,
            overwrite: false,
          }),
        /outside the allowed root|real directory|symlink|ENOENT|no such file/i,
      );

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.existsSync(outsideTarget), false);
    } finally {
      mutablePromises.lstat = originalLstat;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects destination symlink swaps before root-bound no-overwrite publish", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-publish-file-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-publish-file-outside-"));
    const downloadDir = path.join(workspaceDir, "downloads");
    const destination = path.join(downloadDir, "payload.bin");
    const outsideTarget = path.join(outsideDir, "payload.bin");
    const probeLink = path.join(workspaceDir, "probe");
    fs.mkdirSync(downloadDir);
    fs.writeFileSync(outsideTarget, "outside");
    const symlinkSupported = createFileSymlink(outsideTarget, probeLink);
    const originalOpen = fs.promises.open;
    const mutablePromises = fs.promises as unknown as {
      open: typeof fs.promises.open;
    };
    let downloaded = false;
    let swapped = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        downloaded = true;
        controller.enqueue(Buffer.from("do not publish outside"));
        controller.close();
      },
    });

    mutablePromises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const openedPath = String(args[0]);
      if (downloaded && !swapped && path.resolve(openedPath) === path.resolve(destination)) {
        swapped = createFileSymlink(outsideTarget, destination);
        if (!swapped) {
          throw new Error("File symlink creation became unavailable.");
        }
      }
      return originalOpen(...args);
    }) as typeof fs.promises.open;

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { force: true });

      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            allowedRootDirectory: workspaceDir,
            overwrite: false,
          }),
        /EEXIST|ELOOP|file already exists|symbolic link|symlink/i,
      );

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.readFileSync(outsideTarget, "utf8"), "outside");
    } finally {
      mutablePromises.open = originalOpen;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("removes root-bound files opened through parent symlink races", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-publish-open-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-publish-open-outside-"));
    const downloadDir = path.join(workspaceDir, "downloads");
    const movedDownloadDir = path.join(workspaceDir, "downloads-original");
    const destination = path.join(downloadDir, "payload.bin");
    const outsideTarget = path.join(outsideDir, "payload.bin");
    const probeLink = path.join(workspaceDir, "probe");
    fs.mkdirSync(downloadDir);
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    const originalOpen = fs.promises.open;
    const mutablePromises = fs.promises as unknown as {
      open: typeof fs.promises.open;
    };
    let swapped = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("do not publish outside"));
        controller.close();
      },
    });

    mutablePromises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const openedPath = String(args[0]);
      if (!swapped && path.resolve(openedPath) === path.resolve(destination)) {
        swapped = true;
        fs.renameSync(downloadDir, movedDownloadDir);
        fs.symlinkSync(outsideDir, downloadDir, process.platform === "win32" ? "junction" : "dir");
      }
      return originalOpen(...args);
    }) as typeof fs.promises.open;

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { recursive: true, force: true });

      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            allowedRootDirectory: workspaceDir,
            overwrite: false,
          }),
        /outside the allowed root|changed while it was being opened|real directory|symlink/i,
      );

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.existsSync(outsideTarget), false);
    } finally {
      mutablePromises.open = originalOpen;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("does not create workspace transfer temp dir after parent swap", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-temp-race-"));
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "b2-vscode-download-temp-race-outside-"),
    );
    const downloadDir = path.join(workspaceDir, "downloads");
    const movedDownloadDir = path.join(workspaceDir, "downloads-original");
    const destination = path.join(downloadDir, "payload.bin");
    const tempDir = path.join(downloadDir, ".b2-vscode-transfers");
    const outsideTempDir = path.join(outsideDir, ".b2-vscode-transfers");
    const probeLink = path.join(workspaceDir, "probe");
    fs.mkdirSync(downloadDir);
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    const originalOpendir = fs.promises.opendir;
    let swapped = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("do not create temp outside"));
        controller.close();
      },
    });

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { recursive: true, force: true });

      fs.promises.opendir = (async (...args: Parameters<typeof fs.promises.opendir>) => {
        const directory = args[0];
        if (!swapped && path.resolve(String(directory)) === path.resolve(downloadDir)) {
          swapped = true;
          fs.renameSync(downloadDir, movedDownloadDir);
          fs.symlinkSync(
            outsideDir,
            downloadDir,
            process.platform === "win32" ? "junction" : "dir",
          );
        }

        return originalOpendir(...args);
      }) as typeof fs.promises.opendir;

      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            allowedRootDirectory: workspaceDir,
            temporaryDirectory: tempDir,
          }),
        (error) => {
          assert.strictEqual((error as NodeJS.ErrnoException).code, "ERR_B2_TOOL_INPUT");
          assert.match(
            (error as Error).message,
            /Workspace transfer temp directory|real directory|symlink|outside the allowed root/i,
          );
          return true;
        },
      );

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.existsSync(outsideTempDir), false);
      assert.strictEqual(fs.existsSync(destination), false);
    } finally {
      fs.promises.opendir = originalOpendir;
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("stages no-overwrite downloads before publishing the destination", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-reserved-direct-"));
    const destination = path.join(dir, "file.bin");
    const tempDir = path.join(dir, "tmp");
    let checkedBeforeComplete = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!checkedBeforeComplete) {
          checkedBeforeComplete = true;
          assert.strictEqual(fs.existsSync(destination), false);
        }
        controller.enqueue(Buffer.from([1, 2, 3]));
        controller.close();
      },
    });

    try {
      const size = await downloadStreamToFile(stream, destination, {
        overwrite: false,
        temporaryDirectory: tempDir,
      });

      assert.strictEqual(size, 3);
      assert.strictEqual(checkedBeforeComplete, true);
      assert.deepStrictEqual([...fs.readFileSync(destination)], [1, 2, 3]);
      assert.deepStrictEqual(
        fs.existsSync(tempDir)
          ? fs.readdirSync(tempDir).filter((name) => name.startsWith("b2-transfer-"))
          : [],
        [],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("root-bound downloads write new files without exposing a loose overwrite mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-root-"));
    const destination = path.join(dir, "nested", "file.bin");
    const existing = path.join(dir, "existing.bin");
    const originalLink = fs.promises.link;
    const originalCopyFile = fs.promises.copyFile;
    const originalOpen = fs.promises.open;
    let linkCalls = 0;
    let destinationCopyFileCalls = 0;
    let destinationTempOpenCalls = 0;
    fs.writeFileSync(existing, Buffer.from([1]));
    fs.promises.link = async (): Promise<void> => {
      linkCalls += 1;
      throw new Error("root-bound downloads must not hardlink into place");
    };
    fs.promises.copyFile = async (
      sourcePath: fs.PathLike,
      destinationPath: fs.PathLike,
      mode?: number,
    ): Promise<void> => {
      if (path.resolve(String(destinationPath)) === path.resolve(destination)) {
        destinationCopyFileCalls += 1;
        throw new Error("root-bound downloads must not copyFile into place");
      }
      await originalCopyFile(sourcePath, destinationPath, mode);
    };
    fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const openedPath = String(args[0]);
      if (path.basename(openedPath).startsWith(".b2-cross-device-file.bin-")) {
        destinationTempOpenCalls += 1;
        throw new Error("root-bound downloads must publish directly from the staged temp");
      }
      return originalOpen(...args);
    }) as typeof fs.promises.open;

    try {
      const size = await downloadStreamToNewFileWithinRoot(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([6, 7, 8]));
            controller.close();
          },
        }),
        destination,
        dir,
      );

      assert.strictEqual(size, 3);
      assert.strictEqual(linkCalls, 0);
      assert.strictEqual(destinationCopyFileCalls, 0);
      assert.strictEqual(destinationTempOpenCalls, 0);
      assert.deepStrictEqual([...fs.readFileSync(destination)], [6, 7, 8]);
      assert.strictEqual(
        fs.existsSync(path.join(dir, TRANSFER_TEMP_DIR_NAME)),
        false,
        "root-bound downloads should remove the workspace transfer directory when it is empty",
      );
      assert.deepStrictEqual(
        fs.readdirSync(path.dirname(destination)).filter((name) => name.startsWith("b2-transfer-")),
        [],
      );

      await assert.rejects(
        () =>
          downloadStreamToNewFileWithinRoot(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([9]));
                controller.close();
              },
            }),
            existing,
            dir,
          ),
        /EEXIST|file already exists/i,
      );
      assert.deepStrictEqual([...fs.readFileSync(existing)], [1]);
    } finally {
      fs.promises.link = originalLink;
      fs.promises.copyFile = originalCopyFile;
      fs.promises.open = originalOpen;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses hardlink fast path when overwrite is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-link-"));
    const destination = path.join(dir, "file.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([6, 7, 8]));
        controller.close();
      },
    });
    const originalLink = fs.promises.link;
    let linkCalls = 0;
    fs.promises.link = async (existingPath: fs.PathLike, newPath: fs.PathLike): Promise<void> => {
      linkCalls += 1;
      assert.strictEqual(path.resolve(String(newPath)), path.resolve(destination));
      await fs.promises.copyFile(existingPath, newPath, fs.constants.COPYFILE_EXCL);
    };

    try {
      const size = await downloadStreamToFile(stream, destination, { overwrite: false });

      assert.strictEqual(size, 3);
      assert.strictEqual(linkCalls, 1);
      assert.deepStrictEqual([...fs.readFileSync(destination)], [6, 7, 8]);
    } finally {
      fs.promises.link = originalLink;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes staged no-overwrite downloads on interruption", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-reserved-abort-"));
    const destination = path.join(dir, "file.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(Buffer.from("downloaded"));
        streamController.error(new Error("download interrupted"));
      },
    });

    try {
      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            overwrite: false,
          }),
        /download interrupted/i,
      );

      assert.strictEqual(fs.existsSync(destination), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to no-follow copy when hardlink is unavailable", async () => {
    const originalLink = fs.promises.link;

    try {
      for (const code of ["EXDEV", "EPERM", "EOPNOTSUPP", "ENOTSUP", "EINVAL", "EACCES"]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-link-fallback-"));
        const destination = path.join(dir, "file.bin");
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([9, 8, 7]));
            controller.close();
          },
        });
        let linkCalls = 0;
        fs.promises.link = async (): Promise<void> => {
          linkCalls += 1;
          throw Object.assign(new Error(`hardlink unavailable: ${code}`), { code });
        };

        try {
          const size = await downloadStreamToFile(stream, destination, { overwrite: false });

          assert.strictEqual(size, 3);
          assert.strictEqual(linkCalls, 2);
          assert.deepStrictEqual([...fs.readFileSync(destination)], [9, 8, 7]);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      fs.promises.link = originalLink;
    }
  });

  test("does not overwrite destination created during hardlink fallback publish", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-publish-race-"));
    const destination = path.join(dir, "file.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    const originalLink = fs.promises.link;
    const originalCopyFile = fs.promises.copyFile;
    let destinationTempPath = "";

    fs.promises.link = async (existingPath: fs.PathLike, newPath: fs.PathLike): Promise<void> => {
      if (
        path.resolve(String(newPath)) === path.resolve(destination) &&
        path.basename(String(existingPath)).startsWith(".b2-cross-device-")
      ) {
        destinationTempPath = String(existingPath);
      }
      throw Object.assign(new Error("hardlink unavailable"), { code: "EXDEV" });
    };
    fs.promises.copyFile = async (
      src: fs.PathLike,
      dest: fs.PathLike,
      mode?: number,
    ): Promise<void> => {
      if (path.resolve(String(dest)) === path.resolve(destination)) {
        assert.strictEqual(path.basename(String(src)).startsWith(".b2-cross-device-"), true);
        assert.strictEqual(mode, fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(destination, Buffer.from([1, 1, 1]));
      }
      await originalCopyFile(src, dest, mode);
    };

    try {
      await assert.rejects(
        () => downloadStreamToFile(stream, destination, { overwrite: false }),
        /EEXIST|file already exists/i,
      );

      assert.deepStrictEqual([...fs.readFileSync(destination)], [1, 1, 1]);
      assert.strictEqual(fs.existsSync(destinationTempPath), false);
    } finally {
      fs.promises.link = originalLink;
      fs.promises.copyFile = originalCopyFile;
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
      assert.strictEqual(renameCalls, 3);
      assert.strictEqual(
        fs.readdirSync(dir).some((name) => name.startsWith(".b2-replace-backup-")),
        false,
      );
    } finally {
      fs.promises.rename = originalRename;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to replace existing directory destinations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-overwrite-directory-"));
    const destination = path.join(dir, "existing");
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "kept.txt"), "kept");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([6, 7, 8]));
        controller.close();
      },
    });
    const originalRename = fs.promises.rename;
    let destinationRenameAttempts = 0;
    fs.promises.rename = async (oldPath: fs.PathLike, newPath: fs.PathLike): Promise<void> => {
      const newResolved = path.resolve(String(newPath));
      if (newResolved === path.resolve(destination)) {
        destinationRenameAttempts += 1;
        throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
      }

      await originalRename(oldPath, newPath);
    };

    try {
      await assert.rejects(() => downloadStreamToFile(stream, destination), /regular file/i);

      assert.strictEqual(destinationRenameAttempts, 1);
      assert.strictEqual(fs.lstatSync(destination).isDirectory(), true);
      assert.strictEqual(fs.readFileSync(path.join(destination, "kept.txt"), "utf8"), "kept");
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
    let backupPath = "";
    let destinationRenameAttempts = 0;
    fs.promises.rename = async (oldPath: fs.PathLike, newPath: fs.PathLike): Promise<void> => {
      const oldResolved = path.resolve(String(oldPath));
      const newResolved = path.resolve(String(newPath));
      const backupResolved = backupPath ? path.resolve(backupPath) : "";

      if (
        oldResolved === path.resolve(destination) &&
        path.basename(String(newPath)).startsWith(".b2-replace-backup-")
      ) {
        backupPath = String(newPath);
      }

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

  test("refuses transfer temp directories when permissions cannot be restricted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-transfer-private-"));
    const temporaryDirectory = path.join(dir, "shared");
    const destination = path.join(dir, "download.bin");
    fs.mkdirSync(temporaryDirectory, { mode: 0o777 });
    const originalChmod = fs.promises.chmod;
    fs.promises.chmod = async (target: fs.PathLike, mode: fs.Mode): Promise<void> => {
      if (path.resolve(String(target)) === path.resolve(temporaryDirectory)) {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      await originalChmod(target, mode);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    try {
      await assert.rejects(
        () => downloadStreamToFile(stream, destination, { temporaryDirectory }),
        /permissions.*restricted/i,
      );

      assert.strictEqual(fs.existsSync(destination), false);
      assert.deepStrictEqual(fs.readdirSync(temporaryDirectory), []);
    } finally {
      fs.promises.chmod = originalChmod;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts already-private directories when chmod is unsupported", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-private-chmod-"));
    const asyncDirectory = path.join(dir, "async");
    const syncDirectory = path.join(dir, "sync");
    fs.mkdirSync(asyncDirectory, { mode: 0o700 });
    fs.mkdirSync(syncDirectory, { mode: 0o700 });
    fs.chmodSync(asyncDirectory, 0o700);
    fs.chmodSync(syncDirectory, 0o700);

    const mutableFs = require("fs") as typeof fs & {
      chmodSync: (target: fs.PathLike, mode: fs.Mode) => void;
    };
    const originalAsyncChmod = fs.promises.chmod;
    const originalSyncChmod = mutableFs.chmodSync;
    fs.promises.chmod = async (target: fs.PathLike, mode: fs.Mode): Promise<void> => {
      if (path.resolve(String(target)) === path.resolve(asyncDirectory)) {
        throw Object.assign(new Error("chmod unsupported"), { code: "ENOTSUP" });
      }
      await originalAsyncChmod(target, mode);
    };
    mutableFs.chmodSync = (target: fs.PathLike, mode: fs.Mode): void => {
      if (path.resolve(String(target)) === path.resolve(syncDirectory)) {
        throw Object.assign(new Error("chmod unsupported"), { code: "ENOTSUP" });
      }
      originalSyncChmod(target, mode);
    };

    try {
      await ensurePrivateDirectory(asyncDirectory, "Async private directory");
      ensurePrivateDirectorySync(syncDirectory, "Sync private directory");
    } finally {
      fs.promises.chmod = originalAsyncChmod;
      mutableFs.chmodSync = originalSyncChmod;
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

  test("bounds upload finalization after the local stream closes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-finalize-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    const fileHandle = await fs.promises.open(localPath, "r");
    const uploaded: number[] = [];

    const bucket = {
      file() {
        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>({
                write(chunk) {
                  uploaded.push(...chunk);
                },
              }),
              done: new Promise<FileVersion>(() => undefined),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () =>
          uploadFileHandle(bucket, fileHandle, localPath, "remote/file.bin", {
            stallTimeoutMs: 20,
          }),
        (error) => {
          assert.ok(error instanceof UploadIndeterminateError);
          assert.match(error.message, /may still complete in B2/i);
          return true;
        },
      );
      await assert.rejects(() => fileHandle.stat(), /closed|EBADF|file closed/i);
      assert.deepStrictEqual(uploaded, [1, 2, 3]);
    } finally {
      await fileHandle.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports symlink upload sources clearly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-symlink-source-"));
    const target = path.join(dir, "target.bin");
    const linkPath = path.join(dir, "link.bin");
    fs.writeFileSync(target, Buffer.from([1, 2, 3]));
    const symlinkCreated = createFileSymlink(target, linkPath);
    const originalOpen = fs.promises.open;
    let openCalled = false;
    fs.promises.open = ((...args: Parameters<typeof fs.promises.open>) => {
      openCalled = true;
      return originalOpen(...args);
    }) as typeof fs.promises.open;

    try {
      if (!symlinkCreated) {
        return;
      }

      await assert.rejects(
        () => openUploadSourceFile(linkPath),
        /upload source must be a real file, not a symlink/i,
      );
      assert.strictEqual(openCalled, false);
    } finally {
      fs.promises.open = originalOpen;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("background pre-upload cleanup scans only same-key unfinished uploads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-no-pre-clean-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    const uploaded: number[] = [];
    let cancelCalls = 0;
    let listCalls = 0;
    let cleanupObserved: (() => void) | undefined;
    const cleanupObservedPromise = new Promise<void>((resolve) => {
      cleanupObserved = resolve;
    });

    const bucket = {
      async listUnfinishedLargeFiles(options) {
        listCalls += 1;
        cleanupObserved?.();
        assert.strictEqual(options?.namePrefix, "remote/file.bin");
        return {
          files: [
            {
              fileId: largeFileId(`unrelated-${listCalls}`),
              fileName: "remote/file.bin-unrelated",
            },
          ],
          nextFileId: null,
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
      await cleanupObservedPromise;
      assert.strictEqual(listCalls, 1);
      assert.strictEqual(cancelCalls, 0);
      assert.deepStrictEqual(uploaded, [1, 2, 3]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not wait for slow same-key cleanup before streaming upload", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-slow-pre-clean-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    const uploaded: number[] = [];
    let resolveCleanup:
      | ((
          value:
            | { files: readonly []; nextFileId: null }
            | PromiseLike<{ files: readonly []; nextFileId: null }>,
        ) => void)
      | undefined;
    let cleanupStarted: (() => void) | undefined;
    const cleanupStartedPromise = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });

    const bucket = {
      listUnfinishedLargeFiles() {
        cleanupStarted?.();
        return new Promise<{ files: readonly []; nextFileId: null }>((resolve) => {
          resolveCleanup = resolve;
        });
      },
      async cancelLargeFile() {
        assert.fail("Expected stalled pre-upload cleanup not to cancel uploads");
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
      const upload = uploadFileFromDisk(bucket, localPath, "remote/file.bin", {
        unfinishedCleanupTimeoutMs: 500,
      });
      await cleanupStartedPromise;
      const result = await Promise.race([
        upload,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("upload waited for same-key cleanup")), 100);
        }),
      ]);

      assert.strictEqual(result.fileId, "uploaded-id");
      assert.deepStrictEqual(uploaded, [1, 2, 3]);
      resolveCleanup?.({ files: [], nextFileId: null });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      resolveCleanup?.({ files: [], nextFileId: null });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not cancel unmarked remote unfinished uploads before streaming", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-concurrent-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    const uploaded: number[] = [];
    let cancelCalls = 0;

    const bucket = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: largeFileId("fresh-upload"),
              fileName: "remote/file.bin",
              fileInfo: {
                "b2-vscode-upload-owner": "b2-vscode",
                "b2-vscode-upload-started-ms": String(Date.now()),
              },
            },
            {
              fileId: largeFileId("remote-upload"),
              fileName: "remote/file.bin",
              fileInfo: {
                "b2-vscode-upload-owner": "other-client",
                "b2-vscode-upload-started-ms": "1",
              },
            },
          ],
          nextFileId: null,
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
      const result = await uploadFileFromDisk(bucket, localPath, "remote/file.bin");
      assert.strictEqual(result.fileId, "uploaded-id");
      assert.strictEqual(cancelCalls, 0);
      assert.deepStrictEqual(uploaded, [1, 2, 3]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("continues upload when session marker cannot be written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-marker-fail-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([4, 5, 6]));
    const fileHandle = await fs.promises.open(localPath, "r");
    const originalOpen = fs.promises.open;
    const uploaded: number[] = [];

    fs.promises.open = (async (
      filePath: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ): Promise<fs.promises.FileHandle> => {
      if (String(filePath).includes("b2-vscode-upload-sessions")) {
        throw Object.assign(new Error("marker storage full"), { code: "ENOSPC" });
      }
      return originalOpen(filePath, flags, mode);
    }) as typeof fs.promises.open;

    const bucket = {
      async listUnfinishedLargeFiles() {
        return { files: [], nextFileId: null };
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
      const result = await uploadFileHandle(bucket, fileHandle, localPath, "remote/file.bin");

      assert.strictEqual(result.fileId, "uploaded-id");
      assert.deepStrictEqual(uploaded, [4, 5, 6]);
    } finally {
      fs.promises.open = originalOpen;
      await fileHandle.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale upload cleanup ignores attacker-supplied started markers", async () => {
    const staleId = largeFileId("stale-upload");
    let cancelCalls = 0;

    const bucket = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: staleId,
              fileName: "remote/file.bin",
              fileInfo: { "b2-vscode-upload-started-ms": "0" },
            },
          ],
          nextFileId: null,
        };
      },
      async cancelLargeFile() {
        cancelCalls += 1;
      },
      file() {
        assert.fail("Expected cleanup test not to open an upload stream");
      },
      async upload() {
        assert.fail("Expected cleanup test not to upload a file");
      },
    } satisfies UploadBucketHandle;

    await cleanupStaleUnfinishedUploads(bucket, {
      remotePath: "remote/file.bin",
      unfinishedCleanupMaxAgeMs: 1_000,
    });

    assert.strictEqual(cancelCalls, 0);
  });

  test("stale upload cleanup prunes old upload session markers", async () => {
    const markerDirectory = path.join(os.tmpdir(), "b2-vscode-upload-sessions");
    fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });

    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const staleMarker = path.join(markerDirectory, `session-${unique}-stale.json`);
    const freshMarker = path.join(markerDirectory, `session-${unique}-fresh.json`);
    const unrelatedFile = path.join(markerDirectory, `unrelated-${unique}.json`);
    fs.writeFileSync(staleMarker, "{}");
    fs.writeFileSync(freshMarker, "{}");
    fs.writeFileSync(unrelatedFile, "{}");

    const staleTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleMarker, staleTime, staleTime);

    const bucket = {
      async listUnfinishedLargeFiles() {
        return { files: [], nextFileId: null };
      },
      file() {
        assert.fail("Expected cleanup test not to open an upload stream");
      },
      async upload() {
        assert.fail("Expected cleanup test not to upload a file");
      },
    } satisfies UploadBucketHandle;

    try {
      await cleanupStaleUnfinishedUploads(bucket);

      assert.strictEqual(fs.existsSync(staleMarker), false);
      assert.strictEqual(fs.existsSync(freshMarker), true);
      assert.strictEqual(fs.existsSync(unrelatedFile), true);
    } finally {
      for (const filePath of [staleMarker, freshMarker, unrelatedFile]) {
        fs.rmSync(filePath, { force: true });
      }
    }
  });

  test("stale upload cleanup reclaims locally marked interrupted sessions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-reclaim-"));
    const localPath = path.join(dir, "file.bin");
    const remotePath = "remote/file.bin";
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let capturedFileInfo: Record<string, string> | undefined;

    const interruptedBucket = {
      async listUnfinishedLargeFiles() {
        return { files: [], nextFileId: null };
      },
      async cancelLargeFile() {
        assert.fail("First cleanup should not have a matching remote upload to cancel");
      },
      file(fileName: string) {
        assert.strictEqual(fileName, remotePath);
        return {
          createWriteStream(options) {
            capturedFileInfo = options?.fileInfo;
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("pipe failed before cleanup could cancel");
                },
              }),
              done: new Promise<FileVersion>(() => undefined),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () => uploadFileFromDisk(interruptedBucket, localPath, remotePath),
        /pipe failed/i,
      );
      assert.ok(capturedFileInfo);

      const reclaimed: unknown[] = [];
      const reclaimBucket = {
        async listUnfinishedLargeFiles() {
          return {
            files: [
              {
                fileId: largeFileId("locally-owned-stale-upload"),
                fileName: remotePath,
                fileInfo: capturedFileInfo,
              },
            ],
            nextFileId: null,
          };
        },
        async cancelLargeFile(fileId: unknown) {
          reclaimed.push(fileId);
        },
        file() {
          assert.fail("Expected cleanup test not to open an upload stream");
        },
        async upload() {
          assert.fail("Expected cleanup test not to upload a file");
        },
      } satisfies UploadBucketHandle;

      await cleanupStaleUnfinishedUploads(reclaimBucket, {
        remotePath,
        unfinishedCleanupMaxAgeMs: -1,
      });

      assert.deepStrictEqual(reclaimed, [largeFileId("locally-owned-stale-upload")]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale upload cleanup ignores symlinked upload session markers", async function () {
    if (process.platform === "win32") {
      this.skip();
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-symlink-marker-"));
    const localPath = path.join(dir, "file.bin");
    const remotePath = `remote/symlink-marker-${Date.now()}.bin`;
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let capturedFileInfo: Record<string, string> | undefined;

    const interruptedBucket = {
      async listUnfinishedLargeFiles() {
        return { files: [], nextFileId: null };
      },
      async cancelLargeFile() {
        assert.fail("First cleanup should not have a matching remote upload to cancel");
      },
      file(fileName: string) {
        assert.strictEqual(fileName, remotePath);
        return {
          createWriteStream(options) {
            capturedFileInfo = options?.fileInfo;
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("symlink marker setup failure");
                },
              }),
              done: new Promise<FileVersion>(() => undefined),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    let markerPath: string | undefined;
    let symlinkTargetPath: string | undefined;
    try {
      await assert.rejects(
        () => uploadFileFromDisk(interruptedBucket, localPath, remotePath),
        /symlink marker setup failure/i,
      );
      assert.ok(capturedFileInfo);
      const uploadSessionId = capturedFileInfo["b2-vscode-upload-session-id"];
      const startedMs = Number(capturedFileInfo["b2-vscode-upload-started-ms"]);
      assert.ok(uploadSessionId);
      assert.ok(Number.isFinite(startedMs));

      markerPath = uploadSessionMarkerPathForTest(remotePath, uploadSessionId);
      symlinkTargetPath = path.join(dir, "forged-marker.json");
      fs.writeFileSync(
        symlinkTargetPath,
        JSON.stringify({ remotePath, uploadSessionId, startedMs }),
      );
      fs.rmSync(markerPath, { force: true });
      fs.symlinkSync(symlinkTargetPath, markerPath);

      let cancelCalls = 0;
      const reclaimBucket = {
        async listUnfinishedLargeFiles() {
          return {
            files: [
              {
                fileId: largeFileId("symlink-marker-upload"),
                fileName: remotePath,
                fileInfo: capturedFileInfo,
              },
            ],
            nextFileId: null,
          };
        },
        async cancelLargeFile() {
          cancelCalls += 1;
        },
        file() {
          assert.fail("Expected cleanup test not to open an upload stream");
        },
        async upload() {
          assert.fail("Expected cleanup test not to upload a file");
        },
      } satisfies UploadBucketHandle;

      const result = await cleanupStaleUnfinishedUploads(reclaimBucket, {
        unfinishedCleanupMaxAgeMs: -1,
      });

      assert.strictEqual(cancelCalls, 0);
      assert.deepStrictEqual(result, {
        reclaimedOwnedStaleUploadCount: 0,
        ignoredUnownedStaleUploadCount: 1,
      });
    } finally {
      if (markerPath !== undefined) {
        fs.rmSync(markerPath, { force: true });
      }
      if (symlinkTargetPath !== undefined) {
        fs.rmSync(symlinkTargetPath, { force: true });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("activation stale-upload sweep reclaims marked uploads and ignores spoofed metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-activation-reclaim-"));
    const localPath = path.join(dir, "file.bin");
    const remotePath = "remote/file.bin";
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let capturedFileInfo: Record<string, string> | undefined;

    const interruptedBucket = {
      async listUnfinishedLargeFiles() {
        return { files: [], nextFileId: null };
      },
      async cancelLargeFile() {
        assert.fail("First cleanup should not have a matching remote upload to cancel");
      },
      file(fileName: string) {
        assert.strictEqual(fileName, remotePath);
        return {
          createWriteStream(options) {
            capturedFileInfo = options?.fileInfo;
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("activation marker setup failure");
                },
              }),
              done: new Promise<FileVersion>(() => undefined),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () => uploadFileFromDisk(interruptedBucket, localPath, remotePath),
        /activation marker setup failure/i,
      );
      assert.ok(capturedFileInfo);

      const reclaimed: unknown[] = [];
      let spoofedCancelCalls = 0;
      const reclaimBucket = {
        name: "reclaim-bucket",
        async listUnfinishedLargeFiles() {
          return {
            files: [
              {
                fileId: largeFileId("activation-reclaimed"),
                fileName: remotePath,
                fileInfo: capturedFileInfo,
              },
            ],
            nextFileId: null,
          };
        },
        async cancelLargeFile(fileId: unknown) {
          reclaimed.push(fileId);
        },
      } as unknown as UploadBucketHandle & { name: string };
      const spoofedBucket = {
        name: "spoofed-bucket",
        async listUnfinishedLargeFiles() {
          return {
            files: [
              {
                fileId: largeFileId("activation-spoofed"),
                fileName: "remote/spoofed.bin",
                fileInfo: {
                  "b2-vscode-upload-owner": "b2-vscode",
                  "b2-vscode-upload-session-id": "missing-local-marker",
                  "b2-vscode-upload-started-ms": "0",
                },
              },
            ],
            nextFileId: null,
          };
        },
        async cancelLargeFile() {
          spoofedCancelCalls += 1;
        },
      } as unknown as UploadBucketHandle & { name: string };
      const client = {
        async listBuckets() {
          return [reclaimBucket, spoofedBucket];
        },
      } as unknown as Pick<B2Client, "listBuckets">;

      const result = await cleanupStaleUnfinishedUploadsForClient(client, {
        unfinishedCleanupMaxAgeMs: -1,
      });

      assert.deepStrictEqual(reclaimed, [largeFileId("activation-reclaimed")]);
      assert.strictEqual(spoofedCancelCalls, 0);
      assert.deepStrictEqual(result, {
        bucketCount: 2,
        reclaimedOwnedStaleUploadCount: 1,
        ignoredUnownedStaleUploadCount: 1,
        failedBucketCount: 0,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("activation stale unfinished-upload sweep times out bucket listing", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: NodeJS.Timeout[] = [];
    let listBucketsCalled = false;
    const client = {
      listBuckets() {
        listBucketsCalled = true;
        return new Promise<never>(() => undefined);
      },
    } as unknown as Pick<B2Client, "listBuckets">;

    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      _timeout?: number,
      ...args: unknown[]
    ) => {
      const timer = originalSetTimeout(callback, 0, ...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout;

    try {
      const result = await cleanupStaleUnfinishedUploadsForClient(client);

      assert.strictEqual(listBucketsCalled, true);
      assert.deepStrictEqual(result, {
        bucketCount: 0,
        reclaimedOwnedStaleUploadCount: 0,
        ignoredUnownedStaleUploadCount: 0,
        failedBucketCount: 0,
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      for (const timer of timers) {
        originalClearTimeout(timer);
      }
    }
  });

  test("activation stale unfinished-upload sweep caps bucket count", async () => {
    let listCalls = 0;
    const buckets = Array.from(
      { length: STALE_UNFINISHED_UPLOAD_SWEEP_MAX_BUCKETS + 3 },
      (_, index) => ({
        name: `bucket-${index}`,
        async listUnfinishedLargeFiles() {
          listCalls += 1;
          return { files: [], nextFileId: null };
        },
        async cancelLargeFile() {
          assert.fail("Expected empty cleanup pages not to cancel uploads");
        },
      }),
    ) as unknown as Array<UploadBucketHandle & { name: string }>;
    const client = {
      async listBuckets() {
        return buckets;
      },
    } as unknown as Pick<B2Client, "listBuckets">;

    const result = await cleanupStaleUnfinishedUploadsForClient(client);

    assert.strictEqual(listCalls, STALE_UNFINISHED_UPLOAD_SWEEP_MAX_BUCKETS);
    assert.deepStrictEqual(result, {
      bucketCount: STALE_UNFINISHED_UPLOAD_SWEEP_MAX_BUCKETS,
      reclaimedOwnedStaleUploadCount: 0,
      ignoredUnownedStaleUploadCount: 0,
      failedBucketCount: 0,
    });
  });

  test("activation stale unfinished-upload sweep enforces aggregate budget", async () => {
    const originalNow = Date.now;
    let now = 10_000;
    let listCalls = 0;
    const buckets = [0, 1].map((index) => ({
      name: `bucket-${index}`,
      async listUnfinishedLargeFiles() {
        listCalls += 1;
        now += STALE_UNFINISHED_UPLOAD_SWEEP_BUDGET_MS + 1;
        return { files: [], nextFileId: null };
      },
      async cancelLargeFile() {
        assert.fail("Expected empty cleanup pages not to cancel uploads");
      },
    })) as unknown as Array<UploadBucketHandle & { name: string }>;
    const client = {
      async listBuckets() {
        return buckets;
      },
    } as unknown as Pick<B2Client, "listBuckets">;

    Date.now = () => now;
    try {
      const result = await cleanupStaleUnfinishedUploadsForClient(client);

      assert.strictEqual(listCalls, 1);
      assert.deepStrictEqual(result, {
        bucketCount: 1,
        reclaimedOwnedStaleUploadCount: 0,
        ignoredUnownedStaleUploadCount: 0,
        failedBucketCount: 0,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("activation stale unfinished-upload sweep reports missing capability once", async () => {
    let listCalls = 0;
    let missingCapabilityReports = 0;
    const buckets = [0, 1].map((index) => ({
      name: `bucket-${index}`,
      async listUnfinishedLargeFiles() {
        listCalls += 1;
        throw Object.assign(new Error("missing capability"), { code: "missing_capability" });
      },
      async cancelLargeFile() {
        assert.fail("Expected missing capability not to cancel uploads");
      },
    })) as unknown as Array<UploadBucketHandle & { name: string }>;
    const client = {
      async listBuckets() {
        return buckets;
      },
    } as unknown as Pick<B2Client, "listBuckets">;

    const result = await cleanupStaleUnfinishedUploadsForClient(client, {
      onMissingCapability: () => {
        missingCapabilityReports += 1;
      },
    });

    assert.strictEqual(listCalls, 2);
    assert.strictEqual(missingCapabilityReports, 1);
    assert.deepStrictEqual(result, {
      bucketCount: 2,
      reclaimedOwnedStaleUploadCount: 0,
      ignoredUnownedStaleUploadCount: 0,
      failedBucketCount: 0,
    });
  });

  test("does not trust spoofable remote unfinished upload metadata", async () => {
    const spoofedId = largeFileId("spoofed-upload");
    const otherSessionId = largeFileId("other-session-upload");
    const canceled: unknown[] = [];
    const now = Date.now();
    const spoofedFileInfo: Record<string, string> = {
      "b2-vscode-upload-started-ms": String(now - 10_000),
    };
    const otherSessionFileInfo: Record<string, string> = {
      "b2-vscode-upload-session-id": "different-session",
    };
    let listCalls = 0;

    const bucket = {
      async listUnfinishedLargeFiles(options) {
        listCalls += 1;
        assert.strictEqual(options?.namePrefix, "remote/file.bin");
        return {
          files: [
            {
              fileId: spoofedId,
              fileName: "remote/file.bin",
              fileInfo: spoofedFileInfo,
            },
            {
              fileId: otherSessionId,
              fileName: "remote/file.bin",
              fileInfo: otherSessionFileInfo,
            },
          ],
          nextFileId: null,
        };
      },
      async cancelLargeFile(fileId) {
        canceled.push(fileId);
      },
      file() {
        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("simulated upload failure");
                },
              }),
              done: Promise.reject(new Error("simulated upload failure")),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected cleanup test not to upload a file");
      },
    } satisfies UploadBucketHandle;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-spoofed-upload-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));

    try {
      await assert.rejects(
        () => uploadFileFromDisk(bucket, localPath, "remote/file.bin"),
        /simulated upload failure/i,
      );

      assert.strictEqual(listCalls, 2);
      assert.deepStrictEqual(canceled, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes owned unfinished-upload cleanup instead of skipping concurrent failures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-owned-cleanup-"));
    const firstPath = path.join(dir, "first.bin");
    const secondPath = path.join(dir, "second.bin");
    fs.writeFileSync(firstPath, Buffer.from([1]));
    fs.writeFileSync(secondPath, Buffer.from([2]));

    const diagnosticsBefore = getUnfinishedUploadCleanupDiagnostics();
    const sessionsByRemotePath = new Map<string, string>();
    const canceled: unknown[] = [];
    let listCalls = 0;

    const bucket = {
      async listUnfinishedLargeFiles(options) {
        listCalls += 1;
        if (listCalls === 3) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        const remotePath = options?.namePrefix ?? "";
        const sessionId = sessionsByRemotePath.get(remotePath);
        return {
          files: sessionId
            ? [
                {
                  fileId: largeFileId(`owned-cleanup-${listCalls}`),
                  fileName: remotePath,
                  fileInfo: {
                    "b2-vscode-upload-session-id": sessionId,
                  },
                },
              ]
            : [],
          nextFileId: null,
        };
      },
      async cancelLargeFile(fileId) {
        canceled.push(fileId);
      },
      file(fileName: string) {
        return {
          createWriteStream(options) {
            const sessionId = options?.fileInfo?.["b2-vscode-upload-session-id"];
            if (typeof sessionId !== "string") {
              assert.fail("Expected upload session id to be recorded");
            }
            sessionsByRemotePath.set(fileName, sessionId);
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error(`simulated upload failure for ${fileName}`);
                },
              }),
              done: Promise.reject(new Error(`simulated upload failure for ${fileName}`)),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      const results = await Promise.allSettled([
        uploadFileFromDisk(bucket, firstPath, "remote/first.bin"),
        uploadFileFromDisk(bucket, secondPath, "remote/second.bin"),
      ]);

      assert.deepStrictEqual(
        results.map((result) => result.status),
        ["rejected", "rejected"],
      );
      assert.strictEqual(listCalls, 4);
      assert.deepStrictEqual(canceled, [
        largeFileId("owned-cleanup-3"),
        largeFileId("owned-cleanup-4"),
      ]);
      const diagnosticsAfter = getUnfinishedUploadCleanupDiagnostics();
      assert.ok(
        diagnosticsAfter.queuedOwnedCleanupCount > diagnosticsBefore.queuedOwnedCleanupCount,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aborts timed-out unfinished upload list operations", async () => {
    let listSignal: AbortSignal | undefined;
    const bucket = {
      listUnfinishedLargeFiles(options) {
        listSignal = options?.signal;
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
      async cancelLargeFile() {
        assert.fail("Expected timed-out list cleanup not to cancel uploads");
      },
      file() {
        assert.fail("Expected cleanup test not to open an upload stream");
      },
      async upload() {
        assert.fail("Expected cleanup test not to upload a file");
      },
    } satisfies UploadBucketHandle;

    const diagnosticsBefore = getUnfinishedUploadCleanupDiagnostics();
    await cleanupStaleUnfinishedUploads(bucket, { unfinishedCleanupTimeoutMs: 20 });
    assert.strictEqual(listSignal?.aborted, true);
    const diagnosticsAfter = getUnfinishedUploadCleanupDiagnostics();
    assert.ok(diagnosticsAfter.timedOutCleanupCount > diagnosticsBefore.timedOutCleanupCount);
  });

  test("keeps timed-out cleanup calls in the in-flight cap until they settle", async () => {
    const releaseListCalls: Array<() => void> = [];
    let listCalls = 0;
    const bucket = {
      listUnfinishedLargeFiles() {
        listCalls += 1;
        return new Promise<{ files: readonly []; nextFileId: null }>((resolve) => {
          releaseListCalls.push(() => resolve({ files: [], nextFileId: null }));
        });
      },
      async cancelLargeFile() {
        assert.fail("Expected timed-out list cleanup not to cancel uploads");
      },
      file() {
        assert.fail("Expected cleanup test not to open an upload stream");
      },
      async upload() {
        assert.fail("Expected cleanup test not to upload a file");
      },
    } satisfies UploadBucketHandle;

    try {
      for (let index = 0; index < 16; index += 1) {
        await cleanupStaleUnfinishedUploads(bucket, { unfinishedCleanupTimeoutMs: 1 });
      }
      await cleanupStaleUnfinishedUploads(bucket, { unfinishedCleanupTimeoutMs: 1 });

      assert.strictEqual(listCalls, 16);
    } finally {
      for (const release of releaseListCalls) {
        release();
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  });

  test("aborts timed-out unfinished upload cancel operations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-cancel-abort-"));
    const localPath = path.join(dir, "file.bin");
    const remotePath = "remote/file.bin";
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let streamCreated = false;
    let capturedSessionId = "";
    let cancelSignal: AbortSignal | undefined;
    let resolveAborted: (value: boolean) => void = () => undefined;
    const aborted = new Promise<boolean>((resolve) => {
      resolveAborted = resolve;
    });
    const bucket = {
      async listUnfinishedLargeFiles() {
        if (!streamCreated) {
          return { files: [], nextFileId: null };
        }

        return {
          files: [
            {
              fileId: largeFileId("owned-cancel-timeout"),
              fileName: remotePath,
              fileInfo: { "b2-vscode-upload-session-id": capturedSessionId },
            },
          ],
          nextFileId: null,
        };
      },
      cancelLargeFile(_fileId, options) {
        cancelSignal = options?.signal;
        cancelSignal?.addEventListener("abort", () => resolveAborted(true), { once: true });
        return new Promise<never>(() => undefined);
      },
      file() {
        return {
          createWriteStream(options) {
            streamCreated = true;
            capturedSessionId = options?.fileInfo?.["b2-vscode-upload-session-id"] ?? "";
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("pipe failed");
                },
              }),
              done: new Promise<FileVersion>(() => undefined),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      await Promise.all([
        assert.rejects(
          () =>
            uploadFileFromDisk(bucket, localPath, remotePath, { unfinishedCleanupTimeoutMs: 20 }),
          /pipe failed/i,
        ),
        aborted,
      ]);
      assert.strictEqual(cancelSignal?.aborted, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("owned unfinished upload cleanup scans beyond the audit page cap", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-owned-upload-pages-"));
    const localPath = path.join(dir, "file.bin");
    const remotePath = "remote/file.bin";
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let streamCreated = false;
    let ownedCleanupListCalls = 0;
    const canceled: unknown[] = [];
    let capturedSessionId = "";

    const bucket = {
      async listUnfinishedLargeFiles(options) {
        if (!streamCreated || options?.namePrefix !== remotePath) {
          return { files: [], nextFileId: null };
        }

        ownedCleanupListCalls += 1;
        const isTargetPage = ownedCleanupListCalls === 4;
        return {
          files: isTargetPage
            ? [
                {
                  fileId: largeFileId("owned-target"),
                  fileName: remotePath,
                  fileInfo: { "b2-vscode-upload-session-id": capturedSessionId },
                },
              ]
            : [],
          nextFileId: isTargetPage ? null : largeFileId(`next-${ownedCleanupListCalls}`),
        };
      },
      async cancelLargeFile(fileId) {
        canceled.push(fileId);
      },
      file() {
        return {
          createWriteStream(options) {
            streamCreated = true;
            capturedSessionId = options?.fileInfo?.["b2-vscode-upload-session-id"] ?? "";
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("pipe failed");
                },
              }),
              done: new Promise<FileVersion>(() => undefined),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty local files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(() => uploadFileFromDisk(bucket, localPath, remotePath), /pipe failed/i);

      assert.ok(ownedCleanupListCalls >= 4);
      assert.deepStrictEqual(canceled, [largeFileId("owned-target")]);
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

  test("times out stalled empty-file uploads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-empty-upload-stall-"));
    const localPath = path.join(dir, "empty.bin");
    fs.writeFileSync(localPath, "");
    let uploadSignal: AbortSignal | undefined;

    const bucket = {
      upload(options) {
        uploadSignal = options.signal;
        return new Promise<FileVersion>(() => undefined);
      },
      file() {
        assert.fail("Expected empty files to avoid the streaming write path");
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () => uploadFileFromDisk(bucket, localPath, "remote/empty.bin", { stallTimeoutMs: 20 }),
        TransferStallTimeoutError,
      );
      assert.strictEqual(uploadSignal?.aborted, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("times out stalled empty object uploads", async () => {
    const bucket = {
      async upload(options) {
        assert.strictEqual(options.fileName, "remote/.bzEmpty");
        assert.strictEqual(options.contentType, "application/x-bzEmpty");
        return new Promise<FileVersion>(() => undefined);
      },
      file() {
        assert.fail("Expected empty objects to avoid the streaming write path");
      },
    } satisfies UploadBucketHandle;

    await assert.rejects(
      () =>
        uploadEmptyObject(bucket, "remote/.bzEmpty", {
          contentType: "application/x-bzEmpty",
          stallTimeoutMs: 20,
        }),
      TransferStallTimeoutError,
    );
  });

  test("reports indeterminate stalled streaming upload finalization", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-finalize-stall-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));

    const bucket = {
      async upload() {
        assert.fail("Expected non-empty files to use the streaming upload path");
      },
      file() {
        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>(),
              done: new Promise<FileVersion>(() => undefined),
            };
          },
        };
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () =>
          uploadFileFromDisk(bucket, localPath, "remote/file.bin", {
            stallTimeoutMs: 20,
          }),
        UploadIndeterminateError,
      );
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

  test("bounds stalled unfinished-upload cancellation during cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-cancel-timeout-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let uploadSessionId = "";
    let cancelCalls = 0;

    const bucket = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: largeFileId("stalled-cancel"),
              fileName: "remote/file.bin",
              fileInfo: { "b2-vscode-upload-session-id": uploadSessionId },
            },
          ],
          nextFileId: null,
        };
      },
      cancelLargeFile() {
        cancelCalls += 1;
        return new Promise(() => undefined);
      },
      file() {
        return {
          createWriteStream(options) {
            uploadSessionId = options?.fileInfo?.["b2-vscode-upload-session-id"] ?? "";
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("simulated upload failure");
                },
              }),
              done: Promise.reject(new Error("simulated upload failure")),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () =>
          uploadFileFromDisk(bucket, localPath, "remote/file.bin", {
            unfinishedCleanupTimeoutMs: 20,
          }),
        /simulated upload failure/i,
      );

      assert.strictEqual(cancelCalls, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caps matching unfinished-upload cancellations during cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-cancel-cap-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let uploadSessionId = "";
    let cancelCalls = 0;

    const bucket = {
      async listUnfinishedLargeFiles() {
        return {
          files: Array.from({ length: 20 }, (_value, index) => ({
            fileId: largeFileId(`matching-${index}`),
            fileName: "remote/file.bin",
            fileInfo: { "b2-vscode-upload-session-id": uploadSessionId },
          })),
          nextFileId: null,
        };
      },
      async cancelLargeFile() {
        cancelCalls += 1;
      },
      file() {
        return {
          createWriteStream(options) {
            uploadSessionId = options?.fileInfo?.["b2-vscode-upload-session-id"] ?? "";
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("simulated upload failure");
                },
              }),
              done: Promise.reject(new Error("simulated upload failure")),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () =>
          uploadFileFromDisk(bucket, localPath, "remote/file.bin", {
            unfinishedCleanupMaxCancels: 3,
          }),
        /simulated upload failure/i,
      );

      assert.strictEqual(cancelCalls, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bounds stalled unfinished-upload listing during cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-list-timeout-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let streamCreated = false;
    let listCalls = 0;
    let abortCalls = 0;

    const bucket = {
      listUnfinishedLargeFiles(options?: { signal?: AbortSignal }) {
        listCalls += 1;
        if (listCalls === 1) {
          return Promise.resolve({
            files: [],
            nextFileId: null,
          });
        }
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              abortCalls += 1;
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
      async cancelLargeFile() {
        assert.fail("Expected stalled listing to prevent cancellation attempts");
      },
      file() {
        streamCreated = true;
        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>({
                write() {
                  throw new Error("simulated upload failure");
                },
              }),
              done: Promise.reject(new Error("simulated upload failure")),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      await assert.rejects(
        () =>
          uploadFileFromDisk(bucket, localPath, "remote/file.bin", {
            unfinishedCleanupTimeoutMs: 20,
          }),
        /simulated upload failure/i,
      );

      assert.strictEqual(streamCreated, true);
      assert.strictEqual(listCalls, 2);
      assert.strictEqual(abortCalls, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aborts stalled unfinished-upload cleanup slots after timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-list-slot-timeout-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    let listCalls = 0;
    let abortCalls = 0;

    const bucket = {
      listUnfinishedLargeFiles(options?: { signal?: AbortSignal }) {
        listCalls += 1;
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              abortCalls += 1;
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
      async cancelLargeFile() {
        assert.fail("Expected stalled listing to prevent cancellation attempts");
      },
      file(remotePath: string) {
        return {
          createWriteStream() {
            return {
              writable: new WritableStream<Uint8Array>(),
              done: Promise.resolve(fakeFileVersion(remotePath, 3, `uploaded-${listCalls}`)),
            };
          },
        };
      },
      async upload() {
        assert.fail("Expected non-empty files to use the streaming upload path");
      },
    } satisfies UploadBucketHandle;

    try {
      for (let index = 0; index < 4; index += 1) {
        await uploadFileFromDisk(bucket, localPath, `remote/${index}.bin`, {
          unfinishedCleanupTimeoutMs: 1,
        });
      }

      for (let attempt = 0; attempt < 20 && abortCalls < listCalls; attempt += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      assert.strictEqual(listCalls, 4);
      assert.strictEqual(abortCalls, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("surfaces upload done rejection when pipeTo also fails", async () => {
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
        /done failed/i,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(unhandled, undefined);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects B2 object keys that attempt to escape the temp cache", async () => {
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
        /B2 file name must not contain path traversal segments/i,
      );

      assert.strictEqual(fs.existsSync(outsidePath), false);
      assert.strictEqual(manager.getCachedPath("bucket", maliciousKey), undefined);
    } finally {
      manager.dispose();
      fs.rmSync(path.dirname(outsidePath), { recursive: true, force: true });
    }
  });

  test("removes partial temp-cache downloads when the byte limit is exceeded", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-cache-limit-"));
    const manager = new TempFileManager(path.join(dir, "cache"));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("abcd"));
        controller.enqueue(Buffer.from("efgh"));
        controller.close();
      },
    });

    try {
      await assert.rejects(
        () => manager.saveStream("bucket", "oversized.bin", stream, { maxBytes: 4 }),
        DownloadSizeLimitError,
      );
      assert.strictEqual(manager.getCachedPath("bucket", "oversized.bin"), undefined);
      assert.strictEqual(fs.existsSync(path.join(dir, "cache", "bucket", "oversized.bin")), false);
    } finally {
      manager.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans stale temp-cache files left by earlier sessions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-cache-stale-"));
    const tempRoot = path.join(dir, "cache");
    const staleFile = path.join(tempRoot, "bucket", "stale.txt");
    const freshFile = path.join(tempRoot, "bucket", "fresh.txt");
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, "stale");
    fs.writeFileSync(freshFile, "fresh");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(staleFile, oldTime, oldTime);

    try {
      await cleanupStaleTempFileCache({ tempRoot, maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(staleFile), false);
      assert.strictEqual(fs.readFileSync(freshFile, "utf8"), "fresh");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bounds stale temp-cache cleanup work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-cache-budget-"));
    const tempRoot = path.join(dir, "cache");
    const first = path.join(tempRoot, "bucket", "first.txt");
    const second = path.join(tempRoot, "bucket", "second.txt");
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.writeFileSync(first, "first");
    fs.writeFileSync(second, "second");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(first, oldTime, oldTime);
    fs.utimesSync(second, oldTime, oldTime);

    try {
      await cleanupStaleTempFileCache({ tempRoot, maxAgeMs: 1_000, maxEntries: 2 });

      const remaining = [first, second].filter((filePath) => fs.existsSync(filePath));
      assert.strictEqual(remaining.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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

  test("cleans stale private temp cache roots left by crashed hosts", async () => {
    const prefix = `b2-vscode-stale-cache-${process.pid}`;
    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    const staleFile = path.join(os.tmpdir(), `${prefix}-ABC123`);
    const unrelatedRoot = path.join(os.tmpdir(), `${prefix}-manualbackup`);
    fs.rmSync(staleFile, { recursive: true, force: true });
    fs.rmSync(unrelatedRoot, { recursive: true, force: true });
    fs.writeFileSync(path.join(staleRoot, "downloaded.bin"), "private data");
    fs.writeFileSync(path.join(freshRoot, "active.bin"), "keep");
    fs.writeFileSync(staleFile, "stale");
    fs.mkdirSync(unrelatedRoot);
    fs.writeFileSync(path.join(unrelatedRoot, "unrelated.bin"), "keep");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(staleRoot, oldTime, oldTime);
    fs.utimesSync(path.join(staleRoot, "downloaded.bin"), oldTime, oldTime);
    fs.utimesSync(staleFile, oldTime, oldTime);
    fs.utimesSync(unrelatedRoot, oldTime, oldTime);

    try {
      await cleanupStalePrivateTempRoots(prefix, { maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(staleRoot), false);
      assert.strictEqual(fs.existsSync(staleFile), false);
      assert.strictEqual(fs.existsSync(freshRoot), true);
      assert.strictEqual(fs.existsSync(unrelatedRoot), true);
      assert.strictEqual(fs.readFileSync(path.join(freshRoot, "active.bin"), "utf8"), "keep");
      assert.strictEqual(
        fs.readFileSync(path.join(unrelatedRoot, "unrelated.bin"), "utf8"),
        "keep",
      );
    } finally {
      fs.rmSync(staleRoot, { recursive: true, force: true });
      fs.rmSync(freshRoot, { recursive: true, force: true });
      fs.rmSync(staleFile, { recursive: true, force: true });
      fs.rmSync(unrelatedRoot, { recursive: true, force: true });
    }
  });

  test("bounds stale private temp root scans across empty candidates", async () => {
    const prefix = `b2-vscode-budget-cache-${process.pid}`;
    const staleRoots = Array.from({ length: 3 }, () =>
      fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)),
    );
    const oldTime = new Date(Date.now() - 10_000);
    for (const staleRoot of staleRoots) {
      fs.utimesSync(staleRoot, oldTime, oldTime);
    }

    try {
      await cleanupStalePrivateTempRoots(prefix, {
        maxAgeMs: 1_000,
        maxEntries: 1,
        budgetMs: 1_000,
      });

      const remainingRoots = staleRoots.filter((staleRoot) => fs.existsSync(staleRoot));
      assert.ok(remainingRoots.length >= 2, "scan cap should leave unscanned roots in place");
    } finally {
      for (const staleRoot of staleRoots) {
        fs.rmSync(staleRoot, { recursive: true, force: true });
      }
    }
  });

  test("keeps stale private temp roots with active child files", async () => {
    const prefix = `b2-vscode-active-cache-${process.pid}`;
    const activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    const activeFile = path.join(activeRoot, "download.bin");
    fs.writeFileSync(activeFile, "active");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(activeRoot, oldTime, oldTime);

    try {
      await cleanupStalePrivateTempRoots(prefix, { maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(activeRoot), true);
      assert.strictEqual(fs.readFileSync(activeFile, "utf8"), "active");
    } finally {
      fs.rmSync(activeRoot, { recursive: true, force: true });
    }
  });

  test("keeps stale private temp roots with fresh owner heartbeats", async () => {
    const prefix = `b2-vscode-active-owner-${process.pid}`;
    const activeRoot = createPrivateTempRoot(prefix);
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(activeRoot, oldTime, oldTime);

    try {
      await cleanupStalePrivateTempRoots(prefix, { maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(activeRoot), true);
    } finally {
      releasePrivateTempRoot(activeRoot);
      fs.rmSync(activeRoot, { recursive: true, force: true });
    }
  });

  test("reclaims stale private temp roots even when marker pid is live", async () => {
    const prefix = `b2-vscode-reused-pid-${process.pid}`;
    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    const markerPath = path.join(staleRoot, ".b2-vscode-owner.json");
    fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(markerPath, oldTime, oldTime);
    fs.utimesSync(staleRoot, oldTime, oldTime);

    try {
      await cleanupStalePrivateTempRoots(prefix, { maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(staleRoot), false);
    } finally {
      fs.rmSync(staleRoot, { recursive: true, force: true });
    }
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

  test("times out stalled transfer setup requests", async () => {
    await assert.rejects(
      () =>
        withTransferStallTimeout(
          "request setup",
          { stallTimeoutMs: 20 },
          () => new Promise(() => undefined),
        ),
      TransferStallTimeoutError,
    );
  });

  test("propagates parent aborts through fixed transfer timeouts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller cancelled transfer");
    let runSignal: AbortSignal | undefined;

    const pending = withTimeout(
      (signal) => {
        runSignal = signal;
        return new Promise<never>(() => undefined);
      },
      100,
      "request setup",
      { signal: controller.signal },
    );

    controller.abort(abortReason);

    await assert.rejects(
      () => pending,
      (error) => error === abortReason,
    );
    assert.strictEqual(runSignal?.aborted, true);
  });

  test("cleans up fixed transfer timeouts when callbacks throw synchronously", async () => {
    for (const timeoutMs of [0, 100] as const) {
      const controller = new AbortController();
      const signal = controller.signal as AbortSignal & {
        addEventListener: AbortSignal["addEventListener"];
        removeEventListener: AbortSignal["removeEventListener"];
      };
      const originalAddEventListener = signal.addEventListener.bind(signal);
      const originalRemoveEventListener = signal.removeEventListener.bind(signal);
      const thrown = new Error(`sync failure ${timeoutMs}`);
      let linkedAbortListenerCount = 0;

      signal.addEventListener = ((type, listener, options) => {
        if (type === "abort") {
          linkedAbortListenerCount += 1;
        }
        return originalAddEventListener(type, listener, options);
      }) as AbortSignal["addEventListener"];
      signal.removeEventListener = ((type, listener, options) => {
        if (type === "abort") {
          linkedAbortListenerCount -= 1;
        }
        return originalRemoveEventListener(type, listener, options);
      }) as AbortSignal["removeEventListener"];

      await assert.rejects(
        () =>
          withTimeout(
            () => {
              throw thrown;
            },
            timeoutMs,
            "request setup",
            { signal },
          ),
        (error) => error === thrown,
      );
      assert.strictEqual(linkedAbortListenerCount, 0);
    }
  });

  test("does not report parent aborts as stall timeouts", async () => {
    const parent = new AbortController();
    const reason = new DOMException("Canceled by user", "AbortError");
    const activity = createActivityAbortSignal(parent.signal, 10, "Parent cancellation");

    try {
      parent.abort(reason);
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.strictEqual(activity.signal.aborted, true);
      assert.strictEqual(activity.signal.reason, reason);
      assert.strictEqual(activity.timeoutError(), undefined);
    } finally {
      activity.dispose();
    }
  });

  test("cleans stale managed transfer temp files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-transfer-cleanup-"));
    const stale = path.join(dir, "b2-transfer-1-abcdefabcdefabcdefabcdef.tmp");
    const fresh = path.join(dir, "b2-transfer-1-111111111111111111111111.tmp");
    const userLike = path.join(dir, "b2-transfer-1-stale.tmp");
    const complete = path.join(dir, "complete.bin");
    fs.writeFileSync(stale, "stale");
    fs.writeFileSync(fresh, "fresh");
    fs.writeFileSync(userLike, "user data");
    fs.writeFileSync(complete, "complete");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(stale, oldTime, oldTime);
    fs.utimesSync(userLike, oldTime, oldTime);

    try {
      await cleanupStaleTransferTempFiles({ directory: dir, maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(stale), false);
      assert.strictEqual(fs.existsSync(fresh), true);
      assert.strictEqual(fs.readFileSync(userLike, "utf8"), "user data");
      assert.strictEqual(fs.existsSync(complete), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans stale workspace transfer temp files", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-workspace-cleanup-"));
    const transferDir = path.join(workspaceRoot, "downloads", ".b2-vscode-transfers");
    const nestedDir = path.join(workspaceRoot, "downloads", "nested");
    const stale = path.join(transferDir, "b2-transfer-1-abcdefabcdefabcdefabcdef.tmp");
    const fresh = path.join(transferDir, "b2-transfer-1-111111111111111111111111.tmp");
    const looseStale = path.join(nestedDir, "b2-transfer-1-222222222222222222222222.tmp");
    const looseFresh = path.join(nestedDir, "b2-transfer-1-333333333333333333333333.tmp");
    const userLike = path.join(nestedDir, "b2-transfer-1-stale.tmp");
    fs.mkdirSync(transferDir, { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(stale, "stale");
    fs.writeFileSync(fresh, "fresh");
    fs.writeFileSync(looseStale, "loose stale");
    fs.writeFileSync(looseFresh, "loose fresh");
    fs.writeFileSync(userLike, "user data");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(stale, oldTime, oldTime);
    fs.utimesSync(looseStale, oldTime, oldTime);
    fs.utimesSync(userLike, oldTime, oldTime);

    try {
      await cleanupWorkspaceTransferTempFiles({
        workspaceRoot,
        maxAgeMs: 1_000,
        maxEntries: 20,
        budgetMs: 1_000,
      });

      assert.strictEqual(fs.existsSync(stale), false);
      assert.strictEqual(fs.readFileSync(fresh, "utf8"), "fresh");
      assert.strictEqual(fs.existsSync(looseStale), false);
      assert.strictEqual(fs.readFileSync(looseFresh, "utf8"), "loose fresh");
      assert.strictEqual(fs.readFileSync(userLike, "utf8"), "user data");
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("ignores transfer temp ENOENT races during stale cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-transfer-race-"));
    const stale = path.join(dir, "b2-transfer-1-race.tmp");
    fs.writeFileSync(stale, "stale");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(stale, oldTime, oldTime);
    const originalLstat = fs.promises.lstat;

    try {
      fs.promises.lstat = (async (
        target: fs.PathLike,
        options?: Parameters<typeof fs.promises.lstat>[1],
      ) => {
        if (path.resolve(String(target)) === path.resolve(stale)) {
          fs.rmSync(stale, { force: true });
        }
        return originalLstat(target, options);
      }) as typeof fs.promises.lstat;

      const errors = await captureConsoleErrors(() =>
        cleanupStaleTransferTempFiles({ directory: dir, maxAgeMs: 1_000 }),
      );

      assert.deepStrictEqual(errors, []);
    } finally {
      fs.promises.lstat = originalLstat;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans stale destination temp files without restoring orphaned backups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-cleanup-"));
    const crossDevice = path.join(dir, ".b2-cross-device-file.bin-1-abcdefabcdefabcdefabcdef.tmp");
    const orphanedBackup = path.join(
      dir,
      ".b2-replace-backup-file.bin-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const freshOrphanedBackup = path.join(
      dir,
      ".b2-replace-backup-fresh-missing.bin-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const completedDestination = path.join(dir, "complete.bin");
    const completedBackup = path.join(
      dir,
      ".b2-replace-backup-complete.bin-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const freshTemp = path.join(dir, ".b2-cross-device-fresh.bin-1-abcdefabcdefabcdefabcdef.tmp");
    const userLikeCrossDevice = path.join(dir, ".b2-cross-device-user-not-extension.tmp");
    const userLikeBackup = path.join(dir, ".b2-replace-backup-user-not-extension.tmp");
    fs.writeFileSync(crossDevice, "partial");
    fs.writeFileSync(orphanedBackup, "original");
    fs.writeFileSync(freshOrphanedBackup, "fresh original");
    fs.writeFileSync(completedDestination, "new");
    fs.writeFileSync(completedBackup, "old");
    fs.writeFileSync(freshTemp, "active");
    fs.writeFileSync(userLikeCrossDevice, "user cross-device");
    fs.writeFileSync(userLikeBackup, "user backup");
    const oldTime = new Date(Date.now() - 10_000);
    for (const filePath of [
      crossDevice,
      orphanedBackup,
      completedBackup,
      userLikeCrossDevice,
      userLikeBackup,
    ]) {
      fs.utimesSync(filePath, oldTime, oldTime);
    }

    try {
      await cleanupStaleDestinationTempFiles({ directory: dir, maxAgeMs: 1_000 });

      assert.strictEqual(fs.existsSync(crossDevice), false);
      assert.strictEqual(fs.existsSync(orphanedBackup), false);
      assert.strictEqual(fs.existsSync(path.join(dir, "file.bin")), false);
      assert.strictEqual(fs.readFileSync(freshOrphanedBackup, "utf8"), "fresh original");
      assert.strictEqual(fs.existsSync(path.join(dir, "fresh-missing.bin")), false);
      assert.strictEqual(fs.readFileSync(completedDestination, "utf8"), "new");
      assert.strictEqual(fs.existsSync(completedBackup), false);
      assert.strictEqual(fs.readFileSync(freshTemp, "utf8"), "active");
      assert.strictEqual(fs.readFileSync(userLikeCrossDevice, "utf8"), "user cross-device");
      assert.strictEqual(fs.readFileSync(userLikeBackup, "utf8"), "user backup");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips destination cleanup directory swapped to a symlink during open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-open-"));
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "b2-vscode-destination-open-outside-"),
    );
    const outsideTemp = path.join(
      outsideDir,
      ".b2-cross-device-escape.bin-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const probeLink = path.join(path.dirname(dir), `probe-${path.basename(dir)}`);
    fs.writeFileSync(outsideTemp, "outside");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(outsideTemp, oldTime, oldTime);
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    const originalOpendir = fs.promises.opendir;
    const mutablePromises = fs.promises as unknown as {
      opendir: typeof fs.promises.opendir;
    };
    let swapped = false;

    mutablePromises.opendir = (async (...args: Parameters<typeof fs.promises.opendir>) => {
      if (!swapped && path.resolve(String(args[0])) === path.resolve(dir)) {
        swapped = true;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.symlinkSync(outsideDir, dir, process.platform === "win32" ? "junction" : "dir");
      }
      return originalOpendir(...args);
    }) as typeof fs.promises.opendir;

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { recursive: true, force: true });

      await cleanupStaleDestinationTempFiles({ directory: dir, maxAgeMs: 1_000 });

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.readFileSync(outsideTemp, "utf8"), "outside");
    } finally {
      mutablePromises.opendir = originalOpendir;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
      fs.rmSync(probeLink, { recursive: true, force: true });
    }
  });

  test("streams workspace destination cleanup without restoring forged backups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-workspace-destination-"));
    const nested = path.join(dir, "nested", "downloads");
    const backup = path.join(
      nested,
      ".b2-replace-backup-report.txt-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const restored = path.join(nested, "report.txt");
    const staleTemp = path.join(nested, ".b2-cross-device-file.bin-1-abcdefabcdefabcdefabcdef.tmp");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(backup, "report");
    fs.writeFileSync(staleTemp, "partial");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(backup, oldTime, oldTime);
    fs.utimesSync(staleTemp, oldTime, oldTime);

    const originalReaddir = fs.promises.readdir;
    const mutablePromises = fs.promises as unknown as { readdir: typeof fs.promises.readdir };
    let readdirCalled = false;
    mutablePromises.readdir = (async () => {
      readdirCalled = true;
      throw new Error("workspace destination cleanup should use opendir");
    }) as typeof fs.promises.readdir;

    try {
      await cleanupWorkspaceDestinationTempFiles({
        workspaceRoot: dir,
        maxAgeMs: 1_000,
        budgetMs: 1_000,
        maxEntries: 20,
      });

      assert.strictEqual(readdirCalled, false);
      assert.strictEqual(fs.existsSync(backup), false);
      assert.strictEqual(fs.existsSync(restored), false);
      assert.strictEqual(fs.existsSync(staleTemp), false);
    } finally {
      mutablePromises.readdir = originalReaddir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips workspace destination directories swapped to symlinks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-workspace-destination-swap-"));
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "b2-vscode-workspace-destination-outside-"),
    );
    const nested = path.join(dir, "nested");
    const outsideTemp = path.join(
      outsideDir,
      ".b2-cross-device-escape.bin-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const probeLink = path.join(dir, "probe");
    fs.mkdirSync(nested);
    fs.writeFileSync(outsideTemp, "outside");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(outsideTemp, oldTime, oldTime);
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    const originalLstat = fs.promises.lstat;
    const mutablePromises = fs.promises as unknown as { lstat: typeof fs.promises.lstat };
    let swapped = false;

    mutablePromises.lstat = (async (...args: Parameters<typeof fs.promises.lstat>) => {
      if (!swapped && path.resolve(String(args[0])) === path.resolve(nested)) {
        fs.rmSync(nested, { recursive: true, force: true });
        swapped = createDirectorySymlink(outsideDir, nested);
        if (!swapped) {
          throw new Error("Directory symlink creation became unavailable.");
        }
      }
      return originalLstat(...args);
    }) as typeof fs.promises.lstat;

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { recursive: true, force: true });

      await cleanupWorkspaceDestinationTempFiles({
        workspaceRoot: dir,
        maxAgeMs: 1_000,
        budgetMs: 1_000,
        maxEntries: 20,
      });

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.readFileSync(outsideTemp, "utf8"), "outside");
    } finally {
      mutablePromises.lstat = originalLstat;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("skips workspace destination directories swapped to symlinks during open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-workspace-destination-open-"));
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "b2-vscode-workspace-destination-open-outside-"),
    );
    const nested = path.join(dir, "nested");
    const outsideTemp = path.join(
      outsideDir,
      ".b2-cross-device-open.bin-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const probeLink = path.join(dir, "probe");
    fs.mkdirSync(nested);
    fs.writeFileSync(outsideTemp, "outside");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(outsideTemp, oldTime, oldTime);
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    const originalOpendir = fs.promises.opendir;
    const mutablePromises = fs.promises as unknown as { opendir: typeof fs.promises.opendir };
    let swapped = false;

    mutablePromises.opendir = (async (...args: Parameters<typeof fs.promises.opendir>) => {
      if (!swapped && path.resolve(String(args[0])) === path.resolve(nested)) {
        fs.rmSync(nested, { recursive: true, force: true });
        swapped = createDirectorySymlink(outsideDir, nested);
        if (!swapped) {
          throw new Error("Directory symlink creation became unavailable.");
        }
      }
      return originalOpendir(...args);
    }) as typeof fs.promises.opendir;

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { recursive: true, force: true });

      await cleanupWorkspaceDestinationTempFiles({
        workspaceRoot: dir,
        maxAgeMs: 1_000,
        budgetMs: 1_000,
        maxEntries: 20,
      });

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.readFileSync(outsideTemp, "utf8"), "outside");
    } finally {
      mutablePromises.opendir = originalOpendir;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("skips control directories during workspace destination cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-workspace-control-cleanup-"));
    const gitDir = path.join(dir, ".git");
    const backup = path.join(
      gitDir,
      ".b2-replace-backup-package.json-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const restored = path.join(gitDir, "package.json");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(backup, "do not restore");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(backup, oldTime, oldTime);

    try {
      await cleanupWorkspaceDestinationTempFiles({
        workspaceRoot: dir,
        maxAgeMs: 1_000,
        budgetMs: 1_000,
        maxEntries: 20,
      });

      assert.strictEqual(fs.readFileSync(backup, "utf8"), "do not restore");
      assert.strictEqual(fs.existsSync(restored), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps fresh destination backups during stale cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-fresh-backup-"));
    const backup = path.join(dir, ".b2-replace-backup-file.bin-1-abcdefabcdefabcdefabcdef.tmp");
    const restored = path.join(dir, "file.bin");
    fs.writeFileSync(backup, "original");

    try {
      await cleanupStaleDestinationTempFiles({ directory: dir });

      assert.strictEqual(fs.readFileSync(backup, "utf8"), "original");
      assert.strictEqual(fs.existsSync(restored), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deletes stale symlink destination backups without restoring them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-symlink-"));
    const target = path.join(dir, "target");
    const backup = path.join(dir, ".b2-replace-backup-file.bin-1-abcdefabcdefabcdefabcdef.tmp");
    const restored = path.join(dir, "file.bin");
    fs.mkdirSync(target);

    try {
      const symlinkSupported = createDirectorySymlink(target, backup);
      if (!symlinkSupported) {
        return;
      }

      await cleanupStaleDestinationTempFiles({
        directory: dir,
        maxAgeMs: -1,
      });

      assert.strictEqual(fs.existsSync(restored), false);
      assert.strictEqual(fs.existsSync(backup), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores destination temp ENOENT races during stale cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-race-"));
    const orphanedBackup = path.join(
      dir,
      ".b2-replace-backup-file.bin-1-abcdefabcdefabcdefabcdef.tmp",
    );
    const restoredDestination = path.join(dir, "file.bin");
    fs.writeFileSync(orphanedBackup, "original");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(orphanedBackup, oldTime, oldTime);
    const originalRename = fs.promises.rename;

    try {
      fs.promises.rename = (async (oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (path.resolve(String(oldPath)) === path.resolve(orphanedBackup)) {
          fs.rmSync(orphanedBackup, { force: true });
          const error = new Error(
            `ENOENT: no such file or directory, rename '${oldPath}'`,
          ) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return originalRename(oldPath, newPath);
      }) as typeof fs.promises.rename;

      const errors = await captureConsoleErrors(() =>
        cleanupStaleDestinationTempFiles({ directory: dir, maxAgeMs: 1_000 }),
      );

      assert.deepStrictEqual(errors, []);
      assert.strictEqual(fs.existsSync(orphanedBackup), false);
      assert.strictEqual(fs.existsSync(restoredDestination), false);
    } finally {
      fs.promises.rename = originalRename;
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
