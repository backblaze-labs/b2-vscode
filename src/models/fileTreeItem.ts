/**
 * Tree item representing a file in a B2 bucket.
 *
 * @module models/fileTreeItem
 */

import * as vscode from "vscode";
import type { B2FileInfo } from "../types";

/**
 * A leaf tree item representing a single B2 file.
 * Clicking it opens the file in VS Code's default viewer.
 */
export class FileTreeItem extends vscode.TreeItem {
  readonly bucketId: string;
  readonly bucketName: string;
  readonly fileInfo: B2FileInfo;

  constructor(bucketId: string, bucketName: string, file: B2FileInfo) {
    // Extract just the file name from the full path: "data/train.csv" → "train.csv"
    const segments = file.fileName.split("/");
    const fileName = segments[segments.length - 1];

    super(fileName, vscode.TreeItemCollapsibleState.None);

    this.bucketId = bucketId;
    this.bucketName = bucketName;
    this.fileInfo = file;
    this.contextValue = "file";
    this.description = humanSize(file.contentLength);

    this.iconPath = vscode.ThemeIcon.File;

    // Set resourceUri so VS Code applies file-type icons (e.g., .csv, .json, .png)
    this.resourceUri = vscode.Uri.parse(`b2://${bucketName}/${file.fileName}`);

    this.tooltip = new vscode.MarkdownString(
      `**${fileName}**\n\n` +
        `- Path: \`${file.fileName}\`\n` +
        `- Size: ${humanSize(file.contentLength)}\n` +
        `- Type: \`${file.contentType}\`\n` +
        `- Uploaded: ${new Date(file.uploadTimestamp).toISOString()}\n` +
        `- File ID: \`${file.fileId}\``,
    );

    // Single-click opens the file
    this.command = {
      command: "b2.openFile",
      title: "Open File",
      arguments: [this],
    };
  }
}

/**
 * Convert bytes to a human-readable string.
 */
function humanSize(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
