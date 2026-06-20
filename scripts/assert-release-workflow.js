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
const workflowPath = path.join(repoRoot, ".github", "workflows", "release.yml");
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
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);
const jobs = workflow.jobs ?? {};
const marketplaceSecretPattern =
  /(?:secrets\s*(?:\.\s*VSCE_KEY|\[\s*["']VSCE_KEY["']\s*\])|\bVSCE_(?:KEY|PAT)\b)/;
const repoControlledCommandPattern = /\bnpm\s+(?:ci|exec|install|run)\b|\bnpx\b|\bnode\s+scripts\//;
const marketplacePublisherPackage = JSON.parse(fs.readFileSync(publisherPackagePath, "utf8"));
const marketplacePublisherLock = JSON.parse(fs.readFileSync(publisherLockPath, "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function stringify(value) {
  return JSON.stringify(value ?? {});
}

function jobIf(jobName) {
  return String(jobs[jobName]?.if ?? "");
}

function assertJobExists(jobName) {
  assert(jobs[jobName], `release workflow is missing job: ${jobName}`);
}

function assertTimeout(jobName) {
  assertJobExists(jobName);
  assert(
    Number.isInteger(jobs[jobName]["timeout-minutes"]),
    `${jobName} must declare timeout-minutes.`,
  );
}

function jobSteps(jobName) {
  assertJobExists(jobName);
  const steps = jobs[jobName].steps;
  assert(Array.isArray(steps), `${jobName} must declare steps.`);
  return steps;
}

function stepByName(jobName, stepName) {
  const step = jobSteps(jobName).find((candidate) => candidate.name === stepName);
  assert(step, `${jobName} must include step: ${stepName}.`);
  return step;
}

function stepRun(jobName, stepName) {
  const run = stepByName(jobName, stepName).run;
  assert(typeof run === "string", `${jobName} step ${stepName} must be a run step.`);
  return run;
}

function normalizedCommand(command) {
  return command.replace(/\s+/g, " ").trim();
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

function jobNeeds(jobName) {
  const needs = jobs[jobName]?.needs ?? [];
  return Array.isArray(needs) ? needs : [needs];
}

function allRunCommands() {
  return Object.keys(jobs).flatMap((jobName) =>
    (jobs[jobName].steps ?? []).map((step) => step.run).filter((run) => typeof run === "string"),
  );
}

function assertMarketplaceSecretOnlyInPublish(workflowToCheck = workflow) {
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

function assertPublishIsReleaseOnly() {
  assertJobExists("publish");
  const publishIf = jobIf("publish");
  assert(
    publishIf.includes("startsWith(github.ref, 'refs/tags/v')"),
    "publish job must be gated to v* tag refs.",
  );
  assert(
    publishIf.includes("!contains(github.ref_name, '-')"),
    "publish job must reject prerelease tag refs.",
  );
  assert(
    jobs.publish.environment === "marketplace",
    "publish job must run in the marketplace environment.",
  );
  assert(
    jobs.publish.permissions?.actions === "read",
    "publish job must be able to read marketplace environment protection.",
  );

  assertPublishUsesIsolatedPublisher();
}

function assertPublishUsesIsolatedPublisher(workflowToCheck = workflow) {
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

  const installDependenciesRun = normalizedCommand(
    stepRunInSteps(steps, "publish", "Install dependencies"),
  );
  const installDependenciesStepIndex = stepIndexInSteps(steps, "publish", "Install dependencies");
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
  const postPublisherPreSecretRuns = steps
    .slice(installStepIndex + 1, firstSecretStepIndex)
    .map((step) => normalizedCommand(String(step.run ?? "")))
    .filter(Boolean);
  assert(
    !postPublisherPreSecretRuns.some((run) => repoControlledCommandPattern.test(run)),
    "repo-controlled commands must not run after the isolated publisher is created and before VSCE_PAT is used.",
  );
}

function assertMarketplacePublisherLockfile() {
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

function assertMarketplaceSecretStepsUseIsolatedPublisher(workflowToCheck = workflow) {
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
      step.env?.VSCE_BIN === "${{ steps.publisher.outputs.bin }}",
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

function assertReleaseSourceGate() {
  assertJobExists("verify-release-source");
  const sourceGateRun = normalizedCommand(
    stepRun("verify-release-source", "Verify tag is reachable from main"),
  );
  assert(
    /\bgit\s+merge-base\s+--is-ancestor\b/.test(sourceGateRun) &&
      sourceGateRun.includes("origin/main"),
    "verify-release-source must reject tags outside origin/main.",
  );
  assert(
    jobNeeds("build").includes("verify-release-source"),
    "build must depend on verify-release-source.",
  );
}

function assertAttestIsReleaseOnly() {
  assertJobExists("attest");
  assert(
    jobIf("attest").includes("startsWith(github.ref, 'refs/tags/v')"),
    "attest job must only run for release tag refs.",
  );
}

function assertReleaseAfterPublish() {
  assertJobExists("release");
  assert(
    jobNeeds("release").includes("publish"),
    "GitHub Release creation must depend on Marketplace publish.",
  );
  assert(
    jobIf("release").includes("needs.publish.result == 'success'"),
    "stable GitHub Release must require successful Marketplace publish.",
  );
}

function assertPublishVerifiesAttestation() {
  const attestationRun = normalizedCommand(
    stepRun("publish", "Verify VSIX build provenance attestation"),
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

function assertArtifactResolverUsage() {
  const runCommands = allRunCommands();
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

function assertPublishPreflightIgnoresLifecycleScripts(workflowToCheck = workflow) {
  const preflightJob = workflowToCheck.jobs?.["publish-preflight"];
  assert(preflightJob, "release workflow is missing job: publish-preflight");
  const steps = preflightJob.steps;
  assert(Array.isArray(steps), "publish-preflight must declare steps.");
  const installRun = normalizedCommand(
    stepRunInSteps(steps, "publish-preflight", "Install dependencies"),
  );
  assert(
    /\bnpm\s+ci\b/.test(installRun) && installRun.includes("--ignore-scripts"),
    "publish-preflight dependency install must not run package lifecycle scripts.",
  );
}

function main() {
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
    assertTimeout(jobName);
  }

  assertMarketplaceSecretOnlyInPublish();
  assertMarketplacePublisherLockfile();
  assertPublishIsReleaseOnly();
  assertMarketplaceSecretStepsUseIsolatedPublisher();
  assertReleaseSourceGate();
  assertAttestIsReleaseOnly();
  assertReleaseAfterPublish();
  assertPublishVerifiesAttestation();
  assertArtifactResolverUsage();
  assertPublishPreflightIgnoresLifecycleScripts();
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
  assertMarketplacePublisherLockfile,
  assertPublishUsesIsolatedPublisher,
  assertPublishPreflightIgnoresLifecycleScripts,
  main,
  marketplaceSecretPattern,
};
