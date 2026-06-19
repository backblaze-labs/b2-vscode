#!/usr/bin/env node

/**
 * Assert that packaged VSIX files include runtime assets required by the
 * bundled extension. This intentionally reads the final VSIX so packaging
 * changes fail before release.
 *
 * SQL.js runtime/WASM pins are re-derived from the npm-published tarball URL
 * and package integrity recorded in src/sql-js-runtime-assets.json, not trusted from
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
const sqlJsRuntimeAssets = require(path.join(repoRoot, "src", "sql-js-runtime-assets.json"));
const defaultVsixPath = path.join(repoRoot, `${packageJson.name}-${packageJson.version}.vsix`);

const EXPECTED_SQL_WASM_PATH = path.join(repoRoot, sqlJsRuntimeAssets.wasmSourcePath);
const EXPECTED_SQL_RUNTIME_PATH = path.join(repoRoot, sqlJsRuntimeAssets.runtimeSourcePath);
const SQL_JS_PACKAGE_PATH = `node_modules/${sqlJsRuntimeAssets.sqlJsPackageName}`;
const TARBALL_RUNTIME_ENTRY = `package/${sqlJsRuntimeAssets.runtimeSourcePath.replace(
  `${SQL_JS_PACKAGE_PATH}/`,
  "",
)}`;
const TARBALL_WASM_ENTRY = `package/${sqlJsRuntimeAssets.wasmSourcePath.replace(
  `${SQL_JS_PACKAGE_PATH}/`,
  "",
)}`;
const TEST_ONLY_SMOKE_ENTRY_PATTERN = /^extension\/dist\/bundledCredentialSmoke\.js(?:\.map)?$/;
const FORBIDDEN_EXTENSION_SMOKE_TOKENS = [
  "__b2VsixSmokeResolveCredentials",
  "resolveBundledCredentialSmoke",
  "B2_VSCODE_ENABLE_BUNDLED_CREDENTIAL_SMOKE",
];
const PACKAGE_FETCH_TIMEOUT_MS = 15000;
const PACKAGE_FETCH_RETRY_DELAYS_MS = [250, 1000];
const SKIP_SQL_JS_PROVENANCE_ENV = "B2_VSCODE_SKIP_SQLJS_PROVENANCE_FETCH";

const requiredEntries = [
  sqlJsRuntimeAssets.packageJsonEntry,
  sqlJsRuntimeAssets.extensionBundleEntry,
  sqlJsRuntimeAssets.packagedRuntimeEntry,
  sqlJsRuntimeAssets.packagedWasmEntry,
];

const requiredPackageEntries = [
  "extension/resources/b2-icon.png",
  "extension/resources/b2-icon.svg",
  "extension/resources/b2-icons.woff",
];

const requiredVsixEntries = [...requiredEntries, ...requiredPackageEntries];

const requiredDistFiles = [
  sqlJsRuntimeAssets.runtimeFilename,
  sqlJsRuntimeAssets.wasmFilename,
  path.basename(sqlJsRuntimeAssets.extensionBundleEntry),
];

const expectedRepositoryUrl = "https://github.com/backblaze-labs/b2-vscode.git";

const requiredCommands = [
  "b2.authenticate",
  "b2.logout",
  "b2.refresh",
  "b2.loadMore",
  "b2.copyPath",
  "b2.copyFileId",
  "b2.openFile",
  "b2.createBucket",
  "b2.changeBucketVisibility",
  "b2.createFolder",
  "b2.deleteBucket",
  "b2.deleteFolder",
  "b2.deleteFile",
  "b2.renameFile",
];

const requiredLanguageModelTools = [
  "b2_listBuckets",
  "b2_listFiles",
  "b2_getFileInfo",
  "b2_downloadFile",
  "b2_uploadFile",
  "b2_deleteFile",
  "b2_presignUrl",
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertSqlJsDependencyPinned() {
  const declaredVersion = packageJson.dependencies?.[sqlJsRuntimeAssets.sqlJsPackageName];
  if (declaredVersion !== sqlJsRuntimeAssets.sqlJsVersion) {
    throw new Error(
      `sql.js dependency must be pinned to ${sqlJsRuntimeAssets.sqlJsVersion}; found ${declaredVersion ?? "missing"}`,
    );
  }

  const lockedPackage = packageLock.packages?.[SQL_JS_PACKAGE_PATH];
  if (!lockedPackage) {
    throw new Error(`package-lock.json is missing ${SQL_JS_PACKAGE_PATH}`);
  }
  if (lockedPackage.version !== sqlJsRuntimeAssets.sqlJsVersion) {
    throw new Error(
      `package-lock.json must pin ${sqlJsRuntimeAssets.sqlJsPackageName} to ${sqlJsRuntimeAssets.sqlJsVersion}; found ${lockedPackage.version}`,
    );
  }
  if (lockedPackage.integrity !== sqlJsRuntimeAssets.sqlJsPackageIntegrity) {
    throw new Error(
      `${sqlJsRuntimeAssets.sqlJsPackageName} package-lock integrity does not match src/sql-js-runtime-assets.json`,
    );
  }
  if (lockedPackage.resolved !== sqlJsRuntimeAssets.sqlJsTarballUrl) {
    throw new Error(
      `${sqlJsRuntimeAssets.sqlJsPackageName} package-lock tarball URL does not match src/sql-js-runtime-assets.json`,
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`,
    );
  }
}

function assertArrayIncludesValues(values, requiredValues, label) {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array.`);
  }

  const availableValues = new Set(values);
  const missingValues = requiredValues.filter((value) => !availableValues.has(value));
  if (missingValues.length > 0) {
    throw new Error(`${label} missing required value(s): ${missingValues.join(", ")}`);
  }
}

function assertObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function parseJsonBuffer(buffer, label) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
}

function assertContributionManifest(manifest) {
  assertEqual(manifest.name, packageJson.name, "package name");
  assertEqual(manifest.publisher, packageJson.publisher, "package publisher");
  assertEqual(manifest.version, packageJson.version, "package version");
  assertEqual(manifest.main, "./dist/extension.js", "package main");
  assertEqual(manifest.icon, "resources/b2-icon.png", "package icon");

  const repository = assertObject(manifest.repository, "package repository");
  assertEqual(repository.type, "git", "package repository type");
  assertEqual(repository.url, expectedRepositoryUrl, "package repository URL");

  const contributes = assertObject(manifest.contributes, "package contributes");
  const icons = assertObject(contributes.icons, "package contributes.icons");
  const flameIcon = assertObject(icons["backblaze-flame"], "backblaze-flame icon contribution");
  const flameIconDefault = assertObject(
    flameIcon.default,
    "backblaze-flame default icon contribution",
  );
  assertEqual(flameIconDefault.fontPath, "./resources/b2-icons.woff", "backblaze-flame fontPath");

  const viewsContainers = assertObject(
    contributes.viewsContainers,
    "package contributes.viewsContainers",
  );
  const activityBarContainers = viewsContainers.activitybar;
  if (!Array.isArray(activityBarContainers)) {
    throw new Error("package contributes.viewsContainers.activitybar must be an array.");
  }
  if (!activityBarContainers.some((container) => container.id === "b2Explorer")) {
    throw new Error("package contributes.viewsContainers.activitybar missing b2Explorer.");
  }

  const views = assertObject(contributes.views, "package contributes.views");
  const b2ExplorerViews = views.b2Explorer;
  if (!Array.isArray(b2ExplorerViews)) {
    throw new Error("package contributes.views.b2Explorer must be an array.");
  }
  if (!b2ExplorerViews.some((view) => view.id === "b2Buckets")) {
    throw new Error("package contributes.views.b2Explorer missing b2Buckets.");
  }

  const commands = contributes.commands;
  if (!Array.isArray(commands)) {
    throw new Error("package contributes.commands must be an array.");
  }
  const commandIds = commands.map((command) => command.command);
  assertArrayIncludesValues(commandIds, requiredCommands, "package contributes.commands");

  const menus = assertObject(contributes.menus, "package contributes.menus");
  if (!Array.isArray(menus["view/title"]) || !Array.isArray(menus["view/item/context"])) {
    throw new Error("package contributes.menus missing required tree view menu arrays.");
  }

  const configuration = assertObject(contributes.configuration, "package contributes.configuration");
  const configurationProperties = assertObject(
    configuration.properties,
    "package contributes.configuration.properties",
  );
  const apiUrlConfig = assertObject(
    configurationProperties["b2.apiUrl"],
    "b2.apiUrl configuration contribution",
  );
  assertEqual(apiUrlConfig.scope, "application", "b2.apiUrl configuration scope");

  const languageModelTools = contributes.languageModelTools;
  if (!Array.isArray(languageModelTools)) {
    throw new Error("package contributes.languageModelTools must be an array.");
  }
  const toolIds = languageModelTools.map((tool) => tool.name);
  assertArrayIncludesValues(
    toolIds,
    requiredLanguageModelTools,
    "package contributes.languageModelTools",
  );
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

function httpFetchError(url, statusCode) {
  const error = new Error(`Unexpected HTTP ${statusCode} while fetching ${url}`);
  error.statusCode = statusCode;
  return error;
}

function timeoutFetchError(url, timeoutMs) {
  const error = new Error(`Timed out fetching ${url} after ${timeoutMs}ms`);
  error.code = "ETIMEDOUT";
  return error;
}

function isRetryableFetchError(error) {
  const statusCode =
    typeof error === "object" && error !== null && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  if (statusCode !== undefined) {
    return statusCode === 408 || statusCode === 429 || statusCode >= 500;
  }

  const errorCode =
    typeof error === "object" && error !== null && typeof error.code === "string"
      ? error.code
      : undefined;
  return (
    errorCode === "EAI_AGAIN" ||
    errorCode === "ECONNRESET" ||
    errorCode === "ECONNREFUSED" ||
    errorCode === "EHOSTUNREACH" ||
    errorCode === "ENETUNREACH" ||
    errorCode === "ENOTFOUND" ||
    errorCode === "ETIMEDOUT"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchBuffer(url, redirectsRemaining = 3, timeoutMs = PACKAGE_FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    const request = https.get(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          finish(reject, new Error(`Too many redirects while fetching ${url}`));
          return;
        }
        finish(resolve, fetchBuffer(new URL(location, url).toString(), redirectsRemaining - 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        finish(reject, httpFetchError(url, statusCode));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => finish(resolve, Buffer.concat(chunks)));
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(timeoutFetchError(url, timeoutMs));
    });
    request.on("error", (error) => finish(reject, error));
  });
}

async function fetchBufferWithRetries(
  url,
  fetchPackage = fetchBuffer,
  retryDelaysMs = PACKAGE_FETCH_RETRY_DELAYS_MS,
) {
  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      return await fetchPackage(url);
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt === retryDelaysMs.length) {
        throw error;
      }

      await sleep(retryDelaysMs[attempt]);
    }
  }

  throw lastError;
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

function assertLocalSqlJsAssetPins() {
  if (!fs.existsSync(EXPECTED_SQL_WASM_PATH)) {
    throw new Error(`Expected SQL.js WASM asset not found: ${EXPECTED_SQL_WASM_PATH}`);
  }
  if (!fs.existsSync(EXPECTED_SQL_RUNTIME_PATH)) {
    throw new Error(`Expected SQL.js runtime asset not found: ${EXPECTED_SQL_RUNTIME_PATH}`);
  }

  const expectedRuntime = fs.readFileSync(EXPECTED_SQL_RUNTIME_PATH);
  assertSha256(
    expectedRuntime,
    sqlJsRuntimeAssets.runtimeSha256,
    "node_modules SQL.js runtime asset",
  );

  const expectedWasm = fs.readFileSync(EXPECTED_SQL_WASM_PATH);
  assertSha256(expectedWasm, sqlJsRuntimeAssets.wasmSha256, "node_modules SQL.js WASM asset");
}

async function assertSqlJsPackageProvenance(fetchPackage = fetchBuffer, options = {}) {
  let tarball;
  try {
    tarball = await fetchBufferWithRetries(
      sqlJsRuntimeAssets.sqlJsTarballUrl,
      fetchPackage,
      options.retryDelaysMs,
    );
  } catch (error) {
    if (!isRetryableFetchError(error) || options.allowLocalFallback === false) {
      throw error;
    }

    assertLocalSqlJsAssetPins();
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `SQL.js npm provenance fetch unavailable (${detail}); verified local pinned assets instead.`,
    );
    return;
  }

  assertIntegrity(
    tarball,
    sqlJsRuntimeAssets.sqlJsPackageIntegrity,
    `${sqlJsRuntimeAssets.sqlJsPackageName}@${sqlJsRuntimeAssets.sqlJsVersion} tarball`,
  );

  const tarballEntries = extractTarEntries(tarball, [TARBALL_RUNTIME_ENTRY, TARBALL_WASM_ENTRY]);
  assertSha256(
    tarballEntries.get(TARBALL_RUNTIME_ENTRY),
    sqlJsRuntimeAssets.runtimeSha256,
    `${sqlJsRuntimeAssets.sqlJsPackageName} npm tarball runtime asset`,
  );
  assertSha256(
    tarballEntries.get(TARBALL_WASM_ENTRY),
    sqlJsRuntimeAssets.wasmSha256,
    `${sqlJsRuntimeAssets.sqlJsPackageName} npm tarball WASM asset`,
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

function assertNoTestOnlySmokeArtifactEntry(entryName) {
  if (TEST_ONLY_SMOKE_ENTRY_PATTERN.test(entryName)) {
    throw new Error(`Package contains test-only bundled credential smoke artifact: ${entryName}`);
  }
}

async function assertNoTestOnlySmokeArtifacts(zip) {
  for (const entryName of Object.keys(zip.files)) {
    assertNoTestOnlySmokeArtifactEntry(entryName);

    if (entryName.endsWith(".js") || entryName.endsWith(".js.map")) {
      const entry = zip.file(entryName);
      if (entry) {
        assertNoForbiddenSmokeHooks(entryName, await entry.async("nodebuffer"));
      }
    }
  }
}

function readRequiredDistFile(distDir, filename) {
  const filePath = path.join(distDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Packaged dist is missing required runtime asset: ${filePath}`);
  }

  const content = fs.readFileSync(filePath);
  if (content.length === 0) {
    throw new Error(`Packaged dist asset is empty: ${filePath}`);
  }

  return content;
}

function assertNoTestOnlySmokeArtifactsInDist(distDir) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Packaged dist directory not found: ${distDir}`);
  }

  for (const entryName of fs.readdirSync(distDir)) {
    const packagedEntryName = `extension/${sqlJsRuntimeAssets.packagedDistDir}/${entryName}`;
    assertNoTestOnlySmokeArtifactEntry(packagedEntryName);

    if (entryName.endsWith(".js") || entryName.endsWith(".js.map")) {
      assertNoForbiddenSmokeHooks(
        packagedEntryName,
        fs.readFileSync(path.join(distDir, entryName)),
      );
    }
  }
}

async function assertPackageProvenance(options = {}) {
  assertSqlJsDependencyPinned();
  if (!options.skipSqlJsPackageProvenance) {
    await assertSqlJsPackageProvenance(options.fetchSqlJsPackage, {
      retryDelaysMs: options.retryDelaysMs,
    });
  }
  assertLocalSqlJsAssetPins();
}

async function assertVsixAssets(packagePath = defaultVsixPath, options = {}) {
  if (!fs.existsSync(packagePath)) {
    throw new Error(`VSIX not found: ${packagePath}`);
  }
  await assertPackageProvenance(options);

  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  const packagedEntries = await Promise.all(
    requiredVsixEntries.map(async (entryName) => [
      entryName,
      await readRequiredEntry(zip, entryName),
    ]),
  );
  const packagedContent = new Map(packagedEntries);
  await assertNoTestOnlySmokeArtifacts(zip);

  const manifest = parseJsonBuffer(
    packagedContent.get(sqlJsRuntimeAssets.packageJsonEntry),
    sqlJsRuntimeAssets.packageJsonEntry,
  );
  assertContributionManifest(manifest);

  const packagedRuntime = packagedContent.get(sqlJsRuntimeAssets.packagedRuntimeEntry);
  if (!packagedRuntime) {
    throw new Error(
      `VSIX package is missing required runtime asset: ${sqlJsRuntimeAssets.packagedRuntimeEntry}`,
    );
  }
  assertSha256(
    packagedRuntime,
    sqlJsRuntimeAssets.runtimeSha256,
    sqlJsRuntimeAssets.packagedRuntimeEntry,
  );

  const packagedWasm = packagedContent.get(sqlJsRuntimeAssets.packagedWasmEntry);
  if (!packagedWasm) {
    throw new Error(
      `VSIX package is missing required runtime asset: ${sqlJsRuntimeAssets.packagedWasmEntry}`,
    );
  }
  assertSha256(packagedWasm, sqlJsRuntimeAssets.wasmSha256, sqlJsRuntimeAssets.packagedWasmEntry);

  const extensionSource = packagedContent.get(sqlJsRuntimeAssets.extensionBundleEntry);
  if (!extensionSource) {
    throw new Error(
      `VSIX package is missing required runtime asset: ${sqlJsRuntimeAssets.extensionBundleEntry}`,
    );
  }
  assertNoExternalSqlJsImport(extensionSource);
  assertNoForbiddenSmokeHooks(sqlJsRuntimeAssets.extensionBundleEntry, extensionSource);
}

async function assertDistAssets(
  distDir = path.join(repoRoot, sqlJsRuntimeAssets.packagedDistDir),
  options = {},
) {
  await assertPackageProvenance(options);
  assertNoTestOnlySmokeArtifactsInDist(distDir);

  const extensionSource = readRequiredDistFile(
    distDir,
    path.basename(sqlJsRuntimeAssets.extensionBundleEntry),
  );
  assertNoExternalSqlJsImport(extensionSource);
  assertNoForbiddenSmokeHooks(sqlJsRuntimeAssets.extensionBundleEntry, extensionSource);

  const runtime = readRequiredDistFile(distDir, sqlJsRuntimeAssets.runtimeFilename);
  assertSha256(runtime, sqlJsRuntimeAssets.runtimeSha256, sqlJsRuntimeAssets.runtimeFilename);

  const wasm = readRequiredDistFile(distDir, sqlJsRuntimeAssets.wasmFilename);
  assertSha256(wasm, sqlJsRuntimeAssets.wasmSha256, sqlJsRuntimeAssets.wasmFilename);
}

function parseCliArgs(args) {
  const parsed = {
    mode: "vsix",
    path: undefined,
    skipSqlJsPackageProvenance: process.env[SKIP_SQL_JS_PROVENANCE_ENV] === "1",
  };

  for (const arg of args) {
    if (arg === "--dist") {
      parsed.mode = "dist";
      continue;
    }
    if (arg === "--skip-sqljs-provenance-fetch") {
      parsed.skipSqlJsPackageProvenance = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (parsed.path !== undefined) {
      throw new Error(`Unexpected extra path argument: ${arg}`);
    }
    parsed.path = arg;
  }

  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const cliOptions = parseCliArgs(argv);
  const assertionOptions = {
    skipSqlJsPackageProvenance: cliOptions.skipSqlJsPackageProvenance,
  };

  try {
    if (cliOptions.mode === "dist") {
      await assertDistAssets(cliOptions.path, assertionOptions);
    } else {
      await assertVsixAssets(cliOptions.path ?? defaultVsixPath, assertionOptions);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Could not verify packaged runtime assets: ${detail}`);
    process.exit(1);
  }

  const verifiedEntries =
    cliOptions.mode === "dist" ? requiredDistFiles.join(", ") : requiredVsixEntries.join(", ");
  console.log(`Packaged runtime assets verified: ${verifiedEntries}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  assertDistAssets,
  assertSqlJsPackageProvenance,
  assertVsixAssets,
  fetchBuffer,
  parseCliArgs,
  requiredEntries,
  requiredVsixEntries,
};
