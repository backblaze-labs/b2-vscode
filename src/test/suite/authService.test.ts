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
      fs.copyFileSync(
        path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
        packagedWasmPath,
      );
      await createB2CliCredentialDatabase(
        dbPath,
        packagedWasmPath,
        "fixture-key-id",
        "fixture-key",
      );

      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        extensionRuntimeDirectory: packagedRuntimeDir,
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
        sqlWasmPath: path.join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"),
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
    const runtimeDir = path.join(dir, "runtime");

    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        extensionRuntimeDirectory: runtimeDir,
      });

      const credentials = await service.resolveCredentials();

      assert.strictEqual(credentials, null);
      assert.match(
        service.getCredentialResolutionWarning() ?? "",
        /CLI credential auto-detection could not initialize/i,
      );
      assert.match(service.getCredentialResolutionWarning() ?? "", /ENOENT.*sql-wasm\.wasm/i);
      assert.doesNotMatch(service.getCredentialResolutionWarning() ?? "", /Unexpected error/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
