#!/usr/bin/env node

/**
 * Static checks for release workflow trust boundaries. These prevent later
 * workflow edits from re-exposing Marketplace credentials or bypassing release
 * source/artifact guards.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const repoRoot = path.join(__dirname, "..");
const workflowsDirectory = path.join(repoRoot, ".github", "workflows");
const workflowPath = path.join(repoRoot, ".github", "workflows", "release.yml");
const buildExtensionWorkflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "build-extension.yml",
);
const codeQualityWorkflowPath = path.join(repoRoot, ".github", "workflows", "code-quality.yml");
const publisherPackagePath = path.join(
  repoRoot,
  ".github",
  "marketplace-publisher",
  "package.json",
);
const publisherLockPath = path.join(
  repoRoot,
  ".github",
  "marketplace-publisher",
  "package-lock.json",
);

const marketplaceSecretPattern =
  /(?:secrets\s*(?:\.\s*VSCE_KEY|\[\s*["']VSCE_KEY["']\s*\])|\bVSCE_(?:KEY|PAT)\b)/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readYamlFile(filePath) {
  return yaml.load(fs.readFileSync(filePath, "utf8"));
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadReleaseWorkflow() {
  return readYamlFile(workflowPath);
}

function loadBuildExtensionWorkflow() {
  return readYamlFile(buildExtensionWorkflowPath);
}

function loadCodeQualityWorkflow() {
  return readYamlFile(codeQualityWorkflowPath);
}

function loadGithubWorkflows() {
  return fs
    .readdirSync(workflowsDirectory)
    .filter((fileName) => /\.ya?ml$/u.test(fileName))
    .map((fileName) => ({
      name: fileName,
      workflow: readYamlFile(path.join(workflowsDirectory, fileName)),
    }));
}

function loadMarketplacePublisherPackage() {
  return readJsonFile(publisherPackagePath);
}

function loadMarketplacePublisherLock() {
  return readJsonFile(publisherLockPath);
}

function stringify(value) {
  return JSON.stringify(value ?? {});
}

function jobsFor(workflowToCheck) {
  return workflowToCheck.jobs ?? {};
}

function jobIf(workflowToCheck, jobName) {
  return String(jobsFor(workflowToCheck)[jobName]?.if ?? "");
}

function assertJobExists(workflowToCheck, jobName) {
  assert(jobsFor(workflowToCheck)[jobName], `release workflow is missing job: ${jobName}`);
}

function assertTimeout(workflowToCheck, jobName) {
  assertJobExists(workflowToCheck, jobName);
  assert(
    Number.isInteger(jobsFor(workflowToCheck)[jobName]["timeout-minutes"]),
    `${jobName} must declare timeout-minutes.`,
  );
}

function jobSteps(workflowToCheck, jobName) {
  assertJobExists(workflowToCheck, jobName);
  const steps = jobsFor(workflowToCheck)[jobName].steps;
  assert(Array.isArray(steps), `${jobName} must declare steps.`);
  return steps;
}

function stepByName(workflowToCheck, jobName, stepName) {
  const step = jobSteps(workflowToCheck, jobName).find((candidate) => candidate.name === stepName);
  assert(step, `${jobName} must include step: ${stepName}.`);
  return step;
}

function stepRun(workflowToCheck, jobName, stepName) {
  const run = stepByName(workflowToCheck, jobName, stepName).run;
  assert(typeof run === "string", `${jobName} step ${stepName} must be a run step.`);
  return run;
}

function normalizedCommand(command) {
  return command.replace(/\s+/g, " ").trim();
}

function normalizedGithubExpression(value) {
  if (typeof value !== "string") {
    return "";
  }

  const match = value.match(/^\s*\$\{\{\s*([\s\S]*?)\s*\}\}\s*$/);
  return match ? `\${{ ${match[1].trim()} }}` : value.trim();
}

function stepIndexInSteps(steps, jobName, stepName) {
  const index = steps.findIndex((candidate) => candidate.name === stepName);
  assert(index >= 0, `${jobName} must include step: ${stepName}.`);
  return index;
}

function stepRunInSteps(steps, jobName, stepName) {
  const step = steps.find((candidate) => candidate.name === stepName);
  assert(step, `${jobName} must include step: ${stepName}.`);
  assert(typeof step.run === "string", `${jobName} step ${stepName} must be a run step.`);
  return step.run;
}

function jobNeeds(workflowToCheck, jobName) {
  const needs = jobsFor(workflowToCheck)[jobName]?.needs ?? [];
  return Array.isArray(needs) ? needs : [needs];
}

function allRunCommands(workflowToCheck) {
  const jobs = jobsFor(workflowToCheck);
  return Object.keys(jobs).flatMap((jobName) =>
    (jobs[jobName].steps ?? []).map((step) => step.run).filter((run) => typeof run === "string"),
  );
}

function assertMarketplaceSecretOnlyInPublish(workflowToCheck = loadReleaseWorkflow()) {
  const workflowWithoutJobs = { ...workflowToCheck };
  delete workflowWithoutJobs.jobs;
  assert(
    !marketplaceSecretPattern.test(stringify(workflowWithoutJobs)),
    "VSCE_KEY and VSCE_PAT must not be referenced outside jobs.",
  );

  for (const [jobName, job] of Object.entries(workflowToCheck.jobs ?? {})) {
    if (jobName === "publish") {
      continue;
    }
    assert(
      !marketplaceSecretPattern.test(stringify(job)),
      `VSCE_KEY and VSCE_PAT must only be read by the publish job; found in ${jobName}.`,
    );
  }
}

function assertPublishIsReleaseOnly(workflowToCheck = loadReleaseWorkflow()) {
  assertJobExists(workflowToCheck, "publish");
  const jobs = jobsFor(workflowToCheck);
  const publishIf = jobIf(workflowToCheck, "publish");
  assert(
    publishIf.includes("startsWith(github.ref, 'refs/tags/v')"),
    "publish job must be gated to v* tag refs.",
  );
  assert(
    publishIf.includes("!contains(github.ref_name, '-')"),
    "publish job must reject prerelease tag refs.",
  );
  assert(
    publishIf.includes("github.event_name == 'workflow_dispatch'") &&
      publishIf.includes("inputs.publish == true"),
    "publish job must require an explicit manual publish=true dispatch.",
  );
  assert(
    jobs.publish.environment === "marketplace",
    "publish job must run in the marketplace environment.",
  );
  assert(
    jobs.publish.permissions?.actions === "read",
    "publish job must be able to read marketplace environment protection.",
  );

  assertPublishUsesIsolatedPublisher(workflowToCheck);
  assertMarketplacePublisherDependencyGate(workflowToCheck);
}

function assertPublishUsesIsolatedPublisher(workflowToCheck = loadReleaseWorkflow()) {
  const publishJob = workflowToCheck.jobs?.publish;
  assert(publishJob, "release workflow is missing job: publish");
  const steps = publishJob.steps;
  assert(Array.isArray(steps), "publish must declare steps.");

  const installStepIndex = stepIndexInSteps(
    steps,
    "publish",
    "Install isolated Marketplace publisher",
  );
  const installStep = steps[installStepIndex];
  assert(
    installStep.id === "publisher",
    "isolated Marketplace publisher step must expose id: publisher.",
  );
  const installRun = normalizedCommand(String(installStep.run ?? ""));
  assert(
    installRun.includes("$RUNNER_TEMP/vsce-publisher"),
    "isolated Marketplace publisher must be installed outside the repository.",
  );
  assert(
    installRun.includes(".github/marketplace-publisher/package-lock.json") &&
      /\bnpm\s+ci\b/.test(installRun) &&
      !/\bnpm\s+install\b/.test(installRun),
    "isolated Marketplace publisher must install from the committed lockfile with npm ci.",
  );
  assert(
    installRun.includes("--ignore-scripts"),
    "isolated Marketplace publisher install must not run package lifecycle scripts.",
  );
  assert(
    !installRun.includes("@vscode/vsce@"),
    "isolated Marketplace publisher must not resolve @vscode/vsce dynamically in the workflow.",
  );
  assert(
    installRun.includes('VSCE_BIN="$PUBLISHER_DIR/node_modules/.bin/vsce"') &&
      installRun.includes('test -x "$VSCE_BIN"') &&
      installRun.includes('echo "bin=$VSCE_BIN" >> "$GITHUB_OUTPUT"'),
    "isolated Marketplace publisher must export VSCE_BIN from $PUBLISHER_DIR.",
  );

  const installDependenciesRun = normalizedCommand(
    stepRunInSteps(steps, "publish", "Install dependencies without lifecycle scripts"),
  );
  const installDependenciesStepIndex = stepIndexInSteps(
    steps,
    "publish",
    "Install dependencies without lifecycle scripts",
  );
  assert(
    /\bnpm\s+ci\b/.test(installDependenciesRun) &&
      installDependenciesRun.includes("--ignore-scripts"),
    "publish job repo dependencies must be installed without lifecycle scripts.",
  );
  assert(
    installDependenciesStepIndex < installStepIndex,
    "publish job repo dependencies must be installed before the isolated Marketplace publisher is created.",
  );

  const resolveVsixStepIndex = stepIndexInSteps(
    steps,
    "publish",
    "Resolve and verify VSIX artifact",
  );
  assert(
    resolveVsixStepIndex < installStepIndex,
    "repo-controlled VSIX resolution must run before the isolated Marketplace publisher is created.",
  );

  const verifyPatRun = normalizedCommand(
    stepRunInSteps(steps, "publish", "Verify Marketplace publisher token"),
  );
  assert(
    /\benv\s+-u\s+NODE_OPTIONS\s+-u\s+NODE_PATH\s+"\$VSCE_BIN"\s+verify-pat\b/.test(verifyPatRun),
    "publish job must verify the Marketplace token with the isolated vsce binary.",
  );

  const publishRun = normalizedCommand(
    stepRunInSteps(steps, "publish", "Publish to VS Code Marketplace"),
  );
  assert(
    /\benv\s+-u\s+NODE_OPTIONS\s+-u\s+NODE_PATH\s+"\$VSCE_BIN"\s+publish\b/.test(publishRun),
    "publish job must publish with the isolated vsce binary.",
  );
  assert(
    /--skip-duplicate\b/.test(publishRun),
    "publish job must tolerate already-published versions.",
  );

  const verifyPatStepIndex = stepIndexInSteps(
    steps,
    "publish",
    "Verify Marketplace publisher token",
  );
  const publishStepIndex = stepIndexInSteps(steps, "publish", "Publish to VS Code Marketplace");
  assert(
    installStepIndex < verifyPatStepIndex && installStepIndex < publishStepIndex,
    "isolated Marketplace publisher must be installed before VSCE_PAT is exposed.",
  );

  const firstSecretStepIndex = Math.min(verifyPatStepIndex, publishStepIndex);
  const postPublisherPreSecretSteps = steps.slice(installStepIndex + 1, firstSecretStepIndex);
  assert(
    postPublisherPreSecretSteps.length === 0,
    `No step may run between the isolated publisher install and VSCE_PAT use: ${postPublisherPreSecretSteps
      .map((step) => step.name ?? "<unnamed>")
      .join(", ")}.`,
  );
}

function assertMarketplacePublisherDependencyGate(workflowToCheck = loadReleaseWorkflow()) {
  const publishJob = workflowToCheck.jobs?.publish;
  assert(publishJob, "release workflow is missing job: publish");
  const steps = publishJob.steps;
  assert(Array.isArray(steps), "publish must declare steps.");

  const gateStepIndex = stepIndexInSteps(
    steps,
    "publish",
    "Verify Marketplace publisher dependency tree",
  );
  const installStepIndex = stepIndexInSteps(
    steps,
    "publish",
    "Install isolated Marketplace publisher",
  );
  assert(
    gateStepIndex < installStepIndex,
    "Marketplace publisher dependency tree must be verified before install.",
  );

  const gateStep = steps[gateStepIndex];
  assert(
    normalizedGithubExpression(gateStep.env?.EXPECTED_PUBLISHER_PACKAGE_SHA256) ===
      "${{ vars.MARKETPLACE_PUBLISHER_PACKAGE_SHA256 }}",
    "Marketplace publisher package hash must come from protected environment variables.",
  );
  assert(
    normalizedGithubExpression(gateStep.env?.EXPECTED_PUBLISHER_LOCK_SHA256) ===
      "${{ vars.MARKETPLACE_PUBLISHER_LOCK_SHA256 }}",
    "Marketplace publisher lockfile hash must come from protected environment variables.",
  );

  const gateRun = normalizedCommand(String(gateStep.run ?? ""));
  assert(
    gateRun.includes("EXPECTED_PUBLISHER_PACKAGE_SHA256") &&
      gateRun.includes("EXPECTED_PUBLISHER_LOCK_SHA256") &&
      gateRun.includes(".github/marketplace-publisher/package.json") &&
      gateRun.includes(".github/marketplace-publisher/package-lock.json") &&
      gateRun.includes("sha256sum --check --strict"),
    "Marketplace publisher dependency gate must verify package and lockfile SHA-256 values.",
  );
}

function assertMarketplacePublisherLockfile(
  marketplacePublisherPackage = loadMarketplacePublisherPackage(),
  marketplacePublisherLock = loadMarketplacePublisherLock(),
) {
  assert(
    marketplacePublisherPackage.dependencies?.["@vscode/vsce"] === "3.7.1",
    "Marketplace publisher package must pin @vscode/vsce exactly.",
  );
  const rootPackage = marketplacePublisherLock.packages?.[""];
  const vscePackage = marketplacePublisherLock.packages?.["node_modules/@vscode/vsce"];
  assert(
    rootPackage?.dependencies?.["@vscode/vsce"] === "3.7.1",
    "Marketplace publisher lockfile root must pin @vscode/vsce exactly.",
  );
  assert(
    vscePackage?.version === "3.7.1" &&
      typeof vscePackage.integrity === "string" &&
      vscePackage.integrity.startsWith("sha512-"),
    "Marketplace publisher lockfile must include @vscode/vsce 3.7.1 integrity.",
  );
}

function assertMarketplaceSecretStepsUseIsolatedPublisher(workflowToCheck = loadReleaseWorkflow()) {
  const publishJob = workflowToCheck.jobs?.publish;
  assert(publishJob, "release workflow is missing job: publish");
  const steps = publishJob.steps;
  assert(Array.isArray(steps), "publish must declare steps.");

  const secretSteps = steps.filter((step) => marketplaceSecretPattern.test(stringify(step.env)));
  assert(secretSteps.length > 0, "publish job must expose VSCE_PAT only to publisher steps.");

  for (const step of secretSteps) {
    const stepName = step.name ?? "<unnamed>";
    const run = normalizedCommand(String(step.run ?? ""));
    assert(
      normalizedGithubExpression(step.env?.VSCE_BIN) === "${{ steps.publisher.outputs.bin }}",
      `${stepName} must invoke the isolated publisher binary when VSCE_PAT is in scope.`,
    );
    assert(
      run.includes('cd "$RUNNER_TEMP"'),
      `${stepName} must leave the repository before invoking vsce with VSCE_PAT.`,
    );
    assert(
      /\benv\s+-u\s+NODE_OPTIONS\s+-u\s+NODE_PATH\s+"\$VSCE_BIN"\s+(verify-pat|publish)\b/.test(
        run,
      ),
      `${stepName} must invoke the isolated vsce binary with repo Node hooks cleared.`,
    );
    assert(
      !/\bnpm\s+(?:ci|exec|install|run)\b|\bnpx\b|node_modules\/\.bin\/vsce/.test(run),
      `${stepName} must not execute repo-controlled dependencies while VSCE_PAT is in scope.`,
    );
  }
}

function assertReleaseSourceGate(workflowToCheck = loadReleaseWorkflow()) {
  assertJobExists(workflowToCheck, "verify-release-source");
  const sourceGateRun = normalizedCommand(
    stepRun(workflowToCheck, "verify-release-source", "Verify tag is reachable from main"),
  );
  assert(
    /\bgit\s+merge-base\s+--is-ancestor\b/.test(sourceGateRun) &&
      sourceGateRun.includes("origin/main"),
    "verify-release-source must reject tags outside origin/main.",
  );
  assert(
    jobNeeds(workflowToCheck, "build").includes("verify-release-source"),
    "build must depend on verify-release-source.",
  );
}

function assertAttestIsReleaseOnly(workflowToCheck = loadReleaseWorkflow()) {
  assertJobExists(workflowToCheck, "attest");
  assert(
    jobIf(workflowToCheck, "attest").includes("startsWith(github.ref, 'refs/tags/v')"),
    "attest job must only run for release tag refs.",
  );
}

function assertReleaseCodeqlDoesNotUploadSarif(workflowToCheck = loadReleaseWorkflow()) {
  const analyzeStep = stepByName(workflowToCheck, "sast", "Analyze with CodeQL");
  assert(
    analyzeStep.with?.upload === "never",
    "release CodeQL SAST must not upload SARIF while repository CodeQL default setup is enabled.",
  );
}

function assertPostBuildReleaseJobsGuardSkippedNeeds(workflowToCheck = loadReleaseWorkflow()) {
  const smokeIf = jobIf(workflowToCheck, "package-install-smoke");
  assert(
    smokeIf.includes("always()") && smokeIf.includes("needs.build.result == 'success'"),
    "package-install-smoke must explicitly run after a successful build even when optional upstream jobs were skipped.",
  );

  const preflightIf = jobIf(workflowToCheck, "publish-preflight");
  assert(
    preflightIf.includes("always()") &&
      preflightIf.includes("needs.build.result == 'success'") &&
      preflightIf.includes("needs.package-install-smoke.result == 'success'") &&
      preflightIf.includes("github.event_name == 'workflow_dispatch'"),
    "publish-preflight must explicitly guard build and installed-smoke success, and only run for manual dispatch.",
  );

  const attestIf = jobIf(workflowToCheck, "attest");
  assert(
    attestIf.includes("always()") &&
      attestIf.includes("needs.build.result == 'success'") &&
      attestIf.includes("needs.package-install-smoke.result == 'success'"),
    "attest must explicitly guard build and installed-smoke success.",
  );
}

function assertReleasePublishGate(workflowToCheck = loadReleaseWorkflow()) {
  assertJobExists(workflowToCheck, "release");
  assert(
    jobNeeds(workflowToCheck, "release").includes("publish"),
    "GitHub Release creation must wait for the Marketplace publish job outcome.",
  );
  const releaseIf = jobIf(workflowToCheck, "release");
  assert(
    releaseIf.includes("!contains(github.ref_name, '-')") &&
      releaseIf.includes("needs.publish.result == 'success'"),
    "stable GitHub Release must be allowed after successful Marketplace publish.",
  );
  assert(
    releaseIf.includes("!contains(github.ref_name, '-')") &&
      releaseIf.includes("needs.publish.result == 'skipped'"),
    "stable GitHub Release must be allowed when Marketplace publish is skipped.",
  );
  assert(
    releaseIf.includes("contains(github.ref_name, '-')") &&
      releaseIf.includes("needs.publish.result == 'skipped'"),
    "prerelease GitHub Release must be allowed when Marketplace publish is skipped.",
  );
}

function assertPublishVerifiesAttestation(workflowToCheck = loadReleaseWorkflow()) {
  const jobs = jobsFor(workflowToCheck);
  const attestationRun = normalizedCommand(
    stepRun(workflowToCheck, "publish", "Verify VSIX build provenance attestation"),
  );
  assert(
    /\bgh\s+attestation\s+verify\b/.test(attestationRun),
    "publish job must verify the VSIX build provenance attestation before publishing.",
  );
  assert(
    jobs.publish.permissions?.attestations === "read",
    "publish job must be able to read build provenance attestations.",
  );
}

function assertArtifactResolverUsage(workflowToCheck = loadReleaseWorkflow()) {
  const runCommands = allRunCommands(workflowToCheck);
  assert(
    runCommands.some((command) => command.includes("scripts/resolve-vsix-artifact.js")),
    "release workflow must use the deterministic VSIX resolver.",
  );
  assert(
    !runCommands.some((command) =>
      /find\s+\.\/vsix-artifacts[\s\S]*-name[\s\S]*\.vsix/.test(command),
    ),
    "release workflow must not select VSIX artifacts with find | head.",
  );
  assert(
    runCommands.some((command) => command.includes("--verify-checksum")),
    "release workflow must verify VSIX transport checksums before downstream use.",
  );
}

function assertReleaseInstallsIgnoreLifecycleScripts(workflowToCheck = loadReleaseWorkflow()) {
  for (const [jobName, job] of Object.entries(workflowToCheck.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") {
        continue;
      }
      for (const line of step.run.split(/\r?\n/u)) {
        if (/\bnpm\s+ci\b/.test(line)) {
          assert(
            line.includes("--ignore-scripts"),
            `${jobName} step ${step.name ?? "<unnamed>"} must use npm ci --ignore-scripts.`,
          );
        }
      }
    }
  }
}

function assertWorkflowInstallsIgnoreLifecycleScripts(workflowToCheck, workflowName = "workflow") {
  for (const [jobName, job] of Object.entries(workflowToCheck.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== "string") {
        continue;
      }
      for (const line of step.run.split(/\r?\n/u)) {
        if (/\bnpm\s+(?:ci|install)\b/.test(line)) {
          assert(
            line.includes("--ignore-scripts"),
            `${workflowName} ${jobName} step ${step.name ?? "<unnamed>"} must use npm ci --ignore-scripts or npm install --ignore-scripts.`,
          );
        }
      }
    }
  }
}

function assertGithubWorkflowInstallsIgnoreLifecycleScripts(workflows = loadGithubWorkflows()) {
  for (const { name, workflow: workflowToCheck } of workflows) {
    assertWorkflowInstallsIgnoreLifecycleScripts(workflowToCheck, name);
  }
}

function assertPublishPreflightIgnoresLifecycleScripts(workflowToCheck = loadReleaseWorkflow()) {
  const preflightJob = workflowToCheck.jobs?.["publish-preflight"];
  assert(preflightJob, "release workflow is missing job: publish-preflight");
  const steps = preflightJob.steps;
  assert(Array.isArray(steps), "publish-preflight must declare steps.");
  const installRun = normalizedCommand(
    stepRunInSteps(steps, "publish-preflight", "Install dependencies without lifecycle scripts"),
  );
  assert(
    /\bnpm\s+ci\b/.test(installRun) && installRun.includes("--ignore-scripts"),
    "publish-preflight dependency install must not run package lifecycle scripts.",
  );
}

function eventPaths(workflowToCheck, eventName) {
  const onConfig = workflowToCheck.on ?? {};
  const eventConfig = onConfig[eventName];
  return Array.isArray(eventConfig?.paths) ? eventConfig.paths : [];
}

function assertCodeQualityRunsReleaseGuard(workflowToCheck = loadCodeQualityWorkflow()) {
  const qualityJob = workflowToCheck.jobs?.quality;
  assert(qualityJob, "code-quality workflow is missing job: quality");
  const steps = qualityJob.steps;
  assert(Array.isArray(steps), "code-quality quality job must declare steps.");

  const runCommands = steps
    .map((step) => (typeof step.run === "string" ? normalizedCommand(step.run) : ""))
    .filter(Boolean);
  assert(
    runCommands.some(
      (run) =>
        /\bnpm\s+run\s+check\b/.test(run) || /\bnpm\s+run\s+check:release-workflow\b/.test(run),
    ),
    "code-quality workflow must run npm run check or npm run check:release-workflow.",
  );

  for (const eventName of ["push", "pull_request"]) {
    const paths = eventPaths(workflowToCheck, eventName);
    for (const requiredPath of [
      ".github/workflows/build-extension.yml",
      ".github/workflows/release.yml",
      ".github/marketplace-publisher/**",
      "scripts/assert-dependency-vsix-diff.js",
      "scripts/assert-release-workflow.js",
    ]) {
      assert(
        paths.includes(requiredPath),
        `code-quality ${eventName} paths must include ${requiredPath}.`,
      );
    }
  }
}

function assertPullRequestOnlyStep(step, stepName) {
  assert(
    String(step.if ?? "").includes("github.event_name == 'pull_request'"),
    `${stepName} must only run for pull_request events.`,
  );
}

function assertDependencyVsixDiffConditionalStep(step, stepName) {
  assertPullRequestOnlyStep(step, stepName);
  assert(
    String(step.if ?? "").includes("steps.dependency-vsix-diff.outputs.should_check == 'true'"),
    `${stepName} must only run when the dependency VSIX diff gate is required.`,
  );
}

function assertDependencyVsixDiffGate(workflowToCheck = loadBuildExtensionWorkflow()) {
  const steps = jobSteps(workflowToCheck, "build");
  const recordChangedFilesIndex = stepIndexInSteps(steps, "build", "Record changed files");
  const evaluateGateIndex = stepIndexInSteps(steps, "build", "Evaluate dependency VSIX diff gate");
  const checkoutBaseIndex = stepIndexInSteps(
    steps,
    "build",
    "Checkout base source for artifact diff",
  );
  const packageHeadIndex = stepIndexInSteps(steps, "build", "Package VSIX");
  const packageBaseIndex = stepIndexInSteps(
    steps,
    "build",
    "Package base VSIX for dependency diff",
  );
  const gateIndex = stepIndexInSteps(
    steps,
    "build",
    "Check dependency-only VSIX generated-code diff",
  );

  assert(
    recordChangedFilesIndex < evaluateGateIndex && evaluateGateIndex < checkoutBaseIndex,
    "dependency VSIX diff gate must decide before checking out base source.",
  );
  assert(
    checkoutBaseIndex < packageBaseIndex && evaluateGateIndex < gateIndex,
    "dependency VSIX diff gate must collect base source and decide before comparing artifacts.",
  );
  assert(
    packageHeadIndex < gateIndex && packageBaseIndex < gateIndex,
    "dependency VSIX diff gate must run after packaging both head and base VSIX artifacts.",
  );

  const checkoutBaseStep = steps[checkoutBaseIndex];
  assertDependencyVsixDiffConditionalStep(
    checkoutBaseStep,
    "Checkout base source for artifact diff",
  );
  assert(
    normalizedGithubExpression(checkoutBaseStep.with?.ref) ===
      "${{ github.event.pull_request.base.sha }}",
    "base artifact checkout must use the pull request base SHA.",
  );
  assert(
    checkoutBaseStep.with?.path === "base-source",
    "base artifact checkout must use the base-source directory.",
  );

  const recordChangedFilesStep = steps[recordChangedFilesIndex];
  assertPullRequestOnlyStep(recordChangedFilesStep, "Record changed files");
  const recordChangedFilesRun = normalizedCommand(String(recordChangedFilesStep.run ?? ""));
  assert(
    recordChangedFilesRun.includes("git diff --name-only") &&
      recordChangedFilesRun.includes("$RUNNER_TEMP/changed-files.txt"),
    "dependency VSIX diff gate must record changed files from the PR base.",
  );

  const evaluateGateStep = steps[evaluateGateIndex];
  assertPullRequestOnlyStep(evaluateGateStep, "Evaluate dependency VSIX diff gate");
  assert(
    evaluateGateStep.id === "dependency-vsix-diff",
    "dependency VSIX diff gate decision step must expose id: dependency-vsix-diff.",
  );
  const evaluateGateRun = normalizedCommand(String(evaluateGateStep.run ?? ""));
  assert(
    evaluateGateRun.includes("shouldCheckDependencyVsixDiff") &&
      evaluateGateRun.includes("GITHUB_OUTPUT") &&
      evaluateGateRun.includes("should_check"),
    "dependency VSIX diff gate must publish a should_check output from changed files.",
  );

  const packageBaseStep = steps[packageBaseIndex];
  assertDependencyVsixDiffConditionalStep(packageBaseStep, "Package base VSIX for dependency diff");
  assert(
    packageBaseStep["working-directory"] === "base-source",
    "base VSIX packaging must run in the base-source checkout.",
  );
  const packageBaseRun = normalizedCommand(String(packageBaseStep.run ?? ""));
  assert(
    /\bnpm\s+ci\b/.test(packageBaseRun) &&
      packageBaseRun.includes("--ignore-scripts") &&
      /\bnpm\s+run\s+vsix\b/.test(packageBaseRun),
    "base VSIX packaging must install locked dependencies without lifecycle scripts before packaging.",
  );

  const gateStep = steps[gateIndex];
  assertDependencyVsixDiffConditionalStep(
    gateStep,
    "Check dependency-only VSIX generated-code diff",
  );
  const gateRun = normalizedCommand(String(gateStep.run ?? ""));
  assert(
    gateRun.includes("scripts/assert-dependency-vsix-diff.js") &&
      gateRun.includes("--base") &&
      gateRun.includes("--head") &&
      gateRun.includes("--changed-files") &&
      gateRun.includes("$RUNNER_TEMP/changed-files.txt"),
    "build-extension workflow must compare base and head generated VSIX entries for dependency PRs.",
  );

  for (const eventName of ["push", "pull_request"]) {
    const paths = eventPaths(workflowToCheck, eventName);
    for (const requiredPath of [
      ".github/vsix-generated-diff-allowlist.json",
      "package-lock.json",
      "package.json",
      "scripts/assert-dependency-vsix-diff.js",
    ]) {
      assert(
        paths.includes(requiredPath),
        `build-extension ${eventName} paths must include ${requiredPath}.`,
      );
    }
  }
}

function main() {
  const workflow = loadReleaseWorkflow();
  const buildExtensionWorkflow = loadBuildExtensionWorkflow();
  const codeQualityWorkflow = loadCodeQualityWorkflow();
  const marketplacePublisherPackage = loadMarketplacePublisherPackage();
  const marketplacePublisherLock = loadMarketplacePublisherLock();

  for (const jobName of [
    "verify-release-source",
    "quality",
    "test",
    "audit",
    "sast",
    "build",
    "package-install-smoke",
    "attest",
    "publish-preflight",
    "publish",
    "release",
  ]) {
    assertTimeout(workflow, jobName);
  }

  assertMarketplaceSecretOnlyInPublish(workflow);
  assertMarketplacePublisherLockfile(marketplacePublisherPackage, marketplacePublisherLock);
  assertPublishIsReleaseOnly(workflow);
  assertMarketplaceSecretStepsUseIsolatedPublisher(workflow);
  assertReleaseSourceGate(workflow);
  assertAttestIsReleaseOnly(workflow);
  assertReleaseCodeqlDoesNotUploadSarif(workflow);
  assertPostBuildReleaseJobsGuardSkippedNeeds(workflow);
  assertReleasePublishGate(workflow);
  assertPublishVerifiesAttestation(workflow);
  assertArtifactResolverUsage(workflow);
  assertReleaseInstallsIgnoreLifecycleScripts(workflow);
  assertPublishPreflightIgnoresLifecycleScripts(workflow);
  assertDependencyVsixDiffGate(buildExtensionWorkflow);
  assertCodeQualityRunsReleaseGuard(codeQualityWorkflow);
  assertGithubWorkflowInstallsIgnoreLifecycleScripts();
}

if (require.main === module) {
  try {
    main();
    console.log("Release workflow trust-boundary checks passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  assertMarketplaceSecretStepsUseIsolatedPublisher,
  assertMarketplaceSecretOnlyInPublish,
  assertMarketplacePublisherDependencyGate,
  assertMarketplacePublisherLockfile,
  assertPublishUsesIsolatedPublisher,
  assertPublishPreflightIgnoresLifecycleScripts,
  assertReleaseInstallsIgnoreLifecycleScripts,
  assertReleaseCodeqlDoesNotUploadSarif,
  assertPostBuildReleaseJobsGuardSkippedNeeds,
  assertReleasePublishGate,
  assertWorkflowInstallsIgnoreLifecycleScripts,
  assertGithubWorkflowInstallsIgnoreLifecycleScripts,
  assertCodeQualityRunsReleaseGuard,
  assertDependencyVsixDiffGate,
  loadBuildExtensionWorkflow,
  loadReleaseWorkflow,
  main,
  marketplaceSecretPattern,
};
