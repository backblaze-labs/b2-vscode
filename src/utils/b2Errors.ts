/**
 * Shared B2 SDK error-shape predicates.
 *
 * @module utils/b2Errors
 */

export function isMissingCapabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const details = error as Error & { code?: string };
  return String(details.code ?? "").toLowerCase() === "missing_capability";
}
