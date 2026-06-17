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

      await assert.rejects(
        () =>
          adapter.invoke(
            { input: {} } as vscode.LanguageModelToolInvocationOptions<unknown>,
            new vscode.CancellationTokenSource().token,
          ),
        new RegExp(`${definition.displayName} failed: .*rate limit.*4 second`, "i"),
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
      await adapter.invoke(
        { input: {} } as vscode.LanguageModelToolInvocationOptions<unknown>,
        new vscode.CancellationTokenSource().token,
      );
      assert.fail("Expected adapter invocation to fail");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.strictEqual(error.cause, injected);
    }
  });

  test("tool adapters preserve expected extension guidance", async () => {
    const adapter = new B2ToolAdapter(listBucketsTool, listBucketsOperation, noClientExtras);

    await assert.rejects(
      () =>
        adapter.invoke(
          { input: {} } as vscode.LanguageModelToolInvocationOptions<unknown>,
          new vscode.CancellationTokenSource().token,
        ),
      /B2: List Buckets failed: Not authenticated.*B2: Authenticate/i,
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

    await assert.rejects(
      () =>
        adapter.invoke(
          { input: {} } as vscode.LanguageModelToolInvocationOptions<unknown>,
          new vscode.CancellationTokenSource().token,
        ),
      /B2: Upload File failed: ENOENT.*missing\.txt/i,
    );
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
      for (const entry of operations.filter((operation) => operation.name !== "listBuckets")) {
        const input =
          entry.name === "uploadFile" ? { bucket: "b", localPath: localFile } : entry.input;
        await assert.rejects(
          () => entry.operation.execute(input, getMissingBucketExtras),
          /bucket .* not found/i,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
