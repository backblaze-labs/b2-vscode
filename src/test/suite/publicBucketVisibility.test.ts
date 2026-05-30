/**
 * Tests for public bucket visibility warnings.
 *
 * @module test/suite/publicBucketVisibility
 */

import * as assert from "assert";
import {
  buildPublicBucketWarningMessage,
  CONFIRM_PUBLIC_BUCKET_LABEL,
  isPublicBucketConfirmationAccepted,
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

  test("does not require confirmation when changing a public bucket to private", () => {
    assert.strictEqual(shouldConfirmPublicBucketVisibility("allPublic", "allPrivate"), false);
  });

  test("treats cancel or dismiss as not confirmed", () => {
    assert.strictEqual(isPublicBucketConfirmationAccepted(undefined), false);
    assert.strictEqual(isPublicBucketConfirmationAccepted("Cancel"), false);
    assert.strictEqual(isPublicBucketConfirmationAccepted(CONFIRM_PUBLIC_BUCKET_LABEL), true);
  });

  test("explains that public files may be accessible without authorization", () => {
    const message = buildPublicBucketWarningMessage("change", "public-assets");

    assert.ok(message.includes("public-assets"));
    assert.ok(message.includes("accessible without authorization"));
  });
});
