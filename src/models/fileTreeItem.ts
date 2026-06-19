/**
 * Tree item representing a file in a B2 bucket.
 *
 * @module models/fileTreeItem
 */

import * as vscode from "vscode";
import type { Bucket, FileVersion } from "@backblaze-labs/b2-sdk";
import { humanSize } from "../utils/humanSize";

/**
 * A leaf tree item representing a single B2 file.
 * Clicking it opens the file in VS Code's default viewer.
 */
export class FileTreeItem extends vscode.TreeItem {
  readonly bucket: Bucket;
  readonly bucketId: string;
  readonly bucketName: string;
  readonly file: FileVersion;

  constructor(bucket: Bucket, file: FileVersion) {
    // Extract just the file name from the full path: "data/train.csv" → "train.csv"
    const segments = file.fileName.split("/");
    const fileName = segments[segments.length - 1];

    super(fileName, vscode.TreeItemCollapsibleState.None);

    this.bucket = bucket;
    this.bucketId = bucket.id;
    this.bucketName = bucket.name;
    this.file = file;
    this.contextValue = "file";
    this.description = humanSize(file.contentLength);

    this.iconPath = vscode.ThemeIcon.File;

    // Set resourceUri so VS Code applies file-type icons (e.g., .csv, .json, .png)
    this.resourceUri = vscode.Uri.from({
      scheme: "b2",
      authority: bucket.name,
      path: `/${file.fileName}`,
    });

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
