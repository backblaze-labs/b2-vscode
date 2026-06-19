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
import {
  assertSafeWritePath,
  buildTempFilePath,
  resolveDownloadSavePath,
} from "../../utils/localPaths";
import { buildB2DownloadUrl, encodeB2FileNameForUrl } from "../../utils/urlEncoding";
import { humanSize } from "../../utils/humanSize";

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

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relativePath === "" ||
    (!!relativePath &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
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

test("natural B2 basenames are preserved for default download and temp paths", () => {
  const naturalName = "My File #1.csv";
  const unicodeName = "caf\u00e9 #1.txt";
  const bucketPath = buildTempFilePath(tempRoot, "bucket/with\\slash", "safe.txt");
  const bucketPathSegments = path.relative(tempRoot, bucketPath).split(path.sep);

  assert.equal(
    path.basename(resolveDownloadSavePath(workspaceRoot, `reports/${naturalName}`)),
    naturalName,
  );
  assert.equal(
    path.basename(buildTempFilePath(tempRoot, "bucket", `reports/${unicodeName}`)),
    unicodeName,
  );
  assert.deepEqual(bucketPathSegments, ["bucket_with_slash", "safe.txt"]);
});

test("empty B2 path segments are preserved in temp cache paths", () => {
  const collapsedPath = buildTempFilePath(tempRoot, "bucket", "a/b.txt");
  const emptySegmentPath = buildTempFilePath(tempRoot, "bucket", "a//b.txt");
  const emptySegmentPathSegments = path.relative(tempRoot, emptySegmentPath).split(path.sep);

  assert.notEqual(emptySegmentPath, collapsedPath);
  assert.deepEqual(emptySegmentPathSegments, ["bucket", "a", "download", "b.txt"]);
});

test("download default paths stay inside the workspace for arbitrary B2 names", () => {
  fc.assert(
    fc.property(b2Name, (fileName) => {
      const localPath = resolveDownloadSavePath(workspaceRoot, fileName);

      assert.equal(path.isAbsolute(localPath), true);
      assertInsideRoot(workspaceRoot, localPath);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("download localPath inputs are either confined or rejected", () => {
  fc.assert(
    fc.property(b2Name, b2Name, (remotePath, localPath) => {
      try {
        assertInsideRoot(
          workspaceRoot,
          resolveDownloadSavePath(workspaceRoot, remotePath, localPath),
        );
      } catch (error) {
        assert.match(
          error instanceof Error ? error.message : String(error),
          /workspace|NUL|destination|relative/,
        );
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("absolute download paths outside the workspace are rejected", () => {
  const outsideRoot = fs.mkdtempSync(path.join(propertyRoot, "outside-"));
  const outsidePath = path.join(outsideRoot, "authorized_keys");

  assert.throws(
    () => resolveDownloadSavePath(workspaceRoot, "safe.txt", outsidePath),
    /relative to the workspace/,
  );
});

test("absolute download paths inside the workspace are rejected", () => {
  const insidePath = path.join(workspaceRoot, "downloads", "safe.txt");

  assert.throws(
    () => resolveDownloadSavePath(workspaceRoot, "safe.txt", insidePath),
    /relative to the workspace/,
  );
});

test(
  "workspace symlink downloads cannot redirect outside the workspace",
  { skip: process.platform === "win32" ? "directory symlink support varies on Windows" : false },
  () => {
    const root = fs.mkdtempSync(path.join(propertyRoot, "workspace-"));
    const outsideRoot = fs.mkdtempSync(path.join(propertyRoot, "outside-"));
    fs.symlinkSync(outsideRoot, path.join(root, "downloads"), "dir");

    assert.throws(
      () => resolveDownloadSavePath(root, "safe.txt", "downloads/safe.txt"),
      /symlink|destination directory/,
    );
  },
);

test(
  "temp cache symlinks cannot redirect writes outside the temp root",
  { skip: process.platform === "win32" ? "directory symlink support varies on Windows" : false },
  () => {
    const root = fs.mkdtempSync(path.join(propertyRoot, "temp-"));
    const outsideRoot = fs.mkdtempSync(path.join(propertyRoot, "outside-"));
    const bucketDir = path.join(root, "bucket");
    fs.mkdirSync(bucketDir);
    fs.symlinkSync(outsideRoot, path.join(bucketDir, "redirect"), "dir");

    const localPath = buildTempFilePath(root, "bucket", "redirect/file.txt");

    assert.throws(() => assertSafeWritePath(root, localPath), /symlink|destination directory/);
  },
);

test("presigned URL encoding preserves slash separators for nested object names", () => {
  assert.equal(encodeB2FileNameForUrl("photos/2024/img.jpg"), "photos/2024/img.jpg");
  assert.equal(encodeB2FileNameForUrl("reports/q4 final #1.pdf"), "reports/q4%20final%20%231.pdf");
});

test("presigned URL encoding rejects empty path segments", () => {
  assert.throws(() => encodeB2FileNameForUrl("photos//img.jpg"), /empty path segments/);
  assert.throws(
    () => buildB2DownloadUrl("https://download.example.com", "bucket", "/img.jpg", "token"),
    /empty path segments/,
  );
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
