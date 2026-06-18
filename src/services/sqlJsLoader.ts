import * as crypto from "crypto";
import * as fs from "fs";
import Module from "module";
import * as path from "path";
import { log } from "../logger";
import { SQL_WASM_ASSET } from "../sqlWasmAssets";

type InitSqlJs = typeof import("sql.js").default;
export type SqlJsRuntime = Awaited<ReturnType<InitSqlJs>>;

interface CompilableNodeModule extends NodeJS.Module {
  _compile(content: string, filename: string): void;
}

interface NodeModuleConstructor {
  new (id: string, parent?: NodeJS.Module): CompilableNodeModule;
  _nodeModulePaths(from: string): string[];
}

export interface SqlJsRuntimeLoaderOptions {
  /** Override the bundled sql.js WASM path for tests. Defaults to __dirname/sql-wasm.wasm. */
  sqlWasmPath?: string;
  /** Override the bundled sql.js runtime path for tests. Defaults to __dirname/sql-wasm.js. */
  sqlJsRuntimePath?: string;
}

const SQL_WASM_ASSET_READ_ERROR_CODES = new Set(["EACCES", "ENOENT", "ENOTDIR"]);
const NodeModule = Module as unknown as NodeModuleConstructor;

export class SqlWasmInitializationError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super("Bundled SQL.js runtime asset could not be initialized.");
    this.name = "SqlWasmInitializationError";
    this.originalError = originalError;
  }
}

export class SqlJsRuntimeLoader {
  private sqlRuntimePromise: Promise<SqlJsRuntime> | undefined;

  constructor(private readonly options: SqlJsRuntimeLoaderOptions = {}) {}

  getRuntime(): Promise<SqlJsRuntime> {
    if (!this.sqlRuntimePromise) {
      this.sqlRuntimePromise = this.initializeSqlRuntime().catch((error: unknown) => {
        this.sqlRuntimePromise = undefined;
        throw error;
      });
    }

    return this.sqlRuntimePromise;
  }

  private resolveSqlWasmPath(): string {
    return this.options.sqlWasmPath ?? path.join(__dirname, SQL_WASM_ASSET.wasmFilename);
  }

  private resolveSqlJsRuntimePath(): string {
    return this.options.sqlJsRuntimePath ?? path.join(__dirname, SQL_WASM_ASSET.runtimeFilename);
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
    return this.readVerifiedSqlAssetFile(wasmPath, SQL_WASM_ASSET.wasmSha256, "WASM");
  }

  private loadSqlJsInitializer(): InitSqlJs {
    const runtimePath = this.resolveSqlJsRuntimePath();
    log(`CLI-AUTH: Bundled SQL.js runtime exists=${fs.existsSync(runtimePath)}`);
    const runtimeSource = this.readVerifiedSqlAssetFile(
      runtimePath,
      SQL_WASM_ASSET.runtimeSha256,
      "runtime",
    );

    try {
      const loadedRuntime = this.compileVerifiedSqlJsRuntime(runtimePath, runtimeSource);
      const initSqlJs = typeof loadedRuntime === "function" ? loadedRuntime : loadedRuntime.default;

      if (typeof initSqlJs !== "function") {
        throw new Error("SQL.js runtime asset did not export an initializer function.");
      }

      return initSqlJs;
    } catch (error) {
      throw new SqlWasmInitializationError(error);
    }
  }

  private compileVerifiedSqlJsRuntime(
    runtimePath: string,
    runtimeSource: Buffer,
  ): InitSqlJs | { default?: InitSqlJs } {
    const runtimeModule = new NodeModule(runtimePath);
    runtimeModule.filename = runtimePath;
    runtimeModule.paths = NodeModule._nodeModulePaths(path.dirname(runtimePath));
    // Compile the verified bytes directly so the executable JS is not re-read after hashing.
    runtimeModule._compile(runtimeSource.toString("utf8"), runtimePath);
    return runtimeModule.exports as InitSqlJs | { default?: InitSqlJs };
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
