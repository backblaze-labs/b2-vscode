#!/usr/bin/env node

/**
 * Fail fast when the VS Code test harness would run with no compiled tests.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const defaultRepoRoot = path.join(__dirname, "..");
const defaultConfigPath = path.join(defaultRepoRoot, ".vscode-test.mjs");

function findFiles(root, predicate, base = root) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(fullPath, predicate, base));
    } else if (predicate(entry.name)) {
      files.push(path.relative(base, fullPath));
    }
  }

  return files.sort();
}

function suiteDirFromGlob(glob, extension) {
  const suffix = `/**/*.test.${extension}`;
  if (typeof glob !== "string" || !glob.endsWith(suffix)) {
    throw new Error(`unsupported test discovery glob: ${String(glob)}`);
  }

  return glob.slice(0, -suffix.length);
}

async function loadConfiguredGlobs(configPath) {
  const config = await import(pathToFileURL(configPath).href);
  const { sourceTestFilesGlob, compiledTestFilesGlob } = config;

  if (typeof sourceTestFilesGlob !== "string") {
    throw new Error(".vscode-test.mjs must export sourceTestFilesGlob.");
  }
  if (typeof compiledTestFilesGlob !== "string") {
    throw new Error(".vscode-test.mjs must export compiledTestFilesGlob.");
  }

  return { sourceTestFilesGlob, compiledTestFilesGlob };
}

async function runDiscoveryCheck(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const configPath = options.configPath ?? path.join(repoRoot, ".vscode-test.mjs");
  const log = options.log ?? console.log;
  const configuredGlobs =
    options.sourceTestFilesGlob && options.compiledTestFilesGlob
      ? {
          sourceTestFilesGlob: options.sourceTestFilesGlob,
          compiledTestFilesGlob: options.compiledTestFilesGlob,
        }
      : await loadConfiguredGlobs(configPath);

  const sourceSuiteDir = path.join(
    repoRoot,
    suiteDirFromGlob(configuredGlobs.sourceTestFilesGlob, "ts"),
  );
  const compiledSuiteDir = path.join(
    repoRoot,
    suiteDirFromGlob(configuredGlobs.compiledTestFilesGlob, "js"),
  );

  const sourceTests = findFiles(sourceSuiteDir, (name) => name.endsWith(".test.ts"));
  if (sourceTests.length === 0) {
    throw new Error(`no source tests were found for ${configuredGlobs.sourceTestFilesGlob}.`);
  }

  const compiledTests = findFiles(compiledSuiteDir, (name) => name.endsWith(".test.js"));
  if (compiledTests.length === 0) {
    throw new Error(`no compiled tests were found for ${configuredGlobs.compiledTestFilesGlob}.`);
  }

  const expectedCompiledTests = sourceTests.map((fileName) => fileName.replace(/\.ts$/, ".js"));
  const missingTests = expectedCompiledTests.filter(
    (fileName) => !compiledTests.includes(fileName),
  );

  if (missingTests.length > 0) {
    throw new Error(`missing compiled test file(s): ${missingTests.join(", ")}.`);
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
  suiteDirFromGlob,
};
