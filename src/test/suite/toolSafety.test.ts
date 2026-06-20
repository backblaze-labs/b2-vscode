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
  const tokenSource = new vscode.CancellationTokenSource();

  try {
    const prepared = await adapter.prepareInvocation(
      { input } as unknown as vscode.LanguageModelToolInvocationPrepareOptions<unknown>,
      tokenSource.token,
    );
    const cm = prepared.confirmationMessages;
    assert.ok(cm, `${def.name} must require a confirmation`);
    if (!cm) {
      return "";
    }
    return typeof cm.message === "string" ? cm.message : cm.message.value;
  } finally {
    tokenSource.dispose();
  }
}

suite("LM Tool Safety", () => {
  test("all tool definitions declare a risk level", () => {
    for (const def of allDefinitions) {
      assert.ok(def.risk, `${def.name} should declare a risk`);
    }
  });

  test("listFiles limit schema matches integer validation", () => {
    const limit = listFilesTool.parameters.properties.limit as Record<string, unknown>;

    assert.strictEqual(limit.type, "integer");
    assert.strictEqual(limit.minimum, 1);
    assert.strictEqual(limit.maximum, 1000);
  });

  test("cancellation is passed through without a failure wrapper", async () => {
    const cancellationOperation: B2ToolOperation<unknown, unknown> = {
      async execute() {
        throw new vscode.CancellationError();
      },
    };
    const adapter = new B2ToolAdapter(listFilesTool, cancellationOperation, extras);
    const tokenSource = new vscode.CancellationTokenSource();

    try {
      await assert.rejects(
        () =>
          adapter.invoke(
            { input: {} } as unknown as vscode.LanguageModelToolInvocationOptions<unknown>,
            tokenSource.token,
          ),
        (error) => {
          assert.ok(error instanceof vscode.CancellationError);
          assert.doesNotMatch(error instanceof Error ? error.message : "", /failed/i);
          return true;
        },
      );
    } finally {
      tokenSource.dispose();
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

  test("JSON input previews use fences longer than input backtick runs", async () => {
    const text = await confirmText(deleteFileTool, {
      bucket: "my-bucket",
      path: "data/```spoof.md",
    });

    assert.match(text, /^````json$/m);
    assert.match(text, /^````$/m);
    assert.doesNotMatch(text, /^```json$/m);
    assert.doesNotMatch(text, /^```$/m);
  });

  test("presignUrl warns about a shareable link and names the target", async () => {
    const text = await confirmText(presignUrlTool, {
      bucket: "my-bucket",
      path: "r/q4.pdf",
      expiresIn: 900,
    });
    assert.match(text, /shareable|link|download url/i);
    assert.match(text, /my-bucket\/r\/q4\.pdf/);
    assert.match(text, /prefix-scoped|starting with/i);
    assert.match(text, /900 seconds/i);
  });

  test("uploadFile warns that local file contents leave the workspace", async () => {
    const text = await confirmText(uploadFileTool, {
      localPath: "out.csv",
      bucket: "my-bucket",
      remotePath: "data/out.csv",
    });
    assert.match(text, /upload/i);
    assert.match(text, /local file contents/i);
    assert.match(text, /outside VS Code/i);
    assert.match(text, /no Backblaze login required/i);
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

  test("uploadFile derives the default remote key from portable separators", async () => {
    const text = await confirmText(uploadFileTool, {
      localPath: "reports\\out.csv",
      bucket: "my-bucket",
    });

    assert.match(text, /my-bucket\/out\.csv/);
    assert.doesNotMatch(text, /my-bucket\/reports\\out\.csv/);
  });

  test("downloadFile names an explicit localPath destination", async () => {
    const text = await confirmText(downloadFileTool, {
      bucket: "my-bucket",
      path: "data/out.csv",
      localPath: "/tmp/downloads/out.csv",
    });

    assert.match(text, /absolute path \/tmp\/downloads\/out\.csv/);
    assert.match(text, /rejected by this tool/);
    assert.doesNotMatch(text, /your local workspace/);
  });

  test("downloadFile marks relative localPath as workspace-relative", async () => {
    const text = await confirmText(downloadFileTool, {
      bucket: "my-bucket",
      path: "data/out.csv",
      localPath: "downloads/out.csv",
    });

    assert.match(text, /workspace-relative path downloads\/out\.csv/);
  });

  test("downloadFile default destination names the first open workspace folder", async () => {
    const text = await confirmText(downloadFileTool, {
      bucket: "my-bucket",
      path: "data/out.csv",
    });

    assert.match(text, /first open workspace folder/i);
    assert.doesNotMatch(text, /your local workspace/);
  });

  test("malformed required inputs use a placeholder in confirmations", async () => {
    const text = await confirmText(deleteFileTool, { bucket: "my-bucket" });

    assert.match(text, /my-bucket\/\?/);
    assert.doesNotMatch(text, /undefined/);
  });

  test("read-only listBuckets is marked read-only", async () => {
    const text = await confirmText(listBucketsTool, {});
    assert.match(text, /read-only/i);
  });
});
