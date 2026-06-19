#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-audit-fixture-"));

const packageJson = {
  name: "b2-vscode-audit-fixture",
  version: "1.0.0",
  private: true,
  dependencies: {
    lodash: "4.17.20",
  },
};

const packageLock = {
  name: "b2-vscode-audit-fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "b2-vscode-audit-fixture",
      version: "1.0.0",
      dependencies: {
        lodash: "4.17.20",
      },
    },
    "node_modules/lodash": {
      version: "4.17.20",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
      integrity:
        "sha512-PlhdFcillOINfeV7Ni6oF1TAEayyZBoZ8bcshTHqOYJYlrqzRK5hagpagky5o4HfCzzd1TRkXPMFq6cKk9rGmA==",
      license: "MIT",
    },
  },
};

try {
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(tempRoot, "package-lock.json"),
    `${JSON.stringify(packageLock, null, 2)}\n`,
  );

  const result = spawnSync(
    "npx",
    [
      "--yes",
      "audit-ci@7.1.0",
      "--config",
      path.join(repoRoot, "audit-ci.jsonc"),
      "--directory",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    },
  );

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    throw new Error("audit-ci passed against a known-vulnerable lodash fixture.");
  }
  if (!/lodash|GHSA/i.test(output)) {
    throw new Error(`audit-ci failed for an unexpected reason:\n${output}`);
  }

  console.log("Audit gate fixture failed closed as expected.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
