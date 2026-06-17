/**
 * List Files tool definition.
 *
 * @module tools/definitions/listFiles
 */

import type { B2ToolDefinition } from "../types";
import { inputText } from "./inputText";

export const listFilesTool: B2ToolDefinition = {
  name: "b2_listFiles",
  displayName: "B2: List Files",
  description:
    "Lists a bounded page of files in a Backblaze B2 bucket. Optionally filter by prefix (folder path). Use recursive=true to list recursively with a smaller default and hard cap. Use nextContinuationToken from the response to request the next page.",
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
      limit: {
        type: "number",
        description:
          "Maximum number of entries to return. Defaults to 200, or 100 when recursive=true. Hard-capped at 1000, or 500 when recursive=true.",
      },
      continuationToken: {
        type: "string",
        description:
          "Continuation token from a previous response's nextContinuationToken. Omit for the first page.",
      },
    },
    required: ["bucket"],
  },
  tags: ["b2", "file", "list"],
  risk: "readOnly",
  describeEffect: (input) =>
    `list files in b2://${inputText(input.bucket)}${input.prefix ? `/${inputText(input.prefix)}` : ""}`,
};
