/**
 * Pre-sign URL operation.
 *
 * @module tools/operations/presignUrl
 */

import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError } from "../../errors";
import { buildB2DownloadUrl } from "../../utils/urlEncoding";
import {
  DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS,
  MAX_PRESIGN_URL_EXPIRES_IN_SECONDS,
  MIN_PRESIGN_URL_PREFIX_LENGTH,
} from "../presignUrlLimits";

interface PresignUrlParams {
  bucket: string;
  path: string;
  expiresIn?: number;
}

interface PresignUrlResult {
  url: string;
  expiresIn: number;
  authorizedPrefix: string;
  message: string;
}

export function normalizePresignUrlExpiration(expiresIn: number | undefined): number {
  if (expiresIn === undefined) {
    return DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS;
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
  if (!filePath) {
    throw new Error("path must be a non-empty B2 object-name prefix.");
  }

  if (filePath.includes("\0")) {
    throw new Error("path must not contain NUL bytes.");
  }

  if (filePath.endsWith("/")) {
    throw new Error("path must not end with a slash because folder prefixes are rejected.");
  }

  if (filePath.length < MIN_PRESIGN_URL_PREFIX_LENGTH) {
    throw new Error(
      `path must be at least ${MIN_PRESIGN_URL_PREFIX_LENGTH} characters to avoid broad prefix authorization.`,
    );
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
      authorizedPrefix: filePath,
      message: `Pre-signed URL authorizes B2 object names starting with ${filePath} for ${expiresIn}s.`,
    };
  },
};
