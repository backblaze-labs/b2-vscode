/**
 * Command registrations for the B2 extension.
 *
 * Most command handlers stay inline in registerCommands. Safety-critical flows
 * that need command-path tests can be extracted behind narrow service
 * interfaces; public bucket visibility changes use that pattern because they
 * can expose bucket contents.
 *
 * @module commands
 */

import * as vscode from "vscode";
import type { B2Client } from "@backblaze-labs/b2-sdk";
import { BufferSource } from "@backblaze-labs/b2-sdk";
import type { AuthService } from "../services/authService";
import type { B2TreeProvider } from "../providers/b2TreeProvider";
import type { TempFileManager } from "../services/tempFileManager";
import { BucketTreeItem } from "../models/bucketTreeItem";
import { FolderTreeItem } from "../models/folderTreeItem";
import { FileTreeItem } from "../models/fileTreeItem";
import { LoadMoreTreeItem } from "../models/loadMoreTreeItem";
import { registerB2Tools } from "../tools/registration";
import { createConfiguredB2Client } from "../services/b2";
import {
  createTransferProgressReporter,
  withCancellableTransferProgress,
} from "../services/transferProgress";
import { withTransferStallTimeout } from "../services/fileTransfers";
import { B2PartialFailureError, formatB2UserMessage, isB2MutationStateAmbiguous } from "../errors";
import { log, logError } from "../logger";
import {
  buildPublicBucketUnknownStateWarningMessage,
  buildPublicBucketTypedConfirmationValidationMessage,
  buildPublicBucketWarningMessage,
  buildPublicBucketTypedConfirmationPrompt,
  CONFIRM_PUBLIC_BUCKET_LABEL,
  isPublicBucketConfirmationAccepted,
  isPublicBucketNameConfirmationAccepted,
  PUBLIC_BUCKET_TYPED_CONFIRMATION_PLACEHOLDER,
  shouldConfirmPublicBucketVisibility,
  type PublicBucketVisibilityAction,
} from "./publicBucketVisibility";

export function buildCommandErrorMessage(prefix: string, error: unknown): string {
  return `${prefix}. ${formatB2UserMessage(error)}`;
}

function showCommandError(prefix: string, error: unknown): void {
  logError(prefix, error);
  vscode.window.showErrorMessage(buildCommandErrorMessage(prefix, error));
}

async function confirmPublicBucketVisibility(
  action: PublicBucketVisibilityAction,
  bucketName: string,
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    buildPublicBucketWarningMessage(action, bucketName),
    { modal: true },
    CONFIRM_PUBLIC_BUCKET_LABEL,
  );

  if (!isPublicBucketConfirmationAccepted(answer)) {
    return false;
  }

  const typedBucketName = await vscode.window.showInputBox({
    title: "Confirm Public Bucket",
    prompt: buildPublicBucketTypedConfirmationPrompt(bucketName),
    placeHolder: PUBLIC_BUCKET_TYPED_CONFIRMATION_PLACEHOLDER,
    ignoreFocusOut: true,
    validateInput: (value) =>
      isPublicBucketNameConfirmationAccepted(bucketName, value)
        ? undefined
        : buildPublicBucketTypedConfirmationValidationMessage(bucketName),
  });

  // Keep this guard authoritative: tests and extension-host edge cases can
  // bypass validateInput by returning undefined or a stale value.
  return isPublicBucketNameConfirmationAccepted(bucketName, typedBucketName);
}

/**
 * Services required by commands.
 */
export interface CommandServices {
  authService: AuthService;
  treeProvider: B2TreeProvider;
  tempFileManager: TempFileManager;
  context: vscode.ExtensionContext;
  getClient: () => B2Client | null;
  setClient: (client: B2Client | null) => void;
}

export interface OpenFileCommandServices {
  tempFileManager: TempFileManager;
  getClient: () => B2Client | null;
}

export async function openFileCommand(
  item: FileTreeItem,
  services: OpenFileCommandServices,
): Promise<void> {
  const { tempFileManager, getClient } = services;

  if (!getClient()) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return;
  }

  const cached = tempFileManager.getCachedPath(item.bucketName, item.file.fileName);
  if (cached) {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(cached));
    return;
  }

  try {
    await withCancellableTransferProgress(
      { title: `Downloading ${item.file.fileName}...` },
      async ({ progress, signal }) => {
        const reporter = createTransferProgressReporter(progress, item.file.contentLength);
        const { body } = await withTransferStallTimeout(
          `Download request for b2://${item.bucketName}/${item.file.fileName}`,
          { signal },
          (requestSignal, markActivity) =>
            item.bucket.download(item.file.fileName, {
              signal: requestSignal,
              onProgress: (event) => {
                markActivity();
                reporter(event);
              },
            }),
        );
        const localPath = await tempFileManager.saveStream(
          item.bucketName,
          item.file.fileName,
          body,
          { signal },
        );
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(localPath));
      },
    );
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      return;
    }
    showCommandError("B2: Failed to open file", error);
  }
}

export interface BucketCommandServices {
  treeProvider: Pick<B2TreeProvider, "refresh">;
  getClient: () => B2Client | null;
}

async function warnUnknownPublicBucketState(
  services: BucketCommandServices,
  action: PublicBucketVisibilityAction,
  bucketName: string,
): Promise<void> {
  services.treeProvider.refresh();
  await vscode.window.showWarningMessage(
    buildPublicBucketUnknownStateWarningMessage(action, bucketName),
    { modal: true },
  );
}

export async function createBucketCommand(services: BucketCommandServices): Promise<void> {
  const { treeProvider, getClient } = services;
  const client = getClient();
  if (!client) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return;
  }

  const bucketName = await vscode.window.showInputBox({
    title: "Create B2 Bucket",
    prompt: "Enter a name for the new bucket",
    placeHolder: "my-new-bucket",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value) {
        return "Bucket name is required";
      }
      if (value.length < 6) {
        return "Bucket name must be at least 6 characters";
      }
      if (value.length > 50) {
        return "Bucket name must be at most 50 characters";
      }
      if (!/^[a-zA-Z0-9-]+$/.test(value)) {
        return "Bucket name can only contain letters, digits, and hyphens";
      }
      return undefined;
    },
  });
  if (!bucketName) {
    return;
  }

  const visibility = await vscode.window.showQuickPick(
    [
      {
        label: "Private",
        description: "Files require authorization to access",
        value: "allPrivate" as const,
      },
      {
        label: "Public",
        description: "Files can be accessed without authorization",
        value: "allPublic" as const,
      },
    ],
    {
      title: "Bucket Visibility",
      placeHolder: "Select bucket visibility",
      ignoreFocusOut: true,
    },
  );
  if (!visibility) {
    return;
  }

  if (
    shouldConfirmPublicBucketVisibility(undefined, visibility.value) &&
    !(await confirmPublicBucketVisibility("create", bucketName))
  ) {
    return;
  }

  try {
    const bucket = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating B2 bucket "${bucketName}"...`,
        cancellable: false,
      },
      () =>
        client.createBucket({
          bucketName,
          bucketType: visibility.value,
        }),
    );
    treeProvider.refresh();
    log(`Bucket "${bucket.name}" created with type ${visibility.value}.`);
    vscode.window.showInformationMessage(`B2: Bucket "${bucket.name}" created.`);
  } catch (error) {
    if (visibility.value === "allPublic" && isB2MutationStateAmbiguous(error)) {
      await warnUnknownPublicBucketState(services, "create", bucketName);
    }
    showCommandError("B2: Failed to create bucket", error);
  }
}

export async function changeBucketVisibilityCommand(
  services: BucketCommandServices,
  item?: BucketTreeItem,
): Promise<void> {
  const { treeProvider, getClient } = services;
  if (!getClient()) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return;
  }
  if (!item) {
    vscode.window.showErrorMessage("B2: Select a bucket first.");
    return;
  }

  // The tree item is the state the user saw and confirmed. A post-mutation
  // refresh, including on uncertain public failures, reconciles any out-of-band changes.
  const currentType = item.bucketType;
  const newType = currentType === "allPublic" ? "allPrivate" : "allPublic";
  const newLabel = newType === "allPublic" ? "Public" : "Private";
  const currentLabel = currentType === "allPublic" ? "Public" : "Private";

  const confirm = await vscode.window.showQuickPick(
    [
      {
        label: `Change to ${newLabel}`,
        description: `Currently: ${currentLabel}`,
        value: true,
      },
      { label: "Cancel", value: false },
    ],
    {
      title: `Change Visibility: ${item.bucketName}`,
      placeHolder: `Bucket is currently ${currentLabel}`,
      ignoreFocusOut: true,
    },
  );

  if (!confirm?.value) {
    return;
  }

  if (
    shouldConfirmPublicBucketVisibility(currentType, newType) &&
    !(await confirmPublicBucketVisibility("change", item.bucketName))
  ) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Changing "${item.bucketName}" to ${newLabel}...`,
        cancellable: false,
      },
      () => item.bucket.update({ bucketType: newType }),
    );
    treeProvider.refresh();
    log(`Bucket "${item.bucketName}" changed to ${newType}.`);
    vscode.window.showInformationMessage(`B2: "${item.bucketName}" is now ${newLabel}.`);
  } catch (error) {
    if (newType === "allPublic" && isB2MutationStateAmbiguous(error)) {
      await warnUnknownPublicBucketState(services, "change", item.bucketName);
    }
    showCommandError("B2: Failed to update bucket", error);
  }
}

/**
 * Register all B2 commands.
 */
export function registerCommands(services: CommandServices): void {
  const { context, authService, treeProvider, tempFileManager, getClient, setClient } = services;

  // ── Authenticate ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.authenticate", async () => {
      const keyId = await vscode.window.showInputBox({
        title: "B2 Application Key ID",
        prompt: "Enter your Backblaze B2 application key ID",
        placeHolder: "00123456789abcdef0000000n",
        ignoreFocusOut: true,
      });
      if (!keyId) {
        return;
      }

      const appKey = await vscode.window.showInputBox({
        title: "B2 Application Key",
        prompt: "Enter your Backblaze B2 application key",
        password: true,
        ignoreFocusOut: true,
      });
      if (!appKey) {
        return;
      }

      try {
        const client = await createConfiguredB2Client(
          { keyId, appKey },
          context.extension.packageJSON.version,
        );
        await client.authorize();

        await authService.storeCredentials(keyId, appKey);
        setClient(client);
        treeProvider.setClient(client);

        await authService.setAuthState({
          isAuthenticated: true,
          accountId: client.accountInfo.getAccountId(),
          apiUrl: client.accountInfo.getApiUrl(),
          downloadUrl: client.accountInfo.getDownloadUrl(),
        });

        // Register Copilot tools now that we have a client
        registerB2Tools(context, client);

        vscode.window.showInformationMessage(
          `B2: Authenticated as ${client.accountInfo.getAccountId()}`,
        );
      } catch (error) {
        showCommandError("B2: Authentication failed", error);
        await authService.setAuthState({
          isAuthenticated: false,
          error: formatB2UserMessage(error),
        });
      }
    }),
  );

  // ── Create Bucket ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.createBucket", () => createBucketCommand(services)),
  );

  // ── Change Bucket Visibility ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.changeBucketVisibility", (item?: BucketTreeItem) =>
      changeBucketVisibilityCommand(services, item),
    ),
  );

  // ── Create Folder ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "b2.createFolder",
      async (item?: BucketTreeItem | FolderTreeItem) => {
        if (!getClient()) {
          vscode.window.showErrorMessage("B2: Not authenticated.");
          return;
        }
        if (!item) {
          vscode.window.showErrorMessage("B2: Select a bucket or folder first.");
          return;
        }

        const folderName = await vscode.window.showInputBox({
          title: "Create Folder",
          prompt: `Create a new folder inside "${item instanceof BucketTreeItem ? item.bucketName : item.prefix}"`,
          placeHolder: "my-folder",
          ignoreFocusOut: true,
          validateInput: (value) => {
            if (!value) {
              return "Folder name is required";
            }
            if (value.includes("/")) {
              return "Folder name cannot contain '/'";
            }
            return undefined;
          },
        });
        if (!folderName) {
          return;
        }

        const prefix = item instanceof FolderTreeItem ? item.prefix : "";
        const fullPath = `${prefix}${folderName}/.bzEmpty`;

        try {
          await item.bucket.upload({
            fileName: fullPath,
            source: new BufferSource(new Uint8Array(0)),
            contentType: "application/x-bzEmpty",
          });
          treeProvider.refresh();
          vscode.window.showInformationMessage(`B2: Folder "${folderName}" created.`);
        } catch (error) {
          showCommandError("B2: Failed to create folder", error);
        }
      },
    ),
  );

  // ── Delete Bucket ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.deleteBucket", async (item?: BucketTreeItem) => {
      if (!getClient() || !item) {
        return;
      }

      const answer = await vscode.window.showWarningMessage(
        `Delete bucket "${item.bucketName}"? This cannot be undone. The bucket must be empty.`,
        { modal: true },
        "Delete",
      );
      if (answer !== "Delete") {
        return;
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Deleting bucket "${item.bucketName}"...`,
          },
          () => item.bucket.delete(),
        );
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: Bucket "${item.bucketName}" deleted.`);
      } catch (error) {
        showCommandError("B2: Failed to delete bucket", error);
      }
    }),
  );

  // ── Delete Folder ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.deleteFolder", async (item?: FolderTreeItem) => {
      if (!getClient() || !item) {
        return;
      }

      const answer = await vscode.window.showWarningMessage(
        `Delete folder "${item.prefix}" and ALL files inside it? This cannot be undone.`,
        { modal: true },
        "Delete",
      );
      if (answer !== "Delete") {
        return;
      }

      try {
        const count = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Deleting "${item.prefix}"...`,
            cancellable: false,
          },
          async () => {
            let deleted = 0;
            const errors: Array<{ fileName: string; message: string }> = [];
            for await (const event of item.bucket.deleteAll({ prefix: item.prefix })) {
              if (event.type === "delete") {
                deleted++;
              } else if (event.type === "error") {
                errors.push({ fileName: event.fileName, message: event.message });
              }
            }
            if (errors.length > 0) {
              const firstError = errors[0];
              throw new B2PartialFailureError(
                `Deleted ${deleted} file(s), but ${errors.length} file(s) failed. First failed file: ${firstError.fileName}. ${firstError.message}`,
              );
            }
            return deleted;
          },
        );
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: Deleted ${count} file(s) from "${item.prefix}".`);
      } catch (error) {
        showCommandError("B2: Failed to delete folder", error);
      }
    }),
  );

  // ── Delete File ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.deleteFile", async (item?: FileTreeItem) => {
      if (!getClient() || !item) {
        return;
      }

      const segments = item.file.fileName.split("/");
      const displayName = segments[segments.length - 1];

      const answer = await vscode.window.showWarningMessage(
        `Delete "${displayName}"? This cannot be undone.`,
        { modal: true },
        "Delete",
      );
      if (answer !== "Delete") {
        return;
      }

      try {
        await item.bucket.deleteFileVersion(item.file.fileName, item.file.fileId);
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: "${displayName}" deleted.`);
      } catch (error) {
        showCommandError("B2: Failed to delete file", error);
      }
    }),
  );

  // ── Rename File ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.renameFile", async (item?: FileTreeItem) => {
      if (!getClient() || !item) {
        return;
      }

      const oldPath = item.file.fileName;
      const segments = oldPath.split("/");
      const oldName = segments[segments.length - 1];
      const parentPrefix = segments.slice(0, -1).join("/");
      const prefixWithSlash = parentPrefix ? `${parentPrefix}/` : "";

      const newName = await vscode.window.showInputBox({
        title: "Rename File",
        prompt: `Rename "${oldName}"`,
        value: oldName,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value) {
            return "File name is required";
          }
          if (value.includes("/")) {
            return "File name cannot contain '/'";
          }
          if (value === oldName) {
            return "Name is unchanged";
          }
          return undefined;
        },
      });
      if (!newName) {
        return;
      }

      const newPath = `${prefixWithSlash}${newName}`;

      try {
        let copyCompleted = false;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Renaming to "${newName}"...` },
          async () => {
            // Server-side copy then delete the original
            try {
              await item.bucket.copyFile({ sourceFileId: item.file.fileId, fileName: newPath });
              copyCompleted = true;
              await item.bucket.deleteFileVersion(oldPath, item.file.fileId);
            } catch (error) {
              if (copyCompleted) {
                throw new B2PartialFailureError(
                  `Rename incomplete. Copied "${oldPath}" to "${newPath}", but failed to delete the original. Both B2 objects may exist. ${formatB2UserMessage(error)}`,
                  error,
                );
              }
              throw error;
            }
          },
        );
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: Renamed to "${newName}".`);
      } catch (error) {
        showCommandError("B2: Failed to rename", error);
      }
    }),
  );

  // ── Logout ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.logout", async () => {
      await authService.clearCredentials();
      setClient(null);
      treeProvider.setClient(null);
      await authService.setAuthState({ isAuthenticated: false });
      vscode.window.showInformationMessage("B2: Logged out.");
    }),
  );

  // ── Refresh ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.refresh", () => {
      treeProvider.refresh();
    }),
  );

  // ── Load More ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.loadMore", async (item?: LoadMoreTreeItem) => {
      if (item) {
        await treeProvider.loadMore(item);
      }
    }),
  );

  // ── Copy B2 Path ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "b2.copyPath",
      async (item?: BucketTreeItem | FolderTreeItem | FileTreeItem) => {
        let b2Path: string;

        if (item instanceof BucketTreeItem) {
          b2Path = `b2://${item.bucketName}`;
        } else if (item instanceof FolderTreeItem) {
          b2Path = `b2://${item.bucketName}/${item.prefix}`;
        } else if (item instanceof FileTreeItem) {
          b2Path = `b2://${item.bucketName}/${item.file.fileName}`;
        } else {
          return;
        }

        await vscode.env.clipboard.writeText(b2Path);
        vscode.window.showInformationMessage(`Copied: ${b2Path}`);
      },
    ),
  );

  // ── Copy File ID ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.copyFileId", async (item: FileTreeItem) => {
      await vscode.env.clipboard.writeText(item.file.fileId);
      vscode.window.showInformationMessage(`Copied file ID: ${item.file.fileId}`);
    }),
  );

  // ── Open File ───────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.openFile", (item: FileTreeItem) =>
      openFileCommand(item, { tempFileManager, getClient }),
    ),
  );
}
