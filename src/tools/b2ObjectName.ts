/**
 * Shared B2 object-name input validation.
 *
 * @module tools/b2ObjectName
 */

export function normalizeB2ObjectNameInput(filePath: string): string {
  if (!filePath) {
    throw new Error("path must not be empty or a folder prefix.");
  }

  if (/[\u0000-\u001F\u007F]/u.test(filePath)) {
    throw new Error("path must not contain NUL or other control characters.");
  }

  if (filePath.endsWith("/")) {
    throw new Error(
      "path must not be empty or a folder prefix; folder path ending in slash is not allowed.",
    );
  }

  return filePath;
}
