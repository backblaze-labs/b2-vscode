/**
 * Tests for shared VS Code window stubs.
 *
 * @module test/suite/windowStubs
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { withWindowUiStubs } from "./windowStubs";

suite("VS Code window stubs", () => {
  test("selects quick pick items from thenables by label", async () => {
    let selected: unknown;

    const ui = await withWindowUiStubs({ quickPickLabels: ["Async Pick"] }, async () => {
      selected = await vscode.window.showQuickPick(
        Promise.resolve([{ label: "Async Pick", value: 1 }]),
        { title: "Async Quick Pick" },
      );
    });

    assert.deepStrictEqual(ui.quickPicks[0]?.labels, ["Async Pick"]);
    assert.strictEqual((selected as { value?: number } | undefined)?.value, 1);
  });

  test("records warning message item objects as items", async () => {
    const ui = await withWindowUiStubs({}, async () => {
      await vscode.window.showWarningMessage(
        "Retry upload?",
        { title: "Retry" },
        { title: "Cancel", isCloseAffordance: true },
      );
    });

    assert.strictEqual(ui.warnings[0]?.options, undefined);
    assert.deepStrictEqual(ui.warnings[0]?.items, ["Retry", "Cancel"]);
  });

  test("records warning options separately from object items", async () => {
    const ui = await withWindowUiStubs({}, async () => {
      await vscode.window.showWarningMessage(
        "Retry upload?",
        { modal: true },
        { title: "Retry" },
        { title: "Cancel" },
      );
    });

    assert.deepStrictEqual(ui.warnings[0]?.options, { modal: true });
    assert.deepStrictEqual(ui.warnings[0]?.items, ["Retry", "Cancel"]);
  });
});
