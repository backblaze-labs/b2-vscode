/**
 * Commands for managing B2 application keys.
 *
 * @module commands/applicationKeys
 */

import * as vscode from "vscode";
import {
  Capability,
  bucketId as toBucketId,
  type ApplicationKey,
  type B2Client,
  type Bucket,
  type BucketId,
  type Capability as B2Capability,
  type FullApplicationKey,
} from "@backblaze-labs/b2-sdk";
import { formatB2UserMessage } from "../errors";
import { logError } from "../logger";
import { ApplicationKeyTreeItem } from "../models/applicationKeyTreeItem";

const COPY_SECRET_LABEL = "Copy Secret";
const DELETE_KEY_LABEL = "Delete";

type CreateKeyOptions = Parameters<B2Client["createKey"]>[0];
type CreateKeyResult = ReturnType<B2Client["createKey"]>;
type DeleteKeyResult = ReturnType<B2Client["deleteKey"]>;
type ListBucketsResult = ReturnType<B2Client["listBuckets"]>;

export interface ApplicationKeysRefreshProvider {
  refresh(): void;
}

export interface ApplicationKeyManagementClient {
  createKey(options: CreateKeyOptions): CreateKeyResult;
  deleteKey(applicationKeyId: ApplicationKey["applicationKeyId"]): DeleteKeyResult;
  listBuckets(): ListBucketsResult;
}

export interface ApplicationKeyCommandServices {
  getClient: () => ApplicationKeyManagementClient | null;
  applicationKeysProvider?: ApplicationKeysRefreshProvider;
}

interface CapabilityQuickPickItem extends vscode.QuickPickItem {
  readonly capability: B2Capability;
}

interface BucketScopeQuickPickItem extends vscode.QuickPickItem {
  readonly bucketId?: BucketId;
  readonly bucketName?: string;
  readonly enterBucketId?: true;
}

interface BucketScopeSelection {
  readonly bucketId?: BucketId;
  readonly label: string;
}

interface ExpiryQuickPickItem extends vscode.QuickPickItem {
  readonly seconds?: number;
  readonly custom?: true;
}

interface ExpirySelection {
  readonly seconds?: number;
}

const CAPABILITY_ITEMS: readonly CapabilityQuickPickItem[] = (
  Object.values(Capability) as B2Capability[]
).map((capability) => ({
  label: capability,
  description: capabilityDescription(capability),
  capability,
}));

const EXPIRY_OPTIONS: readonly ExpiryQuickPickItem[] = [
  {
    label: "Never expires",
    description: "No time limit",
  },
  {
    label: "1 hour",
    description: "3,600 seconds",
    seconds: 60 * 60,
  },
  {
    label: "1 day",
    description: "86,400 seconds",
    seconds: 24 * 60 * 60,
  },
  {
    label: "7 days",
    description: "604,800 seconds",
    seconds: 7 * 24 * 60 * 60,
  },
  {
    label: "30 days",
    description: "2,592,000 seconds",
    seconds: 30 * 24 * 60 * 60,
  },
  {
    label: "Custom seconds...",
    description: "Enter a positive duration in seconds",
    custom: true,
  },
];

function capabilityDescription(capability: B2Capability): string {
  switch (capability) {
    case Capability.ListKeys:
      return "List application keys";
    case Capability.WriteKeys:
      return "Create application keys";
    case Capability.DeleteKeys:
      return "Delete application keys";
    case Capability.ListBuckets:
      return "List buckets";
    case Capability.ListAllBucketNames:
      return "List bucket names";
    case Capability.ReadBuckets:
      return "Read bucket settings";
    case Capability.WriteBuckets:
      return "Create and update buckets";
    case Capability.DeleteBuckets:
      return "Delete buckets";
    case Capability.ReadBucketRetentions:
      return "Read bucket retention settings";
    case Capability.WriteBucketRetentions:
      return "Write bucket retention settings";
    case Capability.ReadBucketEncryption:
      return "Read bucket encryption settings";
    case Capability.WriteBucketEncryption:
      return "Write bucket encryption settings";
    case Capability.ReadBucketReplications:
      return "Read bucket replication settings";
    case Capability.WriteBucketReplications:
      return "Write bucket replication settings";
    case Capability.ReadBucketNotifications:
      return "Read bucket notification rules";
    case Capability.WriteBucketNotifications:
      return "Write bucket notification rules";
    case Capability.ListFiles:
      return "List file names and versions";
    case Capability.ReadFiles:
      return "Download files";
    case Capability.ShareFiles:
      return "Create download authorizations";
    case Capability.WriteFiles:
      return "Upload files";
    case Capability.DeleteFiles:
      return "Delete file versions";
    case Capability.ReadFileLegalHolds:
      return "Read file legal holds";
    case Capability.WriteFileLegalHolds:
      return "Write file legal holds";
    case Capability.ReadFileRetentions:
      return "Read file retention settings";
    case Capability.WriteFileRetentions:
      return "Write file retention settings";
    case Capability.BypassGovernance:
      return "Bypass governance retention";
  }
}

function validateApplicationKeyName(keyName: string): string | undefined {
  const trimmed = keyName.trim();
  if (!trimmed) {
    return "Application key name is required";
  }
  if (/[\0-\x1f\x7f]/u.test(keyName)) {
    return "Application key name cannot contain control characters";
  }
  return undefined;
}

function validateNamePrefix(namePrefix: string): string | undefined {
  if (/[\0-\x1f\x7f]/u.test(namePrefix)) {
    return "Name prefix cannot contain control characters";
  }
  return undefined;
}

function validateBucketIdInput(value: string): string | undefined {
  if (!value.trim()) {
    return "Bucket ID is required";
  }
  if (/[\s\0-\x1f\x7f]/u.test(value)) {
    return "Bucket ID cannot contain whitespace or control characters";
  }
  return undefined;
}

function validateDurationInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Duration is required";
  }
  if (!/^\d+$/u.test(trimmed)) {
    return "Duration must be a positive whole number of seconds";
  }
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return "Duration must be a positive whole number of seconds";
  }
  return undefined;
}

function showApplicationKeyCommandError(prefix: string, error: unknown): void {
  logError(prefix, error);
  vscode.window.showErrorMessage(`${prefix}. ${formatB2UserMessage(error)}`);
}

async function pickCapabilities(): Promise<B2Capability[] | undefined> {
  const selected = await vscode.window.showQuickPick(CAPABILITY_ITEMS, {
    title: "Application Key Capabilities",
    placeHolder: "Select one or more capabilities",
    canPickMany: true,
    ignoreFocusOut: true,
  });

  if (selected === undefined) {
    return undefined;
  }
  if (selected.length === 0) {
    vscode.window.showErrorMessage("B2: Select at least one application key capability.");
    return undefined;
  }

  return selected.map((item) => item.capability);
}

async function loadBucketScopeItems(
  client: ApplicationKeyManagementClient,
): Promise<BucketScopeQuickPickItem[]> {
  const items: BucketScopeQuickPickItem[] = [
    {
      label: "All buckets",
      description: "No bucket restriction",
    },
  ];

  try {
    const buckets = await client.listBuckets();
    items.push(
      ...buckets.map((bucket: Bucket) => ({
        label: bucket.name,
        description: bucket.id,
        bucketId: bucket.id,
        bucketName: bucket.name,
      })),
    );
  } catch (error) {
    logError("B2: Could not list buckets while preparing application key scope choices", error);
  }

  items.push({
    label: "Enter bucket ID...",
    description: "Restrict to a bucket by ID",
    enterBucketId: true,
  });

  return items;
}

async function pickBucketScope(
  client: ApplicationKeyManagementClient,
): Promise<BucketScopeSelection | undefined> {
  const selected = await vscode.window.showQuickPick(loadBucketScopeItems(client), {
    title: "Application Key Bucket Scope",
    placeHolder: "Select a bucket scope",
    ignoreFocusOut: true,
  });

  if (!selected) {
    return undefined;
  }

  if (selected.enterBucketId) {
    const bucketIdInput = await vscode.window.showInputBox({
      title: "Application Key Bucket Scope",
      prompt: "Enter the B2 bucket ID to restrict this key to",
      placeHolder: "bucket-id",
      ignoreFocusOut: true,
      validateInput: validateBucketIdInput,
    });
    if (bucketIdInput === undefined) {
      return undefined;
    }
    const bucketIdValidation = validateBucketIdInput(bucketIdInput);
    if (bucketIdValidation) {
      vscode.window.showErrorMessage(`B2: ${bucketIdValidation}`);
      return undefined;
    }
    const trimmedBucketId = bucketIdInput.trim();
    return { bucketId: toBucketId(trimmedBucketId), label: `bucket ${trimmedBucketId}` };
  }

  if (selected.bucketId) {
    return {
      bucketId: selected.bucketId,
      label: selected.bucketName ?? `bucket ${selected.bucketId}`,
    };
  }

  return { label: "all buckets" };
}

async function pickNamePrefix(scope: BucketScopeSelection): Promise<string | undefined> {
  if (!scope.bucketId) {
    return "";
  }

  const namePrefix = await vscode.window.showInputBox({
    title: "Application Key Name Prefix",
    prompt: `Optionally restrict this key to a file name prefix in ${scope.label}`,
    placeHolder: "uploads/",
    ignoreFocusOut: true,
    validateInput: validateNamePrefix,
  });

  if (namePrefix === undefined) {
    return undefined;
  }

  const prefixValidation = validateNamePrefix(namePrefix);
  if (prefixValidation) {
    vscode.window.showErrorMessage(`B2: ${prefixValidation}`);
    return undefined;
  }

  return namePrefix.trim();
}

async function pickExpiry(): Promise<ExpirySelection | undefined> {
  const selected = await vscode.window.showQuickPick(EXPIRY_OPTIONS, {
    title: "Application Key Expiry",
    placeHolder: "Select how long the key should remain valid",
    ignoreFocusOut: true,
  });

  if (!selected) {
    return undefined;
  }

  if (!selected.custom) {
    return selected.seconds === undefined ? {} : { seconds: selected.seconds };
  }

  const duration = await vscode.window.showInputBox({
    title: "Custom Application Key Expiry",
    prompt: "Enter the key validity duration in seconds",
    placeHolder: "86400",
    ignoreFocusOut: true,
    validateInput: validateDurationInput,
  });

  if (duration === undefined) {
    return undefined;
  }

  const durationValidation = validateDurationInput(duration);
  if (durationValidation) {
    vscode.window.showErrorMessage(`B2: ${durationValidation}`);
    return undefined;
  }

  return { seconds: Number(duration.trim()) };
}

async function showCreatedKeySecret(createdKey: FullApplicationKey): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `B2 application key "${createdKey.keyName}" was created.\n\n` +
      `Application key ID: ${createdKey.applicationKeyId}\n\n` +
      `Secret: ${createdKey.applicationKey}\n\n` +
      "Copy this secret now. It is shown only once and cannot be retrieved later.",
    { modal: true },
    COPY_SECRET_LABEL,
    "Close",
  );

  if (choice === COPY_SECRET_LABEL) {
    await vscode.env.clipboard.writeText(createdKey.applicationKey);
    vscode.window.showInformationMessage("B2: Application key secret copied to clipboard.");
  }
}

export async function createKeyCommand(services: ApplicationKeyCommandServices): Promise<void> {
  const client = services.getClient();
  if (!client) {
    vscode.window.showErrorMessage("B2: Not authenticated.");
    return;
  }

  const keyNameInput = await vscode.window.showInputBox({
    title: "Create B2 Application Key",
    prompt: "Enter a unique name for the new application key",
    placeHolder: "my-scoped-key",
    ignoreFocusOut: true,
    validateInput: validateApplicationKeyName,
  });
  if (keyNameInput === undefined) {
    return;
  }

  const keyNameValidation = validateApplicationKeyName(keyNameInput);
  if (keyNameValidation) {
    vscode.window.showErrorMessage(`B2: ${keyNameValidation}`);
    return;
  }

  const capabilities = await pickCapabilities();
  if (!capabilities) {
    return;
  }

  const scope = await pickBucketScope(client);
  if (!scope) {
    return;
  }

  const namePrefix = await pickNamePrefix(scope);
  if (namePrefix === undefined) {
    return;
  }

  const expiry = await pickExpiry();
  if (!expiry) {
    return;
  }

  const options: CreateKeyOptions = {
    capabilities,
    keyName: keyNameInput.trim(),
    ...(scope.bucketId !== undefined ? { bucketId: scope.bucketId } : {}),
    ...(namePrefix ? { namePrefix } : {}),
    ...(expiry.seconds !== undefined ? { validDurationInSeconds: expiry.seconds } : {}),
  };

  try {
    const createdKey = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating application key "${options.keyName}"...`,
        cancellable: false,
      },
      () => client.createKey(options),
    );
    services.applicationKeysProvider?.refresh();
    await showCreatedKeySecret(createdKey);
  } catch (error) {
    showApplicationKeyCommandError("B2: Failed to create application key", error);
  }
}

export async function deleteKeyCommand(
  item: ApplicationKeyTreeItem | undefined,
  services: ApplicationKeyCommandServices,
): Promise<void> {
  const client = services.getClient();
  if (!client || !item) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Delete application key "${item.keyName}"? This cannot be undone.`,
    { modal: true },
    DELETE_KEY_LABEL,
  );
  if (answer !== DELETE_KEY_LABEL) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting application key "${item.keyName}"...`,
        cancellable: false,
      },
      () => client.deleteKey(item.key.applicationKeyId),
    );
    services.applicationKeysProvider?.refresh();
    vscode.window.showInformationMessage(`B2: Application key "${item.keyName}" deleted.`);
  } catch (error) {
    showApplicationKeyCommandError("B2: Failed to delete application key", error);
  }
}
