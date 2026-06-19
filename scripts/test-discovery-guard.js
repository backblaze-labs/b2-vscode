#!/usr/bin/env node

/**
 * Unit checks for the compiled-test discovery guard.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runDiscoveryCheck } = require("./assert-test-discovery");

const sourceTestFilesGlob = "src/test/suite/**/*.test.ts";
const compiledTestFilesGlob = "out/src/test/suite/**/*.test.js";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-test-discovery-"));

  try {
    writeFile(path.join(tempRoot, "src", "test", "suite", "example.test.ts"), "export {};\n");

    await assert.rejects(
      () =>
        runDiscoveryCheck({
          repoRoot: tempRoot,
          sourceTestFilesGlob,
          compiledTestFilesGlob,
          log: () => {},
        }),
      /no compiled tests were found/,
    );

    writeFile(path.join(tempRoot, "out", "src", "test", "suite", "example.test.js"), "");
    const result = await runDiscoveryCheck({
      repoRoot: tempRoot,
      sourceTestFilesGlob,
      compiledTestFilesGlob,
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
