/**
 * B2 VS Code Extension entry point.
 *
 * Provides a sidebar tree view for Backblaze B2 buckets and files,
 * Copilot Language Model Tools, and file open support.
 *
 * @module extension
 */

import * as vscode from "vscode";
import type { B2Client } from "@backblaze-labs/b2-sdk";
import { createConfiguredB2Client } from "./services/b2";
import {
  cleanupStaleUnfinishedUploads,
  cleanupStaleUploadSessionMarkers,
  cleanupStaleTransferTempFiles,
  cleanupWorkspaceTransferTempFiles,
  type StaleUnfinishedUploadCleanupOptions,
  type StaleUnfinishedUploadCleanupResult,
} from "./services/fileTransfers";
import { AuthService } from "./services/authService";
import { cleanupStaleTempFileCache, TempFileManager } from "./services/tempFileManager";
import { B2TreeProvider } from "./providers/b2TreeProvider";
import { B2StatusBar } from "./ui/statusBar";
import { registerCommands } from "./commands";
import { registerB2Tools } from "./tools/registration";
import { TEMP_DIR_NAME, VIEW_BUCKETS } from "./constants";
import { initLogger, log, logError } from "./logger";
import { formatB2UserMessage } from "./errors";
import { cleanupStalePrivateTempRoots } from "./utils/privateTempRoot";

/** The current B2 client instance, or null if not authenticated. */
let currentClient: B2Client | null = null;

export interface StaleUnfinishedUploadSweepResult {
  readonly bucketCount: number;
  readonly reclaimedOwnedStaleUploadCount: number;
  readonly ignoredUnownedStaleUploadCount: number;
  readonly failedBucketCount: number;
}

export async function cleanupStaleUnfinishedUploadsForClient(
  client: Pick<B2Client, "listBuckets">,
  options: StaleUnfinishedUploadCleanupOptions = {},
): Promise<StaleUnfinishedUploadSweepResult> {
  const buckets = await client.listBuckets();
  let reclaimedOwnedStaleUploadCount = 0;
  let ignoredUnownedStaleUploadCount = 0;
  let failedBucketCount = 0;

  for (const bucket of buckets) {
    let result: StaleUnfinishedUploadCleanupResult;
    try {
      result = await cleanupStaleUnfinishedUploads(bucket, options);
    } catch (error) {
      failedBucketCount += 1;
      logError(`Could not clean stale unfinished uploads for bucket ${bucket.name}`, error);
      continue;
    }

    reclaimedOwnedStaleUploadCount += result.reclaimedOwnedStaleUploadCount;
    ignoredUnownedStaleUploadCount += result.ignoredUnownedStaleUploadCount;
  }

  log(
    `Activation stale unfinished-upload sweep scanned ${buckets.length} bucket(s), reclaimed ${reclaimedOwnedStaleUploadCount}, ignored ${ignoredUnownedStaleUploadCount}, failed ${failedBucketCount}.`,
  );

  return {
    bucketCount: buckets.length,
    reclaimedOwnedStaleUploadCount,
    ignoredUnownedStaleUploadCount,
    failedBucketCount,
  };
}

function scheduleTempCleanups(context: vscode.ExtensionContext): void {
  void cleanupStalePrivateTempRoots(TEMP_DIR_NAME).catch((error) => {
    logError("Could not clean stale temp cache roots during activation", error);
  });
  void cleanupStaleTransferTempFiles().catch((error) => {
    logError("Could not clean stale transfer temp files during activation", error);
  });
  void cleanupStaleTempFileCache().catch((error) => {
    logError("Could not clean stale temp file cache during activation", error);
  });
  void cleanupStaleUploadSessionMarkers().catch((error) => {
    logError("Could not clean stale upload session markers during activation", error);
  });

  const cleanupWorkspace = (folder: vscode.WorkspaceFolder): void => {
    void cleanupWorkspaceTransferTempFiles({ workspaceRoot: folder.uri.fsPath }).catch((error) => {
      logError(`Could not clean workspace transfer temp files: ${folder.uri.fsPath}`, error);
    });
  };
  vscode.workspace.workspaceFolders?.forEach(cleanupWorkspace);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      event.added.forEach(cleanupWorkspace);
    }),
  );
}

function scheduleAuthenticatedCleanups(client: B2Client): void {
  void cleanupStaleUnfinishedUploadsForClient(client).catch((error) => {
    logError("Could not run stale unfinished-upload sweep during activation", error);
  });
}

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
    isAuthenticated: () => currentClient !== null,
    getClient: () => currentClient,
    setClient: (client) => {
      currentClient = client;
    },
  });
  registerB2Tools(context, () => currentClient);

  // 6. Track disposables
  context.subscriptions.push(treeView, statusBar, authService, tempFileManager);
  scheduleTempCleanups(context);

  // 7. Auto-auth: try to resolve stored/env credentials
  try {
    const credentials = await authService.resolveCredentials();
    if (credentials) {
      const client = await createConfiguredB2Client(
        credentials,
        context.extension.packageJSON.version,
      );
      await client.authorize();

      currentClient = client;
      treeProvider.setClient(client);

      await authService.setAuthState({
        isAuthenticated: true,
        accountId: client.accountInfo.getAccountId(),
        apiUrl: client.accountInfo.getApiUrl(),
        downloadUrl: client.accountInfo.getDownloadUrl(),
      });

      log(`Auto-authenticated as ${client.accountInfo.getAccountId()}`);
      scheduleAuthenticatedCleanups(client);
    } else {
      const warning = authService.getCredentialResolutionWarning();
      await authService.setAuthState({
        isAuthenticated: false,
        ...(warning ? { error: warning } : {}),
      });
      log("No stored credentials found.");
    }
  } catch (error) {
    const message = formatB2UserMessage(error);
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
