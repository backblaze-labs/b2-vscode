/**
 * Tests for command error message construction.
 *
 * @module test/suite/commands
 */

import * as assert from "assert";
import * as vscode from "vscode";
import {
  B2Client,
  classifyError,
  NetworkError,
  type Bucket,
  type BucketType,
} from "@backblaze-labs/b2-sdk";
import {
  type BucketCreationClient,
  type BucketCommandServices,
  type BucketVisibilityItem,
  buildCommandErrorMessage,
  changeBucketVisibilityCommand,
  createBucketCommand,
  openFileCommand,
} from "../../commands";
import {
  CONFIRM_PUBLIC_BUCKET_LABEL,
  isPublicBucketNameConfirmationAccepted,
} from "../../commands/publicBucketVisibility";
import { B2PartialFailureError, isPostRequestB2MutationStateAmbiguous } from "../../errors";
import type { FileTreeItem } from "../../models/fileTreeItem";
import type { TempFileManager } from "../../services/tempFileManager";
import { withWindowUiStubs } from "./windowStubs";

type CreateBucketOptions = Parameters<B2Client["createBucket"]>[0];
type CreateBucketResult = Awaited<ReturnType<B2Client["createBucket"]>>;
type UpdateBucketOptions = Parameters<Bucket["update"]>[0];
type UpdateBucketResult = Awaited<ReturnType<Bucket["update"]>>;

const PRIVATE_VISIBILITY_LABEL = "Private";
const PUBLIC_VISIBILITY_LABEL = "Public";
const CONFIRM_PUBLIC_VISIBILITY_LABEL = "Change to Public";
const CONFIRM_PRIVATE_VISIBILITY_LABEL = "Change to Private";

function makeCommandServices<TClient>(
  client: TClient | null,
  options: Pick<BucketCommandServices, "publicBucketMutationTimeoutMs"> = {},
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
    getClient: () => client,
    ...options,
  };

  return {
    services,
    refreshCount: () => refreshes,
  };
}

function makeCreateBucketClient(
  implementation?: (options: CreateBucketOptions) => Promise<CreateBucketResult>,
): { readonly client: BucketCreationClient; readonly calls: CreateBucketOptions[] } {
  const calls: CreateBucketOptions[] = [];
  const client = {
    async createBucket(options: CreateBucketOptions): Promise<CreateBucketResult> {
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
  implementation?: (options: UpdateBucketOptions) => Promise<UpdateBucketResult>,
): { readonly item: BucketVisibilityItem; readonly updates: UpdateBucketOptions[] } {
  const updates: UpdateBucketOptions[] = [];
  const bucket = {
    info: { bucketType, revision: 7 },
    async update(options: UpdateBucketOptions): Promise<UpdateBucketResult> {
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

  test("treats malformed mutation responses as ambiguous", () => {
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(
        classifyError({ status: 400, code: "bad_json", message: "" }),
      ),
      true,
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
      isPostRequestB2MutationStateAmbiguous(new Error("The operation was aborted")),
      true,
    );
    assert.strictEqual(
      isPostRequestB2MutationStateAmbiguous(
        classifyError({ status: 400, code: "duplicate_bucket_name", message: "duplicate" }),
      ),
      true,
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
      isPostRequestB2MutationStateAmbiguous({ name: "B2SsrfError", message: "blocked" }),
      false,
    );
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

    assert.deepStrictEqual(calls, [{ bucketName: "private-bucket", bucketType: "allPrivate" }]);
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

    assert.deepStrictEqual(calls, [{ bucketName: "public-bucket", bucketType: "allPublic" }]);
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

    assert.deepStrictEqual(updates, [{ bucketType: "allPublic", ifRevisionIs: 7 }]);
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

    assert.deepStrictEqual(updates, [{ bucketType: "allPrivate", ifRevisionIs: 7 }]);
    assert.strictEqual(ui.warnings.length, 0);
    assert.strictEqual(ui.inputs.length, 0);
    assert.strictEqual(ui.progress.length, 1);
    assert.strictEqual(ui.progress[0]?.cancellable, false);
    assert.strictEqual(commandServices.refreshCount(), 1);
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

    assert.deepStrictEqual(updates, [{ bucketType: "allPrivate", ifRevisionIs: 7 }]);
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
    assert.strictEqual(commandServices.refreshCount(), 0);
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
    assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
    assert.strictEqual(ui.warnings[1]?.options?.modal, true);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket creation/);
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
    assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
    assert.strictEqual(ui.warnings[1]?.options?.modal, true);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket creation/);
  });

  test("refreshes and warns when public bucket creation gets malformed response", async () => {
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
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
    assert.strictEqual(ui.warnings[1]?.options?.modal, true);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /could not parse/);
  });

  test("refreshes and warns when public bucket creation gets duplicate-name status", async () => {
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
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket creation/);
  });

  test("refreshes and warns when public bucket creation times out", async () => {
    const { client, calls } = makeCreateBucketClient(
      () => new Promise<CreateBucketResult>(() => undefined),
    );
    const commandServices = makeCommandServices(client, { publicBucketMutationTimeoutMs: 5 });

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

  test("uses bucket revision as an optimistic lock for public visibility updates", async () => {
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

    assert.deepStrictEqual(updates, [{ bucketType: "allPublic", ifRevisionIs: 7 }]);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[1]?.message ?? "", /may already be public/);
    assert.match(ui.errors[0] ?? "", /Could not confirm public bucket visibility change/);
  });

  test("refreshes and warns when public visibility update times out", async () => {
    const { item, updates } = makeBucketTreeItem(
      "photos-public",
      "allPrivate",
      () => new Promise<UpdateBucketResult>(() => undefined),
    );
    const commandServices = makeCommandServices({}, { publicBucketMutationTimeoutMs: 5 });

    const ui = await withWindowUiStubs(
      {
        inputValues: ["photos-public"],
        quickPickLabels: [CONFIRM_PUBLIC_VISIBILITY_LABEL],
        warningValues: [CONFIRM_PUBLIC_BUCKET_LABEL, undefined],
      },
      () => changeBucketVisibilityCommand(commandServices.services, item),
    );

    assert.deepStrictEqual(updates, [{ bucketType: "allPublic", ifRevisionIs: 7 }]);
    assert.strictEqual(commandServices.refreshCount(), 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.errors[0] ?? "", /timed out/i);
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
