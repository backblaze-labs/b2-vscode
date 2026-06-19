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

  const verifyPatRun = normalizedCommand(stepRun("publish", "Verify Marketplace publisher token"));
  assert(
    /\bnpm\s+exec\s+--no-install\s+--\s+vsce\s+verify-pat\b/.test(verifyPatRun),
    "publish job must verify the Marketplace token with the lockfile-installed vsce binary.",
  );

  const publishRun = normalizedCommand(stepRun("publish", "Publish to VS Code Marketplace"));
  assert(
    /\bnpm\s+exec\s+--no-install\s+--\s+vsce\s+publish\b/.test(publishRun),
    "publish job must publish with the lockfile-installed vsce binary.",
  );
  assert(
    /--skip-duplicate\b/.test(publishRun),
    "publish job must tolerate already-published versions.",
  );
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
  assertMarketplaceSecretOnlyInPublish,
  main,
  marketplaceSecretPattern,
};
