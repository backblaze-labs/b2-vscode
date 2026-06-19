#!/usr/bin/env node

/**
 * Fail fast when the VS Code test harness would run with no compiled tests.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const defaultRepoRoot = path.join(__dirname, "..");
const defaultConfigPath = path.join(defaultRepoRoot, "test-harness.config.mjs");

function normalizeGlobList(globs, label) {
  if (typeof globs === "string") {
    return [globs];
  }
  if (Array.isArray(globs) && globs.every((glob) => typeof glob === "string")) {
    return globs;
  }

  throw new Error(`${label} must be a string or an array of strings.`);
}

function findGlobFiles(repoRoot, globs, suffix) {
  const files = new Set();

  for (const glob of globs) {
    for (const fileName of fs.globSync(glob, { cwd: repoRoot })) {
      const absolutePath = path.join(repoRoot, fileName);
      if (fs.statSync(absolutePath).isFile() && fileName.endsWith(suffix)) {
        files.add(path.normalize(fileName));
      }
    }
  }

  return [...files].sort();
}

async function loadHarnessConfig(configPath) {
  const config = await import(pathToFileURL(configPath).href);
  const { sourceTestFilesGlob, compiledTestFilesGlob, sourceTestRoot, compiledTestRoot } = config;

  if (typeof sourceTestRoot !== "string") {
    throw new Error("test-harness.config.mjs must export sourceTestRoot.");
  }
  if (typeof compiledTestRoot !== "string") {
    throw new Error("test-harness.config.mjs must export compiledTestRoot.");
  }
  const sourceTestGlobs = normalizeGlobList(sourceTestFilesGlob, "sourceTestFilesGlob");
  const compiledTestGlobs = normalizeGlobList(compiledTestFilesGlob, "compiledTestFilesGlob");

  return {
    compiledTestGlobs,
    compiledTestRoot,
    sourceTestGlobs,
    sourceTestRoot,
  };
}

function relativeToRoot(repoRoot, testRoot, fileName) {
  const relativePath = path.relative(path.join(repoRoot, testRoot), path.join(repoRoot, fileName));

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${fileName} is outside configured test root ${testRoot}.`);
  }

  return relativePath;
}

async function runDiscoveryCheck(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const configPath = options.configPath ?? path.join(repoRoot, "test-harness.config.mjs");
  const log = options.log ?? console.log;
  const harnessConfig = options.harnessConfig ?? (await loadHarnessConfig(configPath));

  const sourceTests = findGlobFiles(repoRoot, harnessConfig.sourceTestGlobs, ".test.ts");
  if (sourceTests.length === 0) {
    throw new Error(`no source tests were found for ${harnessConfig.sourceTestGlobs.join(", ")}.`);
  }

  const compiledTests = findGlobFiles(repoRoot, harnessConfig.compiledTestGlobs, ".test.js");
  if (compiledTests.length === 0) {
    throw new Error(
      `no compiled tests were found for ${harnessConfig.compiledTestGlobs.join(", ")}.`,
    );
  }

  const compiledRelativeTests = new Set(
    compiledTests.map((fileName) =>
      relativeToRoot(repoRoot, harnessConfig.compiledTestRoot, fileName),
    ),
  );
  const expectedCompiledTests = sourceTests.map((fileName) =>
    relativeToRoot(repoRoot, harnessConfig.sourceTestRoot, fileName).replace(/\.ts$/, ".js"),
  );
  const missingTests = expectedCompiledTests.filter(
    (fileName) => !compiledRelativeTests.has(fileName),
  );

  if (missingTests.length > 0) {
    throw new Error(`missing compiled test file(s): ${missingTests.join(", ")}.`);
  }

  const expectedCompiledTestSet = new Set(expectedCompiledTests);
  const duplicateCompiledTests = compiledTests.filter(
    (fileName) =>
      !expectedCompiledTestSet.has(
        relativeToRoot(repoRoot, harnessConfig.compiledTestRoot, fileName),
      ),
  );

  if (duplicateCompiledTests.length > 0) {
    log(`Ignoring stale compiled test file(s): ${duplicateCompiledTests.join(", ")}.`);
  }

  log(
    `Discovered ${compiledTests.length} compiled test file(s) for ${sourceTests.length} source test file(s).`,
  );

  return {
    compiledTestCount: compiledTests.length,
    sourceTestCount: sourceTests.length,
  };
}

if (require.main === module) {
  runDiscoveryCheck({ configPath: defaultConfigPath }).catch((error) => {
    console.error(`Test discovery failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}

module.exports = {
  runDiscoveryCheck,
};
