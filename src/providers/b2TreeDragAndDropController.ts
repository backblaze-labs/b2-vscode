/**
 * Drag-and-drop support for the B2 Buckets tree.
 *
 * @module providers/b2TreeDragAndDropController
 */

import * as vscode from "vscode";
import type { B2TreeItem } from "./b2TreeProvider";
import { isUploadTargetTreeItem, type UploadTargetTreeItem } from "../commands/uploadFiles";

export const FILES_MIME_TYPE = "files";
export const URI_LIST_MIME_TYPE = "text/uri-list";

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

async function addUriList(
  uris: vscode.Uri[],
  seen: Set<string>,
  item: vscode.DataTransferItem | undefined,
): Promise<void> {
  if (!item) {
    return;
  }

  const value = await item.asString();
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    addUniqueUri(uris, seen, vscode.Uri.parse(trimmed));
  }
}

export async function droppedFileUris(dataTransfer: vscode.DataTransfer): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();

  for (const [, item] of dataTransfer) {
    const file = item.asFile();
    if (file?.uri) {
      addUniqueUri(uris, seen, file.uri);
    }
  }

  await addUriList(uris, seen, dataTransfer.get(URI_LIST_MIME_TYPE));
  return uris;
}

export class B2TreeDragAndDropController implements vscode.TreeDragAndDropController<B2TreeItem> {
  readonly dropMimeTypes = [FILES_MIME_TYPE, URI_LIST_MIME_TYPE];
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
      vscode.window.showErrorMessage("B2: Drop files onto a bucket or folder.");
      return;
    }

    const uris = await droppedFileUris(dataTransfer);
    if (uris.length === 0) {
      return;
    }

    await this.uploadDroppedFiles(target, uris, token);
  }
}
