/**
 * Tests for release workflow trust-boundary guards.
 *
 * @module test/suite/releaseWorkflowGuard
 */

import * as assert from "assert";
import * as path from "path";

interface ReleaseWorkflowGuard {
  assertDependencyVsixDiffGate(workflow: unknown): void;
  assertMarketplaceSecretStepsUseIsolatedPublisher(workflow: unknown): void;
  assertMarketplaceSecretOnlyInPublish(workflow: unknown): void;
  assertMarketplacePublisherDependencyGate(workflow: unknown): void;
  assertMarketplacePublisherLockfile(packageJson: unknown, packageLock: unknown): void;
  assertPublishUsesIsolatedPublisher(workflow: unknown): void;
  assertPublishPreflightIgnoresLifecycleScripts(workflow: unknown): void;
  assertReleaseInstallsIgnoreLifecycleScripts(workflow: unknown): void;
  assertWorkflowInstallsIgnoreLifecycleScripts(workflow: unknown, workflowName?: string): void;
  assertGithubWorkflowInstallsIgnoreLifecycleScripts(workflows: unknown): void;
  assertCodeQualityRunsReleaseGuard(workflow: unknown): void;
}

function loadReleaseWorkflowGuard(): ReleaseWorkflowGuard {
  const guardPath = path.join(process.cwd(), "scripts/assert-release-workflow.js");
  delete require.cache[require.resolve(guardPath)];
  return require(guardPath);
}

function validPublishSteps(extraStepsAfterPublisherInstall: unknown[] = []): unknown[] {
  return [
    {
      name: "Install dependencies without lifecycle scripts",
      run: "npm ci --ignore-scripts",
    },
    {
      name: "Resolve and verify VSIX artifact",
      run: "node scripts/resolve-vsix-artifact.js ./vsix-artifacts --verify-checksum",
    },
    {
      name: "Verify Marketplace publisher dependency tree",
      env: {
        EXPECTED_PUBLISHER_PACKAGE_SHA256: "${{ vars.MARKETPLACE_PUBLISHER_PACKAGE_SHA256 }}",
        EXPECTED_PUBLISHER_LOCK_SHA256: "${{ vars.MARKETPLACE_PUBLISHER_LOCK_SHA256 }}",
      },
      run: [
        'test -n "$EXPECTED_PUBLISHER_PACKAGE_SHA256"',
        'test -n "$EXPECTED_PUBLISHER_LOCK_SHA256"',
        'printf \'%s  %s\\n\' "$EXPECTED_PUBLISHER_PACKAGE_SHA256" ".github/marketplace-publisher/package.json" | sha256sum --check --strict',
        'printf \'%s  %s\\n\' "$EXPECTED_PUBLISHER_LOCK_SHA256" ".github/marketplace-publisher/package-lock.json" | sha256sum --check --strict',
      ].join("\n"),
    },
    {
      name: "Install isolated Marketplace publisher",
      id: "publisher",
      run: [
        'PUBLISHER_DIR="$RUNNER_TEMP/vsce-publisher"',
        'rm -rf "$PUBLISHER_DIR"',
        'mkdir -p "$PUBLISHER_DIR"',
        'cp .github/marketplace-publisher/package.json "$PUBLISHER_DIR/package.json"',
        'cp .github/marketplace-publisher/package-lock.json "$PUBLISHER_DIR/package-lock.json"',
        'cd "$PUBLISHER_DIR"',
        "npm ci --ignore-scripts --no-audit --no-fund --omit=dev",
        'VSCE_BIN="$PUBLISHER_DIR/node_modules/.bin/vsce"',
        'test -x "$VSCE_BIN"',
        'echo "bin=$VSCE_BIN" >> "$GITHUB_OUTPUT"',
      ].join("\n"),
    },
    ...extraStepsAfterPublisherInstall,
    {
      name: "Verify Marketplace publisher token",
      run: 'env -u NODE_OPTIONS -u NODE_PATH "$VSCE_BIN" verify-pat backblaze',
    },
    {
      name: "Publish to VS Code Marketplace",
      run: 'env -u NODE_OPTIONS -u NODE_PATH "$VSCE_BIN" publish --skip-duplicate --packagePath extension.vsix',
    },
  ];
}

function validPublishWorkflow(extraStepsAfterPublisherInstall: unknown[] = []): unknown {
  return {
    jobs: {
      publish: {
        steps: validPublishSteps(extraStepsAfterPublisherInstall),
      },
    },
  };
}

suite("Release workflow guard assertions", () => {
  test("does not perform repository file I/O at import time", () => {
    const fs = require("fs") as typeof import("fs");
    const originalReadFileSync = fs.readFileSync;
    let readCount = 0;

    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const filePath = String(args[0]);
      if (
        filePath.includes(`${path.sep}.github${path.sep}`) ||
        filePath.includes(`${path.sep}marketplace-publisher${path.sep}`)
      ) {
        readCount += 1;
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;

    try {
      const guard = loadReleaseWorkflowGuard();

      assert.strictEqual(typeof guard.assertPublishUsesIsolatedPublisher, "function");
      assert.strictEqual(readCount, 0);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });

  test("validates an isolated publisher from a synthetic workflow", () => {
    const guard = loadReleaseWorkflowGuard();

    const workflow = validPublishWorkflow();

    guard.assertPublishUsesIsolatedPublisher(workflow);
    guard.assertMarketplacePublisherDependencyGate(workflow);
  });

  test("rejects isolated publisher output outside publisher directory", () => {
    const guard = loadReleaseWorkflowGuard();
    const workflow = validPublishWorkflow() as {
      jobs: { publish: { steps: { name?: string; run?: string }[] } };
    };
    const publisherStep = workflow.jobs.publish.steps.find(
      (step) => step.name === "Install isolated Marketplace publisher",
    );
    if (!publisherStep?.run) {
      throw new Error("Synthetic workflow is missing the isolated publisher step.");
    }
    publisherStep.run = publisherStep.run.replace(
      'VSCE_BIN="$PUBLISHER_DIR/node_modules/.bin/vsce"',
      'VSCE_BIN="$GITHUB_WORKSPACE/node_modules/.bin/vsce"',
    );

    assert.throws(
      () => guard.assertPublishUsesIsolatedPublisher(workflow),
      /export VSCE_BIN from \$PUBLISHER_DIR/i,
    );
  });

  test("accepts formatted publisher hash variable expressions", () => {
    const guard = loadReleaseWorkflowGuard();
    const workflow = validPublishWorkflow() as {
      jobs: { publish: { steps: { name?: string; env?: Record<string, string> }[] } };
    };
    const gateStep = workflow.jobs.publish.steps.find(
      (step) => step.name === "Verify Marketplace publisher dependency tree",
    );
    if (!gateStep?.env) {
      throw new Error("Synthetic workflow is missing the dependency gate step.");
    }
    const gateEnv = gateStep.env;
    gateEnv.EXPECTED_PUBLISHER_PACKAGE_SHA256 = "${{vars.MARKETPLACE_PUBLISHER_PACKAGE_SHA256}}";
    gateEnv.EXPECTED_PUBLISHER_LOCK_SHA256 = "${{  vars.MARKETPLACE_PUBLISHER_LOCK_SHA256  }}";

    guard.assertMarketplacePublisherDependencyGate(workflow);
  });

  test("accepts formatted publisher binary output expressions", () => {
    const guard = loadReleaseWorkflowGuard();

    guard.assertMarketplaceSecretStepsUseIsolatedPublisher({
      jobs: {
        publish: {
          steps: [
            {
              name: "Publish to VS Code Marketplace",
              env: {
                VSCE_PAT: "${{ secrets.VSCE_KEY }}",
                VSCE_BIN: "${{steps.publisher.outputs.bin}}",
              },
              run: [
                'cd "$RUNNER_TEMP"',
                'env -u NODE_OPTIONS -u NODE_PATH "$VSCE_BIN" publish --packagePath extension.vsix',
              ].join("\n"),
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

  test("rejects repo-controlled commands after isolated publisher install", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertPublishUsesIsolatedPublisher(
          validPublishWorkflow([
            {
              name: "Tamper after publisher install",
              run: 'cp "$GITHUB_WORKSPACE/.ci/payload" "$RUNNER_TEMP/vsce-publisher/node_modules/.bin/vsce"',
            },
          ]),
        ),
      /No step may run/i,
    );
  });

  test("rejects uses steps after isolated publisher install", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertPublishUsesIsolatedPublisher(
          validPublishWorkflow([
            {
              name: "Third-party action after publisher install",
              uses: "actions/cache@v4",
            },
          ]),
        ),
      /No step may run/i,
    );
  });

  test("rejects missing Marketplace publisher dependency hash gate", () => {
    const guard = loadReleaseWorkflowGuard();
    const steps = validPublishSteps().filter(
      (step) => (step as { name?: string }).name !== "Verify Marketplace publisher dependency tree",
    );

    assert.throws(
      () =>
        guard.assertMarketplacePublisherDependencyGate({
          jobs: {
            publish: { steps },
          },
        }),
      /dependency tree/i,
    );
  });

  test("rejects Marketplace publisher lockfile drift", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertMarketplacePublisherLockfile(
          {
            dependencies: { "@vscode/vsce": "3.7.1" },
          },
          {
            packages: {
              "": { dependencies: { "@vscode/vsce": "3.7.1" } },
              "node_modules/@vscode/vsce": {
                version: "3.7.2",
                integrity: "sha512-placeholder",
              },
            },
          },
        ),
      /3\.7\.1/i,
    );
  });

  test("rejects publish preflight lifecycle scripts", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertPublishPreflightIgnoresLifecycleScripts({
          jobs: {
            "publish-preflight": {
              steps: [
                {
                  name: "Install dependencies",
                  run: "npm ci",
                },
              ],
            },
          },
        }),
      /lifecycle scripts/i,
    );
  });

  test("rejects release artifact installs that run lifecycle scripts", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertReleaseInstallsIgnoreLifecycleScripts({
          jobs: {
            build: {
              steps: [
                {
                  name: "Install dependencies",
                  run: "npm ci",
                },
                {
                  name: "Package VSIX",
                  run: "npm run vsix",
                },
              ],
            },
          },
        }),
      /ignore-scripts/i,
    );
  });

  test("rejects any workflow install that runs lifecycle scripts", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertWorkflowInstallsIgnoreLifecycleScripts(
          {
            jobs: {
              test: {
                steps: [
                  {
                    name: "Install dependencies",
                    run: "npm install",
                  },
                ],
              },
            },
          },
          "test.yml",
        ),
      /ignore-scripts/i,
    );
  });

  test("checks every loaded GitHub workflow install", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertGithubWorkflowInstallsIgnoreLifecycleScripts([
          {
            name: "build-extension.yml",
            workflow: {
              jobs: {
                package: {
                  steps: [
                    {
                      name: "Install dependencies",
                      run: "npm ci",
                    },
                  ],
                },
              },
            },
          },
        ]),
      /build-extension\.yml.*ignore-scripts/i,
    );
  });

  test("rejects code-quality workflows that omit the release guard", () => {
    const guard = loadReleaseWorkflowGuard();

    assert.throws(
      () =>
        guard.assertCodeQualityRunsReleaseGuard({
          on: {
            push: {
              paths: ["src/**", ".github/workflows/code-quality.yml"],
            },
            pull_request: {
              paths: ["src/**", ".github/workflows/code-quality.yml"],
            },
          },
          jobs: {
            quality: {
              steps: [
                { run: "npm run format:check" },
                { run: "npm run lint" },
                { run: "npm run type-check" },
              ],
            },
          },
        }),
      /release-workflow/i,
    );
  });

  test("rejects build workflows that omit dependency VSIX diff gate", () => {
    const guard = loadReleaseWorkflowGuard();
    const paths = [
      ".github/vsix-generated-diff-allowlist.json",
      "package-lock.json",
      "package.json",
      "scripts/assert-dependency-vsix-diff.js",
    ];

    assert.throws(
      () =>
        guard.assertDependencyVsixDiffGate({
          on: {
            push: { paths },
            pull_request: { paths },
          },
          jobs: {
            build: {
              steps: [
                {
                  name: "Checkout base source for artifact diff",
                  if: "github.event_name == 'pull_request'",
                  with: {
                    ref: "${{ github.event.pull_request.base.sha }}",
                    path: "base-source",
                  },
                },
                {
                  name: "Record changed files",
                  if: "github.event_name == 'pull_request'",
                  run: 'git diff --name-only "$BASE_SHA" HEAD > "$RUNNER_TEMP/changed-files.txt"',
                },
                {
                  name: "Package VSIX",
                  run: "npm run vsix",
                },
                {
                  name: "Package base VSIX for dependency diff",
                  if: "github.event_name == 'pull_request'",
                  "working-directory": "base-source",
                  run: "npm ci --ignore-scripts\nnpm run vsix",
                },
              ],
            },
          },
        }),
      /generated-code diff/i,
    );
  });
});
