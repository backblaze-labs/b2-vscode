#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");

function fail(message) {
  console.error(`Audit workflow guardrail failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function getStep(workflow, name) {
  const marker = `- name: ${name}`;
  const start = workflow.indexOf(marker);
  assert(start !== -1, `missing workflow step: ${name}.`);

  const rest = workflow.slice(start + marker.length);
  const nextStep = rest.search(/\n\s+- name: /);
  return nextStep === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextStep);
}

function hasTokens(block, tokens) {
  const normalized = block.replace(/\s+/g, " ");
  return tokens.every((token) => normalized.includes(token));
}

function assertIgnoreScriptsEnv(label, step) {
  assert(
    /npm_config_ignore_scripts\s*:\s*["']?true["']?/.test(step),
    `${label} must set npm_config_ignore_scripts: "true".`,
  );
}

function assertNoPlainNpmCi(workflow, workflowName) {
  const offenders = workflow
    .split("\n")
    .filter((line) => line.includes("npm ci") && !line.includes("--ignore-scripts"));

  assert(
    offenders.length === 0,
    `${workflowName} must not run plain npm ci; use npm ci --ignore-scripts.`,
  );
}

const testWorkflow = readWorkflow(".github/workflows/test.yml");
const releaseWorkflow = readWorkflow(".github/workflows/release.yml");
const releaseBuildIndex = releaseWorkflow.indexOf("- name: Build extension");
const releaseAuditIndex = releaseWorkflow.indexOf("- name: Audit dependency advisories");
const releaseSignatureIndex = releaseWorkflow.indexOf("- name: Verify dependency signatures");

assert(testWorkflow.includes("schedule:"), "test workflow must include a scheduled audit run.");
assert(!testWorkflow.includes("npm run audit:ci"), "CI must not call the PR-mutable audit script.");
assert(releaseBuildIndex !== -1, "release workflow must still build the extension.");
assert(
  releaseAuditIndex !== -1 && releaseAuditIndex < releaseBuildIndex,
  "release workflow must audit dependencies before building.",
);
assert(
  releaseSignatureIndex !== -1 && releaseSignatureIndex < releaseBuildIndex,
  "release workflow must verify dependency signatures before building.",
);
assertNoPlainNpmCi(testWorkflow, "test workflow");
assertNoPlainNpmCi(releaseWorkflow, "release workflow");

const testInstallStep = getStep(testWorkflow, "Install dependencies without lifecycle scripts");
const testAuditStep = getStep(testWorkflow, "Audit dependency advisories");
const testSignatureStep = getStep(testWorkflow, "Verify dependency signatures");
const releaseInstallStep = getStep(
  releaseWorkflow,
  "Install dependencies without lifecycle scripts",
);
const releaseAuditStep = getStep(releaseWorkflow, "Audit dependency advisories");
const releaseSignatureStep = getStep(releaseWorkflow, "Verify dependency signatures");

// CI deliberately inlines the audit command instead of `npm run audit:ci`
// because package.json is part of the PR-mutable checkout.
for (const [label, step] of [
  ["test audit step", testAuditStep],
  ["release audit step", releaseAuditStep],
]) {
  assertIgnoreScriptsEnv(label, step);
  assert(
    hasTokens(step, [
      "bash scripts/retry.sh",
      "npx",
      "--no-install",
      "audit-ci",
      "--config",
      "audit-ci.jsonc",
    ]),
    `${label} must run the pinned local audit-ci binary through the retry helper.`,
  );
}

for (const [label, step] of [
  ["test install step", testInstallStep],
  ["release install step", releaseInstallStep],
]) {
  assert(
    hasTokens(step, ["bash scripts/retry.sh", "npm", "ci", "--ignore-scripts"]),
    `${label} must install with lifecycle scripts disabled through the retry helper.`,
  );
}

for (const [label, step] of [
  ["test signature step", testSignatureStep],
  ["release signature step", releaseSignatureStep],
]) {
  assert(
    hasTokens(step, ["bash scripts/retry.sh", "npm", "audit", "signatures"]),
    `${label} must verify dependency signatures through the retry helper.`,
  );
}

console.log("Audit workflow guardrails verified.");
