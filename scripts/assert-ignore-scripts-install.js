#!/usr/bin/env node

/**
 * Verifies lifecycle-disabled installs do not execute dependency scripts.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { npmCommand } = require("./npm-command");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-ignore-scripts-"));
const fixtureRoot = path.join(tempRoot, "postinstall-fixture");
const markerPath = path.join(tempRoot, "postinstall-ran");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: tempRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    ...options,
  });

  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}:\n${stdout}\n${stderr}`,
    );
  }
}

try {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "postinstall-fixture",
        version: "1.0.0",
        scripts: {
          postinstall: "node postinstall.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "postinstall.js"),
    `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "postinstall ran");\n`,
  );
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "ignore-scripts-root",
        version: "1.0.0",
        private: true,
        dependencies: {
          "postinstall-fixture": "file:./postinstall-fixture",
        },
      },
      null,
      2,
    )}\n`,
  );

  run(npmCommand, ["install", "--package-lock-only", "--ignore-scripts"]);
  run(npmCommand, ["ci", "--ignore-scripts"]);

  if (fs.existsSync(markerPath)) {
    throw new Error("postinstall fixture executed during npm ci --ignore-scripts.");
  }

  console.log("Lifecycle-script-disabled install verified.");
} catch (error) {
  console.error(
    `Lifecycle-script install guardrail failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
