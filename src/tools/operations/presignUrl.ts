/**
 * Pre-sign URL operation.
 *
 * @module tools/operations/presignUrl
 */

import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError } from "../../errors";
import { buildB2DownloadUrl } from "../../utils/urlEncoding";
import { MAX_PRESIGN_URL_EXPIRES_IN_SECONDS } from "../presignUrlLimits";

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

export function normalizePresignUrlExpiration(expiresIn: number | undefined): number {
  if (expiresIn === undefined) {
    return 3600;
  }

  if (
    !Number.isInteger(expiresIn) ||
    expiresIn < 1 ||
    expiresIn > MAX_PRESIGN_URL_EXPIRES_IN_SECONDS
  ) {
    throw new Error(
      `expiresIn must be an integer between 1 and ${MAX_PRESIGN_URL_EXPIRES_IN_SECONDS} seconds.`,
    );
  }
  return expiresIn;
}

export function normalizePresignUrlPath(filePath: string): string {
  if (!filePath || filePath.includes("\0")) {
    throw new Error("path must name a single file and must not be empty.");
  }

  if (filePath.endsWith("/")) {
    throw new Error("path must name a single file, not a folder prefix.");
  }

  return filePath;
}

export const presignUrlOperation: B2ToolOperation<PresignUrlParams, PresignUrlResult> = {
  async execute(params: PresignUrlParams, extras: ToolExtras): Promise<PresignUrlResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const filePath = normalizePresignUrlPath(params.path);
    const expiresIn = normalizePresignUrlExpiration(params.expiresIn);
    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    const { authorizationToken } = await bucket.getDownloadAuthorization(filePath, expiresIn);
    const downloadUrl = client.accountInfo.getDownloadUrl();
    const url = buildB2DownloadUrl(downloadUrl, params.bucket, filePath, authorizationToken);

    return {
      url,
      expiresIn,
      message: `Pre-signed URL for ${filePath} is valid for ${expiresIn}s.`,
    };
  },
};
