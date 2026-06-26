#!/usr/bin/env node

/**
 * Release-time Marketplace contract for the packaged VSIX.
 *
 * These values intentionally freeze sensitive published surfaces. If a command,
 * language model tool, menu, view, activation event, or other Marketplace-facing
 * contribution changes, update this contract in the same PR and explain why the
 * new surface is safe to publish. Run `npm run contract:hash` after reviewing
 * package.json contributes changes to regenerate contributesSha256.
 */

const crypto = require("crypto");

const manifestContract = {
  packageName: "b2-vscode",
  publisher: "backblaze",
  versionedMain: "./dist/extension.js",
  icon: "resources/b2-icon.png",
  repository: {
    type: "git",
    url: "https://github.com/backblaze-labs/b2-vscode.git",
  },
  activationEvents: [],
  forbiddenTopLevelFields: ["extensionDependencies", "extensionPack"],
  requiredPackageEntries: [
    "extension/resources/b2-icon.png",
    "extension/resources/b2-icon.svg",
    "extension/resources/b2-icons.woff",
  ],
  requiredInstalledFiles: [
    "dist/extension.js",
    "resources/b2-icon.png",
    "resources/b2-icon.svg",
    "resources/b2-icons.woff",
  ],
  commandIds: [
    "b2.authenticate",
    "b2.logout",
    "b2.refresh",
    "b2.loadMore",
    "b2.copyPath",
    "b2.copyFileId",
    "b2.openFile",
    "b2.createBucket",
    "b2.createApplicationKey",
    "b2.changeBucketVisibility",
    "b2.createFolder",
    "b2.deleteBucket",
    "b2.deleteFolder",
    "b2.deleteFile",
    "b2.deleteApplicationKey",
    "b2.renameFile",
  ],
  languageModelToolNames: [
    "b2_listBuckets",
    "b2_listFiles",
    "b2_getFileInfo",
    "b2_downloadFile",
    "b2_uploadFile",
    "b2_deleteFile",
    "b2_presignUrl",
  ],
  contributesSha256: "c9c100e11919ee817229cde8b75edab417c8785711876887bb6f2a1e0cd46b46",
};

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function contributesSha256(contributes) {
  return sha256(stableStringify(contributes));
}

module.exports = {
  contributesSha256,
  manifestContract,
  stableStringify,
};
