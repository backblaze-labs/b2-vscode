/**
 * Tests for release workflow trust-boundary guards.
 *
 * @module test/suite/releaseWorkflowGuard
 */

import * as assert from "assert";
import * as path from "path";

interface ReleaseWorkflowGuard {
  assertMarketplaceSecretOnlyInPublish(workflow: unknown): void;
}

function loadReleaseWorkflowGuard(): ReleaseWorkflowGuard {
  return require(path.join(process.cwd(), "scripts/assert-release-workflow.js"));
}

suite("Release workflow guard assertions", () => {
  test("rejects bracket-syntax marketplace secrets outside publish", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertMarketplaceSecretOnlyInPublish({
          jobs: {
            quality: {
              steps: [{ run: "echo ${{ secrets['VSCE_KEY'] }}" }],
            },
            publish: {
              steps: [{ run: "echo ${{ secrets.VSCE_KEY }}" }],
            },
          },
        }),
      /quality/i,
    );
  });
});
