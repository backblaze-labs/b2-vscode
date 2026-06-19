#!/usr/bin/env node

const path = require("path");
const { contributesSha256 } = require("./release-contract");

const repoRoot = path.join(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));

process.stdout.write(`${contributesSha256(packageJson.contributes)}\n`);
