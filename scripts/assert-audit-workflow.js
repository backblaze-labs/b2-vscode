#!/usr/bin/env node

/**
 * Verifies workflow structure keeps the required dependency-audit gate enforced.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

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
  const text = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  return { text, workflow: yaml.load(text) };
}

function workflowOn(workflow) {
  return workflow.on ?? workflow["on"] ?? {};
}

function eventConfig(workflow, eventName) {
  const on = workflowOn(workflow);
  if (Array.isArray(on)) {
    return on.includes(eventName) ? {} : undefined;
  }
  if (typeof on === "string") {
    return on === eventName ? {} : undefined;
  }
  return on[eventName];
}

function workflowHasEvent(workflow, eventName) {
  return eventConfig(workflow, eventName) !== undefined;
}

function pathPatterns(workflow, eventName) {
  const config = eventConfig(workflow, eventName);
  const paths = config?.paths ?? [];
  return Array.isArray(paths) ? paths : [paths];
}

function patternCoversPath(pattern, targetPath) {
  if (pattern === targetPath) {
    return true;
  }
  if (pattern.endsWith("/**")) {
    return targetPath.startsWith(pattern.slice(0, -2));
  }
  return false;
}

function assertPathFilterCovers(workflow, eventName, targetPath) {
  const paths = pathPatterns(workflow, eventName);
  assert(
    paths.some((pattern) => patternCoversPath(String(pattern), targetPath)),
    `${eventName} path filters must include ${targetPath} or a covering glob.`,
  );
}

function assertNoPullRequestPaths(workflow) {
  const config = eventConfig(workflow, "pull_request");
  assert(config !== undefined, "test workflow must run on pull_request.");
  assert(
    config.paths === undefined && config["paths-ignore"] === undefined,
    "pull_request must not use path filters because the required check must report on every PR.",
  );
}

function job(workflow, jobName) {
  const selected = workflow.jobs?.[jobName];
  assert(selected, `missing workflow job: ${jobName}.`);
  assert(Array.isArray(selected.steps), `${jobName} must declare steps.`);
  return selected;
}

function normalizedRun(step) {
  return typeof step.run === "string" ? step.run.replace(/\s+/g, " ").trim() : "";
}

function stepIndex(jobConfig, label, predicate) {
  const index = jobConfig.steps.findIndex((step) => predicate(step, normalizedRun(step)));
  assert(index !== -1, `missing workflow step for ${label}.`);
  return index;
}

function stepByIndex(jobConfig, index) {
  return jobConfig.steps[index];
}

function hasTokens(command, tokens) {
  return tokens.every((token) => command.includes(token));
}

function assertIgnoreScriptsEnv(label, step) {
  assert(
    step.env?.npm_config_ignore_scripts === "true" || step.env?.npm_config_ignore_scripts === true,
    `${label} must set npm_config_ignore_scripts: "true".`,
  );
}

function assertRetryOnlyInfrastructureFailures(label, step) {
  assert(
    step.env?.RETRY_EXIT_CODES === "2" || step.env?.RETRY_EXIT_CODES === 2,
    `${label} must retry only npm audit infrastructure failures.`,
  );
}

function allRunSteps(workflow) {
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobName, jobConfig]) =>
    (jobConfig.steps ?? [])
      .map((step) => ({ jobName, step, run: normalizedRun(step) }))
      .filter(({ run }) => run),
  );
}

function assertNoPlainNpmCi(workflow, workflowName) {
  const offenders = allRunSteps(workflow).filter(
    ({ run }) => /\bnpm\s+ci\b/.test(run) && !run.includes("--ignore-scripts"),
  );

  assert(
    offenders.length === 0,
    `${workflowName} must not run plain npm ci; use npm ci --ignore-scripts.`,
  );
}

function assertNoAuditCi(workflow, workflowName) {
  const offenders = allRunSteps(workflow).filter(({ run }) => /\baudit-ci\b/.test(run));
  assert(offenders.length === 0, `${workflowName} must not execute audit-ci.`);
}

function assertNoMutableAuditScript(workflow) {
  const offenders = allRunSteps(workflow).filter(({ run }) => run.includes("npm run audit:ci"));
  assert(offenders.length === 0, "CI must not call the PR-mutable audit script.");
}

function assertAuditStep(label, step) {
  const command = normalizedRun(step);
  assertIgnoreScriptsEnv(label, step);
  assertRetryOnlyInfrastructureFailures(label, step);
  assert(
    hasTokens(command, ["bash scripts/retry.sh", "node", "scripts/run-npm-audit.js"]),
    `${label} must run the npm audit gate through the retry helper.`,
  );
}

function assertFixtureStep(label, step) {
  const command = normalizedRun(step);
  assertIgnoreScriptsEnv(label, step);
  assertRetryOnlyInfrastructureFailures(label, step);
  assert(
    hasTokens(command, ["bash scripts/retry.sh", "node", "scripts/assert-audit-gate-fixture.js"]),
    `${label} must run the audit fixture through the retry helper.`,
  );
}

function assertInstallStep(label, step) {
  assert(
    hasTokens(normalizedRun(step), ["bash scripts/retry.sh", "npm", "ci", "--ignore-scripts"]),
    `${label} must install with lifecycle scripts disabled through the retry helper.`,
  );
}

function assertSignatureStep(label, step) {
  assert(
    step.if === undefined,
    `${label} must run unconditionally; break-glass may skip only advisory audits.`,
  );
  assertIgnoreScriptsEnv(label, step);
  assert(
    hasTokens(normalizedRun(step), [
      "bash scripts/retry.sh",
      "npm",
      "audit",
      "signatures",
      "--registry=https://registry.npmjs.org/",
      "--userconfig=/dev/null",
      "--globalconfig=/tmp/b2-vscode-empty-npm-globalconfig",
    ]),
    `${label} must verify dependency signatures through the retry helper using the trusted npm registry config.`,
  );
}

function assertTestWorkflow(testWorkflow) {
  assert(
    workflowHasEvent(testWorkflow, "schedule"),
    "test workflow must include a scheduled audit run.",
  );
  assert(workflowHasEvent(testWorkflow, "push"), "test workflow must run on push.");
  assertNoPullRequestPaths(testWorkflow);

  for (const targetPath of [
    "README.md",
    "SECURITY.md",
    "audit-policy.jsonc",
    "scripts/audit-policy.js",
    "scripts/run-npm-audit.js",
    "scripts/retry.sh",
    "scripts/npm-command.js",
  ]) {
    assertPathFilterCovers(testWorkflow, "push", targetPath);
  }

  const testJob = job(testWorkflow, "test");
  const installIndex = stepIndex(testJob, "test install", (_step, run) => /\bnpm\s+ci\b/.test(run));
  const policyIndex = stepIndex(testJob, "audit policy guard", (_step, run) =>
    run.includes("scripts/assert-audit-policy.js"),
  );
  const fixtureIndex = stepIndex(testJob, "audit gate fixture", (_step, run) =>
    run.includes("scripts/assert-audit-gate-fixture.js"),
  );
  const auditIndex = stepIndex(testJob, "dependency advisory audit", (_step, run) =>
    run.includes("scripts/run-npm-audit.js"),
  );
  const signatureIndex = stepIndex(testJob, "dependency signature verification", (_step, run) =>
    /\bnpm\s+audit\s+signatures\b/.test(run),
  );
  const workflowGuardIndex = stepIndex(testJob, "audit workflow guard", (_step, run) =>
    run.includes("scripts/assert-audit-workflow.js"),
  );
  const testRunIndex = stepIndex(testJob, "VS Code tests", (_step, run) =>
    /\bnpm\s+test\b/.test(run),
  );

  for (const [label, index] of [
    ["install", installIndex],
    ["audit policy guard", policyIndex],
    ["audit gate fixture", fixtureIndex],
    ["dependency advisory audit", auditIndex],
    ["dependency signature verification", signatureIndex],
    ["audit workflow guard", workflowGuardIndex],
  ]) {
    assert(index < testRunIndex, `${label} must run before VS Code tests.`);
  }
  assert(installIndex < auditIndex, "test workflow must install before auditing.");
  assert(auditIndex < signatureIndex, "test workflow must audit before verifying signatures.");
  assert(
    signatureIndex < workflowGuardIndex,
    "workflow guard imports installed YAML tooling and must run after signature verification.",
  );

  assertInstallStep("test install step", stepByIndex(testJob, installIndex));
  assertFixtureStep("test audit fixture step", stepByIndex(testJob, fixtureIndex));
  assertAuditStep("test audit step", stepByIndex(testJob, auditIndex));
  assertSignatureStep("test signature step", stepByIndex(testJob, signatureIndex));
}

function assertReleaseWorkflow(releaseWorkflow) {
  const breakGlassJob = job(releaseWorkflow, "dependency-gate-break-glass");
  const qualityJob = job(releaseWorkflow, "quality");
  const auditJob = job(releaseWorkflow, "audit");
  const buildJob = job(releaseWorkflow, "build");
  const buildNeeds = Array.isArray(buildJob.needs) ? buildJob.needs : [buildJob.needs];
  assert(
    breakGlassJob.environment === "dependency-gate-break-glass" ||
      breakGlassJob.environment?.name === "dependency-gate-break-glass",
    "dependency-gate-break-glass job must require the protected dependency-gate-break-glass environment.",
  );
  stepIndex(breakGlassJob, "break-glass environment protection check", (_step, run) =>
    hasTokens(run, ["environments/dependency-gate-break-glass", "required_reviewers"]),
  );
  assert(buildNeeds.includes("quality"), "build must depend on the quality audit gate.");
  assert(buildNeeds.includes("audit"), "build must depend on the dependency audit job.");
  assert(
    buildNeeds.includes("dependency-gate-break-glass"),
    "build must depend on dependency-gate-break-glass approval.",
  );

  const qualityInstallIndex = stepIndex(qualityJob, "release quality install", (_step, run) =>
    /\bnpm\s+ci\b/.test(run),
  );
  const qualityAuditIndex = stepIndex(qualityJob, "release quality audit", (_step, run) =>
    run.includes("scripts/run-npm-audit.js"),
  );
  const qualitySignatureIndex = stepIndex(qualityJob, "release quality signatures", (_step, run) =>
    /\bnpm\s+audit\s+signatures\b/.test(run),
  );
  const qualityCheckIndex = stepIndex(qualityJob, "release quality checks", (_step, run) =>
    run.includes("npm run check"),
  );

  assert(qualityInstallIndex < qualityAuditIndex, "release quality must install before auditing.");
  assert(
    qualityAuditIndex < qualitySignatureIndex,
    "release quality must audit before verifying signatures.",
  );
  assert(
    qualitySignatureIndex < qualityCheckIndex,
    "release quality must verify signatures before running package scripts.",
  );

  assertInstallStep("release quality install step", stepByIndex(qualityJob, qualityInstallIndex));
  assertAuditStep("release quality audit step", stepByIndex(qualityJob, qualityAuditIndex));
  assertSignatureStep(
    "release quality signature step",
    stepByIndex(qualityJob, qualitySignatureIndex),
  );

  const auditInstallIndex = stepIndex(auditJob, "release audit install", (_step, run) =>
    /\bnpm\s+ci\b/.test(run),
  );
  const auditGateIndex = stepIndex(auditJob, "release audit gate", (_step, run) =>
    run.includes("scripts/run-npm-audit.js"),
  );
  assert(auditInstallIndex < auditGateIndex, "release audit job must install before auditing.");
  assertInstallStep("release audit install step", stepByIndex(auditJob, auditInstallIndex));
  assertAuditStep("release audit step", stepByIndex(auditJob, auditGateIndex));

  const rawAuditRelease = allRunSteps(releaseWorkflow).filter(({ run }) =>
    run.includes("npm run audit:release"),
  );
  assert(
    rawAuditRelease.length === 0,
    "release workflow must not call the raw audit:release package script.",
  );
}

const { workflow: testWorkflow } = readWorkflow(".github/workflows/test.yml");
const { workflow: releaseWorkflow } = readWorkflow(".github/workflows/release.yml");

assertNoAuditCi(testWorkflow, "test workflow");
assertNoAuditCi(releaseWorkflow, "release workflow");
assertNoMutableAuditScript(testWorkflow);
assertNoPlainNpmCi(testWorkflow, "test workflow");
assertNoPlainNpmCi(releaseWorkflow, "release workflow");
assertTestWorkflow(testWorkflow);
assertReleaseWorkflow(releaseWorkflow);

console.log("Audit workflow guardrails verified.");
