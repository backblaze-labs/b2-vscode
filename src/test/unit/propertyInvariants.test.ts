/**
 * Property-based tests for pure path and URL invariants.
 *
 * @module test/unit/propertyInvariants
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import * as fc from "fast-check";
import { buildTempFilePath, resolveDownloadSavePath } from "../../utils/localPaths";
import {
  assertSafeFileWritePath,
  assertSafeWritePath,
  prepareSafeFileWritePath,
  writeFileNoFollow,
  writeFileNoFollowWithinRoot,
} from "../../services/pathSafety";
import { createPrivateTempRoot, releasePrivateTempRoot } from "../../utils/privateTempRoot";
import { buildB2DownloadUrl, encodeB2FileNameForUrl } from "../../utils/urlEncoding";
import { humanSize } from "../../utils/humanSize";
import { presignUrlOperation } from "../../tools/operations/presignUrl";
import type { ToolExtras } from "../../tools/types";

const PROPERTY_RUNS = 1000;
const propertyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-properties-"));
const tempRoot = path.join(propertyRoot, "temp-root");
const workspaceRoot = path.join(propertyRoot, "workspace");
const b2Name = fc.string({ unit: "binary", maxLength: 128 });
const b2PathSegment = fc
  .string({ unit: "binary", minLength: 1, maxLength: 32 })
  .filter((segment) => !segment.includes("/"));
const b2SegmentedPath = fc
  .array(b2PathSegment, { minLength: 1, maxLength: 6 })
  .map((segments) => segments.join("/"));
const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true });
const finiteNonNegativeNumber = fc.double({
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  noNaN: true,
  noDefaultInfinity: true,
});
const reservedUrlCharacters = /[:/?#[\]@!$&'()*+,;=]/;
const sizeUnits = new Map([
  ["B", 1],
  ["KB", 1024],
  ["MB", 1024 ** 2],
  ["GB", 1024 ** 3],
  ["TB", 1024 ** 4],
]);

fs.mkdirSync(tempRoot, { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });

after(() => {
  fs.rmSync(propertyRoot, { recursive: true, force: true });
});

test("unit test process does not receive storage or GitHub secrets", () => {
  for (const key of ["B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY", "GITHUB_TOKEN"]) {
    assert.equal(process.env[key], undefined);
  }
});

function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function assertInsideRoot(root: string, candidate: string): void {
  assert.equal(isInsideRoot(root, candidate), true, `${candidate} should stay inside ${root}`);
}

function decodeB2FileNameFromUrl(encodedPath: string): string {
  return encodedPath.split("/").map(decodeURIComponent).join("/");
}

function parseHumanSizeToBytes(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?) (B|KB|MB|GB|TB)$/i.exec(value);
  assert.ok(match, `${value} should be a formatted size`);

  const size = Number(match[1]);
  const multiplier = sizeUnits.get(match[2].toUpperCase());
  if (multiplier === undefined) {
    throw new Error(`${value} should use a known unit`);
  }

  return size * multiplier;
}

test("temp cache paths stay inside the temp root for arbitrary B2 names", () => {
  fc.assert(
    fc.property(b2Name, b2Name, (bucketName, fileName) => {
      const localPath = buildTempFilePath(tempRoot, bucketName, fileName);

      assert.equal(path.isAbsolute(localPath), true);
      assertInsideRoot(tempRoot, localPath);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("natural B2 basenames are preserved for default download and temp paths", async () => {
  const naturalName = "My File #1.csv";
  const unicodeName = "caf\u00e9 #1.txt";
  const hiddenName = ".npmrc";
  const bucketPath = buildTempFilePath(tempRoot, "bucket/with\\slash", "safe.txt");
  const bucketPathSegments = path.relative(tempRoot, bucketPath).split(path.sep);

  assert.equal(
    path.basename(await resolveDownloadSavePath(workspaceRoot, `reports/${naturalName}`)),
    naturalName,
  );
  assert.equal(
    path.basename(buildTempFilePath(tempRoot, "bucket", `reports/${unicodeName}`)),
    unicodeName,
  );
  assert.equal(
    path.basename(await resolveDownloadSavePath(workspaceRoot, `reports/${hiddenName}`)),
    hiddenName,
  );
  assert.equal(bucketPathSegments.length, 2);
  assert.notEqual(bucketPathSegments[0], "bucket/with\\slash");
  assert.notEqual(bucketPathSegments[0], "");
  assert.equal(bucketPathSegments[1], "safe.txt");
});

test("Windows-unsafe B2 basenames are encoded on every host", async () => {
  const timestampedName = "backup-2024-01-01T12:00:00Z.log";

  assert.match(
    path.basename(await resolveDownloadSavePath(workspaceRoot, `reports/${timestampedName}`)),
    /^__b2_/,
  );
  assert.match(
    path.basename(buildTempFilePath(tempRoot, "bucket", `reports/${timestampedName}`)),
    /^__b2_/,
  );
});

test("unsafe B2 basenames are encoded for default downloads", async () => {
  const bidiName = "invoice\u202Egnp.exe";
  const reservedName = "aux";
  const controlDirectoryName = ".git";

  for (const unsafeName of [bidiName, reservedName, controlDirectoryName]) {
    const destinationPath = await resolveDownloadSavePath(workspaceRoot, `reports/${unsafeName}`);
    assert.notEqual(path.basename(destinationPath), unsafeName);
    assert.match(path.basename(destinationPath), /^__b2_/);
  }
});

test("long unsafe B2 basenames use bounded encoded segments", async () => {
  const longUnsafeName = `${"a".repeat(180)}:${"b".repeat(180)}.txt`;
  const destinationPath = await resolveDownloadSavePath(workspaceRoot, `reports/${longUnsafeName}`);
  const encodedName = path.basename(destinationPath);

  assert.notEqual(encodedName, longUnsafeName);
  assert.match(encodedName, /^__b2h_/);
  assert.ok(encodedName.length <= 120, encodedName);
});

test("unsafe localPath segments are encoded for downloads", async () => {
  const destinationPath = await resolveDownloadSavePath(workspaceRoot, "safe.txt", "reports/CON");

  assert.equal(path.basename(path.dirname(destinationPath)), "reports");
  assert.notEqual(path.basename(destinationPath), "CON");
  assert.match(path.basename(destinationPath), /^__b2_/);
});

test("empty B2 path segments are preserved in temp cache paths", () => {
  const collapsedPath = buildTempFilePath(tempRoot, "bucket", "a/b.txt");
  const emptySegmentPath = buildTempFilePath(tempRoot, "bucket", "a//b.txt");
  const literalFallbackPath = buildTempFilePath(tempRoot, "bucket", "a/download/b.txt");
  const emptySegmentPathSegments = path.relative(tempRoot, emptySegmentPath).split(path.sep);

  assert.notEqual(emptySegmentPath, collapsedPath);
  assert.notEqual(emptySegmentPath, literalFallbackPath);
  assert.equal(emptySegmentPathSegments.length, 4);
  assert.equal(emptySegmentPathSegments[0], "bucket");
  assert.equal(emptySegmentPathSegments[1], "a");
  assert.notEqual(emptySegmentPathSegments[2], "");
  assert.equal(emptySegmentPathSegments[3], "b.txt");
});

test("private temp roots are unpredictable and owner-only", () => {
  const prefix = `b2-vscode-private-test-${process.pid}`;
  const fixedRoot = path.join(os.tmpdir(), prefix);
  const symlinkTarget = fs.mkdtempSync(path.join(propertyRoot, "temp-symlink-target-"));
  if (process.platform !== "win32") {
    fs.symlinkSync(symlinkTarget, fixedRoot, "dir");
  }
  const privateRoot = createPrivateTempRoot(prefix);

  try {
    const stats = fs.lstatSync(privateRoot);
    const mode = stats.mode & 0o777;

    assert.notEqual(privateRoot, fixedRoot);
    assert.equal(privateRoot.startsWith(`${fixedRoot}-`), true);
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.isSymbolicLink(), false);
    if (process.platform !== "win32") {
      assert.equal(mode & 0o077, 0);
    }
  } finally {
    releasePrivateTempRoot(privateRoot);
    fs.rmSync(fixedRoot, { recursive: true, force: true });
    fs.rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("private temp root prefixes must be simple names", () => {
  assert.throws(() => createPrivateTempRoot(""));
  assert.throws(() => createPrivateTempRoot("/tmp/b2-vscode"));
  assert.throws(() => createPrivateTempRoot("nested/prefix"));
  assert.throws(() => createPrivateTempRoot("nested\\prefix"));
});

test("safe writes create owner-only files and reject final symlinks", async () => {
  const root = fs.mkdtempSync(path.join(propertyRoot, "safe-write-"));
  const filePath = path.join(root, "nested", "file.txt");

  await prepareSafeFileWritePath(root, filePath);
  await writeFileNoFollow(filePath, Buffer.from("content"));

  const mode = fs.statSync(filePath).mode & 0o777;
  if (process.platform !== "win32") {
    assert.equal(mode & 0o077, 0);
  }

  if (process.platform !== "win32") {
    const targetPath = path.join(root, "target.txt");
    const symlinkPath = path.join(root, "link.txt");
    fs.writeFileSync(targetPath, "target");
    fs.symlinkSync(targetPath, symlinkPath);

    const danglingSymlinkPath = path.join(root, "dangling-link.txt");
    fs.symlinkSync(path.join(root, "missing-target.txt"), danglingSymlinkPath);

    await assert.rejects(() => assertSafeWritePath(root, danglingSymlinkPath));
    await assert.rejects(
      () => assertSafeWritePath(root, path.join(danglingSymlinkPath, "child.txt")),
      /symlink/i,
    );
    await assert.rejects(() => writeFileNoFollow(symlinkPath, Buffer.from("blocked")));
  }
});

test("root-bound no-follow writes require overwrite refusal", async () => {
  const root = fs.mkdtempSync(path.join(propertyRoot, "root-bound-write-"));
  const filePath = path.join(root, "file.txt");

  await assert.rejects(
    () => writeFileNoFollowWithinRoot(root, filePath, Buffer.from("blocked")),
    /overwrite disabled/i,
  );
  assert.equal(fs.existsSync(filePath), false);

  await writeFileNoFollowWithinRoot(root, filePath, Buffer.from("content"), { overwrite: false });
  await assert.rejects(
    () => writeFileNoFollowWithinRoot(root, filePath, Buffer.from("replace"), { overwrite: false }),
    /EEXIST|file already exists/i,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "content");
});

test("download default paths stay inside the workspace for arbitrary B2 names", async () => {
  await fc.assert(
    fc.asyncProperty(b2Name, async (fileName) => {
      const localPath = await resolveDownloadSavePath(workspaceRoot, fileName);

      assert.equal(path.isAbsolute(localPath), true);
      assertInsideRoot(workspaceRoot, localPath);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("download localPath inputs are either confined or rejected", async () => {
  await fc.assert(
    fc.asyncProperty(b2Name, b2Name, async (remotePath, localPath) => {
      let resolvedPath: string;
      try {
        resolvedPath = await resolveDownloadSavePath(workspaceRoot, remotePath, localPath);
      } catch (error) {
        assert.ok(error instanceof Error);
        return;
      }

      assertInsideRoot(workspaceRoot, resolvedPath);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("absolute download paths outside the workspace are rejected", async () => {
  const outsideRoot = fs.mkdtempSync(path.join(propertyRoot, "outside-"));
  const outsidePath = path.join(outsideRoot, "authorized_keys");

  await assert.rejects(
    () => resolveDownloadSavePath(workspaceRoot, "safe.txt", outsidePath),
    /relative to the workspace/,
  );
});

test("absolute download paths inside the workspace are rejected", async () => {
  const insidePath = path.join(workspaceRoot, "downloads", "safe.txt");

  await assert.rejects(
    () => resolveDownloadSavePath(workspaceRoot, "safe.txt", insidePath),
    /relative to the workspace/,
  );
});

test("download destinations reject existing directories", async () => {
  const directoryPath = fs.mkdtempSync(path.join(workspaceRoot, "existing-dir-"));

  await assert.rejects(() => resolveDownloadSavePath(workspaceRoot, "safe.txt", directoryPath));
  await assert.rejects(() => assertSafeFileWritePath(workspaceRoot, directoryPath));
});

test("download destinations reject trailing path separators", async () => {
  const relativeDirectoryPath = "downloads/";
  const winRelativeDirectoryPath = "downloads\\";
  const absoluteDirectoryPath = `${path.join(workspaceRoot, "downloads")}${path.sep}`;

  await assert.rejects(() =>
    resolveDownloadSavePath(workspaceRoot, "safe.txt", relativeDirectoryPath),
  );
  await assert.rejects(() =>
    resolveDownloadSavePath(workspaceRoot, "safe.txt", winRelativeDirectoryPath),
  );
  await assert.rejects(() =>
    resolveDownloadSavePath(workspaceRoot, "safe.txt", absoluteDirectoryPath),
  );
});

test("download localPath inputs reject empty internal segments", async () => {
  await assert.rejects(() =>
    resolveDownloadSavePath(workspaceRoot, "safe.txt", "downloads//safe.txt"),
  );
  await assert.rejects(() =>
    resolveDownloadSavePath(workspaceRoot, "safe.txt", "downloads\\\\safe.txt"),
  );
});

test(
  "workspace symlink downloads cannot redirect outside the workspace",
  { skip: process.platform === "win32" ? "directory symlink support varies on Windows" : false },
  async () => {
    const root = fs.mkdtempSync(path.join(propertyRoot, "workspace-"));
    const outsideRoot = fs.mkdtempSync(path.join(propertyRoot, "outside-"));
    fs.symlinkSync(outsideRoot, path.join(root, "downloads"), "dir");

    await assert.rejects(() => resolveDownloadSavePath(root, "safe.txt", "downloads/safe.txt"));
  },
);

test(
  "temp cache symlinks cannot redirect writes outside the temp root",
  { skip: process.platform === "win32" ? "directory symlink support varies on Windows" : false },
  async () => {
    const root = fs.mkdtempSync(path.join(propertyRoot, "temp-"));
    const outsideRoot = fs.mkdtempSync(path.join(propertyRoot, "outside-"));
    const bucketDir = path.join(root, "bucket");
    fs.mkdirSync(bucketDir);
    fs.symlinkSync(outsideRoot, path.join(bucketDir, "redirect"), "dir");

    const localPath = buildTempFilePath(root, "bucket", "redirect/file.txt");

    await assert.rejects(() => assertSafeWritePath(root, localPath));
  },
);

test("presigned URL encoding preserves slash separators for nested object names", () => {
  assert.equal(encodeB2FileNameForUrl("photos/2024/img.jpg"), "photos/2024/img.jpg");
  assert.equal(encodeB2FileNameForUrl("reports/q4 final #1.pdf"), "reports/q4%20final%20%231.pdf");
});

test("presigned URL encoding supports empty path segments", () => {
  assert.equal(encodeB2FileNameForUrl("photos//img.jpg"), "photos//img.jpg");

  const url = buildB2DownloadUrl("https://download.example.com", "bucket", "/img.jpg", "token");
  const parsedUrl = new URL(url);

  assert.equal(parsedUrl.pathname, "/file/bucket//img.jpg");
  assert.equal(parsedUrl.searchParams.get("Authorization"), "token");
});

test("presign operation supports object names with empty path segments", async () => {
  const authorizationRequests: Array<[string, number]> = [];
  const extras = {
    getClient: () => ({
      async getBucket(bucketName: string) {
        assert.equal(bucketName, "bucket");
        return {
          async getDownloadAuthorization(fileName: string, expiresIn: number) {
            authorizationRequests.push([fileName, expiresIn]);
            return { authorizationToken: "token/with #spaces" };
          },
        };
      },
      accountInfo: {
        getDownloadUrl: () => "https://download.example.com",
      },
    }),
  } as unknown as ToolExtras;

  const result = await presignUrlOperation.execute(
    { bucket: "bucket", path: "a//b.txt", expiresIn: 60 },
    extras,
  );
  const parsedUrl = new URL(result.url);

  assert.deepEqual(authorizationRequests, [["a//b.txt", 60]]);
  assert.equal(parsedUrl.pathname, "/file/bucket/a//b.txt");
  assert.equal(parsedUrl.searchParams.get("Authorization"), "token/with #spaces");
  assert.equal(result.authorizedPrefix, "a//b.txt");
  assert.match(result.message, /starting with a\/\/b\.txt/);
  assert.equal(result.message.includes("token/with #spaces"), false);
  assert.equal(result.message.includes(result.url), false);
});

test("presign operation documents B2 prefix authorization scope", async () => {
  const authorizationRequests: Array<[string, number]> = [];
  const extras = {
    getClient: () => ({
      async getBucket() {
        return {
          async getDownloadAuthorization(fileName: string, expiresIn: number) {
            authorizationRequests.push([fileName, expiresIn]);
            return { authorizationToken: "token" };
          },
        };
      },
      accountInfo: {
        getDownloadUrl: () => "https://download.example.com",
      },
    }),
  } as unknown as ToolExtras;

  const result = await presignUrlOperation.execute(
    { bucket: "bucket", path: "customers/123", expiresIn: 120 },
    extras,
  );

  assert.deepEqual(authorizationRequests, [["customers/123", 120]]);
  assert.equal(result.authorizedPrefix, "customers/123");
  assert.equal("customers/1234/tax.pdf".startsWith(result.authorizedPrefix), true);
  assert.equal("customers/123/secret.txt".startsWith(result.authorizedPrefix), true);
  assert.equal("customers/124/tax.pdf".startsWith(result.authorizedPrefix), false);
  assert.match(result.message, /object names starting with customers\/123/);
});

test("presign operation defaults to short-lived prefix authorization", async () => {
  const authorizationRequests: Array<[string, number]> = [];
  const extras = {
    getClient: () => ({
      async getBucket() {
        return {
          async getDownloadAuthorization(fileName: string, expiresIn: number) {
            authorizationRequests.push([fileName, expiresIn]);
            return { authorizationToken: "token" };
          },
        };
      },
      accountInfo: {
        getDownloadUrl: () => "https://download.example.com",
      },
    }),
  } as unknown as ToolExtras;

  const result = await presignUrlOperation.execute({ bucket: "bucket", path: "file.txt" }, extras);

  assert.deepEqual(authorizationRequests, [["file.txt", 300]]);
  assert.equal(result.expiresIn, 300);
});

test("presign operation rejects empty and folder-prefix paths before B2 calls", async () => {
  for (const [filePath, expectedError] of [
    ["", /empty/i],
    ["reports/", /folder prefix/i],
    ["bad\0path", /NUL/i],
  ] as const) {
    let bucketLookupWasCalled = false;
    const extras = {
      getClient: () => ({
        async getBucket() {
          bucketLookupWasCalled = true;
          throw new Error("bucket lookup should not run");
        },
      }),
    } as unknown as ToolExtras;

    await assert.rejects(
      () => presignUrlOperation.execute({ bucket: "bucket", path: filePath }, extras),
      expectedError,
    );
    assert.equal(bucketLookupWasCalled, false);
  }
});

test("presign operation rejects invalid expiresIn before B2 calls", async () => {
  for (const expiresIn of [-1, 0, 1.5, 604801, Number.NaN]) {
    let bucketLookupWasCalled = false;
    const extras = {
      getClient: () => ({
        async getBucket() {
          bucketLookupWasCalled = true;
          throw new Error("bucket lookup should not run");
        },
      }),
    } as unknown as ToolExtras;

    await assert.rejects(
      () => presignUrlOperation.execute({ bucket: "bucket", path: "file.txt", expiresIn }, extras),
      /expiresIn must be an integer/,
    );
    assert.equal(bucketLookupWasCalled, false);
  }
});

test("presigned URL file-name encoding is per-segment reversible", () => {
  fc.assert(
    fc.property(b2SegmentedPath, (fileName) => {
      const encodedPath = encodeB2FileNameForUrl(fileName);

      assert.equal(encodedPath.includes("//"), false);
      assert.equal(encodedPath.split("/").length, fileName.split("/").length);
      for (const encodedSegment of encodedPath.split("/")) {
        assert.doesNotMatch(encodedSegment, reservedUrlCharacters);
      }
      assert.equal(decodeB2FileNameFromUrl(encodedPath), fileName);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("presigned URLs keep nested paths compatible with prior slash-preserving links", () => {
  fc.assert(
    fc.property(b2SegmentedPath, b2Name, (fileName, authorizationToken) => {
      const bucketName = "bucket";
      const url = buildB2DownloadUrl(
        "https://download.example.com/",
        bucketName,
        fileName,
        authorizationToken,
      );
      const parsedUrl = new URL(url);
      const encodedPath = parsedUrl.pathname.replace(
        new RegExp(`^/file/${encodeURIComponent(bucketName)}/`),
        "",
      );

      assert.doesNotMatch(parsedUrl.pathname, /\/\//);
      assert.equal(parsedUrl.searchParams.get("Authorization"), authorizationToken);
      assert.equal(encodedPath.split("/").length, fileName.split("/").length);
      assert.equal(decodeB2FileNameFromUrl(encodedPath), fileName);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("presigned URL bucket names are encoded as one path segment", () => {
  const url = buildB2DownloadUrl(
    "https://download.example.com",
    "bucket/name",
    "file.txt",
    "token",
  );

  assert.equal(new URL(url).pathname, "/file/bucket%2Fname/file.txt");
});

test("humanSize is total over finite numbers", () => {
  fc.assert(
    fc.property(finiteNumber, (bytes) => {
      const formatted = humanSize(bytes);

      assert.equal(typeof formatted, "string");
      assert.doesNotMatch(formatted, /NaN|Infinity|undefined/);
      assert.equal(Number.isFinite(parseHumanSizeToBytes(formatted)), true);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("humanSize is monotonic for non-negative finite bytes", () => {
  fc.assert(
    fc.property(finiteNonNegativeNumber, finiteNonNegativeNumber, (left, right) => {
      const smaller = Math.min(left, right);
      const larger = Math.max(left, right);
      const smallerFormatted = parseHumanSizeToBytes(humanSize(smaller));
      const largerFormatted = parseHumanSizeToBytes(humanSize(larger));

      assert.ok(
        smallerFormatted <= largerFormatted,
        `${humanSize(smaller)} should not exceed ${humanSize(larger)}`,
      );
    }),
    { numRuns: PROPERTY_RUNS },
  );
});
