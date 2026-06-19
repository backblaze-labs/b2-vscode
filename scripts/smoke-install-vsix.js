#!/usr/bin/env node

/**
 * Install the packaged VSIX into an isolated VS Code profile and verify that
 * VS Code sees the expected extension/version from the installed artifact.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { runVSCodeCommand } = require("@vscode/test-electron");
const { manifestContract } = require("./release-contract");

const repoRoot = path.join(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const sqlJsRuntimeAssets = require(path.join(repoRoot, "src", "sql-js-runtime-assets.json"));
const defaultVsixPath = path.join(repoRoot, `${packageJson.name}-${packageJson.version}.vsix`);
const extensionId = `${packageJson.publisher}.${packageJson.name}`;

function resolveVsixPath(inputPath) {
  const vsixPath = path.resolve(repoRoot, inputPath ?? defaultVsixPath);
  if (!fs.existsSync(vsixPath)) {
    throw new Error(`VSIX not found: ${vsixPath}`);
  }

  return vsixPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertInstalledFile(installedExtensionPath, relativePath) {
  const filePath = path.join(installedExtensionPath, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Installed extension is missing ${relativePath}`);
  }
  const fileStat = fs.statSync(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Installed extension path is not a file: ${relativePath}`);
  }
  if (fileStat.size === 0) {
    throw new Error(`Installed extension file is empty: ${relativePath}`);
  }
}

async function runCodeCommand(args, label) {
  try {
    return await runVSCodeCommand(args, { version: "stable" });
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${label} failed: ${error.message}`;
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) {
    throw new Error("Usage: smoke-install-vsix.js [path/to/package.vsix]");
  }

  const vsixPath = resolveVsixPath(argv[0]);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-vsix-smoke-"));
  const userDataDir = path.join(tempRoot, "user-data");
  const extensionsDir = path.join(tempRoot, "extensions");
  const profileArgs = [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`];

  try {
    await runCodeCommand(
      [...profileArgs, "--install-extension", vsixPath, "--force"],
      "VSIX installation",
    );

    const installedExtensions = await runCodeCommand(
      [...profileArgs, "--list-extensions", "--show-versions"],
      "Installed extension listing",
    );
    const expectedListing = `${extensionId}@${packageJson.version}`;
    const installedLines = installedExtensions.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!installedLines.includes(expectedListing)) {
      throw new Error(
        `Expected ${expectedListing} in installed extension list; found ${installedLines.join(", ")}`,
      );
    }

    const locatedExtension = await runCodeCommand(
      [...profileArgs, "--locate-extension", extensionId],
      "Installed extension lookup",
    );
    const installedExtensionPath = locatedExtension.stdout.trim().split(/\r?\n/)[0];
    if (!installedExtensionPath || !fs.existsSync(installedExtensionPath)) {
      throw new Error(`VS Code did not locate installed extension ${extensionId}`);
    }

    const installedManifest = readJson(path.join(installedExtensionPath, "package.json"));
    if (installedManifest.name !== packageJson.name) {
      throw new Error(`Installed package name mismatch: ${installedManifest.name}`);
    }
    if (installedManifest.publisher !== packageJson.publisher) {
      throw new Error(`Installed package publisher mismatch: ${installedManifest.publisher}`);
    }
    if (installedManifest.version !== packageJson.version) {
      throw new Error(`Installed package version mismatch: ${installedManifest.version}`);
    }

    for (const requiredFile of manifestContract.requiredInstalledFiles) {
      assertInstalledFile(installedExtensionPath, requiredFile);
    }
    assertInstalledFile(
      installedExtensionPath,
      path.join(sqlJsRuntimeAssets.packagedDistDir, sqlJsRuntimeAssets.runtimeFilename),
    );
    assertInstalledFile(
      installedExtensionPath,
      path.join(sqlJsRuntimeAssets.packagedDistDir, sqlJsRuntimeAssets.wasmFilename),
    );

    console.log(`Installed VSIX smoke verified: ${expectedListing}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  assertInstalledFile,
  resolveVsixPath,
};
