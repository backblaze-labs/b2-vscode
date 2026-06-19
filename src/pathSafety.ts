/**
 * Shared helpers for deriving local paths and URL components from untrusted B2
 * object names and language model tool inputs.
 *
 * @module pathSafety
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const HASH_LENGTH = 16;

export interface SafePathSegmentOptions {
  fallback: string;
  maxBytes: number;
  hashInput?: string;
  disambiguateOnChange?: boolean;
  preserveExtension?: boolean;
}

export interface AtomicWriteOptions {
  overwrite?: boolean;
}

export function contentHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}

export function toWellFormedUnicode(value: string): string {
  const maybeNative = value as string & { toWellFormed?: () => string };
  if (typeof maybeNative.toWellFormed === "function") {
    return maybeNative.toWellFormed();
  }

  // Node 22 has String.prototype.toWellFormed(), but the project targets the
  // ES2022 TypeScript lib, so keep a small fallback for type-compatible builds.
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index++;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index];
    }
  }

  return result;
}

export function encodeUrlComponent(value: string): string {
  return encodeURIComponent(toWellFormedUnicode(value));
}

export function encodeUrlPathSegment(value: string): string {
  const wellFormed = toWellFormedUnicode(value);
  if (/^\.+$/.test(wellFormed)) {
    return ".".repeat(wellFormed.length).replace(/\./g, "%252E");
  }

  return encodeUrlComponent(wellFormed);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let usedBytes = 0;

  for (const character of value) {
    const characterBytes = byteLength(character);
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    usedBytes += characterBytes;
  }

  return result;
}

function extensionFor(name: string, maxBytes: number, preserveExtension: boolean): string {
  if (!preserveExtension) {
    return "";
  }

  const extension = path.posix.extname(name);
  if (!extension || extension === name || byteLength(extension) > Math.floor(maxBytes / 3)) {
    return "";
  }

  return extension;
}

function fitSegmentToBytes(
  value: string,
  maxBytes: number,
  hashSuffix: string,
  preserveExtension: boolean,
  fallback: string,
): string {
  const extension = extensionFor(value, maxBytes, preserveExtension);
  const stem = extension ? value.slice(0, -extension.length) : value;
  const suffix = `${hashSuffix}${extension}`;

  if (!hashSuffix && byteLength(value) <= maxBytes) {
    return value;
  }

  const maxStemBytes = Math.max(1, maxBytes - byteLength(suffix));
  const truncatedStem = truncateUtf8(stem, maxStemBytes) || fallback;
  const candidate = `${truncatedStem}${suffix}`;

  if (byteLength(candidate) <= maxBytes) {
    return candidate;
  }

  const fallbackSuffix = hashSuffix || `-${contentHash(value)}`;
  const fallbackStemBytes = Math.max(1, maxBytes - byteLength(fallbackSuffix));
  return `${truncateUtf8(fallback, fallbackStemBytes) || "file"}${fallbackSuffix}`;
}

export function sanitizeLocalPathSegment(value: string, options: SafePathSegmentOptions): string {
  const wellFormed = toWellFormedUnicode(value);
  const trimmed = wellFormed.trim();
  let sanitized = trimmed
    .replace(/[\0-\x1f\x7f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[\\/]+/g, "_")
    .trim();

  let changed = sanitized !== value;
  if (!sanitized || /^\.+$/.test(sanitized)) {
    sanitized = options.fallback;
    changed = true;
  }

  const tooLong = byteLength(sanitized) > options.maxBytes;
  const needsHash = options.disambiguateOnChange ? changed || tooLong : tooLong;
  const hashSuffix = needsHash ? `-${contentHash(options.hashInput ?? value)}` : "";
  const fitted = fitSegmentToBytes(
    sanitized,
    options.maxBytes,
    hashSuffix,
    options.preserveExtension === true,
    options.fallback,
  );

  return !fitted || /^\.+$/.test(fitted) ? `${options.fallback}-${contentHash(value)}` : fitted;
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);

  return (
    relative === "" ||
    (!!relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function nearestExistingAncestor(candidatePath: string): string {
  let current = path.resolve(candidatePath);

  for (;;) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

export function resolvePathInsideReal(
  parentPath: string,
  candidatePath: string,
  parameterName = "localPath",
  allowedDescription = "an allowed directory",
): string {
  const parentReal = fs.realpathSync.native(parentPath);
  const resolvedCandidate = path.resolve(candidatePath);
  let existingAncestor: string;
  try {
    existingAncestor = nearestExistingAncestor(resolvedCandidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENAMETOOLONG") {
      throw new Error(`${parameterName} is too long.`);
    }
    throw error;
  }
  const ancestorReal = fs.realpathSync.native(existingAncestor);
  const remainder = path.relative(existingAncestor, resolvedCandidate);
  const effectiveCandidate = path.resolve(ancestorReal, remainder);

  if (!isPathInside(parentReal, effectiveCandidate)) {
    throw new Error(`${parameterName} must stay within ${allowedDescription}.`);
  }

  return resolvedCandidate;
}

function atomicTempPath(filePath: string): string {
  const directory = path.dirname(filePath);
  const name = path.basename(filePath);
  const nonce = crypto.randomBytes(8).toString("hex");
  return path.join(directory, `.${name}.${process.pid}.${Date.now()}.${nonce}.tmp`);
}

async function publishTempFile(
  tempPath: string,
  destinationPath: string,
  overwrite: boolean,
): Promise<void> {
  if (overwrite) {
    await fs.promises.rename(tempPath, destinationPath);
    return;
  }

  await fs.promises.link(tempPath, destinationPath);
  await fs.promises.unlink(tempPath);
}

export async function writeBufferAtomically(
  destinationPath: string,
  content: Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const overwrite = options.overwrite !== false;
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = atomicTempPath(destinationPath);

  try {
    await fs.promises.writeFile(tempPath, content, { flag: "wx" });
    await publishTempFile(tempPath, destinationPath, overwrite);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeReadableStreamAtomically(
  destinationPath: string,
  stream: ReadableStream<Uint8Array>,
  options: AtomicWriteOptions = {},
): Promise<number> {
  const overwrite = options.overwrite !== false;
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = atomicTempPath(destinationPath);
  const handle = await fs.promises.open(tempPath, "wx");
  let size = 0;

  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        await handle.write(value);
        size += value.byteLength;
      }
    }

    await handle.close();
    await publishTempFile(tempPath, destinationPath, overwrite);
    return size;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}
