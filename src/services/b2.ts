/**
 * B2 SDK client construction and small stream helpers.
 *
 * The extension talks to Backblaze B2 through the official
 * `@backblaze-labs/b2-sdk` high-level facade. This module owns the one place we
 * construct that client (so the custom User-Agent is set consistently) plus a
 * helper to drain a download stream into a Buffer.
 *
 * @module services/b2
 */

import * as vscode from "vscode";
import { B2Client, type B2ClientOptions } from "@backblaze-labs/b2-sdk";
import type { B2Credentials } from "./authService";
import { log } from "../logger";

export const DEFAULT_B2_API_URL = "https://api.backblazeb2.com";

const B2_CONFIGURATION_SECTION = "b2";
const B2_API_URL_SETTING = "apiUrl";
const CUSTOM_API_URL_CONFIRMATION = "Use Custom Endpoint";

export interface B2ApiUrlConfig {
  readonly apiUrl: string;
  readonly isDefault: boolean;
}

export interface B2ApiUrlInspection {
  readonly defaultValue?: unknown;
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
}

export interface CreateB2ClientOptions {
  readonly apiUrl?: string;
}

function normalizeB2ApiUrl(value: unknown): B2ApiUrlConfig {
  if (value === undefined) {
    return { apiUrl: DEFAULT_B2_API_URL, isDefault: true };
  }
  if (typeof value !== "string") {
    throw new Error("b2.apiUrl must be a string.");
  }

  const raw = value.trim();
  if (!raw) {
    throw new Error("b2.apiUrl must not be empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("b2.apiUrl must be a valid HTTPS URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("b2.apiUrl must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("b2.apiUrl must not include embedded credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("b2.apiUrl must not include a query string or fragment.");
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const normalized = `${parsed.protocol}//${parsed.host}${path}`;

  return {
    apiUrl: normalized,
    isDefault: normalized === DEFAULT_B2_API_URL,
  };
}

function isNonDefaultWorkspaceOverride(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }

  try {
    return !normalizeB2ApiUrl(value).isDefault;
  } catch {
    return true;
  }
}

export function resolveB2ApiUrlFromInspection(
  inspection: B2ApiUrlInspection | undefined,
): B2ApiUrlConfig {
  if (
    isNonDefaultWorkspaceOverride(inspection?.workspaceValue) ||
    isNonDefaultWorkspaceOverride(inspection?.workspaceFolderValue)
  ) {
    throw new Error(
      "b2.apiUrl can only be set in user settings. Remove the workspace override before authenticating.",
    );
  }

  return normalizeB2ApiUrl(
    inspection?.globalValue ?? inspection?.defaultValue ?? DEFAULT_B2_API_URL,
  );
}

export function resolveB2ApiUrl(): B2ApiUrlConfig {
  const configuration = vscode.workspace.getConfiguration(B2_CONFIGURATION_SECTION);
  return resolveB2ApiUrlFromInspection(configuration.inspect(B2_API_URL_SETTING));
}

/**
 * Create a B2 SDK client for the given credentials.
 *
 * Call {@link B2Client.authorize} on the result before issuing other requests.
 * The SDK appends its own product token, so the final User-Agent looks like
 * `b2-vscode/<version> b2-sdk-typescript/<version> (...)`.
 */
export function createB2Client(
  credentials: B2Credentials,
  version: string,
  options: CreateB2ClientOptions = {},
): B2Client {
  const apiUrl = normalizeB2ApiUrl(options.apiUrl);
  const clientOptions: B2ClientOptions = {
    applicationKeyId: credentials.keyId,
    applicationKey: credentials.appKey,
    userAgent: `b2-vscode/${version}`,
    ...(apiUrl.isDefault ? {} : { realm: apiUrl.apiUrl }),
  };

  return new B2Client(clientOptions);
}

export async function createConfiguredB2Client(
  credentials: B2Credentials,
  version: string,
): Promise<B2Client> {
  const apiUrl = resolveB2ApiUrl();

  if (!apiUrl.isDefault) {
    const choice = await vscode.window.showWarningMessage(
      `B2: Custom API URL configured (${apiUrl.apiUrl}). Continue only if you trust this endpoint; your B2 application key will be sent there.`,
      { modal: true },
      CUSTOM_API_URL_CONFIRMATION,
    );

    if (choice !== CUSTOM_API_URL_CONFIRMATION) {
      throw new Error("B2 authentication canceled because the custom API URL was not confirmed.");
    }

    log(`Using custom B2 API URL: ${apiUrl.apiUrl}`);
  }

  return createB2Client(credentials, version, { apiUrl: apiUrl.apiUrl });
}

/**
 * Drain a web `ReadableStream<Uint8Array>` (e.g. a B2 download body) into a Buffer.
 */
export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks);
}
