/**
 * String normalization helpers shared by path and URL encoding.
 *
 * @module utils/strings
 */

export function toWellFormedString(value: string): string {
  const maybeNative = value as string & { toWellFormed?: () => string };
  if (typeof maybeNative.toWellFormed === "function") {
    return maybeNative.toWellFormed();
  }

  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}
