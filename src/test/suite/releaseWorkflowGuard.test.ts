/**
 * Tests for release workflow trust-boundary guards.
 *
 * @module test/suite/releaseWorkflowGuard
 */

import * as assert from "assert";
import * as path from "path";

interface ReleaseWorkflowGuard {
  assertMarketplaceSecretStepsUseIsolatedPublisher(workflow: unknown): void;
  assertMarketplaceSecretOnlyInPublish(workflow: unknown): void;
  assertPublishUsesIsolatedPublisher(workflow: unknown): void;
}

function loadReleaseWorkflowGuard(): ReleaseWorkflowGuard {
  return require(path.join(process.cwd(), "scripts/assert-release-workflow.js"));
}

suite("Release workflow guard assertions", () => {
  test("validates an isolated publisher from a synthetic workflow", () => {
    const guard = loadReleaseWorkflowGuard();

    guard.assertPublishUsesIsolatedPublisher({
      jobs: {
        publish: {
          steps: [
            {
              name: "Install isolated Marketplace publisher",
              id: "publisher",
              run: [
                'PUBLISHER_DIR="$RUNNER_TEMP/vsce-publisher"',
                'cp .github/marketplace-publisher/package.json "$PUBLISHER_DIR/package.json"',
                'cp .github/marketplace-publisher/package-lock.json "$PUBLISHER_DIR/package-lock.json"',
                "npm ci --ignore-scripts --no-audit --no-fund --omit=dev",
              ].join("\n"),
            },
            {
              name: "Install dependencies",
              run: "npm ci --ignore-scripts",
            },
            {
              name: "Verify Marketplace publisher token",
              run: 'env -u NODE_OPTIONS -u NODE_PATH "$VSCE_BIN" verify-pat backblaze',
            },
            {
              name: "Publish to VS Code Marketplace",
              run: 'env -u NODE_OPTIONS -u NODE_PATH "$VSCE_BIN" publish --skip-duplicate --packagePath extension.vsix',
            },
          ],
        },
      },
    });
  });

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

  test("rejects repo dependency execution with marketplace token", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertMarketplaceSecretStepsUseIsolatedPublisher({
          jobs: {
            publish: {
              steps: [
                {
                  name: "Publish to VS Code Marketplace",
                  env: {
                    VSCE_PAT: "${{ secrets.VSCE_KEY }}",
                    VSCE_BIN: "${{ steps.publisher.outputs.bin }}",
                  },
                  run: [
                    'cd "$RUNNER_TEMP"',
                    'env -u NODE_OPTIONS -u NODE_PATH "$VSCE_BIN" publish --packagePath extension.vsix',
                    "npm exec --no-install -- vsce verify-pat backblaze",
                  ].join("\n"),
                },
              ],
            },
          },
        }),
      /repo-controlled dependencies/i,
    );
  });
});
