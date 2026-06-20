/**
 * Shared pre-signed URL bounds.
 *
 * Kept outside tool definitions and operations so declarative metadata does
 * not import operation execution logic.
 *
 * @module tools/presignUrlConstants
 */

export const MAX_PRESIGN_URL_EXPIRATION_SECONDS = 604800;
export const DEFAULT_PRESIGN_URL_EXPIRATION_SECONDS = 3600;
