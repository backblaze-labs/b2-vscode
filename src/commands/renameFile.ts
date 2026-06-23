import type { Bucket, FileId } from "@backblaze-labs/b2-sdk";
import { B2PartialFailureError, formatB2UserMessage } from "../errors";

export async function renameFileVersion(
  bucket: Pick<Bucket, "copyFile" | "deleteFileVersion">,
  oldPath: string,
  fileId: FileId,
  newPath: string,
): Promise<void> {
  let copyCompleted = false;
  try {
    await bucket.copyFile({ sourceFileId: fileId, fileName: newPath });
    copyCompleted = true;
    await bucket.deleteFileVersion(oldPath, fileId);
  } catch (error) {
    if (copyCompleted) {
      throw new B2PartialFailureError(
        `Rename incomplete. Copied "${oldPath}" to "${newPath}", but failed to delete the original. Both B2 objects may exist. ${formatB2UserMessage(error)}`,
        error,
      );
    }
    throw error;
  }
}
