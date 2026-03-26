/**
 * B2 REST API client.
 *
 * Pure HTTP client using Node.js built-in `https` module.
 * Handles authorization, token refresh, and all B2 API calls.
 *
 * @module services/b2Client
 */

import * as https from "https";
import * as http from "http";
import {
  B2_DEFAULT_API_URL,
  B2_API_AUTHORIZE,
  B2_API_LIST_BUCKETS,
  B2_API_LIST_FILE_NAMES,
  B2_API_DELETE_FILE_VERSION,
  B2_API_GET_DOWNLOAD_AUTHORIZATION,
  B2_API_GET_UPLOAD_URL,
  B2_API_CREATE_BUCKET,
  B2_API_UPDATE_BUCKET,
  B2_API_DELETE_BUCKET,
  B2_API_COPY_FILE,
  B2_API_LIST_FILE_VERSIONS,
  MAX_FILE_COUNT,
} from "../constants";
import type {
  B2AuthResponse,
  B2AuthResponseRaw,
  B2Bucket,
  B2FileInfo,
  B2ListBucketsResponse,
  B2ListFileNamesResponse,
} from "../types";

/**
 * Backblaze B2 REST API client.
 */
export class B2Client {
  private keyId: string;
  private appKey: string;

  private authorizationToken = "";
  private apiUrl = "";
  private downloadUrl = "";
  private accountId = "";

  constructor(keyId: string, appKey: string) {
    this.keyId = keyId;
    this.appKey = appKey;
  }

  /** Whether the client has been authorized. */
  get isAuthorized(): boolean {
    return this.authorizationToken.length > 0;
  }

  /** The account ID from the last authorization. */
  getAccountId(): string {
    return this.accountId;
  }

  /** The download URL from the last authorization. */
  getDownloadUrl(): string {
    return this.downloadUrl;
  }

  /** The API URL from the last authorization. */
  getApiUrl(): string {
    return this.apiUrl;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Authorize with B2 using the stored key ID and application key.
   * Must be called before any other API method.
   */
  async authorize(): Promise<B2AuthResponse> {
    const credentials = Buffer.from(`${this.keyId}:${this.appKey}`).toString("base64");
    const url = `${B2_DEFAULT_API_URL}${B2_API_AUTHORIZE}`;

    const raw = await this.postJson<B2AuthResponseRaw>(
      url,
      {},
      {
        Authorization: `Basic ${credentials}`,
      },
    );

    // Flatten v3 nested response into our internal format
    const storage = raw.apiInfo.storageApi;
    const result: B2AuthResponse = {
      accountId: raw.accountId,
      authorizationToken: raw.authorizationToken,
      apiUrl: storage.apiUrl,
      downloadUrl: storage.downloadUrl,
      recommendedPartSize: storage.recommendedPartSize,
      absoluteMinimumPartSize: storage.absoluteMinimumPartSize,
      allowed: {
        capabilities: storage.capabilities,
        bucketId: storage.bucketId,
        bucketName: storage.bucketName,
        namePrefix: storage.namePrefix,
      },
    };

    this.authorizationToken = result.authorizationToken;
    this.apiUrl = result.apiUrl;
    this.downloadUrl = result.downloadUrl;
    this.accountId = result.accountId;

    return result;
  }

  /**
   * List all buckets visible to the authorized account.
   */
  async listBuckets(): Promise<B2Bucket[]> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_LIST_BUCKETS}`;
    const result = await this.authedPost<B2ListBucketsResponse>(url, {
      accountId: this.accountId,
    });
    return result.buckets;
  }

  /**
   * Create a new bucket.
   */
  async createBucket(
    bucketName: string,
    bucketType: "allPublic" | "allPrivate",
  ): Promise<B2Bucket> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_CREATE_BUCKET}`;
    return this.authedPost<B2Bucket>(url, {
      accountId: this.accountId,
      bucketName,
      bucketType,
    });
  }

  /**
   * Update a bucket's type (visibility).
   */
  async updateBucket(bucketId: string, bucketType: "allPublic" | "allPrivate"): Promise<B2Bucket> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_UPDATE_BUCKET}`;
    return this.authedPost<B2Bucket>(url, {
      accountId: this.accountId,
      bucketId,
      bucketType,
    });
  }

  /**
   * Delete a bucket. The bucket must be empty first.
   */
  async deleteBucket(bucketId: string): Promise<void> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_DELETE_BUCKET}`;
    await this.authedPost(url, {
      accountId: this.accountId,
      bucketId,
    });
  }

  /**
   * Copy a file within the same bucket (server-side copy, no data transfer).
   */
  async copyFile(
    sourceFileId: string,
    destinationBucketId: string,
    newFileName: string,
  ): Promise<B2FileInfo> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_COPY_FILE}`;
    return this.authedPost<B2FileInfo>(url, {
      sourceFileId,
      destinationBucketId,
      fileName: newFileName,
    });
  }

  /**
   * List all file versions in a bucket (needed to delete all versions of a file).
   */
  async listFileVersions(bucketId: string, prefix?: string): Promise<B2FileInfo[]> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_LIST_FILE_VERSIONS}`;
    const allFiles: B2FileInfo[] = [];
    let startFileId: string | null = null;
    let startFileName: string | null = null;

    do {
      const body: Record<string, unknown> = {
        bucketId,
        maxFileCount: MAX_FILE_COUNT,
      };
      if (prefix) {
        body.prefix = prefix;
      }
      if (startFileName) {
        body.startFileName = startFileName;
        body.startFileId = startFileId;
      }

      const result = await this.authedPost<{
        files: B2FileInfo[];
        nextFileId: string | null;
        nextFileName: string | null;
      }>(url, body);

      allFiles.push(...result.files);
      startFileId = result.nextFileId;
      startFileName = result.nextFileName;
    } while (startFileName !== null);

    return allFiles;
  }

  /**
   * Delete all versions of all files with a given prefix (used for folder deletion).
   */
  async deleteAllFilesWithPrefix(bucketId: string, prefix: string): Promise<number> {
    const files = await this.listFileVersions(bucketId, prefix);
    for (const file of files) {
      await this.deleteFileVersion(file.fileId, file.fileName);
    }
    return files.length;
  }

  /**
   * List file names in a bucket with optional prefix and delimiter.
   *
   * When `delimiter` is `"/"`, B2 returns virtual folder entries
   * (`action: "folder"`) alongside real files — enabling tree-style browsing.
   */
  async listFileNames(
    bucketId: string,
    prefix?: string,
    delimiter?: string,
    startFileName?: string,
    maxFileCount: number = MAX_FILE_COUNT,
  ): Promise<B2ListFileNamesResponse> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_LIST_FILE_NAMES}`;

    const body: Record<string, unknown> = {
      bucketId,
      maxFileCount,
    };
    if (prefix !== undefined) {
      body.prefix = prefix;
    }
    if (delimiter !== undefined) {
      body.delimiter = delimiter;
    }
    if (startFileName !== undefined) {
      body.startFileName = startFileName;
    }

    return this.authedPost<B2ListFileNamesResponse>(url, body);
  }

  /**
   * List ALL files at a given prefix (handles pagination).
   */
  async listAllFileNames(
    bucketId: string,
    prefix?: string,
    delimiter?: string,
  ): Promise<B2FileInfo[]> {
    const allFiles: B2FileInfo[] = [];
    let nextFileName: string | null = null;

    do {
      const response = await this.listFileNames(
        bucketId,
        prefix,
        delimiter,
        nextFileName ?? undefined,
      );
      allFiles.push(...response.files);
      nextFileName = response.nextFileName;
    } while (nextFileName !== null);

    return allFiles;
  }

  /**
   * Download a file by bucket name and file name.
   * Returns the raw file content as a Buffer.
   */
  async downloadFile(bucketName: string, fileName: string): Promise<Buffer> {
    await this.ensureAuthorized();
    const url = `${this.downloadUrl}/file/${bucketName}/${fileName}`;
    return this.getBuffer(url);
  }

  /**
   * Delete a file version by file ID and file name.
   */
  async deleteFileVersion(fileId: string, fileName: string): Promise<void> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_DELETE_FILE_VERSION}`;
    await this.authedPost(url, { fileId, fileName });
  }

  /**
   * Get an upload URL for a specific bucket.
   */
  async getUploadUrl(bucketId: string): Promise<{ uploadUrl: string; authorizationToken: string }> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_GET_UPLOAD_URL}`;
    return this.authedPost(url, { bucketId });
  }

  /**
   * Upload a file to B2 using the upload URL obtained from getUploadUrl.
   */
  async uploadFile(
    bucketId: string,
    fileName: string,
    data: Buffer,
    contentType = "b2/x-auto",
  ): Promise<B2FileInfo> {
    const { uploadUrl, authorizationToken } = await this.getUploadUrl(bucketId);

    const crypto = await import("crypto");
    const sha1 = crypto.createHash("sha1").update(data).digest("hex");

    return new Promise((resolve, reject) => {
      const parsed = new URL(uploadUrl);
      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          Authorization: authorizationToken,
          "Content-Type": contentType,
          "Content-Length": data.length,
          "X-Bz-File-Name": encodeURIComponent(fileName),
          "X-Bz-Content-Sha1": sha1,
        },
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(body) as B2FileInfo);
          } else {
            reject(new Error(`B2 upload failed (${res.statusCode}): ${body}`));
          }
        });
      });

      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * Get a download authorization token for a specific file prefix.
   */
  async getDownloadAuthorization(
    bucketId: string,
    fileNamePrefix: string,
    validDurationInSeconds = 3600,
  ): Promise<string> {
    await this.ensureAuthorized();
    const url = `${this.apiUrl}${B2_API_GET_DOWNLOAD_AUTHORIZATION}`;
    const result = await this.authedPost<{ authorizationToken: string }>(url, {
      bucketId,
      fileNamePrefix,
      validDurationInSeconds,
    });
    return result.authorizationToken;
  }

  /**
   * Get a pre-signed download URL for a file.
   */
  async presignUrl(
    bucketName: string,
    bucketId: string,
    fileName: string,
    validDurationInSeconds = 3600,
  ): Promise<string> {
    const token = await this.getDownloadAuthorization(bucketId, fileName, validDurationInSeconds);
    return `${this.downloadUrl}/file/${bucketName}/${fileName}?Authorization=${token}`;
  }

  /**
   * Get file info by listing with exact prefix and picking the match.
   */
  async getFileInfo(bucketId: string, fileName: string): Promise<B2FileInfo | null> {
    const response = await this.listFileNames(bucketId, fileName, undefined, undefined, 1);
    const match = response.files.find((f) => f.fileName === fileName);
    return match ?? null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async ensureAuthorized(): Promise<void> {
    if (!this.isAuthorized) {
      await this.authorize();
    }
  }

  /**
   * POST with the current authorization token, retrying once on 401.
   */
  private async authedPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
    try {
      return await this.postJson<T>(url, body, {
        Authorization: this.authorizationToken,
      });
    } catch (error) {
      if (error instanceof B2ApiError && error.status === 401) {
        await this.authorize();
        return this.postJson<T>(url, body, {
          Authorization: this.authorizationToken,
        });
      }
      throw error;
    }
  }

  /**
   * Generic JSON POST helper using Node.js https.
   */
  private postJson<T>(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const parsed = new URL(url);

      const transport = parsed.protocol === "https:" ? https : http;
      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(responseBody) as T);
          } else {
            reject(
              new B2ApiError(
                `B2 API error (${res.statusCode}): ${responseBody}`,
                res.statusCode ?? 0,
              ),
            );
          }
        });
      });

      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * GET a URL and return the raw response as a Buffer.
   */
  private getBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === "https:" ? https : http;

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          Authorization: this.authorizationToken,
        },
      };

      const req = transport.request(options, (res) => {
        if (res.statusCode === 401) {
          // Consume the response and retry after re-auth
          res.resume();
          this.authorize()
            .then(() => this.getBuffer(url))
            .then(resolve)
            .catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new B2ApiError(`B2 download failed (${res.statusCode})`, res.statusCode ?? 0));
          }
        });
      });

      req.on("error", reject);
      req.end();
    });
  }
}

/**
 * Custom error class for B2 API errors with HTTP status code.
 */
export class B2ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "B2ApiError";
  }
}
