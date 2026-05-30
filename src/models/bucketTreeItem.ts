/**
 * Tree item representing a B2 bucket.
 *
 * @module models/bucketTreeItem
 */

import * as vscode from "vscode";
import type { Bucket } from "@backblaze-labs/b2-sdk";

/**
 * A collapsible tree item representing a single B2 bucket.
 *
 * Carries the live SDK {@link Bucket} handle so commands can act on it directly.
 */
export class BucketTreeItem extends vscode.TreeItem {
  readonly bucket: Bucket;
  readonly bucketId: string;
  readonly bucketName: string;
  readonly bucketType: string;

  constructor(bucket: Bucket) {
    super(bucket.name, vscode.TreeItemCollapsibleState.Collapsed);

    this.bucket = bucket;
    this.bucketId = bucket.id;
    this.bucketName = bucket.name;
    this.bucketType = bucket.info.bucketType;
    this.contextValue = "bucket";
    this.description = bucket.info.bucketType;

    this.iconPath =
      bucket.info.bucketType === "allPublic"
        ? new vscode.ThemeIcon("globe")
        : new vscode.ThemeIcon("lock");

    this.tooltip = new vscode.MarkdownString(
      `**${bucket.name}**\n\n` +
        `- Type: \`${bucket.info.bucketType}\`\n` +
        `- ID: \`${bucket.id}\``,
    );
  }
}
