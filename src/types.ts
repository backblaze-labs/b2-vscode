/**
 * B2 API response types and shared interfaces.
 *
 * Derived from the Backblaze B2 REST API and the jupyter-b2 Python SDK.
 *
 * @module types
 */

/** Allowed capabilities returned from B2 authorization. */
export interface B2Allowed {
  capabilities: string[];
  bucketId?: string | null;
  bucketName?: string | null;
  namePrefix?: string | null;
}

/** Storage API info nested inside the v3 authorize response. */
export interface B2StorageApi {
  apiUrl: string;
  downloadUrl: string;
  s3ApiUrl: string;
  recommendedPartSize: number;
  absoluteMinimumPartSize: number;
  capabilities: string[];
  bucketId?: string | null;
  bucketName?: string | null;
  namePrefix?: string | null;
}

/** Raw response from b2_authorize_account (v3 API). */
export interface B2AuthResponseRaw {
  accountId: string;
  authorizationToken: string;
  apiInfo: {
    storageApi: B2StorageApi;
  };
}

/** Flattened auth response used internally. */
export interface B2AuthResponse {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  recommendedPartSize: number;
  absoluteMinimumPartSize: number;
  allowed: B2Allowed;
}

/** A single B2 bucket. */
export interface B2Bucket {
  bucketId: string;
  bucketName: string;
  bucketType: "allPublic" | "allPrivate" | "snapshot" | string;
  bucketInfo: Record<string, string>;
  revision: number;
}

/** Response from b2_list_buckets. */
export interface B2ListBucketsResponse {
  buckets: B2Bucket[];
}

/** A single file or folder entry from B2. */
export interface B2FileInfo {
  fileId: string;
  fileName: string;
  contentLength: number;
  contentType: string;
  uploadTimestamp: number;
  action: "upload" | "hide" | "start" | "folder";
}

/** Response from b2_list_file_names. */
export interface B2ListFileNamesResponse {
  files: B2FileInfo[];
  nextFileName: string | null;
}

/** Extension-level authentication state. */
export interface B2AuthState {
  isAuthenticated: boolean;
  accountId?: string;
  apiUrl?: string;
  downloadUrl?: string;
  error?: string;
}
