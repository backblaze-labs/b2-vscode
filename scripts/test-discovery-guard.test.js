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

    const tempConfigPath = path.join(tempRoot, "test-harness.config.mjs");
    writeFile(
      tempConfigPath,
      [
        `export const sourceTestRoot = ${JSON.stringify(harnessConfig.sourceTestRoot)};`,
        `export const compiledTestRoot = ${JSON.stringify(harnessConfig.compiledTestRoot)};`,
        "export const sourceTestFilesGlob = `${sourceTestRoot}/**/*.test.ts`;",
        "export const compiledTestFilesGlob = `${compiledTestRoot}/**/*.test.js`;",
        "export const mochaOptions = { failZero: true, forbidPending: true };",
        "",
      ].join("\n"),
    );
    const loadedConfigResult = await runDiscoveryCheck({
      configPath: tempConfigPath,
      repoRoot: tempRoot,
      log: () => {},
    });

    assert.deepStrictEqual(loadedConfigResult, {
      compiledTestCount: 1,
      sourceTestCount: 1,
    });

    const dotPrefixRoots = {
      compiledTestGlobs: [`${harnessConfig.compiledTestRoot}/..prefix/*.test.js`],
      compiledTestRoot: harnessConfig.compiledTestRoot,
      sourceTestGlobs: [`${harnessConfig.sourceTestRoot}/..prefix/*.test.ts`],
      sourceTestRoot: harnessConfig.sourceTestRoot,
    };
    writeFile(
      path.join(tempRoot, harnessConfig.sourceTestRoot, "..prefix", "example.test.ts"),
      "export {};\n",
    );
    writeFile(
      path.join(tempRoot, harnessConfig.compiledTestRoot, "..prefix", "example.test.js"),
      "",
    );
    const dotPrefixResult = await runDiscoveryCheck({
      harnessConfig: dotPrefixRoots,
      repoRoot: tempRoot,
      log: () => {},
    });

    assert.deepStrictEqual(dotPrefixResult, {
      compiledTestCount: 1,
      sourceTestCount: 1,
    });

    writeFile(path.join(tempRoot, harnessConfig.compiledTestRoot, "orphan.test.js"), "");
    await assert.rejects(
      () =>
        runDiscoveryCheck({
          harnessConfig: testRoots,
          repoRoot: tempRoot,
          log: () => {},
        }),
      /stale compiled test file/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
