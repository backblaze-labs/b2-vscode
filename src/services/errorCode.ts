export function getErrorCode(error: unknown): string | undefined {
  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof errorCode === "string" ? errorCode : undefined;
}
