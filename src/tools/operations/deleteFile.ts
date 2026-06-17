/**
 * Delete File operation.
 *
 * @module tools/operations/deleteFile
 */

import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError } from "../../errors";

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

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    // Look up the file to get its version ID
    const file = await bucket.getFileInfoByName(params.path);
    if (!file) {
      throw new B2ResourceNotFoundError(
        `File "${params.path}" not found in bucket "${params.bucket}".`,
      );
    }

    await bucket.deleteFileVersion(file.fileName, file.fileId);

    return {
      message: `Deleted ${params.path} from bucket ${params.bucket} (file ID: ${file.fileId})`,
    };
  },
};
