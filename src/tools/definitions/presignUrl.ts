/**
 * Pre-sign URL tool definition.
 *
 * @module tools/definitions/presignUrl
 */

import type { B2ToolDefinition } from "../types";
import { inputText } from "./inputText";
import {
  DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS,
  MAX_PRESIGN_URL_EXPIRES_IN_SECONDS,
} from "../presignUrlLimits";

export const presignUrlTool: B2ToolDefinition = {
  name: "b2_presignUrl",
  displayName: "B2: Pre-sign URL",
  description:
    "Generates a pre-signed B2 download URL using a name-prefix authorization token. The token can download any object whose name starts with the supplied path. The URL is valid for the specified duration (default: 5 minutes).",
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
          'B2 object name prefix to authorize. Supplying a full file name still grants prefix scope, so "reports/q4.pdf" also authorizes names such as "reports/q4.pdf.bak". Must not be empty or end with "/".',
      },
      expiresIn: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PRESIGN_URL_EXPIRES_IN_SECONDS,
        description: `URL validity duration in seconds. Default: ${DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS} (5 minutes). Maximum: ${MAX_PRESIGN_URL_EXPIRES_IN_SECONDS} (7 days).`,
      },
    },
    required: ["bucket", "path"],
  },
  tags: ["b2", "file", "presign", "url"],
  risk: "exfiltration",
  describeEffect: (input) =>
    `create a shareable prefix-scoped download URL for b2://${inputText(input.bucket)}/${inputText(input.path)}`,
};
