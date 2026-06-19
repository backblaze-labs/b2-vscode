#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "test.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

function fail(message) {
  console.error(`Audit workflow guardrail failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

const auditStepIndex = workflow.indexOf("- name: Audit dependency advisories");
const installStepIndex = workflow.indexOf("- name: Install dependencies without lifecycle scripts");

assert(auditStepIndex !== -1, "missing the dependency advisory audit step.");
assert(installStepIndex !== -1, "missing the lifecycle-disabled install step.");
assert(
  auditStepIndex < installStepIndex,
  "the advisory audit must run before dependency lifecycle scripts could run.",
);

const auditStep = workflow.slice(auditStepIndex, installStepIndex);

assert(
  !workflow.includes("npm run audit:ci"),
  "CI must not call the repo-controlled audit script.",
);
assert(
  auditStep.includes("npx --yes --ignore-scripts audit-ci@7.1.0 --config audit-ci.jsonc"),
  "CI must call the pinned audit-ci command directly.",
);
assert(
  auditStep.includes('npm_config_ignore_scripts: "true"'),
  "the advisory audit step must run with npm lifecycle scripts disabled.",
);
assert(
  workflow.includes("npm ci --ignore-scripts"),
  "dependency installation must disable npm lifecycle scripts.",
);
assert(
  !/npm ci(?![^\n]*--ignore-scripts)/.test(workflow),
  "plain npm ci must not be reintroduced in the required test workflow.",
);
assert(
  workflow.includes("npm audit signatures"),
  "dependency signature verification must remain in the required check.",
);

console.log("Audit workflow guardrails verified.");
