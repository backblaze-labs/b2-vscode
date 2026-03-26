import { defineConfig } from "@vscode/test-cli";

export default defineConfig([
  {
    files: "out/src/test/suite/**/*.test.js",
    version: "stable",
    mocha: {
      ui: "tdd",
      timeout: 20000,
    },
    launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  },
]);
