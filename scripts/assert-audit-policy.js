#!/usr/bin/env node

/**
 * Verifies the dependency-audit policy cannot silently weaken the required gate.
 */

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const {
  AUDIT_POLICY_STRICT_JSON_NOTICE,
  collectAuditFindings,
  dateOnlyDaysFromNow,
  isAcceptedFinding,
  loadCurrentPolicy,
  validateAuditPolicy,
} = require("./audit-policy");
const { trustedNpmEnv } = require("./npm-command");

function parseArgs(argv) {
  const args = {
    repoRoot: path.join(__dirname, ".."),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--repo-root") {
      throw new Error(`unknown argument: ${arg}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--repo-root requires a path value.");
    }
    args.repoRoot = path.resolve(value);
    index += 1;
  }

  return args;
}

const { repoRoot } = parseArgs(process.argv.slice(2));

function fail(message) {
  console.error(`Audit policy guardrail failed: ${message}`);
  process.exit(1);
}

function expectInvalid(name, mutate) {
  const { auditPolicy, packageJson } = loadCurrentPolicy(repoRoot);
  mutate(auditPolicy, packageJson);

  try {
    validateAuditPolicy(auditPolicy, packageJson);
  } catch {
    return;
  }

  throw new Error(`negative policy case unexpectedly passed: ${name}`);
}

function expectValid(name, mutate) {
  const { auditPolicy, packageJson } = loadCurrentPolicy(repoRoot);
  mutate(auditPolicy);
  validateAuditPolicy(auditPolicy, packageJson);
}

function acceptedAdvisory(overrides = {}) {
  return {
    id: "GHSA-1234-5678-9abc",
    package: "example-package",
    owner: "security-team",
    reason: "No patched version is available yet.",
    reviewBy: dateOnlyDaysFromNow(14),
    paths: ["node_modules/example-package"],
    ...overrides,
  };
}

function assertAcceptedPathScope() {
  const finding = {
    id: "GHSA-1234-5678-9abc",
    package: "example-package",
    vulnerability: "example-package",
    paths: ["node_modules/example-package", "node_modules/tool/node_modules/example-package"],
  };

  const partialAcceptance = acceptedAdvisory({ paths: ["node_modules/example-package"] });
  if (isAcceptedFinding(finding, [partialAcceptance])) {
    throw new Error("accepted advisory paths must cover every affected finding path.");
  }

  const emptyPathFinding = { ...finding, paths: [] };
  if (isAcceptedFinding(emptyPathFinding, [partialAcceptance])) {
    throw new Error("path-scoped accepted advisories must not match findings with no paths.");
  }

  const fullAcceptance = acceptedAdvisory({ paths: finding.paths });
  if (!isAcceptedFinding(finding, [fullAcceptance])) {
    throw new Error("accepted advisory paths should match when every finding path is listed.");
  }

  const groupedFinding = {
    ...finding,
    package: "transitive-example-package",
    vulnerability: "example-package",
  };
  if (isAcceptedFinding(groupedFinding, [fullAcceptance])) {
    throw new Error("accepted advisory package matching must not widen to vulnerability groups.");
  }
}

function assertUnknownSeverityBlocks() {
  const findings = collectAuditFindings(
    {
      vulnerabilities: {
        "example-package": {
          name: "example-package",
          via: [
            {
              source: 12345,
              name: "example-package",
              dependency: "example-package",
              title: "Fixture advisory with missing severity",
            },
          ],
          nodes: ["node_modules/example-package"],
        },
      },
    },
    "moderate",
  );

  if (findings.length !== 1 || findings[0].severity !== "unknown") {
    throw new Error("advisories with missing severity must be collected as blocking findings.");
  }
}

function assertCodeOwnerProtection() {
  const codeownersPath = path.join(repoRoot, ".github", "CODEOWNERS");
  const codeowners = fs.readFileSync(codeownersPath, "utf8");
  const protectedPaths = new Set(
    codeowners
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 2 && parts.some((part) => part.startsWith("@")))
      .map(([pattern]) => pattern),
  );

  for (const requiredPath of [
    "/audit-policy.jsonc",
    "/package.json",
    "/package-lock.json",
    "/.github/marketplace-publisher/package.json",
    "/.github/marketplace-publisher/package-lock.json",
    "/npm-shrinkwrap.json",
    "/.npmrc",
    "/scripts/audit-policy.js",
    "/scripts/run-npm-audit.js",
    "/scripts/retry.sh",
    "/scripts/npm-command.js",
    "/scripts/pr-audit-metadata.js",
    "/scripts/assert-audit-policy.js",
    "/scripts/assert-audit-workflow.js",
    "/scripts/assert-ignore-scripts-install.js",
    "/scripts/assert-audit-gate-fixture.js",
    "/.github/workflows/pr-tests.yml",
  ]) {
    if (!protectedPaths.has(requiredPath)) {
      throw new Error(`CODEOWNERS must require review for ${requiredPath}.`);
    }
  }
}

function assertUnsupportedInstallMetadataAbsent() {
  for (const fileName of ["npm-shrinkwrap.json", ".npmrc"]) {
    const filePath = path.join(repoRoot, fileName);
    if (fs.existsSync(filePath)) {
      throw new Error(`${fileName} must not be present in the audited directory.`);
    }
  }
}

function assertTrustedNpmEnvNeutralizesTransportConfig() {
  const env = trustedNpmEnv({
    npm_config_registry: "https://attacker.example/",
    npm_config_audit_registry: "https://attacker.example/",
    npm_config_userconfig: "/tmp/attacker-user-npmrc",
    npm_config_globalconfig: "/tmp/attacker-global-npmrc",
    npm_config_proxy: "http://attacker.example/",
    npm_config_https_proxy: "http://attacker.example/",
    npm_config_cafile: "/tmp/attacker-ca.pem",
    npm_config_ca: "attacker-ca",
    npm_config_cert: "attacker-cert",
    npm_config_key: "attacker-key",
    npm_config_strict_ssl: "false",
    npm_config_offline: "true",
    npm_config_future_knob: "attacker-value",
    NPM_CONFIG_PROXY: "http://uppercase-attacker.example/",
  });

  for (const key of Object.keys(env)) {
    if (/^npm_config_future_knob$/iu.test(key) || /^NPM_CONFIG_/u.test(key)) {
      throw new Error(`trusted npm env must drop untrusted npm config key ${key}.`);
    }
  }

  if (env.npm_config_proxy !== "" || env.npm_config_https_proxy !== "") {
    throw new Error("trusted npm env must clear proxy config.");
  }
  if (env.npm_config_strict_ssl !== "true" || env.npm_config_offline !== "false") {
    throw new Error("trusted npm env must pin strict TLS and online mode.");
  }
  if (env.npm_config_registry !== "https://registry.npmjs.org/") {
    throw new Error("trusted npm env must pin the public npm registry.");
  }
}

function assertRetryPropagatesFailure() {
  const result = spawnSync(
    "bash",
    [path.join(__dirname, "retry.sh"), "node", "-e", "process.exit(7)"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, RETRY_ATTEMPTS: "1" },
    },
  );

  if (result.status !== 7) {
    throw new Error(
      `retry.sh must propagate the wrapped command exit code. Exit ${result.status}.\n${
        result.stdout ?? ""
      }\n${result.stderr ?? ""}`,
    );
  }
}

try {
  const { auditPolicy, packageJson } = loadCurrentPolicy(repoRoot);
  validateAuditPolicy(auditPolicy, packageJson);
  assertAcceptedPathScope();
  assertUnknownSeverityBlocks();
  assertCodeOwnerProtection();
  assertUnsupportedInstallMetadataAbsent();
  assertTrustedNpmEnvNeutralizesTransportConfig();
  assertRetryPropagatesFailure();

  // Validator self-checks: these do not inspect repository state, they prove
  // the guard rejects known policy bypasses before CI trusts it.
  expectValid("time-boxed accepted advisory", (auditPolicy) => {
    auditPolicy._comment = AUDIT_POLICY_STRICT_JSON_NOTICE;
    auditPolicy.acceptedAdvisories = [acceptedAdvisory()];
  });
  expectInvalid("lowered audit threshold", (auditPolicy) => {
    auditPolicy.auditLevel = "high";
  });
  expectInvalid("skipped dev dependencies", (auditPolicy) => {
    auditPolicy.includeDev = false;
  });
  expectInvalid("audit-ci skip-dev bypass", (auditPolicy) => {
    auditPolicy["skip-dev"] = true;
  });
  expectInvalid("audit-ci pass-enoaudit bypass", (auditPolicy) => {
    auditPolicy["pass-enoaudit"] = true;
  });
  expectInvalid("unexpected policy key", (auditPolicy) => {
    auditPolicy.allowlist = ["GHSA-1234-5678-9abc"];
  });
  expectInvalid("removed strict JSON notice", (auditPolicy) => {
    auditPolicy._comment = undefined;
  });
  expectInvalid("weakened strict JSON notice", (auditPolicy) => {
    auditPolicy._comment = "comments are fine";
  });
  expectInvalid("expired accepted advisory", (auditPolicy) => {
    auditPolicy.acceptedAdvisories = [acceptedAdvisory({ reviewBy: dateOnlyDaysFromNow(-1) })];
  });
  expectInvalid("overlong accepted advisory", (auditPolicy) => {
    auditPolicy.acceptedAdvisories = [acceptedAdvisory({ reviewBy: dateOnlyDaysFromNow(31) })];
  });
  expectInvalid("accepted advisory without owner", (auditPolicy) => {
    auditPolicy.acceptedAdvisories = [acceptedAdvisory({ owner: "" })];
  });
  expectInvalid("accepted advisory without paths", (auditPolicy) => {
    auditPolicy.acceptedAdvisories = [acceptedAdvisory({ paths: undefined })];
  });
  expectInvalid("neutered audit script", (_auditPolicy, packageJson) => {
    packageJson.scripts["audit:ci"] = 'node -e "process.exit(0)"';
  });
  expectInvalid("raw release audit script", (_auditPolicy, packageJson) => {
    packageJson.scripts["audit:release"] = "npm audit --omit=dev --audit-level=moderate";
  });
  expectInvalid("reintroduced audit-ci dependency", (_auditPolicy, packageJson) => {
    packageJson.devDependencies["audit-ci"] = "7.1.0";
  });

  console.log("Audit policy guardrails verified.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
