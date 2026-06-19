#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const expectedAuditScript = "npx --no-install audit-ci --config audit-ci.jsonc";

function fail(message) {
  console.error(`Audit policy guardrail failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// audit-ci accepts JSONC. This guard intentionally supports only the subset
// used by audit-ci.jsonc today: JSON plus trailing commas.
function parseAuditPolicyJsonWithTrailingCommas(text) {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

function validateAuditPolicy(auditConfig, packageJson) {
  assert(auditConfig["package-manager"] === "npm", "audit-ci must audit with npm.");
  assert(auditConfig.moderate === true, "audit-ci.jsonc must keep moderate: true.");
  assert(auditConfig.low !== true, "low advisories must not block the required gate.");
  assert(Array.isArray(auditConfig.allowlist), "audit-ci.jsonc must declare an allowlist array.");
  assert(auditConfig.allowlist.length === 0, "audit-ci.jsonc allowlist must stay empty.");

  assert(packageJson.scripts?.["audit:ci"] === expectedAuditScript, "audit:ci script drifted.");
  assert(
    /^\d+\.\d+\.\d+$/.test(packageJson.devDependencies?.["audit-ci"] ?? ""),
    "audit-ci must stay exact-pinned in devDependencies.",
  );
}

function loadCurrentPolicy() {
  const auditConfig = parseAuditPolicyJsonWithTrailingCommas(
    fs.readFileSync(path.join(repoRoot, "audit-ci.jsonc"), "utf8"),
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return { auditConfig, packageJson };
}

function expectInvalid(name, mutate) {
  const { auditConfig, packageJson } = loadCurrentPolicy();
  mutate(auditConfig, packageJson);

  try {
    validateAuditPolicy(auditConfig, packageJson);
  } catch {
    return;
  }

  throw new Error(`negative policy case unexpectedly passed: ${name}`);
}

try {
  const { auditConfig, packageJson } = loadCurrentPolicy();
  validateAuditPolicy(auditConfig, packageJson);

  expectInvalid("disabled moderate threshold", (auditConfig) => {
    auditConfig.moderate = false;
  });
  expectInvalid("added allowlist entry", (auditConfig) => {
    auditConfig.allowlist = ["GHSA-xxxx-yyyy-zzzz"];
  });
  expectInvalid("neutered audit script", (_auditConfig, packageJson) => {
    packageJson.scripts["audit:ci"] = 'node -e "process.exit(0)"';
  });

  console.log("Audit policy guardrails verified.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
