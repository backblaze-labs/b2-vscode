/**
 * List Files operation.
 *
 * @module tools/operations/listFiles
 */

import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError } from "../../errors";

interface ListFilesParams {
  bucket: string;
  prefix?: string;
  recursive?: boolean;
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
}

export const listFilesOperation: B2ToolOperation<ListFilesParams, ListFilesResult> = {
  async execute(params: ListFilesParams, extras: ToolExtras): Promise<ListFilesResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    // Omit the delimiter to recurse; use "/" to list a single level.
    const delimiter = params.recursive ? undefined : "/";
    const files: FileEntry[] = [];
    let startFileName: string | undefined;

    do {
      const page = await bucket.listFileNames({
        ...(params.prefix !== undefined ? { prefix: params.prefix } : {}),
        ...(delimiter !== undefined ? { delimiter } : {}),
        ...(startFileName !== undefined ? { startFileName } : {}),
      });
      for (const f of page.files) {
        files.push({
          name: f.fileName,
          size: f.contentLength,
          type: f.contentType,
          isFolder: f.action === "folder",
        });
      }
      startFileName = page.nextFileName ?? undefined;
    } while (startFileName !== undefined);

    return {
      files,
      count: files.length,
      bucket: params.bucket,
      prefix: params.prefix ?? "",
    };
  },
};
