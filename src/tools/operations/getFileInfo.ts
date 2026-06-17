/**
 * Get File Info operation.
 *
 * @module tools/operations/getFileInfo
 */

import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError } from "../../errors";

interface GetFileInfoParams {
  bucket: string;
  path: string;
}

interface GetFileInfoResult {
  fileName: string;
  fileId: string;
  size: number;
  contentType: string;
  uploadTimestamp: number;
  uploadDate: string;
}

export const getFileInfoOperation: B2ToolOperation<GetFileInfoParams, GetFileInfoResult> = {
  async execute(params: GetFileInfoParams, extras: ToolExtras): Promise<GetFileInfoResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    const file = await bucket.getFileInfoByName(params.path);
    if (!file) {
      throw new B2ResourceNotFoundError(
        `File "${params.path}" not found in bucket "${params.bucket}".`,
      );
    }

    return {
      fileName: file.fileName,
      fileId: file.fileId,
      size: file.contentLength,
      contentType: file.contentType,
      uploadTimestamp: file.uploadTimestamp,
      uploadDate: new Date(file.uploadTimestamp).toISOString(),
    };
  },
};
