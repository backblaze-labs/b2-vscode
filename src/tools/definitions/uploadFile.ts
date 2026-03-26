/**
 * Upload File tool definition.
 *
 * @module tools/definitions/uploadFile
 */

import type { B2ToolDefinition } from "../types";

export const uploadFileTool: B2ToolDefinition = {
  name: "b2_uploadFile",
  displayName: "B2: Upload File",
  description:
    "Uploads a local file to a B2 bucket. Returns the uploaded file info including file ID and size.",
  parameters: {
    type: "object",
    properties: {
      localPath: {
        type: "string",
        description: "Absolute or workspace-relative path to the local file to upload.",
      },
      bucket: {
        type: "string",
        description: "Name of the B2 bucket to upload to.",
      },
      remotePath: {
        type: "string",
        description:
          'Optional remote path (key) in the bucket. Defaults to the file name. Example: "data/output.csv"',
      },
    },
    required: ["localPath", "bucket"],
  },
  tags: ["b2", "file", "upload"],
};
