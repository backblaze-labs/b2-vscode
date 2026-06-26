/**
 * Tree data provider for the B2 Application Keys view.
 *
 * Lists application key metadata. Key secrets are only available from
 * createKey responses and are never included in this tree.
 *
 * @module providers/applicationKeysProvider
 */

import * as vscode from "vscode";
import type { B2Client } from "@backblaze-labs/b2-sdk";
import type { AuthService } from "../services/authService";
import { log, logError } from "../logger";
import { formatB2UserMessage } from "../errors";
import { ApplicationKeyTreeItem } from "../models/applicationKeyTreeItem";
import { ApplicationKeyListLimitTreeItem } from "../models/applicationKeyListLimitTreeItem";
import { withTimeout } from "../services/transferTimeout";

export const APPLICATION_KEY_TREE_HARD_CAP = 1000;
export const APPLICATION_KEY_TREE_PAGE_SIZE = 100;
export const APPLICATION_KEY_TREE_LIST_TIMEOUT_MS = 10_000;

export type ApplicationKeysTreeItem = ApplicationKeyTreeItem | ApplicationKeyListLimitTreeItem;

export interface ApplicationKeysProviderOptions {
  readonly listTimeoutMs?: number;
  readonly hardCap?: number;
  readonly pageSize?: number;
}

export function buildApplicationKeysErrorMessage(error: unknown): string {
  if (error instanceof Error && /timed out/i.test(error.message)) {
    return "B2: Could not load application keys. Listing timed out; refresh the Application Keys view and retry.";
  }

  return `B2: Could not load application keys. ${formatB2UserMessage(error)}`;
}

export class ApplicationKeysProvider implements vscode.TreeDataProvider<ApplicationKeysTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ApplicationKeysTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<ApplicationKeysTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private client: B2Client | null = null;
  private generation = 0;

  constructor(
    authService: AuthService,
    private readonly options: ApplicationKeysProviderOptions = {},
  ) {
    authService.onAuthStateChanged(() => this.refresh());
  }

  setClient(client: B2Client | null): void {
    this.client = client;
    this.generation++;
  }

  refresh(): void {
    this.generation++;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ApplicationKeysTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ApplicationKeysTreeItem): Promise<ApplicationKeysTreeItem[]> {
    const client = this.client;
    const generation = this.generation;
    if (!client || element) {
      return [];
    }

    try {
      log(`ApplicationKeys: listing keys (account=${client.accountInfo.getAccountId()})`);
      const keys = await withTimeout(
        (signal) => this.listKeys(client, generation, signal),
        this.options.listTimeoutMs ?? APPLICATION_KEY_TREE_LIST_TIMEOUT_MS,
        "Application key listing",
      );
      if (!this.isCurrent(client, generation)) {
        return [];
      }
      log(`ApplicationKeys: found ${keys.length} key(s)`);
      return keys;
    } catch (error) {
      if (!this.isCurrent(client, generation)) {
        return [];
      }
      logError("ApplicationKeys: getChildren failed", error);
      vscode.window.showErrorMessage(buildApplicationKeysErrorMessage(error));
      return [];
    }
  }

  private async listKeys(
    client: B2Client,
    generation: number,
    signal: AbortSignal,
  ): Promise<ApplicationKeysTreeItem[]> {
    const hardCap = this.options.hardCap ?? APPLICATION_KEY_TREE_HARD_CAP;
    const pageSize = Math.min(this.options.pageSize ?? APPLICATION_KEY_TREE_PAGE_SIZE, hardCap + 1);
    const keys: ApplicationKeysTreeItem[] = [];
    let capHit = false;

    for await (const key of client.paginateKeys({ pageSize, signal })) {
      signal.throwIfAborted();
      if (!this.isCurrent(client, generation)) {
        return [];
      }
      if (keys.length >= hardCap) {
        capHit = true;
        break;
      }
      keys.push(new ApplicationKeyTreeItem(key));
    }

    if (capHit) {
      keys.push(new ApplicationKeyListLimitTreeItem(hardCap));
    }

    return keys;
  }

  private isCurrent(client: B2Client, generation: number): boolean {
    return this.client === client && this.generation === generation;
  }
}
