/**
 * Smoke test for the B2 VS Code extension.
 *
 * @module test/suite/extension.test
 */

import * as assert from "assert";
import * as vscode from "vscode";

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
});
