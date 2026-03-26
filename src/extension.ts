/**
 * B2 VS Code Extension entry point.
 *
 * Provides a sidebar tree view for Backblaze B2 buckets and files,
 * Copilot Language Model Tools, and file open support.
 *
 * @module extension
 */

import * as vscode from "vscode";
import { B2Client } from "./services/b2Client";
import { AuthService } from "./services/authService";
import { TempFileManager } from "./services/tempFileManager";
import { B2TreeProvider } from "./providers/b2TreeProvider";
import { B2StatusBar } from "./ui/statusBar";
import { registerCommands } from "./commands";
import { registerB2Tools } from "./tools/registration";
import { VIEW_BUCKETS } from "./constants";
import { initLogger, log, logError } from "./logger";

/** The current B2 client instance, or null if not authenticated. */
let currentClient: B2Client | null = null;

/**
 * Activate the B2 extension.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 0. Output channel
  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);
  log("Activating Backblaze B2 extension...");

  // 1. Services
  const authService = new AuthService(context.secrets);
  const tempFileManager = new TempFileManager();

  // 2. Tree provider
  const treeProvider = new B2TreeProvider(authService);

  // 3. Register tree view
  const treeView = vscode.window.createTreeView(VIEW_BUCKETS, {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // 4. Status bar
  const statusBar = new B2StatusBar(authService);

  // 5. Register commands
  registerCommands({
    context,
    authService,
    treeProvider,
    tempFileManager,
    getClient: () => currentClient,
    setClient: (client) => {
      currentClient = client;
    },
  });

  // 6. Track disposables
  context.subscriptions.push(treeView, statusBar, authService, tempFileManager);

  // 7. Auto-auth: try to resolve stored/env credentials
  try {
    const credentials = await authService.resolveCredentials();
    if (credentials) {
      const client = new B2Client(credentials.keyId, credentials.appKey);
      const authResponse = await client.authorize();

      currentClient = client;
      treeProvider.setClient(client);

      await authService.setAuthState({
        isAuthenticated: true,
        accountId: authResponse.accountId,
        apiUrl: authResponse.apiUrl,
        downloadUrl: authResponse.downloadUrl,
      });

      // Register Copilot tools
      registerB2Tools(context, client);

      log(`Auto-authenticated as ${authResponse.accountId}`);
    } else {
      await authService.setAuthState({ isAuthenticated: false });
      log("No stored credentials found.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("Auto-auth failed", error);
    await authService.setAuthState({ isAuthenticated: false, error: message });
  }

  log("Extension activated.");
}

/**
 * Deactivate the B2 extension.
 */
export function deactivate(): void {
  // Cleanup handled by context.subscriptions disposals
  console.log("[B2] Extension deactivated.");
}
