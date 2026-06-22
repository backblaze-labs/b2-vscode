import { defineConfig } from "@vscode/test-cli";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compiledTestFilesGlob, mochaOptions } from "./test-harness.config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const testHome = join(root, ".vscode-test", "home");
const testXdgConfig = join(root, ".vscode-test", "xdg-config");
const testProfilePrefix = "b2-vscode-test-profile-";
const staleProfileMaxAgeMs = 24 * 60 * 60 * 1000;

for (const entry of readdirSync(tmpdir())) {
  if (entry.startsWith(testProfilePrefix)) {
    const candidate = join(tmpdir(), entry);
    try {
      if (Date.now() - lstatSync(candidate).mtimeMs > staleProfileMaxAgeMs) {
        rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // Best-effort stale profile cleanup; the current run uses a fresh profile.
    }
  }
}

const testProfileRoot = mkdtempSync(join(tmpdir(), testProfilePrefix));
process.once("exit", () => {
  try {
    rmSync(testProfileRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; VS Code can still hold profile files open.
  }
});

const launchArgs = [
  "--disable-extensions",
  "--disable-workspace-trust",
  `--user-data-dir=${join(testProfileRoot, "user-data")}`,
  `--extensions-dir=${join(testProfileRoot, "extensions")}`,
];

if (process.platform === "darwin") {
  launchArgs.push("--use-mock-keychain");
}

mkdirSync(join(testHome, ".vscode"), { recursive: true });
mkdirSync(testXdgConfig, { recursive: true });

export default defineConfig([
  {
    files: compiledTestFilesGlob,
    version: "stable",
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
