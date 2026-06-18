/**
 * Tests for VSIX runtime asset assertions.
 *
 * @module test/suite/vsixAssets
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";

interface VsixAssetAssertions {
  assertVsixAssets(packagePath?: string): Promise<void>;
}

function loadVsixAssetAssertions(): VsixAssetAssertions {
  return require(path.join(process.cwd(), "scripts/assert-vsix-assets.js")) as VsixAssetAssertions;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-vsix-assets-"));
}

async function createFixtureVsix(
  dir: string,
  entries: Record<string, Buffer | string>,
): Promise<string> {
  const zip = new JSZip();
  for (const [entryName, content] of Object.entries(entries)) {
    zip.file(entryName, content);
  }

  const vsixPath = path.join(dir, "fixture.vsix");
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(vsixPath, archive);
  return vsixPath;
}

function baseEntries(
  extensionSource: string,
  wasmContent: Buffer,
): Record<string, Buffer | string> {
  return {
    "extension/package.json": "{}",
    "extension/dist/extension.js": extensionSource,
    "extension/dist/sql-wasm.wasm": wasmContent,
  };
}

suite("VSIX runtime asset assertions", () => {
  test("accepts a VSIX with the bundled sql.js WASM and loadable extension bundle", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const wasm = fs.readFileSync(
        path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
      );
      const vsixPath = await createFixtureVsix(dir, baseEntries("module.exports = {};", wasm));

      await assertions.assertVsixAssets(vsixPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an empty packaged sql.js WASM asset", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries("module.exports = {};", Buffer.alloc(0)),
      );

      await assert.rejects(assertions.assertVsixAssets(vsixPath), /sql-wasm\.wasm/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt packaged sql.js WASM asset", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries("module.exports = {};", Buffer.from("not wasm")),
      );

      await assert.rejects(assertions.assertVsixAssets(vsixPath), /unexpected.*sql-wasm\.wasm/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an extension bundle that still requires sql.js from node_modules", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const wasm = fs.readFileSync(
        path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
      );
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries('module.exports = require("sql.js");', wasm),
      );

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath),
        /without repository node_modules/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
