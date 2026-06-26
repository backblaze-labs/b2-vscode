/**
 * Tests for B2 application key tree and command flows.
 *
 * @module test/suite/applicationKeys
 */

import * as assert from "assert";
import {
  Capability,
  accountId,
  applicationKeyId,
  bucketId,
  type ApplicationKey,
  type B2Client,
  type Bucket,
  type FullApplicationKey,
} from "@backblaze-labs/b2-sdk";
import { createKeyCommand, deleteKeyCommand } from "../../commands/applicationKeys";
import {
  ApplicationKeyTreeItem,
  formatApplicationKeyExpiry,
  formatApplicationKeyScope,
} from "../../models/applicationKeyTreeItem";
import { ApplicationKeyListLimitTreeItem } from "../../models/applicationKeyListLimitTreeItem";
import {
  APPLICATION_KEY_TREE_HARD_CAP,
  ApplicationKeysProvider,
} from "../../providers/applicationKeysProvider";
import type { AuthService } from "../../services/authService";
import { withWindowUiStubs } from "./windowStubs";

type CreateKeyOptions = Parameters<B2Client["createKey"]>[0];

function fakeAuthService(): AuthService {
  return {
    onAuthStateChanged() {
      return { dispose() {} };
    },
  } as unknown as AuthService;
}

function makeKey(overrides: Partial<ApplicationKey> = {}): ApplicationKey {
  return {
    accountId: accountId("account-id"),
    applicationKeyId: applicationKeyId("key-id"),
    bucketId: null,
    capabilities: [Capability.ReadFiles],
    expirationTimestamp: null,
    keyName: "key-name",
    namePrefix: null,
    options: [],
    ...overrides,
  };
}

function makeFullKey(overrides: Partial<FullApplicationKey> = {}): FullApplicationKey {
  return {
    ...makeKey(),
    applicationKey: "secret-value",
    ...overrides,
  };
}

function makeBucket(name: string, id: string): Bucket {
  return {
    id: bucketId(id),
    name,
    info: { bucketType: "allPrivate" },
  } as unknown as Bucket;
}

function warningSecretOccurrences(warning: string, secret: string): number {
  return warning.split(secret).length - 1;
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

suite("B2 application key tree", () => {
  test("formats key capabilities, scope, and expiry in tree metadata", () => {
    const expiresAt = Date.UTC(2026, 0, 2, 3, 4, 5);
    const key = makeKey({
      bucketId: bucketId("bucket-id"),
      capabilities: [Capability.ListFiles, Capability.ReadFiles],
      expirationTimestamp: expiresAt,
      namePrefix: "uploads/",
    });

    const item = new ApplicationKeyTreeItem(key);

    assert.strictEqual(item.label, "key-name");
    assert.match(String(item.description), /listFiles, readFiles/);
    assert.match(String(item.description), /bucket bucket-id, prefix "uploads\/"/);
    assert.match(String(item.description), /expires 2026-01-02T03:04:05.000Z/);
    assert.strictEqual(formatApplicationKeyScope(makeKey()), "all buckets");
    assert.strictEqual(formatApplicationKeyExpiry(null), "never expires");
  });

  test("lists application keys from the SDK paginator", async () => {
    const keys = [
      makeKey({ applicationKeyId: applicationKeyId("key-1"), keyName: "first-key" }),
      makeKey({ applicationKeyId: applicationKeyId("key-2"), keyName: "second-key" }),
    ];
    const client = {
      accountInfo: { getAccountId: () => "account-id" },
      async *paginateKeys() {
        yield* keys;
      },
    } as unknown as B2Client;
    const provider = new ApplicationKeysProvider(fakeAuthService());
    provider.setClient(client);

    const children = await provider.getChildren();

    assert.deepStrictEqual(
      children.map((child) => child.label),
      ["first-key", "second-key"],
    );
  });

  test("caps endless application key listings without draining the paginator", async () => {
    let yielded = 0;
    const client = {
      accountInfo: { getAccountId: () => "account-id" },
      async *paginateKeys({ signal }: { readonly signal?: AbortSignal } = {}) {
        while (true) {
          signal?.throwIfAborted();
          yielded++;
          yield makeKey({
            applicationKeyId: applicationKeyId(`key-${yielded}`),
            keyName: `key-${yielded}`,
          });
        }
      },
    } as unknown as B2Client;
    const provider = new ApplicationKeysProvider(fakeAuthService());
    provider.setClient(client);

    const children = await provider.getChildren();

    assert.strictEqual(yielded, APPLICATION_KEY_TREE_HARD_CAP + 1);
    assert.strictEqual(children.length, APPLICATION_KEY_TREE_HARD_CAP + 1);
    assert.ok(children[APPLICATION_KEY_TREE_HARD_CAP] instanceof ApplicationKeyListLimitTreeItem);
  });

  test("times out slow application key listings", async () => {
    const client = {
      accountInfo: { getAccountId: () => "account-id" },
      async *paginateKeys() {
        await new Promise(() => undefined);
      },
    } as unknown as B2Client;
    const provider = new ApplicationKeysProvider(fakeAuthService(), { listTimeoutMs: 5 });
    provider.setClient(client);

    const ui = await withWindowUiStubs({}, async () => {
      const children = await provider.getChildren();
      assert.deepStrictEqual(children, []);
    });

    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /timed out/i);
  });

  test("drops stale application key results after client changes", async () => {
    const releaseListing = deferred();
    const oldClient = {
      accountInfo: { getAccountId: () => "old-account-id" },
      async *paginateKeys() {
        await releaseListing.promise;
        yield makeKey({ keyName: "old-key" });
      },
    } as unknown as B2Client;
    const newClient = {
      accountInfo: { getAccountId: () => "new-account-id" },
      async *paginateKeys() {
        yield makeKey({ keyName: "new-key" });
      },
    } as unknown as B2Client;
    const provider = new ApplicationKeysProvider(fakeAuthService());
    provider.setClient(oldClient);

    const oldLoad = provider.getChildren();
    provider.setClient(newClient);
    releaseListing.resolve(undefined);
    const oldChildren = await oldLoad;
    const newChildren = await provider.getChildren();

    assert.deepStrictEqual(oldChildren, []);
    assert.deepStrictEqual(
      newChildren.map((child) => child.label),
      ["new-key"],
    );
  });

  test("suppresses stale application key listing errors after refresh", async () => {
    const releaseListing = deferred();
    const client = {
      accountInfo: { getAccountId: () => "account-id" },
      async *paginateKeys() {
        await releaseListing.promise;
        throw new Error("stale listing failure");
      },
    } as unknown as B2Client;
    const provider = new ApplicationKeysProvider(fakeAuthService());
    provider.setClient(client);

    const ui = await withWindowUiStubs({}, async () => {
      const load = provider.getChildren();
      provider.refresh();
      releaseListing.resolve(undefined);
      const children = await load;
      assert.deepStrictEqual(children, []);
    });

    assert.deepStrictEqual(ui.errors, []);
  });
});

suite("B2 application key commands", () => {
  test("creates a scoped key and preserves prefix spaces", async () => {
    const bucket = makeBucket("photos", "bucket-id");
    const createCalls: CreateKeyOptions[] = [];
    let refreshes = 0;
    const client = {
      async listBuckets() {
        return [bucket];
      },
      async createKey(options: CreateKeyOptions) {
        createCalls.push(options);
        return makeFullKey({
          applicationKeyId: applicationKeyId("new-key-id"),
          bucketId: options.bucketId ?? null,
          capabilities: options.capabilities,
          expirationTimestamp: Date.UTC(2026, 0, 1),
          keyName: options.keyName,
          namePrefix: options.namePrefix ?? null,
        });
      },
      async deleteKey() {
        return makeKey();
      },
    };

    const ui = await withWindowUiStubs(
      {
        inputValues: ["scoped-key", " uploads/ "],
        quickPickLabels: ["readFiles, writeFiles", "photos", "1 day"],
        warningValues: ["Close"],
      },
      () =>
        createKeyCommand({
          getClient: () => client,
          viewProviders: { refresh: () => refreshes++ },
        }),
    );

    assert.deepStrictEqual(createCalls, [
      {
        bucketId: bucketId("bucket-id"),
        capabilities: [Capability.ReadFiles, Capability.WriteFiles],
        keyName: "scoped-key",
        namePrefix: " uploads/ ",
        validDurationInSeconds: 24 * 60 * 60,
      },
    ]);
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(ui.progress.length, 1);
    assert.match(ui.progress[0]?.title ?? "", /Creating application key "scoped-key"/);
    assert.strictEqual(ui.warnings.length, 1);
    assert.deepStrictEqual(ui.warnings[0]?.items, ["Copy Secret", "Close"]);
    assert.strictEqual(warningSecretOccurrences(ui.warnings[0]?.message ?? "", "secret-value"), 1);
    assert.match(ui.warnings[0]?.message ?? "", /shown only once/i);
  });

  test("warns about unknown state when key creation times out", async () => {
    const bucket = makeBucket("photos", "bucket-id");
    const createCalls: CreateKeyOptions[] = [];
    let refreshes = 0;
    const client = {
      async listBuckets() {
        return [bucket];
      },
      async createKey(options: CreateKeyOptions) {
        createCalls.push(options);
        return new Promise<FullApplicationKey>(() => undefined);
      },
      async deleteKey() {
        return makeKey();
      },
    };

    const ui = await withWindowUiStubs(
      {
        inputValues: ["timeout-key", "uploads/"],
        quickPickLabels: ["readFiles", "photos", "1 hour"],
      },
      () =>
        createKeyCommand({
          getClient: () => client,
          viewProviders: { refresh: () => refreshes++ },
          applicationKeyMutationTimeoutMs: 5,
          applicationKeyMutationPostTimeoutSettleMs: 0,
        }),
    );

    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(ui.warnings.length, 1);
    assert.match(ui.warnings[0]?.message ?? "", /could not confirm/i);
    assert.match(ui.warnings[0]?.message ?? "", /secret cannot be retrieved/i);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm application key creation/);
  });

  test("rejects forged application key delete command arguments", async () => {
    const deleteCalls: string[] = [];
    const client = {
      async listBuckets() {
        return [];
      },
      async createKey() {
        return makeFullKey();
      },
      async deleteKey(id: ApplicationKey["applicationKeyId"]) {
        deleteCalls.push(id);
        return makeKey();
      },
    };

    const ui = await withWindowUiStubs(
      {
        warningValues: ["Delete"],
      },
      () =>
        deleteKeyCommand(
          {
            keyName: "forged-key",
            key: { applicationKeyId: applicationKeyId("forged-key-id") },
          },
          { getClient: () => client },
        ),
    );

    assert.deepStrictEqual(deleteCalls, []);
    assert.deepStrictEqual(ui.warnings, []);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Application Keys view/);
  });

  test("shows an error when deleting without authentication", async () => {
    const ui = await withWindowUiStubs({}, () =>
      deleteKeyCommand(new ApplicationKeyTreeItem(makeKey()), {
        getClient: () => null,
      }),
    );

    assert.deepStrictEqual(ui.warnings, []);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Not authenticated/);
  });

  test("shows an error when deleting without a selected application key", async () => {
    const deleteCalls: string[] = [];
    const client = {
      async listBuckets() {
        return [];
      },
      async createKey() {
        return makeFullKey();
      },
      async deleteKey(id: ApplicationKey["applicationKeyId"]) {
        deleteCalls.push(id);
        return makeKey();
      },
    };

    const ui = await withWindowUiStubs({}, () =>
      deleteKeyCommand(undefined, {
        getClient: () => client,
      }),
    );

    assert.deepStrictEqual(deleteCalls, []);
    assert.deepStrictEqual(ui.warnings, []);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Application Keys view/);
  });

  test("deletes an application key only after confirmation", async () => {
    const deleteCalls: string[] = [];
    let refreshes = 0;
    const key = makeKey({ applicationKeyId: applicationKeyId("delete-key-id") });
    const client = {
      async listBuckets() {
        return [];
      },
      async createKey() {
        return makeFullKey();
      },
      async deleteKey(id: ApplicationKey["applicationKeyId"]) {
        deleteCalls.push(id);
        return key;
      },
    };

    const ui = await withWindowUiStubs(
      {
        warningValues: ["Delete"],
      },
      () =>
        deleteKeyCommand(new ApplicationKeyTreeItem(key), {
          getClient: () => client,
          viewProviders: { refresh: () => refreshes++ },
        }),
    );

    assert.deepStrictEqual(deleteCalls, ["delete-key-id"]);
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.warnings[0]?.options?.modal, true);
    assert.match(ui.warnings[0]?.message ?? "", /delete-key-id/);
    assert.match(ui.warnings[0]?.message ?? "", /cannot be undone/i);
    assert.deepStrictEqual(ui.infos, ['B2: Application key "key-name" deleted.']);
  });

  test("warns about unknown state when key deletion times out", async () => {
    const deleteCalls: string[] = [];
    let refreshes = 0;
    const key = makeKey({ applicationKeyId: applicationKeyId("delete-timeout-key-id") });
    const client = {
      async listBuckets() {
        return [];
      },
      async createKey() {
        return makeFullKey();
      },
      async deleteKey(id: ApplicationKey["applicationKeyId"]) {
        deleteCalls.push(id);
        return new Promise<ApplicationKey>(() => undefined);
      },
    };

    const ui = await withWindowUiStubs(
      {
        warningValues: ["Delete"],
      },
      () =>
        deleteKeyCommand(new ApplicationKeyTreeItem(key), {
          getClient: () => client,
          viewProviders: { refresh: () => refreshes++ },
          applicationKeyMutationTimeoutMs: 5,
          applicationKeyMutationPostTimeoutSettleMs: 0,
        }),
    );

    assert.deepStrictEqual(deleteCalls, ["delete-timeout-key-id"]);
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(ui.warnings.length, 2);
    assert.match(ui.warnings[0]?.message ?? "", /delete-timeout-key-id/);
    assert.match(ui.warnings[1]?.message ?? "", /could not confirm/i);
    assert.match(ui.warnings[1]?.message ?? "", /before any retry/i);
    assert.strictEqual(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? "", /Could not confirm application key deletion/);
  });
});
