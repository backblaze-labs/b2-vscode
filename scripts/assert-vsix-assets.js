#!/usr/bin/env node

/**
 * Assert that packaged VSIX files include runtime assets required by the
 * bundled extension. This intentionally reads the final VSIX so packaging
 * changes fail before release.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const JSZip = require("jszip");

const repoRoot = path.join(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const vsixPath =
  process.argv[2] ?? path.join(repoRoot, `${packageJson.name}-${packageJson.version}.vsix`);

// Keep in sync with DEFAULT_SQL_WASM_FILENAME in src/services/authService.ts
// and SQL_WASM_FILENAME in webpack.config.js.
const SQL_WASM_FILENAME = "sql-wasm.wasm";
const PACKAGED_SQL_WASM_ENTRY = `extension/dist/${SQL_WASM_FILENAME}`;
const EXPECTED_SQL_WASM_PATH = path.join(
  repoRoot,
  "node_modules",
  "sql.js",
  "dist",
  SQL_WASM_FILENAME,
);

const requiredEntries = [
  "extension/package.json",
  "extension/dist/extension.js",
  PACKAGED_SQL_WASM_ENTRY,
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createVscodeStub() {
  let stub;
  const target = function vscodeStub() {};
  stub = new Proxy(target, {
    get(_target, property) {
      if (property === "TreeItemCollapsibleState") {
        return { None: 0, Collapsed: 1, Expanded: 2 };
      }
      if (property === "StatusBarAlignment") {
        return { Left: 1, Right: 2 };
      }
      if (property === "ProgressLocation") {
        return { Notification: 15 };
      }
      if (property === "ThemeIcon") {
        const ThemeIcon = function ThemeIcon(id) {
          this.id = id;
        };
        ThemeIcon.File = new ThemeIcon("file");
        ThemeIcon.Folder = new ThemeIcon("folder");
        return ThemeIcon;
      }
      if (property === "EventEmitter") {
        return class EventEmitter {
          constructor() {
            this.event = () => ({ dispose() {} });
          }
          fire() {}
          dispose() {}
        };
      }
      if (property === "CancellationError") {
        return class CancellationError extends Error {};
      }
      return stub;
    },
    apply() {
      return stub;
    },
    construct() {
      return stub;
    },
  });

  return stub;
}

function smokeLoadPackagedExtension(extensionSource) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-vsix-smoke-"));
  const extensionPath = path.join(tempDir, "extension.js");
  const originalLoad = Module._load;

  try {
    fs.writeFileSync(extensionPath, extensionSource);
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "vscode") {
        return createVscodeStub();
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[extensionPath];
    require(extensionPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Packaged extension could not be loaded without repository node_modules: ${detail}`,
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[extensionPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
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
  if (!fs.existsSync(EXPECTED_SQL_WASM_PATH)) {
    throw new Error(`Expected SQL.js WASM asset not found: ${EXPECTED_SQL_WASM_PATH}`);
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(packagePath));
  const packagedEntries = await Promise.all(
    requiredEntries.map(async (entryName) => [entryName, await readRequiredEntry(zip, entryName)]),
  );
  const packagedContent = new Map(packagedEntries);
  const expectedWasm = fs.readFileSync(EXPECTED_SQL_WASM_PATH);
  const packagedWasm = packagedContent.get(PACKAGED_SQL_WASM_ENTRY);
  if (!packagedWasm) {
    throw new Error(`VSIX package is missing required runtime asset: ${PACKAGED_SQL_WASM_ENTRY}`);
  }
  if (sha256(packagedWasm) !== sha256(expectedWasm)) {
    throw new Error(
      `VSIX package contains an unexpected ${PACKAGED_SQL_WASM_ENTRY}; it must match ${EXPECTED_SQL_WASM_PATH}`,
    );
  }

  const extensionSource = packagedContent.get("extension/dist/extension.js");
  if (!extensionSource) {
    throw new Error("VSIX package is missing required runtime asset: extension/dist/extension.js");
  }
  smokeLoadPackagedExtension(extensionSource);
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
