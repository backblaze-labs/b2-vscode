/**
 * Public bucket visibility warning helpers.
 *
 * @module commands/publicBucketVisibility
 */

import type { BucketType } from "@backblaze-labs/b2-sdk";

export const CONFIRM_PUBLIC_BUCKET_LABEL = "Make Public";
export const PUBLIC_BUCKET_TYPED_CONFIRMATION_PLACEHOLDER = "Type the bucket name to confirm";

export type PublicBucketVisibilityAction = "create" | "change";
export type PublicPrivateBucketType = Extract<BucketType, "allPrivate" | "allPublic">;

export function isPublicPrivateBucketType(type: BucketType): type is PublicPrivateBucketType {
  return type === "allPrivate" || type === "allPublic";
}

export function shouldConfirmPublicBucketVisibility(
  currentType: string | undefined,
  nextType: PublicPrivateBucketType,
): boolean {
  return nextType === "allPublic" && currentType !== "allPublic";
}

export function isPublicBucketConfirmationAccepted(choice: string | undefined): boolean {
  return choice === CONFIRM_PUBLIC_BUCKET_LABEL;
}

export function bucketTypeLabel(type: PublicPrivateBucketType): string {
  return type === "allPublic" ? "Public" : "Private";
}

export function isPublicBucketNameConfirmationAccepted(
  bucketName: string,
  typedBucketName: string | undefined,
): boolean {
  if (!bucketName.trim()) {
    return false;
  }
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
  targetType: PublicPrivateBucketType = "allPublic",
): string {
  if (action === "create") {
    return `B2 could not confirm whether creating public bucket "${bucketName}" completed. A bucket tree refresh was requested because the bucket may have been created as public, may still complete, or may not have been created at all. Files may be accessible without authorization if the public create succeeded.`;
  }

  const targetLabel = bucketTypeLabel(targetType).toLowerCase();
  const publicStateText =
    targetType === "allPublic"
      ? "the bucket may already be public"
      : "the bucket may remain public";

  return `B2 could not confirm whether changing bucket "${bucketName}" to ${targetLabel} completed. A bucket tree refresh was requested because the original request may still complete, ${publicStateText}, and files may be accessible without authorization.`;
}
