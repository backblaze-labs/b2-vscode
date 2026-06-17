/**
 * Get File Info tool definition.
 *
 * @module tools/definitions/getFileInfo
 */

import type { B2ToolDefinition } from "../types";
import { inputText } from "./inputText";

export const getFileInfoTool: B2ToolDefinition = {
  name: "b2_getFileInfo",
  displayName: "B2: Get File Info",
  description:
    "Gets metadata for a specific file in a B2 bucket, including size, content type, upload timestamp, and file ID.",
  parameters: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Name of the B2 bucket containing the file.",
      },
      path: {
        type: "string",
        description: 'Full file path within the bucket. Example: "data/train.csv"',
      },
    },
    required: ["bucket", "path"],
  },
  tags: ["b2", "file", "info", "metadata"],
  risk: "readOnly",
  describeEffect: (input) =>
    `read metadata for b2://${inputText(input.bucket)}/${inputText(input.path)}`,
};
