/**
 * Delete File operation.
 *
 * @module tools/operations/deleteFile
 */

import type { B2ToolOperation, ToolExtras } from "../types";

interface DeleteFileParams {
  bucket: string;
  path: string;
}

interface DeleteFileResult {
  message: string;
}

export const deleteFileOperation: B2ToolOperation<DeleteFileParams, DeleteFileResult> = {
  async execute(params: DeleteFileParams, extras: ToolExtras): Promise<DeleteFileResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    // Resolve bucket ID
    const buckets = await client.listBuckets();
    const bucket = buckets.find((b) => b.bucketName === params.bucket);
    if (!bucket) {
      throw new Error(`Bucket "${params.bucket}" not found.`);
    }

    // Get file info to get fileId
    const file = await client.getFileInfo(bucket.bucketId, params.path);
    if (!file) {
      throw new Error(`File "${params.path}" not found in bucket "${params.bucket}".`);
    }

    await client.deleteFileVersion(file.fileId, file.fileName);

    return {
      message: `Deleted ${params.path} from bucket ${params.bucket} (file ID: ${file.fileId})`,
    };
  },
};
