/**
 * Shared JSON helpers for virtual B2 bucket-configuration documents.
 *
 * @module providers/b2ConfigJson
 */

import { createHash } from "node:crypto";

export const B2_CONFIG_SCHEME = "b2-config";
export const B2_CONFIG_FILE_EXTENSION = ".json";
export const B2_CONFIG_MASKED_SECRET = "__B2_CONFIG_MASKED_SECRET__";

export const B2_CONFIG_KIND_DESCRIPTORS = {
  lifecycle: {
    fileName: "lifecycle.json",
    schemaPath: "./resources/schemas/b2-config-lifecycle.schema.json",
  },
  cors: {
    fileName: "cors.json",
    schemaPath: "./resources/schemas/b2-config-cors.schema.json",
  },
  notifications: {
    fileName: "notifications.json",
    schemaPath: "./resources/schemas/b2-config-notifications.schema.json",
  },
  bucketInfo: {
    fileName: "bucketInfo.json",
    schemaPath: "./resources/schemas/b2-config-bucketInfo.schema.json",
  },
} as const;

export type B2ConfigKind = keyof typeof B2_CONFIG_KIND_DESCRIPTORS;
export const B2_CONFIG_KINDS = Object.keys(B2_CONFIG_KIND_DESCRIPTORS) as B2ConfigKind[];

export interface B2ConfigLocation {
  readonly bucketName: string;
  readonly kind: B2ConfigKind;
}

interface NotificationRuleSecretSnapshot {
  readonly label: string;
  readonly secrets: Readonly<Record<string, string>>;
  readonly customHeaders: Readonly<Record<string, string>>;
}

export interface B2ConfigSecretSnapshot {
  readonly rulesByIdentity: Readonly<Record<string, NotificationRuleSecretSnapshot>>;
  readonly duplicateIdentities: readonly string[];
}

type MutableJsonRecord = Record<string, unknown>;

const NOTIFICATION_SECRET_KEYS = ["hmacSha256SigningSecret", "hmacSha256"] as const;

const CORS_OPERATIONS = new Set([
  "b2_download_file_by_id",
  "b2_download_file_by_name",
  "b2_upload_file",
  "b2_upload_part",
  "s3_delete",
  "s3_get",
  "s3_head",
  "s3_post",
  "s3_put",
]);

const EVENT_TYPES = new Set([
  "b2:ObjectCreated:*",
  "b2:ObjectCreated:Upload",
  "b2:ObjectCreated:MultipartUpload",
  "b2:ObjectCreated:Copy",
  "b2:ObjectCreated:Replica",
  "b2:ObjectCreated:Hide",
  "b2:ObjectDeleted:*",
  "b2:ObjectDeleted:Delete",
  "b2:ObjectDeleted:LifecycleRule",
]);

export function isB2ConfigKind(value: string): value is B2ConfigKind {
  return Object.prototype.hasOwnProperty.call(B2_CONFIG_KIND_DESCRIPTORS, value);
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
  return B2_CONFIG_KIND_DESCRIPTORS[kind].fileName;
}

export function b2ConfigSchemaPath(kind: B2ConfigKind): string {
  return B2_CONFIG_KIND_DESCRIPTORS[kind].schemaPath;
}

export function prettyB2ConfigJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2) ?? "null"}\n`;
}

export function cloneB2ConfigJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is MutableJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): boolean {
  return Number.isInteger(value) && typeof value === "number" && value >= minimum;
}

function validateStringArray(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value)) {
    return `${path} must be an array.`;
  }

  const invalidIndex = value.findIndex((item) => typeof item !== "string");
  return invalidIndex === -1 ? undefined : `${path}[${invalidIndex}] must be a string.`;
}

function validateUniqueStrings(value: readonly string[], path: string): string | undefined {
  const seen = new Set<string>();
  for (const item of value) {
    if (seen.has(item)) {
      return `${path} must not contain duplicate value "${item}".`;
    }
    seen.add(item);
  }
  return undefined;
}

function validateNullableStringArray(value: unknown, path: string): string | undefined {
  return value === null ? undefined : validateStringArray(value, path);
}

function validateNoUnexpectedProperties(
  value: MutableJsonRecord,
  allowedKeys: readonly string[],
  path: string,
): string | undefined {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  return unexpected === undefined ? undefined : `${path}.${unexpected} is not supported.`;
}

function notificationRuleIdentity(rule: unknown): string | undefined {
  if (!isRecord(rule) || !isRecord(rule.targetConfiguration)) {
    return undefined;
  }

  const { name } = rule;
  const targetType = rule.targetConfiguration.targetType;
  const url = rule.targetConfiguration.url;
  if (typeof name !== "string" || typeof targetType !== "string" || typeof url !== "string") {
    return undefined;
  }

  return stableB2ConfigJson({ name, targetType, url });
}

function notificationRuleLabel(rule: unknown): string {
  if (!isRecord(rule) || !isRecord(rule.targetConfiguration)) {
    return "notification rule";
  }

  const name = typeof rule.name === "string" ? rule.name : "[unnamed]";
  const url =
    typeof rule.targetConfiguration.url === "string"
      ? rule.targetConfiguration.url
      : "[unknown target]";
  return `notification rule "${name}" targeting "${url}"`;
}

function findHeaderKey(
  headers: Readonly<Record<string, string>>,
  headerName: string,
): string | undefined {
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

    for (const secretKey of NOTIFICATION_SECRET_KEYS) {
      if (typeof rule.targetConfiguration[secretKey] === "string") {
        rule.targetConfiguration[secretKey] = B2_CONFIG_MASKED_SECRET;
      }
    }

    const customHeaders = rule.targetConfiguration.customHeaders;
    if (!isRecord(customHeaders)) {
      continue;
    }

    for (const [headerName, headerValue] of Object.entries(customHeaders)) {
      if (typeof headerValue === "string") {
        customHeaders[headerName] = B2_CONFIG_MASKED_SECRET;
      }
    }
  }

  return cloned;
}

export function maskB2ConfigForRead(kind: B2ConfigKind, value: unknown): unknown {
  return kind === "notifications" ? maskNotificationRules(value) : cloneB2ConfigJson(value);
}

function hasNotificationMask(rule: unknown): boolean {
  if (!isRecord(rule) || !isRecord(rule.targetConfiguration)) {
    return false;
  }
  const { targetConfiguration } = rule;

  if (
    NOTIFICATION_SECRET_KEYS.some((key) => targetConfiguration[key] === B2_CONFIG_MASKED_SECRET)
  ) {
    return true;
  }

  const customHeaders = targetConfiguration.customHeaders;
  return (
    isRecord(customHeaders) &&
    Object.values(customHeaders).some((headerValue) => headerValue === B2_CONFIG_MASKED_SECRET)
  );
}

function notificationSecretsFromRule(rule: unknown): NotificationRuleSecretSnapshot | undefined {
  if (!isRecord(rule) || !isRecord(rule.targetConfiguration)) {
    return undefined;
  }

  const secrets: Record<string, string> = {};
  for (const secretKey of NOTIFICATION_SECRET_KEYS) {
    const secretValue = rule.targetConfiguration[secretKey];
    if (typeof secretValue === "string") {
      secrets[secretKey] = secretValue;
    }
  }

  const customHeaders: Record<string, string> = {};
  const originalHeaders = rule.targetConfiguration.customHeaders;
  if (isRecord(originalHeaders)) {
    for (const [headerName, headerValue] of Object.entries(originalHeaders)) {
      if (typeof headerValue === "string") {
        customHeaders[headerName] = headerValue;
      }
    }
  }

  if (Object.keys(secrets).length === 0 && Object.keys(customHeaders).length === 0) {
    return undefined;
  }

  return {
    label: notificationRuleLabel(rule),
    secrets,
    customHeaders,
  };
}

export function createB2ConfigSecretSnapshot(
  kind: B2ConfigKind,
  value: unknown,
): B2ConfigSecretSnapshot | undefined {
  if (kind !== "notifications" || !Array.isArray(value)) {
    return undefined;
  }

  const identityCounts = new Map<string, number>();
  const rulesByIdentity = new Map<string, NotificationRuleSecretSnapshot>();

  for (const rule of value) {
    const identity = notificationRuleIdentity(rule);
    if (!identity) {
      continue;
    }
    identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);

    const secretSnapshot = notificationSecretsFromRule(rule);
    if (secretSnapshot) {
      rulesByIdentity.set(identity, secretSnapshot);
    }
  }

  const duplicateIdentities = [...identityCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([identity]) => identity);

  return {
    rulesByIdentity: Object.fromEntries(rulesByIdentity),
    duplicateIdentities,
  };
}

function mergeNotificationSecrets(
  edited: unknown,
  secretSnapshot: B2ConfigSecretSnapshot | undefined,
): unknown {
  const merged = cloneB2ConfigJson(edited);
  if (!Array.isArray(merged)) {
    return merged;
  }

  const usedMaskedIdentities = new Set<string>();
  for (const [index, rule] of merged.entries()) {
    if (!hasNotificationMask(rule)) {
      continue;
    }

    const identity = notificationRuleIdentity(rule);
    if (!identity) {
      throw new Error(
        `Masked secrets in notifications[${index}] cannot be restored because the rule identity is incomplete.`,
      );
    }
    if (secretSnapshot?.duplicateIdentities.includes(identity)) {
      throw new Error(
        `Masked secrets for ${notificationRuleLabel(rule)} cannot be restored because the original rules are ambiguous.`,
      );
    }
    if (usedMaskedIdentities.has(identity)) {
      throw new Error(
        `Masked secrets for ${notificationRuleLabel(rule)} cannot be restored because the edited rules are ambiguous.`,
      );
    }

    const originalSecrets = secretSnapshot?.rulesByIdentity[identity];
    if (!originalSecrets) {
      throw new Error(
        `Masked secrets for ${notificationRuleLabel(rule)} cannot be restored. Replace masks with real values or reload the document.`,
      );
    }
    usedMaskedIdentities.add(identity);

    if (!isRecord(rule) || !isRecord(rule.targetConfiguration)) {
      continue;
    }

    for (const secretKey of NOTIFICATION_SECRET_KEYS) {
      if (rule.targetConfiguration[secretKey] !== B2_CONFIG_MASKED_SECRET) {
        continue;
      }

      const originalSecret = originalSecrets.secrets[secretKey];
      if (typeof originalSecret !== "string") {
        throw new Error(
          `Masked ${secretKey} for ${originalSecrets.label} cannot be restored because no original value exists.`,
        );
      }
      rule.targetConfiguration[secretKey] = originalSecret;
    }

    const editedHeaders = rule.targetConfiguration.customHeaders;
    if (!isRecord(editedHeaders)) {
      continue;
    }

    for (const [headerName, headerValue] of Object.entries(editedHeaders)) {
      if (headerValue !== B2_CONFIG_MASKED_SECRET) {
        continue;
      }
      const originalHeaderName = findHeaderKey(originalSecrets.customHeaders, headerName);
      if (originalHeaderName === undefined) {
        throw new Error(
          `Masked custom header "${headerName}" for ${originalSecrets.label} cannot be restored because no original value exists.`,
        );
      }
      editedHeaders[headerName] = originalSecrets.customHeaders[originalHeaderName];
    }
  }

  return merged;
}

export function mergeMaskedB2Config(
  kind: B2ConfigKind,
  edited: unknown,
  secretSnapshot?: B2ConfigSecretSnapshot,
): unknown {
  return kind === "notifications"
    ? mergeNotificationSecrets(edited, secretSnapshot)
    : cloneB2ConfigJson(edited);
}

function validateLifecycleRule(rule: unknown, index: number): string | undefined {
  const path = `lifecycle[${index}]`;
  if (!isRecord(rule)) {
    return `${path} must be an object.`;
  }

  return (
    validateNoUnexpectedProperties(
      rule,
      ["fileNamePrefix", "daysFromUploadingToHiding", "daysFromHidingToDeleting"],
      path,
    ) ??
    (typeof rule.fileNamePrefix === "string"
      ? undefined
      : `${path}.fileNamePrefix must be a string.`) ??
    (rule.daysFromUploadingToHiding === null || isIntegerAtLeast(rule.daysFromUploadingToHiding, 1)
      ? undefined
      : `${path}.daysFromUploadingToHiding must be an integer of at least 1 or null.`) ??
    (rule.daysFromHidingToDeleting === null || isIntegerAtLeast(rule.daysFromHidingToDeleting, 1)
      ? undefined
      : `${path}.daysFromHidingToDeleting must be an integer of at least 1 or null.`)
  );
}

function validateCorsRule(rule: unknown, index: number): string | undefined {
  const path = `cors[${index}]`;
  if (!isRecord(rule)) {
    return `${path} must be an object.`;
  }

  const operationError = validateStringArray(rule.allowedOperations, `${path}.allowedOperations`);
  if (operationError) {
    return operationError;
  }

  const duplicateOperationError = validateUniqueStrings(
    rule.allowedOperations as string[],
    `${path}.allowedOperations`,
  );
  if (duplicateOperationError) {
    return duplicateOperationError;
  }

  const invalidOperation = (rule.allowedOperations as unknown[]).find(
    (operation) => typeof operation === "string" && !CORS_OPERATIONS.has(operation),
  );

  return (
    validateNoUnexpectedProperties(
      rule,
      [
        "corsRuleName",
        "allowedOrigins",
        "allowedOperations",
        "allowedHeaders",
        "exposeHeaders",
        "maxAgeSeconds",
      ],
      path,
    ) ??
    (typeof rule.corsRuleName === "string"
      ? undefined
      : `${path}.corsRuleName must be a string.`) ??
    validateStringArray(rule.allowedOrigins, `${path}.allowedOrigins`) ??
    (invalidOperation === undefined
      ? undefined
      : `${path}.allowedOperations contains unsupported operation "${String(invalidOperation)}".`) ??
    validateNullableStringArray(rule.allowedHeaders, `${path}.allowedHeaders`) ??
    validateNullableStringArray(rule.exposeHeaders, `${path}.exposeHeaders`) ??
    (isIntegerAtLeast(rule.maxAgeSeconds, 0)
      ? undefined
      : `${path}.maxAgeSeconds must be a non-negative integer.`)
  );
}

function validateNotificationRule(rule: unknown, index: number): string | undefined {
  const path = `notifications[${index}]`;
  if (!isRecord(rule)) {
    return `${path} must be an object.`;
  }

  const eventTypeError = validateStringArray(rule.eventTypes, `${path}.eventTypes`);
  if (eventTypeError) {
    return eventTypeError;
  }

  const duplicateEventTypeError = validateUniqueStrings(
    rule.eventTypes as string[],
    `${path}.eventTypes`,
  );
  if (duplicateEventTypeError) {
    return duplicateEventTypeError;
  }

  const invalidEventType = (rule.eventTypes as unknown[]).find(
    (eventType) => typeof eventType === "string" && !EVENT_TYPES.has(eventType),
  );
  const targetConfiguration = rule.targetConfiguration;
  if (!isRecord(targetConfiguration)) {
    return `${path}.targetConfiguration must be an object.`;
  }

  const url = targetConfiguration.url;
  let urlError: string | undefined;
  if (typeof url !== "string") {
    urlError = `${path}.targetConfiguration.url must be a string.`;
  } else {
    try {
      new URL(url);
    } catch {
      urlError = `${path}.targetConfiguration.url must be a valid URL.`;
    }
  }

  const customHeaders = targetConfiguration.customHeaders;
  if (customHeaders !== undefined) {
    if (!isRecord(customHeaders)) {
      return `${path}.targetConfiguration.customHeaders must be an object.`;
    }
    for (const [headerName, headerValue] of Object.entries(customHeaders)) {
      if (typeof headerValue !== "string") {
        return `${path}.targetConfiguration.customHeaders.${headerName} must be a string.`;
      }
    }
  }

  for (const secretKey of NOTIFICATION_SECRET_KEYS) {
    if (
      targetConfiguration[secretKey] !== undefined &&
      typeof targetConfiguration[secretKey] !== "string"
    ) {
      return `${path}.targetConfiguration.${secretKey} must be a string.`;
    }
  }

  return (
    (typeof rule.name === "string" ? undefined : `${path}.name must be a string.`) ??
    (invalidEventType === undefined
      ? undefined
      : `${path}.eventTypes contains unsupported event type "${String(invalidEventType)}".`) ??
    (typeof rule.isEnabled === "boolean" ? undefined : `${path}.isEnabled must be a boolean.`) ??
    (typeof rule.isSuspended === "boolean"
      ? undefined
      : `${path}.isSuspended must be a boolean.`) ??
    (typeof rule.objectNamePrefix === "string"
      ? undefined
      : `${path}.objectNamePrefix must be a string.`) ??
    (typeof rule.suspensionReason === "string"
      ? undefined
      : `${path}.suspensionReason must be a string.`) ??
    (typeof targetConfiguration.targetType === "string"
      ? undefined
      : `${path}.targetConfiguration.targetType must be a string.`) ??
    urlError
  );
}

function validateArrayConfig(
  kind: B2ConfigKind,
  value: unknown,
  validateItem: (item: unknown, index: number) => string | undefined,
): string | undefined {
  if (!Array.isArray(value)) {
    return `${b2ConfigFileName(kind)} must contain a JSON array.`;
  }

  for (const [index, item] of value.entries()) {
    const error = validateItem(item, index);
    if (error) {
      return error;
    }
  }

  return undefined;
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

export function validateB2ConfigJson(kind: B2ConfigKind, value: unknown): string | undefined {
  switch (kind) {
    case "bucketInfo":
      return validateBucketInfo(value);
    case "cors":
      return validateArrayConfig(kind, value, validateCorsRule);
    case "lifecycle":
      return validateArrayConfig(kind, value, validateLifecycleRule);
    case "notifications":
      return validateArrayConfig(kind, value, validateNotificationRule);
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
  return JSON.stringify(normalizeForStableJson(value)) ?? "null";
}

export function fingerprintB2ConfigJson(value: unknown): string {
  return createHash("sha256").update(stableB2ConfigJson(value)).digest("hex");
}
