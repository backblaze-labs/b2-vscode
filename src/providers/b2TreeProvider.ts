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
import type { B2Client, Bucket } from "@backblaze-labs/b2-sdk";
import type { AuthService } from "../services/authService";
import { log, logError } from "../logger";
import { MAX_FILE_COUNT } from "../constants";
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
    const client = this.client;
    if (!client) {
      return [];
    }

    try {
      // Root → list buckets
      if (!element) {
        log(`Tree: listing buckets (account=${client.accountInfo.getAccountId()})`);
        const buckets = await client.listBuckets();
        log(`Tree: found ${buckets.length} bucket(s)`);
        return buckets.map((b) => new BucketTreeItem(b));
      }

      // Bucket → list top-level files/folders
      if (element instanceof BucketTreeItem) {
        return this.listChildren(element.bucket, "");
      }

      // Folder → list children at this prefix
      if (element instanceof FolderTreeItem) {
        return this.listChildren(element.bucket, element.prefix);
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
   *
   * B2 returns virtual folder entries (`action: "folder"`) alongside real files,
   * enabling tree-style browsing.
   */
  private async listChildren(bucket: Bucket, prefix: string): Promise<B2TreeItem[]> {
    const items: B2TreeItem[] = [];
    let startFileName: string | undefined;

    do {
      const page = await bucket.listFileNames({
        delimiter: "/",
        pageSize: MAX_FILE_COUNT,
        ...(prefix ? { prefix } : {}),
        ...(startFileName !== undefined ? { startFileName } : {}),
      });

      for (const file of page.files) {
        if (file.action === "folder") {
          items.push(new FolderTreeItem(bucket, file.fileName));
        } else {
          items.push(new FileTreeItem(bucket, file));
        }
      }

      startFileName = page.nextFileName ?? undefined;
    } while (startFileName !== undefined);

    return items;
  }
}
