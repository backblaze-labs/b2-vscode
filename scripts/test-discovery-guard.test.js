#!/usr/bin/env node

/**
 * Unit checks for the compiled-test discovery guard.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { runDiscoveryCheck } = require("./test-discovery-guard");

const harnessConfigPath = path.join(__dirname, "..", "test-harness.config.mjs");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-test-discovery-"));
  const harnessConfig = await import(pathToFileURL(harnessConfigPath).href);
  const testRoots = {
    compiledTestGlobs: [harnessConfig.compiledTestFilesGlob],
    compiledTestRoot: harnessConfig.compiledTestRoot,
    sourceTestGlobs: [harnessConfig.sourceTestFilesGlob],
    sourceTestRoot: harnessConfig.sourceTestRoot,
  };

  assert.strictEqual(harnessConfig.mochaOptions.failZero, true);
  assert.strictEqual(harnessConfig.mochaOptions.forbidPending, true);

  try {
    writeFile(path.join(tempRoot, harnessConfig.sourceTestRoot, "example.test.ts"), "export {};\n");

    await assert.rejects(
      () =>
        runDiscoveryCheck({
          harnessConfig: testRoots,
          repoRoot: tempRoot,
          log: () => {},
        }),
      /no compiled tests were found/,
    );

    writeFile(path.join(tempRoot, harnessConfig.compiledTestRoot, "example.test.js"), "");
    const result = await runDiscoveryCheck({
      harnessConfig: testRoots,
      repoRoot: tempRoot,
      log: () => {},
    });

    assert.deepStrictEqual(result, {
      compiledTestCount: 1,
      sourceTestCount: 1,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
