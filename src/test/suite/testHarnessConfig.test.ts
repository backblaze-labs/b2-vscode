/**
 * Tests for the VS Code extension test harness configuration.
 *
 * @module test/suite/testHarnessConfig
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

suite("VS Code test harness config", () => {
  test("runs against the pinned supported VS Code version", () => {
    const repoRoot = process.cwd();
    const harness = fs.readFileSync(path.join(repoRoot, ".vscode-test.mjs"), "utf8");
    const sharedConfig = fs.readFileSync(path.join(repoRoot, "test-harness.config.mjs"), "utf8");

    assert.match(sharedConfig, /vscodeTestVersion\s*=\s*"1\.101\.0"/);
    assert.match(harness, /version:\s*vscodeTestVersion/);
    assert.doesNotMatch(harness, /version:\s*"stable"/);
  });
});
