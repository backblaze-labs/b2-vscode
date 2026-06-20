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
  cleanupWorkspaceTransferTempFiles,
  DEFAULT_DOWNLOAD_MAX_BYTES,
  DownloadSizeLimitError,
  downloadStreamToFile,
  getUnfinishedUploadCleanupDiagnostics,
  openUploadSourceFile,
  STREAMING_UPLOAD_PART_SIZE,
  TransferStallTimeoutError,
  uploadFileFromDisk,
  withTransferStallTimeout,
  type UploadBucketHandle,
} from "../../services/fileTransfers";
import { withCancellableTransferProgress } from "../../services/transferProgress";
import { cleanupStaleTempFileCache, TempFileManager } from "../../services/tempFileManager";
import { isPathInsideOrEqual } from "../../services/pathSafety";
import { humanSize } from "../../utils/humanSize";
import type { B2Credentials } from "../../services/authService";
import { stubWarningMessage, type WarningMessageCall } from "./windowStubs";

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

  test("documents the default download size cap", () => {
    assert.strictEqual(DEFAULT_DOWNLOAD_MAX_BYTES, 1024 * 1024 * 1024);
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
        /inside Workspace download directory|real directory|symlink/i,
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
        /changed during transfer|real directory|symlink/i,
      );

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.existsSync(outsideTarget), false);
    } finally {
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
    const originalReaddir = fs.promises.readdir;
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

      fs.promises.readdir = (async (...args: Parameters<typeof fs.promises.readdir>) => {
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

        return originalReaddir(...args);
      }) as typeof fs.promises.readdir;

      await assert.rejects(
        () =>
          downloadStreamToFile(stream, destination, {
            allowedRootDirectory: workspaceDir,
            temporaryDirectory: tempDir,
          }),
        /Workspace transfer temp directory|real directory|symlink|outside the allowed root/i,
      );

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.existsSync(outsideTempDir), false);
      assert.strictEqual(fs.existsSync(destination), false);
    } finally {
      fs.promises.readdir = originalReaddir;
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

  test("falls back to no-follow copy when hardlink crosses devices", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-link-exdev-"));
    const destination = path.join(dir, "file.bin");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([9, 8, 7]));
        controller.close();
      },
    });
    const originalLink = fs.promises.link;
    let linkCalls = 0;
    fs.promises.link = async (): Promise<void> => {
      linkCalls += 1;
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    };

    try {
      const size = await downloadStreamToFile(stream, destination, { overwrite: false });

      assert.strictEqual(size, 3);
      assert.strictEqual(linkCalls, 1);
      assert.deepStrictEqual([...fs.readFileSync(destination)], [9, 8, 7]);
    } finally {
      fs.promises.link = originalLink;
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

  test("pre-upload cleanup scans only same-key unfinished uploads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-no-pre-clean-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    const uploaded: number[] = [];
    let listCalls = 0;
    let cancelCalls = 0;

    const bucket = {
      async listUnfinishedLargeFiles(options) {
        listCalls += 1;
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
      assert.strictEqual(listCalls, 1);
      assert.strictEqual(cancelCalls, 0);
      assert.deepStrictEqual(uploaded, [1, 2, 3]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cancels stale extension-owned same-key uploads before streaming", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-pre-clean-"));
    const localPath = path.join(dir, "file.bin");
    fs.writeFileSync(localPath, Buffer.from([1, 2, 3]));
    const canceled: unknown[] = [];
    const uploaded: number[] = [];
    let streamCreated = false;

    const bucket = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: largeFileId("stale-owned"),
              fileName: "remote/file.bin",
              fileInfo: {
                "b2-vscode-upload-owner": "b2-vscode",
                "b2-vscode-upload-started-ms": "1",
              },
            },
          ],
          nextFileId: null,
        };
      },
      async cancelLargeFile(fileId) {
        assert.strictEqual(streamCreated, false);
        canceled.push(fileId);
      },
      file(fileName: string) {
        let resolveDone: (value: FileVersion) => void = () => undefined;
        const done = new Promise<FileVersion>((resolve) => {
          resolveDone = resolve;
        });

        return {
          createWriteStream() {
            streamCreated = true;
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
      assert.deepStrictEqual(canceled, [largeFileId("stale-owned")]);
      assert.deepStrictEqual(uploaded, [1, 2, 3]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not cancel remote unfinished uploads before streaming", async () => {
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

    const bucket = {
      listUnfinishedLargeFiles() {
        listCalls += 1;
        if (listCalls === 1) {
          return Promise.resolve({
            files: [],
            nextFileId: null,
          });
        }
        return new Promise<never>(() => undefined);
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

  test("sanitizes B2 object keys that attempt to escape the temp cache", async () => {
    const manager = new TempFileManager();
    const outsidePath = path.join(os.tmpdir(), `b2-vscode-outside-${Date.now()}`, "owned.txt");
    const maliciousKey = `../../${path.basename(path.dirname(outsidePath))}/owned.txt`;

    try {
      const cachedPath = await manager.saveStream(
        "bucket",
        maliciousKey,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
      );

      assert.strictEqual(fs.existsSync(outsidePath), false);
      assert.strictEqual(manager.getCachedPath("bucket", maliciousKey), cachedPath);
      assert.deepStrictEqual(await fs.promises.readFile(cachedPath), Buffer.from([1, 2, 3]));
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

  test("cleans stale workspace transfer temp files", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-workspace-cleanup-"));
    const transferDir = path.join(workspaceRoot, "downloads", ".b2-vscode-transfers");
    const stale = path.join(transferDir, "b2-transfer-1-stale.tmp");
    const fresh = path.join(transferDir, "b2-transfer-1-fresh.tmp");
    fs.mkdirSync(transferDir, { recursive: true });
    fs.writeFileSync(stale, "stale");
    fs.writeFileSync(fresh, "fresh");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(stale, oldTime, oldTime);

    try {
      await cleanupWorkspaceTransferTempFiles({
        workspaceRoot,
        maxAgeMs: 1_000,
        maxEntries: 20,
        budgetMs: 1_000,
      });

      assert.strictEqual(fs.existsSync(stale), false);
      assert.strictEqual(fs.readFileSync(fresh, "utf8"), "fresh");
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("cleans stale destination temp files and restores orphaned backups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-cleanup-"));
    const crossDevice = path.join(dir, ".b2-cross-device-file.bin-1-abcdefabcdef.tmp");
    const orphanedBackup = path.join(dir, ".b2-replace-backup-file.bin-1-abcdefabcdef.tmp");
    const completedDestination = path.join(dir, "complete.bin");
    const completedBackup = path.join(dir, ".b2-replace-backup-complete.bin-1-abcdefabcdef.tmp");
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

  test("restores fresh destination backups after interrupted replacement", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-fresh-backup-"));
    const backup = path.join(dir, ".b2-replace-backup-file.bin-1-abcdefabcdef.tmp");
    const restored = path.join(dir, "file.bin");
    fs.writeFileSync(backup, "original");

    try {
      await cleanupStaleDestinationTempFiles({ directory: dir });

      assert.strictEqual(fs.existsSync(backup), false);
      assert.strictEqual(fs.readFileSync(restored, "utf8"), "original");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not restore symlink destination backups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-destination-symlink-"));
    const target = path.join(dir, "target");
    const backup = path.join(dir, ".b2-replace-backup-file.bin-1-abcdefabcdef.tmp");
    const restored = path.join(dir, "file.bin");
    fs.mkdirSync(target);

    try {
      const symlinkSupported = createDirectorySymlink(target, backup);
      if (!symlinkSupported) {
        return;
      }

      await cleanupStaleDestinationTempFiles({
        directory: dir,
        maxAgeMs: Number.POSITIVE_INFINITY,
      });

      assert.strictEqual(fs.existsSync(restored), false);
      assert.strictEqual(fs.lstatSync(backup).isSymbolicLink(), true);
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
