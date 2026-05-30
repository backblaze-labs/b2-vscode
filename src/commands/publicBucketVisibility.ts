/**
 * Public bucket visibility warning helpers.
 *
 * @module commands/publicBucketVisibility
 */

import type { BucketType } from "@backblaze-labs/b2-sdk";

export const CONFIRM_PUBLIC_BUCKET_LABEL = "Make Public";

export type PublicBucketVisibilityAction = "create" | "change";

export function shouldConfirmPublicBucketVisibility(
  currentType: string | undefined,
  nextType: BucketType,
): boolean {
  return nextType === "allPublic" && currentType !== "allPublic";
}

export function isPublicBucketConfirmationAccepted(choice: string | undefined): boolean {
  return choice === CONFIRM_PUBLIC_BUCKET_LABEL;
}

export function buildPublicBucketWarningMessage(
  action: PublicBucketVisibilityAction,
  bucketName: string,
): string {
  const actionText =
    action === "create"
      ? `Creating bucket "${bucketName}" as public`
      : `Changing bucket "${bucketName}" to public`;

  return `${actionText} can make files in the bucket accessible without authorization. Continue only if public access is intentional.`;
}
