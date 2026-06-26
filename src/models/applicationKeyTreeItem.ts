/**
 * Tree item representing a B2 application key.
 *
 * @module models/applicationKeyTreeItem
 */

import * as vscode from "vscode";
import type { ApplicationKey } from "@backblaze-labs/b2-sdk";

export function formatApplicationKeyExpiry(expirationTimestamp: number | null): string {
  if (expirationTimestamp === null) {
    return "never expires";
  }

  return `expires ${new Date(expirationTimestamp).toISOString()}`;
}

export function formatApplicationKeyScope(key: ApplicationKey): string {
  const bucketScope = key.bucketId === null ? "all buckets" : `bucket ${key.bucketId}`;
  if (key.namePrefix === null || key.namePrefix === "") {
    return bucketScope;
  }

  return `${bucketScope}, prefix "${key.namePrefix}"`;
}

function formatCapabilitySummary(key: ApplicationKey): string {
  const capabilities = key.capabilities.join(", ");
  return capabilities || "no capabilities";
}

/**
 * A leaf tree item for application key metadata returned by b2_list_keys.
 *
 * The key secret is intentionally absent from this type; B2 only returns it
 * once when a key is created.
 */
export class ApplicationKeyTreeItem extends vscode.TreeItem {
  readonly key: ApplicationKey;
  readonly applicationKeyId: string;
  readonly keyName: string;

  constructor(key: ApplicationKey) {
    super(key.keyName, vscode.TreeItemCollapsibleState.None);

    this.key = key;
    this.applicationKeyId = key.applicationKeyId;
    this.keyName = key.keyName;
    this.contextValue = "applicationKey";
    this.iconPath = new vscode.ThemeIcon("key");

    const scope = formatApplicationKeyScope(key);
    const expiry = formatApplicationKeyExpiry(key.expirationTimestamp);
    const capabilities = formatCapabilitySummary(key);

    this.description = `${capabilities} - ${scope} - ${expiry}`;
    this.tooltip = new vscode.MarkdownString(
      `**${key.keyName}**\n\n` +
        `- ID: \`${key.applicationKeyId}\`\n` +
        `- Capabilities: \`${capabilities}\`\n` +
        `- Scope: ${scope}\n` +
        `- Expiry: ${expiry}`,
    );
  }
}
