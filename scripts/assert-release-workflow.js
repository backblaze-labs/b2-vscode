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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function jobText(jobName) {
  return JSON.stringify(jobs[jobName] ?? {});
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

function assertMarketplaceSecretOnlyInPublish() {
  for (const jobName of Object.keys(jobs)) {
    if (jobText(jobName).includes("secrets.VSCE_KEY")) {
      assert(
        jobName === "publish",
        `secrets.VSCE_KEY must only be read by the publish job; found in ${jobName}.`,
      );
    }
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
    jobText("publish").includes("npm exec --no-install -- vsce"),
    "publish job must use the lockfile-installed vsce binary.",
  );
  assert(
    jobText("publish").includes("--skip-duplicate"),
    "publish job must tolerate already-published versions.",
  );
}

function assertReleaseSourceGate() {
  assertJobExists("verify-release-source");
  assert(
    jobText("verify-release-source").includes("git merge-base --is-ancestor"),
    "verify-release-source must reject tags outside origin/main.",
  );
  assert(
    (jobs.build.needs ?? []).includes("verify-release-source"),
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
    (jobs.release.needs ?? []).includes("publish"),
    "GitHub Release creation must depend on Marketplace publish.",
  );
  assert(
    jobIf("release").includes("needs.publish.result == 'success'"),
    "stable GitHub Release must require successful Marketplace publish.",
  );
}

function assertArtifactResolverUsage() {
  assert(
    workflowText.includes("scripts/resolve-vsix-artifact.js"),
    "release workflow must use the deterministic VSIX resolver.",
  );
  assert(
    !workflowText.includes('find ./vsix-artifacts -name "*.vsix"'),
    "release workflow must not select VSIX artifacts with find | head.",
  );
  assert(
    workflowText.includes("--verify-checksum"),
    "release workflow must verify VSIX checksums downstream.",
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
