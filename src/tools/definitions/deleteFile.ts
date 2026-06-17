/**
 * Delete File tool definition.
 *
 * @module tools/definitions/deleteFile
 */

import type { B2ToolDefinition } from "../types";
import { inputText } from "./inputText";

export const deleteFileTool: B2ToolDefinition = {
  name: "b2_deleteFile",
  displayName: "B2: Delete File",
  description:
    "Deletes a file from a B2 bucket. Requires the bucket name and file path. This action is irreversible.",
  parameters: {
    type: "object",
    properties: {
      bucket: {
        type: "string",
        description: "Name of the B2 bucket containing the file.",
      },
      path: {
        type: "string",
        description: 'Full file path within the bucket. Example: "data/old-results.csv"',
      },
    },
    required: ["bucket", "path"],
  },
  tags: ["b2", "file", "delete"],
  risk: "destructive",
  describeEffect: (input) =>
    `permanently delete b2://${inputText(input.bucket)}/${inputText(input.path)}`,
};
