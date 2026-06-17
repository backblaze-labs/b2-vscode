/**
 * User-facing and diagnostic error handling for B2 failures.
 *
 * The SDK owns retries, auth refresh, and typed B2 error classification. The
 * extension owns turning those failures into clear UI text and safe diagnostics.
 *
 * @module errors
 */

import {
  AccessDeniedError,
  B2Error,
  B2InsufficientCapabilityError,
  BadAuthTokenError,
  ExpiredAuthTokenError,
  FileNotPresentError,
  NetworkError,
  TooManyRequestsError,
} from "@backblaze-labs/b2-sdk";

export const SDK_RETRY_BACKOFF_NOTE =
  "The B2 SDK retries retryable B2 errors with backoff and refreshes expired auth tokens when possible; surfaced failures are the post-SDK result.";

const REDACTED = "<redacted>";

type ErrorRecord = Record<string, unknown>;

const SENSITIVE_QUERY_KEYS = [
  "authorization",
  "authorizationToken",
  "token",
  "applicationKey",
  "application_key",
  "appKey",
  "secret",
  "password",
];

function sensitiveKeyReplacements(key: string): Array<readonly [RegExp, string]> {
  return [
    [new RegExp(`([?&]${key}=)[^&\\s)]+`, "gi"), `$1${REDACTED}`],
    [new RegExp(`("${key}"\\s*:\\s*")[^"]+(")`, "gi"), `$1${REDACTED}$2`],
  ];
}

const SENSITIVE_TEXT_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  ...SENSITIVE_QUERY_KEYS.flatMap(sensitiveKeyReplacements),
  [/\b(B2_APPLICATION_KEY(?:_ID)?=)\S+/gi, `$1${REDACTED}`],
  [
    /\b((?:applicationKey|appKey|authorizationToken|token|secret|password)\s*=\s*)\S+/gi,
    `$1${REDACTED}`,
  ],
  [/\b(application key(?: id)?\s*[:=]\s*)\S+/gi, `$1${REDACTED}`],
  [/\b(authorization token\s*[:=]\s*)\S+/gi, `$1${REDACTED}`],
];

const SAFE_EXTENSION_MESSAGE_PREFIXES = [
  "Not authenticated.",
  "No workspace folder open.",
  "B2 authentication canceled because",
  "b2.apiUrl ",
  "B2 CLI credentials could not be read.",
];

/**
 * Error used when a multi-step operation made progress but could not complete.
 */
export class B2PartialFailureError extends Error {
  readonly originalError?: unknown;

  constructor(message: string, originalError?: unknown) {
    super(message);
    this.name = "B2PartialFailureError";
    this.originalError = originalError;
  }
}

/** Error used when extension-side lookup confirms a B2 resource is absent. */
export class B2ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "B2ResourceNotFoundError";
  }
}

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === "object" && value !== null ? (value as ErrorRecord) : undefined;
}

function stringProperty(record: ErrorRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberProperty(record: ErrorRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function booleanProperty(record: ErrorRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayProperty(record: ErrorRecord | undefined, key: string): readonly string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function matchesErrorName(error: unknown, name: string): boolean {
  return error instanceof Error
    ? error.name === name
    : stringProperty(asRecord(error), "name") === name;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error ?? "Unknown error");
}

function isSafeExtensionMessage(message: string): boolean {
  return SAFE_EXTENSION_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function getB2Code(error: unknown): string | undefined {
  return stringProperty(asRecord(error), "code");
}

function getB2Status(error: unknown): number | undefined {
  return numberProperty(asRecord(error), "status");
}

function getRetryAfter(error: unknown): number | undefined {
  return numberProperty(asRecord(error), "retryAfter");
}

function getRequestId(error: unknown): string | undefined {
  return stringProperty(asRecord(error), "requestId");
}

function isB2ErrorLike(error: unknown): boolean {
  const record = asRecord(error);
  return (
    error instanceof B2Error ||
    (typeof record?.status === "number" && typeof record?.code === "string")
  );
}

function isInvalidCredentials(error: unknown): boolean {
  const status = getB2Status(error);
  const code = getB2Code(error);
  return (
    error instanceof BadAuthTokenError ||
    matchesErrorName(error, "BadAuthTokenError") ||
    code === "bad_auth_token" ||
    (status === 401 && code === "unauthorized")
  );
}

function isExpiredAuth(error: unknown): boolean {
  const code = getB2Code(error);
  return (
    error instanceof ExpiredAuthTokenError ||
    matchesErrorName(error, "ExpiredAuthTokenError") ||
    code === "expired_auth_token"
  );
}

function isMissingCapability(error: unknown): boolean {
  const status = getB2Status(error);
  const code = getB2Code(error);
  return (
    error instanceof B2InsufficientCapabilityError ||
    error instanceof AccessDeniedError ||
    matchesErrorName(error, "B2InsufficientCapabilityError") ||
    matchesErrorName(error, "AccessDeniedError") ||
    code === "access_denied" ||
    status === 403
  );
}

function isObjectNotFound(error: unknown): boolean {
  const status = getB2Status(error);
  const code = getB2Code(error);
  return (
    error instanceof FileNotPresentError ||
    matchesErrorName(error, "FileNotPresentError") ||
    error instanceof B2ResourceNotFoundError ||
    matchesErrorName(error, "B2ResourceNotFoundError") ||
    status === 404 ||
    code === "file_not_present" ||
    code === "no_such_file" ||
    code === "not_found" ||
    code === "bad_bucket_id" ||
    code === "invalid_bucket_id"
  );
}

function isRateLimit(error: unknown): boolean {
  const status = getB2Status(error);
  return (
    error instanceof TooManyRequestsError ||
    matchesErrorName(error, "TooManyRequestsError") ||
    status === 429
  );
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof NetworkError || matchesErrorName(error, "NetworkError")) {
    return true;
  }

  if (getB2Status(error) !== undefined) {
    return false;
  }

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("etimedout")
  );
}

function isMalformedResponse(error: unknown): boolean {
  const code = getB2Code(error);
  const message = getErrorMessage(error).toLowerCase();
  return (
    code === "bad_json" ||
    error instanceof SyntaxError ||
    matchesErrorName(error, "SyntaxError") ||
    message.includes("malformed") ||
    message.includes("invalid json") ||
    message.includes("unexpected token") ||
    message.includes("unexpected end of json") ||
    message.includes("could not parse")
  );
}

function isTransientServiceFailure(error: unknown): boolean {
  const status = getB2Status(error);
  const code = getB2Code(error);
  return (
    status === 408 ||
    status === 503 ||
    (status !== undefined && status >= 500) ||
    code === "request_timeout" ||
    code === "service_unavailable" ||
    code === "internal_error"
  );
}

function retryAfterText(error: unknown): string {
  const retryAfter = getRetryAfter(error);
  return retryAfter === undefined ? "" : ` Wait at least ${retryAfter} second(s) before retrying.`;
}

function missingCapabilitiesText(error: unknown): string {
  const missing = stringArrayProperty(asRecord(error), "missing");
  return missing.length === 0 ? "" : ` Missing capabilities: ${missing.join(", ")}.`;
}

function hasB2SdkFailure(error: unknown): boolean {
  if (isB2ErrorLike(error)) {
    return true;
  }

  const originalError = asRecord(error)?.originalError;
  return originalError === undefined ? false : hasB2SdkFailure(originalError);
}

/**
 * Redact tokens, application keys, and secret-looking query parameters before
 * writing diagnostics to the output channel or console.
 */
export function redactSensitiveText(value: string): string {
  let redacted = value;

  for (const [pattern, replacement] of SENSITIVE_TEXT_REPLACEMENTS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted;
}

/**
 * User-facing message for a B2-related failure.
 */
export function formatB2UserMessage(error: unknown): string {
  if (error instanceof B2PartialFailureError || matchesErrorName(error, "B2PartialFailureError")) {
    return redactSensitiveText(getErrorMessage(error));
  }

  if (isExpiredAuth(error)) {
    return "B2 authorization expired. Retry the operation; the SDK refreshes auth automatically when possible. If this keeps happening, run B2: Authenticate again.";
  }

  if (isInvalidCredentials(error)) {
    return "B2 rejected the application key ID or application key. Run B2: Authenticate and enter valid credentials.";
  }

  if (isMissingCapability(error)) {
    return `The B2 application key is missing permission for this bucket or operation. Use a key with the required bucket access and capabilities.${missingCapabilitiesText(error)}`;
  }

  if (isObjectNotFound(error)) {
    return "The requested B2 bucket or object was not found. Check the bucket name, file path, and any bucket restriction on the application key.";
  }

  if (isRateLimit(error)) {
    return `B2 rate limit reached. The SDK retries retryable failures with backoff before surfacing this error.${retryAfterText(error)}`;
  }

  if (isMalformedResponse(error)) {
    return "B2 returned a response the extension could not parse. Retry the operation and check the Backblaze B2 output log if it persists.";
  }

  if (isTransientServiceFailure(error)) {
    return `B2 is temporarily unavailable or timed out. The SDK retries transient failures with backoff before surfacing this error.${retryAfterText(error)}`;
  }

  if (isNetworkFailure(error)) {
    return "Network connection to B2 failed. Check your internet connection, proxy, VPN, or custom B2 endpoint, then retry.";
  }

  const message = redactSensitiveText(getErrorMessage(error));
  if (!isB2ErrorLike(error) && isSafeExtensionMessage(message)) {
    return message;
  }

  if (!isB2ErrorLike(error) && message) {
    return "Unexpected error. Check the Backblaze B2 output log for details.";
  }

  return message
    ? `Unexpected B2 error: ${message}`
    : "Unexpected B2 error. Check the Backblaze B2 output log for details.";
}

/**
 * Sanitized diagnostic text with enough SDK metadata for support/debugging.
 */
export function formatB2DiagnosticMessage(error: unknown): string {
  return formatB2DiagnosticMessageInner(error, true);
}

function formatB2DiagnosticMessageInner(error: unknown, includeSdkNote: boolean): string {
  const record = asRecord(error);
  const parts: string[] = [];

  if (error instanceof Error) {
    parts.push(`name=${error.name}`);
    parts.push(`message=${error.message}`);
  } else if (record) {
    const name = stringProperty(record, "name");
    if (name) {
      parts.push(`name=${name}`);
    }
    const message = stringProperty(record, "message");
    if (message) {
      parts.push(`message=${message}`);
    }
  } else {
    parts.push(getErrorMessage(error));
  }

  if (isB2ErrorLike(error)) {
    const status = getB2Status(error);
    const code = getB2Code(error);
    const retryable = booleanProperty(record, "retryable");
    const retryAfter = getRetryAfter(error);
    const requestId = getRequestId(error);

    if (status !== undefined) {
      parts.push(`status=${status}`);
    }
    if (code) {
      parts.push(`code=${code}`);
    }
    if (retryable !== undefined) {
      parts.push(`retryable=${retryable}`);
    }
    if (retryAfter !== undefined) {
      parts.push(`retryAfter=${retryAfter}`);
    }
    if (requestId) {
      parts.push(`requestId=${requestId}`);
    }
  }

  const required = stringArrayProperty(record, "required");
  const available = stringArrayProperty(record, "available");
  const missing = stringArrayProperty(record, "missing");
  if (required.length > 0) {
    parts.push(`required=${required.join(",")}`);
  }
  if (available.length > 0) {
    parts.push(`available=${available.join(",")}`);
  }
  if (missing.length > 0) {
    parts.push(`missing=${missing.join(",")}`);
  }

  const originalError = record?.originalError;
  if (originalError !== undefined) {
    parts.push(`originalError=(${formatB2DiagnosticMessageInner(originalError, false)})`);
  }

  if (includeSdkNote && hasB2SdkFailure(error)) {
    parts.push(SDK_RETRY_BACKOFF_NOTE);
  }

  return redactSensitiveText(parts.filter(Boolean).join(" "));
}

/**
 * Sanitized stack trace for developer diagnostics.
 */
export function formatB2DiagnosticStack(error: unknown): string | undefined {
  const stack = error instanceof Error ? error.stack : stringProperty(asRecord(error), "stack");
  return stack ? redactSensitiveText(stack) : undefined;
}
