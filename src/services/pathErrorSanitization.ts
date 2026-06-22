/**
 * Helpers for redacting local filesystem paths from user-facing errors.
 *
 * @module services/pathErrorSanitization
 */

export interface PathMessageReplacement {
  readonly search?: string;
  readonly replacement: string;
}

function replaceLiteral(value: string, search: string | undefined, replacement: string): string {
  return search ? value.replaceAll(search, replacement) : value;
}

export function sanitizePathError(
  error: unknown,
  replacements: readonly PathMessageReplacement[],
  mapErrnoPath: (pathValue: string) => string,
): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const errnoError = error as NodeJS.ErrnoException;
  const allReplacements = [...replacements];
  if (typeof errnoError.path === "string") {
    allReplacements.unshift({
      search: errnoError.path,
      replacement: mapErrnoPath(errnoError.path),
    });
  }

  let message = error.message;
  for (const { search, replacement } of allReplacements) {
    message = replaceLiteral(message, search, replacement);
  }
  if (message === error.message) {
    return error;
  }

  const sanitized = new Error(message);
  sanitized.name = error.name;
  if (typeof errnoError.code === "string") {
    (sanitized as NodeJS.ErrnoException).code = errnoError.code;
  }
  if (typeof errnoError.errno === "number") {
    (sanitized as NodeJS.ErrnoException).errno = errnoError.errno;
  }
  if (typeof errnoError.syscall === "string") {
    (sanitized as NodeJS.ErrnoException).syscall = errnoError.syscall;
  }
  if (typeof errnoError.path === "string") {
    (sanitized as NodeJS.ErrnoException).path = mapErrnoPath(errnoError.path);
  }
  return sanitized;
}
