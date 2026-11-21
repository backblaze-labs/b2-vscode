/**
 * Shared B2 share-link creation helpers.
 *
 * @module services/shareLink
 */

import { isMissingCapabilityError } from "../utils/b2Errors";
import { buildB2DownloadUrl } from "../utils/urlEncoding";
import { B2ShareLinkError } from "../errors";

export const SHARE_LINK_AUTHORIZATION_TIMEOUT_MS = 30_000;

export interface ShareLinkFileEntry {
  readonly fileName: string;
  readonly action?: string;
}

export interface ShareLinkBucket {
  listFileNames(options: { prefix: string; pageSize: number }): Promise<{
    files: readonly ShareLinkFileEntry[];
    nextFileName?: string | null;
  }>;
  getDownloadAuthorization(
    fileNamePrefix: string,
    validDurationInSeconds: number,
  ): Promise<{ authorizationToken: string }>;
}

export interface LateShareLinkAuthorizationEvent {
  readonly status: "completed" | "failed";
  readonly filePath: string;
  readonly reason?: unknown;
  readonly error?: unknown;
}

export interface CreatePrefixScopedDownloadUrlOptions {
  readonly bucket: ShareLinkBucket;
  readonly bucketName: string;
  readonly filePath: string;
  readonly downloadUrl: string;
  readonly expiresIn: number;
  readonly signal?: AbortSignal;
  readonly missingListCapabilityMessage?: string;
  readonly onAuthorizationStarted?: () => void;
  readonly onAuthorizationSettled?: () => void;
  readonly onLateAuthorization?: (event: LateShareLinkAuthorizationEvent) => void;
}

export interface PrefixScopedDownloadUrlResult {
  readonly url: string;
  readonly expiresIn: number;
  readonly authorizedPrefix: string;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function isCurrentDownloadableFile(file: ShareLinkFileEntry): boolean {
  return file.action !== "folder" && file.action !== "hide";
}

export async function assertExactCurrentObjectWithoutAdjacentPrefix(
  bucket: ShareLinkBucket,
  filePath: string,
  signal: AbortSignal | undefined,
  options: { readonly missingListCapabilityMessage?: string } = {},
): Promise<void> {
  let page: Awaited<ReturnType<ShareLinkBucket["listFileNames"]>>;
  try {
    throwIfAborted(signal);
    // The current B2 SDK list/auth helpers do not accept AbortSignal. The
    // surrounding timeout still bounds caller latency and this explicit check
    // prevents issuing later calls after a timeout or cancellation. Calls are
    // sequential, so at most one SDK request per invocation can continue in the
    // background after the bounded caller result returns.
    page = await bucket.listFileNames({ prefix: filePath, pageSize: 2 });
    throwIfAborted(signal);
  } catch (error) {
    if (isMissingCapabilityError(error)) {
      throw new B2ShareLinkError(
        options.missingListCapabilityMessage ??
          "Creating a share link requires the listFiles capability to verify the object before issuing B2's prefix-scoped download authorization.",
      );
    }
    throw error;
  }

  const currentMatches = page.files.filter(isCurrentDownloadableFile);
  const exactMatches = currentMatches.filter((file) => file.fileName === filePath);
  if (exactMatches.length !== 1) {
    throw new B2ShareLinkError(
      "path must exactly match one downloadable B2 file before a temporary download link can be created.",
    );
  }

  if (currentMatches.some((file) => file.fileName !== filePath) || page.nextFileName) {
    throw new B2ShareLinkError(
      "path matches additional current objects sharing this prefix; B2 would authorize ALL object names beginning with that value, not just this file.",
    );
  }
}

async function getDownloadAuthorizationWithLateLogging(
  options: Pick<
    CreatePrefixScopedDownloadUrlOptions,
    "bucket" | "filePath" | "expiresIn" | "signal" | "onLateAuthorization"
  >,
): Promise<{ authorizationToken: string }> {
  const authorizationPromise = options.bucket.getDownloadAuthorization(
    options.filePath,
    options.expiresIn,
  );
  void authorizationPromise.then(
    () => {
      if (options.signal?.aborted) {
        options.onLateAuthorization?.({
          status: "completed",
          filePath: options.filePath,
          reason: options.signal.reason,
        });
      }
    },
    (error) => {
      if (options.signal?.aborted) {
        options.onLateAuthorization?.({
          status: "failed",
          filePath: options.filePath,
          error,
        });
      }
    },
  );

  return authorizationPromise;
}

export async function createPrefixScopedDownloadUrl(
  options: CreatePrefixScopedDownloadUrlOptions,
): Promise<PrefixScopedDownloadUrlResult> {
  await assertExactCurrentObjectWithoutAdjacentPrefix(
    options.bucket,
    options.filePath,
    options.signal,
    {
      missingListCapabilityMessage: options.missingListCapabilityMessage,
    },
  );
  throwIfAborted(options.signal);

  options.onAuthorizationStarted?.();
  const { authorizationToken } = await getDownloadAuthorizationWithLateLogging(options).finally(
    () => options.onAuthorizationSettled?.(),
  );
  throwIfAborted(options.signal);

  return {
    url: buildB2DownloadUrl(
      options.downloadUrl,
      options.bucketName,
      options.filePath,
      authorizationToken,
    ),
    expiresIn: options.expiresIn,
    authorizedPrefix: options.filePath,
  };
}
