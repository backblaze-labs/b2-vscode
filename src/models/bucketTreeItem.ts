/**
 * Tree item representing a B2 bucket.
 *
 * @module models/bucketTreeItem
 */

import * as vscode from "vscode";
import type { B2Bucket } from "../types";

/**
 * A collapsible tree item representing a single B2 bucket.
 */
export class BucketTreeItem extends vscode.TreeItem {
  readonly bucket: B2Bucket;
  readonly bucketId: string;
  readonly bucketName: string;
  readonly bucketType: string;

  constructor(bucket: B2Bucket) {
    super(bucket.bucketName, vscode.TreeItemCollapsibleState.Collapsed);

    this.bucket = bucket;
    this.bucketId = bucket.bucketId;
    this.bucketName = bucket.bucketName;
    this.bucketType = bucket.bucketType;
    this.contextValue = "bucket";
    this.description = bucket.bucketType;

    this.iconPath =
      bucket.bucketType === "allPublic"
        ? new vscode.ThemeIcon("globe")
        : new vscode.ThemeIcon("lock");

    this.tooltip = new vscode.MarkdownString(
      `**${bucket.bucketName}**\n\n` +
        `- Type: \`${bucket.bucketType}\`\n` +
        `- ID: \`${bucket.bucketId}\``,
    );
  }
}
