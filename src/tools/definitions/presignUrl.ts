/**
 * Pre-sign URL tool definition.
 *
 * @module tools/definitions/presignUrl
 */

import type { B2ToolDefinition } from "../types";
import { inputText } from "./inputText";
import { MAX_PRESIGN_URL_EXPIRES_IN_SECONDS } from "../presignUrlLimits";

export const presignUrlTool: B2ToolDefinition = {
  name: "b2_presignUrl",
  displayName: "B2: Pre-sign URL",
  description:
    "Generates a pre-signed download URL for one file in a B2 bucket. Folder-prefix and bucket-wide authorization tokens are rejected. The URL is valid for the specified duration (default: 1 hour).",
  parameters: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Name of the B2 bucket containing the file.",
      },
      path: {
        type: "string",
        description:
          'Full single-file path within the bucket. Must not be empty or end with "/". Example: "reports/q4.pdf"',
      },
      expiresIn: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PRESIGN_URL_EXPIRES_IN_SECONDS,
        description:
          "URL validity duration in seconds. Default: 3600 (1 hour). Maximum: 604800 (7 days).",
      },
    },
    required: ["bucket", "path"],
  },
  tags: ["b2", "file", "presign", "url"],
  risk: "exfiltration",
  describeEffect: (input) =>
    `create a shareable download URL for b2://${inputText(input.bucket)}/${inputText(input.path)}`,
};
