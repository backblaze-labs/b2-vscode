/**
 * Tests for AuthService credential resolution and packaged SQL.js loading.
 *
 * @module test/suite/authService
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs from "sql.js";
import { AuthService } from "../../services/authService";
import { createNoopSecretStorage } from "../../testSupport/noopSecretStorage";
import {
  BUNDLED_CREDENTIAL_SMOKE_ENV,
  type BundledCredentialSmokeResolver,
} from "../../testSupport/bundledCredentialSmoke";
import {
  resolveSqlJsRuntimeSourcePath,
  resolveSqlWasmSourcePath,
  SQL_JS_RUNTIME_ASSETS,
} from "../../sqlJsRuntimeAssets";

interface BundledExtensionSmokeExports {
  __b2VsixSmokeResolveCredentials?: unknown;
}

interface BundledCredentialSmokeExports {
  resolveBundledCredentialSmoke: BundledCredentialSmokeResolver;
}

const SQL_JS_RUNTIME_FIXTURE_PATH = resolveSqlJsRuntimeSourcePath(process.cwd());
const SQL_WASM_FIXTURE_PATH = resolveSqlWasmSourcePath(process.cwd());
const DIST_EXTENSION_PATH = path.join(process.cwd(), "dist", "extension.js");
const DIST_BUNDLED_CREDENTIAL_SMOKE_PATH = path.join(
  process.cwd(),
  "dist",
  "bundledCredentialSmoke.js",
);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-auth-"));
}

function loadBundledExtension(): BundledExtensionSmokeExports {
  delete require.cache[require.resolve(DIST_EXTENSION_PATH)];
  return require(DIST_EXTENSION_PATH) as BundledExtensionSmokeExports;
}

function loadBundledCredentialSmoke(): BundledCredentialSmokeExports {
  delete require.cache[require.resolve(DIST_BUNDLED_CREDENTIAL_SMOKE_PATH)];
  return require(DIST_BUNDLED_CREDENTIAL_SMOKE_PATH) as BundledCredentialSmokeExports;
}

async function withBundledCredentialSmokeEnv<T>(
  value: string | undefined,
  action: () => Promise<T>,
) {
  const previousValue = process.env[BUNDLED_CREDENTIAL_SMOKE_ENV];
  if (value === undefined) {
    delete process.env[BUNDLED_CREDENTIAL_SMOKE_ENV];
  } else {
    process.env[BUNDLED_CREDENTIAL_SMOKE_ENV] = value;
  }

  try {
    return await action();
  } finally {
    if (previousValue === undefined) {
      delete process.env[BUNDLED_CREDENTIAL_SMOKE_ENV];
    } else {
      process.env[BUNDLED_CREDENTIAL_SMOKE_ENV] = previousValue;
    }
  }
}

function createFsError(code: string, filePath: string): NodeJS.ErrnoException {
  const error = new Error(
    `${code}: simulated failure, open '${filePath}'`,
  ) as NodeJS.ErrnoException;
  error.code = code;
  error.path = filePath;
  return error;
}

function createCodelessPathError(filePath: string): Error {
  return new Error(`codeless database read failed at ${filePath}`);
}

function stubReadFileSyncForPath(filePath: string, error: Error): () => void {
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

function stubReadFileSyncForPathOnce(filePath: string, error: Error): () => void {
  const mutableFs = require("fs") as { readFileSync: typeof fs.readFileSync };
  const originalReadFileSync = mutableFs.readFileSync;
  let hasFailed = false;

  mutableFs.readFileSync = ((pathLike: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (pathLike === filePath && !hasFailed) {
      hasFailed = true;
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

suite("AuthService credential resolution and SQL.js loading", () => {
  test("reads CLI credentials from a packaged SQL.js WASM layout", async () => {
    const dir = tempDir();
    const packagedRuntimeDir = path.join(dir, "dist");
    const dbPath = path.join(dir, "account_info");
    const packagedSqlJsRuntimePath = path.join(
      packagedRuntimeDir,
      SQL_JS_RUNTIME_ASSETS.runtimeFilename,
    );
    const packagedWasmPath = path.join(packagedRuntimeDir, SQL_JS_RUNTIME_ASSETS.wasmFilename);

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

      const service = new AuthService(createNoopSecretStorage(), {
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
      const service = new AuthService(createNoopSecretStorage(), {
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

  test("sanitizes codeless filesystem paths in CLI credential error logs", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");

    try {
      const service = new AuthService(createNoopSecretStorage(), {
        environment: {},
      });
      const formattedError = (
        service as unknown as { formatCredentialErrorForLog(error: unknown): string }
      ).formatCredentialErrorForLog(createCodelessPathError(dbPath));

      assert.match(formattedError, /Error: codeless database read failed at <path>/i);
      assert.strictEqual(formattedError.includes(dbPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records a warning for missing sql.js WASM during CLI credential lookup", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const missingWasmPath = path.join(dir, "missing", SQL_JS_RUNTIME_ASSETS.wasmFilename);
    fs.writeFileSync(dbPath, "");

    try {
      const service = new AuthService(createNoopSecretStorage(), {
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

  for (const errorCode of ["EACCES", "EISDIR", "ENOTDIR", "EPERM"]) {
    test(`records an initialization warning when the SQL.js WASM read fails with ${errorCode}`, async () => {
      const dir = tempDir();
      const dbPath = path.join(dir, "account_info");
      fs.writeFileSync(dbPath, "");
      const restoreReadFileSync = stubReadFileSyncForPath(
        SQL_WASM_FIXTURE_PATH,
        createFsError(errorCode, SQL_WASM_FIXTURE_PATH),
      );

      try {
        const service = new AuthService(createNoopSecretStorage(), {
          environment: {},
          b2CliDatabasePaths: [dbPath],
          sqlJsRuntimePath: SQL_JS_RUNTIME_FIXTURE_PATH,
          sqlWasmPath: SQL_WASM_FIXTURE_PATH,
        });

        const credentials = await service.resolveCredentials();
        const warning = service.getCredentialResolutionWarning() ?? "";

        assert.strictEqual(credentials, null);
        assert.match(warning, /CLI credential auto-detection could not initialize/i);
        assert.doesNotMatch(warning, new RegExp(errorCode, "i"));
        assert.strictEqual(warning.includes(SQL_WASM_FIXTURE_PATH), false);
      } finally {
        restoreReadFileSync();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("records a warning for a sql.js WASM digest mismatch", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const wasmPath = path.join(dir, SQL_JS_RUNTIME_ASSETS.wasmFilename);
    fs.writeFileSync(dbPath, "");
    fs.writeFileSync(wasmPath, "not the pinned sql.js wasm");

    try {
      const wasmReadCounter = countReadFileSyncForPath(wasmPath);
      const service = new AuthService(createNoopSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        sqlJsRuntimePath: SQL_JS_RUNTIME_FIXTURE_PATH,
        sqlWasmPath: wasmPath,
      });

      try {
        const credentials = await service.resolveCredentials();
        const warning = service.getCredentialResolutionWarning() ?? "";

        assert.strictEqual(credentials, null);
        assert.match(warning, /CLI credential auto-detection could not initialize/i);
        assert.doesNotMatch(warning, /SHA-256/i);
        assert.strictEqual(warning.includes(wasmPath), false);

        assert.strictEqual(await service.resolveCredentials(), null);
        assert.strictEqual(wasmReadCounter.count(), 1);
      } finally {
        wasmReadCounter.restore();
      }
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
      const service = new AuthService(createNoopSecretStorage(), {
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

  test("retries SQL.js initialization after a transient asset read failure", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");

    try {
      await createB2CliCredentialDatabase(
        dbPath,
        SQL_WASM_FIXTURE_PATH,
        "retry-key-id",
        "retry-key",
      );
      const restoreReadFileSync = stubReadFileSyncForPathOnce(
        SQL_WASM_FIXTURE_PATH,
        createFsError("EACCES", SQL_WASM_FIXTURE_PATH),
      );
      const service = new AuthService(createNoopSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        sqlJsRuntimePath: SQL_JS_RUNTIME_FIXTURE_PATH,
        sqlWasmPath: SQL_WASM_FIXTURE_PATH,
      });

      try {
        assert.strictEqual(await service.resolveCredentials(), null);
        assert.match(
          service.getCredentialResolutionWarning() ?? "",
          /credential auto-detection could not initialize/i,
        );
        assert.deepStrictEqual(await service.resolveCredentials(), {
          keyId: "retry-key-id",
          appKey: "retry-key",
        });
        assert.strictEqual(service.getCredentialResolutionWarning(), undefined);
      } finally {
        restoreReadFileSync();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executes the verified SQL.js runtime bytes when the file changes after read", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const runtimePath = path.join(dir, SQL_JS_RUNTIME_ASSETS.runtimeFilename);
    const wasmPath = path.join(dir, SQL_JS_RUNTIME_ASSETS.wasmFilename);
    const sideEffectPath = path.join(dir, "swapped-runtime-executed");

    try {
      fs.copyFileSync(SQL_JS_RUNTIME_FIXTURE_PATH, runtimePath);
      fs.copyFileSync(SQL_WASM_FIXTURE_PATH, wasmPath);
      await createB2CliCredentialDatabase(dbPath, wasmPath, "verified-key-id", "verified-key");

      const mutableFs = require("fs") as { readFileSync: typeof fs.readFileSync };
      const originalReadFileSync = mutableFs.readFileSync;
      let runtimeWasSwapped = false;
      mutableFs.readFileSync = ((pathLike: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        const result = (originalReadFileSync as (...readArgs: unknown[]) => unknown)(
          pathLike,
          ...args,
        );
        if (pathLike === runtimePath && !runtimeWasSwapped) {
          runtimeWasSwapped = true;
          fs.writeFileSync(
            runtimePath,
            `require("fs").writeFileSync(${JSON.stringify(sideEffectPath)}, "executed");
module.exports = function swappedSqlJsRuntime() {
  throw new Error("swapped SQL.js runtime executed");
};`,
          );
        }

        return result;
      }) as typeof fs.readFileSync;

      try {
        const service = new AuthService(createNoopSecretStorage(), {
          environment: {},
          b2CliDatabasePaths: [dbPath],
          sqlJsRuntimePath: runtimePath,
          sqlWasmPath: wasmPath,
        });

        assert.deepStrictEqual(await service.resolveCredentials(), {
          keyId: "verified-key-id",
          appKey: "verified-key",
        });
        assert.strictEqual(runtimeWasSwapped, true);
        assert.strictEqual(fs.existsSync(sideEffectPath), false);
      } finally {
        mutableFs.readFileSync = originalReadFileSync;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads CLI credentials from default SQL.js asset paths", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const compiledServiceDir = path.join(process.cwd(), "out", "src", "services");
    const defaultRuntimePath = path.join(compiledServiceDir, SQL_JS_RUNTIME_ASSETS.runtimeFilename);
    const defaultWasmPath = path.join(compiledServiceDir, SQL_JS_RUNTIME_ASSETS.wasmFilename);

    try {
      await createB2CliCredentialDatabase(
        dbPath,
        SQL_WASM_FIXTURE_PATH,
        "default-path-key-id",
        "default-path-key",
      );
      fs.copyFileSync(SQL_JS_RUNTIME_FIXTURE_PATH, defaultRuntimePath);
      fs.copyFileSync(SQL_WASM_FIXTURE_PATH, defaultWasmPath);

      const service = new AuthService(createNoopSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
      });

      assert.deepStrictEqual(await service.resolveCredentials(), {
        keyId: "default-path-key-id",
        appKey: "default-path-key",
      });
    } finally {
      fs.rmSync(defaultRuntimePath, { force: true });
      fs.rmSync(defaultWasmPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not expose the bundled credential smoke helper from the production bundle", () => {
    const bundledExtension = loadBundledExtension();

    // Legacy smoke hooks are intentionally absent from the production entrypoint.
    assert.strictEqual(bundledExtension.__b2VsixSmokeResolveCredentials, undefined);
  });

  test("keeps the bundled smoke artifact inert without the smoke env flag", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const bundledSmoke = loadBundledCredentialSmoke();

    try {
      await createB2CliCredentialDatabase(
        dbPath,
        SQL_WASM_FIXTURE_PATH,
        "bundled-key-id",
        "bundled-key",
      );
      const readCounter = countReadFileSyncForPath(dbPath);

      try {
        const credentials = await withBundledCredentialSmokeEnv(undefined, () =>
          bundledSmoke.resolveBundledCredentialSmoke(dbPath),
        );

        assert.strictEqual(credentials, null);
        assert.strictEqual(readCounter.count(), 0);
      } finally {
        readCounter.restore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves CLI credentials through the bundled smoke artifact", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    const bundledSmoke = loadBundledCredentialSmoke();

    try {
      await createB2CliCredentialDatabase(
        dbPath,
        SQL_WASM_FIXTURE_PATH,
        "bundled-key-id",
        "bundled-key",
      );

      const credentials = await withBundledCredentialSmokeEnv("1", () =>
        bundledSmoke.resolveBundledCredentialSmoke(dbPath),
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
        const service = new AuthService(createNoopSecretStorage(), {
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
