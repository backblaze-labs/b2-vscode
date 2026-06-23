#!/usr/bin/env node

/**
 * Verifies package metadata stays aligned across npm-managed files.
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function stableObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

function assertRootEnginesMatch(packageJson, packageLock) {
  const packageEngines = stableObject(packageJson.engines);
  const lockfileEngines = stableObject(packageLock.packages?.[""]?.engines);

  if (JSON.stringify(packageEngines) !== JSON.stringify(lockfileEngines)) {
    throw new Error(
      [
        "package-lock.json root engines must match package.json engines.",
        `package.json: ${JSON.stringify(packageEngines)}`,
        `package-lock.json: ${JSON.stringify(lockfileEngines)}`,
      ].join("\n"),
    );
  }
}

function main() {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");

  assertRootEnginesMatch(packageJson, packageLock);
  console.log("Package metadata checks passed.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  assertRootEnginesMatch,
  main,
};
