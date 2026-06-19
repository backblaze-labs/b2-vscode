/**
 * Convert bytes to a human-readable string.
 *
 * @module utils/humanSize
 */

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function humanSize(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }

  const unitIndex = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1),
  );
  const size = bytes / Math.pow(1024, unitIndex);

  return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${SIZE_UNITS[unitIndex]}`;
}
