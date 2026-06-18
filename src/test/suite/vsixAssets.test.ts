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
import sqlWasmAsset from "../../sql-wasm-asset.json";

interface VsixAssetAssertions {
  assertVsixAssets(packagePath?: string): Promise<void>;
}

interface SqlWasmAssetConfig {
  filename: string;
  packagedDistDir: string;
  runtimeFilename: string;
  runtimeSourcePath: string;
  sourcePath: string;
}

const SQL_WASM_ASSET: SqlWasmAssetConfig = sqlWasmAsset;
const SQL_JS_RUNTIME_FIXTURE_PATH = path.join(process.cwd(), SQL_WASM_ASSET.runtimeSourcePath);
const SQL_WASM_FIXTURE_PATH = path.join(process.cwd(), SQL_WASM_ASSET.sourcePath);
const PACKAGED_SQL_RUNTIME_ENTRY = path.posix.join(
  "extension",
  SQL_WASM_ASSET.packagedDistDir,
  SQL_WASM_ASSET.runtimeFilename,
);
const PACKAGED_SQL_WASM_ENTRY = path.posix.join(
  "extension",
  SQL_WASM_ASSET.packagedDistDir,
  SQL_WASM_ASSET.filename,
);

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
  runtimeContent: Buffer,
  wasmContent: Buffer,
): Record<string, Buffer | string> {
  return {
    "extension/package.json": "{}",
    "extension/dist/extension.js": extensionSource,
    [PACKAGED_SQL_RUNTIME_ENTRY]: runtimeContent,
    [PACKAGED_SQL_WASM_ENTRY]: wasmContent,
  };
}

function baseRuntimeAndWasm(): { runtime: Buffer; wasm: Buffer } {
  return {
    runtime: fs.readFileSync(SQL_JS_RUNTIME_FIXTURE_PATH),
    wasm: fs.readFileSync(SQL_WASM_FIXTURE_PATH),
  };
}

suite("VSIX runtime asset assertions", () => {
  test("accepts a VSIX with the bundled sql.js WASM and loadable extension bundle", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries("module.exports = {};", runtime, wasm),
      );

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
        baseEntries(
          "module.exports = {};",
          fs.readFileSync(SQL_JS_RUNTIME_FIXTURE_PATH),
          Buffer.alloc(0),
        ),
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
        baseEntries(
          "module.exports = {};",
          fs.readFileSync(SQL_JS_RUNTIME_FIXTURE_PATH),
          Buffer.from("not wasm"),
        ),
      );

      await assert.rejects(assertions.assertVsixAssets(vsixPath), /unexpected.*sql-wasm\.wasm/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt packaged sql.js runtime asset", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries(
          "module.exports = {};",
          Buffer.from("not runtime"),
          fs.readFileSync(SQL_WASM_FIXTURE_PATH),
        ),
      );

      await assert.rejects(assertions.assertVsixAssets(vsixPath), /unexpected.*sql-wasm\.js/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an extension bundle that still requires sql.js from node_modules", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries('module.exports = require("sql.js");', runtime, wasm),
      );

      await assert.rejects(assertions.assertVsixAssets(vsixPath), /unresolved sql\.js import/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not execute packaged extension JavaScript while verifying assets", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();
    const sideEffectPath = path.join(dir, "side-effect");

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries(
          `require("node:fs").writeFileSync(${JSON.stringify(sideEffectPath)}, "executed");`,
          runtime,
          wasm,
        ),
      );

      await assertions.assertVsixAssets(vsixPath);

      assert.strictEqual(fs.existsSync(sideEffectPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
