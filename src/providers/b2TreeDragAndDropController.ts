/**
 * Drag-and-drop support for the B2 Buckets tree.
 *
 * @module providers/b2TreeDragAndDropController
 */

import * as vscode from "vscode";
import type { B2TreeItem } from "./b2TreeProvider";
import { isUploadTargetTreeItem, type UploadTargetTreeItem } from "../models/uploadTarget";

export const FILES_MIME_TYPE = "files";

export type DroppedFileUploader = (
  target: UploadTargetTreeItem,
  uris: readonly vscode.Uri[],
  token: vscode.CancellationToken,
) => Thenable<void>;

function addUniqueUri(uris: vscode.Uri[], seen: Set<string>, uri: vscode.Uri): void {
  const key = uri.toString();
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  uris.push(uri);
}

export function droppedFileUris(dataTransfer: vscode.DataTransfer): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();

  for (const [, item] of dataTransfer) {
    const file = item.asFile();
    if (file?.uri?.scheme === "file") {
      addUniqueUri(uris, seen, file.uri);
    }
  }

  return uris;
}

export class B2TreeDragAndDropController implements vscode.TreeDragAndDropController<B2TreeItem> {
  readonly dropMimeTypes = [FILES_MIME_TYPE];
  readonly dragMimeTypes: readonly string[] = [];

  constructor(private readonly uploadDroppedFiles: DroppedFileUploader) {}

  async handleDrop(
    target: B2TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }

    if (!isUploadTargetTreeItem(target)) {
      vscode.window.showErrorMessage("B2: Drop files or folders onto a bucket or folder.");
      return;
    }

    const uris = droppedFileUris(dataTransfer);
    if (uris.length === 0) {
      return;
    }

    await this.uploadDroppedFiles(target, uris, token);
  }
}
