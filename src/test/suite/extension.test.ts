/**
 * Smoke test for the B2 VS Code extension.
 *
 * @module test/suite/extension.test
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { B2Client } from "@backblaze-labs/b2-sdk";
import { createAuthenticatedClientSetter } from "../../extension";
import { downloadFileTool } from "../../tools/definitions/downloadFile";
import { presignUrlTool } from "../../tools/definitions/presignUrl";
import { uploadFileTool } from "../../tools/definitions/uploadFile";
import { MAX_PRESIGN_URL_EXPIRES_IN_SECONDS } from "../../tools/presignUrlLimits";

interface MenuContribution {
  command: string;
  when?: string;
}

interface LanguageModelToolContribution {
  name: string;
  modelDescription: string;
  inputSchema: {
    properties: Record<string, unknown>;
  };
}

suite("B2 Extension Test Suite", () => {
  test("Extension activates", async () => {
    const extension = vscode.extensions.getExtension("backblaze.b2-vscode");
    assert.ok(extension, "Backblaze B2 extension should be discoverable by ID");

    await extension.activate();

    assert.strictEqual(extension.isActive, true);
  });

  test("VS Code API is accessible", () => {
    assert.ok(vscode.window);
    assert.ok(vscode.commands);
    assert.ok(vscode.workspace);
  });

  test("Extension commands are registered", async () => {
    await vscode.extensions.getExtension("backblaze.b2-vscode")?.activate();

    const commands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      "b2.authenticate",
      "b2.logout",
      "b2.refresh",
      "b2.loadMore",
      "b2.copyPath",
      "b2.copyFileId",
      "b2.openFile",
      "b2.createBucket",
      "b2.changeBucketVisibility",
      "b2.createFolder",
      "b2.deleteBucket",
      "b2.deleteFolder",
      "b2.deleteFile",
      "b2.renameFile",
    ];

    for (const command of expectedCommands) {
      assert.ok(commands.includes(command), `${command} should be registered`);
    }
  });

  test("Copy path menus are scoped to pathable tree items", async () => {
    const extension = vscode.extensions.getExtension("backblaze.b2-vscode");
    assert.ok(extension, "Backblaze B2 extension should be discoverable by ID");

    const viewItemMenus = extension.packageJSON.contributes.menus[
      "view/item/context"
    ] as MenuContribution[];
    const copyPathMenus = viewItemMenus.filter((entry) => entry.command === "b2.copyPath");

    assert.strictEqual(copyPathMenus.length, 2);
    for (const entry of copyPathMenus) {
      assert.strictEqual(entry.when, "view == b2Buckets && viewItem =~ /^(bucket|folder|file)$/");
    }
  });

  test("listFiles package contribution declares an integer limit schema", () => {
    const extension = vscode.extensions.getExtension("backblaze.b2-vscode");
    assert.ok(extension, "Backblaze B2 extension should be discoverable by ID");

    const tools = extension.packageJSON.contributes
      .languageModelTools as LanguageModelToolContribution[];
    const listFiles = tools.find((tool) => tool.name === "b2_listFiles");
    assert.ok(listFiles, "b2_listFiles contribution should exist");

    const limit = listFiles.inputSchema.properties.limit as Record<string, unknown>;
    assert.strictEqual(limit.type, "integer");
    assert.strictEqual(limit.minimum, 1);
    assert.strictEqual(limit.maximum, 1000);
  });

  test("package LM tool schemas match source definitions", () => {
    const extension = vscode.extensions.getExtension("backblaze.b2-vscode");
    assert.ok(extension, "Backblaze B2 extension should be discoverable by ID");

    const tools = extension.packageJSON.contributes
      .languageModelTools as LanguageModelToolContribution[];
    const uploadFile = tools.find((tool) => tool.name === uploadFileTool.name);
    const downloadFile = tools.find((tool) => tool.name === downloadFileTool.name);
    const presignUrl = tools.find((tool) => tool.name === presignUrlTool.name);

    assert.ok(uploadFile, "b2_uploadFile contribution should exist");
    assert.ok(downloadFile, "b2_downloadFile contribution should exist");
    assert.ok(presignUrl, "b2_presignUrl contribution should exist");
    assert.deepStrictEqual(uploadFile.inputSchema, uploadFileTool.parameters);
    assert.deepStrictEqual(downloadFile.inputSchema, downloadFileTool.parameters);
    assert.strictEqual(presignUrl.modelDescription, presignUrlTool.description);
    assert.deepStrictEqual(
      presignUrl.inputSchema.properties.path,
      presignUrlTool.parameters.properties.path,
    );

    const expiresIn = presignUrl.inputSchema.properties.expiresIn as Record<string, unknown>;
    assert.strictEqual(expiresIn.type, "integer");
    assert.strictEqual(expiresIn.minimum, 1);
    assert.strictEqual(expiresIn.maximum, MAX_PRESIGN_URL_EXPIRES_IN_SECONDS);
    assert.deepStrictEqual(expiresIn, presignUrlTool.parameters.properties.expiresIn);
  });

  test("authenticated client setter schedules stale unfinished-upload cleanup", () => {
    const client = new B2Client({ applicationKeyId: "key-id", applicationKey: "app-key" });
    const scheduledClients: B2Client[] = [];
    const assignedClients: Array<B2Client | null> = [];
    const setClient = createAuthenticatedClientSetter(
      (scheduledClient) => {
        scheduledClients.push(scheduledClient);
      },
      (assignedClient) => {
        assignedClients.push(assignedClient);
      },
    );

    setClient(client);
    setClient(null);

    assert.deepStrictEqual(scheduledClients, [client]);
    assert.deepStrictEqual(assignedClients, [client, null]);
  });

});
