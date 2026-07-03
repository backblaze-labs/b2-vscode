/**
 * Tests for the b2-config virtual file-system provider.
 *
 * @module test/suite/b2ConfigFileSystemProvider
 */

import * as assert from "assert";
import type { EventNotificationRule } from "@backblaze-labs/b2-sdk";
import {
  B2_CONFIG_CACHE_TTL_MS,
  B2_CONFIG_SAVE_CONFIRM_LABEL,
  B2ConfigFileSystemProvider,
  buildB2ConfigUri,
  type B2ConfigBucket,
  type B2ConfigClient,
} from "../../providers/b2ConfigFileSystemProvider";
import {
  B2_CONFIG_KINDS,
  B2_CONFIG_MASKED_SECRET,
  maskB2ConfigForRead,
  prettyB2ConfigJson,
  type B2ConfigKind,
} from "../../providers/b2ConfigJson";
import { withWindowUiStubs } from "./windowStubs";

function notificationRule(
  name: string,
  url: string,
  options: {
    readonly signingSecret?: string;
    readonly headers?: Record<string, string>;
    readonly objectNamePrefix?: string;
    readonly isSuspended?: boolean;
  } = {},
): EventNotificationRule {
  const rule: EventNotificationRule = {
    name,
    eventTypes: ["b2:ObjectCreated:*"],
    isEnabled: true,
    isSuspended: options.isSuspended ?? false,
    objectNamePrefix: options.objectNamePrefix ?? "",
    suspensionReason: "",
    targetConfiguration: {
      targetType: "url",
      url,
      ...(options.signingSecret ? { hmacSha256SigningSecret: options.signingSecret } : {}),
      ...(options.headers ? { customHeaders: options.headers } : {}),
    },
  };
  return rule;
}

function encodeConfig(value: unknown): Uint8Array {
  return Buffer.from(prettyB2ConfigJson(value), "utf8");
}

async function writeConfigWithConfirmation(
  provider: B2ConfigFileSystemProvider,
  uri: ReturnType<typeof buildB2ConfigUri>,
  value: unknown,
): Promise<void> {
  await withWindowUiStubs({ warningValues: [B2_CONFIG_SAVE_CONFIRM_LABEL] }, async () => {
    await provider.writeFile(uri, encodeConfig(value), { create: false, overwrite: true });
  });
}

function makeNotificationProvider(
  initialRules: EventNotificationRule[],
  options: {
    readonly normalizeSetResult?: (rules: EventNotificationRule[]) => EventNotificationRule[];
    readonly beforeSetResult?: () => Promise<void>;
  } = {},
): {
  readonly bucket: B2ConfigBucket;
  readonly provider: B2ConfigFileSystemProvider;
  readonly savedRules: EventNotificationRule[][];
  liveRules: EventNotificationRule[];
} {
  const state = {
    liveRules: initialRules,
  };
  const savedRules: EventNotificationRule[][] = [];
  const bucket = {
    name: "bucket",
    info: {
      bucketName: "bucket",
      bucketInfo: {},
      corsRules: [],
      lifecycleRules: [],
      revision: 1,
    },
    async update() {
      throw new Error("update should not be called for notification tests");
    },
    async getNotificationRules() {
      return { eventNotificationRules: state.liveRules };
    },
    async setNotificationRules(rules: EventNotificationRule[]) {
      await options.beforeSetResult?.();
      savedRules.push(rules);
      state.liveRules = options.normalizeSetResult?.(rules) ?? rules;
      return { eventNotificationRules: state.liveRules };
    },
  } as unknown as B2ConfigBucket;
  const client = {
    async getBucket(bucketName: string) {
      return bucketName === "bucket" ? bucket : null;
    },
  } satisfies B2ConfigClient;

  return {
    bucket,
    provider: new B2ConfigFileSystemProvider(() => client),
    savedRules,
    get liveRules() {
      return state.liveRules;
    },
    set liveRules(value: EventNotificationRule[]) {
      state.liveRules = value;
    },
  };
}

suite("B2 config file-system provider", () => {
  test("rejects blind b2-config writes without an opened snapshot", async () => {
    let getBucketCalls = 0;
    const client = {
      async getBucket() {
        getBucketCalls += 1;
        return null;
      },
    } satisfies B2ConfigClient;
    const provider = new B2ConfigFileSystemProvider(() => client);
    const payloads = {
      bucketInfo: {},
      cors: [],
      lifecycle: [],
      notifications: [],
    } satisfies Record<B2ConfigKind, unknown>;

    const ui = await withWindowUiStubs({}, async () => {
      for (const kind of B2_CONFIG_KINDS) {
        await assert.rejects(
          () =>
            provider.writeFile(buildB2ConfigUri("bucket", kind), encodeConfig(payloads[kind]), {
              create: true,
              overwrite: true,
            }),
          /Open or reload/u,
        );
      }
    });

    assert.strictEqual(getBucketCalls, 0);
    assert.strictEqual(ui.warnings.length, 0);
    assert.strictEqual(ui.errors.length, B2_CONFIG_KINDS.length);
  });

  test("uses kind-appropriate placeholder stat sizes before read", () => {
    const { provider } = makeNotificationProvider([]);

    assert.strictEqual(
      provider.stat(buildB2ConfigUri("bucket", "bucketInfo")).size,
      Buffer.byteLength("{}\n"),
    );
    assert.strictEqual(
      provider.stat(buildB2ConfigUri("bucket", "notifications")).size,
      Buffer.byteLength("[]\n"),
    );
  });

  test("masks notification secrets on read and restores them on save", async () => {
    const original = [
      notificationRule("webhook", "https://example.com/b2", {
        signingSecret: "signing-secret",
        headers: {
          Authorization: "Bearer secret",
          "X-Api-Key": "api-key",
        },
      }),
    ];
    const { provider, savedRules } = makeNotificationProvider(original);
    const uri = buildB2ConfigUri("bucket", "notifications");

    const readConfig = JSON.parse(Buffer.from(await provider.readFile(uri)).toString("utf8")) as
      | EventNotificationRule[]
      | undefined;

    assert.strictEqual(
      readConfig?.[0]?.targetConfiguration.hmacSha256SigningSecret,
      B2_CONFIG_MASKED_SECRET,
    );
    assert.deepStrictEqual(readConfig?.[0]?.targetConfiguration.customHeaders, {
      Authorization: B2_CONFIG_MASKED_SECRET,
      "X-Api-Key": B2_CONFIG_MASKED_SECRET,
    });

    assert.ok(readConfig);
    (readConfig[0] as { objectNamePrefix: string }).objectNamePrefix = "logs/";
    await writeConfigWithConfirmation(provider, uri, readConfig);

    assert.strictEqual(savedRules.length, 1);
    assert.strictEqual(
      savedRules[0][0].targetConfiguration.hmacSha256SigningSecret,
      "signing-secret",
    );
    assert.deepStrictEqual(savedRules[0][0].targetConfiguration.customHeaders, {
      Authorization: "Bearer secret",
      "X-Api-Key": "api-key",
    });
  });

  test("uses server-returned notification rules for the next save snapshot", async () => {
    const original = [
      notificationRule("webhook", "https://example.com/b2", {
        signingSecret: "signing-secret",
      }),
    ];
    const fixture = makeNotificationProvider(original, {
      normalizeSetResult: (rules) => rules.map((rule) => ({ ...rule, isSuspended: true })),
    });
    const { provider, savedRules } = fixture;
    const uri = buildB2ConfigUri("bucket", "notifications");

    const readConfig = JSON.parse(Buffer.from(await provider.readFile(uri)).toString("utf8")) as
      | EventNotificationRule[]
      | undefined;
    assert.ok(readConfig);
    (readConfig[0] as { objectNamePrefix: string }).objectNamePrefix = "logs/";

    await writeConfigWithConfirmation(provider, uri, readConfig);

    const nextEdit = maskB2ConfigForRead(
      "notifications",
      fixture.liveRules,
    ) as EventNotificationRule[];
    (nextEdit[0] as { objectNamePrefix: string }).objectNamePrefix = "images/";

    await writeConfigWithConfirmation(provider, uri, nextEdit);

    assert.strictEqual(savedRules.length, 2);
  });

  test("notification saves ignore unrelated bucket revision changes", async () => {
    const original = [
      notificationRule("webhook", "https://example.com/b2", {
        signingSecret: "signing-secret",
      }),
    ];
    const { bucket, provider, savedRules } = makeNotificationProvider(original);
    const uri = buildB2ConfigUri("bucket", "notifications");

    const readConfig = JSON.parse(Buffer.from(await provider.readFile(uri)).toString("utf8")) as
      | EventNotificationRule[]
      | undefined;
    assert.ok(readConfig);
    (readConfig[0] as { objectNamePrefix: string }).objectNamePrefix = "logs/";
    (bucket.info as { revision: number }).revision = 2;

    await writeConfigWithConfirmation(provider, uri, readConfig);

    assert.strictEqual(savedRules.length, 1);
  });

  test("requires confirmation before persisting opened config documents", async () => {
    const original = [
      notificationRule("webhook", "https://example.com/b2", {
        signingSecret: "signing-secret",
      }),
    ];
    const { provider, savedRules } = makeNotificationProvider(original);
    const uri = buildB2ConfigUri("bucket", "notifications");
    const readConfig = JSON.parse(Buffer.from(await provider.readFile(uri)).toString("utf8")) as
      | EventNotificationRule[]
      | undefined;
    assert.ok(readConfig);
    (readConfig[0] as { objectNamePrefix: string }).objectNamePrefix = "logs/";

    const ui = await withWindowUiStubs({ warningValues: [undefined] }, async () => {
      await assert.rejects(
        () => provider.writeFile(uri, encodeConfig(readConfig), { create: false, overwrite: true }),
        /Save canceled/u,
      );
    });

    assert.strictEqual(savedRules.length, 0);
    assert.strictEqual(ui.warnings.length, 1);
    assert.strictEqual(ui.warnings[0]?.options?.modal, true);
    assert.deepStrictEqual(ui.warnings[0]?.items, [B2_CONFIG_SAVE_CONFIRM_LABEL]);
    assert.match(ui.warnings[0]?.message ?? "", /updates live bucket configuration/u);
  });

  test("serializes concurrent notification replacements through stale checks", async () => {
    let inFlightSets = 0;
    let maxInFlightSets = 0;
    const original = [
      notificationRule("webhook", "https://example.com/b2", {
        signingSecret: "signing-secret",
      }),
    ];
    const { provider, savedRules } = makeNotificationProvider(original, {
      beforeSetResult: async () => {
        inFlightSets += 1;
        maxInFlightSets = Math.max(maxInFlightSets, inFlightSets);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlightSets -= 1;
      },
    });
    const uri = buildB2ConfigUri("bucket", "notifications");
    const readConfig = JSON.parse(Buffer.from(await provider.readFile(uri)).toString("utf8")) as
      | EventNotificationRule[]
      | undefined;
    assert.ok(readConfig);
    const firstEdit = JSON.parse(JSON.stringify(readConfig)) as EventNotificationRule[];
    const secondEdit = JSON.parse(JSON.stringify(readConfig)) as EventNotificationRule[];
    (firstEdit[0] as { objectNamePrefix: string }).objectNamePrefix = "logs/";
    (secondEdit[0] as { objectNamePrefix: string }).objectNamePrefix = "images/";

    let results: PromiseSettledResult<void>[] = [];
    await withWindowUiStubs(
      { warningValues: [B2_CONFIG_SAVE_CONFIRM_LABEL, B2_CONFIG_SAVE_CONFIRM_LABEL] },
      async () => {
        results = await Promise.allSettled([
          provider.writeFile(uri, encodeConfig(firstEdit), { create: false, overwrite: true }),
          provider.writeFile(uri, encodeConfig(secondEdit), { create: false, overwrite: true }),
        ]);
      },
    );

    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((result) => result.status === "rejected").length, 1);
    assert.strictEqual(maxInFlightSets, 1);
    assert.strictEqual(savedRules.length, 1);
  });

  test("cache expiry is refreshed while config documents are accessed", async () => {
    const original = [
      notificationRule("webhook", "https://example.com/b2", {
        signingSecret: "signing-secret",
      }),
    ];
    const { provider, savedRules } = makeNotificationProvider(original);
    const uri = buildB2ConfigUri("bucket", "notifications");
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const readConfig = JSON.parse(Buffer.from(await provider.readFile(uri)).toString("utf8")) as
        | EventNotificationRule[]
        | undefined;
      assert.ok(readConfig);
      (readConfig[0] as { objectNamePrefix: string }).objectNamePrefix = "logs/";

      now += B2_CONFIG_CACHE_TTL_MS - 1;
      provider.stat(uri);
      now += 2;

      await writeConfigWithConfirmation(provider, uri, readConfig);
    } finally {
      Date.now = originalNow;
    }

    assert.strictEqual(savedRules.length, 1);
  });
});
