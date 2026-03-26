/**
 * Smoke test for the B2 VS Code extension.
 *
 * @module test/suite/extension.test
 */

import * as assert from "assert";
import * as vscode from "vscode";

suite("B2 Extension Test Suite", () => {
  test("VS Code API is accessible", () => {
    assert.ok(vscode.window);
    assert.ok(vscode.commands);
    assert.ok(vscode.workspace);
  });

  test("Extension commands are registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("b2.authenticate"));
    assert.ok(commands.includes("b2.logout"));
    assert.ok(commands.includes("b2.refresh"));
    assert.ok(commands.includes("b2.copyPath"));
    assert.ok(commands.includes("b2.copyFileId"));
    assert.ok(commands.includes("b2.openFile"));
  });
});
