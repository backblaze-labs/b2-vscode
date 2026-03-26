/**
 * List Buckets tool definition.
 *
 * @module tools/definitions/listBuckets
 */

import type { B2ToolDefinition } from "../types";

export const listBucketsTool: B2ToolDefinition = {
  name: "b2_listBuckets",
  displayName: "B2: List Buckets",
  description:
    "Lists all Backblaze B2 buckets accessible by the authenticated account. Returns bucket names, types (allPublic/allPrivate), and IDs.",
  parameters: {
    type: "object",
    properties: {},
  },
  tags: ["b2", "bucket", "list"],
};
