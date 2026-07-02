/**
 * Tests for command error message construction.
 *
 * @module test/suite/commands
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  B2Client,
  classifyError,
  NetworkError,
  type Bucket,
  type BucketType,
} from "@backblaze-labs/b2-sdk";
import {
  type CommandServices,
  type BucketCreationClient,
  type BucketCommandServices,
  type BucketVisibilityItem,
  authenticateCommand,
  buildCommandErrorMessage,
  changeBucketVisibilityCommand,
  createBucketCommand,
  createFolderCommand,
  openFileCommand,
} from "../../commands";
import {
  CONFIRM_PUBLIC_BUCKET_LABEL,
  isPublicBucketNameConfirmationAccepted,
} from "../../commands/publicBucketVisibility";
import { B2PartialFailureError, isPostRequestB2MutationStateAmbiguous } from "../../errors";
import { createAuthenticatedClientSetter } from "../../extension";
import { BucketTreeItem } from "../../models/bucketTreeItem";
import type { FileTreeItem } from "../../models/fileTreeItem";
import { FolderTreeItem } from "../../models/folderTreeItem";
import type { TempFileManager } from "../../services/tempFileManager";
import { tempDir } from "../../testSupport/tempDir";
import {
  B2_AUTO_CONTENT_TYPE,
  OVERWRITE_UPLOAD_LABEL,
  uploadFilesCommand,
  uploadLocalUrisToTarget,
} from "../../commands/uploadFiles";
import { withWindowUiStubs } from "./windowStubs";

type CreateBucketOptions = Parameters<B2Client["createBucket"]>[0];
type CreateBucketResult = Awaited<ReturnType<B2Client["createBucket"]>>;
type UpdateBucketOptions = Parameters<Bucket["update"]>[0];
type UpdateBucketResult = Awaited<ReturnType<Bucket["update"]>>;
type AbortableCreateBucketOptions = CreateBucketOptions & { readonly signal?: AbortSignal };
type AbortableUpdateBucketOptions = UpdateBucketOptions & { readonly signal?: AbortSignal };

const PRIVATE_VISIBILITY_LABEL = "Private";
const PUBLIC_VISIBILITY_LABEL = "Public";
const CONFIRM_PUBLIC_VISIBILITY_LABEL = "Change to Public";
const CONFIRM_PRIVATE_VISIBILITY_LABEL = "Change to Private";

function makeCommandServices<TClient>(
  client: TClient | null,
  options: Pick<
    BucketCommandServices,
    "bucketMutationTimeoutMs" | "bucketMutationPostTimeoutSettleMs"
  > = {},
): {
  readonly services: BucketCommandServices & { getClient: () => TClient | null };
  readonly refreshCount: () => number;
} {
  let refreshes = 0;
  const services: BucketCommandServices & { getClient: () => TClient | null } = {
    treeProvider: {
      refresh() {
        refreshes++;
      },
    },
    isAuthenticated: () => client !== null,
    getClient: () => client,
    ...options,
  };

  return {
    services,
    refreshCount: () => refreshes,
  };
}

function makeCreateBucketClient(
  implementation?: (options: AbortableCreateBucketOptions) => Promise<CreateBucketResult>,
): { readonly client: BucketCreationClient; readonly calls: AbortableCreateBucketOptions[] } {
  const calls: AbortableCreateBucketOptions[] = [];
  const client = {
    async createBucket(options: AbortableCreateBucketOptions): Promise<CreateBucketResult> {
      calls.push(options);
      if (implementation) {
        return implementation(options);
      }
      const createdBucket: Partial<CreateBucketResult> = { name: options.bucketName };
      return createdBucket as CreateBucketResult;
    },
  } satisfies BucketCreationClient;

  return { client, calls };
}

function makeBucketTreeItem(
  bucketName: string,
  bucketType: BucketType,
  implementation?: (options: AbortableUpdateBucketOptions) => Promise<UpdateBucketResult>,
): { readonly item: BucketVisibilityItem; readonly updates: AbortableUpdateBucketOptions[] } {
  const updates: AbortableUpdateBucketOptions[] = [];
  const bucket = {
    info: { bucketType, revision: 7 },
    async update(options: AbortableUpdateBucketOptions): Promise<UpdateBucketResult> {
      updates.push(options);
      if (implementation) {
        return implementation(options);
      }
      const updatedBucket: Partial<UpdateBucketResult> = {
        bucketName,
        bucketType: options.bucketType ?? bucketType,
      };
      return updatedBucket as UpdateBucketResult;
    },
  };

  return {
    item: {
      bucketName,
      bucketType,
      bucket,
    },
    updates,
  };
}

function createBucketRequestWithoutSignal(
  options: AbortableCreateBucketOptions,
): CreateBucketOptions {
  const { signal: _signal, ...request } = options;
  return request;
}

function updateBucketRequestWithoutSignal(
  options: AbortableUpdateBucketOptions,
): UpdateBucketOptions {
  const { signal: _signal, ...request } = options;
  return request;
}

function assertAbortSignalIsEnumerable(options: { readonly signal?: AbortSignal }): void {
  assert.ok(options.signal);
  assert.strictEqual(Object.prototype.propertyIsEnumerable.call(options, "signal"), true);
  assert.strictEqual({ ...options }.signal, options.signal);
}

interface UploadCall {
  readonly kind: "stream" | "empty";
  readonly fileName: string;
  readonly contentType: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly bytes: number;
}

function notFoundError(): Error & { status: number; code: string } {
  const error = new Error("not found") as Error & { status: number; code: string };
  error.status = 404;
  error.code = "not_found";
  return error;
}

function makeUploadBucket(existingPaths: readonly string[] = []): {
  readonly bucket: Bucket;
  readonly calls: UploadCall[];
  readonly headSignals: Array<AbortSignal | undefined>;
} {
  const calls: UploadCall[] = [];
  const headSignals: Array<AbortSignal | undefined> = [];
  const existing = new Set(existingPaths);
  const bucket = {
    name: "bucket",
    id: "bucket-id",
    info: { bucketType: "allPrivate" },
    async head(fileName: string, options?: { signal?: AbortSignal }) {
      headSignals.push(options?.signal);
      if (existing.has(fileName)) {
        return {};
      }
      throw notFoundError();
    },
    async upload(options: {
      fileName: string;
      contentType?: string;
      signal?: AbortSignal;
      onProgress?: (event: { bytesTransferred: number; totalBytes?: number | null }) => void;
    }) {
      options.onProgress?.({ bytesTransferred: 0, totalBytes: 0 });
      calls.push({
        kind: "empty",
        fileName: options.fileName,
        contentType: options.contentType,
        signal: options.signal,
        bytes: 0,
      });
      return {
        fileId: `id-${calls.length}`,
        fileName: options.fileName,
        contentLength: 0,
      };
    },
    file(fileName: string) {
      return {
        createWriteStream(options?: {
          contentType?: string;
          signal?: AbortSignal;
          onProgress?: (event: { bytesTransferred: number; totalBytes?: number | null }) => void;
        }) {
          let bytes = 0;
          let resolveDone: (value: unknown) => void = () => undefined;
          const done = new Promise((resolve) => {
            resolveDone = resolve;
          });
          const writable = new WritableStream<Uint8Array>({
            write(chunk) {
              bytes += chunk.byteLength;
              options?.onProgress?.({ bytesTransferred: bytes, totalBytes: null });
            },
            close() {
              calls.push({
                kind: "stream",
                fileName,
                contentType: options?.contentType,
                signal: options?.signal,
                bytes,
              });
              resolveDone({
                fileId: `id-${calls.length}`,
                fileName,
                contentLength: bytes,
              });
            },
          });
          return { writable, done };
        },
      };
    },
  } as unknown as Bucket;

  return { bucket, calls, headSignals };
}

function makeCancellationAmbiguousBucket(onUploadStarted: () => void): Bucket {
  return {
    name: "bucket",
    id: "bucket-id",
    info: { bucketType: "allPrivate" },
    async head() {
      throw notFoundError();
    },
    async upload(options: { signal?: AbortSignal }) {
      onUploadStarted();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
    file() {
      throw new Error("streaming upload should not be used for zero-byte entries");
    },
  } as unknown as Bucket;
}

suite("B2 commands error handling", () => {
  test("authentication errors surface invalid credential guidance", () => {
    const message = buildCommandErrorMessage(
      "B2: Authentication failed",
      classifyError({ status: 401, code: "bad_auth_token", message: "bad key" }),
    );

    assert.match(message, /^B2: Authentication failed\./);
    assert.match(message, /Run B2: Authenticate/i);
  });

  test("partial rename failures do not look successful", () => {
    const message = buildCommandErrorMessage(
      "B2: Failed to rename",
      new B2PartialFailureError(
        'Rename incomplete. Copied "old.csv" to "new.csv", but failed to delete the original. Both B2 objects may exist.',
      ),
    );

    assert.match(message, /Rename incomplete/i);
    assert.match(message, /Both B2 objects may exist/i);
    assert.doesNotMatch(message, /Renamed to/i);
  });

  test("open file cancellation does not show a failure notification", async () => {
    const item = {
      bucketName: "bucket",
      file: { fileName: "file.txt", contentLength: 4 },
      bucket: {
        async download() {
          return { body: new ReadableStream<Uint8Array>() };
        },
      },
    } as unknown as FileTreeItem;
    const tempFileManager = {
      getCachedPath: () => undefined,
      async saveStream() {
        throw new vscode.CancellationError();
      },
    } as unknown as TempFileManager;
    const client = new B2Client({ applicationKeyId: "key-id", applicationKey: "app-key" });

    const ui = await withWindowUiStubs({}, () =>
      openFileCommand(item, {
        tempFileManager,
        getClient: () => client,
      }),
    );

    assert.deepStrictEqual(ui.errors, []);
  });

  test("manual authenticate schedules authenticated cleanup through the setter", async () => {
    const fakeClient = {
      async authorize() {
        return undefined;
      },
      accountInfo: {
        getAccountId: () => "account-id",
        getApiUrl: () => "https://api.example.com",
        getDownloadUrl: () => "https://download.example.com",
      },
    } as unknown as B2Client;
    const scheduledClients: B2Client[] = [];
    const treeClients: Array<B2Client | null> = [];
    const storedCredentials: Array<{ keyId: string; appKey: string }> = [];
    const authStates: unknown[] = [];
    const setClient = createAuthenticatedClientSetter((client) => {
      scheduledClients.push(client);
    });
    const services = {
      authService: {
        async storeCredentials(keyId: string, appKey: string) {
          storedCredentials.push({ keyId, appKey });
        },
        async setAuthState(state: unknown) {
          authStates.push(state);
        },
      },
      context: {
        extension: { packageJSON: { version: "1.2.3" } },
      },
      treeProvider: {
        setClient(client: B2Client | null) {
          treeClients.push(client);
        },
      },
      tempFileManager: {},
      isAuthenticated: () => false,
      getClient: () => null,
      setClient,
      async createClient(
        credentials: { readonly keyId: string; readonly appKey: string },
        extensionVersion: string,
      ) {
        assert.deepStrictEqual(credentials, { keyId: "key-id", appKey: "app-key" });
        assert.strictEqual(extensionVersion, "1.2.3");
        return fakeClient;
      },
    } as unknown as CommandServices;

    try {
      const ui = await withWindowUiStubs({ inputValues: ["key-id", "app-key"] }, () =>
        authenticateCommand(services),
      );

      assert.deepStrictEqual(storedCredentials, [{ keyId: "key-id", appKey: "app-key" }]);
      assert.deepStrictEqual(scheduledClients, [fakeClient]);
      assert.deepStrictEqual(treeClients, [fakeClient]);
      assert.strictEqual(authStates.length, 1);
      assert.deepStrictEqual(ui.errors, []);
      assert.deepStrictEqual(ui.infos, ["B2: Authenticated as account-id"]);
    } finally {
      setClient(null);
    }
  });

  test("create folder times out stalled folder marker uploads", async () => {
    let refreshed = false;
    let uploadSignal: AbortSignal | undefined;
    const bucket = {
      name: "bucket",
      id: "bucket-id",
      info: { bucketType: "allPrivate" },
      async upload(options: { fileName: string; contentType?: string; signal?: AbortSignal }) {
        assert.strictEqual(options.fileName, "my-folder/.bzEmpty");
        assert.strictEqual(options.contentType, "application/x-bzEmpty");
        uploadSignal = options.signal;
        return new Promise(() => undefined);
      },
    };
    const item = new BucketTreeItem(
      bucket as unknown as ConstructorParameters<typeof BucketTreeItem>[0],
    );

    const ui = await withWindowUiStubs({ inputValues: ["my-folder"] }, () =>
      createFolderCommand(
        item,
        {
          getClient: () =>
            ({ accountInfo: { getAccountId: () => "account-id" } }) as unknown as B2Client,
          treeProvider: { refresh: () => (refreshed = true) },
        },
        { stallTimeoutMs: 20 },
      ),
    );

    assert.strictEqual(uploadSignal?.aborted, true);
    assert.strictEqual(refreshed, false);
    assert.deepStrictEqual(ui.infos, []);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /timed out/i);
  });

  test("create folder revalidates path-shaped names after input", async () => {
    for (const folderName of ["..", "bad\0name"]) {
      let uploadCalled = false;
      const bucket = {
        name: "bucket",
        id: "bucket-id",
        info: { bucketType: "allPrivate" },
        async upload() {
          uploadCalled = true;
          return undefined;
        },
      };
      const item = new BucketTreeItem(
        bucket as unknown as ConstructorParameters<typeof BucketTreeItem>[0],
      );

      const ui = await withWindowUiStubs({ inputValues: [folderName] }, () =>
        createFolderCommand(item, {
          getClient: () => ({}) as unknown as B2Client,
          treeProvider: { refresh: () => undefined },
        }),
      );

      assert.strictEqual(uploadCalled, false);
      assert.deepStrictEqual(ui.infos, []);
      assert.strictEqual(ui.errors.length, 1);
      assert.match(ui.errors[0] ?? "", /Folder name/);
    }
  });

  test("uploads picked files into the selected folder target", async () => {
    const root = tempDir();
    const filePath = path.join(root, "report.txt");
    fs.writeFileSync(filePath, "hello b2");
    const { bucket, calls, headSignals } = makeUploadBucket();
    const target = new FolderTreeItem(bucket, "incoming/");
    let refreshes = 0;

    const ui = await withWindowUiStubs(
      {
        openDialogValues: [[vscode.Uri.file(filePath)]],
      },
      () =>
        uploadFilesCommand(undefined, {
          getClient: () => ({}) as unknown as B2Client,
          getSelectedUploadTarget: () => target,
          treeProvider: { refresh: () => refreshes++ },
        }),
    );

    assert.deepStrictEqual(
      calls.map((call) => ({
        kind: call.kind,
        fileName: call.fileName,
        contentType: call.contentType,
        bytes: call.bytes,
      })),
      [
        {
          kind: "stream",
          fileName: "incoming/report.txt",
          contentType: B2_AUTO_CONTENT_TYPE,
          bytes: 8,
        },
      ],
    );
    assert.ok(calls[0]?.signal);
    assert.ok(headSignals[0]);
    assert.strictEqual(ui.openDialogs.length, 1);
    assert.strictEqual(
      ui.openDialogs[0]?.title,
      "Upload Files or Folders to b2://bucket/incoming/",
    );
    assert.strictEqual(ui.openDialogs[0]?.canSelectFiles, true);
    assert.strictEqual(ui.openDialogs[0]?.canSelectFolders, true);
    assert.strictEqual(ui.openDialogs[0]?.canSelectMany, true);
    assert.strictEqual(ui.progress.length, 1);
    assert.strictEqual(ui.progress[0]?.cancellable, true);
    assert.strictEqual(refreshes, 1);
    assert.deepStrictEqual(ui.errors, []);
  });

  test("title upload lets users choose a bucket when no tree target is selected", async () => {
    const root = tempDir();
    const filePath = path.join(root, "report.txt");
    fs.writeFileSync(filePath, "hello b2");
    const { bucket, calls } = makeUploadBucket();
    let refreshes = 0;
    const client = {
      async listBuckets() {
        return [bucket];
      },
    } as unknown as B2Client;

    const ui = await withWindowUiStubs(
      {
        quickPickLabels: ["bucket"],
        openDialogValues: [[vscode.Uri.file(filePath)]],
      },
      () =>
        uploadFilesCommand(undefined, {
          getClient: () => client,
          getSelectedUploadTarget: () => undefined,
          treeProvider: { refresh: () => refreshes++ },
        }),
    );

    assert.deepStrictEqual(ui.quickPicks[0]?.labels, ["bucket"]);
    assert.strictEqual(ui.quickPicks[0]?.options?.title, "Upload Destination");
    assert.strictEqual(ui.openDialogs[0]?.title, "Upload Files or Folders to b2://bucket");
    assert.deepStrictEqual(
      calls.map((call) => call.fileName),
      ["report.txt"],
    );
    assert.strictEqual(refreshes, 1);
    assert.deepStrictEqual(ui.errors, []);
  });

  test("uploads local folders recursively and preserves empty folders", async () => {
    const root = tempDir();
    const folderPath = path.join(root, "photos");
    fs.mkdirSync(path.join(folderPath, "nested"), { recursive: true });
    fs.mkdirSync(path.join(folderPath, "empty"));
    fs.writeFileSync(path.join(folderPath, "cover.txt"), "cover");
    fs.writeFileSync(path.join(folderPath, "nested", "raw.bin"), Buffer.from([1, 2, 3]));
    const { bucket, calls } = makeUploadBucket();
    const target = new BucketTreeItem(bucket);

    const ui = await withWindowUiStubs(
      {
        openDialogValues: [[vscode.Uri.file(folderPath)]],
      },
      () =>
        uploadFilesCommand(target, {
          getClient: () => ({}) as unknown as B2Client,
          treeProvider: { refresh: () => undefined },
        }),
    );

    assert.deepStrictEqual(
      calls.map((call) => ({
        kind: call.kind,
        fileName: call.fileName,
        contentType: call.contentType,
        bytes: call.bytes,
      })),
      [
        {
          kind: "stream",
          fileName: "photos/cover.txt",
          contentType: B2_AUTO_CONTENT_TYPE,
          bytes: 5,
        },
        {
          kind: "empty",
          fileName: "photos/empty/.bzEmpty",
          contentType: "application/x-bzEmpty",
          bytes: 0,
        },
        {
          kind: "stream",
          fileName: "photos/nested/raw.bin",
          contentType: B2_AUTO_CONTENT_TYPE,
          bytes: 3,
        },
      ],
    );
    assert.strictEqual(ui.openDialogs[0]?.title, "Upload Files or Folders to b2://bucket");
    assert.deepStrictEqual(ui.errors, []);
  });

  test("reports aggregate upload progress without double-counting entries", async () => {
    const root = tempDir();
    const firstPath = path.join(root, "a.txt");
    const secondPath = path.join(root, "b.txt");
    fs.writeFileSync(firstPath, "12345");
    fs.writeFileSync(secondPath, "abcde");
    const { bucket } = makeUploadBucket();
    const target = new BucketTreeItem(bucket);

    const ui = await withWindowUiStubs({}, () =>
      uploadLocalUrisToTarget(target, [vscode.Uri.file(firstPath), vscode.Uri.file(secondPath)], {
        getClient: () => ({}) as unknown as B2Client,
        treeProvider: { refresh: () => undefined },
      }),
    );
    const positiveProgressReports = ui.progressReports.filter(
      (report): report is { readonly message?: string; readonly increment: number } =>
        typeof report.increment === "number" && report.increment > 0,
    );

    assert.deepStrictEqual(
      positiveProgressReports.map((report) => report.increment),
      [50, 50],
    );
    assert.match(positiveProgressReports[0]?.message ?? "", /a\.txt/);
    assert.match(positiveProgressReports[1]?.message ?? "", /b\.txt/);
  });

  test("reports stable overwrite preflight check counters", async () => {
    const root = tempDir();
    const firstPath = path.join(root, "a.txt");
    const secondPath = path.join(root, "b.txt");
    fs.writeFileSync(firstPath, "12345");
    fs.writeFileSync(secondPath, "abcde");
    const { bucket } = makeUploadBucket();
    const target = new BucketTreeItem(bucket);

    const ui = await withWindowUiStubs({}, () =>
      uploadLocalUrisToTarget(target, [vscode.Uri.file(firstPath), vscode.Uri.file(secondPath)], {
        getClient: () => ({}) as unknown as B2Client,
        treeProvider: { refresh: () => undefined },
      }),
    );
    const checkCounters = ui.progressReports
      .map((report) => report.message?.match(/Checking for existing B2 files (\d+\/2):/u)?.[1])
      .filter((counter): counter is string => counter !== undefined);

    assert.deepStrictEqual(checkCounters, ["1/2", "2/2"]);
  });

  test("warns and cancels before overwriting existing B2 objects", async () => {
    const root = tempDir();
    const filePath = path.join(root, "report.txt");
    fs.writeFileSync(filePath, "hello b2");
    const { bucket, calls } = makeUploadBucket(["incoming/report.txt"]);
    const target = new FolderTreeItem(bucket, "incoming/");
    let refreshes = 0;

    const ui = await withWindowUiStubs(
      {
        openDialogValues: [[vscode.Uri.file(filePath)]],
      },
      () =>
        uploadFilesCommand(target, {
          getClient: () => ({}) as unknown as B2Client,
          treeProvider: { refresh: () => refreshes++ },
        }),
    );

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(ui.warnings.length, 1);
    assert.deepStrictEqual(ui.warnings[0]?.items, [OVERWRITE_UPLOAD_LABEL]);
    assert.match(ui.warnings[0]?.message ?? "", /incoming\/report\.txt/);
    assert.strictEqual(ui.progress.length, 1);
    assert.strictEqual(ui.progress[0]?.cancellable, true);
    assert.strictEqual(refreshes, 0);
  });

  test("sorts overwrite warning paths deterministically", async () => {
    const root = tempDir();
    const firstPath = path.join(root, "z.txt");
    const secondPath = path.join(root, "a.txt");
    fs.writeFileSync(firstPath, "first");
    fs.writeFileSync(secondPath, "second");
    const { bucket } = makeUploadBucket(["z.txt", "a.txt"]);
    const target = new BucketTreeItem(bucket);

    const ui = await withWindowUiStubs({}, () =>
      uploadLocalUrisToTarget(target, [vscode.Uri.file(firstPath), vscode.Uri.file(secondPath)], {
        getClient: () => ({}) as unknown as B2Client,
        treeProvider: { refresh: () => undefined },
      }),
    );

    assert.match(ui.warnings[0]?.message ?? "", /\("a\.txt", "z\.txt"\)/);
  });

  test("warns and refreshes when canceling an in-flight zero-byte file upload", async () => {
    const root = tempDir();
    const filePath = path.join(root, "empty.txt");
    fs.writeFileSync(filePath, "");
    const tokenSource = new vscode.CancellationTokenSource();
    const bucket = makeCancellationAmbiguousBucket(() => {
      setImmediate(() => tokenSource.cancel());
    });
    const target = new BucketTreeItem(bucket);
    let refreshes = 0;

    try {
      const ui = await withWindowUiStubs({}, () =>
        uploadLocalUrisToTarget(
          target,
          [vscode.Uri.file(filePath)],
          {
            getClient: () => ({}) as unknown as B2Client,
            treeProvider: { refresh: () => refreshes++ },
          },
          tokenSource.token,
        ),
      );

      assert.strictEqual(refreshes, 1);
      assert.strictEqual(ui.warnings.length, 1);
      assert.match(ui.warnings[0]?.message ?? "", /empty\.txt/);
      assert.match(ui.warnings[0]?.message ?? "", /may have been uploaded/i);
      assert.deepStrictEqual(ui.errors, []);
    } finally {
      tokenSource.dispose();
    }
  });

  test("warns and refreshes when canceling an in-flight empty-folder marker upload", async () => {
    const root = tempDir();
    const folderPath = path.join(root, "empty-folder");
    fs.mkdirSync(folderPath);
    const tokenSource = new vscode.CancellationTokenSource();
    const bucket = makeCancellationAmbiguousBucket(() => {
      setImmediate(() => tokenSource.cancel());
    });
    const target = new BucketTreeItem(bucket);
    let refreshes = 0;

    try {
      const ui = await withWindowUiStubs({}, () =>
        uploadLocalUrisToTarget(
          target,
          [vscode.Uri.file(folderPath)],
          {
            getClient: () => ({}) as unknown as B2Client,
            treeProvider: { refresh: () => refreshes++ },
          },
          tokenSource.token,
        ),
      );

      assert.strictEqual(refreshes, 1);
      assert.strictEqual(ui.warnings.length, 1);
      assert.match(ui.warnings[0]?.message ?? "", /empty-folder\/\.bzEmpty/);
      assert.match(ui.warnings[0]?.message ?? "", /may have been uploaded/i);
      assert.deepStrictEqual(ui.errors, []);
    } finally {
      tokenSource.dispose();
    }
  });

  test("classifies public mutation failures by certainty", () => {
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(
        classifyError({ status: 400, code: "bad_json", message: "" }),
      ),
      false,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(new SyntaxError("Unexpected end of JSON")),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(new Error("truncated JSON response")),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({
        code: "ERR_INVALID_JSON",
        message: "truncated JSON response",
      }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(new Error("The operation was aborted")),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({
        name: "AbortError",
        message: "The operation was aborted",
      }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({ code: "ECONNRESET", message: "socket hang up" }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({
        code: "ECONNREFUSED",
        message: "connect ECONNREFUSED",
      }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({
        code: "EAI_AGAIN",
        message: "getaddrinfo EAI_AGAIN",
      }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({ code: "EPIPE", message: "broken pipe" }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({
        code: "UND_ERR_CONNECT_TIMEOUT",
        message: "connect timeout",
      }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({
        code: "UND_ERR_HEADERS_TIMEOUT",
        message: "Headers Timeout Error",
      }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({
        code: "bad_request",
        message: "bucket name contains aborted",
      }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(
        classifyError({ status: 400, code: "duplicate_bucket_name", message: "duplicate" }),
      ),
      false,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(
        classifyError({ status: 409, code: "conflict", message: "revision mismatch" }),
      ),
      false,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(
        classifyError({ status: 400, code: "bad_request", message: "malformed bucket name" }),
      ),
      false,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(
        classifyError({ status: 403, code: "access_denied", message: "denied" }),
      ),
      false,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({ code: "access_denied", message: "denied" }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({
        code: "duplicate_bucket_name",
        message: "duplicate",
      }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({ code: "conflict", message: "revision mismatch" }),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous({ name: "B2SsrfError", message: "blocked" }),
      false,
    );
    assert.strictEqual(isPostRequestB2MutationStateAmbiguous(new Error("opaque failure")), true);
  });
});

suite("B2 public bucket command safety", () => {
  test("creates a private bucket without a public access warning", async () => {
    const { client, calls } = makeCreateBucketClient();
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["private-bucket"],
        quickPickLabels: [PRIVATE_VISIBILITY_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.deepStrictEqual(calls.map(createBucketRequestWithoutSignal), [
      { bucketName: "private-bucket", bucketType: "allPrivate" },
    ]);
    assertAbortSignalIsEnumerable(calls[0] ?? {});
    assert.strictEqual(ui.warnings.length, 0);
    assert.strictEqual(ui.inputs.length, 1);
    assert.strictEqual(ui.progress.length, 1);
    assert.strictEqual(ui.progress[0]?.cancellable, false);
    assert.match(ui.progress[0]?.title ?? "", /Creating B2 bucket/);
    assert.strictEqual(commandServices.refreshCount(), 1);
  });

  test("creates a public bucket only after modal and typed confirmation", async () => {
    const { client, calls } = makeCreateBucketClient();
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.deepStrictEqual(calls.map(createBucketRequestWithoutSignal), [
      { bucketName: "public-bucket", bucketType: "allPublic" },
    ]);
    assertAbortSignalIsEnumerable(calls[0] ?? {});
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.warnings[0]?.options?.modal, true);
    assert.deepStrictEqual(ui.warnings[0]?.items, [CONFIRM_PUBLIC_BUCKET_LABEL]);
    assert.match(ui.warnings[0]?.message ?? "", /accessible without authorization/);
    assert.strictEqual(ui.inputs.length, 2);
    assert.match(ui.inputs[1]?.prompt ?? "", /Type "public-bucket"/);
    assert.strictEqual(ui.progress.length, 1);
    assert.strictEqual(ui.progress[0]?.cancellable, false);
    assert.strictEqual(commandServices.refreshCount(), 1);
  });

  test("revalidates bucket names after input returns", async () => {
    const { client, calls } = makeCreateBucketClient();
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["bad name"],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(ui.quickPicks.length, 0);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Bucket name can only contain/);
  });

  test("times out stalled private bucket creation", async () => {
    const { client, calls } = makeCreateBucketClient(
      () => new Promise<CreateBucketResult>(() => undefined),
    );
    const commandServices = makeCommandServices(client, {
      bucketMutationTimeoutMs: 5,
      bucketMutationPostTimeoutSettleMs: 0,
    });

    const ui = await withWindowUiStubs(
      {
        inputValues: ["private-bucket"],
        quickPickLabels: [PRIVATE_VISIBILITY_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.signal?.aborted, true);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 0);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /timed out/i);
  });

  test("keeps timeout error when aborted bucket creation rejects during settle", async () => {
    const { client, calls } = makeCreateBucketClient(
      (options) =>
        new Promise<CreateBucketResult>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const commandServices = makeCommandServices(client, {
      bucketMutationTimeoutMs: 5,
      bucketMutationPostTimeoutSettleMs: 100,
    });

    const ui = await withWindowUiStubs(
      {
        inputValues: ["private-bucket"],
        quickPickLabels: [PRIVATE_VISIBILITY_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.signal?.aborted, true);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /timed out/i);
    assert.doesNotMatch(ui.errors[0] ?? "", /aborted/i);
  });

  test("does not create a public bucket when typed confirmation name mismatches", async () => {
    const { client, calls } = makeCreateBucketClient();
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "wrong-name"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.inputs.length, 2);
    assert.strictEqual(ui.progress.length, 0);
    assert.strictEqual(ui.infos.length, 0);
    assert.strictEqual(commandServices.refreshCount(), 0);
  });

  test("does not create a public bucket when typed confirmation is dismissed", async () => {
    const { client, calls } = makeCreateBucketClient();
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", undefined],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.inputs.length, 2);
    assert.strictEqual(ui.progress.length, 0);
    assert.strictEqual(ui.infos.length, 0);
    assert.strictEqual(commandServices.refreshCount(), 0);
  });

  test("does not accept empty public bucket typed confirmation", async () => {
    assert.strictEqual(isPublicBucketNameConfirmationAccepted("", ""), false);

    const { item, updates } = makeBucketTreeItem("", "allPrivate");
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: [""],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates, []);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.inputs.length, 1);
    assert.strictEqual(ui.progress.length, 0);
    assert.strictEqual(commandServices.refreshCount(), 0);
  });

  test("changes a private bucket to public only after explicit confirmation", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate");
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public"],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates.map(updateBucketRequestWithoutSignal), [
      { bucketType: "allPublic", ifRevisionIs: 7 },
    ]);
    assertAbortSignalIsEnumerable(updates[0] ?? {});
    assert.strictEqual(ui.warnings.length, 1);
    assert.match(ui.warnings[0]?.message ?? "", /accessible without authorization/);
    assert.strictEqual(ui.inputs.length, 1);
    assert.strictEqual(ui.progress.length, 1);
    assert.strictEqual(ui.progress[0]?.cancellable, false);
    assert.match(ui.progress[0]?.title ?? "", /Changing "photos-public" to Public/);
    assert.strictEqual(commandServices.refreshCount(), 1);
  });

  test("does not change a private bucket to public when typed confirmation is cancelled", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate");
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: [undefined],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates, []);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.inputs.length, 1);
    assert.strictEqual(ui.progress.length, 0);
    assert.strictEqual(ui.infos.length, 0);
    assert.strictEqual(commandServices.refreshCount(), 0);
  });

  test("does not change a private bucket to public when typed confirmation mismatches", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate");
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public "],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates, []);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.inputs.length, 1);
    assert.strictEqual(ui.progress.length, 0);
    assert.strictEqual(ui.infos.length, 0);
    assert.strictEqual(commandServices.refreshCount(), 0);
  });

  test("changes a public bucket to private without a public access warning", async () => {
    const { item, updates } = makeBucketTreeItem("photos-private", "allPublic");
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        quickPickLabels: [CONFIRM_PRIVATE_VISIBILITY_LABEL],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates.map(updateBucketRequestWithoutSignal), [
      { bucketType: "allPrivate", ifRevisionIs: 7 },
    ]);
    assertAbortSignalIsEnumerable(updates[0] ?? {});
    assert.strictEqual(ui.warnings.length, 0);
    assert.strictEqual(ui.inputs.length, 0);
    assert.strictEqual(ui.progress.length, 1);
    assert.strictEqual(ui.progress[0]?.cancellable, false);
    assert.strictEqual(commandServices.refreshCount(), 1);
  });

  test("rejects unsupported bucket types before offering a visibility toggle", async () => {
    const { item, updates } = makeBucketTreeItem("snapshot-bucket", "snapshot");
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs({}, () =>
      changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates, []);
    assert.strictEqual(ui.quickPicks.length, 0);
    assert.strictEqual(ui.progress.length, 0);
    assert.match(ui.errors[0] ?? "", /cannot be changed/i);
  });

  test("refreshes when visibility update hits a revision conflict", async () => {
    const { item, updates } = makeBucketTreeItem("photos-private", "allPublic", async () => {
      throw classifyError({ status: 409, code: "conflict", message: "revision mismatch" });
    });
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        quickPickLabels: [CONFIRM_PRIVATE_VISIBILITY_LABEL],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates.map(updateBucketRequestWithoutSignal), [
      { bucketType: "allPrivate", ifRevisionIs: 7 },
    ]);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 0);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Failed to update bucket/);
  });

  test("cancels public bucket creation when the warning is dismissed", async () => {
    const { client, calls } = makeCreateBucketClient();
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [undefined],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.inputs.length, 1);
    assert.strictEqual(ui.progress.length, 0);
    assert.strictEqual(commandServices.refreshCount(), 0);
  });

  test("shows an error when bucket creation fails", async () => {
    const { client, calls } = makeCreateBucketClient(async () => {
      throw new Error("duplicate bucket");
    });
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["private-bucket"],
        quickPickLabels: [PRIVATE_VISIBILITY_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.progress.length, 1);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Failed to create bucket/);
    assert.match(ui.errors[0] ?? "", /Unexpected error/);
  });

  test("refreshes and warns when public bucket creation has unknown state", async () => {
    const { client, calls } = makeCreateBucketClient(async () => {
      throw new NetworkError("fetch failed");
    });
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[1]?.message ?? "", /may have been created as public/);
    assert.strictEqual(ui.warnings[1]?.options?.modal, true);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket creation/);
  });

  test("refreshes and warns for no-status B2-looking public create failures", async () => {
    for (const code of ["access_denied", "duplicate_bucket_name", "conflict", "bad_request"]) {
      const { client, calls } = makeCreateBucketClient(async () => {
        throw Object.assign(new Error(`${code} without status`), { code });
      });
      const commandServices = makeCommandServices(client);

      const ui = await withWindowUiStubs(
        {
          inputValues: ["public-bucket", "public-bucket"],
          quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
          warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
        },
        () => createBucketCommand(commandServices.services),
      );

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(commandServices.refreshCount(), 1);
      assert.strictEqual(ui.warnings.length, 2);
      assert.match(ui.warnings[1]?.message ?? "", /may have been created as public/);
      assert.match(ui.errors[0] ?? "", /Could not confirm public bucket creation/);
    }
  });

  test("refreshes and warns when public bucket creation fails ambiguously without keywords", async () => {
    const { client, calls } = makeCreateBucketClient(async () => {
      throw new Error("The operation was aborted");
    });
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[1]?.message ?? "", /may have been created as public/);
    assert.strictEqual(ui.warnings[1]?.options?.modal, true);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket creation/);
  });

  test("does not warn when public bucket creation gets definitive bad_json status", async () => {
    const { client, calls } = makeCreateBucketClient(async () => {
      throw classifyError({ status: 400, code: "bad_json", message: "malformed body" });
    });
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 0);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Failed to create bucket/);
  });

  test("does not warn when public bucket creation gets duplicate-name status", async () => {
    const { client, calls } = makeCreateBucketClient(async () => {
      throw classifyError({
        status: 400,
        code: "duplicate_bucket_name",
        message: "already exists",
      });
    });
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 0);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Failed to create bucket/);
  });

  test("refreshes and warns when public bucket creation times out", async () => {
    const { client, calls } = makeCreateBucketClient(
      () => new Promise<CreateBucketResult>(() => undefined),
    );
    const commandServices = makeCommandServices(client, {
      bucketMutationTimeoutMs: 5,
      bucketMutationPostTimeoutSettleMs: 0,
    });

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.errors[0] ?? "", /timed out/i);
  });

  test("refreshes success when public bucket creation settles after timeout", async () => {
    const { client, calls } = makeCreateBucketClient(
      () =>
        new Promise<CreateBucketResult>((resolve) => {
          setTimeout(() => {
            resolve({ name: "public-bucket" } as CreateBucketResult);
          }, 150);
        }),
    );
    const commandServices = makeCommandServices(client, {
      bucketMutationTimeoutMs: 50,
      bucketMutationPostTimeoutSettleMs: 1_000,
    });

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.errors.length, 0);
    assert.strictEqual(ui.infos.length, 1);
  });

  test("does not show unknown-state warning for definitive public create failures", async () => {
    const { client, calls } = makeCreateBucketClient(async () => {
      throw classifyError({ status: 403, code: "access_denied", message: "denied" });
    });
    const commandServices = makeCommandServices(client);

    const ui = await withWindowUiStubs(
      {
        inputValues: ["public-bucket", "public-bucket"],
        quickPickLabels: [PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => createBucketCommand(commandServices.services),
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 0);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Failed to create bucket/);
  });

  test("refreshes and warns when public visibility update has unknown state", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate", async () => {
      throw new NetworkError("fetch failed");
    });
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public"],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
    assert.strictEqual(ui.warnings[1]?.options?.modal, true);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket visibility change/);
    assert.match(ui.errors[0] ?? "", /Network connection to B2 failed/);
  });

  test("refreshes and warns for no-status B2-looking public visibility failures", async () => {
    for (const code of ["access_denied", "duplicate_bucket_name", "conflict", "bad_request"]) {
      const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate", async () => {
        throw Object.assign(new Error(`${code} without status`), { code });
      });
      const commandServices = makeCommandServices({});

      const ui = await withWindowUiStubs(
        {
          inputValues: ["photos-public"],
          quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
          warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
        },
        () => changeBucketVisibilityCommand(commandServices.services, item),
      );

      assert.strictEqual(updates.length, 1);
      assert.strictEqual(commandServices.refreshCount(), 1);
      assert.strictEqual(ui.warnings.length, 2);
      assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
      assert.match(ui.errors[0] ?? "", /Could not confirm public bucket visibility change/);
    }
  });

  test("uses bucket revision as an optimistic lock and refreshes on conflict", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate", async () => {
      throw classifyError({ status: 409, code: "conflict", message: "revision mismatch" });
    });
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public"],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates.map(updateBucketRequestWithoutSignal), [
      { bucketType: "allPublic", ifRevisionIs: 7 },
    ]);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 1);
    assert.match(ui.errors[0] ?? "", /Failed to update bucket/);
  });

  test("does not update bucket visibility without a revision", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate");
    const commandServices = makeCommandServices({});
    const itemWithoutRevision: BucketVisibilityItem = {
      ...item,
      bucket: {
        ...item.bucket,
        info: {},
      },
    };

    const ui = await withWindowUiStubs(
      {
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
      },
      () => changeBucketVisibilityCommand(commandServices.services, itemWithoutRevision),
    );

    assert.deepStrictEqual(updates, []);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.quickPicks.length, 0);
    assert.match(ui.errors[0] ?? "", /missing a revision/i);
  });

  test("refreshes and warns when public visibility update times out", async () => {
    const { item, updates } = makeBucketTreeItem(
      "photos-public",
      "allPrivate",
      () => new Promise<UpdateBucketResult>(() => undefined),
    );
    const commandServices = makeCommandServices(
      {},
      {
        bucketMutationTimeoutMs: 5,
        bucketMutationPostTimeoutSettleMs: 0,
      },
    );

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public"],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates.map(updateBucketRequestWithoutSignal), [
      { bucketType: "allPublic", ifRevisionIs: 7 },
    ]);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.errors[0] ?? "", /timed out/i);
  });

  test("refreshes and warns when public-to-private visibility update times out", async () => {
    const { item, updates } = makeBucketTreeItem(
      "photos-public",
      "allPublic",
      () => new Promise<UpdateBucketResult>(() => undefined),
    );
    const commandServices = makeCommandServices(
      {},
      {
        bucketMutationTimeoutMs: 5,
        bucketMutationPostTimeoutSettleMs: 0,
      },
    );

    const ui = await withWindowUiStubs(
      {
        quickPickLabels: [CONFIRM_PRIVATE_VISIBILITY_LABEL],
        warningValues: [undefined],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates.map(updateBucketRequestWithoutSignal), [
      { bucketType: "allPrivate", ifRevisionIs: 7 },
    ]);
    assert.strictEqual(updates[0]?.signal?.aborted, true);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 1);
    assert.match(ui.warnings[0]?.message ?? "", /to private completed/);
    assert.doesNotMatch(ui.warnings[0]?.message ?? "", /to public completed/);
    assert.match(ui.warnings[0]?.message ?? "", /may remain public/);
    assert.match(ui.errors[0] ?? "", /timed out/i);
  });

  test("refreshes and warns when public-to-private update hits transport failure", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPublic", async () => {
      throw Object.assign(new Error("Headers Timeout Error"), {
        code: "UND_ERR_HEADERS_TIMEOUT",
      });
    });
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        quickPickLabels: [CONFIRM_PRIVATE_VISIBILITY_LABEL],
        warningValues: [undefined],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates.map(updateBucketRequestWithoutSignal), [
      { bucketType: "allPrivate", ifRevisionIs: 7 },
    ]);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 1);
    assert.match(ui.warnings[0]?.message ?? "", /to private completed/);
    assert.doesNotMatch(ui.warnings[0]?.message ?? "", /to public completed/);
    assert.match(ui.warnings[0]?.message ?? "", /may remain public/);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket visibility change/);
  });

  test("refreshes and warns when public visibility update fails ambiguously without keywords", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate", async () => {
      throw new Error("The operation was aborted");
    });
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public"],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
    assert.strictEqual(ui.warnings[1]?.options?.modal, true);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket visibility change/);
  });

  test("refreshes and warns when public visibility update gets malformed response", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate", async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    });
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public"],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
    assert.strictEqual(ui.warnings[1]?.options?.modal, true);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /could not parse/);
  });

  test("does not show unknown-state warning for definitive visibility update failures", async () => {
    const { item, updates } = makeBucketTreeItem("photos-public", "allPrivate", async () => {
      throw classifyError({ status: 403, code: "access_denied", message: "denied" });
    });
    const commandServices = makeCommandServices({});

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public"],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(commandServices.refreshCount(), 0);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Failed to update bucket/);
  });
});
