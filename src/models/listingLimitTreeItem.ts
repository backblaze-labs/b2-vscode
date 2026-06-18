/**
 * Tree item used when a B2 listing reaches the extension-side hard cap.
 *
 * @module models/listingLimitTreeItem
 */

import * as vscode from "vscode";

/**
 * Informational item appended when more objects exist but are intentionally hidden.
 */
export class ListingLimitTreeItem extends vscode.TreeItem {
  override readonly contextValue = "listingLimit";

  constructor(limit: number) {
    super(`Showing first ${limit} items`, vscode.TreeItemCollapsibleState.None);
    this.description = "Narrow the prefix to see more";
    this.tooltip =
      "This listing is capped to keep the VS Code extension host responsive. Use a narrower folder or prefix to continue.";
    this.iconPath = new vscode.ThemeIcon("warning");
  }
}
