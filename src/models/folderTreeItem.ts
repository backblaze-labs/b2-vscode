/**
 * Tree item representing a virtual folder in a B2 bucket.
 *
 * B2 stores flat file names; folders are derived from "/" delimiters.
 *
 * @module models/folderTreeItem
 */

import * as vscode from "vscode";

/**
 * A collapsible tree item representing a virtual folder prefix.
 */
export class FolderTreeItem extends vscode.TreeItem {
  readonly bucketId: string;
  readonly bucketName: string;
  readonly prefix: string;

  constructor(bucketId: string, bucketName: string, prefix: string) {
    // Extract the folder name from the prefix: "data/models/" → "models"
    const segments = prefix.replace(/\/$/, "").split("/");
    const folderName = segments[segments.length - 1];

    super(folderName, vscode.TreeItemCollapsibleState.Collapsed);

    this.bucketId = bucketId;
    this.bucketName = bucketName;
    this.prefix = prefix;
    this.contextValue = "folder";
    this.iconPath = vscode.ThemeIcon.Folder;

    this.tooltip = new vscode.MarkdownString(
      `**${folderName}/**\n\n` + `- Bucket: \`${bucketName}\`\n` + `- Prefix: \`${prefix}\``,
    );
  }
}
