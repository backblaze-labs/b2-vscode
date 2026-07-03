/**
 * Shared JSON helpers for virtual B2 bucket-configuration documents.
 *
 * @module providers/b2ConfigJson
 */

export const B2_CONFIG_SCHEME = "b2-config";
export const B2_CONFIG_FILE_EXTENSION = ".json";
export const B2_CONFIG_MASKED_SECRET = "__B2_CONFIG_MASKED_SECRET__";

export const B2_CONFIG_KINDS = ["lifecycle", "cors", "notifications", "bucketInfo"] as const;

export type B2ConfigKind = (typeof B2_CONFIG_KINDS)[number];

export interface B2ConfigLocation {
  readonly bucketName: string;
  readonly kind: B2ConfigKind;
}

type MutableJsonRecord = Record<string, unknown>;

export function isB2ConfigKind(value: string): value is B2ConfigKind {
  return B2_CONFIG_KINDS.includes(value as B2ConfigKind);
}

export function parseB2ConfigPath(path: string): B2ConfigLocation | undefined {
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 2) {
    return undefined;
  }

  const [bucketName, fileName] = segments;
  if (!bucketName || !fileName.endsWith(B2_CONFIG_FILE_EXTENSION)) {
    return undefined;
  }

  const kind = fileName.slice(0, -B2_CONFIG_FILE_EXTENSION.length);
  if (!isB2ConfigKind(kind)) {
    return undefined;
  }

  return { bucketName, kind };
}

export function b2ConfigFileName(kind: B2ConfigKind): string {
  return `${kind}${B2_CONFIG_FILE_EXTENSION}`;
}

export function prettyB2ConfigJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function cloneB2ConfigJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is MutableJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthorizationHeader(headerName: string): boolean {
  return headerName.toLowerCase() === "authorization";
}

function findHeaderKey(headers: MutableJsonRecord, headerName: string): string | undefined {
  return Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === headerName.toLowerCase(),
  );
}

function maskNotificationRules(value: unknown): unknown {
  const cloned = cloneB2ConfigJson(value);
  if (!Array.isArray(cloned)) {
    return cloned;
  }

  for (const rule of cloned) {
    if (!isRecord(rule) || !isRecord(rule.targetConfiguration)) {
      continue;
    }

    for (const secretKey of ["hmacSha256SigningSecret", "hmacSha256"]) {
      if (typeof rule.targetConfiguration[secretKey] === "string") {
        rule.targetConfiguration[secretKey] = B2_CONFIG_MASKED_SECRET;
      }
    }

    const customHeaders = rule.targetConfiguration.customHeaders;
    if (!isRecord(customHeaders)) {
      continue;
    }

    for (const [headerName, headerValue] of Object.entries(customHeaders)) {
      if (isAuthorizationHeader(headerName) && typeof headerValue === "string") {
        customHeaders[headerName] = B2_CONFIG_MASKED_SECRET;
      }
    }
  }

  return cloned;
}

export function maskB2ConfigForRead(kind: B2ConfigKind, value: unknown): unknown {
  return kind === "notifications" ? maskNotificationRules(value) : cloneB2ConfigJson(value);
}

function mergeNotificationSecrets(edited: unknown, original: unknown): unknown {
  const merged = cloneB2ConfigJson(edited);
  if (!Array.isArray(merged) || !Array.isArray(original)) {
    return merged;
  }

  for (const [index, rule] of merged.entries()) {
    const originalRule = original[index];
    if (
      !isRecord(rule) ||
      !isRecord(originalRule) ||
      !isRecord(rule.targetConfiguration) ||
      !isRecord(originalRule.targetConfiguration)
    ) {
      continue;
    }

    for (const secretKey of ["hmacSha256SigningSecret", "hmacSha256"]) {
      if (rule.targetConfiguration[secretKey] !== B2_CONFIG_MASKED_SECRET) {
        continue;
      }
      const originalSecret = originalRule.targetConfiguration[secretKey];
      if (typeof originalSecret === "string") {
        rule.targetConfiguration[secretKey] = originalSecret;
      }
    }

    const editedHeaders = rule.targetConfiguration.customHeaders;
    const originalHeaders = originalRule.targetConfiguration.customHeaders;
    if (!isRecord(editedHeaders) || !isRecord(originalHeaders)) {
      continue;
    }

    for (const [headerName, headerValue] of Object.entries(editedHeaders)) {
      if (!isAuthorizationHeader(headerName) || headerValue !== B2_CONFIG_MASKED_SECRET) {
        continue;
      }
      const originalHeaderName = findHeaderKey(originalHeaders, headerName);
      if (
        originalHeaderName !== undefined &&
        typeof originalHeaders[originalHeaderName] === "string"
      ) {
        editedHeaders[headerName] = originalHeaders[originalHeaderName];
      }
    }
  }

  return merged;
}

export function mergeMaskedB2Config(
  kind: B2ConfigKind,
  edited: unknown,
  original: unknown,
): unknown {
  return kind === "notifications"
    ? mergeNotificationSecrets(edited, original)
    : cloneB2ConfigJson(edited);
}

function validateArrayConfig(kind: B2ConfigKind, value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return undefined;
  }
  return `${b2ConfigFileName(kind)} must contain a JSON array.`;
}

function validateBucketInfo(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "bucketInfo.json must contain a JSON object.";
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return `bucketInfo.${key} must be a string.`;
    }
  }

  return undefined;
}

function validateNotificationHeaders(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const [index, rule] of value.entries()) {
    if (!isRecord(rule)) {
      return `notifications[${index}] must be an object.`;
    }
    const targetConfiguration = rule.targetConfiguration;
    if (targetConfiguration === undefined) {
      continue;
    }
    if (!isRecord(targetConfiguration)) {
      return `notifications[${index}].targetConfiguration must be an object.`;
    }
    const customHeaders = targetConfiguration.customHeaders;
    if (customHeaders === undefined) {
      continue;
    }
    if (!isRecord(customHeaders)) {
      return `notifications[${index}].targetConfiguration.customHeaders must be an object.`;
    }
    for (const [headerName, headerValue] of Object.entries(customHeaders)) {
      if (typeof headerValue !== "string") {
        return `notifications[${index}].targetConfiguration.customHeaders.${headerName} must be a string.`;
      }
    }
  }

  return undefined;
}

export function validateB2ConfigJson(kind: B2ConfigKind, value: unknown): string | undefined {
  switch (kind) {
    case "bucketInfo":
      return validateBucketInfo(value);
    case "cors":
    case "lifecycle":
      return validateArrayConfig(kind, value);
    case "notifications":
      return validateArrayConfig(kind, value) ?? validateNotificationHeaders(value);
  }
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForStableJson);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeForStableJson(value[key])]),
  );
}

export function stableB2ConfigJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}
