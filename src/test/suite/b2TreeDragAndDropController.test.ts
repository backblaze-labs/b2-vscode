/**
 * Tests for B2 tree drag-and-drop boundaries.
 *
 * @module test/suite/b2TreeDragAndDropController
 */

import * as assert from "assert";
import * as vscode from "vscode";
import type { Bucket } from "@backblaze-labs/b2-sdk";
import {
  B2TreeDragAndDropController,
  FILES_MIME_TYPE,
} from "../../providers/b2TreeDragAndDropController";
import { BucketTreeItem } from "../../models/bucketTreeItem";
import { FileTreeItem } from "../../models/fileTreeItem";
import { withWindowUiStubs } from "./windowStubs";

function makeBucketTreeItem(): BucketTreeItem {
  return new BucketTreeItem({
    name: "bucket",
    id: "bucket-id",
    info: { bucketType: "allPrivate" },
  } as unknown as Bucket);
}

function dataTransfer(
  entries: Array<readonly [string, vscode.DataTransferItem]>,
): vscode.DataTransfer {
  const items = new Map(entries);
  return {
    get(mimeType: string) {
      return items.get(mimeType);
    },
    *[Symbol.iterator]() {
      yield* items.entries();
    },
  } as unknown as vscode.DataTransfer;
}

function itemWithFile(uri: vscode.Uri): vscode.DataTransferItem {
  return {
    asFile() {
      return {
        name: "upload-source",
        uri,
        async data() {
          return new Uint8Array();
        },
      };
    },
    async asString() {
      return uri.toString();
    },
    value: undefined,
  } as unknown as vscode.DataTransferItem;
}

suite("B2 tree drag and drop", () => {
  test("ignores synthetic text/uri-list file URIs", async () => {
    let uploadCalled = false;
    const tokenSource = new vscode.CancellationTokenSource();
    const controller = new B2TreeDragAndDropController(async () => {
      uploadCalled = true;
    });

    try {
      await controller.handleDrop(
        makeBucketTreeItem(),
        dataTransfer([
          [
            "text/uri-list",
            new vscode.DataTransferItem(vscode.Uri.file("/tmp/secret.txt").toString()),
          ],
        ]),
        tokenSource.token,
      );

      assert.strictEqual(uploadCalled, false);
    } finally {
      tokenSource.dispose();
    }
  });

  test("ignores file transfer items that do not resolve to local files", async () => {
    let uploadCalled = false;
    const tokenSource = new vscode.CancellationTokenSource();
    const controller = new B2TreeDragAndDropController(async () => {
      uploadCalled = true;
    });

    try {
      await controller.handleDrop(
        makeBucketTreeItem(),
        dataTransfer([[FILES_MIME_TYPE, itemWithFile(vscode.Uri.parse("https://example.com/a"))]]),
        tokenSource.token,
      );

      assert.strictEqual(uploadCalled, false);
    } finally {
      tokenSource.dispose();
    }
  });

  test("uploads local file transfer items", async () => {
    const uploadedUris: vscode.Uri[][] = [];
    const tokenSource = new vscode.CancellationTokenSource();
    const controller = new B2TreeDragAndDropController(async (_target, uris) => {
      uploadedUris.push([...uris]);
    });
    const uri = vscode.Uri.file("/tmp/report.txt");

    try {
      await controller.handleDrop(
        makeBucketTreeItem(),
        dataTransfer([[FILES_MIME_TYPE, itemWithFile(uri)]]),
        tokenSource.token,
      );

      assert.deepStrictEqual(uploadedUris, [[uri]]);
    } finally {
      tokenSource.dispose();
    }
  });

  test("describes file and folder drops for invalid targets", async () => {
    let uploadCalled = false;
    const tokenSource = new vscode.CancellationTokenSource();
    const controller = new B2TreeDragAndDropController(async () => {
      uploadCalled = true;
    });
    const fileTarget = new FileTreeItem(makeBucketTreeItem().bucket, {
      fileName: "remote/report.txt",
      fileId: "file-id",
      contentType: "text/plain",
      contentLength: 1,
      uploadTimestamp: 0,
    } as ConstructorParameters<typeof FileTreeItem>[1]);

    try {
      const ui = await withWindowUiStubs({}, () =>
        controller.handleDrop(
          fileTarget,
          dataTransfer([[FILES_MIME_TYPE, itemWithFile(vscode.Uri.file("/tmp/report.txt"))]]),
          tokenSource.token,
        ),
      );

      assert.strictEqual(uploadCalled, false);
      assert.deepStrictEqual(ui.errors, ["B2: Drop files or folders onto a bucket or folder."]);
    } finally {
      tokenSource.dispose();
    }
  });
});
