import { defineConfig } from "@vscode/test-cli";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compiledTestFilesGlob, mochaOptions } from "./test-harness.config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const testHome = join(root, ".vscode-test", "home");
const testXdgConfig = join(root, ".vscode-test", "xdg-config");
const launchArgs = ["--disable-extensions", "--disable-workspace-trust"];

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
