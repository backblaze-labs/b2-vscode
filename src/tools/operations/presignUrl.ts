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
} from "../presignUrlLimits";
import { normalizeB2ObjectNameInput } from "../b2ObjectName";

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

interface PresignableBucket {
  listFileNames(options: { prefix: string; pageSize: number }): Promise<{
    files: readonly { fileName: string; action?: string }[];
    nextFileName?: string | null;
  }>;
  getDownloadAuthorization(
    filePath: string,
    expiresIn: number,
  ): Promise<{ authorizationToken: string }>;
}

function isCurrentDownloadableFile(file: { action?: string }): boolean {
  return file.action !== "folder" && file.action !== "hide";
}

function isMissingListFilesCapabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const details = error as Error & { code?: string };
  return String(details.code ?? "").toLowerCase() === "missing_capability";
}

async function assertExactCurrentObjectWithoutAdjacentPrefix(
  bucket: PresignableBucket,
  filePath: string,
): Promise<void> {
  let page: Awaited<ReturnType<PresignableBucket["listFileNames"]>>;
  try {
    page = await bucket.listFileNames({ prefix: filePath, pageSize: 2 });
  } catch (error) {
    if (isMissingListFilesCapabilityError(error)) {
      throw new Error(
        "presignUrl requires listFiles capability to verify the object before issuing B2's prefix-scoped download authorization.",
      );
    }
    throw error;
  }

  const currentMatches = page.files.filter(isCurrentDownloadableFile);
  const exactMatches = currentMatches.filter((file) => file.fileName === filePath);
  if (exactMatches.length !== 1) {
    throw new Error(
      "path must exactly match one current downloadable B2 object before a presigned URL can be created.",
    );
  }

  if (currentMatches.some((file) => file.fileName !== filePath) || page.nextFileName) {
    throw new Error(
      `path is ambiguous for B2 prefix authorization: a URL for ${filePath} would authorize ALL object names beginning with that value, not just this file.`,
    );
  }
}

export const presignUrlOperation: B2ToolOperation<PresignUrlParams, PresignUrlResult> = {
  async execute(params: PresignUrlParams, extras: ToolExtras): Promise<PresignUrlResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const filePath = normalizeB2ObjectNameInput(params.path);
    const expiresIn = normalizePresignUrlExpiration(params.expiresIn);
    const bucket = await client.getBucket(params.bucket);
    if (!bucket) {
      throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
    }

    await assertExactCurrentObjectWithoutAdjacentPrefix(bucket, filePath);
    const { authorizationToken } = await bucket.getDownloadAuthorization(filePath, expiresIn);
    const downloadUrl = client.accountInfo.getDownloadUrl();
    const url = buildB2DownloadUrl(downloadUrl, params.bucket, filePath, authorizationToken);

    return {
      url,
      expiresIn,
      authorizedPrefix: filePath,
      message: `Pre-signed URL authorizes ALL B2 object names beginning with ${filePath}, not just this file, for ${expiresIn}s. Current bucket contents were checked and no adjacent same-prefix object was found. Use the dedicated url field for the token-bearing link.`,
    };
  },
};
