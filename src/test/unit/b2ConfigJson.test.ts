/**
 * Unit tests for B2 bucket-configuration JSON helpers.
 *
 * @module test/unit/b2ConfigJson
 */

import * as assert from "node:assert/strict";
import test from "node:test";
import {
  B2_CONFIG_MASKED_SECRET,
  maskB2ConfigForRead,
  mergeMaskedB2Config,
  parseB2ConfigPath,
  stableB2ConfigJson,
  validateB2ConfigJson,
} from "../../providers/b2ConfigJson";

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

test("masks notification signing secrets and authorization headers on read", () => {
  const original = [
    {
      name: "webhook",
      targetConfiguration: {
        targetType: "url",
        url: "https://example.com/b2",
        hmacSha256SigningSecret: "signing-secret",
        hmacSha256: "legacy-secret",
        customHeaders: {
          Authorization: "Bearer secret",
          "X-Trace": "keep-visible",
        },
      },
    },
  ];

  const masked = maskB2ConfigForRead("notifications", original) as typeof original;

  assert.equal(masked[0].targetConfiguration.hmacSha256SigningSecret, B2_CONFIG_MASKED_SECRET);
  assert.equal(masked[0].targetConfiguration.hmacSha256, B2_CONFIG_MASKED_SECRET);
  assert.equal(masked[0].targetConfiguration.customHeaders.Authorization, B2_CONFIG_MASKED_SECRET);
  assert.equal(masked[0].targetConfiguration.customHeaders["X-Trace"], "keep-visible");
  assert.equal(original[0].targetConfiguration.hmacSha256SigningSecret, "signing-secret");
});

test("merges unchanged notification masks back to the original secret values", () => {
  const original = [
    {
      targetConfiguration: {
        hmacSha256SigningSecret: "signing-secret",
        customHeaders: {
          Authorization: "Bearer secret",
        },
      },
    },
  ];
  const edited = maskB2ConfigForRead("notifications", original) as typeof original;

  const merged = mergeMaskedB2Config("notifications", edited, original);

  assert.deepEqual(merged, original);
});

test("changed notification secrets replace originals while unchanged masks are preserved", () => {
  const original = [
    {
      targetConfiguration: {
        hmacSha256SigningSecret: "old-secret",
        customHeaders: {
          Authorization: "Bearer old",
        },
      },
    },
  ];
  const edited = maskB2ConfigForRead("notifications", original) as typeof original;
  edited[0].targetConfiguration.hmacSha256SigningSecret = "new-secret";

  const merged = mergeMaskedB2Config("notifications", edited, original) as typeof original;

  assert.equal(merged[0].targetConfiguration.hmacSha256SigningSecret, "new-secret");
  assert.equal(merged[0].targetConfiguration.customHeaders.Authorization, "Bearer old");
});

test("validates top-level config shapes before save", () => {
  assert.equal(validateB2ConfigJson("lifecycle", []), undefined);
  assert.equal(validateB2ConfigJson("cors", []), undefined);
  assert.equal(validateB2ConfigJson("notifications", []), undefined);
  assert.equal(validateB2ConfigJson("bucketInfo", { team: "platform" }), undefined);

  assert.match(validateB2ConfigJson("lifecycle", {}) ?? "", /array/u);
  assert.match(validateB2ConfigJson("bucketInfo", []) ?? "", /object/u);
  assert.match(validateB2ConfigJson("bucketInfo", { team: 1 }) ?? "", /string/u);
  assert.match(
    validateB2ConfigJson("notifications", [
      { targetConfiguration: { customHeaders: { Authorization: 1 } } },
    ]) ?? "",
    /must be a string/u,
  );
});

test("stable config JSON ignores object key insertion order", () => {
  assert.equal(
    stableB2ConfigJson({ b: 1, a: { d: 4, c: 3 } }),
    stableB2ConfigJson({
      a: { c: 3, d: 4 },
      b: 1,
    }),
  );
});
