/**
 * Shared upload target helpers for B2 tree items.
 *
 * @module models/uploadTarget
 */

import { BucketTreeItem } from "./bucketTreeItem";
import { FolderTreeItem } from "./folderTreeItem";

export type UploadTargetTreeItem = BucketTreeItem | FolderTreeItem;

export function isUploadTargetTreeItem(item: unknown): item is UploadTargetTreeItem {
  return item instanceof BucketTreeItem || item instanceof FolderTreeItem;
}

export function uploadTargetPrefix(item: UploadTargetTreeItem): string {
  return item instanceof FolderTreeItem ? item.prefix : "";
}

export function uploadTargetLabel(item: UploadTargetTreeItem): string {
  const prefix = uploadTargetPrefix(item);
  return prefix ? `b2://${item.bucketName}/${prefix}` : `b2://${item.bucketName}`;
}
