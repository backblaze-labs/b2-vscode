/**
 * Downloads the minimal PR-controlled metadata needed by the trusted audit gate.
 *
 * This module is executed from the protected base checkout by the
 * pull_request_target workflow. Keep file limits conservative: package-lock is
 * the only expected large metadata file, and every decoded payload is checked
 * before it is written to disk.
 */

const fs = require("fs/promises");
const path = require("path");

const PR_AUDIT_METADATA_FILES = Object.freeze([
  { path: ".github/CODEOWNERS", maxBytes: 64 * 1024 },
  { path: ".github/workflows/build-extension.yml", maxBytes: 256 * 1024 },
  { path: ".github/workflows/code-quality.yml", maxBytes: 256 * 1024 },
  { path: ".github/workflows/docs.yml", maxBytes: 256 * 1024 },
  { path: ".github/workflows/pr-tests.yml", maxBytes: 256 * 1024 },
  { path: ".github/workflows/release.yml", maxBytes: 256 * 1024 },
  { path: ".github/workflows/test.yml", maxBytes: 256 * 1024 },
  { path: "audit-policy.jsonc", maxBytes: 64 * 1024 },
  { path: "package.json", maxBytes: 256 * 1024 },
  { path: "package-lock.json", maxBytes: 5 * 1024 * 1024 },
  { path: "SECURITY.md", maxBytes: 256 * 1024 },
]);

const UNSUPPORTED_PR_AUDIT_METADATA_FILES = Object.freeze([
  {
    path: "npm-shrinkwrap.json",
    message: "npm-shrinkwrap.json is not supported by the audit gate; use package-lock.json.",
  },
  {
    path: ".npmrc",
    message:
      ".npmrc is not supported by the audit gate; npm config must not be controlled by PR metadata.",
  },
]);

const RETRYABLE_GITHUB_API_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metadataFileLimit(filePath) {
  const match = PR_AUDIT_METADATA_FILES.find((file) => file.path === filePath);
  if (!match) {
    throw new Error(`No audit metadata size cap is configured for ${filePath}.`);
  }
  return match.maxBytes;
}

function assertSafeMetadataPath(filePath) {
  if (
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`Unsafe audit metadata path: ${filePath}`);
  }
}

function assertMetadataFileWithinLimit(filePath, size, label) {
  const limit = metadataFileLimit(filePath);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${filePath} ${label} size is missing or invalid.`);
  }
  if (size > limit) {
    throw new Error(
      `${filePath} ${label} size ${size} bytes exceeds the ${limit} byte audit metadata cap.`,
    );
  }
}

async function getWithRetry(request) {
  let attempt = 0;
  while (true) {
    try {
      return await request();
    } catch (error) {
      attempt += 1;
      if (!RETRYABLE_GITHUB_API_STATUSES.has(error.status) || attempt >= 3) {
        throw error;
      }
      await sleep(attempt * 1000);
    }
  }
}

async function readPrMetadataFileContent(filePath, data, getBlobWithRetry) {
  if (Array.isArray(data) || data.type !== "file" || !data.sha) {
    throw new Error(`${filePath} is not a readable file in the PR head.`);
  }

  assertMetadataFileWithinLimit(filePath, data.size, "declared");

  let content;
  if (data.encoding === "none" || !data.content) {
    const blob = await getBlobWithRetry(data.sha);
    if (blob.data.size !== undefined) {
      assertMetadataFileWithinLimit(filePath, blob.data.size, "blob");
    }
    content = Buffer.from(blob.data.content, blob.data.encoding || "base64");
  } else {
    content = Buffer.from(data.content, data.encoding || "base64");
  }

  assertMetadataFileWithinLimit(filePath, content.byteLength, "decoded");
  return content;
}

async function downloadPrAuditMetadata({ github, context, workspace }) {
  const pr = context.payload.pull_request;
  if (!pr) {
    throw new Error("pull_request payload is required.");
  }

  const owner = pr.head.repo.owner.login;
  const repo = pr.head.repo.name;
  const ref = pr.head.sha;

  const getContentWithRetry = (filePath) =>
    getWithRetry(() =>
      github.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref,
      }),
    );
  const getBlobWithRetry = (sha) =>
    getWithRetry(() =>
      github.rest.git.getBlob({
        owner,
        repo,
        file_sha: sha,
      }),
    );

  for (const file of UNSUPPORTED_PR_AUDIT_METADATA_FILES) {
    try {
      await getContentWithRetry(file.path);
      throw new Error(file.message);
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  for (const file of PR_AUDIT_METADATA_FILES) {
    assertSafeMetadataPath(file.path);
    const response = await getContentWithRetry(file.path);
    const content = await readPrMetadataFileContent(file.path, response.data, getBlobWithRetry);
    const destination = path.join(workspace, "source", file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
  }
}

module.exports = {
  PR_AUDIT_METADATA_FILES,
  RETRYABLE_GITHUB_API_STATUSES,
  UNSUPPORTED_PR_AUDIT_METADATA_FILES,
  assertMetadataFileWithinLimit,
  downloadPrAuditMetadata,
  metadataFileLimit,
  readPrMetadataFileContent,
};
