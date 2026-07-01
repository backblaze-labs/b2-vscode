/**
 * Command registrations for the B2 extension.
 *
 * Most command handlers stay inline in registerCommands. Handlers that need
 * command-path tests can be extracted behind narrow service interfaces; public
 * bucket visibility changes are one example because they can expose bucket
 * contents.
 *
 * @module commands
 */

import * as vscode from "vscode";
import type { B2Client, Bucket, BucketType } from "@backblaze-labs/b2-sdk";
import type { AuthService, B2Credentials } from "../services/authService";
import type { B2TreeProvider } from "../providers/b2TreeProvider";
import type { TempFileManager } from "../services/tempFileManager";
import { BucketTreeItem } from "../models/bucketTreeItem";
import { FolderTreeItem } from "../models/folderTreeItem";
import { FileTreeItem } from "../models/fileTreeItem";
import { LoadMoreTreeItem } from "../models/loadMoreTreeItem";
import { createConfiguredB2Client } from "../services/b2";
import {
  createTransferProgressReporter,
  withCancellableTransferProgress,
} from "../services/transferProgress";
import {
  type TransferTimeoutOptions,
  uploadEmptyObject,
  withTransferStallTimeout,
} from "../services/fileTransfers";
import {
  B2MutationTimeoutError,
  B2PartialFailureError,
  B2ShareLinkError,
  formatB2DiagnosticMessage,
  formatB2UserMessage,
  isBucketRevisionConflict,
  isPostRequestB2MutationStateAmbiguous,
  redactSensitiveText,
} from "../errors";
import { log, logError } from "../logger";
import {
  createPrefixScopedDownloadUrl,
  SHARE_LINK_AUTHORIZATION_TIMEOUT_MS,
  throwIfAborted,
  type LateShareLinkAuthorizationEvent,
} from "../services/shareLink";
import { withTimeout } from "../services/transferTimeout";
import {
  DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS,
  MAX_PRESIGN_URL_EXPIRES_IN_SECONDS,
} from "../tools/presignUrlLimits";
import {
  bucketTypeLabel,
  buildPublicBucketUnknownStateWarningMessage,
  buildPublicBucketTypedConfirmationValidationMessage,
  buildPublicBucketWarningMessage,
  buildPublicBucketTypedConfirmationPrompt,
  CONFIRM_PUBLIC_BUCKET_LABEL,
  isPublicBucketConfirmationAccepted,
  isPublicBucketNameConfirmationAccepted,
  isPublicPrivateBucketType,
  PUBLIC_BUCKET_TYPED_CONFIRMATION_PLACEHOLDER,
  shouldConfirmPublicBucketVisibility,
  type PublicPrivateBucketType,
  type PublicBucketVisibilityAction,
} from "./publicBucketVisibility";
import { renameFileVersion } from "./renameFile";

const BUCKET_MUTATION_TIMEOUT_MS = 2 * 60 * 1000;
const BUCKET_MUTATION_POST_TIMEOUT_SETTLE_MS = 1_000;

type CreateBucketOptions = Parameters<B2Client["createBucket"]>[0];
type CreateBucketResult = ReturnType<B2Client["createBucket"]>;
type BucketUpdateOptions = Parameters<Bucket["update"]>[0];
type BucketUpdateResult = ReturnType<Bucket["update"]>;
type AbortableCreateBucketOptions = CreateBucketOptions & { readonly signal?: AbortSignal };
type AbortableBucketUpdateOptions = BucketUpdateOptions & { readonly signal?: AbortSignal };
export type ConfiguredB2ClientFactory = (
  credentials: B2Credentials,
  extensionVersion: string,
) => Promise<B2Client>;

export interface BucketCreationClient {
  createBucket(options: AbortableCreateBucketOptions): CreateBucketResult;
}

export interface BucketVisibilityItem {
  readonly bucketName: string;
  readonly bucketType: BucketType;
  readonly bucket: {
    readonly info: {
      readonly revision?: number;
    };
    update(options: AbortableBucketUpdateOptions): BucketUpdateResult;
  };
}

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

function validateBucketName(bucketName: string): string | undefined {
  if (!bucketName) {
    return "Bucket name is required";
  }
  if (bucketName.length < 6) {
    return "Bucket name must be at least 6 characters";
  }
  if (bucketName.length > 50) {
    return "Bucket name must be at most 50 characters";
  }
  if (!/^[a-zA-Z0-9-]+$/.test(bucketName)) {
    return "Bucket name can only contain letters, digits, and hyphens";
  }
  return undefined;
}

function validateFolderName(folderName: string): string | undefined {
  if (!folderName) {
    return "Folder name is required";
  }
  if (folderName.includes("/") || folderName.includes("\\")) {
    return "Folder name cannot contain path separators";
  }
  if (/[\0-\x1f\x7f]/u.test(folderName)) {
    return "Folder name cannot contain control characters";
  }
  if (folderName === "." || folderName === "..") {
    return "Folder name cannot be '.' or '..'";
  }
  return undefined;
}

function withAbortSignal<T extends object>(
  options: T,
  signal: AbortSignal,
): T & { readonly signal: AbortSignal } {
  return { ...options, signal };
}

async function withBucketMutationTimeout<T>(
  description: string,
  timeoutMs: number,
  postTimeoutSettleMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (timeoutMs <= 0) {
    return operation(controller.signal);
  }

  const operationPromise = operation(controller.signal);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new B2MutationTimeoutError(`${description} timed out after ${timeoutMs} ms.`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operationPromise, timeout]);
  } catch (error) {
    const observeLateSettlement = () => {
      void operationPromise.then(
        () => {
          log(`${description} completed after the client-side timeout`);
        },
        (lateError) => {
          logError(`${description} failed after the client-side timeout`, lateError);
        },
      );
    };

    if (!(error instanceof B2MutationTimeoutError)) {
      throw error;
    }

    if (postTimeoutSettleMs <= 0) {
      observeLateSettlement();
      throw error;
    }

    let settleTimer: NodeJS.Timeout | undefined;
    let settleTimedOut = false;
    const settleTimeout = new Promise<never>((_resolve, reject) => {
      settleTimer = setTimeout(() => {
        settleTimedOut = true;
        reject(error);
      }, postTimeoutSettleMs);
      settleTimer.unref?.();
    });

    try {
      return await Promise.race([operationPromise, settleTimeout]);
    } catch (settleError) {
      if (settleTimedOut) {
        observeLateSettlement();
      } else {
        logError(`${description} failed while settling after the client-side timeout`, settleError);
      }
      throw error;
    } finally {
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Services required by commands.
 */
export interface BucketCommandServices {
  treeProvider: Pick<B2TreeProvider, "refresh">;
  isAuthenticated: () => boolean;
  bucketMutationTimeoutMs?: number;
  bucketMutationPostTimeoutSettleMs?: number;
}

export interface CreateBucketCommandServices extends BucketCommandServices {
  getClient: () => BucketCreationClient | null;
}

export interface CommandServices extends CreateBucketCommandServices {
  authService: AuthService;
  treeProvider: B2TreeProvider;
  tempFileManager: TempFileManager;
  context: vscode.ExtensionContext;
  getClient: () => B2Client | null;
  setClient: (client: B2Client | null) => void;
  createClient?: ConfiguredB2ClientFactory;
}

export interface OpenFileCommandServices {
  tempFileManager: TempFileManager;
  getClient: () => B2Client | null;
}

export interface CopyShareLinkCommandServices {
  getClient: () => Pick<B2Client, "accountInfo"> | null;
  writeClipboardText?: (value: string) => Thenable<void>;
  shareLinkTimeoutMs?: number;
  onLateAuthorization?: (event: LateShareLinkAuthorizationEvent) => void;
  now?: () => Date;
}

export interface CreateFolderCommandServices {
  treeProvider: Pick<B2TreeProvider, "refresh">;
  getClient: () => B2Client | null;
}

function parseShareLinkExpiresIn(input: string): number | undefined {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const expiresIn = Number(trimmed);
  return Number.isSafeInteger(expiresIn) ? expiresIn : undefined;
}

export function validateShareLinkExpiresInInput(value: string): string | undefined {
  const expiresIn = parseShareLinkExpiresIn(value);
  if (expiresIn === undefined || expiresIn < 1 || expiresIn > MAX_PRESIGN_URL_EXPIRES_IN_SECONDS) {
    return `Enter a whole number of seconds from 1 to ${MAX_PRESIGN_URL_EXPIRES_IN_SECONDS}.`;
  }
  return undefined;
}

function signalFromCancellationToken(token: vscode.CancellationToken): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new vscode.CancellationError());
    }
  };
  if (token.isCancellationRequested) {
    abort();
  }
  const subscription = token.onCancellationRequested(abort);
  return {
    signal: controller.signal,
    dispose: () => subscription.dispose(),
  };
}

function redactedCommandLateAuthorizationError(error: unknown): unknown {
  if (error instanceof Error) {
    const redactedError = new Error(redactSensitiveText(error.message));
    redactedError.name = error.name;
    return redactedError;
  }
  return error === undefined ? undefined : redactSensitiveText(String(error));
}

function logShareLinkLateAuthorization(event: LateShareLinkAuthorizationEvent): void {
  const message =
    event.status === "completed"
      ? `Share-link download authorization completed after timeout or cancellation for prefix ${event.filePath}; the discarded B2 token may remain valid until expiry.`
      : `Share-link download authorization failed after timeout or cancellation for prefix ${event.filePath}`;
  const detail = redactedCommandLateAuthorizationError(
    event.status === "completed" ? event.reason : event.error,
  );
  const safeMessage = redactSensitiveText(message);

  if (detail === undefined) {
    log(safeMessage);
    return;
  }

  log(`${safeMessage} - ${formatB2DiagnosticMessage(detail)}`);
}

function formatShareLinkTimeoutForUser(timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
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

export async function copyShareLinkCommand(
  item: FileTreeItem | undefined,
  services: CopyShareLinkCommandServices,
): Promise<void> {
  const client = services.getClient();
  if (!client) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return;
  }
  if (!item) {
    vscode.window.showErrorMessage("B2: Select a file first.");
    return;
  }

  const expiresInInput = await vscode.window.showInputBox({
    title: "Copy Share Link",
    prompt: `Enter link TTL in seconds (1-${MAX_PRESIGN_URL_EXPIRES_IN_SECONDS})`,
    value: String(DEFAULT_PRESIGN_URL_EXPIRES_IN_SECONDS),
    placeHolder: "3600",
    ignoreFocusOut: true,
    validateInput: validateShareLinkExpiresInInput,
  });
  if (expiresInInput === undefined) {
    return;
  }

  const validationError = validateShareLinkExpiresInInput(expiresInInput);
  if (validationError) {
    vscode.window.showErrorMessage(`B2: ${validationError}`);
    return;
  }

  const expiresIn = parseShareLinkExpiresIn(expiresInInput);
  if (expiresIn === undefined) {
    vscode.window.showErrorMessage("B2: Invalid share link TTL.");
    return;
  }

  try {
    const { expiresAt } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating share link for "${item.file.fileName}"...`,
        cancellable: true,
      },
      async (_progress, token) => {
        const writeClipboardText =
          services.writeClipboardText ?? ((value: string) => vscode.env.clipboard.writeText(value));
        const cancellation = signalFromCancellationToken(token);
        try {
          return await withTimeout(
            async (signal) => {
              const shareLink = await createPrefixScopedDownloadUrl({
                bucket: item.bucket,
                bucketName: item.bucketName,
                filePath: item.file.fileName,
                downloadUrl: client.accountInfo.getDownloadUrl(),
                expiresIn,
                signal,
                onLateAuthorization: services.onLateAuthorization ?? logShareLinkLateAuthorization,
              });
              throwIfAborted(signal);
              await writeClipboardText(shareLink.url);
              throwIfAborted(signal);
              const now = services.now?.() ?? new Date();
              return {
                expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
              };
            },
            services.shareLinkTimeoutMs ?? SHARE_LINK_AUTHORIZATION_TIMEOUT_MS,
            `Share link for b2://${item.bucketName}/${item.file.fileName}`,
            {
              signal: cancellation.signal,
              createTimeoutError: (description, timeoutMs) =>
                new B2ShareLinkError(
                  `${description} timed out after ${formatShareLinkTimeoutForUser(timeoutMs)}.`,
                ),
            },
          );
        } finally {
          cancellation.dispose();
        }
      },
    );

    log(
      `Created prefix-scoped share link for b2://${item.bucketName}/${item.file.fileName} expiring at ${expiresAt}.`,
    );
    vscode.window.showInformationMessage(
      `B2: Share link copied. Expires at ${expiresAt}. Future same-prefix objects may also be downloadable until then.`,
    );
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      return;
    }
    showCommandError("B2: Failed to create share link", error);
  }
}

export async function authenticateCommand(services: CommandServices): Promise<void> {
  const { authService, context, treeProvider, setClient } = services;
  const createClient = services.createClient ?? createConfiguredB2Client;
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
    const client = await createClient({ keyId, appKey }, context.extension.packageJSON.version);
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
}

export async function createFolderCommand(
  item: BucketTreeItem | FolderTreeItem | undefined,
  services: CreateFolderCommandServices,
  options: TransferTimeoutOptions = {},
): Promise<void> {
  const { treeProvider, getClient } = services;
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
    validateInput: validateFolderName,
  });
  if (!folderName) {
    return;
  }
  const folderNameValidation = validateFolderName(folderName);
  if (folderNameValidation) {
    vscode.window.showErrorMessage(`B2: ${folderNameValidation}`);
    return;
  }

  const prefix = item instanceof FolderTreeItem ? item.prefix : "";
  const fullPath = `${prefix}${folderName}/.bzEmpty`;

  try {
    await uploadEmptyObject(item.bucket, fullPath, {
      ...options,
      contentType: "application/x-bzEmpty",
    });
    treeProvider.refresh();
    vscode.window.showInformationMessage(`B2: Folder "${folderName}" created.`);
  } catch (error) {
    showCommandError("B2: Failed to create folder", error);
  }
}

async function warnUnknownPublicBucketState(
  services: BucketCommandServices,
  action: PublicBucketVisibilityAction,
  bucketName: string,
  targetType: PublicPrivateBucketType,
  error: unknown,
): Promise<void> {
  services.treeProvider.refresh();
  logError(
    `B2: Unconfirmed public bucket state after ${action} of "${bucketName}" to ${targetType}; bucket may be public and a tree refresh was requested`,
    error,
  );
  await vscode.window.showWarningMessage(
    buildPublicBucketUnknownStateWarningMessage(action, bucketName, targetType),
    { modal: true },
  );
}

export async function createBucketCommand(services: CreateBucketCommandServices): Promise<void> {
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
    validateInput: validateBucketName,
  });
  if (!bucketName) {
    return;
  }
  // Defensive re-check: tests and extension-host edge cases can bypass
  // validateInput by returning undefined or a stale value.
  const bucketNameValidation = validateBucketName(bucketName);
  if (bucketNameValidation) {
    vscode.window.showErrorMessage(`B2: ${bucketNameValidation}`);
    return;
  }

  const visibility = await vscode.window.showQuickPick(
    [
      {
        label: bucketTypeLabel("allPrivate"),
        description: "Files require authorization to access",
        value: "allPrivate" as const,
      },
      {
        label: bucketTypeLabel("allPublic"),
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
      () => {
        const create = (signal: AbortSignal) =>
          client.createBucket(
            withAbortSignal({ bucketName, bucketType: visibility.value }, signal),
          );
        return withBucketMutationTimeout(
          `Creating ${visibility.value === "allPublic" ? "public" : "private"} B2 bucket "${bucketName}"`,
          services.bucketMutationTimeoutMs ?? BUCKET_MUTATION_TIMEOUT_MS,
          services.bucketMutationPostTimeoutSettleMs ?? BUCKET_MUTATION_POST_TIMEOUT_SETTLE_MS,
          create,
        );
      },
    );
    treeProvider.refresh();
    log(`Bucket "${bucket.name}" created with type ${visibility.value}.`);
    vscode.window.showInformationMessage(`B2: Bucket "${bucket.name}" created.`);
  } catch (error) {
    if (visibility.value === "allPublic" && isPostRequestB2MutationStateAmbiguous(error)) {
      await warnUnknownPublicBucketState(services, "create", bucketName, visibility.value, error);
      showCommandError("B2: Could not confirm public bucket creation", error);
      return;
    }
    if (isPostRequestB2MutationStateAmbiguous(error)) {
      treeProvider.refresh();
    }
    showCommandError("B2: Failed to create bucket", error);
  }
}

export async function changeBucketVisibilityCommand(
  services: BucketCommandServices,
  item?: BucketVisibilityItem,
): Promise<void> {
  const { treeProvider, isAuthenticated } = services;
  if (!isAuthenticated()) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return;
  }
  if (!item) {
    vscode.window.showErrorMessage("B2: Select a bucket first.");
    return;
  }

  // The tree item is the state the user saw and confirmed. Its revision is sent
  // with the update so an out-of-band bucket change fails instead of being overwritten.
  const currentType = item.bucketType;
  if (!isPublicPrivateBucketType(currentType)) {
    vscode.window.showErrorMessage(
      `B2: Bucket type "${currentType}" cannot be changed with the public/private visibility command.`,
    );
    return;
  }
  const newType = currentType === "allPublic" ? "allPrivate" : "allPublic";
  const newLabel = bucketTypeLabel(newType);
  const currentLabel = bucketTypeLabel(currentType);
  const publicStateCouldRemainUnknown = currentType === "allPublic" || newType === "allPublic";
  const revision = item.bucket.info.revision;
  if (typeof revision !== "number") {
    treeProvider.refresh();
    vscode.window.showErrorMessage(
      "B2: Bucket metadata is missing a revision. Refresh the bucket tree and retry.",
    );
    return;
  }

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
      () => {
        const update = (signal: AbortSignal) =>
          item.bucket.update(
            withAbortSignal({ bucketType: newType, ifRevisionIs: revision }, signal),
          );
        return withBucketMutationTimeout(
          `Changing B2 bucket "${item.bucketName}" to ${newType === "allPublic" ? "public" : "private"}`,
          services.bucketMutationTimeoutMs ?? BUCKET_MUTATION_TIMEOUT_MS,
          services.bucketMutationPostTimeoutSettleMs ?? BUCKET_MUTATION_POST_TIMEOUT_SETTLE_MS,
          update,
        );
      },
    );
    treeProvider.refresh();
    log(`Bucket "${item.bucketName}" changed to ${newType}.`);
    vscode.window.showInformationMessage(`B2: "${item.bucketName}" is now ${newLabel}.`);
  } catch (error) {
    if (publicStateCouldRemainUnknown && isPostRequestB2MutationStateAmbiguous(error)) {
      await warnUnknownPublicBucketState(services, "change", item.bucketName, newType, error);
      showCommandError("B2: Could not confirm public bucket visibility change", error);
      return;
    }
    if (isBucketRevisionConflict(error) || isPostRequestB2MutationStateAmbiguous(error)) {
      treeProvider.refresh();
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
    vscode.commands.registerCommand("b2.authenticate", () => authenticateCommand(services)),
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
      async (item?: BucketTreeItem | FolderTreeItem) =>
        createFolderCommand(item, { treeProvider, getClient }),
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
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Renaming to "${newName}"...` },
          () => renameFileVersion(item.bucket, oldPath, item.file.fileId, newPath),
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

  // ── Copy Share Link ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.copyShareLink", (item?: FileTreeItem) =>
      copyShareLinkCommand(item, { getClient }),
    ),
  );

  // ── Open File ───────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("b2.openFile", (item: FileTreeItem) =>
      openFileCommand(item, { tempFileManager, getClient }),
    ),
  );
}
