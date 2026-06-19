/**
 * Pre-sign URL operation.
 *
 * @module tools/operations/presignUrl
 */

import type { CancellationToken } from "vscode";
import type { B2ToolOperation, ToolExtras } from "../types";
import { B2ResourceNotFoundError, B2ToolInputError } from "../../errors";
import { withTimeout } from "../../services/transferTimeout";
import { isMissingCapabilityError } from "../../utils/b2Errors";
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

type PresignUrlLateAuthorizationLogger = (message: string, error?: unknown) => void;

const PRESIGN_URL_OPERATION_TIMEOUT_MS = 30_000;

let presignUrlLateAuthorizationLogger: PresignUrlLateAuthorizationLogger = (message, error) => {
  const detail =
    error instanceof Error
      ? ` - ${error.name}: ${error.message}`
      : error === undefined
        ? ""
        : ` - ${String(error)}`;
  console.error(`[B2] ${message}${detail}`);
};

export function setPresignUrlLateAuthorizationLoggerForTest(
  logger: PresignUrlLateAuthorizationLogger,
): () => void {
  const previousLogger = presignUrlLateAuthorizationLogger;
  presignUrlLateAuthorizationLogger = logger;
  return () => {
    presignUrlLateAuthorizationLogger = previousLogger;
  };
}

function createCancellationError(): Error {
  try {
    const vscode = require("vscode") as typeof import("vscode");
    return new vscode.CancellationError();
  } catch {
    return new DOMException("Aborted", "AbortError");
  }
}

function logPresignUrlLateAuthorization(message: string, error?: unknown): void {
  presignUrlLateAuthorizationLogger(message, error);
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
    throw new B2ToolInputError(
      `expiresIn must be an integer between 1 and ${MAX_PRESIGN_URL_EXPIRES_IN_SECONDS} seconds.`,
    );
  }
  return expiresIn;
}

export function buildPresignedDownloadUrl(
  downloadUrl: string,
  bucketName: string,
  filePath: string,
  authorizationToken: string,
): string {
  return buildB2DownloadUrl(downloadUrl, bucketName, filePath, authorizationToken);
}

function signalFromCancellationToken(token: CancellationToken | undefined): {
  readonly signal: AbortSignal | undefined;
  dispose(): void;
} {
  if (!token) {
    return { signal: undefined, dispose: () => undefined };
  }

  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(createCancellationError());
    }
  };
  if (token.isCancellationRequested) {
    abort();
  }
  const subscription = token.onCancellationRequested(abort);
  return {
    signal: controller.signal,
    dispose: () => subscription.dispose(),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
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

async function assertExactCurrentObjectWithoutAdjacentPrefix(
  bucket: PresignableBucket,
  filePath: string,
  signal: AbortSignal,
): Promise<void> {
  let page: Awaited<ReturnType<PresignableBucket["listFileNames"]>>;
  try {
    throwIfAborted(signal);
    // The current B2 SDK list/auth helpers do not accept AbortSignal. The
    // surrounding withTimeout still bounds tool latency and this explicit check
    // prevents issuing later calls after a timeout or LM cancellation. Calls
    // are sequential, so at most one SDK request per presign invocation can
    // continue in the background after the bounded tool result returns.
    page = await bucket.listFileNames({ prefix: filePath, pageSize: 2 });
    throwIfAborted(signal);
  } catch (error) {
    if (isMissingCapabilityError(error)) {
      throw new Error(
        "presignUrl requires the listFiles capability to verify the object before issuing B2's prefix-scoped download authorization.",
      );
    }
    throw error;
  }

  const currentMatches = page.files.filter(isCurrentDownloadableFile);
  const exactMatches = currentMatches.filter((file) => file.fileName === filePath);
  if (exactMatches.length !== 1) {
    throw new Error(
      "path must exactly match one downloadable B2 file before a presigned URL can be created.",
    );
  }

  if (currentMatches.some((file) => file.fileName !== filePath) || page.nextFileName) {
    throw new Error(
      "path matches additional current objects sharing this prefix; B2 would authorize ALL object names beginning with that value, not just this file.",
    );
  }
}

async function getDownloadAuthorizationWithAbortLogging(
  bucket: PresignableBucket,
  filePath: string,
  expiresIn: number,
  signal: AbortSignal,
): Promise<{ authorizationToken: string }> {
  const authorizationPromise = bucket.getDownloadAuthorization(filePath, expiresIn);
  void authorizationPromise.then(
    () => {
      if (signal.aborted) {
        logPresignUrlLateAuthorization(
          `presignUrl download authorization completed after timeout or cancellation for prefix ${filePath}; the discarded B2 token may remain valid until expiry.`,
          signal.reason,
        );
      }
    },
    (error) => {
      if (signal.aborted) {
        logPresignUrlLateAuthorization(
          `presignUrl download authorization failed after timeout or cancellation for prefix ${filePath}`,
          error,
        );
      }
    },
  );

  return authorizationPromise;
}

export const presignUrlOperation: B2ToolOperation<PresignUrlParams, PresignUrlResult> = {
  async execute(
    params: PresignUrlParams,
    extras: ToolExtras,
    token?: CancellationToken,
  ): Promise<PresignUrlResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const filePath = normalizeB2ObjectNameInput(params.path);
    const expiresIn = normalizePresignUrlExpiration(params.expiresIn);
    let authorizationInFlight = false;
    let authorizationCancellationLogged = false;
    const logAuthorizationCancellation = () => {
      if (authorizationInFlight && !authorizationCancellationLogged) {
        authorizationCancellationLogged = true;
        logPresignUrlLateAuthorization(
          `presignUrl download authorization may complete after timeout or cancellation for prefix ${filePath}; an in-flight B2 token request cannot be cancelled by the SDK.`,
          createCancellationError(),
        );
      }
    };
    const authorizationCancellationSubscription = token?.onCancellationRequested(
      logAuthorizationCancellation,
    );
    const cancellation = signalFromCancellationToken(token);
    try {
      return await withTimeout(
        async (signal) => {
          throwIfAborted(signal);
          const bucket = await client.getBucket(params.bucket);
          throwIfAborted(signal);
          if (!bucket) {
            throw new B2ResourceNotFoundError(`Bucket "${params.bucket}" not found.`);
          }

          await assertExactCurrentObjectWithoutAdjacentPrefix(bucket, filePath, signal);
          throwIfAborted(signal);
          authorizationInFlight = true;
          const { authorizationToken } = await getDownloadAuthorizationWithAbortLogging(
            bucket,
            filePath,
            expiresIn,
            signal,
          ).finally(() => {
            authorizationInFlight = false;
          });
          throwIfAborted(signal);
          const downloadUrl = client.accountInfo.getDownloadUrl();
          const url = buildB2DownloadUrl(downloadUrl, params.bucket, filePath, authorizationToken);

          return {
            url,
            expiresIn,
            authorizedPrefix: filePath,
            message:
              `Pre-signed URL created for B2 file-name prefix ${filePath}; it authorizes ALL B2 object names beginning with ${filePath}, not just this file, for ${expiresIn}s. ` +
              "Current bucket contents were checked and no adjacent same-prefix object was found. " +
              "Objects created later with the same prefix may also be authorized until it expires. " +
              "Use the dedicated url field for the token-bearing link.",
          };
        },
        PRESIGN_URL_OPERATION_TIMEOUT_MS,
        `presignUrl for b2://${params.bucket}/${filePath}`,
        { signal: cancellation.signal },
      );
    } finally {
      authorizationCancellationSubscription?.dispose();
      cancellation.dispose();
    }
  },
};
