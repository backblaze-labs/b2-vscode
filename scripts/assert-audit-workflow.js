#!/usr/bin/env node

/**
 * Verifies workflow structure keeps the required dependency-audit gate enforced.
 *
 * These checks are intentionally strict because the workflow is the trust
 * boundary for dependency code. When editing audit steps, update this file
 * together with .github/workflows/test.yml, build-extension.yml, release.yml,
 * and scripts/npm-command.js.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

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

class GuardrailFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardrailFailure";
  }
}

function fail(message) {
  throw new GuardrailFailure(message);
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

function assertNoPullRequestEvent(workflow, workflowName) {
  assert(
    !workflowHasEvent(workflow, "pull_request"),
    `${workflowName} must not use pull_request because PRs can rewrite that workflow.`,
  );
}

function assertNoPullRequestTargetPaths(workflow) {
  const config = eventConfig(workflow, "pull_request_target");
  assert(config !== undefined, "test workflow must run on pull_request_target.");
  assert(
    config.paths === undefined && config["paths-ignore"] === undefined,
    "pull_request_target must not use path filters because the required check must report on every PR.",
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

function retryHelperPath(trusted) {
  return trusted ? "../trusted-source/scripts/retry.sh" : "scripts/retry.sh";
}

function scriptPath(scriptName, trusted) {
  return trusted ? `../trusted-source/scripts/${scriptName}` : `scripts/${scriptName}`;
}

function assertNoEventEnvOverride(workflow, workflowName) {
  const offenders = Object.entries(workflow.jobs ?? {}).flatMap(([jobName, jobConfig]) =>
    (jobConfig.steps ?? [])
      .filter(
        (step) =>
          Object.prototype.hasOwnProperty.call(step.env ?? {}, "GITHUB_EVENT_NAME") ||
          Object.prototype.hasOwnProperty.call(step.env ?? {}, "GITHUB_BASE_REF"),
      )
      .map((step) => `${jobName}/${step.name ?? "unnamed step"}`),
  );

  assert(
    offenders.length === 0,
    `${workflowName} must not override GITHUB_EVENT_NAME or GITHUB_BASE_REF in step env: ${offenders.join(
      ", ",
    )}.`,
  );
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

function assertAllNpmCiPinned(workflow, workflowName) {
  const offenders = allRunSteps(workflow).filter(
    ({ run }) =>
      /\bnpm\s+ci\b/.test(run) &&
      !hasTokens(run, [
        "--registry=https://registry.npmjs.org/",
        "--userconfig=/dev/null",
        "--globalconfig=/tmp/b2-vscode-empty-npm-globalconfig",
      ]),
  );

  assert(
    offenders.length === 0,
    `${workflowName} npm ci steps must pin the npm registry and config files.`,
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

function assertTrustedNpmInstallConfig(label, command) {
  assert(
    hasTokens(command, [
      "--registry=https://registry.npmjs.org/",
      "--userconfig=/dev/null",
      "--globalconfig=/tmp/b2-vscode-empty-npm-globalconfig",
    ]),
    `${label} must pin npm registry, userconfig, and globalconfig.`,
  );
}

function assertAuditStep(label, step, options = {}) {
  const command = normalizedRun(step);
  assertIgnoreScriptsEnv(label, step);
  assertRetryOnlyInfrastructureFailures(label, step);
  assert(
    hasTokens(command, [
      "bash",
      retryHelperPath(options.trusted),
      "node",
      scriptPath("run-npm-audit.js", options.trusted),
    ]),
    `${label} must run the npm audit gate through the retry helper.`,
  );
  if (options.trustedBaseRef) {
    assert(
      command.includes("--trusted-base-ref"),
      `${label} must pass the protected base branch to the trusted audit gate.`,
    );
  }
}

function assertFixtureStep(label, step, options = {}) {
  const command = normalizedRun(step);
  assertIgnoreScriptsEnv(label, step);
  assertRetryOnlyInfrastructureFailures(label, step);
  assert(
    hasTokens(command, [
      "bash",
      retryHelperPath(options.trusted),
      "node",
      scriptPath("assert-audit-gate-fixture.js", options.trusted),
    ]),
    `${label} must run the audit fixture through the retry helper.`,
  );
}

function assertInstallStep(label, step, options = {}) {
  const command = normalizedRun(step);
  assert(
    hasTokens(command, ["bash", retryHelperPath(options.trusted), "npm", "ci", "--ignore-scripts"]),
    `${label} must install with lifecycle scripts disabled through the retry helper.`,
  );
  assertTrustedNpmInstallConfig(label, command);
}

function assertSignatureStep(label, step, options = {}) {
  assert(
    step.if === undefined,
    `${label} must run unconditionally; break-glass may skip only advisory audits.`,
  );
  assertIgnoreScriptsEnv(label, step);
  assert(
    hasTokens(normalizedRun(step), [
      "bash",
      retryHelperPath(options.trusted),
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

function assertCheckoutPair(jobConfig, workflowName) {
  const sourceIndex = stepIndex(
    jobConfig,
    `${workflowName} PR source checkout`,
    (step) =>
      String(step.uses ?? "").startsWith("actions/checkout@") && step.with?.path === "source",
  );
  const trustedIndex = stepIndex(
    jobConfig,
    `${workflowName} trusted source checkout`,
    (step) =>
      String(step.uses ?? "").startsWith("actions/checkout@") &&
      step.with?.path === "trusted-source",
  );
  const sourceStep = stepByIndex(jobConfig, sourceIndex);
  const trustedStep = stepByIndex(jobConfig, trustedIndex);

  assert(
    String(sourceStep.with?.repository ?? "").includes(
      "github.event.pull_request.head.repo.full_name",
    ) && String(sourceStep.with?.repository ?? "").includes("github.repository"),
    `${workflowName} source checkout must select the PR head repository for PRs.`,
  );
  assert(
    String(sourceStep.with?.ref ?? "").includes("github.event.pull_request.head.sha") &&
      String(sourceStep.with?.ref ?? "").includes("github.sha"),
    `${workflowName} source checkout must select the PR head SHA for PRs.`,
  );
  assert(
    trustedStep.with?.repository === "${{ github.repository }}",
    `${workflowName} trusted checkout must come from the base repository.`,
  );
  assert(
    String(trustedStep.with?.ref ?? "").includes("github.event.pull_request.base.sha") &&
      String(trustedStep.with?.ref ?? "").includes("github.sha"),
    `${workflowName} trusted checkout must select the protected base SHA for PRs.`,
  );

  return { sourceIndex, trustedIndex };
}

function assertRunsInSource(label, step) {
  assert(step["working-directory"] === "source", `${label} must run in the PR source checkout.`);
}

function assertTestWorkflow(testWorkflow) {
  assert(
    workflowHasEvent(testWorkflow, "schedule"),
    "test workflow must include a scheduled audit run.",
  );
  assert(workflowHasEvent(testWorkflow, "push"), "test workflow must run on push.");
  assertNoPullRequestEvent(testWorkflow, "test workflow");
  assertNoPullRequestTargetPaths(testWorkflow);

  for (const targetPath of [
    "README.md",
    "SECURITY.md",
    "audit-policy.jsonc",
    "package.json",
    "package-lock.json",
    ".npmrc",
    "scripts/audit-policy.js",
    "scripts/run-npm-audit.js",
    "scripts/retry.sh",
    "scripts/npm-command.js",
  ]) {
    assertPathFilterCovers(testWorkflow, "push", targetPath);
  }

  const testJob = job(testWorkflow, "test");
  assertCheckoutPair(testJob, "test workflow");
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

  assertInstallStep("test install step", stepByIndex(testJob, installIndex), { trusted: true });
  assertFixtureStep("test audit fixture step", stepByIndex(testJob, fixtureIndex), {
    trusted: true,
  });
  assertAuditStep("test audit step", stepByIndex(testJob, auditIndex), {
    trusted: true,
    trustedBaseRef: true,
  });
  assertSignatureStep("test signature step", stepByIndex(testJob, signatureIndex), {
    trusted: true,
  });
  for (const [label, index] of [
    ["test install step", installIndex],
    ["test audit fixture step", fixtureIndex],
    ["test audit step", auditIndex],
    ["test signature step", signatureIndex],
    ["test workflow guard step", workflowGuardIndex],
    ["VS Code test step", testRunIndex],
  ]) {
    assertRunsInSource(label, stepByIndex(testJob, index));
  }
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

function assertBuildExtensionWorkflow(buildWorkflow) {
  assertNoPullRequestEvent(buildWorkflow, "build-extension workflow");
  assert(
    workflowHasEvent(buildWorkflow, "pull_request_target"),
    "build-extension workflow must run on pull_request_target.",
  );

  const buildJob = job(buildWorkflow, "build");
  const testInstallationJob = job(buildWorkflow, "test-installation");
  assertCheckoutPair(buildJob, "build-extension build job");
  assertCheckoutPair(testInstallationJob, "build-extension test-installation job");

  const installIndex = stepIndex(buildJob, "build-extension install", (_step, run) =>
    /\bnpm\s+ci\b/.test(run),
  );
  const policyIndex = stepIndex(buildJob, "build-extension audit policy guard", (_step, run) =>
    run.includes("scripts/assert-audit-policy.js"),
  );
  const auditIndex = stepIndex(buildJob, "build-extension audit gate", (_step, run) =>
    run.includes("scripts/run-npm-audit.js"),
  );
  const signatureIndex = stepIndex(buildJob, "build-extension signatures", (_step, run) =>
    /\bnpm\s+audit\s+signatures\b/.test(run),
  );
  const compileIndex = stepIndex(buildJob, "build-extension compile", (_step, run) =>
    run.includes("npm run compile"),
  );
  const packageIndex = stepIndex(buildJob, "build-extension package", (_step, run) =>
    run.includes("npm run vsix"),
  );

  assert(installIndex < auditIndex, "build-extension must install before auditing.");
  assert(policyIndex < auditIndex, "build-extension must validate policy before auditing.");
  assert(
    auditIndex < signatureIndex,
    "build-extension must audit before verifying dependency signatures.",
  );
  assert(
    signatureIndex < compileIndex,
    "build-extension must verify dependency signatures before compiling PR code.",
  );
  assert(compileIndex < packageIndex, "build-extension must compile before packaging.");

  assertInstallStep("build-extension install step", stepByIndex(buildJob, installIndex), {
    trusted: true,
  });
  assertAuditStep("build-extension audit step", stepByIndex(buildJob, auditIndex), {
    trusted: true,
    trustedBaseRef: true,
  });
  assertSignatureStep("build-extension signature step", stepByIndex(buildJob, signatureIndex), {
    trusted: true,
  });

  for (const [label, index] of [
    ["build-extension install step", installIndex],
    ["build-extension policy step", policyIndex],
    ["build-extension audit step", auditIndex],
    ["build-extension signature step", signatureIndex],
    ["build-extension compile step", compileIndex],
    ["build-extension package step", packageIndex],
  ]) {
    assertRunsInSource(label, stepByIndex(buildJob, index));
  }

  const testInstallIndex = stepIndex(
    testInstallationJob,
    "build-extension package smoke install",
    (_step, run) => /\bnpm\s+ci\b/.test(run),
  );
  assertInstallStep(
    "build-extension package smoke install step",
    stepByIndex(testInstallationJob, testInstallIndex),
    { trusted: true },
  );
  assertRunsInSource(
    "build-extension package smoke install step",
    stepByIndex(testInstallationJob, testInstallIndex),
  );
}

function assertNoPlainPrWorkflowInstalls(workflows) {
  for (const [workflowName, workflow] of workflows) {
    if (
      !workflowHasEvent(workflow, "pull_request") &&
      !workflowHasEvent(workflow, "pull_request_target")
    ) {
      continue;
    }
    assertNoPlainNpmCi(workflow, workflowName);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectGuardFailure(name, run) {
  try {
    run();
  } catch (error) {
    if (error instanceof GuardrailFailure) {
      return;
    }
    throw error;
  }

  throw new Error(`negative workflow case unexpectedly passed: ${name}`);
}

function runNegativeWorkflowTests(testWorkflow) {
  const mutablePrWorkflow = clone(testWorkflow);
  const on = workflowOn(mutablePrWorkflow);
  on.pull_request = on.pull_request_target;
  delete on.pull_request_target;
  expectGuardFailure("PR-controlled workflow trigger", () => assertTestWorkflow(mutablePrWorkflow));

  const localAuditScriptWorkflow = clone(testWorkflow);
  const auditStep = job(localAuditScriptWorkflow, "test").steps.find((step) =>
    normalizedRun(step).includes("scripts/run-npm-audit.js"),
  );
  auditStep.run = "bash scripts/retry.sh node scripts/run-npm-audit.js";
  expectGuardFailure("PR-local audit script", () => assertTestWorkflow(localAuditScriptWorkflow));

  const envOverrideWorkflow = clone(testWorkflow);
  const envAuditStep = job(envOverrideWorkflow, "test").steps.find((step) =>
    normalizedRun(step).includes("scripts/run-npm-audit.js"),
  );
  envAuditStep.env = { ...envAuditStep.env, GITHUB_EVENT_NAME: "push" };
  expectGuardFailure("event env override", () => {
    assertNoEventEnvOverride(envOverrideWorkflow, "test workflow");
    assertTestWorkflow(envOverrideWorkflow);
  });
}

function runGuardrails() {
  const { workflow: testWorkflow } = readWorkflow(".github/workflows/test.yml");
  const { workflow: releaseWorkflow } = readWorkflow(".github/workflows/release.yml");
  const { workflow: buildExtensionWorkflow } = readWorkflow(
    ".github/workflows/build-extension.yml",
  );
  const { workflow: codeQualityWorkflow } = readWorkflow(".github/workflows/code-quality.yml");
  const { workflow: docsWorkflow } = readWorkflow(".github/workflows/docs.yml");

  const workflows = [
    ["test workflow", testWorkflow],
    ["release workflow", releaseWorkflow],
    ["build-extension workflow", buildExtensionWorkflow],
    ["code-quality workflow", codeQualityWorkflow],
    ["docs workflow", docsWorkflow],
  ];

  runNegativeWorkflowTests(testWorkflow);
  for (const [workflowName, workflow] of workflows) {
    assertNoAuditCi(workflow, workflowName);
    assertNoEventEnvOverride(workflow, workflowName);
    assertAllNpmCiPinned(workflow, workflowName);
  }
  assertNoMutableAuditScript(testWorkflow);
  assertNoPlainPrWorkflowInstalls(workflows);
  assertNoPlainNpmCi(releaseWorkflow, "release workflow");
  assertTestWorkflow(testWorkflow);
  assertBuildExtensionWorkflow(buildExtensionWorkflow);
  assertReleaseWorkflow(releaseWorkflow);
}

try {
  runGuardrails();
  console.log("Audit workflow guardrails verified.");
} catch (error) {
  console.error(
    `Audit workflow guardrail failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
