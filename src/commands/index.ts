/**
 * Command registrations for the B2 extension.
 *
 * @module commands
 */

import * as vscode from "vscode";
import { B2Client } from "../services/b2Client";
import type { AuthService } from "../services/authService";
import type { B2TreeProvider } from "../providers/b2TreeProvider";
import type { TempFileManager } from "../services/tempFileManager";
import { BucketTreeItem } from "../models/bucketTreeItem";
import { FolderTreeItem } from "../models/folderTreeItem";
import { FileTreeItem } from "../models/fileTreeItem";
import { registerB2Tools } from "../tools/registration";

/**
 * Extract a human-friendly message from B2 API errors.
 * B2 errors come as JSON: { "code": "...", "message": "...", "status": N }
 */
function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  // Try to parse the JSON body from "B2 API error (NNN): { ... }"
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { code?: string; message?: string };
      if (parsed.message) {
        return parsed.message;
      }
    } catch {
      // fall through
    }
  }

  return raw;
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
        const client = new B2Client(keyId, appKey);
        const authResponse = await client.authorize();

        await authService.storeCredentials(keyId, appKey);
        setClient(client);
        treeProvider.setClient(client);

        await authService.setAuthState({
          isAuthenticated: true,
          accountId: authResponse.accountId,
          apiUrl: authResponse.apiUrl,
          downloadUrl: authResponse.downloadUrl,
        });

        // Register Copilot tools now that we have a client
        registerB2Tools(context, client);

        vscode.window.showInformationMessage(`B2: Authenticated as ${authResponse.accountId}`);
      } catch (error) {
        vscode.window.showErrorMessage(`B2: Authentication failed — ${friendlyError(error)}`);
        await authService.setAuthState({ isAuthenticated: false, error: friendlyError(error) });
      }
    }),
  );

  // ── Create Bucket ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.createBucket", async () => {
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

      try {
        const bucket = await client.createBucket(bucketName, visibility.value);
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: Bucket "${bucket.bucketName}" created.`);
      } catch (error) {
        vscode.window.showErrorMessage(`B2: Failed to create bucket — ${friendlyError(error)}`);
      }
    }),
  );

  // ── Change Bucket Visibility ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.changeBucketVisibility", async (item?: BucketTreeItem) => {
      const client = getClient();
      if (!client) {
        vscode.window.showErrorMessage("B2: Not authenticated.");
        return;
      }

      if (!item) {
        vscode.window.showErrorMessage("B2: Select a bucket first.");
        return;
      }

      const currentType = item.bucket.bucketType;
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
          title: `Change Visibility — ${item.bucketName}`,
          placeHolder: `Bucket is currently ${currentLabel}`,
          ignoreFocusOut: true,
        },
      );

      if (!confirm?.value) {
        return;
      }

      try {
        await client.updateBucket(item.bucket.bucketId, newType);
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: "${item.bucketName}" is now ${newLabel}.`);
      } catch (error) {
        vscode.window.showErrorMessage(`B2: Failed to update bucket — ${friendlyError(error)}`);
      }
    }),
  );

  // ── Create Folder ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "b2.createFolder",
      async (item?: BucketTreeItem | FolderTreeItem) => {
        const client = getClient();
        if (!client) {
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

        const bucketId = item instanceof BucketTreeItem ? item.bucketId : item.bucketId;
        const prefix = item instanceof FolderTreeItem ? item.prefix : "";
        const fullPath = `${prefix}${folderName}/.bzEmpty`;

        try {
          await client.uploadFile(bucketId, fullPath, Buffer.alloc(0), "application/x-bzEmpty");
          treeProvider.refresh();
          vscode.window.showInformationMessage(`B2: Folder "${folderName}" created.`);
        } catch (error) {
          vscode.window.showErrorMessage(`B2: Failed to create folder — ${friendlyError(error)}`);
        }
      },
    ),
  );

  // ── Delete Bucket ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.deleteBucket", async (item?: BucketTreeItem) => {
      const client = getClient();
      if (!client || !item) {
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
          () => client.deleteBucket(item.bucketId),
        );
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: Bucket "${item.bucketName}" deleted.`);
      } catch (error) {
        vscode.window.showErrorMessage(`B2: Failed to delete bucket — ${friendlyError(error)}`);
      }
    }),
  );

  // ── Delete Folder ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.deleteFolder", async (item?: FolderTreeItem) => {
      const client = getClient();
      if (!client || !item) {
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
          () => client.deleteAllFilesWithPrefix(item.bucketId, item.prefix),
        );
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: Deleted ${count} file(s) from "${item.prefix}".`);
      } catch (error) {
        vscode.window.showErrorMessage(`B2: Failed to delete folder — ${friendlyError(error)}`);
      }
    }),
  );

  // ── Delete File ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.deleteFile", async (item?: FileTreeItem) => {
      const client = getClient();
      if (!client || !item) {
        return;
      }

      const segments = item.fileInfo.fileName.split("/");
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
        await client.deleteFileVersion(item.fileInfo.fileId, item.fileInfo.fileName);
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: "${displayName}" deleted.`);
      } catch (error) {
        vscode.window.showErrorMessage(`B2: Failed to delete file — ${friendlyError(error)}`);
      }
    }),
  );

  // ── Rename File ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.renameFile", async (item?: FileTreeItem) => {
      const client = getClient();
      if (!client || !item) {
        return;
      }

      const oldPath = item.fileInfo.fileName;
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
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Renaming to "${newName}"...` },
          async () => {
            // Server-side copy then delete the original
            await client.copyFile(item.fileInfo.fileId, item.bucketId, newPath);
            await client.deleteFileVersion(item.fileInfo.fileId, oldPath);
          },
        );
        treeProvider.refresh();
        vscode.window.showInformationMessage(`B2: Renamed to "${newName}".`);
      } catch (error) {
        vscode.window.showErrorMessage(`B2: Failed to rename — ${friendlyError(error)}`);
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

  // ── Copy B2 Path ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "b2.copyPath",
      async (item: BucketTreeItem | FolderTreeItem | FileTreeItem) => {
        let b2Path: string;

        if (item instanceof BucketTreeItem) {
          b2Path = `b2://${item.bucketName}`;
        } else if (item instanceof FolderTreeItem) {
          b2Path = `b2://${item.bucketName}/${item.prefix}`;
        } else {
          b2Path = `b2://${item.bucketName}/${item.fileInfo.fileName}`;
        }

        await vscode.env.clipboard.writeText(b2Path);
        vscode.window.showInformationMessage(`Copied: ${b2Path}`);
      },
    ),
  );

  // ── Copy File ID ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.copyFileId", async (item: FileTreeItem) => {
      await vscode.env.clipboard.writeText(item.fileInfo.fileId);
      vscode.window.showInformationMessage(`Copied file ID: ${item.fileInfo.fileId}`);
    }),
  );

  // ── Open File ───────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.openFile", async (item: FileTreeItem) => {
      const client = getClient();
      if (!client) {
        vscode.window.showErrorMessage("B2: Not authenticated.");
        return;
      }

      // Check cache first
      const cached = tempFileManager.getCachedPath(item.bucketName, item.fileInfo.fileName);
      if (cached) {
        const uri = vscode.Uri.file(cached);
        await vscode.commands.executeCommand("vscode.open", uri);
        return;
      }

      // Download and open
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${item.fileInfo.fileName}...`,
          cancellable: false,
        },
        async () => {
          const data = await client.downloadFile(item.bucketName, item.fileInfo.fileName);
          const localPath = await tempFileManager.saveFile(
            item.bucketName,
            item.fileInfo.fileName,
            data,
          );
          const uri = vscode.Uri.file(localPath);
          await vscode.commands.executeCommand("vscode.open", uri);
        },
      );
    }),
  );
}
