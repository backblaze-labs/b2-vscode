#!/usr/bin/env node

/**
 * Runs the blocking npm advisory audit with repository-owned exception policy.
 */

const path = require("path");
const { spawnSync } = require("child_process");
const {
  AUDIT_POLICY_FILE,
  collectAuditFindings,
  formatFinding,
  isAcceptedFinding,
  loadCurrentPolicy,
  parseStrictJsonPolicy,
  validateAuditPolicy,
} = require("./audit-policy");
const { npmCommand, trustedNpmConfigArgs, trustedNpmEnv } = require("./npm-command");

const repoRoot = path.join(__dirname, "..");
const AUDIT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

function failInfrastructure(message) {
  console.error(`npm audit infrastructure error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    directory: repoRoot,
    policy: path.join(repoRoot, AUDIT_POLICY_FILE),
    trustedBaseRef: undefined,
  };

  function readPathArgument(index, flag) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a path value.`);
    }
    return path.resolve(value);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--directory") {
      args.directory = readPathArgument(index, arg);
      index += 1;
    } else if (arg === "--policy") {
      args.policy = readPathArgument(index, arg);
      index += 1;
    } else if (arg === "--trusted-base-ref") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a branch name value.`);
      }
      args.trustedBaseRef = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseAuditReport(stdout, stderr, status) {
  if (!stdout.trim()) {
    return failInfrastructure(`npm audit returned no JSON output. Exit ${status}.\n${stderr}`);
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    return failInfrastructure(
      `npm audit returned invalid JSON. Exit ${status}. ${error.message}\n${stdout}\n${stderr}`,
    );
  }
}

function npmAuditScopeArgs(auditPolicy) {
  return auditPolicy.includeDev ? ["--include=dev"] : ["--omit=dev"];
}

function spawnFailureDetails(result) {
  return [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
}

function runGitOrFail(args, repoRoot, failureMessage) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return failInfrastructure(`${failureMessage}\n${spawnFailureDetails(result)}`);
  }
  return result;
}

function runGitAllowFailure(args, repoRoot, failureMessage) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) {
    return failInfrastructure(`${failureMessage}\n${spawnFailureDetails(result)}`);
  }
  return result;
}

function readBaseBranchPolicy(repoRoot, baseRef) {
  const basePolicySpec = `refs/remotes/origin/${baseRef}:${AUDIT_POLICY_FILE}`;
  const readFailureMessage = `could not read ${AUDIT_POLICY_FILE} from base branch ${baseRef}.`;
  let result = runGitAllowFailure(["show", basePolicySpec], repoRoot, readFailureMessage);

  if (result.status !== 0) {
    runGitOrFail(
      ["fetch", "--no-tags", "origin", `${baseRef}:refs/remotes/origin/${baseRef}`],
      repoRoot,
      `could not fetch base branch ${baseRef} for trusted accepted advisories.`,
    );
    result = runGitAllowFailure(["show", basePolicySpec], repoRoot, readFailureMessage);
  }

  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }

  return parseStrictJsonPolicy(result.stdout, basePolicySpec);
}

function acceptedAdvisoriesMatch(left, right) {
  return (
    JSON.stringify(left.acceptedAdvisories ?? []) === JSON.stringify(right.acceptedAdvisories ?? [])
  );
}

function trustedAcceptedAdvisories(repoRoot, auditPolicy, packageJson, trustedBaseRef) {
  if (!trustedBaseRef) {
    return auditPolicy.acceptedAdvisories;
  }

  const basePolicy = readBaseBranchPolicy(repoRoot, trustedBaseRef);
  if (basePolicy === undefined) {
    if ((auditPolicy.acceptedAdvisories ?? []).length > 0) {
      throw new Error(
        `PR-local acceptedAdvisories cannot be trusted because ${AUDIT_POLICY_FILE} is absent on ${trustedBaseRef}.`,
      );
    }
    return [];
  }
  validateAuditPolicy(basePolicy, packageJson, { checkPackageScripts: false });
  if (
    (auditPolicy.acceptedAdvisories ?? []).length > 0 &&
    !acceptedAdvisoriesMatch(auditPolicy, basePolicy)
  ) {
    throw new Error(
      `PR-local acceptedAdvisories must match the protected ${trustedBaseRef} policy before they can suppress findings.`,
    );
  }
  return basePolicy.acceptedAdvisories;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const { auditPolicy, packageJson } = loadCurrentPolicy(args.directory, args.policy);
  validateAuditPolicy(auditPolicy, packageJson, { checkPackageScripts: false });

  const result = spawnSync(
    npmCommand,
    [
      "audit",
      "--json",
      `--audit-level=${auditPolicy.auditLevel}`,
      ...npmAuditScopeArgs(auditPolicy),
      ...trustedNpmConfigArgs,
    ],
    {
      cwd: args.directory,
      encoding: "utf8",
      env: trustedNpmEnv(),
      maxBuffer: AUDIT_MAX_BUFFER_BYTES,
    },
  );

  if (result.error) {
    failInfrastructure(result.error.message);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const report = parseAuditReport(stdout, stderr, result.status);
  if (result.status !== 0 && !report.vulnerabilities) {
    failInfrastructure(
      `npm audit could not complete. Exit ${result.status}.\n${stdout}\n${stderr}`,
    );
  }

  const findings = collectAuditFindings(report, auditPolicy.auditLevel);
  const acceptedAdvisories = trustedAcceptedAdvisories(
    args.directory,
    auditPolicy,
    packageJson,
    args.trustedBaseRef,
  );
  const unacceptedFindings = findings.filter(
    (finding) => !isAcceptedFinding(finding, acceptedAdvisories),
  );

  if (unacceptedFindings.length > 0) {
    console.error("npm audit found unaccepted moderate-or-higher advisories:");
    for (const finding of unacceptedFindings) {
      console.error(`- ${formatFinding(finding)}`);
    }
    process.exit(1);
  }

  if (findings.length > 0) {
    console.warn("npm audit found only time-boxed accepted advisories:");
    for (const finding of findings) {
      console.warn(`- ${formatFinding(finding)}`);
    }
  } else {
    console.log("npm audit found no moderate-or-higher advisories.");
  }
} catch (error) {
  console.error(`npm audit gate failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
