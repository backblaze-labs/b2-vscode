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
});
