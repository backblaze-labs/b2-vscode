/**
 * Local filesystem path safety helpers.
 *
 * @module services/pathSafety
 */

import * as path from "path";

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

function isAbsolutePortable(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function assertNoNul(value: string, label: string): void {
  if (value.includes("\0")) {
    throw new UnsafePathError(`${label} must not contain NUL bytes.`);
  }
}

function portableSegments(relativePath: string, label: string): string[] {
  assertNoNul(relativePath, label);
  if (isAbsolutePortable(relativePath)) {
    throw new UnsafePathError(`${label} must be a relative path inside the allowed directory.`);
  }

  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new UnsafePathError(`${label} must not be empty.`);
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new UnsafePathError(`${label} must not contain path traversal segments.`);
  }

  return segments;
}

export function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const parentPrefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(parentPrefix);
}

export function resolveContainedRelativePath(
  basePath: string,
  relativePath: string,
  label: string,
): string {
  const base = path.resolve(basePath);
  const resolved = path.resolve(base, ...portableSegments(relativePath, label));

  if (!isPathInsideOrEqual(base, resolved)) {
    throw new UnsafePathError(`${label} resolves outside the allowed directory.`);
  }

  return resolved;
}

export function b2KeyBasename(fileName: string): string {
  assertNoNul(fileName, "B2 file name");

  const segments = fileName
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  return segments[segments.length - 1] ?? "download";
}
