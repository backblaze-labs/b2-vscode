/**
 * Credential management and authentication state service.
 *
 * Resolves credentials with 4-tier priority:
 *   1. VS Code SecretStorage (persisted, encrypted)
 *   2. Environment variables (B2_APPLICATION_KEY_ID + B2_APPLICATION_KEY)
 *   3. B2 CLI stored credentials (~/.b2_account_info SQLite database)
 *   4. Not authenticated
 *
 * @module services/authService
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import sqlWasmAsset from "../sql-wasm-asset.json";
import {
  ENV_KEY_ID,
  ENV_APP_KEY,
  SECRET_KEY_ID,
  SECRET_APP_KEY,
  CTX_AUTHENTICATED,
} from "../constants";
import type { B2AuthState } from "../types";
import { log } from "../logger";

type InitSqlJs = typeof import("sql.js").default;
type SqlJsRuntime = Awaited<ReturnType<InitSqlJs>>;

declare const __non_webpack_require__: NodeRequire | undefined;

interface SqlWasmAssetConfig {
  filename: string;
  runtimeFilename: string;
  runtimeSha256: string;
  sha256: string;
}

const SQL_WASM_ASSET: SqlWasmAssetConfig = sqlWasmAsset;

/**
 * Resolved B2 credentials.
 */
export interface B2Credentials {
  keyId: string;
  appKey: string;
}

const SQL_WASM_ASSET_READ_ERROR_CODES = new Set(["EACCES", "ENOENT", "ENOTDIR"]);

class SqlWasmInitializationError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super("Bundled SQL.js runtime asset could not be initialized.");
    this.name = "SqlWasmInitializationError";
    this.originalError = originalError;
  }
}

export interface AuthServiceOptions {
  /** Override environment lookup for tests. Defaults to process.env. */
  environment?: Record<string, string | undefined>;
  /** Override B2 CLI database search paths for tests. */
  b2CliDatabasePaths?: readonly string[];
  /** Override the bundled sql.js WASM path for tests. Defaults to __dirname/sql-wasm.wasm. */
  sqlWasmPath?: string;
  /** Override the bundled sql.js runtime path for tests. Defaults to __dirname/sql-wasm.js. */
  sqlJsRuntimePath?: string;
}

/**
 * Manages B2 credential resolution, persistence, and authentication state.
 */
export class AuthService implements vscode.Disposable {
  private readonly _onAuthStateChanged = new vscode.EventEmitter<B2AuthState>();

  /** Fires whenever the authentication state changes. */
  readonly onAuthStateChanged: vscode.Event<B2AuthState> = this._onAuthStateChanged.event;

  private state: B2AuthState = { isAuthenticated: false };

  private credentialResolutionWarning: string | undefined;

  private sqlRuntimePromise: Promise<SqlJsRuntime> | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly options: AuthServiceOptions = {},
  ) {}

  dispose(): void {
    this._onAuthStateChanged.dispose();
  }

  // ── State ───────────────────────────────────────────────────────────────

  /** Get the current authentication state. */
  getAuthState(): B2AuthState {
    return this.state;
  }

  /** Whether the user is currently authenticated. */
  isAuthenticated(): boolean {
    return this.state.isAuthenticated;
  }

  /** Last non-fatal credential resolution warning, if CLI credentials failed to load. */
  getCredentialResolutionWarning(): string | undefined {
    return this.credentialResolutionWarning;
  }

  /**
   * Update the authentication state and notify listeners.
   */
  async setAuthState(state: B2AuthState): Promise<void> {
    this.state = state;
    await vscode.commands.executeCommand("setContext", CTX_AUTHENTICATED, state.isAuthenticated);
    this._onAuthStateChanged.fire(state);
  }

  // ── Credential Resolution ─────────────────────────────────────────────

  /**
   * Resolve credentials from SecretStorage first, then environment variables.
   * Returns `null` if no credentials are found.
   */
  async resolveCredentials(): Promise<B2Credentials | null> {
    this.credentialResolutionWarning = undefined;

    // 1. VS Code SecretStorage
    const storedKeyId = await this.secrets.get(SECRET_KEY_ID);
    const storedAppKey = await this.secrets.get(SECRET_APP_KEY);
    if (storedKeyId && storedAppKey) {
      return { keyId: storedKeyId, appKey: storedAppKey };
    }

    // 2. Environment variables
    const environment = this.options.environment ?? process.env;
    const envKeyId = environment[ENV_KEY_ID];
    const envAppKey = environment[ENV_APP_KEY];
    if (envKeyId && envAppKey) {
      return { keyId: envKeyId, appKey: envAppKey };
    }

    // 3. B2 CLI stored credentials (SQLite database)
    const cliCreds = await this.resolveB2CliCredentials();
    if (cliCreds) {
      return cliCreds;
    }

    // 4. Not authenticated
    return null;
  }

  /**
   * Store credentials in VS Code SecretStorage.
   */
  async storeCredentials(keyId: string, appKey: string): Promise<void> {
    await this.secrets.store(SECRET_KEY_ID, keyId);
    await this.secrets.store(SECRET_APP_KEY, appKey);
  }

  /**
   * Clear credentials from VS Code SecretStorage.
   */
  async clearCredentials(): Promise<void> {
    await this.secrets.delete(SECRET_KEY_ID);
    await this.secrets.delete(SECRET_APP_KEY);
  }

  // ── B2 CLI Credential Resolution ──────────────────────────────────────

  /**
   * Attempt to read credentials from the B2 CLI's SQLite database.
   *
   * The B2 CLI (`b2` command) stores credentials in a SQLite database at:
   *   - `~/.b2_account_info` (default on all platforms)
   *   - `$XDG_CONFIG_HOME/b2/account_info` (Linux/BSD XDG path)
   *
   * The `account` table contains `account_id_or_app_key_id` and `application_key`.
   * Uses sql.js (pure WASM SQLite) — works on all platforms including Windows.
   */
  private async resolveB2CliCredentials(): Promise<B2Credentials | null> {
    log("CLI-AUTH: Starting B2 CLI credential resolution...");
    const dbPath = this.findB2CliDatabase();
    if (!dbPath) {
      log("CLI-AUTH: No B2 CLI database file found.");
      return null;
    }

    log("CLI-AUTH: Found B2 CLI database.");
    try {
      const result = await this.queryB2Database(dbPath);
      log(`CLI-AUTH: Query result: ${result ? "credentials found" : "no credentials"}`);
      return result;
    } catch (err) {
      log(`CLI-AUTH: Error reading B2 CLI database (${this.formatCredentialErrorForLog(err)}).`);
      this.credentialResolutionWarning = this.buildB2CliCredentialWarning(err);
      return null;
    }
  }

  private buildB2CliCredentialWarning(error: unknown): string {
    if (error instanceof SqlWasmInitializationError) {
      return "B2 CLI credential auto-detection could not initialize. The bundled SQL.js runtime asset is missing, unreadable, or invalid. Check the Backblaze B2 output log for details.";
    }

    return "B2 CLI credentials could not be read. Check file permissions, review the Backblaze B2 output log for details, or run B2: Authenticate to store credentials in VS Code.";
  }

  private formatCredentialErrorForLog(error: unknown): string {
    if (error instanceof SqlWasmInitializationError) {
      const originalCode = this.getErrorCode(error.originalError);
      if (originalCode) {
        return `sql.js runtime initialization failed, code=${originalCode}`;
      }

      const originalDetail =
        error.originalError instanceof Error
          ? `${error.originalError.name}: ${error.originalError.message}`
          : undefined;
      return originalDetail
        ? `sql.js runtime initialization failed (${originalDetail})`
        : "sql.js runtime initialization failed";
    }

    const errorCode = this.getErrorCode(error);
    if (errorCode) {
      return `code=${errorCode}`;
    }

    return error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
  }

  private getErrorCode(error: unknown): string | undefined {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    return typeof errorCode === "string" ? errorCode : undefined;
  }

  private isSqlWasmAssetReadError(error: unknown): boolean {
    const errorCode = this.getErrorCode(error);
    return typeof errorCode === "string" && SQL_WASM_ASSET_READ_ERROR_CODES.has(errorCode);
  }

  private resolveSqlWasmPath(): string {
    return this.options.sqlWasmPath ?? path.join(__dirname, SQL_WASM_ASSET.filename);
  }

  private resolveSqlJsRuntimePath(): string {
    return this.options.sqlJsRuntimePath ?? path.join(__dirname, SQL_WASM_ASSET.runtimeFilename);
  }

  private readVerifiedSqlAssetFile(
    assetPath: string,
    expectedSha256: string,
    label: string,
  ): Buffer {
    try {
      const assetFile = fs.readFileSync(assetPath);
      const actualSha256 = crypto.createHash("sha256").update(assetFile).digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new SqlWasmInitializationError(
          new Error(
            `Bundled SQL.js ${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
          ),
        );
      }

      return assetFile;
    } catch (error) {
      if (error instanceof SqlWasmInitializationError) {
        throw error;
      }
      if (this.isSqlWasmAssetReadError(error)) {
        throw new SqlWasmInitializationError(error);
      }
      throw error;
    }
  }

  private readSqlWasmFile(wasmPath: string): Buffer {
    return this.readVerifiedSqlAssetFile(wasmPath, SQL_WASM_ASSET.sha256, "WASM");
  }

  private verifySqlJsRuntimeFile(runtimePath: string): void {
    this.readVerifiedSqlAssetFile(runtimePath, SQL_WASM_ASSET.runtimeSha256, "runtime");
  }

  private findB2CliDatabase(): string | null {
    if (this.options.b2CliDatabasePaths) {
      for (const candidate of this.options.b2CliDatabasePaths) {
        const candidateExists = fs.existsSync(candidate);
        log(`CLI-AUTH: Checking configured B2 CLI database path -> exists=${candidateExists}`);
        if (candidateExists) {
          return candidate;
        }
      }

      return null;
    }

    const home = os.homedir();
    log("CLI-AUTH: Checking default B2 CLI database locations.");

    const legacyPath = path.join(home, ".b2_account_info");
    const legacyPathExists = fs.existsSync(legacyPath);
    log(`CLI-AUTH: Checking legacy B2 CLI database path -> exists=${legacyPathExists}`);
    if (legacyPathExists) {
      return legacyPath;
    }

    const environment = this.options.environment ?? process.env;
    const xdgHome = environment.XDG_CONFIG_HOME ?? path.join(home, ".config");
    const xdgPath = path.join(xdgHome, "b2", "account_info");
    const xdgPathExists = fs.existsSync(xdgPath);
    log(`CLI-AUTH: Checking XDG B2 CLI database path -> exists=${xdgPathExists}`);
    if (xdgPathExists) {
      return xdgPath;
    }

    return null;
  }

  private async queryB2Database(dbPath: string): Promise<B2Credentials | null> {
    log(`CLI-AUTH: Reading database file...`);
    const fileBuffer = fs.readFileSync(dbPath);
    log(`CLI-AUTH: File size: ${fileBuffer.length} bytes`);

    const SQL = await this.getSqlRuntime();
    const db = new SQL.Database(fileBuffer);
    log("CLI-AUTH: Database opened successfully");

    try {
      const result = db.exec(
        "SELECT account_id_or_app_key_id, application_key FROM account LIMIT 1",
      );
      log(`CLI-AUTH: Query returned ${result.length} result set(s)`);
      if (result.length > 0) {
        log(`CLI-AUTH: First result has ${result[0].values.length} row(s)`);
      }

      if (result.length === 0 || result[0].values.length === 0) {
        return null;
      }

      const row = result[0].values[0];
      const keyId = row[0] as string | null;
      const appKey = row[1] as string | null;

      if (keyId && appKey) {
        log("CLI-AUTH: Found key ID and application key in CLI database.");
        return { keyId, appKey };
      }
      return null;
    } finally {
      db.close();
    }
  }

  private getSqlRuntime(): Promise<SqlJsRuntime> {
    this.sqlRuntimePromise ??= this.initializeSqlRuntime();
    return this.sqlRuntimePromise;
  }

  private loadSqlJsInitializer(): InitSqlJs {
    const runtimePath = this.resolveSqlJsRuntimePath();
    log(`CLI-AUTH: Bundled SQL.js runtime exists=${fs.existsSync(runtimePath)}`);
    this.verifySqlJsRuntimeFile(runtimePath);

    try {
      const runtimeRequire =
        typeof __non_webpack_require__ === "function"
          ? __non_webpack_require__
          : (eval("require") as NodeRequire);
      const loadedRuntime = runtimeRequire(runtimePath) as InitSqlJs | { default?: InitSqlJs };
      const initSqlJs = typeof loadedRuntime === "function" ? loadedRuntime : loadedRuntime.default;

      if (typeof initSqlJs !== "function") {
        throw new Error("SQL.js runtime asset did not export an initializer function.");
      }

      return initSqlJs;
    } catch (error) {
      throw new SqlWasmInitializationError(error);
    }
  }

  private async initializeSqlRuntime(): Promise<SqlJsRuntime> {
    const initSqlJs = this.loadSqlJsInitializer();
    const wasmPath = this.resolveSqlWasmPath();
    log(`CLI-AUTH: Bundled SQL.js WASM exists=${fs.existsSync(wasmPath)}`);

    const wasmBinary = new Uint8Array(this.readSqlWasmFile(wasmPath)).buffer as ArrayBuffer;
    log(`CLI-AUTH: WASM binary size: ${wasmBinary.byteLength} bytes`);

    try {
      const SQL = await initSqlJs({ wasmBinary });
      log("CLI-AUTH: sql.js initialized successfully");
      return SQL;
    } catch (error) {
      throw new SqlWasmInitializationError(error);
    }
  }
}
