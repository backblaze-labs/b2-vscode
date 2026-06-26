/**
 * Application constants: keys, identifiers, and limits.
 *
 * B2 API endpoints are owned by `@backblaze-labs/b2-sdk`, not this file.
 *
 * @module constants
 */

// ── Environment Variables ───────────────────────────────────────────────────

export const ENV_KEY_ID = "B2_APPLICATION_KEY_ID";
export const ENV_APP_KEY = "B2_APPLICATION_KEY";

// ── VS Code SecretStorage Keys ──────────────────────────────────────────────

export const SECRET_KEY_ID = "b2.applicationKeyId";
export const SECRET_APP_KEY = "b2.applicationKey";

// ── VS Code Context Keys ────────────────────────────────────────────────────

export const CTX_AUTHENTICATED = "b2.authenticated";

// ── View IDs ────────────────────────────────────────────────────────────────

export const VIEW_BUCKETS = "b2Buckets";
export const VIEW_APPLICATION_KEYS = "b2ApplicationKeys";

// ── Temp File Directory ─────────────────────────────────────────────────────

export const TEMP_DIR_NAME = "b2-vscode";
export const TEMP_CACHE_DIR_NAME = "cache";
export const TEMP_TOOLS_DIR_NAME = "tools";

// ── File listing ────────────────────────────────────────────────────────────

export const MAX_FILE_COUNT = 1000;
export const TREE_LIST_PAGE_SIZE = 200;
export const TREE_LIST_HARD_CAP = 1000;
export const LIST_FILES_DEFAULT_LIMIT = 200;
export const LIST_FILES_RECURSIVE_DEFAULT_LIMIT = 100;
export const LIST_FILES_LIMIT_CAP = 1000;
export const LIST_FILES_RECURSIVE_LIMIT_CAP = 500;
