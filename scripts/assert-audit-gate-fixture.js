#!/usr/bin/env node

/**
 * Proves the npm audit gate fails closed for a fixture with known advisories.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  AUDIT_POLICY_STRICT_JSON_NOTICE,
  collectAuditFindings,
  dateOnlyDaysFromNow,
} = require("./audit-policy");
const { npmCommand, trustedNpmConfigArgs, trustedNpmEnv } = require("./npm-command");

const repoRoot = path.join(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-audit-fixture-"));
const devOnlyTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-audit-dev-fixture-"));

class InfrastructureError extends Error {
  constructor(message) {
    super(message);
    this.name = "InfrastructureError";
  }
}

const packageJson = {
  name: "b2-vscode-audit-fixture",
  version: "1.0.0",
  private: true,
  dependencies: {
    lodash: "4.17.20",
  },
};

const devOnlyPackageJson = {
  name: "b2-vscode-audit-dev-fixture",
  version: "1.0.0",
  private: true,
  devDependencies: {
    lodash: "4.17.20",
  },
};

function packageLock(name, dependencyField) {
  return {
    name,
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name,
        version: "1.0.0",
        [dependencyField]: {
          lodash: "4.17.20",
        },
      },
      "node_modules/lodash": {
        version: "4.17.20",
        resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
        integrity:
          "sha512-PlhdFcillOINfeV7Ni6oF1TAEayyZBoZ8bcshTHqOYJYlrqzRK5hagpagky5o4HfCzzd1TRkXPMFq6cKk9rGmA==",
        license: "MIT",
        ...(dependencyField === "devDependencies" ? { dev: true } : {}),
      },
    },
  };
}

function run(command, args, options = {}) {
  const { env, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: trustedNpmEnv(env),
    ...spawnOptions,
  });
  return {
    ...result,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function runGate(directory = tempRoot, args = [], options = {}) {
  return run(
    "node",
    [path.join(repoRoot, "scripts/run-npm-audit.js"), "--directory", directory, ...args],
    options,
  );
}

function assertInvalidCliArgs(args, expectedMessage) {
  const result = run("node", [path.join(repoRoot, "scripts/run-npm-audit.js"), ...args]);
  if (result.status === 0) {
    throw new Error(`audit gate accepted invalid CLI arguments: ${args.join(" ")}`);
  }
  if (!result.output.includes(expectedMessage)) {
    throw new Error(
      `audit gate rejected invalid CLI arguments with an unexpected message:\n${result.output}`,
    );
  }
}

function loadFixtureFindings() {
  const result = run(
    npmCommand,
    ["audit", "--json", "--audit-level=moderate", ...trustedNpmConfigArgs],
    {
      cwd: tempRoot,
    },
  );
  if (result.error) {
    throw new InfrastructureError(result.error.message);
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
    throw new InfrastructureError(
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
  assertInvalidCliArgs(["--directory"], "--directory requires a path value.");
  assertInvalidCliArgs(["--policy", "--directory"], "--policy requires a path value.");
  assertInvalidCliArgs(["--trusted-base-ref"], "--trusted-base-ref requires a branch name value.");
  assertInvalidCliArgs(["--trusted-policy"], "--trusted-policy requires a path value.");

  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(tempRoot, "package-lock.json"),
    `${JSON.stringify(packageLock(packageJson.name, "dependencies"), null, 2)}\n`,
  );
  fs.writeFileSync(path.join(tempRoot, ".npmrc"), "registry=https://example.invalid/\n");
  const npmrcResult = runGate();
  if (npmrcResult.status === 0 || !npmrcResult.output.includes(".npmrc is not supported")) {
    throw new Error(
      `audit gate must reject project .npmrc before auditing:\n${npmrcResult.output}`,
    );
  }
  fs.rmSync(path.join(tempRoot, ".npmrc"), { force: true });

  const result = runGate();
  if (result.error) {
    throw new InfrastructureError(result.error.message);
  }
  if (result.status === 0) {
    throw new Error(
      "npm audit fixture did not report known lodash advisories; the advisory service may be unavailable or the fixture may need refresh.",
    );
  }
  if (result.status === 2) {
    throw new InfrastructureError(
      `npm audit infrastructure error while checking the lodash fixture:\n${result.output}`,
    );
  }
  if (!/lodash|GHSA/i.test(result.output)) {
    throw new Error(`npm audit gate failed for an unexpected reason:\n${result.output}`);
  }

  fs.writeFileSync(
    path.join(devOnlyTempRoot, "package.json"),
    `${JSON.stringify(devOnlyPackageJson, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(devOnlyTempRoot, "package-lock.json"),
    `${JSON.stringify(packageLock(devOnlyPackageJson.name, "devDependencies"), null, 2)}\n`,
  );

  const devOnlyResult = runGate(devOnlyTempRoot, [], {
    env: {
      ...process.env,
      npm_config_ignore_scripts: "true",
      npm_config_omit: "dev",
    },
  });
  if (devOnlyResult.error) {
    throw new InfrastructureError(devOnlyResult.error.message);
  }
  if (devOnlyResult.status === 0) {
    throw new Error("npm audit gate allowed npm_config_omit=dev to hide dev advisories.");
  }
  if (devOnlyResult.status === 2) {
    throw new InfrastructureError(
      `npm audit infrastructure error while checking dev dependency coverage:\n${devOnlyResult.output}`,
    );
  }
  if (!/lodash|GHSA/i.test(devOnlyResult.output)) {
    throw new Error(
      `dev dependency audit failed for an unexpected reason:\n${devOnlyResult.output}`,
    );
  }

  const acceptedPolicyPath = path.join(tempRoot, "accepted-audit-policy.jsonc");
  const acceptedAdvisories = loadFixtureFindings().map((finding) => ({
    id: finding.id,
    package: finding.package,
    owner: "security-team",
    reason: "Fixture proves accepted advisories unblock audited releases.",
    reviewBy: dateOnlyDaysFromNow(14),
    paths: finding.paths,
  }));
  fs.writeFileSync(
    acceptedPolicyPath,
    `${JSON.stringify(
      {
        _comment: AUDIT_POLICY_STRICT_JSON_NOTICE,
        auditLevel: "moderate",
        includeDev: true,
        acceptedAdvisories,
      },
      null,
      2,
    )}\n`,
  );

  const acceptedResult = runGate(tempRoot, ["--policy", acceptedPolicyPath], {
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_BASE_REF: "",
    },
  });
  if (acceptedResult.error) {
    throw new InfrastructureError(acceptedResult.error.message);
  }
  if (acceptedResult.status === 2) {
    throw new InfrastructureError(
      `npm audit infrastructure error while checking accepted advisories:\n${acceptedResult.output}`,
    );
  }
  if (acceptedResult.status !== 0) {
    throw new Error(
      `accepted advisory policy did not unblock the lodash fixture:\n${acceptedResult.output}`,
    );
  }

  console.log("Audit gate fixture failed closed and accepted tracked advisories.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof InfrastructureError ? 2 : 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(devOnlyTempRoot, { recursive: true, force: true });
}
