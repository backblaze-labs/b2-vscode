/**
 * Download File tool definition.
 *
 * @module tools/definitions/downloadFile
 */

import type { B2ToolDefinition } from "../types";

export const downloadFileTool: B2ToolDefinition = {
  name: "b2_downloadFile",
  displayName: "B2: Download File",
  description:
    "Downloads a file from a B2 bucket to the local workspace. Returns the local file path where the file was saved.",
  parameters: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Name of the B2 bucket containing the file.",
      },
      path: {
        type: "string",
        description: 'Full file path within the bucket. Example: "data/results.csv"',
      },
      localPath: {
        type: "string",
        description:
          "Optional local path to save the file. Defaults to the workspace root with the same file name.",
      },
    },
    required: ["bucket", "path"],
  },
  tags: ["b2", "file", "download"],
  risk: "write",
  describeEffect: (input) =>
    `download b2://${String(input.bucket)}/${String(input.path)} to your local workspace`,
};
