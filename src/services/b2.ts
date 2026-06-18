/**
 * B2 SDK client construction and small stream helpers.
 *
 * The extension talks to Backblaze B2 through the official
 * `@backblaze-labs/b2-sdk` high-level facade. This module owns the one place we
 * construct that client (so the custom User-Agent is set consistently) plus a
 * helpers for streaming transfers between B2 and the local filesystem.
 *
 * @module services/b2
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  B2Client,
  BufferSource,
  type B2ClientOptions,
  type Bucket,
  type FileVersion,
  type ProgressEvent,
  type ProgressListener,
} from "@backblaze-labs/b2-sdk";
import type { B2Credentials } from "./authService";
import { log } from "../logger";

export const DEFAULT_B2_API_URL = "https://api.backblazeb2.com";

const B2_CONFIGURATION_SECTION = "b2";
const B2_API_URL_SETTING = "apiUrl";
export const CONFIRM_CUSTOM_API_URL_LABEL = "Use Custom Endpoint";

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

export function resolveB2ClientApiUrl(options: CreateB2ClientOptions = {}): B2ApiUrlConfig {
  return normalizeB2ApiUrl(options.apiUrl);
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

  // Use an explicit undefined check, not `??`: null and other non-string user
  // values must reach normalizeB2ApiUrl so they fail closed. defaultValue is
  // extension-controlled, so `??` is safe there.
  const configuredValue =
    inspection?.globalValue !== undefined
      ? inspection.globalValue
      : (inspection?.defaultValue ?? DEFAULT_B2_API_URL);

  return normalizeB2ApiUrl(configuredValue);
}

export function resolveB2ApiUrl(): B2ApiUrlConfig {
  const configuration = vscode.workspace.getConfiguration(B2_CONFIGURATION_SECTION);
  return resolveB2ApiUrlFromInspection(configuration.inspect(B2_API_URL_SETTING));
}

export function buildCustomApiUrlWarningMessage(apiUrl: string): string {
  return `B2: Custom API URL configured (${sanitizeApiUrlForDisplay(apiUrl)}). Continue only if you trust this endpoint; your B2 application key will be sent there.`;
}

function sanitizeApiUrlForDisplay(apiUrl: string): string {
  try {
    const parsed = new URL(apiUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";

    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return "[invalid URL]";
  }
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
  const apiUrl = resolveB2ClientApiUrl(options);
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
      buildCustomApiUrlWarningMessage(apiUrl.apiUrl),
      { modal: true },
      CONFIRM_CUSTOM_API_URL_LABEL,
    );

    if (choice !== CONFIRM_CUSTOM_API_URL_LABEL) {
      throw new Error("B2 authentication canceled because the custom API URL was not confirmed.");
    }

    log(`Using custom B2 API URL: ${apiUrl.apiUrl}`);
  }

  return createB2Client(credentials, version, { apiUrl: apiUrl.apiUrl });
}

export interface TransferProgressOptions {
  readonly title: string;
  readonly token?: vscode.CancellationToken;
}

export interface TransferRunContext {
  readonly progress: vscode.Progress<{ message?: string; increment?: number }>;
  readonly signal: AbortSignal;
}

export interface DownloadStreamToFileOptions {
  readonly signal?: AbortSignal;
}

export interface UploadFileFromDiskOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressListener;
}

function cancellationError(): vscode.CancellationError {
  return new vscode.CancellationError();
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error.name === "TimeoutError";
}

export async function withCancellableTransferProgress<T>(
  options: TransferProgressOptions,
  run: (context: TransferRunContext) => Promise<T>,
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.title,
      cancellable: true,
    },
    async (progress, progressToken) => {
      const controller = new AbortController();
      const disposables: vscode.Disposable[] = [];

      const cancel = () => {
        if (!controller.signal.aborted) {
          controller.abort(cancellationError());
        }
      };

      if (options.token?.isCancellationRequested || progressToken.isCancellationRequested) {
        throw cancellationError();
      }

      if (options.token) {
        disposables.push(options.token.onCancellationRequested(cancel));
      }
      disposables.push(progressToken.onCancellationRequested(cancel));

      try {
        return await run({ progress, signal: controller.signal });
      } catch (error) {
        if (
          controller.signal.aborted ||
          options.token?.isCancellationRequested ||
          progressToken.isCancellationRequested ||
          isAbortLikeError(error)
        ) {
          throw cancellationError();
        }
        throw error;
      } finally {
        for (const disposable of disposables) {
          disposable.dispose();
        }
      }
    },
  );
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return unitIndex === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function createTransferProgressReporter(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  totalBytesOverride?: number,
): ProgressListener {
  let previousPercent = 0;

  return (event: ProgressEvent) => {
    const totalBytes = event.totalBytes ?? totalBytesOverride ?? null;
    const report: { message?: string; increment?: number } = {
      message:
        totalBytes && totalBytes > 0
          ? `${formatBytes(event.bytesTransferred)} of ${formatBytes(totalBytes)}`
          : formatBytes(event.bytesTransferred),
    };

    if (totalBytes && totalBytes > 0) {
      const percent = Math.min(100, (event.bytesTransferred / totalBytes) * 100);
      const increment = percent - previousPercent;
      previousPercent = percent;
      if (increment > 0) {
        report.increment = increment;
      }
    }

    progress.report(report);
  };
}

function tempDownloadPath(destinationPath: string): string {
  const parsed = path.parse(destinationPath);
  return path.join(
    parsed.dir,
    `.${parsed.base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

export async function downloadStreamToFile(
  stream: ReadableStream<Uint8Array>,
  destinationPath: string,
  options: DownloadStreamToFileOptions = {},
): Promise<number> {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

  const temporaryPath = tempDownloadPath(destinationPath);
  try {
    const readable = Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(readable, fs.createWriteStream(temporaryPath), {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const stats = await fs.promises.stat(temporaryPath);
    await fs.promises.rename(temporaryPath, destinationPath);
    return stats.size;
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function uploadFileFromDisk(
  bucket: Bucket,
  localPath: string,
  remotePath: string,
  options: UploadFileFromDiskOptions = {},
): Promise<FileVersion> {
  const stats = await fs.promises.stat(localPath);

  if (stats.size === 0) {
    return bucket.upload({
      fileName: remotePath,
      source: new BufferSource(new Uint8Array(0)),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    });
  }

  const { writable, done } = bucket.file(remotePath).createWriteStream({
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
  });
  const readable = Readable.toWeb(fs.createReadStream(localPath)) as ReadableStream<Uint8Array>;

  await readable.pipeTo(writable, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  return done;
}
