/**
 * FileSystemProvider for editable Backblaze B2 bucket configuration JSON.
 *
 * @module providers/b2ConfigFileSystemProvider
 */

import * as vscode from "vscode";
import type {
  BucketInfo,
  CorsRule,
  EventNotificationRule,
  GetBucketNotificationRulesResponse,
  LifecycleRule,
} from "@backblaze-labs/b2-sdk";
import { formatB2UserMessage, isBucketRevisionConflict } from "../errors";
import { log, logError } from "../logger";
import {
  B2_CONFIG_KINDS,
  B2_CONFIG_SCHEME,
  b2ConfigFileName,
  createB2ConfigSecretSnapshot,
  fingerprintB2ConfigJson,
  maskB2ConfigForRead,
  mergeMaskedB2Config,
  parseB2ConfigPath,
  prettyB2ConfigJson,
  validateB2ConfigJson,
  type B2ConfigKind,
  type B2ConfigLocation,
  type B2ConfigSecretSnapshot,
} from "./b2ConfigJson";

export const B2_CONFIG_REMOTE_TIMEOUT_MS = 60_000;
export const B2_CONFIG_CACHE_TTL_MS = 15 * 60 * 1000;
export const B2_CONFIG_CACHE_MAX_ENTRIES = 32;

type BucketConfigUpdate = {
  readonly bucketInfo?: Record<string, string>;
  readonly corsRules?: CorsRule[];
  readonly lifecycleRules?: LifecycleRule[];
  readonly ifRevisionIs?: number;
};

export interface B2ConfigBucket {
  readonly name: string;
  readonly info: Pick<
    BucketInfo,
    "bucketName" | "bucketInfo" | "corsRules" | "lifecycleRules" | "revision"
  >;
  update(options: BucketConfigUpdate): Promise<BucketInfo>;
  getNotificationRules(): Promise<GetBucketNotificationRulesResponse>;
  setNotificationRules(rules: EventNotificationRule[]): Promise<GetBucketNotificationRulesResponse>;
}

export interface B2ConfigClient {
  getBucket(bucketName: string): Promise<B2ConfigBucket | null>;
}

interface B2ConfigCacheEntry extends B2ConfigLocation {
  readonly originalFingerprint: string;
  readonly secretSnapshot?: B2ConfigSecretSnapshot;
  readonly revision: number;
  readonly mtime: number;
  readonly size: number;
  readonly expiresAt: number;
  readonly lastAccessedAt: number;
}

class B2ConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "B2ConfigConflictError";
  }
}

class B2ConfigRemoteTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "B2ConfigRemoteTimeoutError";
  }
}

export function buildB2ConfigUri(bucketName: string, kind: B2ConfigKind): vscode.Uri {
  return vscode.Uri.from({
    scheme: B2_CONFIG_SCHEME,
    path: `/${bucketName}/${b2ConfigFileName(kind)}`,
  });
}

export class B2ConfigFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly cache = new Map<string, B2ConfigCacheEntry>();

  readonly onDidChangeFile = this.changeEmitter.event;

  constructor(private readonly getClient: () => B2ConfigClient | null) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.scheme !== B2_CONFIG_SCHEME) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const segments = uri.path.split("/").filter(Boolean);
    if (segments.length === 0 || segments.length === 1) {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: 0,
      };
    }

    this.parseUri(uri);
    const cacheEntry = this.getCacheEntry(this.cacheKey(uri));
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: cacheEntry?.mtime ?? Date.now(),
      size: cacheEntry?.size ?? Buffer.byteLength(prettyB2ConfigJson([])),
    };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (uri.scheme !== B2_CONFIG_SCHEME) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const segments = uri.path.split("/").filter(Boolean);
    if (segments.length === 0) {
      return [];
    }
    if (segments.length === 1) {
      return B2_CONFIG_KINDS.map((kind) => [b2ConfigFileName(kind), vscode.FileType.File]);
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const location = this.parseUri(uri);
    try {
      const bucket = await this.resolveBucket(location, uri);
      const { config, revision } = await this.readLiveConfig(bucket, location);
      const maskedConfig = maskB2ConfigForRead(location.kind, config);
      const bytes = Buffer.from(prettyB2ConfigJson(maskedConfig), "utf8");

      this.rememberConfigSnapshot(uri, location, config, revision, bytes.byteLength);

      return bytes;
    } catch (error) {
      if (error instanceof B2ConfigRemoteTimeoutError) {
        await vscode.window.showErrorMessage(`B2: ${error.message}`);
      }
      throw error;
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const location = this.parseUri(uri);
    const key = this.cacheKey(uri);
    const cacheEntry = this.getCacheEntry(key);
    if (!cacheEntry && !options.create) {
      await this.rejectWrite(
        `B2: Open or reload ${b2ConfigFileName(location.kind)} before saving it.`,
      );
    }
    if (cacheEntry && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    const parsedConfig = await this.parseEditedJson(location, content);
    const validationError = validateB2ConfigJson(location.kind, parsedConfig);
    if (validationError) {
      await this.rejectWrite(`B2: ${validationError}`);
    }

    const snapshot = cacheEntry ?? (await this.createWriteSnapshot(uri, location));
    let mergedConfig: unknown;
    try {
      mergedConfig = mergeMaskedB2Config(location.kind, parsedConfig, snapshot.secretSnapshot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.rejectWrite(`B2: ${detail}`);
    }

    try {
      const bucket = await this.resolveBucket(location, uri);
      const updated = await this.persistConfig(bucket, location, mergedConfig, snapshot);
      const updatedBytes = Buffer.from(
        prettyB2ConfigJson(maskB2ConfigForRead(location.kind, updated.config)),
        "utf8",
      );
      this.rememberConfigSnapshot(
        uri,
        location,
        updated.config,
        updated.revision,
        updatedBytes.byteLength,
      );
      this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (error) {
      if (error instanceof B2ConfigConflictError) {
        await this.rejectWrite(error.message);
      }
      if (error instanceof B2ConfigRemoteTimeoutError) {
        await this.rejectWrite(`B2: ${error.message}`, error);
      }
      if (isBucketRevisionConflict(error)) {
        await this.rejectWrite(this.conflictMessage(location), error);
      }
      await this.rejectWrite(
        `B2: Failed to save ${b2ConfigFileName(location.kind)} for "${location.bucketName}". ${formatB2UserMessage(error)}`,
        error,
      );
    }
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(_oldUri: vscode.Uri, newUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(newUri);
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.cache.clear();
  }

  clearCache(): void {
    this.cache.clear();
  }

  deleteCacheEntry(uri: vscode.Uri): void {
    this.cache.delete(this.cacheKey(uri));
  }

  private parseUri(uri: vscode.Uri): B2ConfigLocation {
    if (uri.scheme !== B2_CONFIG_SCHEME) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const location = parseB2ConfigPath(uri.path);
    if (!location) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return location;
  }

  private cacheKey(uri: vscode.Uri): string {
    return uri.toString();
  }

  private getCacheEntry(key: string): B2ConfigCacheEntry | undefined {
    this.pruneCache();
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    const now = Date.now();
    if (entry.expiresAt <= now) {
      this.cache.delete(key);
      return undefined;
    }

    const touched = { ...entry, lastAccessedAt: now };
    this.cache.set(key, touched);
    return touched;
  }

  private rememberConfigSnapshot(
    uri: vscode.Uri,
    location: B2ConfigLocation,
    config: unknown,
    revision: number,
    size: number,
  ): void {
    const now = Date.now();
    this.cache.set(this.cacheKey(uri), {
      ...location,
      originalFingerprint: fingerprintB2ConfigJson(config),
      secretSnapshot: createB2ConfigSecretSnapshot(location.kind, config),
      revision,
      mtime: now,
      size,
      expiresAt: now + B2_CONFIG_CACHE_TTL_MS,
      lastAccessedAt: now,
    });
    this.pruneCache(now);
  }

  private pruneCache(now: number = Date.now()): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }

    if (this.cache.size <= B2_CONFIG_CACHE_MAX_ENTRIES) {
      return;
    }

    const entriesByAge = [...this.cache.entries()].sort(
      ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt,
    );
    for (const [key] of entriesByAge.slice(0, this.cache.size - B2_CONFIG_CACHE_MAX_ENTRIES)) {
      this.cache.delete(key);
    }
  }

  private async resolveBucket(
    location: B2ConfigLocation,
    uri: vscode.Uri,
  ): Promise<B2ConfigBucket> {
    const client = this.getClient();
    if (!client) {
      throw vscode.FileSystemError.Unavailable("B2: Not authenticated.");
    }

    const bucket = await this.withRemoteTimeout(location, "fetch bucket metadata", () =>
      client.getBucket(location.bucketName),
    );
    if (!bucket) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return bucket;
  }

  private async readLiveConfig(
    bucket: B2ConfigBucket,
    location: B2ConfigLocation,
  ): Promise<{ readonly config: unknown; readonly revision: number }> {
    const revision = bucket.info.revision;
    if (typeof revision !== "number") {
      throw new Error("B2 bucket metadata is missing a revision.");
    }

    switch (location.kind) {
      case "bucketInfo":
        return { config: bucket.info.bucketInfo, revision };
      case "cors":
        return { config: bucket.info.corsRules, revision };
      case "lifecycle":
        return { config: bucket.info.lifecycleRules, revision };
      case "notifications": {
        const response = await this.withRemoteTimeout(location, "read notification rules", () =>
          bucket.getNotificationRules(),
        );
        return { config: response.eventNotificationRules, revision };
      }
    }
  }

  private async parseEditedJson(location: B2ConfigLocation, content: Uint8Array): Promise<unknown> {
    const text = Buffer.from(content).toString("utf8");
    try {
      return JSON.parse(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.rejectWrite(
        `B2: ${b2ConfigFileName(location.kind)} contains invalid JSON. ${detail}`,
      );
    }
  }

  private async createWriteSnapshot(
    uri: vscode.Uri,
    location: B2ConfigLocation,
  ): Promise<B2ConfigCacheEntry> {
    const bytes = await this.readFile(uri);
    const entry = this.cache.get(this.cacheKey(uri));
    if (!entry) {
      throw new Error(`B2: Could not prepare ${b2ConfigFileName(location.kind)} for saving.`);
    }
    return { ...entry, size: bytes.byteLength };
  }

  private async persistConfig(
    bucket: B2ConfigBucket,
    location: B2ConfigLocation,
    config: unknown,
    snapshot: B2ConfigCacheEntry,
  ): Promise<{ readonly config: unknown; readonly revision: number }> {
    switch (location.kind) {
      case "bucketInfo": {
        const updated = await this.withRemoteTimeout(
          location,
          "save bucketInfo",
          () =>
            bucket.update({
              bucketInfo: config as Record<string, string>,
              ifRevisionIs: snapshot.revision,
            }),
          { observeLateOutcome: true },
        );
        return { config: updated.bucketInfo, revision: updated.revision };
      }
      case "cors": {
        const updated = await this.withRemoteTimeout(
          location,
          "save CORS rules",
          () =>
            bucket.update({
              corsRules: config as CorsRule[],
              ifRevisionIs: snapshot.revision,
            }),
          { observeLateOutcome: true },
        );
        return { config: updated.corsRules, revision: updated.revision };
      }
      case "lifecycle": {
        const updated = await this.withRemoteTimeout(
          location,
          "save lifecycle rules",
          () =>
            bucket.update({
              lifecycleRules: config as LifecycleRule[],
              ifRevisionIs: snapshot.revision,
            }),
          { observeLateOutcome: true },
        );
        return { config: updated.lifecycleRules, revision: updated.revision };
      }
      case "notifications":
        await this.assertNotificationSnapshotCurrent(bucket, location, snapshot);
        return this.persistNotificationRules(bucket, location, config, snapshot.revision);
    }
  }

  private async persistNotificationRules(
    bucket: B2ConfigBucket,
    location: B2ConfigLocation,
    config: unknown,
    revision: number,
  ): Promise<{ readonly config: unknown; readonly revision: number }> {
    try {
      await this.withRemoteTimeout(
        location,
        "save notification rules",
        () => bucket.setNotificationRules(config as EventNotificationRule[]),
        { observeLateOutcome: true },
      );
    } catch (error) {
      const reconciled = await this.reconcileNotificationSave(bucket, location, config, error);
      if (reconciled) {
        return { config: reconciled, revision };
      }
      throw error;
    }

    return { config, revision };
  }

  private async reconcileNotificationSave(
    bucket: B2ConfigBucket,
    location: B2ConfigLocation,
    intendedConfig: unknown,
    originalError: unknown,
  ): Promise<unknown | undefined> {
    try {
      const current = await this.withRemoteTimeout(
        location,
        "re-read notification rules after failed save",
        () => bucket.getNotificationRules(),
      );
      if (
        fingerprintB2ConfigJson(current.eventNotificationRules) ===
        fingerprintB2ConfigJson(intendedConfig)
      ) {
        log(
          `B2 config save for ${b2ConfigFileName(location.kind)} in bucket "${location.bucketName}" was reconciled after a failed response.`,
        );
        return current.eventNotificationRules;
      }
    } catch (reconcileError) {
      logError(
        `Could not reconcile B2 config save for ${b2ConfigFileName(location.kind)} in bucket "${location.bucketName}" after a failed response`,
        reconcileError,
      );
    }

    logError(
      `B2 config save for ${b2ConfigFileName(location.kind)} in bucket "${location.bucketName}" could not be reconciled after failure`,
      originalError,
    );
    return undefined;
  }

  private async assertNotificationSnapshotCurrent(
    bucket: B2ConfigBucket,
    location: B2ConfigLocation,
    snapshot: B2ConfigCacheEntry,
  ): Promise<void> {
    if (bucket.info.revision !== snapshot.revision) {
      throw new B2ConfigConflictError(this.conflictMessage(snapshot));
    }

    const current = await this.withRemoteTimeout(location, "check notification rules", () =>
      bucket.getNotificationRules(),
    );
    if (fingerprintB2ConfigJson(current.eventNotificationRules) !== snapshot.originalFingerprint) {
      throw new B2ConfigConflictError(this.conflictMessage(snapshot));
    }
  }

  private async withRemoteTimeout<T>(
    location: B2ConfigLocation,
    operation: string,
    run: (signal: AbortSignal) => Promise<T>,
    options: { readonly observeLateOutcome?: boolean } = {},
  ): Promise<T> {
    const description = `B2 config ${operation} for ${b2ConfigFileName(location.kind)} in bucket "${location.bucketName}"`;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let timeoutError: B2ConfigRemoteTimeoutError | undefined;
    const operationPromise = Promise.resolve().then(() => run(controller.signal));
    void operationPromise.catch(() => undefined);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutError = new B2ConfigRemoteTimeoutError(
          `${description} timed out after ${B2_CONFIG_REMOTE_TIMEOUT_MS} ms.`,
        );
        if (!controller.signal.aborted) {
          controller.abort(timeoutError);
        }
        reject(timeoutError);
      }, B2_CONFIG_REMOTE_TIMEOUT_MS);
      timer.unref?.();
    });

    try {
      return await Promise.race([operationPromise, timeout]);
    } catch (error) {
      if (timedOut && error === timeoutError) {
        logError(`${description} timed out`, error);
        if (options.observeLateOutcome) {
          void operationPromise.then(
            () => {
              log(`${description} completed after the client-side timeout.`);
            },
            (lateError) => {
              logError(`${description} failed after the client-side timeout`, lateError);
            },
          );
        }
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private conflictMessage(location: B2ConfigLocation): string {
    return `B2: Bucket "${location.bucketName}" changed after ${b2ConfigFileName(location.kind)} was opened. Reload the b2-config document and apply your edits again.`;
  }

  private async rejectWrite(message: string, cause?: unknown): Promise<never> {
    await vscode.window.showErrorMessage(message);
    if (cause instanceof Error) {
      throw cause;
    }
    throw new Error(message);
  }
}

export { B2_CONFIG_FILE_EXTENSION } from "./b2ConfigJson";
export { B2_CONFIG_SCHEME };
