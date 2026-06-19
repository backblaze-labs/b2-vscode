#!/usr/bin/env node

/**
 * Fail fast when the VS Code test harness would run with no compiled tests.
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const sourceSuiteDir = path.join(repoRoot, "src", "test", "suite");
const compiledSuiteDir = path.join(repoRoot, "out", "src", "test", "suite");

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

function fail(message) {
  console.error(`Test discovery failed: ${message}`);
  process.exit(1);
}

const sourceTests = findFiles(sourceSuiteDir, (name) => name.endsWith(".test.ts"));
if (sourceTests.length === 0) {
  fail("no source tests were found under src/test/suite.");
}

const compiledTests = findFiles(compiledSuiteDir, (name) => name.endsWith(".test.js"));
if (compiledTests.length === 0) {
  fail("no compiled tests were found under out/src/test/suite.");
}

const expectedCompiledTests = sourceTests.map((fileName) => fileName.replace(/\.ts$/, ".js"));
const missingTests = expectedCompiledTests.filter((fileName) => !compiledTests.includes(fileName));

if (missingTests.length > 0) {
  fail(`missing compiled test file(s): ${missingTests.join(", ")}.`);
}

console.log(
  `Discovered ${compiledTests.length} compiled test file(s) for ${sourceTests.length} source test file(s).`,
);
