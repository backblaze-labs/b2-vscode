/**
 * B2 SDK client construction and small stream helpers.
 *
 * The extension talks to Backblaze B2 through the official
 * `@backblaze-labs/b2-sdk` high-level facade. This module owns the one place we
 * construct that client (so the custom User-Agent is set consistently) plus a
 * helper to drain a download stream into a Buffer.
 *
 * @module services/b2
 */

import { B2Client } from "@backblaze-labs/b2-sdk";
import type { B2Credentials } from "./authService";

/**
 * Create a B2 SDK client for the given credentials.
 *
 * Call {@link B2Client.authorize} on the result before issuing other requests.
 * The SDK appends its own product token, so the final User-Agent looks like
 * `b2-vscode/<version> b2-sdk-typescript/<version> (...)`.
 */
export function createB2Client(credentials: B2Credentials, version: string): B2Client {
  return new B2Client({
    applicationKeyId: credentials.keyId,
    applicationKey: credentials.appKey,
    userAgent: `b2-vscode/${version}`,
  });
}

/**
 * Drain a web `ReadableStream<Uint8Array>` (e.g. a B2 download body) into a Buffer.
 */
export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks);
}
