/**
 * Unit tests for B2 bucket-configuration JSON helpers.
 *
 * @module test/unit/b2ConfigJson
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  B2_CONFIG_KINDS,
  B2_CONFIG_MASKED_SECRET,
  B2_CONFIG_SCHEME,
  b2ConfigFileName,
  b2ConfigSchemaPath,
  createB2ConfigSecretSnapshot,
  fingerprintB2ConfigJson,
  maskB2ConfigForRead,
  mergeMaskedB2Config,
  parseB2ConfigPath,
  prettyB2ConfigJson,
  stableB2ConfigJson,
  validateB2ConfigJson,
} from "../../providers/b2ConfigJson";

interface TestNotificationRule {
  name: string;
  eventTypes: string[];
  isEnabled: boolean;
  isSuspended: boolean;
  objectNamePrefix: string;
  suspensionReason: string;
  targetConfiguration: {
    targetType: string;
    url: string;
    hmacSha256SigningSecret?: string;
    hmacSha256?: string;
    customHeaders?: Record<string, string>;
  };
}

function notificationRule(
  name: string,
  url: string,
  options: {
    readonly signingSecret?: string;
    readonly legacySecret?: string;
    readonly headers?: Record<string, string>;
  } = {},
): TestNotificationRule {
  return {
    name,
    eventTypes: ["b2:ObjectCreated:*"],
    isEnabled: true,
    isSuspended: false,
    objectNamePrefix: "",
    suspensionReason: "",
    targetConfiguration: {
      targetType: "url",
      url,
      ...(options.signingSecret ? { hmacSha256SigningSecret: options.signingSecret } : {}),
      ...(options.legacySecret ? { hmacSha256: options.legacySecret } : {}),
      ...(options.headers ? { customHeaders: options.headers } : {}),
    },
  };
}

function maskedNotifications(rules: readonly TestNotificationRule[]): TestNotificationRule[] {
  return maskB2ConfigForRead("notifications", rules) as TestNotificationRule[];
}

test("parses b2-config bucket config document paths", () => {
  assert.deepEqual(parseB2ConfigPath("/my-bucket/lifecycle.json"), {
    bucketName: "my-bucket",
    kind: "lifecycle",
  });
  assert.deepEqual(parseB2ConfigPath("/my-bucket/cors.json"), {
    bucketName: "my-bucket",
    kind: "cors",
  });
  assert.deepEqual(parseB2ConfigPath("/my-bucket/notifications.json"), {
    bucketName: "my-bucket",
    kind: "notifications",
  });
  assert.deepEqual(parseB2ConfigPath("/my-bucket/bucketInfo.json"), {
    bucketName: "my-bucket",
    kind: "bucketInfo",
  });

  assert.equal(parseB2ConfigPath("/my-bucket/unknown.json"), undefined);
  assert.equal(parseB2ConfigPath("/my-bucket/lifecycle.txt"), undefined);
  assert.equal(parseB2ConfigPath("/too/many/lifecycle.json"), undefined);
});

test("masks notification signing secrets and all custom headers on read", () => {
  const original = [
    notificationRule("webhook", "https://example.com/b2", {
      signingSecret: "signing-secret",
      legacySecret: "legacy-secret",
      headers: {
        Authorization: "Bearer secret",
        "X-Api-Key": "api-key",
        "X-Webhook-Secret": "webhook-secret",
        "X-Trace": "trace-token",
      },
    }),
  ];

  const masked = maskedNotifications(original);

  assert.equal(masked[0].targetConfiguration.hmacSha256SigningSecret, B2_CONFIG_MASKED_SECRET);
  assert.equal(masked[0].targetConfiguration.hmacSha256, B2_CONFIG_MASKED_SECRET);
  assert.deepEqual(masked[0].targetConfiguration.customHeaders, {
    Authorization: B2_CONFIG_MASKED_SECRET,
    "X-Api-Key": B2_CONFIG_MASKED_SECRET,
    "X-Webhook-Secret": B2_CONFIG_MASKED_SECRET,
    "X-Trace": B2_CONFIG_MASKED_SECRET,
  });
  assert.equal(original[0].targetConfiguration.hmacSha256SigningSecret, "signing-secret");
});

test("merges unchanged notification masks back to matching original rule secrets", () => {
  const original = [
    notificationRule("webhook", "https://example.com/b2", {
      signingSecret: "signing-secret",
      headers: {
        Authorization: "Bearer secret",
        "X-Api-Key": "api-key",
      },
    }),
  ];
  const edited = maskedNotifications(original);

  const merged = mergeMaskedB2Config(
    "notifications",
    edited,
    createB2ConfigSecretSnapshot("notifications", original),
  );

  assert.deepEqual(merged, original);
});

test("restores reordered notification masks by stable rule identity", () => {
  const original = [
    notificationRule("alpha", "https://alpha.example.com/b2", {
      signingSecret: "alpha-secret",
      headers: { "X-Api-Key": "alpha-api-key" },
    }),
    notificationRule("beta", "https://beta.example.com/b2", {
      signingSecret: "beta-secret",
      headers: { "X-Api-Key": "beta-api-key" },
    }),
  ];
  const edited = maskedNotifications(original).reverse();

  const merged = mergeMaskedB2Config(
    "notifications",
    edited,
    createB2ConfigSecretSnapshot("notifications", original),
  ) as TestNotificationRule[];

  assert.equal(merged[0].name, "beta");
  assert.equal(merged[0].targetConfiguration.hmacSha256SigningSecret, "beta-secret");
  assert.equal(merged[0].targetConfiguration.customHeaders?.["X-Api-Key"], "beta-api-key");
  assert.equal(merged[1].name, "alpha");
  assert.equal(merged[1].targetConfiguration.hmacSha256SigningSecret, "alpha-secret");
  assert.equal(merged[1].targetConfiguration.customHeaders?.["X-Api-Key"], "alpha-api-key");
});

test("restores remaining notification masks after a rule deletion by identity", () => {
  const original = [
    notificationRule("deleted", "https://deleted.example.com/b2", {
      signingSecret: "deleted-secret",
    }),
    notificationRule("remaining", "https://remaining.example.com/b2", {
      signingSecret: "remaining-secret",
    }),
  ];
  const edited = maskedNotifications(original).slice(1);

  const merged = mergeMaskedB2Config(
    "notifications",
    edited,
    createB2ConfigSecretSnapshot("notifications", original),
  ) as TestNotificationRule[];

  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "remaining");
  assert.equal(merged[0].targetConfiguration.hmacSha256SigningSecret, "remaining-secret");
});

test("rejects masked secrets on inserted notification rules", () => {
  const original = [
    notificationRule("alpha", "https://alpha.example.com/b2", {
      signingSecret: "alpha-secret",
    }),
  ];
  const edited = [
    notificationRule("inserted", "https://inserted.example.com/b2", {
      signingSecret: B2_CONFIG_MASKED_SECRET,
      headers: { "X-Api-Key": B2_CONFIG_MASKED_SECRET },
    }),
  ];

  assert.throws(
    () =>
      mergeMaskedB2Config(
        "notifications",
        edited,
        createB2ConfigSecretSnapshot("notifications", original),
      ),
    /cannot be restored/u,
  );
});

test("rejects masked secrets when notification rule identity is renamed", () => {
  const original = [
    notificationRule("alpha", "https://alpha.example.com/b2", {
      signingSecret: "alpha-secret",
    }),
  ];
  const edited = maskedNotifications(original);
  edited[0].name = "renamed";

  assert.throws(
    () =>
      mergeMaskedB2Config(
        "notifications",
        edited,
        createB2ConfigSecretSnapshot("notifications", original),
      ),
    /cannot be restored/u,
  );
});

test("rejects masked secrets when notification target URL changes", () => {
  const original = [
    notificationRule("alpha", "https://alpha.example.com/b2", {
      signingSecret: "alpha-secret",
      headers: { "X-Api-Key": "alpha-api-key" },
    }),
  ];
  const edited = maskedNotifications(original);
  edited[0].targetConfiguration.url = "https://attacker.example.com/b2";

  assert.throws(
    () =>
      mergeMaskedB2Config(
        "notifications",
        edited,
        createB2ConfigSecretSnapshot("notifications", original),
      ),
    /cannot be restored/u,
  );
});

test("rejects masked secrets when notification target type changes", () => {
  const original = [
    notificationRule("alpha", "https://alpha.example.com/b2", {
      headers: { "X-Api-Key": "alpha-api-key" },
    }),
  ];
  const edited = maskedNotifications(original);
  edited[0].targetConfiguration.targetType = "attacker";

  assert.throws(
    () =>
      mergeMaskedB2Config(
        "notifications",
        edited,
        createB2ConfigSecretSnapshot("notifications", original),
      ),
    /cannot be restored/u,
  );
});

test("rejects masked secrets for ambiguous notification rule identities", () => {
  const original = [
    notificationRule("same", "https://same.example.com/b2", {
      signingSecret: "first-secret",
    }),
    notificationRule("same", "https://same.example.com/b2", {
      signingSecret: "second-secret",
    }),
  ];
  const edited = [maskedNotifications(original)[0]];

  assert.throws(
    () =>
      mergeMaskedB2Config(
        "notifications",
        edited,
        createB2ConfigSecretSnapshot("notifications", original),
      ),
    /ambiguous/u,
  );
});

test("changed notification secrets replace originals while unchanged masks are preserved", () => {
  const original = [
    notificationRule("webhook", "https://example.com/b2", {
      signingSecret: "old-secret",
      headers: {
        Authorization: "Bearer old",
      },
    }),
  ];
  const edited = maskedNotifications(original);
  edited[0].targetConfiguration.hmacSha256SigningSecret = "new-secret";

  const merged = mergeMaskedB2Config(
    "notifications",
    edited,
    createB2ConfigSecretSnapshot("notifications", original),
  ) as TestNotificationRule[];

  assert.equal(merged[0].targetConfiguration.hmacSha256SigningSecret, "new-secret");
  assert.equal(merged[0].targetConfiguration.customHeaders?.Authorization, "Bearer old");
});

test("validates config shapes before save", () => {
  assert.equal(
    validateB2ConfigJson("lifecycle", [
      {
        fileNamePrefix: "logs/",
        daysFromUploadingToHiding: 30,
        daysFromHidingToDeleting: null,
      },
    ]),
    undefined,
  );
  assert.equal(
    validateB2ConfigJson("cors", [
      {
        corsRuleName: "browser",
        allowedOrigins: ["https://example.com"],
        allowedOperations: ["b2_download_file_by_name"],
        allowedHeaders: null,
        exposeHeaders: null,
        maxAgeSeconds: 300,
      },
    ]),
    undefined,
  );
  assert.equal(
    validateB2ConfigJson("notifications", [notificationRule("webhook", "https://example.com/b2")]),
    undefined,
  );
  assert.equal(validateB2ConfigJson("bucketInfo", { team: "platform" }), undefined);

  assert.match(validateB2ConfigJson("lifecycle", {}) ?? "", /array/u);
  assert.match(validateB2ConfigJson("lifecycle", [{}]) ?? "", /fileNamePrefix/u);
  assert.match(
    validateB2ConfigJson("cors", [
      {
        corsRuleName: "browser",
        allowedOrigins: ["https://example.com"],
        allowedOperations: ["unsupported"],
        allowedHeaders: null,
        exposeHeaders: null,
        maxAgeSeconds: 300,
      },
    ]) ?? "",
    /unsupported operation/u,
  );
  assert.match(
    validateB2ConfigJson("cors", [
      {
        corsRuleName: "browser",
        allowedOrigins: ["https://example.com"],
        allowedOperations: ["b2_download_file_by_name", "b2_download_file_by_name"],
        allowedHeaders: null,
        exposeHeaders: null,
        maxAgeSeconds: 300,
      },
    ]) ?? "",
    /duplicate value/u,
  );
  assert.match(validateB2ConfigJson("bucketInfo", []) ?? "", /object/u);
  assert.match(validateB2ConfigJson("bucketInfo", { team: 1 }) ?? "", /string/u);
  assert.match(
    validateB2ConfigJson("notifications", [{ ...notificationRule("webhook", "not a url") }]) ?? "",
    /valid URL/u,
  );
  assert.match(
    validateB2ConfigJson("notifications", [
      {
        ...notificationRule("webhook", "https://example.com/b2"),
        eventTypes: ["b2:ObjectCreated:*", "b2:ObjectCreated:*"],
      },
    ]) ?? "",
    /duplicate value/u,
  );
  assert.match(
    validateB2ConfigJson("notifications", [
      {
        ...notificationRule("webhook", "https://example.com/b2", {
          headers: { Authorization: "ok" },
        }),
        targetConfiguration: {
          ...notificationRule("webhook", "https://example.com/b2").targetConfiguration,
          customHeaders: { Authorization: 1 },
        },
      },
    ]) ?? "",
    /must be a string/u,
  );
});

test("stable config JSON and fingerprint ignore object key insertion order", () => {
  const left = { b: 1, a: { d: 4, c: 3 } };
  const right = {
    a: { c: 3, d: 4 },
    b: 1,
  };

  assert.equal(stableB2ConfigJson(left), stableB2ConfigJson(right));
  assert.equal(fingerprintB2ConfigJson(left), fingerprintB2ConfigJson(right));
});

test("JSON helpers keep undefined values representable as JSON", () => {
  assert.equal(prettyB2ConfigJson(undefined), "null\n");
  assert.equal(stableB2ConfigJson(undefined), "null");
  assert.equal(fingerprintB2ConfigJson(undefined), fingerprintB2ConfigJson(null));
});

test("config kind metadata matches package jsonValidation and schema files", () => {
  const repoRoot = process.cwd();
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    contributes: {
      jsonValidation: Array<{
        fileMatch: string[];
        url: string;
      }>;
    };
  };

  for (const kind of B2_CONFIG_KINDS) {
    const schemaPath = b2ConfigSchemaPath(kind);
    const schemaFile = path.join(repoRoot, schemaPath.replace(/^\.\//u, ""));
    assert.equal(fs.existsSync(schemaFile), true, `${schemaPath} should exist`);

    const validation = packageJson.contributes.jsonValidation.find(
      (entry) => entry.url === schemaPath,
    );
    assert.ok(validation, `${kind} should have a jsonValidation contribution`);
    assert.deepEqual(validation.fileMatch, [`${B2_CONFIG_SCHEME}:/**/${b2ConfigFileName(kind)}`]);
  }
});
