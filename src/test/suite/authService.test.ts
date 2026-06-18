/**
 * Tests for credential resolution failure handling.
 *
 * @module test/suite/authService
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import initSqlJs from "sql.js";
import { AuthService } from "../../services/authService";
import sqlWasmAsset from "../../sql-wasm-asset.json";

interface SqlWasmAssetConfig {
  filename: string;
  runtimeFilename: string;
  runtimeSourcePath: string;
  sourcePath: string;
}

interface BundledExtensionSmokeExports {
  __b2VsixSmokeResolveCredentials?: (
    dbPath: string,
    sqlJsRuntimePath: string,
    sqlWasmPath: string,
  ) => Promise<{ keyId: string; appKey: string } | null>;
}

const SQL_WASM_ASSET: SqlWasmAssetConfig = sqlWasmAsset;
const SQL_JS_RUNTIME_FIXTURE_PATH = path.join(process.cwd(), SQL_WASM_ASSET.runtimeSourcePath);
const SQL_WASM_FIXTURE_PATH = path.join(process.cwd(), SQL_WASM_ASSET.sourcePath);
const DIST_SQL_JS_RUNTIME_PATH = path.join(process.cwd(), "dist", SQL_WASM_ASSET.runtimeFilename);
const DIST_SQL_WASM_PATH = path.join(process.cwd(), "dist", SQL_WASM_ASSET.filename);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-auth-"));
}

function fakeSecretStorage(): vscode.SecretStorage {
  const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  return {
    onDidChange: emitter.event,
    async get() {
      return undefined;
    },
    async store() {},
    async delete() {},
  };
}

function createFsError(code: string, filePath: string): NodeJS.ErrnoException {
  const error = new Error(
    `${code}: simulated failure, open '${filePath}'`,
  ) as NodeJS.ErrnoException;
  error.code = code;
  error.path = filePath;
  return error;
}

function stubReadFileSyncForPath(filePath: string, error: NodeJS.ErrnoException): () => void {
  const mutableFs = require("fs") as { readFileSync: typeof fs.readFileSync };
  const originalReadFileSync = mutableFs.readFileSync;
  mutableFs.readFileSync = ((pathLike: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (pathLike === filePath) {
      throw error;
    }

    return (originalReadFileSync as (...readArgs: unknown[]) => unknown)(pathLike, ...args);
  }) as typeof fs.readFileSync;

  return () => {
    mutableFs.readFileSync = originalReadFileSync;
  };
}

function countReadFileSyncForPath(filePath: string): { count: () => number; restore: () => void } {
  const mutableFs = require("fs") as { readFileSync: typeof fs.readFileSync };
  const originalReadFileSync = mutableFs.readFileSync;
  let readCount = 0;

  mutableFs.readFileSync = ((pathLike: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (pathLike === filePath) {
      readCount++;
    }

    return (originalReadFileSync as (...readArgs: unknown[]) => unknown)(pathLike, ...args);
  }) as typeof fs.readFileSync;

  return {
    count: () => readCount,
    restore: () => {
      mutableFs.readFileSync = originalReadFileSync;
    },
  };
}

async function createB2CliCredentialDatabase(
  dbPath: string,
  wasmPath: string,
  keyId: string,
  appKey: string,
): Promise<void> {
  const wasmBinary = new Uint8Array(fs.readFileSync(wasmPath)).buffer as ArrayBuffer;
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();

  try {
    db.run("CREATE TABLE account (account_id_or_app_key_id TEXT, application_key TEXT);");
    db.run("INSERT INTO account VALUES (?, ?);", [keyId, appKey]);
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  } finally {
    db.close();
  }
}

suite("AuthService credential resolution failures", () => {
  test("reads CLI credentials from a packaged SQL.js WASM layout", async () => {
    const dir = tempDir();
    const packagedRuntimeDir = path.join(dir, "dist");
    const dbPath = path.join(dir, "account_info");
    const packagedSqlJsRuntimePath = path.join(packagedRuntimeDir, SQL_WASM_ASSET.runtimeFilename);
    const packagedWasmPath = path.join(packagedRuntimeDir, SQL_WASM_ASSET.filename);

    try {
      fs.mkdirSync(packagedRuntimeDir, { recursive: true });
      fs.copyFileSync(SQL_JS_RUNTIME_FIXTURE_PATH, packagedSqlJsRuntimePath);
      fs.copyFileSync(SQL_WASM_FIXTURE_PATH, packagedWasmPath);
      await createB2CliCredentialDatabase(
        dbPath,
        packagedWasmPath,
        "fixture-key-id",
        "fixture-key",
      );

      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        sqlJsRuntimePath: packagedSqlJsRuntimePath,
        sqlWasmPath: packagedWasmPath,
      });

      const credentials = await service.resolveCredentials();

      assert.deepStrictEqual(credentials, {
        keyId: "fixture-key-id",
        appKey: "fixture-key",
      });
      assert.strictEqual(service.getCredentialResolutionWarning(), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records a warning for a malformed B2 CLI database", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    fs.writeFileSync(dbPath, "not sqlite");

    try {
      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        sqlJsRuntimePath: SQL_JS_RUNTIME_FIXTURE_PATH,
        sqlWasmPath: SQL_WASM_FIXTURE_PATH,
      });

      const credentials = await service.resolveCredentials();

      assert.strictEqual(credentials, null);
      assert.match(
        service.getCredentialResolutionWarning() ?? "",
        /CLI credentials could not be read/i,
      );
      assert.match(service.getCredentialResolutionWarning() ?? "", /output log/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records a warning for missing sql.js WASM during CLI credential lookup", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const missingWasmPath = path.join(dir, "missing", SQL_WASM_ASSET.filename);
    fs.writeFileSync(dbPath, "");

    try {
      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        sqlJsRuntimePath: SQL_JS_RUNTIME_FIXTURE_PATH,
        sqlWasmPath: missingWasmPath,
      });

      const credentials = await service.resolveCredentials();

      assert.strictEqual(credentials, null);
      assert.match(
        service.getCredentialResolutionWarning() ?? "",
        /CLI credential auto-detection could not initialize/i,
      );
      assert.doesNotMatch(service.getCredentialResolutionWarning() ?? "", /ENOENT/i);
      assert.strictEqual(
        (service.getCredentialResolutionWarning() ?? "").includes(missingWasmPath),
        false,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records a warning for a sql.js WASM digest mismatch", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const wasmPath = path.join(dir, SQL_WASM_ASSET.filename);
    fs.writeFileSync(dbPath, "");
    fs.writeFileSync(wasmPath, "not the pinned sql.js wasm");

    try {
      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        sqlJsRuntimePath: SQL_JS_RUNTIME_FIXTURE_PATH,
        sqlWasmPath: wasmPath,
      });

      const credentials = await service.resolveCredentials();
      const warning = service.getCredentialResolutionWarning() ?? "";

      assert.strictEqual(credentials, null);
      assert.match(warning, /CLI credential auto-detection could not initialize/i);
      assert.doesNotMatch(warning, /SHA-256/i);
      assert.strictEqual(warning.includes(wasmPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reuses the initialized SQL.js runtime for repeated CLI credential lookups", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");

    try {
      await createB2CliCredentialDatabase(dbPath, SQL_WASM_FIXTURE_PATH, "fixture-key-id", "key");
      const wasmReadCounter = countReadFileSyncForPath(SQL_WASM_FIXTURE_PATH);
      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        sqlJsRuntimePath: SQL_JS_RUNTIME_FIXTURE_PATH,
        sqlWasmPath: SQL_WASM_FIXTURE_PATH,
      });

      try {
        assert.deepStrictEqual(await service.resolveCredentials(), {
          keyId: "fixture-key-id",
          appKey: "key",
        });
        assert.deepStrictEqual(await service.resolveCredentials(), {
          keyId: "fixture-key-id",
          appKey: "key",
        });
        assert.strictEqual(wasmReadCounter.count(), 1);
      } finally {
        wasmReadCounter.restore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves CLI credentials through the bundled extension runtime", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const bundledExtension = require(
      path.join(process.cwd(), "dist", "extension.js"),
    ) as BundledExtensionSmokeExports;

    try {
      await createB2CliCredentialDatabase(
        dbPath,
        SQL_WASM_FIXTURE_PATH,
        "bundled-key-id",
        "bundled-key",
      );

      const resolveBundledCredentials = bundledExtension.__b2VsixSmokeResolveCredentials;
      if (typeof resolveBundledCredentials !== "function") {
        assert.fail("Bundled credential smoke helper was not exported.");
      }
      const credentials = await resolveBundledCredentials(
        dbPath,
        DIST_SQL_JS_RUNTIME_PATH,
        DIST_SQL_WASM_PATH,
      );

      assert.deepStrictEqual(credentials, {
        keyId: "bundled-key-id",
        appKey: "bundled-key",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const errorCode of ["EACCES", "ENOENT", "ENOTDIR"]) {
    test(`records a generic warning when the CLI database read fails with ${errorCode}`, async () => {
      const dir = tempDir();
      const dbPath = path.join(dir, "account_info");
      fs.writeFileSync(dbPath, "");
      const restoreReadFileSync = stubReadFileSyncForPath(dbPath, createFsError(errorCode, dbPath));

      try {
        const service = new AuthService(fakeSecretStorage(), {
          environment: {},
          b2CliDatabasePaths: [dbPath],
          sqlJsRuntimePath: SQL_JS_RUNTIME_FIXTURE_PATH,
          sqlWasmPath: SQL_WASM_FIXTURE_PATH,
        });

        const credentials = await service.resolveCredentials();
        const warning = service.getCredentialResolutionWarning() ?? "";

        assert.strictEqual(credentials, null);
        assert.match(warning, /CLI credentials could not be read/i);
        assert.match(warning, /output log/i);
        assert.doesNotMatch(warning, /auto-detection could not initialize/i);
        assert.strictEqual(warning.includes(dbPath), false);
      } finally {
        restoreReadFileSync();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
