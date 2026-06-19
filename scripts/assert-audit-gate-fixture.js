#!/usr/bin/env node

/**
 * Proves the npm audit gate fails closed for a fixture with known advisories.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { collectAuditFindings, dateOnlyDaysFromNow } = require("./audit-policy");

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    ...options,
  });
  return {
    ...result,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function runGate(args = []) {
  return run("node", [
    path.join(repoRoot, "scripts/run-npm-audit.js"),
    "--directory",
    tempRoot,
    ...args,
  ]);
}

function loadFixtureFindings() {
  const result = run("npm", ["audit", "--json", "--audit-level=moderate"], {
    cwd: tempRoot,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    throw new Error(
      "npm audit fixture did not report known lodash advisories; the advisory service may be unavailable or the fixture may need refresh.",
    );
  }

  let report;
  try {
    report = JSON.parse(result.stdout ?? "");
  } catch (error) {
    throw new Error(
      `npm audit infrastructure error while reading the lodash fixture: ${error.message}\n${result.output}`,
    );
  }

  const findings = collectAuditFindings(report, "moderate");
  if (findings.length === 0) {
    throw new Error(
      `npm audit fixture returned no moderate-or-higher lodash advisories:\n${result.output}`,
    );
  }
  return findings;
}

try {
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(tempRoot, "package-lock.json"),
    `${JSON.stringify(packageLock, null, 2)}\n`,
  );

  const result = runGate();
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    throw new Error(
      "npm audit fixture did not report known lodash advisories; the advisory service may be unavailable or the fixture may need refresh.",
    );
  }
  if (result.status === 2) {
    throw new Error(
      `npm audit infrastructure error while checking the lodash fixture:\n${result.output}`,
    );
  }
  if (!/lodash|GHSA/i.test(result.output)) {
    throw new Error(`npm audit gate failed for an unexpected reason:\n${result.output}`);
  }

  const acceptedPolicyPath = path.join(tempRoot, "accepted-audit-policy.jsonc");
  const acceptedAdvisories = loadFixtureFindings().map((finding) => ({
    id: finding.id,
    package: finding.package,
    owner: "security-team",
    reason: "Fixture proves accepted advisories unblock audited releases.",
    reviewBy: dateOnlyDaysFromNow(7),
    paths: finding.paths,
  }));
  fs.writeFileSync(
    acceptedPolicyPath,
    `${JSON.stringify(
      {
        auditLevel: "moderate",
        includeDev: true,
        acceptedAdvisories,
      },
      null,
      2,
    )}\n`,
  );

  const acceptedResult = runGate(["--policy", acceptedPolicyPath]);
  if (acceptedResult.error) {
    throw acceptedResult.error;
  }
  if (acceptedResult.status !== 0) {
    throw new Error(
      `accepted advisory policy did not unblock the lodash fixture:\n${acceptedResult.output}`,
    );
  }

  console.log("Audit gate fixture failed closed and accepted tracked advisories.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
