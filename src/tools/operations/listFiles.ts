/**
 * List Files operation.
 *
 * @module tools/operations/listFiles
 */

import * as vscode from "vscode";
import type { B2ToolOperation, ToolExtras } from "../types";
import {
  LIST_FILES_DEFAULT_LIMIT,
  LIST_FILES_LIMIT_CAP,
  LIST_FILES_RECURSIVE_DEFAULT_LIMIT,
  LIST_FILES_RECURSIVE_LIMIT_CAP,
  MAX_FILE_COUNT,
} from "../../constants";
import { B2ResourceNotFoundError } from "../../errors";

interface ListFilesParams {
  bucket: string;
  prefix?: string;
  recursive?: boolean;
  limit?: number;
  continuationToken?: string;
}

interface FileEntry {
  name: string;
  size: number;
  type: string;
  isFolder: boolean;
}

interface ListFilesResult {
  files: FileEntry[];
  count: number;
  bucket: string;
  prefix: string;
  recursive: boolean;
  limit: number;
  requestedLimit: number | null;
  limitWasCapped: boolean;
  continuationToken: string | null;
  nextContinuationToken: string | null;
  truncated: boolean;
  pageCount: number;
}

function throwIfCancellationRequested(token: vscode.CancellationToken | undefined): void {
  if (token?.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

function normalizeLimit(limit: number | undefined, recursive: boolean): number {
  const defaultLimit = recursive ? LIST_FILES_RECURSIVE_DEFAULT_LIMIT : LIST_FILES_DEFAULT_LIMIT;
  const cap = recursive ? LIST_FILES_RECURSIVE_LIMIT_CAP : LIST_FILES_LIMIT_CAP;

  if (limit === undefined) {
    return defaultLimit;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer.");
  }

  return Math.min(limit, cap);
}

export const listFilesOperation: B2ToolOperation<ListFilesParams, ListFilesResult> = {
  async execute(
    params: ListFilesParams,
    extras: ToolExtras,
    token?: vscode.CancellationToken,
  ): Promise<ListFilesResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    // Omit the delimiter to recurse; use "/" to list a single level.
    const recursive = params.recursive === true;
    const delimiter = recursive ? undefined : "/";
    const limit = normalizeLimit(params.limit, recursive);
    const files: FileEntry[] = [];
    let startFileName = params.continuationToken || undefined;
    let nextContinuationToken: string | undefined = startFileName;
    let pageCount = 0;

    while (files.length < limit) {
      throwIfCancellationRequested(token);
      const remaining = limit - files.length;
      const pageSize = Math.min(MAX_FILE_COUNT, remaining);
      const page = await bucket.listFileNames({
        ...(params.prefix !== undefined ? { prefix: params.prefix } : {}),
        ...(delimiter !== undefined ? { delimiter } : {}),
        ...(startFileName !== undefined ? { startFileName } : {}),
        pageSize,
      });
      pageCount++;

      // pageSize should already bound page.files; keep slice as a defensive cap.
      const visibleFiles = page.files.slice(0, pageSize);
      for (const f of visibleFiles) {
        throwIfCancellationRequested(token);
        files.push({
          name: f.fileName,
          size: f.contentLength,
          type: f.contentType,
          isFolder: f.action === "folder",
        });
      }

      // If an oversized page is sliced, continue from the first hidden item.
      nextContinuationToken =
        page.files.length > visibleFiles.length
          ? page.files[visibleFiles.length]?.fileName
          : (page.nextFileName ?? undefined);
      if (nextContinuationToken === undefined) {
        break;
      }
      if (nextContinuationToken === startFileName) {
        throw new Error("B2 returned an unchanged continuation token; listing stopped.");
      }

      startFileName = nextContinuationToken;
    }

    return {
      files,
      count: files.length,
      bucket: params.bucket,
      prefix: params.prefix ?? "",
      recursive,
      limit,
      requestedLimit: params.limit ?? null,
      limitWasCapped: params.limit !== undefined && params.limit !== limit,
      continuationToken: params.continuationToken ?? null,
      nextContinuationToken: nextContinuationToken ?? null,
      truncated: nextContinuationToken !== undefined,
      pageCount,
    };
  },
};
