/**
 * Shared B2 object-name input validation.
 *
 * @module tools/b2ObjectName
 */

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export function normalizeB2ObjectNameInput(filePath: string): string {
  if (!filePath) {
    throw new Error("path must not be empty or a folder prefix.");
  }

  if (CONTROL_CHARACTER_PATTERN.test(filePath)) {
    throw new Error("path must not contain NUL or other control characters.");
  }

  if (filePath.endsWith("/")) {
    throw new Error(
      "path must not be empty or a folder prefix; folder path ending in slash is not allowed.",
    );
  }

  return filePath;
}
