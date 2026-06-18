#!/usr/bin/env node

/**
 * Assert that packaged VSIX files include runtime assets required by the
 * bundled extension. This intentionally reads the final VSIX so packaging
 * changes fail before release.
 *
 * SQL.js runtime/WASM pins are re-derived from the npm-published tarball URL
 * and package integrity recorded in src/sql-wasm-asset.json, not trusted from
 * the local node_modules copy alone.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const zlib = require("zlib");
const JSZip = require("jszip");

const repoRoot = path.join(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const packageLock = require(path.join(repoRoot, "package-lock.json"));
const sqlWasmAsset = require(path.join(repoRoot, "src", "sql-wasm-asset.json"));
const vsixPath =
  process.argv[2] ?? path.join(repoRoot, `${packageJson.name}-${packageJson.version}.vsix`);

const EXPECTED_SQL_WASM_PATH = path.join(repoRoot, sqlWasmAsset.wasmSourcePath);
const EXPECTED_SQL_RUNTIME_PATH = path.join(repoRoot, sqlWasmAsset.runtimeSourcePath);
const SQL_JS_PACKAGE_PATH = `node_modules/${sqlWasmAsset.sqlJsPackageName}`;
const TARBALL_RUNTIME_ENTRY = `package/${sqlWasmAsset.runtimeSourcePath.replace(
  `${SQL_JS_PACKAGE_PATH}/`,
  "",
)}`;
const TARBALL_WASM_ENTRY = `package/${sqlWasmAsset.wasmSourcePath.replace(
  `${SQL_JS_PACKAGE_PATH}/`,
  "",
)}`;
const TEST_ONLY_SMOKE_ENTRY_PATTERN = /^extension\/dist\/bundledCredentialSmoke\.js(?:\.map)?$/;
const FORBIDDEN_EXTENSION_SMOKE_TOKENS = [
  "__b2VsixSmokeResolveCredentials",
  "resolveBundledSmokeCredentials",
  "B2_VSCODE_ENABLE_BUNDLED_CREDENTIAL_SMOKE",
];

const requiredEntries = [
  sqlWasmAsset.packageJsonEntry,
  sqlWasmAsset.extensionBundleEntry,
  sqlWasmAsset.packagedRuntimeEntry,
  sqlWasmAsset.packagedWasmEntry,
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertSqlJsDependencyPinned() {
  const declaredVersion = packageJson.dependencies?.[sqlWasmAsset.sqlJsPackageName];
  if (declaredVersion !== sqlWasmAsset.sqlJsVersion) {
    throw new Error(
      `sql.js dependency must be pinned to ${sqlWasmAsset.sqlJsVersion}; found ${declaredVersion ?? "missing"}`,
    );
  }

  const lockedPackage = packageLock.packages?.[SQL_JS_PACKAGE_PATH];
  if (!lockedPackage) {
    throw new Error(`package-lock.json is missing ${SQL_JS_PACKAGE_PATH}`);
  }
  if (lockedPackage.version !== sqlWasmAsset.sqlJsVersion) {
    throw new Error(
      `package-lock.json must pin ${sqlWasmAsset.sqlJsPackageName} to ${sqlWasmAsset.sqlJsVersion}; found ${lockedPackage.version}`,
    );
  }
  if (lockedPackage.integrity !== sqlWasmAsset.sqlJsPackageIntegrity) {
    throw new Error(
      `${sqlWasmAsset.sqlJsPackageName} package-lock integrity does not match src/sql-wasm-asset.json`,
    );
  }
  if (lockedPackage.resolved !== sqlWasmAsset.sqlJsTarballUrl) {
    throw new Error(
      `${sqlWasmAsset.sqlJsPackageName} package-lock tarball URL does not match src/sql-wasm-asset.json`,
    );
  }
}

function assertSha256(buffer, expectedSha256, label) {
  const actualSha256 = sha256(buffer);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Unexpected SHA-256 for ${label}: ${actualSha256}; expected ${expectedSha256}`);
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

function assertNoForbiddenSmokeHooks(entryName, content) {
  const source = content.toString("utf8");
  for (const token of FORBIDDEN_EXTENSION_SMOKE_TOKENS) {
    if (source.includes(token)) {
      throw new Error(
        `VSIX package contains test-only credential smoke hook ${token} in ${entryName}`,
      );
    }
  }
}

function parseIntegrity(integrity) {
  const match = /^([A-Za-z0-9]+)-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match) {
    throw new Error(`Unsupported npm integrity format: ${integrity}`);
  }

  return { algorithm: match[1], digest: match[2] };
}

function assertIntegrity(buffer, expectedIntegrity, label) {
  const { algorithm, digest } = parseIntegrity(expectedIntegrity);
  const actualDigest = crypto.createHash(algorithm).update(buffer).digest("base64");
  if (actualDigest !== digest) {
    throw new Error(`Unexpected ${algorithm} integrity for ${label}`);
  }
}

function fetchBuffer(url, redirectsRemaining = 3) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`Too many redirects while fetching ${url}`));
          return;
        }
        resolve(fetchBuffer(new URL(location, url).toString(), redirectsRemaining - 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Unexpected HTTP ${statusCode} while fetching ${url}`));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });

    request.on("error", reject);
  });
}

function readTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.toString("utf8", start, boundedEnd);
}

function readTarSize(buffer, offset) {
  const rawSize = readTarString(buffer, offset + 124, 12).trim();
  return rawSize ? Number.parseInt(rawSize, 8) : 0;
}

function extractTarEntries(tarball, entryNames) {
  const wantedEntries = new Set(entryNames);
  const foundEntries = new Map();
  const tar = zlib.gunzipSync(tarball);

  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = readTarString(tar, offset, 100);
    if (!name) {
      break;
    }

    const prefix = readTarString(tar, offset + 345, 155);
    const entryName = prefix ? `${prefix}/${name}` : name;
    const size = readTarSize(tar, offset);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;

    if (wantedEntries.has(entryName)) {
      foundEntries.set(entryName, tar.subarray(dataOffset, dataOffset + size));
    }

    offset = nextOffset;
  }

  for (const entryName of wantedEntries) {
    if (!foundEntries.has(entryName)) {
      throw new Error(`npm tarball is missing expected SQL.js asset: ${entryName}`);
    }
  }

  return foundEntries;
}

async function assertSqlJsPackageProvenance(fetchPackage = fetchBuffer) {
  const tarball = await fetchPackage(sqlWasmAsset.sqlJsTarballUrl);
  assertIntegrity(
    tarball,
    sqlWasmAsset.sqlJsPackageIntegrity,
    `${sqlWasmAsset.sqlJsPackageName}@${sqlWasmAsset.sqlJsVersion} tarball`,
  );

  const tarballEntries = extractTarEntries(tarball, [TARBALL_RUNTIME_ENTRY, TARBALL_WASM_ENTRY]);
  assertSha256(
    tarballEntries.get(TARBALL_RUNTIME_ENTRY),
    sqlWasmAsset.runtimeSha256,
    `${sqlWasmAsset.sqlJsPackageName} npm tarball runtime asset`,
  );
  assertSha256(
    tarballEntries.get(TARBALL_WASM_ENTRY),
    sqlWasmAsset.wasmSha256,
    `${sqlWasmAsset.sqlJsPackageName} npm tarball WASM asset`,
  );
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

async function assertNoTestOnlySmokeArtifacts(zip) {
  for (const entryName of Object.keys(zip.files)) {
    if (TEST_ONLY_SMOKE_ENTRY_PATTERN.test(entryName)) {
      throw new Error(
        `VSIX package contains test-only bundled credential smoke artifact: ${entryName}`,
      );
    }

    if (entryName.endsWith(".js") || entryName.endsWith(".js.map")) {
      const entry = zip.file(entryName);
      if (entry) {
        assertNoForbiddenSmokeHooks(entryName, await entry.async("nodebuffer"));
      }
    }
  }
}

async function assertVsixAssets(packagePath = vsixPath, options = {}) {
  if (!fs.existsSync(packagePath)) {
    throw new Error(`VSIX not found: ${packagePath}`);
  }
  assertSqlJsDependencyPinned();
  if (!options.skipSqlJsPackageProvenance) {
    await assertSqlJsPackageProvenance(options.fetchSqlJsPackage);
  }
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
  await assertNoTestOnlySmokeArtifacts(zip);

  const expectedRuntime = fs.readFileSync(EXPECTED_SQL_RUNTIME_PATH);
  assertSha256(expectedRuntime, sqlWasmAsset.runtimeSha256, "node_modules SQL.js runtime asset");
  const packagedRuntime = packagedContent.get(sqlWasmAsset.packagedRuntimeEntry);
  if (!packagedRuntime) {
    throw new Error(
      `VSIX package is missing required runtime asset: ${sqlWasmAsset.packagedRuntimeEntry}`,
    );
  }
  assertSha256(packagedRuntime, sqlWasmAsset.runtimeSha256, sqlWasmAsset.packagedRuntimeEntry);

  const expectedWasm = fs.readFileSync(EXPECTED_SQL_WASM_PATH);
  assertSha256(expectedWasm, sqlWasmAsset.wasmSha256, "node_modules SQL.js WASM asset");
  const packagedWasm = packagedContent.get(sqlWasmAsset.packagedWasmEntry);
  if (!packagedWasm) {
    throw new Error(
      `VSIX package is missing required runtime asset: ${sqlWasmAsset.packagedWasmEntry}`,
    );
  }
  assertSha256(packagedWasm, sqlWasmAsset.wasmSha256, sqlWasmAsset.packagedWasmEntry);

  const extensionSource = packagedContent.get(sqlWasmAsset.extensionBundleEntry);
  if (!extensionSource) {
    throw new Error(
      `VSIX package is missing required runtime asset: ${sqlWasmAsset.extensionBundleEntry}`,
    );
  }
  assertNoExternalSqlJsImport(extensionSource);
  assertNoForbiddenSmokeHooks(sqlWasmAsset.extensionBundleEntry, extensionSource);
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
  assertSqlJsPackageProvenance,
  assertVsixAssets,
  requiredEntries,
};
