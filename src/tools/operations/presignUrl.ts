/**
 * Pre-sign URL operation.
 *
 * @module tools/operations/presignUrl
 */

import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError } from "../../errors";

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

const MAX_PRESIGN_URL_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

function normalizedExpiresIn(expiresIn: number | undefined): number {
  const normalized = expiresIn ?? 3600;
  if (
    !Number.isFinite(normalized) ||
    normalized <= 0 ||
    normalized > MAX_PRESIGN_URL_EXPIRES_IN_SECONDS
  ) {
    throw new Error(
      `expiresIn must be between 1 and ${MAX_PRESIGN_URL_EXPIRES_IN_SECONDS} seconds.`,
    );
  }
  return normalized;
}

export const presignUrlOperation: B2ToolOperation<PresignUrlParams, PresignUrlResult> = {
  async execute(params: PresignUrlParams, extras: ToolExtras): Promise<PresignUrlResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const expiresIn = normalizedExpiresIn(params.expiresIn);
    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    const { authorizationToken } = await bucket.getDownloadAuthorization(params.path, expiresIn);
    const downloadUrl = client.accountInfo.getDownloadUrl();
    // Encode each path segment (preserving "/") and the token for safe URL use.
    const encodedPath = params.path.split("/").map(encodeURIComponent).join("/");
    const url = `${downloadUrl}/file/${params.bucket}/${encodedPath}?Authorization=${encodeURIComponent(authorizationToken)}`;

    return {
      url,
      expiresIn,
      message: `Pre-signed URL for ${params.path} (valid for ${expiresIn}s): ${url}`,
    };
  },
};
