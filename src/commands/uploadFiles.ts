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
  closeUploadSource,
  openUploadSourceFile,
  sameFileIdentity,
  uploadEmptyObject,
  uploadFileFromDisk,
  type UploadEmptyObjectOptions,
  type UploadFileFromDiskOptions,
  type UploadSourceFile,
} from "../services/fileTransfers";
import { createTransferProgressReporter } from "../services/transferProgress";
import { DEFAULT_TRANSFER_STALL_TIMEOUT_MS, withTimeout } from "../services/transferTimeout";

const B2_AUTO_CONTENT_TYPE = "b2/x-auto";
const OVERWRITE_UPLOAD_LABEL = "Overwrite";

const EMPTY_FOLDER_MARKER = ".bzEmpty";
const EMPTY_FOLDER_MARKER_CONTENT_TYPE = "application/x-bzEmpty";
const MAX_LOCAL_UPLOAD_ENTRIES = 10_000;
const MAX_LOCAL_UPLOAD_DEPTH = 64;
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
  readonly rootRealPath: string;
}

export interface EmptyDirectoryUploadEntry {
  readonly kind: "emptyDirectory";
  readonly localPath: string;
  readonly remotePath: string;
  readonly size: 0;
  readonly rootRealPath: string;
}

export interface LocalUploadCollectionOptions {
  readonly signal?: AbortSignal;
  readonly progress?: vscode.Progress<{ message?: string; increment?: number }>;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

interface LocalUploadCollectionContext {
  readonly entries: LocalUploadEntry[];
  readonly signal?: AbortSignal;
  readonly progress?: vscode.Progress<{ message?: string; increment?: number }>;
  readonly maxEntries: number;
  readonly maxDepth: number;
  discoveredEntries: number;
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

function directoryNameForUpload(localPath: string): string {
  const resolvedPath = path.resolve(localPath);
  if (resolvedPath === path.parse(resolvedPath).root) {
    throw new Error("Cannot upload a filesystem root as a folder.");
  }
  return path.basename(resolvedPath);
}

function throwIfCollectionCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new vscode.CancellationError();
  }
}

function isPathInsideOrEqual(rootRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function localUploadLimitError(description: string): Error {
  return new Error(`Local upload selection is too large: ${description}. Select a smaller batch.`);
}

function assertCollectionCapacity(context: LocalUploadCollectionContext): void {
  if (context.entries.length >= context.maxEntries) {
    throw localUploadLimitError(`exceeds the ${context.maxEntries} item limit`);
  }
}

function addCollectedEntry(context: LocalUploadCollectionContext, entry: LocalUploadEntry): void {
  assertCollectionCapacity(context);
  context.entries.push(entry);
  context.discoveredEntries++;
  context.progress?.report({
    message: `Preparing upload list: ${context.discoveredEntries} item(s) found`,
  });
}

async function realPathInsideRoot(localPath: string, rootRealPath: string): Promise<string> {
  const realPath = await fs.promises.realpath(localPath);
  if (!isPathInsideOrEqual(rootRealPath, realPath)) {
    throw new Error(`Local upload path resolves outside the selected folder: ${localPath}`);
  }
  return realPath;
}

async function verifiedDirectoryStats(
  directoryPath: string,
  rootRealPath: string,
): Promise<fs.Stats> {
  const stats = await fs.promises.lstat(directoryPath);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Local upload path must be a real file or folder, not a symlink: ${directoryPath}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`Local upload path is not a folder: ${directoryPath}`);
  }
  await realPathInsideRoot(directoryPath, rootRealPath);
  return stats;
}

async function verifiedFileStats(localPath: string, rootRealPath: string): Promise<fs.Stats> {
  const stats = await fs.promises.lstat(localPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Local upload path must be a real file or folder, not a symlink: ${localPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Local upload path is not a regular file: ${localPath}`);
  }
  await realPathInsideRoot(localPath, rootRealPath);
  return stats;
}

function createUploadCollectionContext(
  options: LocalUploadCollectionOptions,
): LocalUploadCollectionContext {
  return {
    entries: [],
    signal: options.signal,
    progress: options.progress,
    maxEntries: options.maxEntries ?? MAX_LOCAL_UPLOAD_ENTRIES,
    maxDepth: options.maxDepth ?? MAX_LOCAL_UPLOAD_DEPTH,
    discoveredEntries: 0,
  };
}

async function collectDirectoryUploadEntries(
  directoryPath: string,
  remoteDirectoryPath: string,
  rootRealPath: string,
  context: LocalUploadCollectionContext,
  depth: number,
): Promise<boolean> {
  throwIfCollectionCanceled(context.signal);
  if (depth > context.maxDepth) {
    throw localUploadLimitError(`folder nesting is deeper than ${context.maxDepth} levels`);
  }
  await verifiedDirectoryStats(directoryPath, rootRealPath);

  const children = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  let hasUploadableDescendant = false;
  for (const child of children) {
    throwIfCollectionCanceled(context.signal);
    const childPath = path.join(directoryPath, child.name);
    const childStats = await fs.promises.lstat(childPath);

    if (childStats.isSymbolicLink()) {
      throw new Error(
        `Local upload path must be a real file or folder, not a symlink: ${childPath}`,
      );
    }

    if (childStats.isDirectory()) {
      const childRemoteDirectoryPath = joinB2Path(remoteDirectoryPath, `${child.name}/`);
      const childHasEntries = await collectDirectoryUploadEntries(
        childPath,
        childRemoteDirectoryPath,
        rootRealPath,
        context,
        depth + 1,
      );
      hasUploadableDescendant = childHasEntries || hasUploadableDescendant;
      continue;
    }

    if (!childStats.isFile()) {
      throw new Error(`Local upload path is not a regular file: ${childPath}`);
    }

    await realPathInsideRoot(childPath, rootRealPath);
    addCollectedEntry(context, {
      kind: "file",
      localPath: childPath,
      remotePath: joinB2Path(remoteDirectoryPath, child.name),
      size: childStats.size,
      rootRealPath,
    });
    hasUploadableDescendant = true;
  }

  if (!hasUploadableDescendant) {
    addCollectedEntry(context, {
      kind: "emptyDirectory",
      localPath: directoryPath,
      remotePath: markerPathForDirectory(remoteDirectoryPath),
      size: 0,
      rootRealPath,
    });
    return true;
  }

  return true;
}

export async function collectLocalUploadEntries(
  localPaths: readonly string[],
  prefix: string,
  options: LocalUploadCollectionOptions = {},
): Promise<LocalUploadEntry[]> {
  const context = createUploadCollectionContext(options);

  for (const localPath of localPaths) {
    throwIfCollectionCanceled(context.signal);
    const stats = await fs.promises.lstat(localPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Local upload path must be a real file or folder, not a symlink: ${localPath}`,
      );
    }

    if (stats.isFile()) {
      const rootRealPath = await fs.promises.realpath(localPath);
      addCollectedEntry(context, {
        kind: "file",
        localPath,
        remotePath: joinB2Path(prefix, path.basename(localPath)),
        size: stats.size,
        rootRealPath,
      });
      continue;
    }

    if (stats.isDirectory()) {
      const rootRealPath = await fs.promises.realpath(localPath);
      await verifiedDirectoryStats(localPath, rootRealPath);
      const directoryName = directoryNameForUpload(localPath);
      await collectDirectoryUploadEntries(
        localPath,
        joinB2Path(prefix, `${directoryName}/`),
        rootRealPath,
        context,
        0,
      );
      continue;
    }

    throw new Error(`Local upload path is not a regular file or folder: ${localPath}`);
  }

  return context.entries;
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
  ].sort((left, right) => left.localeCompare(right));

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
    await verifiedDirectoryStats(entry.localPath, entry.rootRealPath);
    await uploadEmptyObject(bucket, entry.remotePath, {
      ...options,
      contentType: EMPTY_FOLDER_MARKER_CONTENT_TYPE,
    });
    return;
  }

  const realStats = await verifiedFileStats(entry.localPath, entry.rootRealPath);
  let source: UploadSourceFile | undefined;
  try {
    source = await openUploadSourceFile(entry.localPath);
    const realPathAfterOpen = await realPathInsideRoot(entry.localPath, entry.rootRealPath);
    const realStatsAfterOpen = await fs.promises.stat(realPathAfterOpen);
    if (
      !sameFileIdentity(source.stats, realStats) ||
      !sameFileIdentity(source.stats, realStatsAfterOpen)
    ) {
      throw new Error(`Local upload path changed while opening upload source: ${entry.localPath}`);
    }

    await uploadFileFromDisk(bucket, source, entry.remotePath, {
      ...options,
      contentType: B2_AUTO_CONTENT_TYPE,
    });
    source = undefined;
  } finally {
    if (source) {
      await closeUploadSource(source);
    }
  }
}

async function collectLocalUploadEntriesWithProgress(
  target: UploadTargetTreeItem,
  localPaths: readonly string[],
  token?: vscode.CancellationToken,
): Promise<LocalUploadEntry[]> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Preparing upload to ${uploadTargetLabel(target)}...`,
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

      try {
        return await collectLocalUploadEntries(localPaths, uploadTargetPrefix(target), {
          signal: controller.signal,
          progress,
        });
      } finally {
        for (const disposable of disposables) {
          disposable.dispose();
        }
      }
    },
  );
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
  if (!services.getClient()) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return;
  }

  if (uris.length === 0) {
    return;
  }

  let uploadedCount = 0;
  try {
    const entries = await collectLocalUploadEntriesWithProgress(
      target,
      uris.map(uriToLocalPath),
      token,
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
