#!/usr/bin/env node

/**
 * Assert that packaged VSIX files include runtime assets required by the
 * bundled extension. This intentionally reads the final VSIX so packaging
 * changes fail before release.
 */

const fs = require("fs");
const path = require("path");

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;

const repoRoot = path.join(__dirname, "..");
const packageJson = require(path.join(repoRoot, "package.json"));
const vsixPath =
  process.argv[2] ?? path.join(repoRoot, `${packageJson.name}-${packageJson.version}.vsix`);

const requiredEntries = [
  "extension/package.json",
  "extension/dist/extension.js",
  "extension/dist/sql-wasm.wasm",
];

function findEndOfCentralDirectory(buffer) {
  const searchStart = Math.max(0, buffer.length - ZIP_MAX_COMMENT_LENGTH - 22);

  for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }

  throw new Error("Could not locate ZIP central directory.");
}

function listZipEntries(buffer) {
  const endOfCentralDirectory = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(endOfCentralDirectory + 10);
  let offset = buffer.readUInt32LE(endOfCentralDirectory + 16);
  const entries = [];

  for (let index = 0; index < totalEntries; index++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE) {
      throw new Error(`Invalid central directory file header at offset ${offset}.`);
    }

    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;

    entries.push(buffer.toString("utf8", fileNameStart, fileNameEnd));
    offset = fileNameEnd + extraFieldLength + fileCommentLength;
  }

  return entries;
}

if (!fs.existsSync(vsixPath)) {
  console.error(`VSIX not found: ${vsixPath}`);
  process.exit(1);
}

let entries;
try {
  entries = new Set(listZipEntries(fs.readFileSync(vsixPath)));
} catch (error) {
  console.error(`Could not inspect VSIX package: ${error.message}`);
  process.exit(1);
}

const missingEntries = requiredEntries.filter((entry) => !entries.has(entry));
if (missingEntries.length > 0) {
  console.error("VSIX package is missing required runtime asset(s):");
  for (const entry of missingEntries) {
    console.error(`- ${entry}`);
  }
  process.exit(1);
}

console.log(`VSIX runtime assets verified: ${requiredEntries.join(", ")}`);
