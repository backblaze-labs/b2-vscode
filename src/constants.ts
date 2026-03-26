/**
 * Application constants — endpoints, keys, and identifiers.
 *
 * @module constants
 */

// ── B2 API ──────────────────────────────────────────────────────────────────

export const B2_DEFAULT_API_URL = "https://api.backblazeb2.com";

export const B2_API_AUTHORIZE = "/b2api/v3/b2_authorize_account";
export const B2_API_LIST_BUCKETS = "/b2api/v3/b2_list_buckets";
export const B2_API_LIST_FILE_NAMES = "/b2api/v3/b2_list_file_names";
export const B2_API_DELETE_FILE_VERSION = "/b2api/v3/b2_delete_file_version";
export const B2_API_GET_UPLOAD_URL = "/b2api/v3/b2_get_upload_url";
export const B2_API_GET_DOWNLOAD_AUTHORIZATION = "/b2api/v3/b2_get_download_authorization";
export const B2_API_CREATE_BUCKET = "/b2api/v3/b2_create_bucket";
export const B2_API_UPDATE_BUCKET = "/b2api/v3/b2_update_bucket";
export const B2_API_DELETE_BUCKET = "/b2api/v3/b2_delete_bucket";
export const B2_API_COPY_FILE = "/b2api/v3/b2_copy_file";
export const B2_API_LIST_FILE_VERSIONS = "/b2api/v3/b2_list_file_versions";

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

// ── Temp File Directory ─────────────────────────────────────────────────────

export const TEMP_DIR_NAME = "b2-vscode";

// ── File listing ────────────────────────────────────────────────────────────

export const MAX_FILE_COUNT = 1000;
