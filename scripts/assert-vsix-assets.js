#!/usr/bin/env node

/**
 * Assert that packaged VSIX files include runtime assets required by the
 * bundled extension. This intentionally reads the final VSIX so packaging
 * changes fail before release.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const JSZip = require("jszip");

const repoRoot = path.join(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const sqlWasmAsset = require(path.join(repoRoot, "src", "sql-wasm-asset.json"));
const vsixPath =
  process.argv[2] ?? path.join(repoRoot, `${packageJson.name}-${packageJson.version}.vsix`);

const PACKAGED_SQL_WASM_ENTRY = path.posix.join(
  "extension",
  sqlWasmAsset.packagedDistDir,
  sqlWasmAsset.filename,
);
const PACKAGED_SQL_RUNTIME_ENTRY = path.posix.join(
  "extension",
  sqlWasmAsset.packagedDistDir,
  sqlWasmAsset.runtimeFilename,
);
const EXPECTED_SQL_WASM_PATH = path.join(repoRoot, sqlWasmAsset.sourcePath);
const EXPECTED_SQL_RUNTIME_PATH = path.join(repoRoot, sqlWasmAsset.runtimeSourcePath);

const requiredEntries = [
  "extension/package.json",
  "extension/dist/extension.js",
  PACKAGED_SQL_RUNTIME_ENTRY,
  PACKAGED_SQL_WASM_ENTRY,
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertSqlJsDependencyPinned() {
  const declaredVersion = packageJson.dependencies?.["sql.js"];
  if (declaredVersion !== sqlWasmAsset.sqlJsVersion) {
    throw new Error(
      `sql.js dependency must be pinned to ${sqlWasmAsset.sqlJsVersion}; found ${declaredVersion ?? "missing"}`,
    );
  }
}

function assertSha256(buffer, expectedSha256, label) {
  const actualSha256 = sha256(buffer);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Unexpected SHA-256 for ${label}: ${actualSha256}; expected ${expectedSha256}`,
    );
  }
}

function assertNoExternalSqlJsImport(extensionSource) {
  const source = extensionSource.toString("utf8");
  const externalSqlJsPatterns = [
    /\brequire\s*\(\s*["']sql\.js["']\s*\)/,
    /\bimport\s*\(\s*["']sql\.js["']\s*\)/,
    /\bfrom\s*["']sql\.js["']/,
  ];

  for (const pattern of externalSqlJsPatterns) {
    if (pattern.test(source)) {
      throw new Error(
        "VSIX package contains an unresolved sql.js import; sql.js must be bundled into extension/dist/extension.js",
      );
    }
  }
}

async function readRequiredEntry(zip, entryName) {
  const entry = zip.file(entryName);
  if (!entry) {
    throw new Error(`VSIX package is missing required runtime asset: ${entryName}`);
  }

  const content = await entry.async("nodebuffer");
  if (content.length === 0) {
    throw new Error(`VSIX package entry is empty: ${entryName}`);
  }

  return content;
}

async function assertVsixAssets(packagePath = vsixPath) {
  if (!fs.existsSync(packagePath)) {
    throw new Error(`VSIX not found: ${packagePath}`);
  }
  assertSqlJsDependencyPinned();
  if (!fs.existsSync(EXPECTED_SQL_WASM_PATH)) {
    throw new Error(`Expected SQL.js WASM asset not found: ${EXPECTED_SQL_WASM_PATH}`);
  }
  if (!fs.existsSync(EXPECTED_SQL_RUNTIME_PATH)) {
    throw new Error(`Expected SQL.js runtime asset not found: ${EXPECTED_SQL_RUNTIME_PATH}`);
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  const packagedEntries = await Promise.all(
    requiredEntries.map(async (entryName) => [entryName, await readRequiredEntry(zip, entryName)]),
  );
  const packagedContent = new Map(packagedEntries);
  const expectedRuntime = fs.readFileSync(EXPECTED_SQL_RUNTIME_PATH);
  assertSha256(expectedRuntime, sqlWasmAsset.runtimeSha256, "node_modules SQL.js runtime asset");
  const packagedRuntime = packagedContent.get(PACKAGED_SQL_RUNTIME_ENTRY);
  if (!packagedRuntime) {
    throw new Error(`VSIX package is missing required runtime asset: ${PACKAGED_SQL_RUNTIME_ENTRY}`);
  }
  assertSha256(packagedRuntime, sqlWasmAsset.runtimeSha256, PACKAGED_SQL_RUNTIME_ENTRY);

  const expectedWasm = fs.readFileSync(EXPECTED_SQL_WASM_PATH);
  assertSha256(expectedWasm, sqlWasmAsset.sha256, "node_modules SQL.js WASM asset");
  const packagedWasm = packagedContent.get(PACKAGED_SQL_WASM_ENTRY);
  if (!packagedWasm) {
    throw new Error(`VSIX package is missing required runtime asset: ${PACKAGED_SQL_WASM_ENTRY}`);
  }
  assertSha256(packagedWasm, sqlWasmAsset.sha256, PACKAGED_SQL_WASM_ENTRY);

  const extensionSource = packagedContent.get("extension/dist/extension.js");
  if (!extensionSource) {
    throw new Error("VSIX package is missing required runtime asset: extension/dist/extension.js");
  }
  assertNoExternalSqlJsImport(extensionSource);
}

async function main() {
  try {
    await assertVsixAssets();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Could not verify VSIX runtime assets: ${detail}`);
    process.exit(1);
  }

  console.log(`VSIX runtime assets verified: ${requiredEntries.join(", ")}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  assertVsixAssets,
  requiredEntries,
};
