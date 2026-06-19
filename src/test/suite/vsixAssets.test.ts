/**
 * Tests for VSIX runtime asset assertions.
 *
 * @module test/suite/vsixAssets
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { EventEmitter } from "events";
import JSZip from "jszip";
import {
  SQL_JS_RUNTIME_ASSETS,
  resolveSqlJsRuntimeSourcePath,
  resolveSqlWasmSourcePath,
} from "../../sqlJsRuntimeAssets";

interface VsixAssetAssertions {
  assertDistAssets(
    distDir?: string,
    options?: { skipSqlJsPackageProvenance?: boolean; retryDelaysMs?: number[] },
  ): Promise<void>;
  assertSqlJsPackageProvenance(
    fetchPackage?: (url: string) => Promise<Buffer>,
    options?: { retryDelaysMs?: number[]; allowLocalFallback?: boolean },
  ): Promise<void>;
  assertVsixAssets(
    packagePath?: string,
    options?: {
      allowLocalFallback?: boolean;
      skipSqlJsPackageProvenance?: boolean;
      retryDelaysMs?: number[];
    },
  ): Promise<void>;
  fetchBuffer(url: string, redirectsRemaining?: number, timeoutMs?: number): Promise<Buffer>;
}

interface VsixArtifactResolver {
  collectVsixFiles(rootDir: string): string[];
  parseArgs(argv: string[]): { rootDir: string; verifyChecksum: boolean };
}

interface SmokeInstallAssertions {
  assertInstalledFile(installedExtensionPath: string, relativePath: string): void;
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

function loadVsixArtifactResolver(): VsixArtifactResolver {
  return require(
    path.join(process.cwd(), "scripts/resolve-vsix-artifact.js"),
  ) as VsixArtifactResolver;
}

function loadSmokeInstallAssertions(): SmokeInstallAssertions {
  return require(
    path.join(process.cwd(), "scripts/smoke-install-vsix.js"),
  ) as SmokeInstallAssertions;
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

function createFixtureDist(dir: string, entries: Record<string, Buffer | string>): string {
  const distDir = path.join(dir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const [entryName, content] of Object.entries(entries)) {
    fs.writeFileSync(path.join(distDir, entryName), content);
  }

  return distDir;
}

function packageManifestFixture(overrides: Record<string, unknown> = {}): string {
  const packageMetadata = require(path.join(process.cwd(), "package.json")) as Record<
    string,
    unknown
  >;

  return JSON.stringify({ ...packageMetadata, ...overrides });
}

function baseEntries(
  extensionSource: string,
  runtimeContent: Buffer,
  wasmContent: Buffer,
): Record<string, Buffer | string> {
  return {
    [SQL_JS_RUNTIME_ASSETS.packageJsonEntry]: packageManifestFixture(),
    [SQL_JS_RUNTIME_ASSETS.extensionBundleEntry]: extensionSource,
    [SQL_JS_RUNTIME_ASSETS.packagedRuntimeEntry]: runtimeContent,
    [SQL_JS_RUNTIME_ASSETS.packagedWasmEntry]: wasmContent,
    "extension/resources/b2-icon.png": "png",
    "extension/resources/b2-icon.svg": "<svg />",
    "extension/resources/b2-icons.woff": "woff",
  };
}

function baseDistEntries(
  extensionSource: string,
  runtimeContent: Buffer,
  wasmContent: Buffer,
): Record<string, Buffer | string> {
  return {
    [path.basename(SQL_JS_RUNTIME_ASSETS.extensionBundleEntry)]: extensionSource,
    [SQL_JS_RUNTIME_ASSETS.runtimeFilename]: runtimeContent,
    [SQL_JS_RUNTIME_ASSETS.wasmFilename]: wasmContent,
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

  test("rejects a VSIX with missing contribution manifest commands", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const packageMetadata = require(path.join(process.cwd(), "package.json")) as {
        contributes: Record<string, unknown>;
      };
      const entries = {
        ...baseEntries("module.exports = {};", runtime, wasm),
        [SQL_JS_RUNTIME_ASSETS.packageJsonEntry]: packageManifestFixture({
          contributes: { ...packageMetadata.contributes, commands: [] },
        }),
      };
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /contributes\.commands/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a VSIX with the old repository URL", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const entries = {
        ...baseEntries("module.exports = {};", runtime, wasm),
        [SQL_JS_RUNTIME_ASSETS.packageJsonEntry]: packageManifestFixture({
          repository: {
            type: "git",
            url: "https://github.com/backblaze-demos/b2-vscode.git",
          },
        }),
      };
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /repository URL/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a VSIX missing required icon resources", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const entries = baseEntries("module.exports = {};", runtime, wasm);
      delete entries["extension/resources/b2-icon.svg"];
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /b2-icon\.svg/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a VSIX with extension dependencies or extension packs", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const entries = {
        ...baseEntries("module.exports = {};", runtime, wasm),
        [SQL_JS_RUNTIME_ASSETS.packageJsonEntry]: packageManifestFixture({
          extensionDependencies: ["attacker.b2-token-stealer"],
          extensionPack: ["attacker.b2-token-stealer"],
        }),
      };
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /extensionDependencies/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects unexpected activation events and extra executable contributions", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const packageMetadata = require(path.join(process.cwd(), "package.json")) as {
        contributes: { commands: Array<Record<string, unknown>> };
      };
      const entries = {
        ...baseEntries("module.exports = {};", runtime, wasm),
        [SQL_JS_RUNTIME_ASSETS.packageJsonEntry]: packageManifestFixture({
          activationEvents: ["onStartupFinished"],
          contributes: {
            ...packageMetadata.contributes,
            commands: [
              ...packageMetadata.contributes.commands,
              { command: "b2.exfiltrate", title: "Exfiltrate", category: "B2" },
            ],
          },
        }),
      };
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /activationEvents/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects extra command contributions", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const packageMetadata = require(path.join(process.cwd(), "package.json")) as {
        contributes: { commands: Array<Record<string, unknown>> };
      };
      const entries = {
        ...baseEntries("module.exports = {};", runtime, wasm),
        [SQL_JS_RUNTIME_ASSETS.packageJsonEntry]: packageManifestFixture({
          contributes: {
            ...packageMetadata.contributes,
            commands: [
              ...packageMetadata.contributes.commands,
              { command: "b2.exfiltrate", title: "Exfiltrate", category: "B2" },
            ],
          },
        }),
      };
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /contributes\.commands/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing language model tools", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const packageMetadata = require(path.join(process.cwd(), "package.json")) as {
        contributes: { languageModelTools: Array<Record<string, unknown>> };
      };
      const entries = {
        ...baseEntries("module.exports = {};", runtime, wasm),
        [SQL_JS_RUNTIME_ASSETS.packageJsonEntry]: packageManifestFixture({
          contributes: {
            ...packageMetadata.contributes,
            languageModelTools: packageMetadata.contributes.languageModelTools.slice(1),
          },
        }),
      };
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /languageModelTools/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed command contribution entries with targeted errors", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const packageMetadata = require(path.join(process.cwd(), "package.json")) as {
        contributes: Record<string, unknown>;
      };
      const entries = {
        ...baseEntries("module.exports = {};", runtime, wasm),
        [SQL_JS_RUNTIME_ASSETS.packageJsonEntry]: packageManifestFixture({
          contributes: { ...packageMetadata.contributes, commands: [null] },
        }),
      };
      const vsixPath = await createFixtureVsix(dir, entries);

      await assert.rejects(
        assertions.assertVsixAssets(vsixPath, FIXTURE_ASSERT_OPTIONS),
        /contributes\.commands\[0\]/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts packaged dist assets for the publish preflight gate", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const distDir = createFixtureDist(
        dir,
        baseDistEntries("module.exports = {};", runtime, wasm),
      );

      await assertions.assertDistAssets(distDir, FIXTURE_ASSERT_OPTIONS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs the packaged dist asset gate during vscode prepublish", () => {
    const packageMetadata = require(path.join(process.cwd(), "package.json")) as {
      scripts: Record<string, string>;
    };

    assert.match(packageMetadata.scripts["vscode:prepublish"], /assert:dist-assets/);
  });

  test("VSIX resolver skips large generated directories", () => {
    const dir = tempDir();
    const resolver = loadVsixArtifactResolver();

    try {
      fs.mkdirSync(path.join(dir, "node_modules", "stale"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "stale", "ignored.vsix"), "ignored");
      fs.writeFileSync(path.join(dir, "fixture.vsix"), "vsix");

      assert.deepStrictEqual(resolver.collectVsixFiles(dir), [path.join(dir, "fixture.vsix")]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("VSIX resolver rejects multiple positional paths", () => {
    const resolver = loadVsixArtifactResolver();

    assert.throws(
      () => resolver.parseArgs(["./first", "./second"]),
      /Usage: resolve-vsix-artifact\.js/i,
    );
  });

  test("installed VSIX smoke rejects required paths that are directories", () => {
    const dir = tempDir();
    const smokeAssertions = loadSmokeInstallAssertions();

    try {
      fs.mkdirSync(path.join(dir, "resources", "b2-icon.png"), { recursive: true });

      assert.throws(
        () => smokeAssertions.assertInstalledFile(dir, "resources/b2-icon.png"),
        /not a file/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("VSIX asset CLI reports argument errors cleanly", () => {
    const result = spawnSync(process.execPath, ["scripts/assert-vsix-assets.js", "--unknown"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option: --unknown/);
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|unhandled/i);
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

  test("rejects packaged dist output containing the test-only smoke artifact", async () => {
    const dir = tempDir();
    const assertions = loadVsixAssetAssertions();

    try {
      const { runtime, wasm } = baseRuntimeAndWasm();
      const distDir = createFixtureDist(dir, {
        ...baseDistEntries("module.exports = {};", runtime, wasm),
        "bundledCredentialSmoke.js": "module.exports = {};",
      });

      await assert.rejects(
        assertions.assertDistAssets(distDir, FIXTURE_ASSERT_OPTIONS),
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

  test("falls back to local pinned SQL.js assets when tarball fetch is offline", async () => {
    const assertions = loadVsixAssetAssertions();
    const offlineError = new Error("registry unavailable") as NodeJS.ErrnoException;
    offlineError.code = "ENOTFOUND";

    await assert.doesNotReject(
      assertions.assertSqlJsPackageProvenance(
        async () => {
          throw offlineError;
        },
        { retryDelaysMs: [] },
      ),
    );
  });

  test("strict SQL.js provenance fails closed when tarball fetch is offline", async () => {
    const assertions = loadVsixAssetAssertions();
    const offlineError = new Error("registry unavailable") as NodeJS.ErrnoException;
    offlineError.code = "ENOTFOUND";

    await assert.rejects(
      assertions.assertSqlJsPackageProvenance(
        async () => {
          throw offlineError;
        },
        { allowLocalFallback: false, retryDelaysMs: [] },
      ),
      /registry unavailable/i,
    );
  });

  test("still fails on SQL.js tarball integrity mismatches", async () => {
    const assertions = loadVsixAssetAssertions();

    await assert.rejects(
      assertions.assertSqlJsPackageProvenance(async () => Buffer.from("not the sql.js tarball"), {
        retryDelaysMs: [],
      }),
      /Unexpected sha512 integrity/i,
    );
  });
});
