/**
 * Tests for bounded B2 listFiles language model tool behavior.
 *
 * @module test/suite/listFiles
 */

import * as assert from "assert";
import * as vscode from "vscode";
import {
  B2Client,
  BufferSource,
  SSE_NONE,
  accountId,
  bucketId,
  fileId,
  type Bucket,
  type FileVersion,
} from "@backblaze-labs/b2-sdk";
// @ts-expect-error Classic moduleResolution does not read this package export map.
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { LIST_FILES_DEFAULT_LIMIT, LIST_FILES_RECURSIVE_LIMIT_CAP } from "../../constants";
import { listFilesOperation } from "../../tools/operations/listFiles";
import type { ToolExtras } from "../../tools/types";

type ListFileNamesOptions = Parameters<Bucket["listFileNames"]>[0];
type ListFileNamesPage = Awaited<ReturnType<Bucket["listFileNames"]>>;

function file(fileName: string, action: "folder" | "upload" = "upload"): FileVersion {
  return {
    accountId: accountId("account-id"),
    fileName,
    action,
    bucketId: bucketId("bucket-id"),
    contentLength: action === "folder" ? 0 : 12,
    contentMd5: null,
    contentSha1: null,
    contentType: action === "folder" ? "" : "text/plain",
    fileId: fileId(`id-${fileName}`),
    fileInfo: {},
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    replicationStatus: null,
    serverSideEncryption: SSE_NONE,
    uploadTimestamp: 0,
  };
}

function makeExtras(pages: ListFileNamesPage[]): {
  readonly extras: ToolExtras;
  readonly calls: ListFileNamesOptions[];
} {
  const calls: ListFileNamesOptions[] = [];
  const remainingPages = [...pages];
  const bucket = {
    async listFileNames(options?: ListFileNamesOptions): Promise<ListFileNamesPage> {
      calls.push(options);
      return remainingPages.shift() ?? { files: [], nextFileName: null };
    },
  } as unknown as Bucket;
  const client = {
    async getBucket(bucketName: string): Promise<Bucket | null> {
      return bucketName === "bucket" ? bucket : null;
    },
  } as unknown as B2Client;

  return {
    extras: { getClient: () => client },
    calls,
  };
}

suite("B2 listFiles tool paging", () => {
  test("returns empty bucket metadata without a continuation token", async () => {
    const { extras, calls } = makeExtras([{ files: [], nextFileName: null }]);

    const result = await listFilesOperation.execute({ bucket: "bucket" }, extras);

    assert.deepStrictEqual(result.files, []);
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.limit, LIST_FILES_DEFAULT_LIMIT);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.nextContinuationToken, null);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.pageSize, LIST_FILES_DEFAULT_LIMIT);
    assert.strictEqual(calls[0]?.delimiter, "/");
  });

  test("preserves deep prefixes, special characters, and continuation input", async () => {
    const prefix = "deep prefix/üñîçødé & symbols/#/";
    const { extras, calls } = makeExtras([
      {
        files: [file(`${prefix}folder/`, "folder"), file(`${prefix}report (final).txt`)],
        nextFileName: null,
      },
    ]);

    const result = await listFilesOperation.execute(
      {
        bucket: "bucket",
        prefix,
        continuationToken: `${prefix}previous.txt`,
        limit: 3,
      },
      extras,
    );

    assert.strictEqual(calls[0]?.prefix, prefix);
    assert.strictEqual(calls[0]?.startFileName, `${prefix}previous.txt`);
    assert.deepStrictEqual(
      result.files.map((entry) => entry.name),
      [`${prefix}folder/`, `${prefix}report (final).txt`],
    );
    assert.strictEqual(result.continuationToken, `${prefix}previous.txt`);
    assert.strictEqual(result.nextContinuationToken, null);
  });

  test("walks multiple bounded pages until the requested limit", async () => {
    const { extras, calls } = makeExtras([
      { files: [file("a.txt"), file("b.txt")], nextFileName: "c.txt" },
      { files: [file("c.txt"), file("d.txt")], nextFileName: "e.txt" },
      { files: [file("e.txt")], nextFileName: "f.txt" },
    ]);

    const result = await listFilesOperation.execute({ bucket: "bucket", limit: 5 }, extras);

    assert.deepStrictEqual(
      result.files.map((entry) => entry.name),
      ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"],
    );
    assert.strictEqual(result.count, 5);
    assert.strictEqual(result.pageCount, 3);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.nextContinuationToken, "f.txt");
    assert.deepStrictEqual(
      calls.map((call) => call?.startFileName ?? null),
      [null, "c.txt", "e.txt"],
    );
  });

  test("applies recursive hard cap and truncation metadata", async () => {
    const recursiveFiles = Array.from({ length: LIST_FILES_RECURSIVE_LIMIT_CAP }, (_, index) =>
      file(`recursive/${index}.txt`),
    );
    const { extras, calls } = makeExtras([
      { files: recursiveFiles, nextFileName: "recursive/more.txt" },
    ]);

    const result = await listFilesOperation.execute(
      { bucket: "bucket", recursive: true, limit: 9999 },
      extras,
    );

    assert.strictEqual(result.recursive, true);
    assert.strictEqual(result.limit, LIST_FILES_RECURSIVE_LIMIT_CAP);
    assert.strictEqual(result.requestedLimit, 9999);
    assert.strictEqual(result.limitWasCapped, true);
    assert.strictEqual(result.count, LIST_FILES_RECURSIVE_LIMIT_CAP);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.nextContinuationToken, "recursive/more.txt");
    assert.strictEqual(calls[0]?.delimiter, undefined);
    assert.strictEqual(calls[0]?.pageSize, LIST_FILES_RECURSIVE_LIMIT_CAP);
  });

  test("rejects invalid limits before listing", async () => {
    const { extras, calls } = makeExtras([{ files: [file("unused.txt")], nextFileName: null }]);

    await assert.rejects(
      () => listFilesOperation.execute({ bucket: "bucket", limit: 0 }, extras),
      /positive integer/,
    );
    assert.strictEqual(calls.length, 0);
  });

  test("honors cancellation before making a listing request", async () => {
    const { extras, calls } = makeExtras([{ files: [file("unused.txt")], nextFileName: null }]);
    const tokenSource = new vscode.CancellationTokenSource();
    tokenSource.cancel();

    try {
      await assert.rejects(
        () => listFilesOperation.execute({ bucket: "bucket" }, extras, tokenSource.token),
        vscode.CancellationError,
      );
      assert.strictEqual(calls.length, 0);
    } finally {
      tokenSource.dispose();
    }
  });

  test("works with SDK rate-limit retry on bounded list pages", async () => {
    const sim = new B2Simulator();
    const client = new B2Client({
      applicationKeyId: "test",
      applicationKey: "test",
      transport: sim.transport(),
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    });
    await client.authorize();
    const bucket = await client.createBucket({
      bucketName: "bucket",
      bucketType: "allPrivate",
    });
    await bucket.upload({
      fileName: "retry/file.txt",
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    });
    sim.injectFailure({
      on: "b2_list_file_names",
      status: 429,
      code: "too_many_requests",
      message: "slow down",
      count: 1,
    });

    const result = await listFilesOperation.execute(
      { bucket: "bucket", prefix: "retry/", limit: 10 },
      { getClient: () => client },
    );

    assert.deepStrictEqual(
      result.files.map((entry) => entry.name),
      ["retry/file.txt"],
    );
    assert.strictEqual(result.truncated, false);
  });
});
