#!/usr/bin/env node

/**
 * Install the packaged VSIX into an isolated VS Code profile and verify that
 * VS Code sees the expected extension/version from the installed artifact.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
} = require("@vscode/test-electron");
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

function linuxCiArgs() {
  if (process.platform !== "linux") {
    return [];
  }

  return ["--no-sandbox", "--disable-gpu"];
}

async function resolveCodeCliPath() {
  const executablePath = await downloadAndUnzipVSCode({ version: "stable" });
  return resolveCliPathFromVSCodeExecutablePath(executablePath);
}

async function runCodeCommand(codeCliPath, args, label) {
  const cliArgs = [...linuxCiArgs(), ...args];

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const shell = process.platform === "win32";
    const child = spawn(shell ? `"${codeCliPath}"` : codeCliPath, cliArgs, {
      stdio: "pipe",
      shell,
      windowsHide: true,
    });

    child.stdout?.setEncoding("utf8").on("data", (data) => {
      stdout += data;
    });
    child.stderr?.setEncoding("utf8").on("data", (data) => {
      stderr += data;
    });
    let settled = false;
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code, signal) => {
      if (code === 0) {
        settle(() => resolve({ stdout, stderr }));
        return;
      }

      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
      const status = code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
      settle(() =>
        reject(new Error(`${label} failed with ${status}${details ? `:\n${details}` : "."}`)),
      );
    });
  });
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
    const codeCliPath = await resolveCodeCliPath();

    await runCodeCommand(
      codeCliPath,
      [...profileArgs, "--install-extension", vsixPath, "--force"],
      "VSIX installation",
    );

    const installedExtensions = await runCodeCommand(
      codeCliPath,
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
      codeCliPath,
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
