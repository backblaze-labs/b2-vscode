/**
 * List Files tool definition.
 *
 * @module tools/definitions/listFiles
 */

import type { B2ToolDefinition } from "../types";

export const listFilesTool: B2ToolDefinition = {
  name: "b2_listFiles",
  displayName: "B2: List Files",
  description:
    "Lists files in a Backblaze B2 bucket. Optionally filter by prefix (folder path). Use recursive=true to list all files, or omit for just the immediate level.",
  parameters: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Name of the B2 bucket to list files from.",
      },
      prefix: {
        type: "string",
        description: 'Optional prefix (folder path) to filter files. Example: "data/train/"',
      },
      recursive: {
        type: "boolean",
        description:
          "If true, list all files recursively. If false (default), list only the immediate level.",
      },
    },
    required: ["bucket"],
  },
  tags: ["b2", "file", "list"],
  risk: "readOnly",
  describeEffect: (input) =>
    `list files in b2://${String(input.bucket)}${input.prefix ? `/${String(input.prefix)}` : ""}`,
};
