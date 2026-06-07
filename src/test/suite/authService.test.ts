/**
 * Tests for AuthService packaged runtime asset resolution.
 *
 * @module test/suite/authService
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveSqlWasmPath } from "../../services/authService";

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-auth-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

suite("AuthService SQL.js WASM path resolution", () => {
  test("uses packaged dist/sql-wasm.wasm next to the bundled extension", () => {
    withTempDir((dir) => {
      const distDir = path.join(dir, "dist");
      fs.mkdirSync(distDir);
      const packagedWasm = path.join(distDir, "sql-wasm.wasm");
      fs.writeFileSync(packagedWasm, "wasm");

      assert.strictEqual(resolveSqlWasmPath(distDir), packagedWasm);
    });
  });

  test("falls back to node_modules path for development checkouts", () => {
    withTempDir((dir) => {
      const distDir = path.join(dir, "dist");
      const devWasmDir = path.join(dir, "node_modules", "sql.js", "dist");
      fs.mkdirSync(distDir);
      fs.mkdirSync(devWasmDir, { recursive: true });
      const devWasm = path.join(devWasmDir, "sql-wasm.wasm");
      fs.writeFileSync(devWasm, "wasm");

      assert.strictEqual(resolveSqlWasmPath(distDir), devWasm);
    });
  });

  test("throws a clear error when the SQL.js WASM asset is missing", () => {
    withTempDir((dir) => {
      const distDir = path.join(dir, "dist");
      fs.mkdirSync(distDir);

      assert.throws(() => resolveSqlWasmPath(distDir), /sql-wasm\.wasm was not found/);
    });
  });
});
