/**
 * Shared B2 object-name input validation.
 *
 * @module tools/b2ObjectName
 */

export function normalizeB2ObjectNameInput(filePath: string): string {
  if (!filePath) {
    throw new Error("path must name a B2 object and must not be empty.");
  }

  if (filePath.includes("\0")) {
    throw new Error("path must not contain NUL bytes.");
  }

  if (filePath.endsWith("/")) {
    throw new Error("path must name a B2 object, not a folder path ending in slash.");
  }

  return filePath;
}
