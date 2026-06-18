/**
 * Tree item used to request the next page of B2 objects.
 *
 * @module models/loadMoreTreeItem
 */

import * as vscode from "vscode";
import type { Bucket } from "@backblaze-labs/b2-sdk";
import type { BucketTreeItem } from "./bucketTreeItem";
import type { FolderTreeItem } from "./folderTreeItem";

export type PageableTreeItem = BucketTreeItem | FolderTreeItem;

/**
 * Command-backed item appended when a bucket or folder has another page.
 */
export class LoadMoreTreeItem extends vscode.TreeItem {
  override readonly contextValue = "loadMore";

  constructor(
    readonly bucket: Bucket,
    readonly prefix: string,
    readonly parent: PageableTreeItem,
  ) {
    super("Load more", vscode.TreeItemCollapsibleState.None);
    this.description = prefix ? `More in ${prefix}` : "More objects";
    this.tooltip = `Load more objects from b2://${bucket.name}/${prefix}`;
    this.iconPath = new vscode.ThemeIcon("more");
    this.command = {
      command: "b2.loadMore",
      title: "Load More",
      arguments: [this],
    };
  }
}
