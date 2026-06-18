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

suite("AuthService credential resolution failures", () => {
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

    try {
      const service = new AuthService(fakeSecretStorage(), {
        environment: {},
        b2CliDatabasePaths: [dbPath],
        sqlWasmPath: path.join(dir, "missing-sql-wasm.wasm"),
      });

      const credentials = await service.resolveCredentials();

      assert.strictEqual(credentials, null);
      assert.match(
        service.getCredentialResolutionWarning() ?? "",
        /CLI credentials could not be read/i,
      );
      assert.match(
        service.getCredentialResolutionWarning() ?? "",
        /ENOENT.*missing-sql-wasm\.wasm/i,
      );
      assert.doesNotMatch(service.getCredentialResolutionWarning() ?? "", /Unexpected error/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
