/**
 * Pre-sign URL tool definition.
 *
 * @module tools/definitions/presignUrl
 */

import type { B2ToolDefinition } from "../types";

export const presignUrlTool: B2ToolDefinition = {
  name: "b2_presignUrl",
  displayName: "B2: Pre-sign URL",
  description:
    "Generates a pre-signed download URL for a file in a B2 bucket. The URL is valid for the specified duration (default: 1 hour).",
  parameters: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Name of the B2 bucket containing the file.",
      },
      path: {
        type: "string",
        description: 'Full file path within the bucket. Example: "reports/q4.pdf"',
      },
      expiresIn: {
        type: "number",
        description:
          "URL validity duration in seconds. Default: 3600 (1 hour). Maximum: 604800 (7 days).",
      },
    },
    required: ["bucket", "path"],
  },
  tags: ["b2", "file", "presign", "url"],
};
