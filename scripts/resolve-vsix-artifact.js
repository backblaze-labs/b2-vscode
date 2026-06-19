#!/usr/bin/env node

/**
 * Resolve the single VSIX artifact in a directory and optionally verify it
 * against VSIX_SHA256SUMS.txt from the build job.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CHECKSUM_FILE = "VSIX_SHA256SUMS.txt";

function collectVsixFiles(rootDir) {
  const found = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectVsixFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".vsix")) {
      found.push(entryPath);
    }
  }

  return found.sort();
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyChecksum(rootDir, vsixPath) {
  const checksumPath = path.join(rootDir, CHECKSUM_FILE);
  if (!fs.existsSync(checksumPath)) {
    throw new Error(`Missing checksum file: ${checksumPath}`);
  }

  const vsixBasename = path.basename(vsixPath);
  const matchingEntries = fs
    .readFileSync(checksumPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
      if (!match) {
        throw new Error(`Invalid checksum entry: ${line}`);
      }

      return { checksum: match[1].toLowerCase(), fileName: path.basename(match[2]) };
    })
    .filter((entry) => entry.fileName === vsixBasename);

  if (matchingEntries.length !== 1) {
    throw new Error(`Expected one checksum for ${vsixBasename}; found ${matchingEntries.length}.`);
  }

  const actualChecksum = sha256File(vsixPath);
  if (actualChecksum !== matchingEntries[0].checksum) {
    throw new Error(
      `VSIX checksum mismatch for ${vsixBasename}: ${actualChecksum}; expected ${matchingEntries[0].checksum}`,
    );
  }
}

function parseArgs(argv) {
  const parsed = { rootDir: ".", verifyChecksum: false };
  for (const arg of argv) {
    if (arg === "--verify-checksum") {
      parsed.verifyChecksum = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    parsed.rootDir = arg;
  }

  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const { rootDir, verifyChecksum: shouldVerifyChecksum } = parseArgs(argv);
  const resolvedRoot = path.resolve(rootDir);
  const vsixFiles = collectVsixFiles(resolvedRoot);
  if (vsixFiles.length !== 1) {
    throw new Error(`Expected exactly one VSIX in ${resolvedRoot}; found ${vsixFiles.length}.`);
  }

  if (shouldVerifyChecksum) {
    verifyChecksum(resolvedRoot, vsixFiles[0]);
  }

  process.stdout.write(vsixFiles[0]);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  collectVsixFiles,
  parseArgs,
  verifyChecksum,
};
