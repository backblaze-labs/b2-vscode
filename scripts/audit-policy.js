/**
 * Shared dependency-audit policy helpers for the npm audit gate and guardrails.
 */

const fs = require("fs");
const path = require("path");

const AUDIT_POLICY_FILE = "audit-policy.jsonc";
const AUDIT_COMMAND = "node scripts/run-npm-audit.js";
const RELEASE_AUDIT_COMMAND = "npm run audit:ci";
const AUDIT_POLICY_STRICT_JSON_NOTICE =
  "Strict JSON only: comments and trailing commas are not allowed despite the .jsonc extension.";
const REQUIRED_AUDIT_LEVEL = "moderate";
const MAX_ACCEPTANCE_DAYS = 30;
const ACCEPTANCE_EXPIRY_WARNING_DAYS = 7;
const SEVERITY_RANK = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseStrictJsonPolicy(text, sourceName = AUDIT_POLICY_FILE) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName} must be strict JSON: ${message}`);
  }
}

function utcDateOnly(date) {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const result = utcDateOnly(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function parseDateOnly(value, fieldName) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${fieldName} must use YYYY-MM-DD.`);

  const date = new Date(`${value}T00:00:00Z`);
  assert(
    !Number.isNaN(date.getTime()) && formatDateOnly(date) === value,
    `${fieldName} must be a valid calendar date.`,
  );
  return date;
}

function dateOnlyDaysFromNow(days) {
  return formatDateOnly(addUtcDays(new Date(), days));
}

function validateAcceptedAdvisory(entry, index, today = new Date()) {
  assert(
    entry && typeof entry === "object" && !Array.isArray(entry),
    `acceptedAdvisories[${index}] must be an object.`,
  );

  const allowedKeys = new Set(["id", "package", "owner", "reason", "reviewBy", "paths"]);
  for (const key of Object.keys(entry)) {
    assert(allowedKeys.has(key), `acceptedAdvisories[${index}] has unexpected key: ${key}.`);
  }

  assert(
    /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(entry.id ?? ""),
    `acceptedAdvisories[${index}].id must be a GHSA advisory id.`,
  );
  assert(
    typeof entry.package === "string" && entry.package.length > 0,
    `acceptedAdvisories[${index}].package must be a non-empty string.`,
  );
  assert(
    typeof entry.owner === "string" && entry.owner.length > 0,
    `acceptedAdvisories[${index}].owner must be a non-empty string.`,
  );
  assert(
    typeof entry.reason === "string" && entry.reason.length >= 10,
    `acceptedAdvisories[${index}].reason must explain the risk acceptance.`,
  );
  assert(
    typeof entry.reviewBy === "string",
    `acceptedAdvisories[${index}].reviewBy must be a YYYY-MM-DD string.`,
  );

  const todayUtc = utcDateOnly(today);
  const reviewBy = parseDateOnly(entry.reviewBy, `acceptedAdvisories[${index}].reviewBy`);
  const latestReviewBy = addUtcDays(todayUtc, MAX_ACCEPTANCE_DAYS);

  assert(reviewBy >= todayUtc, `acceptedAdvisories[${index}].reviewBy must not be expired.`);
  assert(
    reviewBy <= latestReviewBy,
    `acceptedAdvisories[${index}].reviewBy must be within ${MAX_ACCEPTANCE_DAYS} days.`,
  );
  if (reviewBy <= addUtcDays(todayUtc, ACCEPTANCE_EXPIRY_WARNING_DAYS)) {
    console.warn(
      `acceptedAdvisories[${index}] expires on ${formatDateOnly(
        reviewBy,
      )}; renew or remove it before the required check starts failing.`,
    );
  }

  assert(
    Array.isArray(entry.paths) && entry.paths.length > 0,
    `acceptedAdvisories[${index}].paths must be a non-empty array.`,
  );
  assert(
    entry.paths.every((item) => typeof item === "string" && item.length > 0),
    `acceptedAdvisories[${index}].paths must contain non-empty strings.`,
  );
}

function validateAuditPolicy(auditPolicy, packageJson, options = {}) {
  assert(
    auditPolicy && typeof auditPolicy === "object" && !Array.isArray(auditPolicy),
    `${AUDIT_POLICY_FILE} must contain an object.`,
  );

  const allowedKeys = new Set(["_comment", "auditLevel", "includeDev", "acceptedAdvisories"]);
  for (const key of Object.keys(auditPolicy)) {
    assert(allowedKeys.has(key), `${AUDIT_POLICY_FILE} has unexpected key: ${key}.`);
  }

  assert(
    auditPolicy._comment === AUDIT_POLICY_STRICT_JSON_NOTICE,
    `${AUDIT_POLICY_FILE} must keep the strict JSON notice.`,
  );
  assert(
    auditPolicy.auditLevel === REQUIRED_AUDIT_LEVEL,
    `${AUDIT_POLICY_FILE} must keep auditLevel: "${REQUIRED_AUDIT_LEVEL}".`,
  );
  assert(auditPolicy.includeDev === true, `${AUDIT_POLICY_FILE} must keep includeDev: true.`);
  assert(
    Array.isArray(auditPolicy.acceptedAdvisories),
    `${AUDIT_POLICY_FILE} must declare acceptedAdvisories as an array.`,
  );

  auditPolicy.acceptedAdvisories.forEach((entry, index) =>
    validateAcceptedAdvisory(entry, index, options.today),
  );

  if (options.checkPackageScripts !== false) {
    assert(packageJson.scripts?.["audit:ci"] === AUDIT_COMMAND, "audit:ci script drifted.");
    assert(
      packageJson.scripts?.["audit:release"] === RELEASE_AUDIT_COMMAND,
      "audit:release script drifted.",
    );
    assert(
      packageJson.devDependencies?.["audit-ci"] === undefined,
      "audit-ci must not be reintroduced as a devDependency.",
    );
  }
}

function loadAuditPolicy(repoRoot, policyPath = path.join(repoRoot, AUDIT_POLICY_FILE)) {
  return parseStrictJsonPolicy(fs.readFileSync(policyPath, "utf8"), path.basename(policyPath));
}

function loadCurrentPolicy(repoRoot, policyPath) {
  const auditPolicy = loadAuditPolicy(repoRoot, policyPath);
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return { auditPolicy, packageJson };
}

function severityMeetsLevel(severity, auditLevel) {
  const auditRank = SEVERITY_RANK[auditLevel];
  assert(auditRank !== undefined, `unsupported audit level: ${auditLevel}.`);

  const severityRank = SEVERITY_RANK[String(severity ?? "").toLowerCase()];
  if (severityRank === undefined) {
    return true;
  }

  return severityRank >= auditRank;
}

function advisoryIdFromUrl(url) {
  return typeof url === "string"
    ? url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0]
    : undefined;
}

function collectAuditFindings(report, auditLevel) {
  const findings = [];
  const seen = new Set();

  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (!via || typeof via !== "object") {
        continue;
      }

      const severity = String(via.severity || vulnerability.severity || "unknown").toLowerCase();
      if (!severityMeetsLevel(severity, auditLevel)) {
        continue;
      }

      const id = advisoryIdFromUrl(via.url) || String(via.source ?? "");
      const finding = {
        id,
        package: via.dependency || via.name || vulnerability.name,
        vulnerability: vulnerability.name,
        severity,
        title: via.title || vulnerability.title || "npm advisory",
        url: via.url,
        paths: vulnerability.nodes ?? [],
      };
      const key = `${finding.id}|${finding.package}|${finding.paths.join(",")}`;
      if (!seen.has(key)) {
        findings.push(finding);
        seen.add(key);
      }
    }
  }

  return findings;
}

function isAcceptedFinding(finding, acceptedAdvisories) {
  return acceptedAdvisories.some((entry) => {
    const packageMatches = entry.package === finding.package;
    const pathsMatch =
      finding.paths.length > 0 &&
      finding.paths.every((findingPath) => entry.paths.includes(findingPath));

    return entry.id.toLowerCase() === finding.id.toLowerCase() && packageMatches && pathsMatch;
  });
}

function formatFinding(finding) {
  const pathText = finding.paths.length > 0 ? ` paths=${finding.paths.join(",")}` : "";
  const urlText = finding.url ? ` ${finding.url}` : "";
  return `${finding.severity}: ${finding.id} ${finding.package} - ${finding.title}${pathText}${urlText}`;
}

module.exports = {
  AUDIT_COMMAND,
  AUDIT_POLICY_FILE,
  AUDIT_POLICY_STRICT_JSON_NOTICE,
  collectAuditFindings,
  dateOnlyDaysFromNow,
  formatFinding,
  isAcceptedFinding,
  loadCurrentPolicy,
  parseStrictJsonPolicy,
  validateAuditPolicy,
};
