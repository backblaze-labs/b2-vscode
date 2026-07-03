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
import {
  B2_CONFIG_KINDS,
  B2_CONFIG_SCHEME,
  b2ConfigFileName,
  cloneB2ConfigJson,
  maskB2ConfigForRead,
  mergeMaskedB2Config,
  parseB2ConfigPath,
  prettyB2ConfigJson,
  stableB2ConfigJson,
  validateB2ConfigJson,
  type B2ConfigKind,
  type B2ConfigLocation,
} from "./b2ConfigJson";

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
  readonly originalConfig: unknown;
  readonly originalFingerprint: string;
  readonly revision: number;
  readonly mtime: number;
  readonly size: number;
}

class B2ConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "B2ConfigConflictError";
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
    const cacheEntry = this.cache.get(this.cacheKey(uri));
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
    const bucket = await this.resolveBucket(location.bucketName, uri);
    const { config, revision } = await this.readLiveConfig(bucket, location.kind);
    const maskedConfig = maskB2ConfigForRead(location.kind, config);
    const bytes = Buffer.from(prettyB2ConfigJson(maskedConfig), "utf8");

    this.cache.set(this.cacheKey(uri), {
      ...location,
      originalConfig: cloneB2ConfigJson(config),
      originalFingerprint: stableB2ConfigJson(config),
      revision,
      mtime: Date.now(),
      size: bytes.byteLength,
    });

    return bytes;
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const location = this.parseUri(uri);
    const key = this.cacheKey(uri);
    const cacheEntry = this.cache.get(key);
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
    const mergedConfig = mergeMaskedB2Config(location.kind, parsedConfig, snapshot.originalConfig);
    const bucket = await this.resolveBucket(location.bucketName, uri);

    try {
      const updated = await this.persistConfig(bucket, location.kind, mergedConfig, snapshot);
      const updatedBytes = Buffer.from(
        prettyB2ConfigJson(maskB2ConfigForRead(location.kind, updated.config)),
        "utf8",
      );
      this.cache.set(key, {
        ...location,
        originalConfig: cloneB2ConfigJson(updated.config),
        originalFingerprint: stableB2ConfigJson(updated.config),
        revision: updated.revision,
        mtime: Date.now(),
        size: updatedBytes.byteLength,
      });
      this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    } catch (error) {
      if (error instanceof B2ConfigConflictError) {
        await this.rejectWrite(error.message);
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

  private async resolveBucket(bucketName: string, uri: vscode.Uri): Promise<B2ConfigBucket> {
    const client = this.getClient();
    if (!client) {
      throw vscode.FileSystemError.Unavailable("B2: Not authenticated.");
    }

    const bucket = await client.getBucket(bucketName);
    if (!bucket) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return bucket;
  }

  private async readLiveConfig(
    bucket: B2ConfigBucket,
    kind: B2ConfigKind,
  ): Promise<{ readonly config: unknown; readonly revision: number }> {
    const revision = bucket.info.revision;
    if (typeof revision !== "number") {
      throw new Error("B2 bucket metadata is missing a revision.");
    }

    switch (kind) {
      case "bucketInfo":
        return { config: bucket.info.bucketInfo, revision };
      case "cors":
        return { config: bucket.info.corsRules, revision };
      case "lifecycle":
        return { config: bucket.info.lifecycleRules, revision };
      case "notifications": {
        const response = await bucket.getNotificationRules();
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
    kind: B2ConfigKind,
    config: unknown,
    snapshot: B2ConfigCacheEntry,
  ): Promise<{ readonly config: unknown; readonly revision: number }> {
    switch (kind) {
      case "bucketInfo": {
        const updated = await bucket.update({
          bucketInfo: config as Record<string, string>,
          ifRevisionIs: snapshot.revision,
        });
        return { config: updated.bucketInfo, revision: updated.revision };
      }
      case "cors": {
        const updated = await bucket.update({
          corsRules: config as CorsRule[],
          ifRevisionIs: snapshot.revision,
        });
        return { config: updated.corsRules, revision: updated.revision };
      }
      case "lifecycle": {
        const updated = await bucket.update({
          lifecycleRules: config as LifecycleRule[],
          ifRevisionIs: snapshot.revision,
        });
        return { config: updated.lifecycleRules, revision: updated.revision };
      }
      case "notifications":
        await this.assertNotificationSnapshotCurrent(bucket, snapshot);
        return this.persistNotificationRules(bucket, config, snapshot.revision);
    }
  }

  private async persistNotificationRules(
    bucket: B2ConfigBucket,
    config: unknown,
    revision: number,
  ): Promise<{ readonly config: unknown; readonly revision: number }> {
    await bucket.setNotificationRules(config as EventNotificationRule[]);
    return { config, revision };
  }

  private async assertNotificationSnapshotCurrent(
    bucket: B2ConfigBucket,
    snapshot: B2ConfigCacheEntry,
  ): Promise<void> {
    if (bucket.info.revision !== snapshot.revision) {
      throw new B2ConfigConflictError(this.conflictMessage(snapshot));
    }

    const current = await bucket.getNotificationRules();
    if (stableB2ConfigJson(current.eventNotificationRules) !== snapshot.originalFingerprint) {
      throw new B2ConfigConflictError(this.conflictMessage(snapshot));
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
