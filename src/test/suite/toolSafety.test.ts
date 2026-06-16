/**
 * Tests for Language Model tool confirmation safety.
 *
 * Verifies that destructive and exfiltration-capable tools surface explicit,
 * effect-naming confirmations, and that read-only tools are marked as such.
 *
 * @module test/suite/toolSafety.test
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { B2ToolAdapter } from "../../tools/b2ToolAdapter";
import { deleteFileTool } from "../../tools/definitions/deleteFile";
import { downloadFileTool } from "../../tools/definitions/downloadFile";
import { getFileInfoTool } from "../../tools/definitions/getFileInfo";
import { listBucketsTool } from "../../tools/definitions/listBuckets";
import { listFilesTool } from "../../tools/definitions/listFiles";
import { presignUrlTool } from "../../tools/definitions/presignUrl";
import { uploadFileTool } from "../../tools/definitions/uploadFile";
import type { B2ToolDefinition, B2ToolOperation, ToolExtras } from "../../tools/types";

const noopOperation: B2ToolOperation<unknown, unknown> = {
  async execute() {
    return {};
  },
};

const extras: ToolExtras = { getClient: () => null };
const allDefinitions = [
  deleteFileTool,
  downloadFileTool,
  getFileInfoTool,
  listBucketsTool,
  listFilesTool,
  presignUrlTool,
  uploadFileTool,
];

/** Run prepareInvocation for a tool and return the confirmation message text. */
async function confirmText(def: B2ToolDefinition, input: unknown): Promise<string> {
  const adapter = new B2ToolAdapter(def, noopOperation, extras);
  const token = new vscode.CancellationTokenSource().token;
  const prepared = await adapter.prepareInvocation(
    { input } as unknown as vscode.LanguageModelToolInvocationPrepareOptions<unknown>,
    token,
  );
  const cm = prepared.confirmationMessages;
  assert.ok(cm, `${def.name} must require a confirmation`);
  if (!cm) {
    return "";
  }
  return typeof cm.message === "string" ? cm.message : cm.message.value;
}

suite("LM Tool Safety", () => {
  test("all tool definitions declare a risk level", () => {
    for (const def of allDefinitions) {
      assert.ok(def.risk, `${def.name} should declare a risk`);
    }
  });

  test("destructive deleteFile warns it is irreversible and names the target", async () => {
    const text = await confirmText(deleteFileTool, { bucket: "my-bucket", path: "data/x.csv" });
    assert.match(text, /cannot be undone/i);
    assert.match(text, /my-bucket\/data\/x\.csv/);
  });

  test("confirmation effects are rendered as single-line inline code", async () => {
    const text = await confirmText(deleteFileTool, {
      bucket: "my-bucket\n**not the real effect**",
      path: "data/`x`.csv",
    });

    assert.match(
      text,
      /``permanently delete b2:\/\/my-bucket\\n\*\*not the real effect\*\*\/data\/`x`\.csv``/,
    );
    assert.doesNotMatch(text, /\*\*permanently delete/);
  });

  test("presignUrl warns about a shareable link and names the target", async () => {
    const text = await confirmText(presignUrlTool, { bucket: "my-bucket", path: "r/q4.pdf" });
    assert.match(text, /shareable|link|download url/i);
    assert.match(text, /my-bucket\/r\/q4\.pdf/);
  });

  test("write uploadFile names the upload effect", async () => {
    const text = await confirmText(uploadFileTool, {
      localPath: "out.csv",
      bucket: "my-bucket",
      remotePath: "data/out.csv",
    });
    assert.match(text, /upload/i);
    assert.match(text, /my-bucket\/data\/out\.csv/);
  });

  test("uploadFile derives the default remote key from the local file name", async () => {
    const text = await confirmText(uploadFileTool, {
      localPath: "/tmp/reports/out.csv",
      bucket: "my-bucket",
    });

    assert.match(text, /my-bucket\/out\.csv/);
    assert.doesNotMatch(text, /\(file name\)/);
  });

  test("read-only listBuckets is marked read-only", async () => {
    const text = await confirmText(listBucketsTool, {});
    assert.match(text, /read-only/i);
  });
});
