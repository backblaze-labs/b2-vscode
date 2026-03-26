/**
 * Status bar item showing B2 authentication state.
 *
 * @module ui/statusBar
 */

import * as vscode from "vscode";
import type { AuthService } from "../services/authService";
import type { B2AuthState } from "../types";

/**
 * Creates and manages a status bar item for B2 connection status.
 */
export class B2StatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(authService: AuthService) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = "b2.authenticate";
    this.statusBarItem.name = "Backblaze B2";

    this.update(authService.getAuthState());
    this.statusBarItem.show();

    this.disposables.push(authService.onAuthStateChanged((state) => this.update(state)));
  }

  dispose(): void {
    this.statusBarItem.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private update(state: B2AuthState): void {
    if (state.isAuthenticated) {
      this.statusBarItem.text = `$(backblaze-flame) B2: ${state.accountId ?? "Connected"}`;
      this.statusBarItem.tooltip = `Backblaze B2 — Connected\nAccount: ${state.accountId ?? "unknown"}`;
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = "$(backblaze-flame) B2: Not Connected";
      this.statusBarItem.tooltip = "Backblaze B2 — Click to authenticate";
      this.statusBarItem.backgroundColor = undefined;
    }
  }
}
