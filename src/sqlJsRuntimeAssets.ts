import * as path from "path";
import sqlJsRuntimeAssets from "./sql-js-runtime-assets.json";

export const SQL_JS_RUNTIME_ASSETS = sqlJsRuntimeAssets;
export type SqlJsRuntimeAssetsConfig = typeof SQL_JS_RUNTIME_ASSETS;

export function resolveSqlJsRuntimeSourcePath(repoRoot: string): string {
  return path.join(repoRoot, SQL_JS_RUNTIME_ASSETS.runtimeSourcePath);
}

export function resolveSqlWasmSourcePath(repoRoot: string): string {
  return path.join(repoRoot, SQL_JS_RUNTIME_ASSETS.wasmSourcePath);
}

export function resolvePackagedSqlJsRuntimePath(repoRoot: string): string {
  return path.join(
    repoRoot,
    SQL_JS_RUNTIME_ASSETS.packagedDistDir,
    SQL_JS_RUNTIME_ASSETS.runtimeFilename,
  );
}

export function resolvePackagedSqlWasmPath(repoRoot: string): string {
  return path.join(
    repoRoot,
    SQL_JS_RUNTIME_ASSETS.packagedDistDir,
    SQL_JS_RUNTIME_ASSETS.wasmFilename,
  );
}
