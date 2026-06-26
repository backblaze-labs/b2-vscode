/**
 * Tree item shown when application key listing hits the extension hard cap.
 *
 * @module models/applicationKeyListLimitTreeItem
 */

import * as vscode from "vscode";

export class ApplicationKeyListLimitTreeItem extends vscode.TreeItem {
  override readonly contextValue = "applicationKeyListLimit";

  constructor(limit: number) {
    super(`Showing first ${limit} application keys`, vscode.TreeItemCollapsibleState.None);
    this.description = "Listing capped";
    this.tooltip =
      "This listing is capped to keep the VS Code extension host responsive. Delete old keys or use the B2 web console to inspect additional keys.";
    this.iconPath = new vscode.ThemeIcon("warning");
  }
}
