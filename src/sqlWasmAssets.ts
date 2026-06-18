import * as path from "path";
import sqlWasmAsset from "./sql-wasm-asset.json";

export const SQL_WASM_ASSET = sqlWasmAsset;
export type SqlWasmAssetConfig = typeof SQL_WASM_ASSET;

export function resolveSqlJsRuntimeSourcePath(repoRoot: string): string {
  return path.join(repoRoot, SQL_WASM_ASSET.runtimeSourcePath);
}

export function resolveSqlWasmSourcePath(repoRoot: string): string {
  return path.join(repoRoot, SQL_WASM_ASSET.wasmSourcePath);
}

export function resolvePackagedSqlJsRuntimePath(repoRoot: string): string {
  return path.join(repoRoot, SQL_WASM_ASSET.packagedDistDir, SQL_WASM_ASSET.runtimeFilename);
}

export function resolvePackagedSqlWasmPath(repoRoot: string): string {
  return path.join(repoRoot, SQL_WASM_ASSET.packagedDistDir, SQL_WASM_ASSET.wasmFilename);
}
