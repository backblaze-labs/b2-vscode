/**
 * Explorer upload command support.
 *
 * @module commands/uploadFiles
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { FileNotPresentError, type B2Client, type Bucket } from "@backblaze-labs/b2-sdk";
import { BucketTreeItem } from "../models/bucketTreeItem";
import {
  type UploadTargetTreeItem,
  uploadTargetLabel,
  uploadTargetPrefix,
} from "../models/uploadTarget";
import type { B2TreeProvider } from "../providers/b2TreeProvider";
import { B2PartialFailureError, formatB2UserMessage } from "../errors";
import { log, logError } from "../logger";
import { humanSize } from "../utils/humanSize";
import {
  uploadEmptyObject,
  uploadFileFromDisk,
  type UploadEmptyObjectOptions,
  type UploadFileFromDiskOptions,
} from "../services/fileTransfers";
import { createTransferProgressReporter } from "../services/transferProgress";
import { DEFAULT_TRANSFER_STALL_TIMEOUT_MS, withTimeout } from "../services/transferTimeout";

export const B2_AUTO_CONTENT_TYPE = "b2/x-auto";
export const OVERWRITE_UPLOAD_LABEL = "Overwrite";

const EMPTY_FOLDER_MARKER = ".bzEmpty";
const EMPTY_FOLDER_MARKER_CONTENT_TYPE = "application/x-bzEmpty";
const OVERWRITE_PREFLIGHT_CONCURRENCY = 8;
const OVERWRITE_PREFLIGHT_TIMEOUT_MS = DEFAULT_TRANSFER_STALL_TIMEOUT_MS;

export interface UploadFilesCommandServices {
  readonly treeProvider: Pick<B2TreeProvider, "refresh">;
  readonly getClient: () => B2Client | null;
  readonly getSelectedUploadTarget?: () => UploadTargetTreeItem | undefined;
}

export type LocalUploadEntry = LocalFileUploadEntry | EmptyDirectoryUploadEntry;

export interface LocalFileUploadEntry {
  readonly kind: "file";
  readonly localPath: string;
  readonly remotePath: string;
  readonly size: number;
}

export interface EmptyDirectoryUploadEntry {
  readonly kind: "emptyDirectory";
  readonly localPath: string;
  readonly remotePath: string;
  readonly size: 0;
}

interface BatchProgressReporter {
  readonly forEntry: (
    entry: LocalUploadEntry,
    index: number,
  ) => UploadFileFromDiskOptions["onProgress"];
  markEntryDone(entry: LocalUploadEntry, index: number): void;
}

interface UploadRunOutcome {
  readonly completed: boolean;
  readonly uploadedCount: number;
}

class UploadCancellationAmbiguousError extends Error {
  constructor(
    readonly remotePath: string,
    readonly uploadedCount: number,
  ) {
    super(
      `Upload canceled while "${remotePath}" was in progress. It may have been uploaded to B2.`,
    );
    this.name = "UploadCancellationAmbiguousError";
  }
}

async function selectedUploadTarget(
  item: UploadTargetTreeItem | undefined,
  services: UploadFilesCommandServices,
): Promise<UploadTargetTreeItem | undefined> {
  const selected = item ?? services.getSelectedUploadTarget?.();
  if (selected) {
    return selected;
  }

  const client = services.getClient();
  if (!client) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return undefined;
  }

  const buckets = await client.listBuckets();
  if (buckets.length === 0) {
    vscode.window.showErrorMessage("B2: No buckets available for upload.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    buckets.map((bucket) => ({
      label: bucket.name,
      description: bucket.info.bucketType,
      target: new BucketTreeItem(bucket),
    })),
    {
      title: "Upload Destination",
      placeHolder: "Select a B2 bucket to upload into",
      ignoreFocusOut: true,
    },
  );

  return picked?.target;
}

function normalizeB2Prefix(prefix: string): string {
  return prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
}

function joinB2Path(prefix: string, relativePath: string): string {
  return `${normalizeB2Prefix(prefix)}${relativePath.replace(/^\/+/u, "")}`;
}

function markerPathForDirectory(remoteDirectoryPath: string): string {
  return `${normalizeB2Prefix(remoteDirectoryPath)}${EMPTY_FOLDER_MARKER}`;
}

async function collectDirectoryUploadEntries(
  directoryPath: string,
  remoteDirectoryPath: string,
  entries: LocalUploadEntry[],
): Promise<boolean> {
  const children = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  let hasUploadableDescendant = false;
  for (const child of children) {
    const childPath = path.join(directoryPath, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(
        `Local upload path must be a real file or folder, not a symlink: ${childPath}`,
      );
    }

    if (child.isDirectory()) {
      const childRemoteDirectoryPath = joinB2Path(remoteDirectoryPath, `${child.name}/`);
      const childHasEntries = await collectDirectoryUploadEntries(
        childPath,
        childRemoteDirectoryPath,
        entries,
      );
      hasUploadableDescendant = childHasEntries || hasUploadableDescendant;
      continue;
    }

    if (!child.isFile()) {
      throw new Error(`Local upload path is not a regular file: ${childPath}`);
    }

    const stats = await fs.promises.stat(childPath);
    entries.push({
      kind: "file",
      localPath: childPath,
      remotePath: joinB2Path(remoteDirectoryPath, child.name),
      size: stats.size,
    });
    hasUploadableDescendant = true;
  }

  if (!hasUploadableDescendant) {
    entries.push({
      kind: "emptyDirectory",
      localPath: directoryPath,
      remotePath: markerPathForDirectory(remoteDirectoryPath),
      size: 0,
    });
    return true;
  }

  return true;
}

export async function collectLocalUploadEntries(
  localPaths: readonly string[],
  prefix: string,
): Promise<LocalUploadEntry[]> {
  const entries: LocalUploadEntry[] = [];

  for (const localPath of localPaths) {
    const stats = await fs.promises.lstat(localPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Local upload path must be a real file or folder, not a symlink: ${localPath}`,
      );
    }

    if (stats.isFile()) {
      entries.push({
        kind: "file",
        localPath,
        remotePath: joinB2Path(prefix, path.basename(localPath)),
        size: stats.size,
      });
      continue;
    }

    if (stats.isDirectory()) {
      const directoryName = path.basename(path.resolve(localPath));
      if (!directoryName) {
        throw new Error("Cannot upload a filesystem root as a folder.");
      }
      await collectDirectoryUploadEntries(
        localPath,
        joinB2Path(prefix, `${directoryName}/`),
        entries,
      );
      continue;
    }

    throw new Error(`Local upload path is not a regular file or folder: ${localPath}`);
  }

  return entries;
}

function uriToLocalPath(uri: vscode.Uri): string {
  if (uri.scheme !== "file") {
    throw new Error(`Only local file uploads are supported. Unsupported URI scheme: ${uri.scheme}`);
  }
  return uri.fsPath;
}

function isRemoteNotFound(error: unknown): boolean {
  const details = error as {
    readonly status?: unknown;
    readonly code?: unknown;
    readonly name?: unknown;
  };
  return (
    error instanceof FileNotPresentError ||
    details.name === "FileNotPresentError" ||
    details.status === 404 ||
    details.code === "file_not_present" ||
    details.code === "no_such_file" ||
    details.code === "not_found"
  );
}

async function remotePathExists(
  bucket: Bucket,
  remotePath: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await withTimeout(
      (requestSignal) => bucket.head(remotePath, { signal: requestSignal }),
      OVERWRITE_PREFLIGHT_TIMEOUT_MS,
      `Overwrite check for b2://${bucket.name}/${remotePath}`,
      { signal },
    );
    return true;
  } catch (error) {
    if (isRemoteNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function duplicateRemotePaths(entries: readonly LocalUploadEntry[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.remotePath)) {
      duplicates.add(entry.remotePath);
    }
    seen.add(entry.remotePath);
  }

  return [...duplicates];
}

async function existingRemotePaths(
  bucket: Bucket,
  remotePaths: readonly string[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  signal: AbortSignal,
): Promise<string[]> {
  const existing: string[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (signal.aborted) {
        throw signal.reason ?? new vscode.CancellationError();
      }

      const index = nextIndex++;
      if (index >= remotePaths.length) {
        return;
      }

      const remotePath = remotePaths[index];
      progress.report({
        message: `Checking for existing B2 files ${index + 1}/${remotePaths.length}: ${remotePath}`,
      });
      if (await remotePathExists(bucket, remotePath, signal)) {
        existing.push(remotePath);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(OVERWRITE_PREFLIGHT_CONCURRENCY, remotePaths.length) }, () =>
      worker(),
    ),
  );
  return existing;
}

function overwriteWarningMessage(paths: readonly string[]): string {
  const preview = paths
    .slice(0, 3)
    .map((remotePath) => `"${remotePath}"`)
    .join(", ");
  const suffix = paths.length > 3 ? ` and ${paths.length - 3} more` : "";

  if (paths.length === 1) {
    return `B2: ${preview} already exists. Uploading will overwrite it.`;
  }

  return `B2: ${paths.length} upload destinations already exist or are duplicated (${preview}${suffix}). Uploading will overwrite them.`;
}

async function confirmPotentialOverwrites(
  bucket: Bucket,
  entries: readonly LocalUploadEntry[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  signal: AbortSignal,
): Promise<boolean> {
  const uniqueRemotePaths = [...new Set(entries.map((entry) => entry.remotePath))];
  const overwritePaths = [
    ...new Set([
      ...(await existingRemotePaths(bucket, uniqueRemotePaths, progress, signal)),
      ...duplicateRemotePaths(entries),
    ]),
  ];

  if (overwritePaths.length === 0) {
    return true;
  }

  const answer = await vscode.window.showWarningMessage(
    overwriteWarningMessage(overwritePaths),
    { modal: true },
    OVERWRITE_UPLOAD_LABEL,
  );
  return answer === OVERWRITE_UPLOAD_LABEL;
}

function createBatchProgressReporter(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  entries: readonly LocalUploadEntry[],
): BatchProgressReporter {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let completedBytes = 0;
  let previousPercent = 0;

  const report = (bytesTransferred: number, entry: LocalUploadEntry, index: number): void => {
    const messagePrefix = `Uploading ${index + 1}/${entries.length}: ${entry.remotePath}`;
    if (totalBytes <= 0) {
      progress.report({ message: messagePrefix });
      return;
    }

    const aggregateBytes = Math.min(totalBytes, completedBytes + bytesTransferred);
    const percent = Math.min(100, (aggregateBytes / totalBytes) * 100);
    const increment = percent - previousPercent;
    previousPercent = percent;
    progress.report({
      message: `${messagePrefix} (${humanSize(aggregateBytes)} of ${humanSize(totalBytes)})`,
      ...(increment > 0 ? { increment } : {}),
    });
  };

  return {
    forEntry(entry, index) {
      if (entry.kind === "emptyDirectory") {
        return createTransferProgressReporter(progress, 0);
      }
      return (event) => report(event.bytesTransferred, entry, index);
    },
    markEntryDone(entry, index) {
      report(entry.size, entry, index);
      completedBytes = Math.min(totalBytes, completedBytes + entry.size);
    },
  };
}

async function uploadEntry(
  bucket: Bucket,
  entry: LocalUploadEntry,
  options: UploadFileFromDiskOptions | UploadEmptyObjectOptions,
): Promise<void> {
  if (entry.kind === "emptyDirectory") {
    await uploadEmptyObject(bucket, entry.remotePath, {
      ...options,
      contentType: EMPTY_FOLDER_MARKER_CONTENT_TYPE,
    });
    return;
  }

  await uploadFileFromDisk(bucket, entry.localPath, entry.remotePath, {
    ...options,
    contentType: B2_AUTO_CONTENT_TYPE,
  });
}

async function uploadEntriesWithProgress(
  target: UploadTargetTreeItem,
  entries: readonly LocalUploadEntry[],
  onEntryUploaded: () => void,
  token?: vscode.CancellationToken,
): Promise<UploadRunOutcome> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Uploading ${entries.length} item(s) to ${uploadTargetLabel(target)}...`,
      cancellable: true,
    },
    async (progress, progressToken) => {
      const controller = new AbortController();
      const disposables: vscode.Disposable[] = [];
      const cancel = () => {
        if (!controller.signal.aborted) {
          controller.abort(new vscode.CancellationError());
        }
      };

      if (token?.isCancellationRequested || progressToken.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      if (token) {
        disposables.push(token.onCancellationRequested(cancel));
      }
      disposables.push(progressToken.onCancellationRequested(cancel));

      let uploadedCount = 0;
      let currentEntry: LocalUploadEntry | undefined;
      const reporter = createBatchProgressReporter(progress, entries);
      try {
        if (
          !(await confirmPotentialOverwrites(target.bucket, entries, progress, controller.signal))
        ) {
          return { completed: false, uploadedCount };
        }

        for (const [index, entry] of entries.entries()) {
          if (controller.signal.aborted) {
            throw new vscode.CancellationError();
          }

          currentEntry = entry;
          await uploadEntry(target.bucket, entry, {
            signal: controller.signal,
            onProgress: reporter.forEntry(entry, index),
          });
          currentEntry = undefined;
          reporter.markEntryDone(entry, index);
          uploadedCount++;
          onEntryUploaded();
        }
        return { completed: true, uploadedCount };
      } catch (error) {
        if (
          controller.signal.aborted ||
          token?.isCancellationRequested ||
          progressToken.isCancellationRequested
        ) {
          if (currentEntry) {
            throw new UploadCancellationAmbiguousError(currentEntry.remotePath, uploadedCount);
          }
          throw new vscode.CancellationError();
        }
        if (uploadedCount > 0) {
          throw new B2PartialFailureError(
            `Uploaded ${uploadedCount} of ${entries.length} item(s), then upload failed. ${formatB2UserMessage(error)}`,
            error,
          );
        }
        throw error;
      } finally {
        for (const disposable of disposables) {
          disposable.dispose();
        }
      }
    },
  );
}

function showUploadError(prefix: string, error: unknown): void {
  logError(prefix, error);
  vscode.window.showErrorMessage(`${prefix}. ${formatB2UserMessage(error)}`);
}

export async function uploadLocalUrisToTarget(
  target: UploadTargetTreeItem,
  uris: readonly vscode.Uri[],
  services: UploadFilesCommandServices,
  token?: vscode.CancellationToken,
): Promise<void> {
  const client = services.getClient();
  if (!client) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return;
  }

  if (uris.length === 0) {
    return;
  }

  let uploadedCount = 0;
  try {
    const entries = await collectLocalUploadEntries(
      uris.map(uriToLocalPath),
      uploadTargetPrefix(target),
    );
    if (entries.length === 0) {
      vscode.window.showInformationMessage("B2: No files found to upload.");
      return;
    }

    const outcome = await uploadEntriesWithProgress(target, entries, () => uploadedCount++, token);
    uploadedCount = outcome.uploadedCount;
    if (!outcome.completed) {
      return;
    }

    services.treeProvider.refresh();
    vscode.window.showInformationMessage(
      `B2: Uploaded ${uploadedCount} item(s) to ${uploadTargetLabel(target)}.`,
    );
  } catch (error) {
    if (error instanceof UploadCancellationAmbiguousError) {
      services.treeProvider.refresh();
      log(
        `Upload canceled while ${error.remotePath} was in flight; the object may have been committed in B2.`,
      );
      await vscode.window.showWarningMessage(
        `B2: Upload canceled while "${error.remotePath}" was in progress. It may have been uploaded, so the tree was refreshed. Verify before retrying to avoid duplicate versions.`,
      );
      return;
    }
    if (error instanceof vscode.CancellationError) {
      if (uploadedCount > 0) {
        services.treeProvider.refresh();
      }
      return;
    }
    if (uploadedCount > 0) {
      services.treeProvider.refresh();
    }
    showUploadError("B2: Failed to upload files", error);
  }
}

export async function uploadFilesCommand(
  item: UploadTargetTreeItem | undefined,
  services: UploadFilesCommandServices,
): Promise<void> {
  let target: UploadTargetTreeItem | undefined;
  try {
    target = await selectedUploadTarget(item, services);
  } catch (error) {
    showUploadError("B2: Failed to choose upload destination", error);
    return;
  }

  if (!target) {
    return;
  }

  const uris = await vscode.window.showOpenDialog({
    title: `Upload Files or Folders to ${uploadTargetLabel(target)}`,
    openLabel: "Upload",
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
  });

  if (!uris || uris.length === 0) {
    return;
  }

  await uploadLocalUrisToTarget(target, uris, services);
}
