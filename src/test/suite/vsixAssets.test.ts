/**
 * Tests for VSIX runtime asset assertions.
 *
 * @module test/suite/vsixAssets
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import JSZip from "jszip";
import {
  SQL_WASM_ASSET,
  resolveSqlJsRuntimeSourcePath,
  resolveSqlWasmSourcePath,
} from "../../sqlWasmAssets";

interface VsixAssetAssertions {
  assertVsixAssets(
    packagePath?: string,
    options?: { skipSqlJsPackageProvenance?: boolean },
  ): Promise<void>;
  fetchBuffer(url: string, redirectsRemaining?: number, timeoutMs?: number): Promise<Buffer>;
}

interface FakeRequest extends EventEmitter {
  destroy(error: Error): FakeRequest;
  setTimeout(timeoutMs: number, callback: () => void): FakeRequest;
}

const SQL_JS_RUNTIME_FIXTURE_PATH = resolveSqlJsRuntimeSourcePath(process.cwd());
const SQL_WASM_FIXTURE_PATH = resolveSqlWasmSourcePath(process.cwd());
const FIXTURE_ASSERT_OPTIONS = { skipSqlJsPackageProvenance: true };

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
    [SQL_WASM_ASSET.packageJsonEntry]: "{}",
    [SQL_WASM_ASSET.extensionBundleEntry]: extensionSource,
    [SQL_WASM_ASSET.packagedRuntimeEntry]: runtimeContent,
    [SQL_WASM_ASSET.packagedWasmEntry]: wasmContent,
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

      await assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS);
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

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /sql-wasm\.wasm/i,
      );
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

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /unexpected.*sql-wasm\.wasm/i,
      );
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

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /unexpected.*sql-wasm\.js/i,
      );
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

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /unresolved sql\.js import/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a production extension bundle that contains the smoke env gate", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries(
          "module.exports = process.env.B2_VSCODE_ENABLE_BUNDLED_CREDENTIAL_SMOKE;",
          runtime,
          wasm,
        ),
      );

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /test-only credential smoke hook/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a production extension bundle that contains the smoke resolver symbol", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const vsixPath = await createFixtureVsix(
        dir,
        baseEntries(
          "module.exports.resolveBundledCredentialSmoke = function () {};",
          runtime,
          wasm,
        ),
      );

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /test-only credential smoke hook/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a VSIX containing the test-only bundled smoke artifact", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const entries = {
        ...baseEntries("module.exports = {};", runtime, wasm),
        "extension/dist/bundledCredentialSmoke.js": "module.exports = {};",
      };
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /test-only bundled credential smoke artifact/i,
      );
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

      await assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS);

      assert.strictEqual(fs.existsSync(sideEffectPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("times out stalled SQL.js tarball fetches", async () => {
    const assertions = loadVsixAssetAssertions();
    const httpsModule = require("https") as typeof import("https");
    const originalGet = httpsModule.get;
    const fakeRequest = new EventEmitter() as FakeRequest;
    fakeRequest.setTimeout = (_timeoutMs, callback) => {
      setImmediate(callback);
      return fakeRequest;
    };
    fakeRequest.destroy = (error) => {
      fakeRequest.emit("error", error);
      return fakeRequest;
    };

    Object.defineProperty(httpsModule, "get", {
      configurable: true,
      value: (() => fakeRequest) as unknown as typeof httpsModule.get,
    });

    try {
      await assert.rejects(
        assertions.fetchBuffer("https://registry.npmjs.org/sql.js/-/sql.js-1.14.1.tgz", 3, 1),
        /Timed out fetching/i,
      );
    } finally {
      Object.defineProperty(httpsModule, "get", {
        configurable: true,
        value: originalGet,
      });
    }
  });
});
