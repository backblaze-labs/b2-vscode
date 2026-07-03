/**
 * Tests for the b2-config virtual file-system provider.
 *
 * @module test/suite/b2ConfigFileSystemProvider
 */

import * as assert from "assert";
import type { EventNotificationRule } from "@backblaze-labs/b2-sdk";
import {
  B2ConfigFileSystemProvider,
  buildB2ConfigUri,
  type B2ConfigBucket,
  type B2ConfigClient,
} from "../../providers/b2ConfigFileSystemProvider";
import {
  B2_CONFIG_MASKED_SECRET,
  maskB2ConfigForRead,
  prettyB2ConfigJson,
} from "../../providers/b2ConfigJson";

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

function makeNotificationProvider(
  initialRules: EventNotificationRule[],
  options: {
    readonly normalizeSetResult?: (rules: EventNotificationRule[]) => EventNotificationRule[];
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
    await provider.writeFile(uri, encodeConfig(readConfig), { create: false, overwrite: true });

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

    await provider.writeFile(uri, encodeConfig(readConfig), { create: false, overwrite: true });

    const nextEdit = maskB2ConfigForRead(
      "notifications",
      fixture.liveRules,
    ) as EventNotificationRule[];
    (nextEdit[0] as { objectNamePrefix: string }).objectNamePrefix = "images/";

    await provider.writeFile(uri, encodeConfig(nextEdit), { create: false, overwrite: true });

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

    await provider.writeFile(uri, encodeConfig(readConfig), { create: false, overwrite: true });

    assert.strictEqual(savedRules.length, 1);
  });
});
