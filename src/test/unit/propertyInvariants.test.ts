/**
 * Property-based tests for pure path and URL invariants.
 *
 * @module test/unit/propertyInvariants
 */

import * as assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import * as fc from "fast-check";
import {
  buildTempFilePath,
  isPathInsideRoot,
  resolveDownloadSavePath,
} from "../../utils/localPaths";
import { buildB2DownloadUrl, encodeB2FileNameForUrl } from "../../utils/urlEncoding";
import { humanSize } from "../../utils/humanSize";

const PROPERTY_RUNS = 1000;
const tempRoot = path.join(process.cwd(), ".property-tests", "temp-root");
const workspaceRoot = path.join(process.cwd(), ".property-tests", "workspace");
const b2Name = fc.string({ unit: "binary", maxLength: 128 });
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

function assertInsideRoot(root: string, candidate: string): void {
  assert.equal(isPathInsideRoot(root, candidate), true, `${candidate} should stay inside ${root}`);
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

test("relative download paths cannot escape the workspace", () => {
  fc.assert(
    fc.property(b2Name, b2Name, (remotePath, localPath) => {
      if (path.posix.isAbsolute(localPath) || path.win32.isAbsolute(localPath)) {
        return;
      }

      try {
        assertInsideRoot(
          workspaceRoot,
          resolveDownloadSavePath(workspaceRoot, remotePath, localPath),
        );
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /workspace|NUL/);
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("presigned URL file-name encoding is reversible and has no raw reserved characters", () => {
  fc.assert(
    fc.property(b2Name, (fileName) => {
      const encodedPath = encodeB2FileNameForUrl(fileName);

      assert.equal(encodedPath.includes("//"), false);
      assert.doesNotMatch(encodedPath, reservedUrlCharacters);
      assert.equal(decodeURIComponent(encodedPath), fileName);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test("presigned URLs keep encoded paths and tokens in their URL components", () => {
  fc.assert(
    fc.property(b2Name, b2Name, (fileName, authorizationToken) => {
      const url = buildB2DownloadUrl(
        "https://download.example.com/",
        "bucket",
        fileName,
        authorizationToken,
      );
      const parsedUrl = new URL(url);

      assert.doesNotMatch(parsedUrl.pathname, /\/\//);
      assert.equal(parsedUrl.searchParams.get("Authorization"), authorizationToken);
      assert.equal(
        decodeURIComponent(parsedUrl.pathname.replace(/^\/file\/bucket\//, "")),
        fileName,
      );
    }),
    { numRuns: PROPERTY_RUNS },
  );
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
