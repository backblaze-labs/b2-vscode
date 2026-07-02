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

function fileUriFromValue(value: unknown): vscode.Uri | undefined {
  if (typeof value !== "object" || value === null || !("uri" in value)) {
    return undefined;
  }

  const uri = (value as { readonly uri?: unknown }).uri;
  return uri instanceof vscode.Uri && uri.scheme === "file" ? uri : undefined;
}

function addFileValueUris(uris: vscode.Uri[], seen: Set<string>, value: unknown): void {
  const directUri = fileUriFromValue(value);
  if (directUri) {
    addUniqueUri(uris, seen, directUri);
    return;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value !== "object" ||
    !(Symbol.iterator in value)
  ) {
    return;
  }

  for (const file of value as Iterable<unknown>) {
    const uri = fileUriFromValue(file);
    if (uri) {
      addUniqueUri(uris, seen, uri);
    }
  }
}

export function droppedFileUris(dataTransfer: vscode.DataTransfer): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();

  for (const [mimeType, item] of dataTransfer) {
    const file = item.asFile();
    if (file?.uri?.scheme === "file") {
      addUniqueUri(uris, seen, file.uri);
    }
    if (mimeType === FILES_MIME_TYPE) {
      addFileValueUris(uris, seen, item.value);
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
