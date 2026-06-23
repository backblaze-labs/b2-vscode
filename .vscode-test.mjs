import { defineConfig } from "@vscode/test-cli";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compiledTestFilesGlob, mochaOptions, vscodeTestVersion } from "./test-harness.config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const testHome = join(root, ".vscode-test", "home");
const testXdgConfig = join(root, ".vscode-test", "xdg-config");
const testRunRoot = mkdtempSync(join(tmpdir(), "b2-vscode-test-"));
const testUserDataDir = join(testRunRoot, "user-data");
const testExtensionsDir = join(testRunRoot, "extensions");
const launchArgs = [
  "--disable-extensions",
  "--disable-workspace-trust",
  `--user-data-dir=${testUserDataDir}`,
  `--extensions-dir=${testExtensionsDir}`,
];

if (process.platform === "darwin") {
  launchArgs.push("--use-mock-keychain");
}

if (process.platform !== "win32") {
  try {
    chmodSync(testRunRoot, 0o700);
  } catch {
    // mkdtempSync already creates a private POSIX directory; chmod is best-effort.
  }
}
mkdirSync(join(testHome, ".vscode"), { recursive: true });
mkdirSync(testXdgConfig, { recursive: true });
mkdirSync(testUserDataDir, { recursive: true });
mkdirSync(testExtensionsDir, { recursive: true });

function cleanupTestRunRoot() {
  try {
    rmSync(testRunRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; locked files must not block process shutdown.
  }
}

process.once("exit", cleanupTestRunRoot);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanupTestRunRoot();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

export default defineConfig([
  {
    files: compiledTestFilesGlob,
    version: vscodeTestVersion,
    env: {
      B2_APPLICATION_KEY_ID: "",
      B2_APPLICATION_KEY: "",
      HOME: testHome,
      XDG_CONFIG_HOME: testXdgConfig,
    },
    mocha: mochaOptions,
    launchArgs,
  },
]);
