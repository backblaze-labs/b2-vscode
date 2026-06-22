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

function assertNoPullRequestTargetEvent(workflow, workflowName) {
  assert(
    !workflowHasEvent(workflow, "pull_request_target"),
    `${workflowName} must not use pull_request_target when it executes PR code.`,
  );
}

function assertNoPullRequestEvent(workflow, workflowName) {
  assert(
    !workflowHasEvent(workflow, "pull_request"),
    `${workflowName} must not use pull_request when it contains trusted pull_request_target audit code.`,
  );
}

function assertEventHasNoPathFilters(workflow, eventName, workflowName) {
  const config = eventConfig(workflow, eventName);
  assert(config !== undefined, `${workflowName} must run on ${eventName}.`);
  assert(
    config.paths === undefined && config["paths-ignore"] === undefined,
    `${eventName} must not use path filters because required checks must report on every PR.`,
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
    ({ run }) => /\bnpm\s+ci\b/.test(run) && !hasTrustedNpmInstallConfig(run),
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

function hasTrustedNpmInstallConfig(command) {
  return (
    hasTokens(command, ["--registry=https://registry.npmjs.org/", "--userconfig=/dev/null"]) &&
    (command.includes("--globalconfig=/tmp/b2-vscode-empty-npm-globalconfig") ||
      command.includes('--globalconfig="$EMPTY_NPM_GLOBALCONFIG"'))
  );
}

function assertTrustedNpmInstallConfig(label, command) {
  assert(
    hasTrustedNpmInstallConfig(command),
    `${label} must pin npm registry, userconfig, and globalconfig.`,
  );
}

function assertAuditStep(label, step, options = {}) {
  const command = normalizedRun(step);
  assert(
    !command.includes("${{"),
    `${label} must not use GitHub template expansion inside run commands.`,
  );
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
  if (options.trustedPolicy) {
    assert(
      command.includes("--trusted-policy") &&
        command.includes("$GITHUB_WORKSPACE/trusted-source/audit-policy.jsonc"),
      `${label} must pass the protected base policy file to the trusted audit gate.`,
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

function assertDirectInstallStep(label, step) {
  const command = normalizedRun(step);
  assert(
    /\bnpm\s+ci\b/.test(command) && command.includes("--ignore-scripts"),
    `${label} must install with lifecycle scripts disabled.`,
  );
  assertTrustedNpmInstallConfig(label, command);
}

function assertSignatureStep(label, step, options = {}) {
  if (options.skipsPrTarget) {
    assert(
      String(step.if ?? "").includes("github.event_name != 'pull_request_target'"),
      `${label} must be skipped for pull_request_target.`,
    );
  } else {
    assert(
      step.if === undefined,
      `${label} must run unconditionally; break-glass may skip only advisory audits.`,
    );
  }
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

function checkoutStepIndex(jobConfig, label, checkoutPath) {
  return stepIndex(
    jobConfig,
    label,
    (step) =>
      String(step.uses ?? "").startsWith("actions/checkout@") && step.with?.path === checkoutPath,
  );
}

function assertTrustedCheckout(jobConfig, workflowName) {
  const trustedIndex = checkoutStepIndex(
    jobConfig,
    `${workflowName} trusted source checkout`,
    "trusted-source",
  );
  const trustedStep = stepByIndex(jobConfig, trustedIndex);

  assert(
    trustedStep.with?.repository === "${{ github.repository }}",
    `${workflowName} trusted checkout must come from the base repository.`,
  );
  assert(
    String(trustedStep.with?.ref ?? "").includes("github.event.pull_request.base.sha") &&
      String(trustedStep.with?.ref ?? "").includes("github.sha"),
    `${workflowName} trusted checkout must select the protected base SHA for PRs.`,
  );

  return trustedIndex;
}

function assertPrTargetSourceCheckoutIsSkipped(jobConfig, workflowName) {
  const sourceIndex = checkoutStepIndex(jobConfig, `${workflowName} source checkout`, "source");
  const sourceStep = stepByIndex(jobConfig, sourceIndex);
  assert(
    String(sourceStep.if ?? "").includes("github.event_name != 'pull_request_target'"),
    `${workflowName} source checkout must be skipped for pull_request_target.`,
  );
  assert(
    sourceStep.with?.repository === undefined && sourceStep.with?.ref === undefined,
    `${workflowName} must not checkout the PR head in pull_request_target.`,
  );
  return sourceIndex;
}

function assertUnprivilegedSourceCheckout(jobConfig, workflowName) {
  const sourceIndex = checkoutStepIndex(jobConfig, `${workflowName} source checkout`, "source");
  const sourceStep = stepByIndex(jobConfig, sourceIndex);
  assert(
    sourceStep.with?.repository === undefined && sourceStep.with?.ref === undefined,
    `${workflowName} source checkout must use the unprivileged event ref.`,
  );
  assert(
    sourceStep.if === undefined,
    `${workflowName} source checkout must run for every unprivileged event.`,
  );
  return sourceIndex;
}

function assertPrMetadataDownload(jobConfig, workflowName) {
  const downloadIndex = stepIndex(jobConfig, `${workflowName} PR metadata download`, (step) =>
    String(step.uses ?? "").startsWith("actions/github-script@"),
  );
  const step = stepByIndex(jobConfig, downloadIndex);
  const script = String(step.with?.script ?? "");
  assert(
    String(step.if ?? "").includes("github.event_name == 'pull_request_target'"),
    `${workflowName} PR metadata download must run only for pull_request_target.`,
  );
  assert(
    script.includes("getContentWithRetry") && script.includes("retryableStatuses"),
    `${workflowName} PR metadata download must retry transient GitHub API failures.`,
  );
  assert(
    script.includes("getBlobWithRetry") &&
      script.includes("github.rest.git.getBlob") &&
      script.includes("data.encoding === 'none' || !data.content"),
    `${workflowName} PR metadata download must fall back to git blobs for large metadata files.`,
  );
  assert(
    script.includes("'npm-shrinkwrap.json'") &&
      script.includes("npm-shrinkwrap.json is not supported"),
    `${workflowName} PR metadata download must reject npm-shrinkwrap.json.`,
  );
  assert(
    script.includes("'.npmrc'") && script.includes(".npmrc is not supported"),
    `${workflowName} PR metadata download must reject .npmrc.`,
  );
  for (const requiredFile of [
    ".github/CODEOWNERS",
    ".github/workflows/build-extension.yml",
    ".github/workflows/code-quality.yml",
    ".github/workflows/docs.yml",
    ".github/workflows/pr-tests.yml",
    ".github/workflows/release.yml",
    ".github/workflows/test.yml",
    "audit-policy.jsonc",
    "package.json",
    "package-lock.json",
  ]) {
    assert(
      script.includes(`'${requiredFile}'`),
      `${workflowName} PR metadata download must include ${requiredFile}.`,
    );
  }
  return downloadIndex;
}

function assertSetupNodeDoesNotCache(label, step) {
  assert(
    step.with?.cache === undefined && step.with?.["cache-dependency-path"] === undefined,
    `${label} must not enable dependency caching.`,
  );
}

function assertRunsInSource(label, step) {
  assert(step["working-directory"] === "source", `${label} must run in the source directory.`);
}

function assertRunsInTrustedSource(label, step) {
  assert(
    step["working-directory"] === "trusted-source",
    `${label} must run in the trusted source checkout.`,
  );
}

function assertHasTimeout(label, config) {
  assert(
    Number.isInteger(config?.["timeout-minutes"]) && config["timeout-minutes"] > 0,
    `${label} must declare timeout-minutes.`,
  );
}

function assertTestWorkflow(testWorkflow) {
  assert(
    workflowHasEvent(testWorkflow, "schedule"),
    "test workflow must include a scheduled audit run.",
  );
  assert(workflowHasEvent(testWorkflow, "push"), "test workflow must run on push.");
  assertNoPullRequestEvent(testWorkflow, "test workflow");
  assertEventHasNoPathFilters(testWorkflow, "pull_request_target", "test workflow");

  for (const targetPath of [
    "README.md",
    "SECURITY.md",
    "audit-policy.jsonc",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    ".npmrc",
    "scripts/audit-policy.js",
    "scripts/run-npm-audit.js",
    "scripts/retry.sh",
    "scripts/npm-command.js",
    ".github/workflows/build-extension.yml",
    ".github/workflows/code-quality.yml",
    ".github/workflows/docs.yml",
    ".github/workflows/pr-tests.yml",
    ".github/workflows/release.yml",
    ".github/workflows/test.yml",
  ]) {
    assertPathFilterCovers(testWorkflow, "push", targetPath);
  }

  const auditJob = job(testWorkflow, "dependency-audit");
  assert(
    auditJob.name === "Dependency Audit Gate",
    "trusted dependency audit job must have a distinct check name.",
  );

  const sourceCheckoutIndex = assertPrTargetSourceCheckoutIsSkipped(auditJob, "test workflow");
  const trustedCheckoutIndex = assertTrustedCheckout(auditJob, "test workflow");
  const metadataDownloadIndex = assertPrMetadataDownload(auditJob, "test workflow");
  const setupNodeIndex = stepIndex(auditJob, "audit node setup", (step) =>
    String(step.uses ?? "").startsWith("actions/setup-node@"),
  );
  const trustedInstallIndex = stepIndex(
    auditJob,
    "audit trusted guard install",
    (step, run) => step["working-directory"] === "trusted-source" && /\bnpm\s+ci\b/.test(run),
  );
  const installIndex = stepIndex(
    auditJob,
    "audit source install",
    (step, run) => step["working-directory"] === "source" && /\bnpm\s+ci\b/.test(run),
  );
  const lifecycleIndex = stepIndex(auditJob, "ignore-scripts guard", (_step, run) =>
    run.includes("scripts/assert-ignore-scripts-install.js"),
  );
  const policyIndex = stepIndex(auditJob, "audit policy guard", (_step, run) =>
    run.includes("scripts/assert-audit-policy.js"),
  );
  const fixtureIndex = stepIndex(auditJob, "audit gate fixture", (_step, run) =>
    run.includes("scripts/assert-audit-gate-fixture.js"),
  );
  const auditSteps = auditJob.steps
    .map((step, index) => ({ index, step, run: normalizedRun(step) }))
    .filter(({ run }) => run.includes("scripts/run-npm-audit.js"));
  assert(
    auditSteps.length === 2,
    "test workflow must have separate PR and trusted-branch audit steps.",
  );
  const prAudit = auditSteps.find(({ step }) =>
    String(step.if ?? "").includes("github.event_name == 'pull_request_target'"),
  );
  const trustedBranchAudit = auditSteps.find(({ step }) =>
    String(step.if ?? "").includes("github.event_name != 'pull_request_target'"),
  );
  assert(prAudit, "test workflow must keep a pull_request_target audit step.");
  assert(trustedBranchAudit, "test workflow must keep a non-pull_request_target audit step.");
  const prAuditIndex = prAudit.index;
  const trustedBranchAuditIndex = trustedBranchAudit.index;
  const signatureIndex = stepIndex(auditJob, "dependency signature verification", (_step, run) =>
    /\bnpm\s+audit\s+signatures\b/.test(run),
  );
  const workflowGuardIndex = stepIndex(auditJob, "audit workflow guard", (_step, run) =>
    run.includes("scripts/assert-audit-workflow.js"),
  );

  assertSetupNodeDoesNotCache("audit node setup", stepByIndex(auditJob, setupNodeIndex));
  assert(sourceCheckoutIndex < setupNodeIndex, "test source checkout must run before setup.");
  assert(trustedCheckoutIndex < setupNodeIndex, "test trusted checkout must run before setup.");
  assert(
    metadataDownloadIndex < installIndex,
    "test workflow must download PR metadata before installing source dependencies.",
  );
  assert(setupNodeIndex < trustedInstallIndex, "test workflow must setup Node before installing.");
  assert(setupNodeIndex < installIndex, "test workflow must setup Node before source install.");
  assert(
    trustedInstallIndex < workflowGuardIndex,
    "workflow guard imports trusted YAML tooling and must run after trusted dependency install.",
  );
  assert(lifecycleIndex < installIndex, "ignore-scripts guard must run before source install.");
  assert(
    installIndex < trustedBranchAuditIndex,
    "test workflow must install source dependencies before trusted-branch auditing.",
  );
  for (const [label, index] of [
    ["PR audit", prAuditIndex],
    ["trusted-branch audit", trustedBranchAuditIndex],
  ]) {
    assert(policyIndex < index, `test workflow must validate policy before ${label}.`);
    assert(fixtureIndex < index, `test workflow must run fixture before ${label}.`);
  }
  assert(
    trustedBranchAuditIndex < signatureIndex,
    "test workflow must audit before verifying signatures.",
  );
  assert(
    signatureIndex < workflowGuardIndex,
    "workflow guard imports installed YAML tooling and must run after signature verification.",
  );

  assertInstallStep("test trusted guard install step", stepByIndex(auditJob, trustedInstallIndex));
  assertInstallStep("test source install step", stepByIndex(auditJob, installIndex), {
    trusted: true,
  });
  assert(
    String(stepByIndex(auditJob, installIndex).if ?? "").includes(
      "github.event_name != 'pull_request_target'",
    ),
    "test source install step must be skipped for pull_request_target.",
  );
  assertFixtureStep("test audit fixture step", stepByIndex(auditJob, fixtureIndex));
  assertAuditStep("test PR audit step", stepByIndex(auditJob, prAuditIndex), {
    trustedPolicy: true,
  });
  assertAuditStep("test trusted-branch audit step", stepByIndex(auditJob, trustedBranchAuditIndex));
  assertSignatureStep("test signature step", stepByIndex(auditJob, signatureIndex), {
    trusted: true,
    skipsPrTarget: true,
  });
  for (const [label, index] of [
    ["test trusted guard install step", trustedInstallIndex],
    ["test ignore-scripts guard step", lifecycleIndex],
    ["test audit fixture step", fixtureIndex],
    ["test PR audit step", prAuditIndex],
    ["test trusted-branch audit step", trustedBranchAuditIndex],
    ["test workflow guard step", workflowGuardIndex],
  ]) {
    assertRunsInTrustedSource(label, stepByIndex(auditJob, index));
  }
  for (const [label, index] of [
    ["test source install step", installIndex],
    ["test signature step", signatureIndex],
  ]) {
    assertRunsInSource(label, stepByIndex(auditJob, index));
  }
}

function assertPrTestsWorkflow(prTestsWorkflow) {
  assertEventHasNoPathFilters(prTestsWorkflow, "pull_request", "PR tests workflow");
  assertNoPullRequestTargetEvent(prTestsWorkflow, "PR tests workflow");

  const testJob = job(prTestsWorkflow, "vscode-tests");
  assert(
    testJob.name === "VS Code Extension Tests",
    "unprivileged test job must keep the required VS Code Extension Tests check name.",
  );
  assert(
    testJob.if === undefined,
    "VS Code Extension Tests job must run for every pull_request event.",
  );
  assertHasTimeout("VS Code Extension Tests job", testJob);
  const testSourceCheckoutIndex = assertUnprivilegedSourceCheckout(testJob, "VS Code test job");
  const testSetupNodeIndex = stepIndex(testJob, "VS Code test node setup", (step) =>
    String(step.uses ?? "").startsWith("actions/setup-node@"),
  );
  const testInstallIndex = stepIndex(testJob, "VS Code test source install", (_step, run) =>
    /\bnpm\s+ci\b/.test(run),
  );
  const compileIndex = stepIndex(testJob, "VS Code test compile", (_step, run) =>
    run.includes("npm run compile"),
  );
  const lintIndex = stepIndex(testJob, "VS Code test lint", (_step, run) =>
    run.includes("npm run lint"),
  );
  const testRunIndex = stepIndex(testJob, "VS Code tests", (_step, run) =>
    run.includes("xvfb-run -a npm test"),
  );

  assertSetupNodeDoesNotCache("VS Code test node setup", stepByIndex(testJob, testSetupNodeIndex));
  assert(
    testSourceCheckoutIndex < testSetupNodeIndex,
    "VS Code test source checkout must run before setup.",
  );
  assert(testSetupNodeIndex < testInstallIndex, "VS Code tests must setup Node before install.");
  assert(testInstallIndex < compileIndex, "VS Code tests must install before compiling.");
  assert(compileIndex < lintIndex, "VS Code tests must compile before linting.");
  assert(lintIndex < testRunIndex, "VS Code tests must lint before running tests.");
  assertDirectInstallStep("VS Code test install step", stepByIndex(testJob, testInstallIndex));
  for (const [label, index] of [
    ["VS Code test install step", testInstallIndex],
    ["VS Code test compile step", compileIndex],
    ["VS Code test lint step", lintIndex],
    ["VS Code test step", testRunIndex],
  ]) {
    const step = stepByIndex(testJob, index);
    assertRunsInSource(label, step);
    assertHasTimeout(label, step);
  }
  assert(
    !testJob.steps.some((step) => normalizedRun(step).includes("scripts/run-npm-audit.js")),
    "VS Code tests job must not share the trusted dependency audit implementation.",
  );
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
  assert(
    workflowHasEvent(buildWorkflow, "pull_request"),
    "build-extension workflow must run PR builds on pull_request.",
  );
  assert(workflowHasEvent(buildWorkflow, "push"), "build-extension workflow must run on push.");
  assertNoPullRequestTargetEvent(buildWorkflow, "build-extension workflow");

  const buildJob = job(buildWorkflow, "build");
  const testInstallationJob = job(buildWorkflow, "test-installation");
  assertUnprivilegedSourceCheckout(buildJob, "build-extension build job");
  assertUnprivilegedSourceCheckout(testInstallationJob, "build-extension test-installation job");

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
  const setupNodeIndex = stepIndex(buildJob, "build-extension node setup", (step) =>
    String(step.uses ?? "").startsWith("actions/setup-node@"),
  );

  assertSetupNodeDoesNotCache("build-extension node setup", stepByIndex(buildJob, setupNodeIndex));
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

  assertInstallStep("build-extension install step", stepByIndex(buildJob, installIndex));
  assertAuditStep("build-extension audit step", stepByIndex(buildJob, auditIndex));
  assertSignatureStep("build-extension signature step", stepByIndex(buildJob, signatureIndex));

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
  const testSetupNodeIndex = stepIndex(
    testInstallationJob,
    "build-extension package smoke node setup",
    (step) => String(step.uses ?? "").startsWith("actions/setup-node@"),
  );
  assertSetupNodeDoesNotCache(
    "build-extension package smoke node setup",
    stepByIndex(testInstallationJob, testSetupNodeIndex),
  );
  assertInstallStep(
    "build-extension package smoke install step",
    stepByIndex(testInstallationJob, testInstallIndex),
  );
  assertRunsInSource(
    "build-extension package smoke install step",
    stepByIndex(testInstallationJob, testInstallIndex),
  );

  const postPrCommentJob = buildWorkflow.jobs?.["post-pr-comment"];
  assert(postPrCommentJob, "build-extension workflow must keep the PR comment job.");
  assert(
    String(postPrCommentJob.if ?? "").includes("github.event_name == 'pull_request'") &&
      String(postPrCommentJob.if ?? "").includes("!github.event.pull_request.head.repo.fork"),
    "build-extension PR comment job must run only on same-repository pull_request events.",
  );
  const stickyCommentIndex = stepIndex(
    postPrCommentJob,
    "build-extension sticky PR comment",
    (step) => String(step.uses ?? "").startsWith("marocchino/sticky-pull-request-comment@"),
  );
  assert(
    stepByIndex(postPrCommentJob, stickyCommentIndex)["continue-on-error"] === true,
    "build-extension sticky PR comment must be non-blocking.",
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

function assertRawContains(text, label, snippets) {
  for (const snippet of snippets) {
    assert(text.includes(snippet), `${label} raw workflow text must include: ${snippet}`);
  }
}

function assertRawTestWorkflowText(text) {
  assertRawContains(text, "test", [
    "pull_request_target: # zizmor: ignore[dangerous-triggers] Trusted gate audits metadata only and never executes PR code.",
    "name: Dependency Audit Gate",
    "path: trusted-source",
    "path: source",
    "getContentWithRetry",
    "getBlobWithRetry",
    "github.rest.git.getBlob",
    "data.encoding === 'none' || !data.content",
    "'npm-shrinkwrap.json'",
    "npm-shrinkwrap.json is not supported by the audit gate",
    "'.npmrc'",
    ".npmrc is not supported by the audit gate",
    'node scripts/assert-audit-policy.js --repo-root "$GITHUB_WORKSPACE/source"',
    'node scripts/run-npm-audit.js --directory "$GITHUB_WORKSPACE/source" --policy "$GITHUB_WORKSPACE/source/audit-policy.jsonc" --trusted-policy "$GITHUB_WORKSPACE/trusted-source/audit-policy.jsonc"',
    "npm audit signatures --registry=https://registry.npmjs.org/",
  ]);
}

function assertRawPrTestsWorkflowText(text) {
  assertRawContains(text, "PR tests", [
    "pull_request:",
    "name: VS Code Extension Tests",
    "path: source",
    "npm run compile",
    "npm run lint",
    "xvfb-run -a npm test",
  ]);
}

function assertDependencyGateDocs() {
  const security = fs.readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
  assert(
    security.includes("signature verification runs on release and unprivileged build workflows"),
    "SECURITY.md must document that privileged PR metadata audits do not run signature verification.",
  );
  assert(
    security.includes("Branch protection must require the exact `Dependency Audit Gate`") &&
      security.includes("Pull requests that were opened before this") &&
      security.includes(".github/workflows/pr-tests.yml") &&
      security.includes("must be rebased onto"),
    "SECURITY.md must document required-check rollout and in-flight PR handling.",
  );
  assert(
    security.includes("npm-shrinkwrap.json") && security.includes("is not supported"),
    "SECURITY.md must document npm-shrinkwrap.json rejection.",
  );
}

function runNegativeRawWorkflowTests(testWorkflowText, prTestsWorkflowText) {
  expectGuardFailure("raw workflow audit command removed", () =>
    assertRawTestWorkflowText(
      testWorkflowText.replace(
        'node scripts/run-npm-audit.js --directory "$GITHUB_WORKSPACE/source" --policy "$GITHUB_WORKSPACE/source/audit-policy.jsonc" --trusted-policy "$GITHUB_WORKSPACE/trusted-source/audit-policy.jsonc"',
        'node -e "process.exit(0)"',
      ),
    ),
  );
  expectGuardFailure("raw workflow PR tests removed", () =>
    assertRawPrTestsWorkflowText(prTestsWorkflowText.replace("xvfb-run -a npm test", "true")),
  );
  expectGuardFailure("raw workflow npmrc rejection removed", () =>
    assertRawTestWorkflowText(
      testWorkflowText.replace(
        ".npmrc is not supported by the audit gate",
        "npmrc rejection removed",
      ),
    ),
  );
}

function runNegativeWorkflowTests(testWorkflow, prTestsWorkflow, buildWorkflow) {
  const mutablePrWorkflow = clone(testWorkflow);
  workflowOn(mutablePrWorkflow).pull_request = { branches: ["main"] };
  expectGuardFailure("trusted audit runs on PR-controlled workflow trigger", () =>
    assertTestWorkflow(mutablePrWorkflow),
  );

  const prTargetCheckoutWorkflow = clone(testWorkflow);
  const sourceCheckoutStep = job(prTargetCheckoutWorkflow, "dependency-audit").steps.find(
    (step) =>
      String(step.uses ?? "").startsWith("actions/checkout@") && step.with?.path === "source",
  );
  delete sourceCheckoutStep.if;
  sourceCheckoutStep.with.repository = "${{ github.event.pull_request.head.repo.full_name }}";
  sourceCheckoutStep.with.ref = "${{ github.event.pull_request.head.sha }}";
  expectGuardFailure("pull_request_target PR checkout", () =>
    assertTestWorkflow(prTargetCheckoutWorkflow),
  );

  const localAuditScriptWorkflow = clone(testWorkflow);
  const auditStep = job(localAuditScriptWorkflow, "dependency-audit").steps.find((step) =>
    normalizedRun(step).includes("scripts/run-npm-audit.js"),
  );
  auditStep["working-directory"] = "source";
  auditStep.run = "bash scripts/retry.sh node scripts/run-npm-audit.js";
  expectGuardFailure("PR-local audit script", () => assertTestWorkflow(localAuditScriptWorkflow));

  const envOverrideWorkflow = clone(testWorkflow);
  const envAuditStep = job(envOverrideWorkflow, "dependency-audit").steps.find((step) =>
    normalizedRun(step).includes("scripts/run-npm-audit.js"),
  );
  envAuditStep.env = { ...envAuditStep.env, GITHUB_EVENT_NAME: "push" };
  expectGuardFailure("event env override", () => {
    assertNoEventEnvOverride(envOverrideWorkflow, "test workflow");
    assertTestWorkflow(envOverrideWorkflow);
  });

  const skippedTestsWorkflow = clone(prTestsWorkflow);
  job(skippedTestsWorkflow, "vscode-tests").if = "github.event_name == 'push'";
  expectGuardFailure("PR test job skipped for pull_request", () =>
    assertPrTestsWorkflow(skippedTestsWorkflow),
  );

  const removedTestStepWorkflow = clone(prTestsWorkflow);
  job(removedTestStepWorkflow, "vscode-tests").steps = job(
    removedTestStepWorkflow,
    "vscode-tests",
  ).steps.filter((step) => !normalizedRun(step).includes("xvfb-run -a npm test"));
  expectGuardFailure("required PR test step removed", () =>
    assertPrTestsWorkflow(removedTestStepWorkflow),
  );

  const privilegedBuildWorkflow = clone(buildWorkflow);
  const buildOn = workflowOn(privilegedBuildWorkflow);
  buildOn.pull_request_target = buildOn.pull_request;
  delete buildOn.pull_request;
  expectGuardFailure("privileged build workflow trigger", () =>
    assertBuildExtensionWorkflow(privilegedBuildWorkflow),
  );
}

function runGuardrails() {
  const { text: testWorkflowText, workflow: testWorkflow } = readWorkflow(
    ".github/workflows/test.yml",
  );
  const { text: prTestsWorkflowText, workflow: prTestsWorkflow } = readWorkflow(
    ".github/workflows/pr-tests.yml",
  );
  const { workflow: releaseWorkflow } = readWorkflow(".github/workflows/release.yml");
  const { workflow: buildExtensionWorkflow } = readWorkflow(
    ".github/workflows/build-extension.yml",
  );
  const { workflow: codeQualityWorkflow } = readWorkflow(".github/workflows/code-quality.yml");
  const { workflow: docsWorkflow } = readWorkflow(".github/workflows/docs.yml");

  const workflows = [
    ["test workflow", testWorkflow],
    ["PR tests workflow", prTestsWorkflow],
    ["release workflow", releaseWorkflow],
    ["build-extension workflow", buildExtensionWorkflow],
    ["code-quality workflow", codeQualityWorkflow],
    ["docs workflow", docsWorkflow],
  ];

  runNegativeWorkflowTests(testWorkflow, prTestsWorkflow, buildExtensionWorkflow);
  runNegativeRawWorkflowTests(testWorkflowText, prTestsWorkflowText);
  for (const [workflowName, workflow] of workflows) {
    assertNoAuditCi(workflow, workflowName);
    assertNoEventEnvOverride(workflow, workflowName);
    assertAllNpmCiPinned(workflow, workflowName);
  }
  assertNoMutableAuditScript(testWorkflow);
  assertNoPlainPrWorkflowInstalls(workflows);
  assertNoPlainNpmCi(releaseWorkflow, "release workflow");
  assertTestWorkflow(testWorkflow);
  assertRawTestWorkflowText(testWorkflowText);
  assertPrTestsWorkflow(prTestsWorkflow);
  assertRawPrTestsWorkflowText(prTestsWorkflowText);
  assertDependencyGateDocs();
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
