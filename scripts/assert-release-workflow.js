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
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);
const jobs = workflow.jobs ?? {};
const marketplaceSecretPattern =
  /(?:secrets\s*(?:\.\s*VSCE_KEY|\[\s*["']VSCE_KEY["']\s*\])|\bVSCE_(?:KEY|PAT)\b)/;

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

function stepIndexByName(jobName, stepName) {
  const index = jobSteps(jobName).findIndex((candidate) => candidate.name === stepName);
  assert(index >= 0, `${jobName} must include step: ${stepName}.`);
  return index;
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
  assertMarketplaceSecretStepsUseIsolatedPublisher();
}

function assertPublishUsesIsolatedPublisher(workflowToCheck = workflow) {
  const publishJob = workflowToCheck.jobs?.publish;
  assert(publishJob, "release workflow is missing job: publish");
  const steps = publishJob.steps;
  assert(Array.isArray(steps), "publish must declare steps.");

  const installStepIndex = stepIndexByName("publish", "Install isolated Marketplace publisher");
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
    installStep.env?.VSCE_VERSION === "3.7.1" &&
      /\bnpm\s+install\b/.test(installRun) &&
      installRun.includes("@vscode/vsce@$VSCE_VERSION"),
    "isolated Marketplace publisher must install a pinned @vscode/vsce version.",
  );
  assert(
    installRun.includes("--ignore-scripts"),
    "isolated Marketplace publisher install must not run package lifecycle scripts.",
  );

  const verifyPatRun = normalizedCommand(stepRun("publish", "Verify Marketplace publisher token"));
  assert(
    /\benv\s+-u\s+NODE_OPTIONS\s+-u\s+NODE_PATH\s+"\$VSCE_BIN"\s+verify-pat\b/.test(verifyPatRun),
    "publish job must verify the Marketplace token with the isolated vsce binary.",
  );

  const publishRun = normalizedCommand(stepRun("publish", "Publish to VS Code Marketplace"));
  assert(
    /\benv\s+-u\s+NODE_OPTIONS\s+-u\s+NODE_PATH\s+"\$VSCE_BIN"\s+publish\b/.test(publishRun),
    "publish job must publish with the isolated vsce binary.",
  );
  assert(
    /--skip-duplicate\b/.test(publishRun),
    "publish job must tolerate already-published versions.",
  );

  const verifyPatStepIndex = stepIndexByName("publish", "Verify Marketplace publisher token");
  const publishStepIndex = stepIndexByName("publish", "Publish to VS Code Marketplace");
  assert(
    installStepIndex < verifyPatStepIndex && installStepIndex < publishStepIndex,
    "isolated Marketplace publisher must be installed before VSCE_PAT is exposed.",
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
  assertPublishIsReleaseOnly();
  assertMarketplaceSecretStepsUseIsolatedPublisher();
  assertReleaseSourceGate();
  assertAttestIsReleaseOnly();
  assertReleaseAfterPublish();
  assertPublishVerifiesAttestation();
  assertArtifactResolverUsage();
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
  main,
  marketplaceSecretPattern,
};
