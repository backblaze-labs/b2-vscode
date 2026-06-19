/**
 * Upload File tool definition.
 *
 * @module tools/definitions/uploadFile
 */

import type { B2ToolDefinition } from "../types";
import { inputText } from "./inputText";
import { portablePathBasename } from "../../utils/localPaths";

function remotePathFor(input: Record<string, unknown>): string {
  if (input.remotePath !== undefined && input.remotePath !== null) {
    return inputText(input.remotePath);
  }
  const localPath = inputText(input.localPath, "");
  return portablePathBasename(localPath, "(file name)");
}

export const uploadFileTool: B2ToolDefinition = {
  name: "b2_uploadFile",
  displayName: "B2: Upload File",
  description:
    "Uploads a file from the open workspace to a B2 bucket. Returns the uploaded file info including file ID and size.",
  parameters: {
    type: "object",
    properties: {
      localPath: {
        type: "string",
        description:
          "Workspace-relative path to the local file to upload. Absolute paths are rejected.",
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
  risk: "exfiltration",
  describeEffect: (input) =>
    `upload local file contents from ${inputText(input.localPath)} to b2://${inputText(input.bucket)}/${remotePathFor(input)}`,
};
