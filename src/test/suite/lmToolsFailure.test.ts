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
import { uploadFileOperation } from "../../tools/operations/uploadFile";

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
    input: { bucket: "b", path: "a.txt" },
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

suite("B2 LM tool failure handling", () => {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-upload-missing-"));
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
        withCancellationToken((token) =>
          assert.rejects(
            () =>
              adapter.invoke(
                {
                  input: { bucket: "b", localPath: "missing.txt" },
                } as vscode.LanguageModelToolInvocationOptions<{
                  bucket: string;
                  localPath: string;
                }>,
                token,
              ),
            /B2: Upload File failed: ENOENT.*missing\.txt/i,
          ),
        ),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("all tool operations report missing authentication", async () => {
    for (const entry of operations) {
      await assert.rejects(
        () => entry.operation.execute(entry.input, noClientExtras),
        /Not authenticated/i,
      );
    }
  });

  test("object lookup failures are mapped for file-oriented tools", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-tools-"));
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
            entry.name === "uploadFile" ? { bucket: "b", localPath: "a.txt" } : entry.input;
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

  test("download tool rejects workspace path traversal before writing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-download-policy-"));
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
      await withWorkspaceFolder(dir, async () => {
        await assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: "b", path: "payload.txt", localPath: "../outside.txt" },
              { getClient: () => client },
            ),
          /path traversal|relative path inside/i,
        );
      });
      assert.strictEqual(downloadWasCalled, false);
      assert.strictEqual(fs.existsSync(path.join(path.dirname(dir), "outside.txt")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("download tool requires an open workspace for local writes", async () => {
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

    await withoutWorkspaceFolder(async () => {
      for (const input of [
        { bucket: "b", path: "payload.txt", localPath: "downloads/payload.txt" },
        { bucket: "b", path: "payload.txt" },
      ]) {
        await assert.rejects(
          () => downloadFileOperation.execute(input, { getClient: () => client }),
          /requires an open workspace folder.*workspace-relative/i,
        );
      }
    });

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
          /real directory|symlink/i,
        );
      });

      assert.strictEqual(downloadWasCalled, false);
      assert.strictEqual(fs.existsSync(path.join(outsideDir, "payload.txt")), false);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
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
          /path traversal|relative path inside/i,
        );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
          /outside the open workspace/i,
        );
      });
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
