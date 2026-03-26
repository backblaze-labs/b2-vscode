/**
 * List Files operation.
 *
 * @module tools/operations/listFiles
 */

import type { B2ToolOperation, ToolExtras } from "../types";

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

    // Resolve bucket ID from bucket name
    const buckets = await client.listBuckets();
    const bucket = buckets.find((b) => b.bucketName === params.bucket);
    if (!bucket) {
      throw new Error(`Bucket "${params.bucket}" not found.`);
    }

    const delimiter = params.recursive ? undefined : "/";
    const files = await client.listAllFileNames(bucket.bucketId, params.prefix, delimiter);

    return {
      files: files.map((f) => ({
        name: f.fileName,
        size: f.contentLength,
        type: f.contentType,
        isFolder: f.action === "folder",
      })),
      count: files.length,
      bucket: params.bucket,
      prefix: params.prefix ?? "",
    };
  },
};
