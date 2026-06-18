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

const SQL_WASM_FIXTURE_PATH = path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");

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

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-auth-"));
}

function defaultCompiledSqlWasmPath(): string {
  return path.join(__dirname, "..", "..", "services", "sql-wasm.wasm");
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
    const packagedWasmPath = path.join(packagedRuntimeDir, "sql-wasm.wasm");

    try {
      fs.mkdirSync(packagedRuntimeDir, { recursive: true });
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
        sqlWasmPath: SQL_WASM_FIXTURE_PATH,
      });

      const credentials = await service.resolveCredentials();

      assert.strictEqual(credentials, null);
      assert.match(
        service.getCredentialResolutionWarning() ?? "",
        /CLI credentials could not be read/i,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records a warning for missing sql.js WASM during CLI credential lookup", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "account_info");
    fs.writeFileSync(dbPath, "");
    const defaultWasmPath = defaultCompiledSqlWasmPath();
    const originalDefaultWasm = fs.existsSync(defaultWasmPath)
      ? fs.readFileSync(defaultWasmPath)
      : undefined;

    try {
      fs.rmSync(defaultWasmPath, { force: true });
      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
      });

      const credentials = await service.resolveCredentials();

      assert.strictEqual(credentials, null);
      assert.match(
        service.getCredentialResolutionWarning() ?? "",
        /CLI credential auto-detection could not initialize/i,
      );
      assert.doesNotMatch(service.getCredentialResolutionWarning() ?? "", /ENOENT/i);
      assert.strictEqual(
        (service.getCredentialResolutionWarning() ?? "").includes(defaultWasmPath),
        false,
      );
    } finally {
      if (originalDefaultWasm) {
        fs.writeFileSync(defaultWasmPath, originalDefaultWasm);
      }
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
          sqlWasmPath: SQL_WASM_FIXTURE_PATH,
        });

        const credentials = await service.resolveCredentials();
        const warning = service.getCredentialResolutionWarning() ?? "";

        assert.strictEqual(credentials, null);
        assert.match(warning, /CLI credentials could not be read/i);
        assert.doesNotMatch(warning, /auto-detection could not initialize/i);
        assert.strictEqual(warning.includes(dbPath), false);
      } finally {
        restoreReadFileSync();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
