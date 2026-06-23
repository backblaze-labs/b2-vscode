#!/usr/bin/env node

/**
 * Guard dependency-maintenance PRs against silent generated-code changes in the
 * packaged VSIX. When package manifests change without runtime source changes,
 * compare generated entries from the base and head VSIX files. Any generated
 * output delta must either be absent or match an exact reviewed allowlist entry.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const repoRoot = path.join(__dirname, "..");
const DEFAULT_ALLOWLIST_PATH = path.join(repoRoot, ".github", "vsix-generated-diff-allowlist.json");

const PACKAGE_MANIFEST_FILES = new Set([
  ".npmrc",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
]);

const RUNTIME_SOURCE_PREFIXES = ["resources/"];
const RUNTIME_SOURCE_FILES = new Set(["scripts/build-icons.js", "webpack.config.js"]);
const GENERATED_ENTRY_PATTERNS = [
  /^extension\/dist\/.+/u,
  /^extension\/resources\/b2-icons\.woff$/u,
];
let JSZip;

function loadJSZip() {
  JSZip ??= require("jszip");
  return JSZip;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizeChangedFile(filePath) {
  return filePath.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function isRuntimeSourceFile(filePath) {
  if (RUNTIME_SOURCE_FILES.has(filePath)) {
    return true;
  }
  if (RUNTIME_SOURCE_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return true;
  }
  return filePath.startsWith("src/") && !filePath.startsWith("src/test");
}

function dependencyManifestChanged(changedFiles) {
  return changedFiles.some((filePath) => PACKAGE_MANIFEST_FILES.has(filePath));
}

function shouldCheckDependencyVsixDiff(changedFiles) {
  const normalizedFiles = changedFiles.map(normalizeChangedFile).filter(Boolean);
  if (!dependencyManifestChanged(normalizedFiles)) {
    return {
      check: false,
      reason: "no package manifest changes",
    };
  }
  const sourceChanges = normalizedFiles.filter(isRuntimeSourceFile);
  if (sourceChanges.length > 0) {
    return {
      check: false,
      reason: `runtime source changed: ${sourceChanges.join(", ")}`,
    };
  }

  return {
    check: true,
    reason: "package manifests changed without runtime source changes",
  };
}

function isGeneratedEntry(entryName) {
  return GENERATED_ENTRY_PATTERNS.some((pattern) => pattern.test(entryName));
}

async function generatedEntries(vsixPath) {
  if (!fs.existsSync(vsixPath)) {
    throw new Error(`VSIX not found: ${vsixPath}`);
  }

  const zip = await loadJSZip().loadAsync(fs.readFileSync(vsixPath));
  const entries = new Map();
  const generatedEntryNames = Object.keys(zip.files)
    .filter((entryName) => isGeneratedEntry(entryName) && !zip.files[entryName].dir)
    .sort();

  for (const entryName of generatedEntryNames) {
    const content = await zip.files[entryName].async("nodebuffer");
    entries.set(entryName, {
      bytes: content.length,
      sha256: sha256(content),
    });
  }

  return entries;
}

function diffGeneratedEntries(baseEntries, headEntries) {
  const entryNames = [...new Set([...baseEntries.keys(), ...headEntries.keys()])].sort();
  const diffs = [];

  for (const entryName of entryNames) {
    const base = baseEntries.get(entryName) ?? null;
    const head = headEntries.get(entryName) ?? null;
    if (
      base?.bytes === head?.bytes &&
      base?.sha256 === head?.sha256 &&
      base !== null &&
      head !== null
    ) {
      continue;
    }

    diffs.push({
      path: entryName,
      base,
      head,
    });
  }

  return diffs;
}

function diffSha256(generatedEntriesDiff) {
  return sha256(Buffer.from(stableStringify(generatedEntriesDiff), "utf8"));
}

function loadAllowlist(allowlistPath = DEFAULT_ALLOWLIST_PATH) {
  if (!fs.existsSync(allowlistPath)) {
    return {
      version: 1,
      reviewedDiffs: [],
    };
  }

  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  if (allowlist.version !== 1 || !Array.isArray(allowlist.reviewedDiffs)) {
    throw new Error(`${allowlistPath} must contain { "version": 1, "reviewedDiffs": [...] }.`);
  }

  return allowlist;
}

function allowlistEntryForDiff(generatedEntriesDiff, reason) {
  return {
    reason,
    diffSha256: diffSha256(generatedEntriesDiff),
    generatedEntries: generatedEntriesDiff,
  };
}

function isDiffAllowed(generatedEntriesDiff, allowlist) {
  const expectedEntry = allowlistEntryForDiff(generatedEntriesDiff, "<reviewed reason>");
  return allowlist.reviewedDiffs.some((entry) => {
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      return false;
    }
    return (
      entry.diffSha256 === expectedEntry.diffSha256 &&
      stableStringify(entry.generatedEntries) === stableStringify(expectedEntry.generatedEntries)
    );
  });
}

function formatAllowlistEntry(generatedEntriesDiff) {
  return JSON.stringify(
    allowlistEntryForDiff(generatedEntriesDiff, "Reviewed dependency build-output change."),
    null,
    2,
  );
}

async function assertDependencyOnlyVsixDiff(options) {
  const changedFiles = options.changedFiles ?? [];
  const decision = shouldCheckDependencyVsixDiff(changedFiles);
  if (!decision.check) {
    return {
      status: "skipped",
      reason: decision.reason,
    };
  }

  const baseEntries = await generatedEntries(options.baseVsixPath);
  const headEntries = await generatedEntries(options.headVsixPath);
  const generatedEntriesDiff = diffGeneratedEntries(baseEntries, headEntries);
  if (generatedEntriesDiff.length === 0) {
    return {
      status: "passed",
      reason: "generated VSIX entries match base",
    };
  }

  const allowlist =
    options.allowlist ?? loadAllowlist(options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH);
  if (isDiffAllowed(generatedEntriesDiff, allowlist)) {
    return {
      status: "allowed",
      reason: "generated VSIX diff matches reviewed allowlist",
      diffSha256: diffSha256(generatedEntriesDiff),
    };
  }

  throw new Error(
    [
      "Generated VSIX code changed in a dependency-maintenance PR without a reviewed allowlist.",
      `Diff fingerprint: ${diffSha256(generatedEntriesDiff)}`,
      "Review the generated-code delta. If it is expected, add this exact entry to .github/vsix-generated-diff-allowlist.json:",
      formatAllowlistEntry(generatedEntriesDiff),
    ].join("\n"),
  );
}

function readChangedFiles(changedFilesPath) {
  return fs.readFileSync(changedFilesPath, "utf8").split(/\r?\n/u).filter(Boolean);
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return value;
}

function parseArgs(argv) {
  const parsed = {
    allowlistPath: DEFAULT_ALLOWLIST_PATH,
    baseVsixPath: undefined,
    changedFilesPath: undefined,
    headVsixPath: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allowlist") {
      parsed.allowlistPath = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--base") {
      parsed.baseVsixPath = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--changed-files") {
      parsed.changedFilesPath = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--head") {
      parsed.headVsixPath = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  for (const [propertyName, optionName] of [
    ["baseVsixPath", "--base"],
    ["changedFilesPath", "--changed-files"],
    ["headVsixPath", "--head"],
  ]) {
    if (!parsed[propertyName]) {
      throw new Error(`Missing required option: ${optionName}`);
    }
  }

  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await assertDependencyOnlyVsixDiff({
    allowlistPath: args.allowlistPath,
    baseVsixPath: args.baseVsixPath,
    changedFiles: readChangedFiles(args.changedFilesPath),
    headVsixPath: args.headVsixPath,
  });
  console.log(`Dependency VSIX generated-code diff gate ${result.status}: ${result.reason}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_ALLOWLIST_PATH,
  assertDependencyOnlyVsixDiff,
  diffGeneratedEntries,
  diffSha256,
  formatAllowlistEntry,
  generatedEntries,
  isDiffAllowed,
  parseArgs,
  shouldCheckDependencyVsixDiff,
};
