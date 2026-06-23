#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const sourceRoot = path.join("src", "test", "unit");
const compiledRoot = path.join("out", "src", "test", "unit");

function findTests(root, extension) {
  if (typeof fs.globSync !== "function") {
    throw new Error("Unit test discovery requires Node.js 22 or newer.");
  }

  return fs
    .globSync(`${root}/**/*.test.${extension}`, { cwd: repoRoot })
    .filter((fileName) => fs.statSync(path.join(repoRoot, fileName)).isFile())
    .map((fileName) => path.normalize(fileName))
    .sort();
}

const sourceTests = findTests(sourceRoot, "ts");
if (sourceTests.length === 0) {
  throw new Error(`No source unit tests found under ${sourceRoot}.`);
}

const compiledTests = findTests(compiledRoot, "js");
if (compiledTests.length === 0) {
  throw new Error(`No compiled unit tests found under ${compiledRoot}.`);
}

const compiledRelativeTests = new Set(
  compiledTests.map((fileName) => path.relative(compiledRoot, fileName)),
);
const missingCompiledTests = sourceTests
  .map((fileName) => path.relative(sourceRoot, fileName).replace(/\.ts$/u, ".js"))
  .filter((fileName) => !compiledRelativeTests.has(fileName));

if (missingCompiledTests.length > 0) {
  throw new Error(`Missing compiled unit test file(s): ${missingCompiledTests.join(", ")}.`);
}

const sanitizedEnv = { ...process.env };
for (const key of ["B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY", "GITHUB_TOKEN"]) {
  delete sanitizedEnv[key];
}

const result = spawnSync(process.execPath, ["--test", ...compiledTests], {
  cwd: repoRoot,
  env: sanitizedEnv,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
