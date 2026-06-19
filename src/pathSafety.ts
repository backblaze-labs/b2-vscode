/**
 * Shared helpers for deriving local paths and URL components from untrusted B2
 * object names and language model tool inputs.
 *
 * @module pathSafety
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { B2ToolInputError } from "./errors";

const HASH_LENGTH = 16;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const STALE_ATOMIC_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ATOMIC_TEMP_FILE_PATTERN = /^\..+\.\d+\.\d+\.[a-f0-9]{16}\.tmp$/;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

export interface SafePathSegmentOptions {
  fallback: string;
  maxBytes: number;
  hashInput?: string;
  disambiguateOnChange?: boolean;
  preserveExtension?: boolean;
}

export interface AtomicWriteOptions {
  overwrite?: boolean;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

export class PathContainmentError extends Error {
  readonly code = "ERR_PATH_CONTAINMENT";

  constructor(parameterName: string, allowedDescription: string) {
    super(`${parameterName} must stay within ${allowedDescription}.`);
    this.name = "PathContainmentError";
  }
}

class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Download stream stalled for ${timeoutMs}ms.`);
    this.name = "StreamIdleTimeoutError";
  }
}

function codedLocalError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
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
  return encodeUrlComponent(value);
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

function avoidWindowsReservedBasename(segment: string): string {
  return WINDOWS_RESERVED_BASENAME.test(segment) ? `_${segment}` : segment;
}

export function sanitizeLocalPathSegment(value: string, options: SafePathSegmentOptions): string {
  const wellFormed = toWellFormedUnicode(value);
  const trimmed = wellFormed.trim();
  let sanitized = trimmed
    .replace(/[\0-\x1f\x7f]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[\\/]+/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();

  let changed = sanitized !== value;
  const portable = avoidWindowsReservedBasename(sanitized);
  if (portable !== sanitized) {
    sanitized = portable;
    changed = true;
  }

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

export function safeLocalBasename(value: string, options: SafePathSegmentOptions): string {
  const basename = path.posix.basename(value.replace(/\\/g, "/"));
  return sanitizeLocalPathSegment(basename, options);
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
      throw codedLocalError(`${parameterName} is too long.`, "ENAMETOOLONG");
    }
    throw error;
  }
  const ancestorReal = fs.realpathSync.native(existingAncestor);
  const remainder = path.relative(existingAncestor, resolvedCandidate);
  const effectiveCandidate = path.resolve(ancestorReal, remainder);

  if (!isPathInside(parentReal, effectiveCandidate)) {
    throw new PathContainmentError(parameterName, allowedDescription);
  }

  return effectiveCandidate;
}

function validatePrivateDirectoryStat(directoryPath: string, stat: fs.Stats): void {
  if (!stat.isDirectory()) {
    throw codedLocalError(`${directoryPath} must be a directory.`, "ENOTDIR");
  }
  if (process.platform === "win32") {
    return;
  }

  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid()) {
    throw codedLocalError(`${directoryPath} is not owned by the current user.`, "EPERM");
  }
}

export async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await fs.promises.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directoryPath);
  validatePrivateDirectoryStat(directoryPath, stat);

  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    await fs.promises.chmod(directoryPath, 0o700);
  }
}

export function ensurePrivateDirectorySync(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directoryPath);
  validatePrivateDirectoryStat(directoryPath, stat);

  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fs.chmodSync(directoryPath, 0o700);
  }
}

export async function sweepStaleAtomicTempFiles(
  directoryPath: string,
  maxAgeMs = STALE_ATOMIC_TEMP_MAX_AGE_MS,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && ATOMIC_TEMP_FILE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const tempPath = path.join(directoryPath, entry.name);
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(tempPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
          }
          throw error;
        }
        if (stat.mtimeMs < cutoff) {
          await fs.promises.rm(tempPath, { force: true });
        }
      }),
  );
}

export async function readFileNoFollow(filePath: string): Promise<Buffer> {
  const stat = await fs.promises.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new B2ToolInputError(`${filePath} must not be a symbolic link.`);
  }

  const noFollow = fs.constants.O_NOFOLLOW;
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (noFollow ?? 0));

  try {
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
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
    try {
      await fs.promises.rename(tempPath, destinationPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EACCES", "EEXIST", "EPERM"].includes(code ?? "")) {
        throw error;
      }
      await fs.promises.rm(destinationPath, { force: true });
      await fs.promises.rename(tempPath, destinationPath);
    }
    return;
  }

  try {
    await fs.promises.link(tempPath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw error;
    }
    await fs.promises.copyFile(tempPath, destinationPath, fs.constants.COPYFILE_EXCL);
  }
  await fs.promises.unlink(tempPath);
}

async function writeChunkFully(handle: fs.promises.FileHandle, chunk: Uint8Array): Promise<number> {
  const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let written = 0;

  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written);
    if (result.bytesWritten === 0) {
      throw new Error("File write made no progress.");
    }
    written += result.bytesWritten;
  }

  return written;
}

export async function writeBufferAtomically(
  destinationPath: string,
  content: Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const overwrite = options.overwrite !== false;
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await sweepStaleAtomicTempFiles(path.dirname(destinationPath));
  const tempPath = atomicTempPath(destinationPath);

  try {
    await fs.promises.writeFile(tempPath, content, { flag: "wx", mode: 0o600 });
    await publishTempFile(tempPath, destinationPath, overwrite);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<StreamReadResult> {
  if (signal?.aborted) {
    throw new Error("Download stream was aborted.");
  }

  let timeout: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new StreamIdleTimeoutError(timeoutMs)), timeoutMs);
  });
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error("Download stream was aborted."));
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : undefined;

  try {
    return await Promise.race(
      [reader.read(), timeoutPromise, abortPromise].filter(
        (promise): promise is Promise<StreamReadResult> | Promise<never> => promise !== undefined,
      ),
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

export async function writeReadableStreamAtomically(
  destinationPath: string,
  stream: ReadableStream<Uint8Array>,
  options: AtomicWriteOptions = {},
): Promise<number> {
  const overwrite = options.overwrite !== false;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  let tempPath: string | undefined;
  let handle: fs.promises.FileHandle | undefined;
  let size = 0;
  const reader = stream.getReader();

  try {
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await sweepStaleAtomicTempFiles(path.dirname(destinationPath));
    tempPath = atomicTempPath(destinationPath);
    handle = await fs.promises.open(tempPath, "wx", 0o600);

    for (;;) {
      const { done, value } = await readWithTimeout(reader, idleTimeoutMs, options.signal);
      if (done) {
        break;
      }
      if (value) {
        size += await writeChunkFully(handle, value);
      }
    }

    await handle.close();
    handle = undefined;
    await publishTempFile(tempPath, destinationPath, overwrite);
    return size;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (tempPath) {
      await fs.promises.rm(tempPath, { force: true });
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best-effort release after successful completion or cancellation.
    }
  }
}
