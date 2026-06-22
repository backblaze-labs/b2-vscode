/**
 * Local filesystem path safety helpers.
 *
 * @module services/pathSafety
 */

import * as path from "path";
import * as fs from "fs";

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

  const segments = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    throw new UnsafePathError(`${label} must not be empty.`);
  }
  if (segments.some((segment) => segment === "..")) {
    throw new UnsafePathError(`${label} must not contain path traversal segments.`);
  }

  return segments;
}

const WORKSPACE_CONTROL_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".vscode",
  ".idea",
  ".github",
  ".devcontainer",
  ".husky",
  ".circleci",
  ".gitlab",
  ".gitea",
]);

export interface EnsureRealDirectoryOptions {
  readonly mode?: number;
  readonly recursive?: boolean;
}

export function assertRealDirectory(stats: fs.Stats, directory: string, label: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `${label} must be a real directory, not a symlink or special file: ${directory}`,
    );
  }
}

export async function pathExistsAsRealDirectory(
  directory: string,
  label: string,
): Promise<boolean> {
  try {
    assertRealDirectory(await fs.promises.lstat(directory), directory, label);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function ensureRealDirectorySync(
  directory: string,
  label: string,
  options: EnsureRealDirectoryOptions = {},
): void {
  let stats: fs.Stats | undefined;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (stats) {
    assertRealDirectory(stats, directory, label);
    return;
  }

  fs.mkdirSync(directory, {
    recursive: options.recursive ?? false,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
  assertRealDirectory(fs.lstatSync(directory), directory, label);
}

export async function ensureRealDirectory(
  directory: string,
  label: string,
  options: EnsureRealDirectoryOptions = {},
): Promise<void> {
  if (await pathExistsAsRealDirectory(directory, label)) {
    return;
  }

  await fs.promises.mkdir(directory, {
    recursive: options.recursive ?? false,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
  assertRealDirectory(await fs.promises.lstat(directory), directory, label);
}

export async function ensureContainedDirectoryPath(
  rootPath: string,
  targetDirectory: string,
  label: string,
  options: EnsureRealDirectoryOptions = {},
): Promise<void> {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetDirectory);
  if (!isPathInsideOrEqual(root, target)) {
    throw new Error(`${label} resolves outside the allowed root: ${targetDirectory}`);
  }

  const rootRealPath = await fs.promises.realpath(rootPath);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, segment);
    await ensureRealDirectory(current, label, options);
    const currentRealPath = await fs.promises.realpath(current);
    if (!isPathInsideOrEqual(rootRealPath, currentRealPath)) {
      throw new Error(`${label} resolves outside the allowed root: ${current}`);
    }
  }
}

export function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const parentPrefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(parentPrefix);
}

export function findWorkspaceControlDirectory(
  workspaceRoot: string,
  candidatePath: string,
): string | undefined {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(candidatePath));
  return relative
    .split(path.sep)
    .filter((segment) => segment.length > 0)
    .find((segment) =>
      WORKSPACE_CONTROL_DIRECTORIES.has(segment.toLowerCase().replace(/[. ]+$/u, "")),
    );
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
