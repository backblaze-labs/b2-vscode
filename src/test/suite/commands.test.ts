/**
 * Tests for command error message construction.
 *
 * @module test/suite/commands
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { B2Client, classifyError } from "@backblaze-labs/b2-sdk";
import { buildCommandErrorMessage, openFileCommand } from "../../commands";
import { B2PartialFailureError } from "../../errors";
import type { FileTreeItem } from "../../models/fileTreeItem";
import type { TempFileManager } from "../../services/tempFileManager";

function stubWithProgress(): () => void {
  const tokenSource = new vscode.CancellationTokenSource();
  const mutableWindow = vscode.window as unknown as {
    withProgress: typeof vscode.window.withProgress;
  };
  const originalWithProgress = mutableWindow.withProgress;

  mutableWindow.withProgress = ((_options, task) =>
    task({ report: () => undefined }, tokenSource.token)) as typeof vscode.window.withProgress;

  return () => {
    mutableWindow.withProgress = originalWithProgress;
    tokenSource.dispose();
  };
}

function stubErrorMessages(messages: string[]): () => void {
  const mutableWindow = vscode.window as unknown as {
    showErrorMessage: typeof vscode.window.showErrorMessage;
  };
  const originalShowErrorMessage = mutableWindow.showErrorMessage;

  mutableWindow.showErrorMessage = ((message: string) => {
    messages.push(message);
    return Promise.resolve(undefined);
  }) as typeof vscode.window.showErrorMessage;

  return () => {
    mutableWindow.showErrorMessage = originalShowErrorMessage;
  };
}

suite("B2 commands error handling", () => {
  test("authentication errors surface invalid credential guidance", () => {
    const message = buildCommandErrorMessage(
      "B2: Authentication failed",
      classifyError({ status: 401, code: "bad_auth_token", message: "bad key" }),
    );

    assert.match(message, /^B2: Authentication failed\./);
    assert.match(message, /Run B2: Authenticate/i);
  });

  test("partial rename failures do not look successful", () => {
    const message = buildCommandErrorMessage(
      "B2: Failed to rename",
      new B2PartialFailureError(
        'Rename incomplete. Copied "old.csv" to "new.csv", but failed to delete the original. Both B2 objects may exist.',
      ),
    );

    assert.match(message, /Rename incomplete/i);
    assert.match(message, /Both B2 objects may exist/i);
    assert.doesNotMatch(message, /Renamed to/i);
  });

  test("open file cancellation does not show a failure notification", async () => {
    const messages: string[] = [];
    const restoreProgress = stubWithProgress();
    const restoreErrors = stubErrorMessages(messages);
    const item = {
      bucketName: "bucket",
      file: { fileName: "file.txt", contentLength: 4 },
      bucket: {
        async download() {
          return { body: new ReadableStream<Uint8Array>() };
        },
      },
    } as unknown as FileTreeItem;
    const tempFileManager = {
      getCachedPath: () => undefined,
      async saveStream() {
        throw new vscode.CancellationError();
      },
    } as unknown as TempFileManager;
    const client = new B2Client({ applicationKeyId: "key-id", applicationKey: "app-key" });

    try {
      await openFileCommand(item, {
        tempFileManager,
        getClient: () => client,
      });

      assert.deepStrictEqual(messages, []);
    } finally {
      restoreErrors();
      restoreProgress();
    }
  });
});
