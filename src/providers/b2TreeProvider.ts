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
import { TREE_LIST_HARD_CAP, TREE_LIST_PAGE_SIZE } from "../constants";
import { BucketTreeItem } from "../models/bucketTreeItem";
import { FolderTreeItem } from "../models/folderTreeItem";
import { FileTreeItem } from "../models/fileTreeItem";
import { ListingLimitTreeItem } from "../models/listingLimitTreeItem";
import { LoadMoreTreeItem, type PageableTreeItem } from "../models/loadMoreTreeItem";

/** Union of all tree item types used in the B2 Buckets view. */
export type ListedB2TreeItem = BucketTreeItem | FolderTreeItem | FileTreeItem;
export type B2TreeItem = ListedB2TreeItem | LoadMoreTreeItem | ListingLimitTreeItem;

interface ListingState {
  readonly items: ListedB2TreeItem[];
  nextFileName: string | undefined;
}

/**
 * Tree data provider for browsing B2 buckets and files.
 */
export class B2TreeProvider implements vscode.TreeDataProvider<B2TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<B2TreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<B2TreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private client: B2Client | null = null;
  private readonly listingStates = new Map<string, ListingState>();
  private readonly listingStateLoads = new Map<string, Promise<ListingState>>();
  private readonly loadingListings = new Set<string>();
  private listingStateGeneration = 0;

  constructor(authService: AuthService) {
    // Refresh when auth state changes
    authService.onAuthStateChanged(() => this.refresh());
  }

  /** Set or replace the B2 client (called after authentication). */
  setClient(client: B2Client | null): void {
    this.client = client;
    this.listingStateGeneration++;
    this.listingStates.clear();
    this.listingStateLoads.clear();
    this.loadingListings.clear();
  }

  /** Refresh the entire tree. */
  refresh(): void {
    this.listingStateGeneration++;
    this.listingStates.clear();
    this.listingStateLoads.clear();
    this.loadingListings.clear();
    this._onDidChangeTreeData.fire();
  }

  /** Load the next page for a bucket/folder that has more objects. */
  async loadMore(item: LoadMoreTreeItem): Promise<void> {
    const key = this.listingKey(item.bucket, item.prefix);
    const generation = this.listingStateGeneration;
    if (this.loadingListings.has(key)) {
      return;
    }

    this.loadingListings.add(key);
    try {
      const state = this.listingStates.get(key);
      if (!state || this.listingStateGeneration !== generation) {
        return;
      }
      if (state.nextFileName === undefined || state.items.length >= TREE_LIST_HARD_CAP) {
        return;
      }

      await this.fetchNextPage(item.bucket, item.prefix, state);
      if (this.listingStateGeneration !== generation) {
        return;
      }
      this._onDidChangeTreeData.fire(item.parent);
    } catch (error) {
      if (this.listingStateGeneration !== generation) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logError(`Tree: loadMore failed`, error);
      vscode.window.showErrorMessage(`B2: ${message}`);
    } finally {
      if (this.listingStateGeneration === generation) {
        this.loadingListings.delete(key);
      }
    }
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
        return this.listChildren(element.bucket, "", element);
      }

      // Folder → list children at this prefix
      if (element instanceof FolderTreeItem) {
        return this.listChildren(element.bucket, element.prefix, element);
      }

      if (element instanceof LoadMoreTreeItem || element instanceof ListingLimitTreeItem) {
        return [];
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
  private async listChildren(
    bucket: Bucket,
    prefix: string,
    parent: PageableTreeItem,
  ): Promise<B2TreeItem[]> {
    const state = await this.getOrCreateListingState(bucket, prefix);
    return this.decoratePagedListing(bucket, prefix, parent, state);
  }

  private async getOrCreateListingState(bucket: Bucket, prefix: string): Promise<ListingState> {
    const key = this.listingKey(bucket, prefix);
    const existing = this.listingStates.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.listingStateLoads.get(key);
    if (pending) {
      return pending;
    }

    const created: ListingState = { items: [], nextFileName: undefined };
    const generation = this.listingStateGeneration;
    const load = this.createListingState(bucket, prefix, key, created, generation);
    this.listingStateLoads.set(key, load);
    try {
      return await load;
    } finally {
      if (this.listingStateGeneration === generation) {
        this.listingStateLoads.delete(key);
      }
    }
  }

  private async createListingState(
    bucket: Bucket,
    prefix: string,
    key: string,
    state: ListingState,
    generation: number,
  ): Promise<ListingState> {
    await this.fetchNextPage(bucket, prefix, state);
    if (this.listingStateGeneration === generation) {
      this.listingStates.set(key, state);
    }
    return state;
  }

  private async fetchNextPage(bucket: Bucket, prefix: string, state: ListingState): Promise<void> {
    const remaining = TREE_LIST_HARD_CAP - state.items.length;
    if (remaining <= 0) {
      return;
    }

    const startFileName = state.nextFileName;
    const pageSize = Math.min(TREE_LIST_PAGE_SIZE, remaining);
    const page = await bucket.listFileNames({
      delimiter: "/",
      pageSize,
      ...(prefix ? { prefix } : {}),
      ...(startFileName !== undefined ? { startFileName } : {}),
    });

    // pageSize should already bound page.files; keep slice as a defensive cap.
    const visibleFiles = page.files.slice(0, pageSize);
    for (const file of visibleFiles) {
      if (file.action === "folder") {
        state.items.push(new FolderTreeItem(bucket, file.fileName));
      } else {
        state.items.push(new FileTreeItem(bucket, file));
      }
    }

    // If an oversized page is sliced, continue from the first hidden item.
    const nextFileName =
      page.files.length > visibleFiles.length
        ? page.files[visibleFiles.length]?.fileName
        : (page.nextFileName ?? undefined);
    if (nextFileName !== undefined && nextFileName === startFileName) {
      throw new Error("B2 returned an unchanged continuation token; listing stopped.");
    }
    state.nextFileName = nextFileName;
  }

  private decoratePagedListing(
    bucket: Bucket,
    prefix: string,
    parent: PageableTreeItem,
    state: ListingState,
  ): B2TreeItem[] {
    const items: B2TreeItem[] = [...state.items];
    if (state.nextFileName === undefined) {
      return items;
    }

    if (state.items.length >= TREE_LIST_HARD_CAP) {
      items.push(new ListingLimitTreeItem(TREE_LIST_HARD_CAP));
    } else {
      items.push(new LoadMoreTreeItem(bucket, prefix, parent));
    }

    return items;
  }

  private listingKey(bucket: Bucket, prefix: string): string {
    return JSON.stringify([bucket.name, prefix]);
  }
}
