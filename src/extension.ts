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
  cleanupWorkspaceDestinationTempFiles,
  type StaleUnfinishedUploadCleanupOptions,
  type StaleUnfinishedUploadCleanupResult,
} from "./services/fileTransfers";
import { withTimeout } from "./services/transferTimeout";
import { AuthService } from "./services/authService";
import { cleanupStaleTempFileCache, TempFileManager } from "./services/tempFileManager";
import { B2TreeProvider, type B2TreeItem } from "./providers/b2TreeProvider";
import { B2TreeDragAndDropController } from "./providers/b2TreeDragAndDropController";
import { B2StatusBar } from "./ui/statusBar";
import { registerCommands } from "./commands";
import { uploadLocalUrisToTarget } from "./commands/uploadFiles";
import { isUploadTargetTreeItem } from "./models/uploadTarget";
import { registerB2Tools } from "./tools/registration";
import { TEMP_DIR_NAME, VIEW_BUCKETS } from "./constants";
import { initLogger, log, logError } from "./logger";
import { formatB2UserMessage } from "./errors";
import { cleanupStalePrivateTempRoots } from "./utils/privateTempRoot";

/** The current B2 client instance, or null if not authenticated. */
let currentClient: B2Client | null = null;

export const STALE_UNFINISHED_UPLOAD_LIST_BUCKETS_TIMEOUT_MS = 10_000;
export const STALE_UNFINISHED_UPLOAD_SWEEP_MAX_BUCKETS = 25;
export const STALE_UNFINISHED_UPLOAD_SWEEP_BUDGET_MS = 30_000;

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
  const startedAt = Date.now();
  let buckets: Awaited<ReturnType<B2Client["listBuckets"]>>;
  try {
    buckets = await withTimeout(
      () => client.listBuckets(),
      STALE_UNFINISHED_UPLOAD_LIST_BUCKETS_TIMEOUT_MS,
      "Activation stale unfinished-upload bucket listing",
    );
  } catch (error) {
    logError(
      `Activation stale unfinished-upload sweep could not list buckets within ${STALE_UNFINISHED_UPLOAD_LIST_BUCKETS_TIMEOUT_MS} ms`,
      error,
    );
    return {
      bucketCount: 0,
      reclaimedOwnedStaleUploadCount: 0,
      ignoredUnownedStaleUploadCount: 0,
      failedBucketCount: 0,
    };
  }

  await cleanupStaleUploadSessionMarkers().catch((error) => {
    logError("Could not clean stale upload session markers during unfinished-upload sweep", error);
  });

  let reclaimedOwnedStaleUploadCount = 0;
  let ignoredUnownedStaleUploadCount = 0;
  let failedBucketCount = 0;
  let scannedBucketCount = 0;
  let budgetHit = false;
  let missingCapabilityLogged = false;
  const maxBuckets = Math.max(0, STALE_UNFINISHED_UPLOAD_SWEEP_MAX_BUCKETS);
  const sweepBudgetMs = Math.max(0, STALE_UNFINISHED_UPLOAD_SWEEP_BUDGET_MS);
  const bucketsToScan = buckets.slice(0, maxBuckets);

  if (buckets.length > maxBuckets) {
    log(
      `Activation stale unfinished-upload sweep limited to ${maxBuckets} of ${buckets.length} bucket(s).`,
    );
  }

  for (const bucket of bucketsToScan) {
    const remainingBudgetMs = Math.max(0, startedAt + sweepBudgetMs - Date.now());
    if (remainingBudgetMs <= 0) {
      budgetHit = true;
      log(
        `Activation stale unfinished-upload sweep stopped after reaching the ${sweepBudgetMs} ms aggregate budget.`,
      );
      break;
    }

    scannedBucketCount += 1;
    let result: StaleUnfinishedUploadCleanupResult;
    try {
      result = await cleanupStaleUnfinishedUploads(bucket, {
        ...options,
        skipUploadSessionMarkerCleanup: true,
        unfinishedCleanupBudgetMs: Math.min(
          options.unfinishedCleanupBudgetMs ?? remainingBudgetMs,
          remainingBudgetMs,
        ),
        onMissingCapability: (description, error) => {
          if (missingCapabilityLogged) {
            return;
          }
          missingCapabilityLogged = true;
          if (options.onMissingCapability) {
            options.onMissingCapability(description, error);
            return;
          }
          log(
            "Activation stale unfinished-upload sweep skipped unfinished-upload listing because the B2 key lacks the required capability.",
          );
        },
      });
    } catch (error) {
      failedBucketCount += 1;
      logError(`Could not clean stale unfinished uploads for bucket ${bucket.name}`, error);
      continue;
    }

    reclaimedOwnedStaleUploadCount += result.reclaimedOwnedStaleUploadCount;
    ignoredUnownedStaleUploadCount += result.ignoredUnownedStaleUploadCount;
  }

  log(
    `Activation stale unfinished-upload sweep scanned ${scannedBucketCount} bucket(s), reclaimed ${reclaimedOwnedStaleUploadCount}, ignored ${ignoredUnownedStaleUploadCount}, failed ${failedBucketCount}, bucketCapHit=${buckets.length > maxBuckets}, budgetHit=${budgetHit}.`,
  );

  return {
    bucketCount: scannedBucketCount,
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

  const cleanupWorkspace = (folder: vscode.WorkspaceFolder): void => {
    void cleanupWorkspaceTransferTempFiles({ workspaceRoot: folder.uri.fsPath }).catch((error) => {
      logError(`Could not clean workspace transfer temp files: ${folder.uri.fsPath}`, error);
    });
    void cleanupWorkspaceDestinationTempFiles({ workspaceRoot: folder.uri.fsPath }).catch(
      (error) => {
        logError(`Could not clean workspace destination temp files: ${folder.uri.fsPath}`, error);
      },
    );
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

export function createAuthenticatedClientSetter(
  scheduleCleanups: (client: B2Client) => void = scheduleAuthenticatedCleanups,
  assignClient: (client: B2Client | null) => void = (client) => {
    currentClient = client;
  },
): (client: B2Client | null) => void {
  return (client) => {
    assignClient(client);
    if (client) {
      scheduleCleanups(client);
    }
  };
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
  let treeView: vscode.TreeView<B2TreeItem>;
  const uploadServices = {
    treeProvider,
    getClient: () => currentClient,
    getSelectedUploadTarget: () => {
      const selected = treeView.selection[0];
      return isUploadTargetTreeItem(selected) ? selected : undefined;
    },
  };
  const dragAndDropController = new B2TreeDragAndDropController((target, uris, token) =>
    uploadLocalUrisToTarget(target, uris, uploadServices, token),
  );

  // 3. Register tree view
  treeView = vscode.window.createTreeView(VIEW_BUCKETS, {
    treeDataProvider: treeProvider,
    dragAndDropController,
    showCollapseAll: true,
  });

  // 4. Status bar
  const statusBar = new B2StatusBar(authService);

  // 5. Register commands
  const setAuthenticatedClient = createAuthenticatedClientSetter();
  registerCommands({
    context,
    authService,
    treeProvider,
    tempFileManager,
    isAuthenticated: () => currentClient !== null,
    getClient: () => currentClient,
    getSelectedUploadTarget: uploadServices.getSelectedUploadTarget,
    setClient: setAuthenticatedClient,
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

      setAuthenticatedClient(client);
      treeProvider.setClient(client);

      await authService.setAuthState({
        isAuthenticated: true,
        accountId: client.accountInfo.getAccountId(),
        apiUrl: client.accountInfo.getApiUrl(),
        downloadUrl: client.accountInfo.getDownloadUrl(),
      });

      log(`Auto-authenticated as ${client.accountInfo.getAccountId()}`);
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
