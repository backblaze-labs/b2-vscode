/**
 * Download File tool definition.
 *
 * @module tools/definitions/downloadFile
 */

import * as path from "path";
import type { B2ToolDefinition } from "../types";
import { inputText } from "./inputText";

function localDestinationFor(input: Record<string, unknown>): string {
  if (typeof input.localPath !== "string" || input.localPath.length === 0) {
    return "your local workspace";
  }
  return path.isAbsolute(input.localPath) || path.win32.isAbsolute(input.localPath)
    ? `absolute path ${input.localPath} (must be inside the first workspace or extension tools temporary directory)`
    : `workspace-relative path ${input.localPath}`;
}

export const downloadFileTool: B2ToolDefinition = {
  name: "b2_downloadFile",
  displayName: "B2: Download File",
  description:
    "Downloads a file from a B2 bucket to the first open workspace folder or the extension tools temporary directory without overwriting existing files. Returns the local file path where the file was saved.",
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
          "Optional local file path. Relative paths resolve inside the first open workspace folder and each filename segment is sanitized once for portable writes. Absolute paths are accepted only inside that workspace or the extension tools temporary directory. Defaults to the workspace root with a safe version of the remote file name. Sensitive workspace config/secret paths and existing files are rejected.",
      },
    },
    required: ["bucket", "path"],
  },
  tags: ["b2", "file", "download"],
  risk: "write",
  describeEffect: (input) =>
    `download b2://${inputText(input.bucket)}/${inputText(input.path)} to ${localDestinationFor(input)}`,
};
