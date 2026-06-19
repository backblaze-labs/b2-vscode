#!/usr/bin/env node

/**
 * Verifies the dependency-audit policy cannot silently weaken the required gate.
 */

const path = require("path");
const { dateOnlyDaysFromNow, loadCurrentPolicy, validateAuditPolicy } = require("./audit-policy");

const repoRoot = path.join(__dirname, "..");

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
  mutate(auditPolicy, packageJson);
  validateAuditPolicy(auditPolicy, packageJson);
}

function acceptedAdvisory(overrides = {}) {
  return {
    id: "GHSA-1234-5678-9abc",
    package: "example-package",
    owner: "security-team",
    reason: "No patched version is available yet.",
    reviewBy: dateOnlyDaysFromNow(7),
    ...overrides,
  };
}

try {
  const { auditPolicy, packageJson } = loadCurrentPolicy(repoRoot);
  validateAuditPolicy(auditPolicy, packageJson);

  // Validator self-checks: these do not inspect repository state, they prove
  // the guard rejects known policy bypasses before CI trusts it.
  expectValid("time-boxed accepted advisory", (auditPolicy) => {
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
  expectInvalid("expired accepted advisory", (auditPolicy) => {
    auditPolicy.acceptedAdvisories = [acceptedAdvisory({ reviewBy: dateOnlyDaysFromNow(-1) })];
  });
  expectInvalid("overlong accepted advisory", (auditPolicy) => {
    auditPolicy.acceptedAdvisories = [acceptedAdvisory({ reviewBy: dateOnlyDaysFromNow(31) })];
  });
  expectInvalid("accepted advisory without owner", (auditPolicy) => {
    auditPolicy.acceptedAdvisories = [acceptedAdvisory({ owner: "" })];
  });
  expectInvalid("neutered audit script", (_auditPolicy, packageJson) => {
    packageJson.scripts["audit:ci"] = 'node -e "process.exit(0)"';
  });
  expectInvalid("reintroduced audit-ci dependency", (_auditPolicy, packageJson) => {
    packageJson.devDependencies["audit-ci"] = "7.1.0";
  });

  console.log("Audit policy guardrails verified.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
