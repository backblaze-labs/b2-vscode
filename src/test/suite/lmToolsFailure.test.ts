/**
 * Failure injection tests for all B2 language model tools.
 *
 * @module test/suite/lmToolsFailure
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { B2Client, classifyError } from "@backblaze-labs/b2-sdk";
import { TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME } from "../../constants";
import { ensureToolPrivateDirectorySync } from "../../toolPathSafety";
import { B2ToolAdapter } from "../../tools/b2ToolAdapter";
import type { B2ToolOperation, ToolExtras } from "../../tools/types";
import { deleteFileTool } from "../../tools/definitions/deleteFile";
import { downloadFileTool } from "../../tools/definitions/downloadFile";
import { getFileInfoTool } from "../../tools/definitions/getFileInfo";
import { listBucketsTool } from "../../tools/definitions/listBuckets";
import { listFilesTool } from "../../tools/definitions/listFiles";
import { presignUrlTool } from "../../tools/definitions/presignUrl";
import { uploadFileTool } from "../../tools/definitions/uploadFile";
import { deleteFileOperation } from "../../tools/operations/deleteFile";
import { downloadFileOperation } from "../../tools/operations/downloadFile";
import { getFileInfoOperation } from "../../tools/operations/getFileInfo";
import { listBucketsOperation } from "../../tools/operations/listBuckets";
import { listFilesOperation } from "../../tools/operations/listFiles";
import { presignUrlOperation } from "../../tools/operations/presignUrl";
import { MAX_PRESIGN_URL_EXPIRES_IN_SECONDS } from "../../tools/presignUrlLimits";
import { uploadFileOperation } from "../../tools/operations/uploadFile";
import { registerB2Tools } from "../../tools/registration";
import { withWindowUiStubs } from "./windowStubs";

const definitions = [
  listBucketsTool,
  listFilesTool,
  getFileInfoTool,
  downloadFileTool,
  uploadFileTool,
  deleteFileTool,
  presignUrlTool,
];

const operations: Array<{
  name: string;
  operation: B2ToolOperation<unknown, unknown>;
  input: unknown;
}> = [
  { name: "listBuckets", operation: listBucketsOperation, input: {} },
  {
    name: "listFiles",
    operation: listFilesOperation as B2ToolOperation<unknown, unknown>,
    input: { bucket: "b" },
  },
  {
    name: "getFileInfo",
    operation: getFileInfoOperation as B2ToolOperation<unknown, unknown>,
    input: { bucket: "b", path: "a.txt" },
  },
  {
    name: "downloadFile",
    operation: downloadFileOperation as B2ToolOperation<unknown, unknown>,
    input: { bucket: "b", path: "a.txt", localPath: "/tmp/a.txt" },
  },
  {
    name: "uploadFile",
    operation: uploadFileOperation as B2ToolOperation<unknown, unknown>,
    input: { bucket: "b", localPath: "/tmp/a.txt" },
  },
  {
    name: "deleteFile",
    operation: deleteFileOperation as B2ToolOperation<unknown, unknown>,
    input: { bucket: "b", path: "a.txt" },
  },
  {
    name: "presignUrl",
    operation: presignUrlOperation as B2ToolOperation<unknown, unknown>,
    input: { bucket: "b", path: "file.txt" },
  },
];

const noClientExtras: ToolExtras = { getClient: () => null };

async function withCancellationToken<T>(
  run: (token: vscode.CancellationToken) => Promise<T>,
): Promise<T> {
  const tokenSource = new vscode.CancellationTokenSource();

  try {
    return await run(tokenSource.token);
  } finally {
    tokenSource.dispose();
  }
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

async function withoutWorkspaceFolder<T>(run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    get: () => undefined,
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

suite("B2 LM tool failure handling", () => {
  function extensionTempFixture(prefix: string): string {
    const tempRoot = path.join(os.tmpdir(), TEMP_DIR_NAME, TEMP_TOOLS_DIR_NAME);
    ensureToolPrivateDirectorySync(tempRoot);
    return fs.mkdtempSync(path.join(tempRoot, prefix));
  }

  test("all tool adapters map injected B2 failures to friendly messages", async () => {
    const injected = classifyError(
      { status: 429, code: "too_many_requests", message: "slow down" },
      { retryAfter: 4 },
    );

    for (const definition of definitions) {
      const operation: B2ToolOperation<unknown, unknown> = {
        async execute() {
          throw injected;
        },
      };
      const adapter = new B2ToolAdapter(definition, operation, noClientExtras);

      await withCancellationToken((token) =>
        assert.rejects(
          () =>
            adapter.invoke(
              { input: {} } as vscode.LanguageModelToolInvocationOptions<unknown>,
              token,
            ),
          new RegExp(`${definition.displayName} failed: .*rate limit.*4 seconds`, "i"),
        ),
      );
    }
  });

  test("tool adapters preserve the original error cause", async () => {
    const injected = classifyError(
      { status: 429, code: "too_many_requests", message: "slow down" },
      { retryAfter: 4 },
    );
    const operation: B2ToolOperation<unknown, unknown> = {
      async execute() {
        throw injected;
      },
    };
    const adapter = new B2ToolAdapter(listBucketsTool, operation, noClientExtras);

    try {
      await withCancellationToken((token) =>
        adapter.invoke({ input: {} } as vscode.LanguageModelToolInvocationOptions<unknown>, token),
      );
      assert.fail("Expected adapter invocation to fail");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.strictEqual(error.cause, injected);
    }
  });

  test("tool adapters preserve expected extension guidance", async () => {
    const adapter = new B2ToolAdapter(listBucketsTool, listBucketsOperation, noClientExtras);

    await withCancellationToken((token) =>
      assert.rejects(
        () =>
          adapter.invoke(
            { input: {} } as vscode.LanguageModelToolInvocationOptions<unknown>,
            token,
          ),
        /B2: List Buckets failed: Not authenticated.*B2: Authenticate/i,
      ),
    );
  });

  test("registered tools resolve the live client after logout", async () => {
    if (!vscode.lm || typeof vscode.lm.registerTool !== "function") {
      return;
    }

    const registeredTools = new Map<string, vscode.LanguageModelTool<unknown>>();
    const mutableLm = vscode.lm as unknown as {
      registerTool: typeof vscode.lm.registerTool;
    };
    const originalRegisterTool = mutableLm.registerTool;
    mutableLm.registerTool = ((name: string, tool: vscode.LanguageModelTool<unknown>) => {
      registeredTools.set(name, tool);
      return { dispose() {} };
    }) as typeof vscode.lm.registerTool;

    let liveClient: B2Client | null = new B2Client({
      applicationKeyId: "key-id",
      applicationKey: "app-key",
    });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    try {
      registerB2Tools(context, () => liveClient);
      liveClient = null;

      const presignTool = registeredTools.get("b2_presignUrl");
      const deleteTool = registeredTools.get("b2_deleteFile");
      assert.ok(presignTool, "Expected b2_presignUrl to be registered");
      assert.ok(deleteTool, "Expected b2_deleteFile to be registered");

      await withCancellationToken((token) =>
        assert.rejects(
          () =>
            Promise.resolve(
              presignTool.invoke(
                {
                  input: { bucket: "private-bucket", path: "secret.txt" },
                } as unknown as vscode.LanguageModelToolInvocationOptions<unknown>,
                token,
              ),
            ),
          /Not authenticated.*B2: Authenticate/i,
        ),
      );
      await withCancellationToken((token) =>
        assert.rejects(
          () =>
            Promise.resolve(
              deleteTool.invoke(
                {
                  input: { bucket: "private-bucket", path: "important.txt" },
                } as unknown as vscode.LanguageModelToolInvocationOptions<unknown>,
                token,
              ),
            ),
          /Not authenticated.*B2: Authenticate/i,
        ),
      );
    } finally {
      mutableLm.registerTool = originalRegisterTool;
    }
  });

  test("tool adapters surface safe local file errors", async () => {
    const localError = new Error(
      "ENOENT: no such file or directory, open '/tmp/missing.txt'",
    ) as Error & { code: string };
    localError.code = "ENOENT";
    const operation: B2ToolOperation<unknown, unknown> = {
      async execute() {
        throw localError;
      },
    };
    const adapter = new B2ToolAdapter(uploadFileTool, operation, noClientExtras);

    await withCancellationToken((token) =>
      assert.rejects(
        () =>
          adapter.invoke(
            { input: {} } as vscode.LanguageModelToolInvocationOptions<unknown>,
            token,
          ),
        /B2: Upload File failed: ENOENT.*missing\.txt/i,
      ),
    );
  });

  test("upload tool surfaces missing local file path feedback", async () => {
    const dir = extensionTempFixture("upload-missing-");
    const client = {
      async getBucket() {
        assert.fail("Expected local path validation before bucket lookup");
      },
    } as unknown as B2Client;
    const adapter = new B2ToolAdapter(uploadFileTool, uploadFileOperation, {
      getClient: () => client,
    });

    try {
      await withWorkspaceFolder(dir, () =>
        withCancellationToken(async (token) => {
          let message = "";
          try {
            await adapter.invoke(
              {
                input: { bucket: "b", localPath: "missing.txt" },
              } as vscode.LanguageModelToolInvocationOptions<{
                bucket: string;
                localPath: string;
              }>,
              token,
            );
            assert.fail("Expected missing local file to reject.");
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }

          assert.match(message, /B2: Upload File failed: ENOENT.*missing\.txt/i);
          assert.strictEqual(message.includes(dir), false);
        }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("download tool requires a workspace before choosing localPath", async function () {
    if (vscode.workspace.workspaceFolders?.length) {
      this.skip();
    }

    const client = {
      async getBucket() {
        return {
          async download() {
            assert.fail("Expected workspace validation before download");
          },
        };
      },
    } as unknown as B2Client;

    await assert.rejects(
      () =>
        downloadFileOperation.execute(
          {
            bucket: "b",
            path: "a.txt",
            localPath: "a.txt",
          },
          { getClient: () => client },
        ),
      (error: unknown) => {
        assert.match((error as Error).message, /No workspace folder open/i);
        assert.strictEqual((error as NodeJS.ErrnoException).code, "ERR_B2_TOOL_INPUT");
        return true;
      },
    );
  });

  test("upload tool requires a workspace for absolute local paths", async () => {
    const client = {
      async getBucket() {
        assert.fail("Expected workspace validation before bucket lookup");
      },
    } as unknown as B2Client;

    await withoutWorkspaceFolder(async () => {
      await assert.rejects(
        () =>
          uploadFileOperation.execute(
            { bucket: "b", localPath: path.join(os.tmpdir(), "payload.txt") },
            { getClient: () => client },
          ),
        (error: unknown) => {
          assert.match(
            (error as Error).message,
            /requires an open workspace folder for localPath inputs/i,
          );
          assert.strictEqual((error as NodeJS.ErrnoException).code, "ERR_B2_TOOL_INPUT");
          return true;
        },
      );
    });
  });

  test("download tool surfaces existing destination feedback", async () => {
    const dir = extensionTempFixture("download-exists-");
    const targetPath = path.join(dir, "existing.txt");
    const client = {
      async getBucket() {
        return {
          async download() {
            assert.fail("Expected destination validation before download");
          },
        };
      },
    } as unknown as B2Client;
    const adapter = new B2ToolAdapter(downloadFileTool, downloadFileOperation, {
      getClient: () => client,
    });

    try {
      fs.writeFileSync(targetPath, "old");

      await withWorkspaceFolder(dir, () =>
        withCancellationToken((token) =>
          assert.rejects(
            () =>
              adapter.invoke(
                {
                  input: { bucket: "b", path: "remote.txt", localPath: "existing.txt" },
                } as vscode.LanguageModelToolInvocationOptions<{
                  bucket: string;
                  path: string;
                  localPath: string;
                }>,
                token,
              ),
            /B2: Download File failed: File already exists .*Choose a different localPath/i,
          ),
        ),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tool adapters surface absolute localPath feedback", async () => {
    const dir = extensionTempFixture("upload-absolute-");
    const client = {
      async getBucket() {
        assert.fail("Expected localPath validation before bucket lookup");
      },
    } as unknown as B2Client;
    const adapter = new B2ToolAdapter(uploadFileTool, uploadFileOperation, {
      getClient: () => client,
    });

    try {
      await withWorkspaceFolder(dir, () =>
        withCancellationToken((token) =>
          assert.rejects(
            () =>
              adapter.invoke(
                {
                  input: { bucket: "b", localPath: path.join(os.tmpdir(), "session-token.txt") },
                } as vscode.LanguageModelToolInvocationOptions<{
                  bucket: string;
                  localPath: string;
                }>,
                token,
              ),
            /B2: Upload File failed: localPath must stay within the current workspace/i,
          ),
        ),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("presign tool surfaces invalid expiresIn feedback", async () => {
    const client = {
      accountInfo: { getDownloadUrl: () => "https://download.example.com" },
      async getBucket() {
        assert.fail("Expected expiresIn validation before bucket lookup");
      },
    } as unknown as B2Client;
    const adapter = new B2ToolAdapter(presignUrlTool, presignUrlOperation, {
      getClient: () => client,
    });

    await withCancellationToken((token) =>
      assert.rejects(
        () =>
          adapter.invoke(
            {
              input: { bucket: "b", path: "file.txt", expiresIn: 0 },
            } as vscode.LanguageModelToolInvocationOptions<{
              bucket: string;
              path: string;
              expiresIn: number;
            }>,
            token,
          ),
        /B2: Pre-sign URL failed: expiresIn must be an integer between 1 and \d+ seconds/i,
      ),
    );
  });

  test("all tool operations report missing authentication", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-auth-order-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");

    try {
      await withWorkspaceFolder(dir, async () => {
        for (const entry of operations) {
          const input =
            entry.name === "uploadFile"
              ? { bucket: "b", localPath: "a.txt" }
              : entry.name === "downloadFile"
                ? { bucket: "b", path: "a.txt", localPath: "download.txt" }
                : entry.input;
          await assert.rejects(
            () => entry.operation.execute(input, noClientExtras),
            /Not authenticated/i,
          );
        }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("presignUrl rejects durations above the documented maximum", async () => {
    const client = {
      async getBucket() {
        assert.fail("Expected expiresIn validation before bucket lookup");
      },
    } as unknown as B2Client;

    await assert.rejects(
      () =>
        presignUrlOperation.execute(
          {
            bucket: "b",
            path: "a.txt",
            expiresIn: MAX_PRESIGN_URL_EXPIRES_IN_SECONDS + 1,
          },
          { getClient: () => client },
        ),
      new RegExp(`between 1 and ${MAX_PRESIGN_URL_EXPIRES_IN_SECONDS} seconds`, "i"),
    );
  });

  test("upload tool result reports workspace-relative source path", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-result-"));
    const localPath = path.join(workspaceDir, "payload.txt");
    fs.writeFileSync(localPath, "");
    const bucket = {
      async upload(options: { fileName: string }) {
        return {
          fileId: "uploaded-id",
          fileName: options.fileName,
          contentLength: 0,
        };
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        let result: Awaited<ReturnType<typeof uploadFileOperation.execute>> | undefined;
        await withWindowUiStubs({}, async () => {
          result = await uploadFileOperation.execute(
            { bucket: "b", localPath: "./payload.txt", remotePath: "remote/payload.txt" },
            { getClient: () => client },
          );
        });

        if (!result) {
          throw new Error("uploadFileOperation did not return a result.");
        }
        assert.match(result.message, /Uploaded payload\.txt to b2:\/\/b\/remote\/payload\.txt/);
        assert.strictEqual(result.message.includes(workspaceDir), false);
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("download tool result reports workspace-relative destination path", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-result-"));
    const destinationPath = path.join(workspaceDir, "downloads", "payload.txt");
    const bucket = {
      async download() {
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("downloaded"));
              controller.close();
            },
          }),
        };
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        let result: Awaited<ReturnType<typeof downloadFileOperation.execute>> | undefined;
        await withWindowUiStubs({}, async () => {
          result = await downloadFileOperation.execute(
            { bucket: "b", path: "remote/payload.txt", localPath: "downloads/payload.txt" },
            { getClient: () => client },
          );
        });

        if (!result) {
          throw new Error("downloadFileOperation did not return a result.");
        }
        assert.strictEqual(result.localPath, "downloads/payload.txt");
        assert.match(
          result.message,
          /Downloaded remote\/payload\.txt from b to downloads\/payload\.txt/,
        );
        assert.strictEqual(result.message.includes(workspaceDir), false);
        assert.strictEqual(fs.readFileSync(destinationPath, "utf8"), "downloaded");
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("object lookup failures are mapped for file-oriented tools", async () => {
    const dir = extensionTempFixture("tools-");
    const localFile = path.join(dir, "a.txt");
    fs.writeFileSync(localFile, "hello");

    const missingBucketClient = new B2Client({
      applicationKeyId: "key-id",
      applicationKey: "application-key",
    });
    missingBucketClient.getBucket = async () => null;

    const getMissingBucketExtras: ToolExtras = {
      getClient: () => missingBucketClient,
    };

    try {
      await withWorkspaceFolder(dir, async () => {
        for (const entry of operations.filter((operation) => operation.name !== "listBuckets")) {
          const input =
            entry.name === "uploadFile"
              ? { bucket: "b", localPath: "a.txt" }
              : entry.name === "downloadFile"
                ? { bucket: "b", path: "a.txt", localPath: "download.txt" }
                : entry.input;
          await assert.rejects(
            () => entry.operation.execute(input, getMissingBucketExtras),
            /bucket .* not found/i,
          );
        }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("download tool checks buckets before creating parent directories", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-missing-"));
    const downloadDir = path.join(workspaceDir, "downloads");
    const client = {
      async getBucket() {
        return null;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "missing", path: "payload.txt", localPath: "downloads/payload.txt" },
              { getClient: () => client },
            ),
          /bucket .* not found/i,
        );
      });

      assert.strictEqual(fs.existsSync(downloadDir), false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("download tool rejects workspace path traversal before writing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-policy-"));
    let downloadWasCalled = false;
    let bucketLookupWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        throw new Error("download should not start");
      },
    };
    const client = {
      async getBucket() {
        bucketLookupWasCalled = true;
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(dir, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "b", path: "payload.txt", localPath: "../outside.txt" },
              { getClient: () => client },
            ),
          /must (stay within the current workspace|not contain path traversal segments)/i,
        );
      });
      assert.strictEqual(bucketLookupWasCalled, false);
      assert.strictEqual(downloadWasCalled, false);
      assert.strictEqual(fs.existsSync(path.join(path.dirname(dir), "outside.txt")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("download tool rejects directory-like localPath before downloading", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-directory-path-"));
    let downloadWasCalled = false;
    let bucketLookupWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        throw new Error("download should not start");
      },
    };
    const client = {
      async getBucket() {
        bucketLookupWasCalled = true;
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(dir, async () => {
        for (const localPath of ["downloads/", "", ".", ".."] as const) {
          await assert.rejects(
            () =>
              downloadFileOperation.execute(
                { bucket: "b", path: "payload.txt", localPath },
                { getClient: () => client },
              ),
            /file path, not a directory path/i,
          );
        }
      });
      assert.strictEqual(bucketLookupWasCalled, false);
      assert.strictEqual(downloadWasCalled, false);
      assert.strictEqual(fs.existsSync(path.join(dir, "downloads")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("download tool rejects invalid remote paths before B2 lookup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-remote-path-"));
    let downloadWasCalled = false;
    let bucketLookupWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        throw new Error("download should not start");
      },
    };
    const client = {
      async getBucket() {
        bucketLookupWasCalled = true;
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(dir, async () => {
        for (const [remotePath, expectedError] of [
          ["", /empty/i],
          ["bad\0path", /NUL/i],
          ["reports/", /folder path ending in slash/i],
        ] as const) {
          await assert.rejects(
            () =>
              downloadFileOperation.execute(
                { bucket: "b", path: remotePath, localPath: "download.txt" },
                { getClient: () => client },
              ),
            expectedError,
          );
        }
      });
      assert.strictEqual(bucketLookupWasCalled, false);
      assert.strictEqual(downloadWasCalled, false);
      assert.strictEqual(fs.existsSync(path.join(dir, "download.txt")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("download tool requires an open workspace for local writes", async () => {
    let downloadWasCalled = false;
    let bucketLookupWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        throw new Error("download should not start");
      },
    };
    const client = {
      async getBucket() {
        bucketLookupWasCalled = true;
        return bucket;
      },
    } as unknown as B2Client;

    await withoutWorkspaceFolder(async () => {
      for (const input of [
        { bucket: "b", path: "payload.txt", localPath: "downloads/payload.txt" },
        { bucket: "b", path: "payload.txt" },
      ]) {
        await assert.rejects(
          () => downloadFileOperation.execute(input, { getClient: () => client }),
          /requires an open workspace folder when localPath is omitted or relative/i,
        );
      }
    });

    assert.strictEqual(bucketLookupWasCalled, false);
    assert.strictEqual(downloadWasCalled, false);
  });

  test("download tool rejects symlinked workspace destinations before writing", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-symlink-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-outside-"));
    const linkPath = path.join(workspaceDir, "downloads");
    const symlinkCreated = createDirectorySymlink(outsideDir, linkPath);
    let downloadWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        throw new Error("download should not start");
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      if (!symlinkCreated) {
        return;
      }

      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "b", path: "payload.txt", localPath: "downloads/payload.txt" },
              { getClient: () => client },
            ),
          (error: unknown) => {
            assert.match((error as Error).message, /must stay within the current workspace/i);
            assert.match(
              String((error as NodeJS.ErrnoException).code),
              /ERR_B2_TOOL_INPUT|ERR_PATH_CONTAINMENT/,
            );
            return true;
          },
        );
      });

      assert.strictEqual(downloadWasCalled, false);
      assert.strictEqual(fs.existsSync(path.join(outsideDir, "payload.txt")), false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("download tool rejects parent directory symlink swaps during transfer", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-swap-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-swap-outside-"));
    const downloadDir = path.join(workspaceDir, "downloads");
    const outsideTarget = path.join(outsideDir, "payload.txt");
    const probeLink = path.join(workspaceDir, "probe");
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    let downloadWasCalled = false;

    const bucket = {
      async download() {
        downloadWasCalled = true;
        fs.rmSync(downloadDir, { recursive: true, force: true });
        fs.symlinkSync(outsideDir, downloadDir, process.platform === "win32" ? "junction" : "dir");
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("do not write outside"));
              controller.close();
            },
          }),
        };
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { recursive: true, force: true });

      await withWorkspaceFolder(workspaceDir, async () => {
        let message = "";
        try {
          await downloadFileOperation.execute(
            { bucket: "b", path: "payload.txt", localPath: "downloads/payload.txt" },
            { getClient: () => client },
          );
          assert.fail("Expected symlink swap to reject.");
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        assert.match(message, /real directory|symlink|outside the allowed root/i);
        assert.strictEqual(message.includes(workspaceDir), false);
        assert.strictEqual(message.includes(outsideDir), false);
      });

      assert.strictEqual(downloadWasCalled, true);
      assert.strictEqual(fs.existsSync(outsideTarget), false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("download tool rejects control-like localPath segments before writing", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-control-"));
    let downloadWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("downloaded"));
              controller.close();
            },
          }),
        };
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        for (const localPath of [
          ".git/hooks/pre-commit",
          ".github/workflows/ci-helper.yml",
          ".github./workflows/ci-helper.yml",
        ]) {
          await assert.rejects(
            () =>
              downloadFileOperation.execute(
                { bucket: "b", path: "payload.txt", localPath },
                { getClient: () => client },
              ),
            /workspace control directories|workspace control directories such as/i,
          );
        }
      });

      assert.strictEqual(downloadWasCalled, false);
      assert.strictEqual(fs.existsSync(path.join(workspaceDir, ".git")), false);
      assert.strictEqual(fs.existsSync(path.join(workspaceDir, ".github")), false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("download tool refuses to overwrite existing workspace files", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-existing-"));
    const existingPath = path.join(workspaceDir, "payload.txt");
    fs.writeFileSync(existingPath, "keep me");
    let getBucketWasCalled = false;
    let downloadWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        throw new Error("download should not start");
      },
    };
    const client = {
      async getBucket() {
        getBucketWasCalled = true;
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "b", path: "payload.txt", localPath: "payload.txt" },
              { getClient: () => client },
            ),
          /File already exists .*Choose a different localPath/i,
        );
      });

      assert.strictEqual(getBucketWasCalled, false);
      assert.strictEqual(downloadWasCalled, false);
      assert.strictEqual(fs.readFileSync(existingPath, "utf8"), "keep me");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("download tool refuses destinations created during transfer", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-race-"));
    const destinationPath = path.join(workspaceDir, "payload.txt");
    let downloadWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        fs.writeFileSync(destinationPath, "keep me");
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("replace me"));
              controller.close();
            },
          }),
        };
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "b", path: "payload.txt", localPath: "payload.txt" },
              { getClient: () => client },
            ),
          /EEXIST|file already exists/i,
        );
      });

      assert.strictEqual(downloadWasCalled, true);
      assert.strictEqual(fs.readFileSync(destinationPath, "utf8"), "keep me");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("download tool rejects parent directories swapped to symlinks during transfer", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-race-link-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-race-outside-"));
    const destinationDirectory = path.join(workspaceDir, "downloads");
    const outsidePath = path.join(outsideDir, "authorized_keys");
    fs.mkdirSync(destinationDirectory);
    const probeLink = path.join(workspaceDir, "probe-link");
    const symlinkSupported = createDirectorySymlink(outsideDir, probeLink);
    fs.rmSync(probeLink, { recursive: true, force: true });
    let downloadWasCalled = false;
    const bucket = {
      async download() {
        downloadWasCalled = true;
        fs.rmSync(destinationDirectory, { recursive: true, force: true });
        createDirectorySymlink(outsideDir, destinationDirectory);
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("downloaded"));
              controller.close();
            },
          }),
        };
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      if (!symlinkSupported) {
        return;
      }

      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "b", path: "authorized_keys", localPath: "downloads/authorized_keys" },
              { getClient: () => client },
            ),
          /outside the allowed root|symlink|real directory/i,
        );
      });

      assert.strictEqual(downloadWasCalled, true);
      assert.strictEqual(fs.existsSync(outsidePath), false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("download tool sanitizes unsafe default basenames before writing", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-name-"));
    const unsafeNames = ["reports/invoice\u202Egnp.exe", "reports/aux"];
    const downloadedPaths: string[] = [];
    const bucket = {
      async download() {
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("downloaded"));
              controller.close();
            },
          }),
        };
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        for (const remotePath of unsafeNames) {
          const result = await downloadFileOperation.execute(
            { bucket: "b", path: remotePath },
            { getClient: () => client },
          );
          downloadedPaths.push(result.localPath);
          assert.doesNotMatch(path.basename(result.localPath), /[\u202a-\u202e\u2066-\u2069]/i);
          assert.notStrictEqual(path.basename(result.localPath), path.basename(remotePath));
          assert.strictEqual(
            fs.readFileSync(path.join(workspaceDir, result.localPath), "utf8"),
            "downloaded",
          );
        }
      });

      assert.strictEqual(fs.existsSync(path.join(workspaceDir, "invoice\u202Egnp.exe")), false);
      assert.strictEqual(fs.existsSync(path.join(workspaceDir, "aux")), false);
      assert.strictEqual(new Set(downloadedPaths).size, unsafeNames.length);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("download tool preserves non-sensitive hidden default basenames", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-dotfile-"));
    const bucket = {
      async download() {
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("downloaded"));
              controller.close();
            },
          }),
        };
      },
    };
    const client = {
      async getBucket() {
        return bucket;
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        const result = await downloadFileOperation.execute(
          { bucket: "b", path: "reports/.notes" },
          { getClient: () => client },
        );

        assert.strictEqual(path.basename(result.localPath), ".notes");
        assert.strictEqual(
          fs.readFileSync(path.join(workspaceDir, result.localPath), "utf8"),
          "downloaded",
        );
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("upload tool rejects workspace path traversal before reading", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-policy-"));
    const client = {
      async getBucket() {
        assert.fail("Expected traversal validation before bucket lookup");
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(dir, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "b", localPath: "../secret.txt" },
              { getClient: () => client },
            ),
          /must (stay within the current workspace|not contain path traversal segments)/i,
        );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upload tool rejects workspace control directories before reading", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-control-"));
    const controlFile = path.join(workspaceDir, ".git", "config");
    fs.mkdirSync(path.dirname(controlFile), { recursive: true });
    fs.writeFileSync(controlFile, "secret");
    const client = {
      async getBucket() {
        assert.fail("Expected control-directory validation before bucket lookup");
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "b", localPath: ".git/config" },
              { getClient: () => client },
            ),
          /control director(?:y|ies)/i,
        );
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("upload tool rejects directory-like localPath before B2 lookup", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-directory-"));
    const client = {
      async getBucket() {
        assert.fail("Expected localPath validation before bucket lookup");
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        for (const localPath of ["", ".", "..", "payloads/"] as const) {
          await assert.rejects(
            () =>
              uploadFileOperation.execute({ bucket: "b", localPath }, { getClient: () => client }),
            /file path, not a directory path/i,
          );
        }
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("upload tool rejects direct symlink localPath explicitly before bucket lookup", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-link-"));
    const targetFile = path.join(workspaceDir, "payload.txt");
    const linkPath = path.join(workspaceDir, "payload-link.txt");
    fs.writeFileSync(targetFile, "payload");
    const symlinkCreated = createFileSymlink(targetFile, linkPath);
    const client = {
      async getBucket() {
        assert.fail("Expected symlink validation before bucket lookup");
      },
    } as unknown as B2Client;

    try {
      if (!symlinkCreated) {
        return;
      }

      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "b", localPath: "payload-link.txt" },
              { getClient: () => client },
            ),
          (error: unknown) => {
            assert.match((error as Error).message, /symlink|symbolic link/i);
            assert.match((error as Error).message, /payload-link\.txt/);
            assert.strictEqual((error as Error).message.includes(workspaceDir), false);
            assert.strictEqual((error as NodeJS.ErrnoException).code, "ERR_B2_TOOL_INPUT");
            return true;
          },
        );
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("upload tool treats Windows absolute localPath as absolute before lstat", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-winabs-"));
    const targetFile = path.join(workspaceDir, "target.txt");
    const requestedPath = String.raw`C:\temp\payload.txt`;
    const workspaceProbePath = path.join(workspaceDir, requestedPath);
    fs.writeFileSync(targetFile, "payload");
    const symlinkCreated = createFileSymlink(targetFile, workspaceProbePath);
    const client = {
      async getBucket() {
        assert.fail("Expected localPath validation before bucket lookup");
      },
    } as unknown as B2Client;

    try {
      if (!symlinkCreated) {
        return;
      }

      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "b", localPath: requestedPath },
              { getClient: () => client },
            ),
          /current workspace/i,
        );
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("upload tool rejects symlinks into workspace control directories", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-control-link-"));
    const controlFile = path.join(workspaceDir, ".git", "config");
    const linkPath = path.join(workspaceDir, "backup.txt");
    fs.mkdirSync(path.dirname(controlFile), { recursive: true });
    fs.writeFileSync(controlFile, "secret");
    const symlinkCreated = createFileSymlink(controlFile, linkPath);
    const client = {
      async getBucket() {
        assert.fail("Expected realpath control-directory validation before bucket lookup");
      },
    } as unknown as B2Client;

    try {
      if (!symlinkCreated) {
        return;
      }

      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "b", localPath: "backup.txt" },
              { getClient: () => client },
            ),
          /control director(?:y|ies)/i,
        );
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("upload tool rejects workspace secret files", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-secret-"));
    fs.writeFileSync(path.join(workspaceDir, ".env"), "TOKEN=secret");
    fs.mkdirSync(path.join(workspaceDir, ".config", "b2"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, ".config", "b2", "account.json"), "{}");
    const client = {
      async getBucket() {
        assert.fail("Expected secret-file validation before bucket lookup");
      },
    } as unknown as B2Client;

    try {
      await withWorkspaceFolder(workspaceDir, async () => {
        for (const localPath of [".env", path.join(".config", "b2", "account.json")]) {
          await assert.rejects(
            () =>
              uploadFileOperation.execute({ bucket: "b", localPath }, { getClient: () => client }),
            /sensitive workspace path/i,
          );
        }
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("upload tool rejects symlink escapes before reading", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-symlink-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    const linkPath = path.join(workspaceDir, "link");
    fs.writeFileSync(outsideFile, "secret");
    const symlinkCreated = createDirectorySymlink(outsideDir, linkPath);
    const client = {
      async getBucket() {
        assert.fail("Expected realpath validation before bucket lookup");
      },
    } as unknown as B2Client;

    try {
      if (!symlinkCreated) {
        return;
      }

      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "b", localPath: "link/secret.txt" },
              { getClient: () => client },
            ),
          /must stay within the current workspace/i,
        );
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("upload tool rejects source swaps after validation before reading", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-swap-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-swap-outside-"));
    const localPath = path.join(workspaceDir, "payload.txt");
    const outsideFile = path.join(outsideDir, "secret.txt");
    const probeLink = path.join(workspaceDir, "probe");
    fs.writeFileSync(localPath, "safe");
    fs.writeFileSync(outsideFile, "secret");
    const symlinkSupported = createFileSymlink(outsideFile, probeLink);
    let uploadStarted = false;
    const bucket = {
      file() {
        uploadStarted = true;
        throw new Error("upload should not start");
      },
      async upload() {
        uploadStarted = true;
        throw new Error("upload should not start");
      },
    };
    const client = {
      async getBucket() {
        fs.rmSync(localPath, { force: true });
        fs.symlinkSync(outsideFile, localPath, "file");
        return bucket;
      },
    } as unknown as B2Client;

    try {
      if (!symlinkSupported) {
        return;
      }
      fs.rmSync(probeLink, { force: true });

      await withWorkspaceFolder(workspaceDir, async () => {
        await assert.rejects(
          () =>
            uploadFileOperation.execute(
              { bucket: "b", localPath: "payload.txt" },
              { getClient: () => client },
            ),
          /changed before upload/i,
        );
      });

      assert.strictEqual(uploadStarted, false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
