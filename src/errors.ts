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
  B2SsrfError,
  BadAuthTokenError,
  CapExceededError,
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
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "X-Amz-Signature",
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
    /\b((?:authorization|applicationKey|application_key|appKey|authorizationToken|token|secret|password)\s*[:=]\s*)(?:Bearer\s+)?\S+/gi,
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
];

const SAFE_LOCAL_ERROR_CODES = new Set([
  "EACCES",
  "EEXIST",
  "EISDIR",
  "ERR_B2_TOOL_INPUT",
  "ERR_PATH_CONTAINMENT",
  "EMFILE",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

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

export class B2ToolInputError extends Error {
  readonly code = "ERR_B2_TOOL_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "B2ToolInputError";
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

function getRawErrorCode(error: unknown): string | undefined {
  return stringProperty(asRecord(error), "code");
}

function isSafeLocalError(error: unknown): boolean {
  const code = getRawErrorCode(error);
  return code === undefined ? false : SAFE_LOCAL_ERROR_CODES.has(code);
}

function isNetworkErrorCode(code: string | undefined): boolean {
  return code !== undefined && (NETWORK_ERROR_CODES.has(code) || code.startsWith("UND_ERR_"));
}

function getB2Code(error: unknown): string | undefined {
  const code = getRawErrorCode(error);
  if (code === undefined) {
    return undefined;
  }

  // Treat B2 codes as authoritative only when they are attached to an SDK
  // B2Error or a response status. Bare no-status `code` values can be produced
  // by local dependencies and remain ambiguous for post-request public mutations.
  return error instanceof B2Error || getB2Status(error) !== undefined ? code : undefined;
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

function isCapExceeded(error: unknown): boolean {
  const code = getB2Code(error);
  return (
    error instanceof CapExceededError ||
    matchesErrorName(error, "CapExceededError") ||
    code === "cap_exceeded" ||
    code === "storage_cap_exceeded" ||
    code === "transaction_cap_exceeded" ||
    code === "download_cap_exceeded"
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

function isB2SsrfFailure(error: unknown): boolean {
  return error instanceof B2SsrfError || matchesErrorName(error, "B2SsrfError");
}

function isNetworkFailure(error: unknown): boolean {
  if (isNetworkErrorCode(getRawErrorCode(error))) {
    return true;
  }

  if (
    error instanceof NetworkError ||
    matchesErrorName(error, "NetworkError") ||
    matchesErrorName(error, "AbortError")
  ) {
    return true;
  }

  if (getB2Status(error) !== undefined || getB2Code(error) !== undefined) {
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
  if (getB2Status(error) !== undefined || getB2Code(error) !== undefined) {
    // B2's `bad_json` code is a definitive classified B2 response, so public
    // mutation ambiguity keeps it out of this transport/malformed-response path.
    return false;
  }

  const message = getErrorMessage(error).toLowerCase();
  return (
    error instanceof SyntaxError ||
    matchesErrorName(error, "SyntaxError") ||
    message.includes("malformed json") ||
    message.includes("malformed response") ||
    message.includes("invalid json") ||
    message.includes("truncated json") ||
    message.includes("truncated response") ||
    message.includes("response truncated") ||
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

export function isBucketRevisionConflict(error: unknown): boolean {
  return getB2Status(error) === 409 || getB2Code(error) === "conflict";
}

/** Error used when the client cannot confirm a mutation's final state in time. */
export class B2MutationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "B2MutationTimeoutError";
  }
}

function isMutationTimeout(error: unknown): boolean {
  return (
    error instanceof B2MutationTimeoutError || matchesErrorName(error, "B2MutationTimeoutError")
  );
}

/**
 * Classifies public bucket mutations after a create/update request has been
 * attempted. Transport/timeout/transient-service checks intentionally run
 * before definitive status handling because those outcomes can be uncertain
 * even when an HTTP status is present, such as 408 or 5xx. After known
 * definitive local and B2 failures are excluded, unclassified errors with no B2
 * status or code default to ambiguous as a public-exposure fail-safe.
 */
export function isPostRequestB2MutationStateAmbiguous(error: unknown): boolean {
  if (
    isMutationTimeout(error) ||
    isNetworkFailure(error) ||
    isTransientServiceFailure(error) ||
    isMalformedResponse(error)
  ) {
    return true;
  }

  if (
    isB2SsrfFailure(error) ||
    isInvalidCredentials(error) ||
    isMissingCapability(error) ||
    isCapExceeded(error) ||
    isSafeLocalError(error)
  ) {
    return false;
  }

  return getB2Status(error) === undefined && getB2Code(error) === undefined;
}

function retryAfterText(error: unknown): string {
  const retryAfter = getRetryAfter(error);
  if (retryAfter === undefined) {
    return "";
  }

  const unit = retryAfter === 1 ? "second" : "seconds";
  return ` Wait at least ${retryAfter} ${unit} before retrying.`;
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

  if (
    error instanceof B2ResourceNotFoundError ||
    matchesErrorName(error, "B2ResourceNotFoundError")
  ) {
    return redactSensitiveText(getErrorMessage(error));
  }

  if (isMutationTimeout(error)) {
    return "The B2 request timed out before the extension could confirm the final state. Refresh the bucket tree and verify the bucket in Backblaze before retrying.";
  }

  if (
    matchesErrorName(error, "DownloadSizeLimitError") ||
    matchesErrorName(error, "TransferStallTimeoutError")
  ) {
    return redactSensitiveText(getErrorMessage(error));
  }

  if (isExpiredAuth(error)) {
    return "B2 authorization expired. Retry the operation; the SDK refreshes auth automatically when possible. If this keeps happening, run B2: Authenticate again.";
  }

  if (isInvalidCredentials(error)) {
    return "B2 rejected the application key ID or application key. Run B2: Authenticate and enter valid credentials.";
  }

  if (isCapExceeded(error)) {
    return "A Backblaze B2 account cap was reached for storage, transactions, or downloads. Check your caps and usage in the Backblaze account dashboard.";
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

  if (getB2Code(error) === "bad_json" || isMalformedResponse(error)) {
    return "B2 returned a response the extension could not parse. Retry the operation and check the Backblaze B2 output log if it persists.";
  }

  if (isTransientServiceFailure(error)) {
    return `B2 is temporarily unavailable or timed out. The SDK retries transient failures with backoff before surfacing this error.${retryAfterText(error)}`;
  }

  if (isNetworkFailure(error)) {
    return "Network connection to B2 failed. Check your internet connection, proxy, VPN, or custom B2 endpoint, then retry.";
  }

  if (isB2SsrfFailure(error)) {
    return "B2 rejected a request URL outside the authorized B2 realm. Check your custom B2 endpoint or retry with the default Backblaze B2 endpoint.";
  }

  const message = redactSensitiveText(getErrorMessage(error));
  const b2ErrorLike = isB2ErrorLike(error);
  if (!b2ErrorLike) {
    if (isSafeExtensionMessage(message)) {
      return message;
    }

    return "Unexpected error. Check the Backblaze B2 output log for details.";
  }

  return message
    ? `Unexpected B2 error: ${message}`
    : "Unexpected B2 error. Check the Backblaze B2 output log for details.";
}

/**
 * User-facing message for LM tools, where safe local path errors are useful
 * feedback the model can use to correct the next tool call.
 */
export function formatB2ToolUserMessage(error: unknown): string {
  if (isSafeLocalError(error)) {
    return redactSensitiveText(getErrorMessage(error));
  }

  return formatB2UserMessage(error);
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
