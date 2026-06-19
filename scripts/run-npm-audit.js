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
  validateAuditPolicy,
} = require("./audit-policy");
const { npmCommand } = require("./npm-command");

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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseAuditReport(stdout, stderr, status) {
  if (!stdout.trim()) {
    failInfrastructure(`npm audit returned no JSON output. Exit ${status}.\n${stderr}`);
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    failInfrastructure(
      `npm audit returned invalid JSON. Exit ${status}. ${error.message}\n${stdout}\n${stderr}`,
    );
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const { auditPolicy, packageJson } = loadCurrentPolicy(repoRoot, args.policy);
  validateAuditPolicy(auditPolicy, packageJson);

  const result = spawnSync(
    npmCommand,
    ["audit", "--json", `--audit-level=${auditPolicy.auditLevel}`],
    {
      cwd: args.directory,
      encoding: "utf8",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
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
  const unacceptedFindings = findings.filter(
    (finding) => !isAcceptedFinding(finding, auditPolicy.acceptedAdvisories),
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
