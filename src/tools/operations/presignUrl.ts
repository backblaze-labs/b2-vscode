/**
 * Pre-sign URL operation.
 *
 * @module tools/operations/presignUrl
 */

import type { CancellationToken } from "vscode";
import type { B2ToolOperation, ToolExtras } from "../types";
import {
  B2ResourceNotFoundError,
  B2ToolInputError,
  formatB2DiagnosticMessage,
  redactSensitiveText,
} from "../../errors";
import {
  createPrefixScopedDownloadUrl,
  SHARE_LINK_AUTHORIZATION_TIMEOUT_MS,
  throwIfAborted,
  type LateShareLinkAuthorizationEvent,
} from "../../services/shareLink";
import { withTimeout } from "../../services/transferTimeout";
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

let presignUrlLateAuthorizationLogger: PresignUrlLateAuthorizationLogger = (message, error) => {
  const safeMessage = redactSensitiveText(message);
  const detail = error === undefined ? "" : ` - ${formatB2DiagnosticMessage(error)}`;
  console.error(`[B2] ${safeMessage}${detail}`);
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

function redactedLateAuthorizationError(error: unknown): unknown {
  if (error instanceof Error) {
    const redactedError = new Error(redactSensitiveText(error.message));
    redactedError.name = error.name;
    return redactedError;
  }
  return error === undefined ? undefined : redactSensitiveText(String(error));
}

function logPresignUrlLateAuthorization(message: string, error?: unknown): void {
  presignUrlLateAuthorizationLogger(
    redactSensitiveText(message),
    redactedLateAuthorizationError(error),
  );
}

function logPresignUrlLateAuthorizationEvent(event: LateShareLinkAuthorizationEvent): void {
  if (event.status === "completed") {
    logPresignUrlLateAuthorization(
      `presignUrl download authorization completed after timeout or cancellation for prefix ${event.filePath}; the discarded B2 token may remain valid until expiry.`,
      event.reason,
    );
    return;
  }

  logPresignUrlLateAuthorization(
    `presignUrl download authorization failed after timeout or cancellation for prefix ${event.filePath}`,
    event.error,
  );
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

function hasUrlDotSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === "." || segment === "..");
}

function rejectUrlDotSegments(parameterName: string, value: string): void {
  if (hasUrlDotSegment(value)) {
    throw new B2ToolInputError(`${parameterName} must not contain "." or ".." URL path segments.`);
  }
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
    rejectUrlDotSegments("bucket", params.bucket);
    rejectUrlDotSegments("path", filePath);

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

          const presigned = await createPrefixScopedDownloadUrl({
            bucket,
            bucketName: params.bucket,
            filePath,
            downloadUrl: client.accountInfo.getDownloadUrl(),
            expiresIn,
            signal,
            missingListCapabilityMessage:
              "presignUrl requires the listFiles capability to verify the object before issuing B2's prefix-scoped download authorization.",
            onAuthorizationStarted: () => {
              authorizationInFlight = true;
            },
            onAuthorizationSettled: () => {
              authorizationInFlight = false;
            },
            onLateAuthorization: logPresignUrlLateAuthorizationEvent,
          });
          throwIfAborted(signal);

          return {
            url: presigned.url,
            expiresIn: presigned.expiresIn,
            authorizedPrefix: presigned.authorizedPrefix,
            message:
              `Pre-signed URL created for B2 file-name prefix ${filePath}; it authorizes ALL B2 object names beginning with ${filePath}, not just this file, for ${expiresIn}s. ` +
              "Current bucket contents were checked and no adjacent same-prefix object was found. " +
              "Objects created later with the same prefix may also be authorized until it expires. " +
              "Use the dedicated url field for the token-bearing link.",
          };
        },
        SHARE_LINK_AUTHORIZATION_TIMEOUT_MS,
        `presignUrl for b2://${params.bucket}/${filePath}`,
        { signal: cancellation.signal },
      );
    } finally {
      authorizationCancellationSubscription?.dispose();
      cancellation.dispose();
    }
  },
};
