/**
 * Tree data provider for the B2 Buckets view.
 *
 * Displays buckets at root level with lazy-loaded virtual folder hierarchy
 * using the B2 `delimiter` parameter for one-level-at-a-time expansion.
 *
 * @see https://code.visualstudio.com/api/extension-guides/tree-view
 * @module providers/b2TreeProvider
 */

import * as vscode from "vscode";
import type { B2Client } from "../services/b2Client";
import type { AuthService } from "../services/authService";
import { log, logError } from "../logger";
import { BucketTreeItem } from "../models/bucketTreeItem";
import { FolderTreeItem } from "../models/folderTreeItem";
import { FileTreeItem } from "../models/fileTreeItem";

/** Union of all tree item types used in the B2 Buckets view. */
export type B2TreeItem = BucketTreeItem | FolderTreeItem | FileTreeItem;

/**
 * Tree data provider for browsing B2 buckets and files.
 */
export class B2TreeProvider implements vscode.TreeDataProvider<B2TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<B2TreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<B2TreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private client: B2Client | null = null;

  constructor(authService: AuthService) {
    // Refresh when auth state changes
    authService.onAuthStateChanged(() => this.refresh());
  }

  /** Set or replace the B2 client (called after authentication). */
  setClient(client: B2Client | null): void {
    this.client = client;
  }

  /** Refresh the entire tree. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: B2TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: B2TreeItem): Promise<B2TreeItem[]> {
    if (!this.client || !this.client.isAuthorized) {
      return [];
    }

    try {
      // Root → list buckets
      if (!element) {
        log(
          `Tree: listing buckets (apiUrl=${this.client.getApiUrl()}, accountId=${this.client.getAccountId()})`,
        );
        const buckets = await this.client.listBuckets();
        log(`Tree: found ${buckets.length} bucket(s)`);
        return buckets.map((b) => new BucketTreeItem(b));
      }

      // Bucket → list top-level files/folders
      if (element instanceof BucketTreeItem) {
        return this.listChildren(element.bucketId, element.bucketName, "");
      }

      // Folder → list children at this prefix
      if (element instanceof FolderTreeItem) {
        return this.listChildren(element.bucketId, element.bucketName, element.prefix);
      }

      // File → no children
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Tree: getChildren failed`, error);
      vscode.window.showErrorMessage(`B2: ${message}`);
      return [];
    }
  }

  /**
   * List one level of children at the given prefix using delimiter "/".
   */
  private async listChildren(
    bucketId: string,
    bucketName: string,
    prefix: string,
  ): Promise<B2TreeItem[]> {
    if (!this.client) {
      return [];
    }

    const files = await this.client.listAllFileNames(bucketId, prefix, "/");
    const items: B2TreeItem[] = [];

    for (const file of files) {
      if (file.action === "folder") {
        items.push(new FolderTreeItem(bucketId, bucketName, file.fileName));
      } else {
        items.push(new FileTreeItem(bucketId, bucketName, file));
      }
    }

    return items;
  }
}
