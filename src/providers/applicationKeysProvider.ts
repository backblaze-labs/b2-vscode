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

export type ApplicationKeysTreeItem = ApplicationKeyTreeItem;

export function buildApplicationKeysErrorMessage(error: unknown): string {
  return `B2: Could not load application keys. ${formatB2UserMessage(error)}`;
}

export class ApplicationKeysProvider implements vscode.TreeDataProvider<ApplicationKeysTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ApplicationKeysTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<ApplicationKeysTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private client: B2Client | null = null;

  constructor(authService: AuthService) {
    authService.onAuthStateChanged(() => this.refresh());
  }

  setClient(client: B2Client | null): void {
    this.client = client;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ApplicationKeysTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ApplicationKeysTreeItem): Promise<ApplicationKeysTreeItem[]> {
    const client = this.client;
    if (!client || element) {
      return [];
    }

    try {
      log(`ApplicationKeys: listing keys (account=${client.accountInfo.getAccountId()})`);
      const keys: ApplicationKeysTreeItem[] = [];
      for await (const key of client.paginateKeys()) {
        keys.push(new ApplicationKeyTreeItem(key));
      }
      log(`ApplicationKeys: found ${keys.length} key(s)`);
      return keys;
    } catch (error) {
      logError("ApplicationKeys: getChildren failed", error);
      vscode.window.showErrorMessage(buildApplicationKeysErrorMessage(error));
      return [];
    }
  }
}
