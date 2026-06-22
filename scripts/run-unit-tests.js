#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const sanitizedEnv = { ...process.env };
for (const key of ["B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY", "GITHUB_TOKEN"]) {
  delete sanitizedEnv[key];
}

const result = spawnSync(process.execPath, ["--test", "out/src/test/unit/**/*.test.js"], {
  env: sanitizedEnv,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
