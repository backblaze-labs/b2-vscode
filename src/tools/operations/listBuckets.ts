/**
 * List Buckets operation.
 *
 * @module tools/operations/listBuckets
 */

import type { B2ToolOperation, ToolExtras } from "../types";

interface ListBucketsResult {
  buckets: Array<{ name: string; type: string; id: string }>;
  count: number;
}

export const listBucketsOperation: B2ToolOperation<unknown, ListBucketsResult> = {
  async execute(_params: unknown, extras: ToolExtras): Promise<ListBucketsResult> {
    const client = extras.getClient();
    if (!client) {
      throw new Error("Not authenticated. Please run the B2: Authenticate command first.");
    }

    const buckets = await client.listBuckets();
    return {
      buckets: buckets.map((b) => ({
        name: b.name,
        type: b.info.bucketType,
        id: b.id,
      })),
      count: buckets.length,
    };
  },
};
