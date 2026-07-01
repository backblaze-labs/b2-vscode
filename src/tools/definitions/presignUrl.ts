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
} from "../../services/shareLinkLimits";

function describeExpiresIn(value: unknown): string {
  if (value === undefined) {
    return `${DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS} seconds`;
  }
  if (
    Number.isInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= MAX_PRESIGN_URL_EXPIRES_IN_SECONDS
  ) {
    return `${Number(value)} seconds`;
  }
  return "an invalid expiresIn value that the operation will reject";
}

export const presignUrlTool: B2ToolDefinition = {
  name: "b2_presignUrl",
  displayName: "B2: Pre-sign URL",
  description:
    "Generates a pre-signed B2 download URL after verifying the path currently names one object and no adjacent same-prefix object. Requires the B2 listFiles capability for verification and the B2 shareFiles capability to mint the download authorization. B2 tokens remain prefix-scoped: the URL can download any object whose name starts with the supplied path until it expires.",
  parameters: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Name of the B2 bucket containing the file.",
      },
      path: {
        type: "string",
        minLength: 1,
        description:
          'B2 object name to authorize. The path must currently match exactly one downloadable object and no other current object may start with that value. B2 still grants prefix scope, so future names such as "reports/q4.pdf.bak" may also be authorized until expiry.',
      },
      expiresIn: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PRESIGN_URL_EXPIRES_IN_SECONDS,
        default: DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS,
        description: `URL validity duration in seconds. Default: ${DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS} (5 minutes). Maximum: ${MAX_PRESIGN_URL_EXPIRES_IN_SECONDS} (7 days).`,
      },
    },
    required: ["bucket", "path"],
  },
  tags: ["b2", "file", "presign", "url"],
  risk: "exfiltration",
  describeEffect: (input) =>
    `create a shareable prefix-scoped download URL for b2://${inputText(input.bucket)}/${inputText(input.path)} that is valid for ${describeExpiresIn(input.expiresIn)} and authorizes ALL object names beginning with that path, not just this file`,
};
