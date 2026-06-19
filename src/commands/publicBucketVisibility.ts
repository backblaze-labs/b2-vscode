/**
 * Public bucket visibility warning helpers.
 *
 * @module commands/publicBucketVisibility
 */

import type { BucketType } from "@backblaze-labs/b2-sdk";

export const CONFIRM_PUBLIC_BUCKET_LABEL = "Make Public";
export const PUBLIC_BUCKET_TYPED_CONFIRMATION_PLACEHOLDER = "Type the bucket name to confirm";

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

export function isPublicBucketNameConfirmationAccepted(
  bucketName: string,
  typedBucketName: string | undefined,
): boolean {
  return typedBucketName === bucketName;
}

export function buildPublicBucketWarningMessage(
  action: PublicBucketVisibilityAction,
  bucketName: string,
): string {
  const actionText =
    action === "create"
      ? `Creating bucket "${bucketName}" as public`
      : `Changing bucket "${bucketName}" to public`;

  return `${actionText} can make current and future files in the bucket accessible without authorization. Continue only if public access is intentional.`;
}

export function buildPublicBucketTypedConfirmationPrompt(bucketName: string): string {
  return `Type "${bucketName}" to confirm making this bucket public. Files may be accessible without authorization.`;
}

export function buildPublicBucketTypedConfirmationValidationMessage(bucketName: string): string {
  return `Type "${bucketName}" to confirm public access`;
}

export function buildPublicBucketUnknownStateWarningMessage(
  action: PublicBucketVisibilityAction,
  bucketName: string,
): string {
  const actionText =
    action === "create"
      ? `creating public bucket "${bucketName}"`
      : `changing bucket "${bucketName}" to public`;

  return `B2 could not confirm whether ${actionText} completed. The bucket tree has been refreshed because the bucket may already be public and files may be accessible without authorization.`;
}
