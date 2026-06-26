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
import { ApplicationKeysProvider } from "../../providers/applicationKeysProvider";
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
      children.map((child) => child.keyName),
      ["first-key", "second-key"],
    );
  });
});

suite("B2 application key commands", () => {
  test("creates a scoped key and shows the secret once with copy warning", async () => {
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
        inputValues: ["scoped-key", "uploads/"],
        quickPickLabels: ["readFiles, writeFiles", "photos", "1 day"],
        warningValues: ["Close"],
      },
      () =>
        createKeyCommand({
          getClient: () => client,
          applicationKeysProvider: { refresh: () => refreshes++ },
        }),
    );

    assert.deepStrictEqual(createCalls, [
      {
        bucketId: bucketId("bucket-id"),
        capabilities: [Capability.ReadFiles, Capability.WriteFiles],
        keyName: "scoped-key",
        namePrefix: "uploads/",
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
          applicationKeysProvider: { refresh: () => refreshes++ },
        }),
    );

    assert.deepStrictEqual(deleteCalls, ["delete-key-id"]);
    assert.strictEqual(refreshes, 1);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.warnings[0]?.options?.modal, true);
    assert.match(ui.warnings[0]?.message ?? "", /cannot be undone/i);
    assert.deepStrictEqual(ui.infos, ['B2: Application key "key-name" deleted.']);
  });
});
