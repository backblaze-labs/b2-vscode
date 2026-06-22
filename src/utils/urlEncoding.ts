/**
 * URL encoding helpers for B2 object names and authorization tokens.
 *
 * @module utils/urlEncoding
 */

import { toWellFormedString } from "./strings";

/**
 * RFC 3986 component encoding. encodeURIComponent leaves a few reserved
 * sub-delimiters untouched, so encode them explicitly.
 */
export function encodeUrlComponent(value: string): string {
  return encodeURIComponent(toWellFormedString(value)).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeB2FileNameForUrl(fileName: string): string {
  return fileName.split("/").map(encodeUrlComponent).join("/");
}

export function buildB2DownloadUrl(
  downloadUrl: string,
  bucketName: string,
  fileName: string,
  authorizationToken: string,
): string {
  const baseUrl = downloadUrl.replace(/\/+$/, "");
  return `${baseUrl}/file/${encodeUrlComponent(bucketName)}/${encodeB2FileNameForUrl(fileName)}?Authorization=${encodeUrlComponent(authorizationToken)}`;
}
