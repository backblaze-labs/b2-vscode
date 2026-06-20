/**
 * Tests for public bucket visibility warnings.
 *
 * @module test/suite/publicBucketVisibility
 */

import * as assert from "assert";
import {
  bucketTypeLabel,
  buildPublicBucketTypedConfirmationValidationMessage,
  buildPublicBucketTypedConfirmationPrompt,
  buildPublicBucketUnknownStateWarningMessage,
  buildPublicBucketWarningMessage,
  CONFIRM_PUBLIC_BUCKET_LABEL,
  isPublicBucketConfirmationAccepted,
  isPublicBucketNameConfirmationAccepted,
  shouldConfirmPublicBucketVisibility,
} from "../../commands/publicBucketVisibility";

suite("Public bucket visibility warnings", () => {
  test("does not require confirmation when creating a private bucket", () => {
    assert.strictEqual(shouldConfirmPublicBucketVisibility(undefined, "allPrivate"), false);
  });

  test("requires confirmation when creating a public bucket", () => {
    assert.strictEqual(shouldConfirmPublicBucketVisibility(undefined, "allPublic"), true);
  });

  test("requires confirmation when changing a private bucket to public", () => {
    assert.strictEqual(shouldConfirmPublicBucketVisibility("allPrivate", "allPublic"), true);
  });

  test("labels B2 bucket visibility consistently", () => {
    assert.strictEqual(bucketTypeLabel("allPrivate"), "Private");
    assert.strictEqual(bucketTypeLabel("allPublic"), "Public");
  });

  test("does not require confirmation when changing a public bucket to private", () => {
    assert.strictEqual(shouldConfirmPublicBucketVisibility("allPublic", "allPrivate"), false);
  });

  test("treats cancel or dismiss as not confirmed", () => {
    assert.strictEqual(isPublicBucketConfirmationAccepted(undefined), false);
    assert.strictEqual(isPublicBucketConfirmationAccepted("Cancel"), false);
    assert.strictEqual(isPublicBucketConfirmationAccepted(CONFIRM_PUBLIC_BUCKET_LABEL), true);
  });

  test("requires the exact bucket name for typed confirmation", () => {
    assert.strictEqual(isPublicBucketNameConfirmationAccepted("public-assets", undefined), false);
    assert.strictEqual(isPublicBucketNameConfirmationAccepted("public-assets", ""), false);
    assert.strictEqual(
      isPublicBucketNameConfirmationAccepted("public-assets", "PUBLIC-ASSETS"),
      false,
    );
    assert.strictEqual(
      isPublicBucketNameConfirmationAccepted("public-assets", "public-assets"),
      true,
    );
  });

  test("explains that public files may be accessible without authorization", () => {
    const message = buildPublicBucketWarningMessage("change", "public-assets");

    assert.ok(message.includes("public-assets"));
    assert.ok(message.includes("accessible without authorization"));
  });

  test("typed confirmation prompt repeats the bucket name and public exposure risk", () => {
    const prompt = buildPublicBucketTypedConfirmationPrompt("public-assets");

    assert.ok(prompt.includes('"public-assets"'));
    assert.ok(prompt.includes("accessible without authorization"));
  });

  test("typed confirmation validation repeats the bucket name", () => {
    const message = buildPublicBucketTypedConfirmationValidationMessage("public-assets");

    assert.ok(message.includes('"public-assets"'));
    assert.ok(message.includes("public access"));
  });

  test("create unknown-state warning tells users the bucket may have been created", () => {
    const message = buildPublicBucketUnknownStateWarningMessage("create", "public-assets");

    assert.ok(message.includes("public-assets"));
    assert.ok(message.includes("may have been created as public"));
    assert.ok(message.includes("may not have been created at all"));
    assert.ok(message.includes("accessible without authorization"));
  });

  test("change unknown-state warning tells users the bucket may already be public", () => {
    const message = buildPublicBucketUnknownStateWarningMessage("change", "public-assets");

    assert.ok(message.includes("public-assets"));
    assert.ok(message.includes("may already be public"));
    assert.ok(message.includes("accessible without authorization"));
  });
});
