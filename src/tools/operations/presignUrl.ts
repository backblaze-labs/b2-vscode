/**
 * Pre-sign URL operation.
 *
 * @module tools/operations/presignUrl
 */

import type { B2ToolOperation, ToolExtras } from "../types";

interface PresignUrlParams {
  bucket: string;
  path: string;
  expiresIn?: number;
}

interface PresignUrlResult {
  url: string;
  expiresIn: number;
  message: string;
}

export const presignUrlOperation: B2ToolOperation<PresignUrlParams, PresignUrlResult> = {
  async execute(params: PresignUrlParams, extras: ToolExtras): Promise<PresignUrlResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new Error(`Bucket "${params.bucket}" not found.`);
    }

    const expiresIn = params.expiresIn ?? 3600;
    const { authorizationToken } = await bucket.getDownloadAuthorization(params.path, expiresIn);
    const downloadUrl = client.accountInfo.getDownloadUrl();
    const url = `${downloadUrl}/file/${params.bucket}/${params.path}?Authorization=${authorizationToken}`;

    return {
      url,
      expiresIn,
      message: `Pre-signed URL for ${params.path} (valid for ${expiresIn}s): ${url}`,
    };
  },
};
