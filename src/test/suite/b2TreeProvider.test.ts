/**
 * Tests for B2 tree provider paging and error handling.
 *
 * @module test/suite/b2TreeProvider
 */

import * as assert from "assert";
import * as vscode from "vscode";
import {
  SSE_NONE,
  accountId,
  bucketId,
  classifyError,
  fileId,
  type B2Client,
  type Bucket,
  type FileVersion,
} from "@backblaze-labs/b2-sdk";
import { TREE_LIST_HARD_CAP, TREE_LIST_PAGE_SIZE } from "../../constants";
import type { AuthService } from "../../services/authService";
import { BucketTreeItem } from "../../models/bucketTreeItem";
import { FolderTreeItem } from "../../models/folderTreeItem";
import { ListingLimitTreeItem } from "../../models/listingLimitTreeItem";
import { LoadMoreTreeItem } from "../../models/loadMoreTreeItem";
import { B2TreeProvider, buildTreeErrorMessage } from "../../providers/b2TreeProvider";

type ListFileNamesOptions = Parameters<Bucket["listFileNames"]>[0];
type ListFileNamesPage = Awaited<ReturnType<Bucket["listFileNames"]>>;
type ListFileNamesPageSource = ListFileNamesPage | (() => Promise<ListFileNamesPage>);

function file(fileName: string, action: "folder" | "upload" = "upload"): FileVersion {
  return {
    accountId: accountId("account-id"),
    fileName,
    action,
    bucketId: bucketId("bucket-id"),
    contentLength: action === "folder" ? 0 : 5,
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

function fakeAuthService(): AuthService {
  return {
    onAuthStateChanged() {
      return { dispose() {} };
    },
  } as unknown as AuthService;
}

function makeBucket(pages: ListFileNamesPageSource[]): {
  readonly bucket: Bucket;
  readonly calls: ListFileNamesOptions[];
} {
  const calls: ListFileNamesOptions[] = [];
  const remainingPages = [...pages];
  const bucket = {
    id: "bucket-id",
    name: "bucket",
    info: { bucketType: "allPrivate" },
    async listFileNames(options?: ListFileNamesOptions): Promise<ListFileNamesPage> {
      calls.push(options);
      const nextPage = remainingPages.shift();
      if (typeof nextPage === "function") {
        return nextPage();
      }
      return nextPage ?? { files: [], nextFileName: null };
    },
  } as unknown as Bucket;

  return { bucket, calls };
}

function makeProvider(bucket: Bucket): B2TreeProvider {
  const client = {
    accountInfo: { getAccountId: () => "account-id" },
    async listBuckets(): Promise<Bucket[]> {
      return [bucket];
    },
  } as unknown as B2Client;
  const provider = new B2TreeProvider(fakeAuthService());
  provider.setClient(client);
  return provider;
}

function label(item: vscode.TreeItem): string {
  return typeof item.label === "string" ? item.label : (item.label?.label ?? "");
}

async function withShowErrorMessageStub<T>(
  callback: () => Promise<T>,
): Promise<{ result: T; messages: string[] }> {
  const original = vscode.window.showErrorMessage;
  const messages: string[] = [];

  Object.defineProperty(vscode.window, "showErrorMessage", {
    configurable: true,
    value: ((message: string) => {
      messages.push(message);
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showErrorMessage,
  });

  try {
    return { result: await callback(), messages };
  } finally {
    Object.defineProperty(vscode.window, "showErrorMessage", {
      configurable: true,
      value: original,
    });
  }
}

suite("B2 tree provider paging", () => {
  test("returns an empty bucket without a load-more item", async () => {
    const { bucket, calls } = makeBucket([{ files: [], nextFileName: null }]);
    const provider = makeProvider(bucket);

    const children = await provider.getChildren(new BucketTreeItem(bucket));

    assert.deepStrictEqual(children, []);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.delimiter, "/");
    assert.strictEqual(calls[0]?.pageSize, TREE_LIST_PAGE_SIZE);
  });

  test("appends load-more and fetches the next page on command", async () => {
    const { bucket, calls } = makeBucket([
      { files: [file("sub/", "folder"), file("a.txt")], nextFileName: "b.txt" },
      { files: [file("b.txt")], nextFileName: null },
    ]);
    const provider = makeProvider(bucket);
    const bucketItem = new BucketTreeItem(bucket);

    const firstPage = await provider.getChildren(bucketItem);
    assert.deepStrictEqual(firstPage.map(label), ["sub", "a.txt", "Load more"]);
    assert.ok(firstPage[2] instanceof LoadMoreTreeItem);

    await provider.loadMore(firstPage[2] as LoadMoreTreeItem);
    const secondPage = await provider.getChildren(bucketItem);

    assert.deepStrictEqual(secondPage.map(label), ["sub", "a.txt", "b.txt"]);
    assert.deepStrictEqual(
      calls.map((call) => call?.startFileName ?? null),
      [null, "b.txt"],
    );
  });

  test("ignores duplicate load-more activation while a page is in flight", async () => {
    let releasePage: (() => void) | undefined;
    const secondPageReady = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const { bucket, calls } = makeBucket([
      { files: [file("a.txt")], nextFileName: "b.txt" },
      async () => {
        await secondPageReady;
        return { files: [file("b.txt")], nextFileName: null };
      },
    ]);
    const provider = makeProvider(bucket);
    const bucketItem = new BucketTreeItem(bucket);
    const firstPage = await provider.getChildren(bucketItem);
    const loadMore = firstPage[firstPage.length - 1];
    assert.ok(loadMore instanceof LoadMoreTreeItem);

    const firstLoad = provider.loadMore(loadMore as LoadMoreTreeItem);
    const secondLoad = provider.loadMore(loadMore as LoadMoreTreeItem);
    releasePage?.();
    await Promise.all([firstLoad, secondLoad]);
    const loadedChildren = await provider.getChildren(bucketItem);

    assert.deepStrictEqual(loadedChildren.map(label), ["a.txt", "b.txt"]);
    assert.strictEqual(calls.length, 2);
  });

  test("ignores stale load-more items after refresh clears state", async () => {
    const { bucket, calls } = makeBucket([
      { files: [file("a.txt")], nextFileName: "b.txt" },
      { files: [file("fresh.txt")], nextFileName: null },
    ]);
    const provider = makeProvider(bucket);
    const bucketItem = new BucketTreeItem(bucket);
    const firstPage = await provider.getChildren(bucketItem);
    const loadMore = firstPage[firstPage.length - 1];
    assert.ok(loadMore instanceof LoadMoreTreeItem);

    provider.refresh();
    await provider.loadMore(loadMore as LoadMoreTreeItem);

    assert.strictEqual(calls.length, 1);

    const refreshedChildren = await provider.getChildren(bucketItem);

    assert.deepStrictEqual(refreshedChildren.map(label), ["fresh.txt"]);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1]?.startFileName, undefined);
  });

  test("coalesces concurrent initial listings for the same prefix", async () => {
    let releasePage: (() => void) | undefined;
    const firstPageReady = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const { bucket, calls } = makeBucket([
      async () => {
        await firstPageReady;
        return { files: [file("a.txt")], nextFileName: null };
      },
    ]);
    const provider = makeProvider(bucket);
    const bucketItem = new BucketTreeItem(bucket);

    const firstLoad = provider.getChildren(bucketItem);
    const secondLoad = provider.getChildren(bucketItem);
    releasePage?.();
    const [firstChildren, secondChildren] = await Promise.all([firstLoad, secondLoad]);

    assert.deepStrictEqual(firstChildren.map(label), ["a.txt"]);
    assert.deepStrictEqual(secondChildren.map(label), ["a.txt"]);
    assert.strictEqual(calls.length, 1);
  });

  test("caps oversized initial pages to the requested tree page size", async () => {
    const oversizedFiles = Array.from({ length: TREE_LIST_PAGE_SIZE + 25 }, (_, index) =>
      file(`item-${index}.txt`),
    );
    const { bucket, calls } = makeBucket([
      { files: oversizedFiles, nextFileName: "sdk-next.txt" },
      { files: [], nextFileName: null },
    ]);
    const provider = makeProvider(bucket);
    const bucketItem = new BucketTreeItem(bucket);

    const children = await provider.getChildren(bucketItem);

    assert.strictEqual(calls[0]?.pageSize, TREE_LIST_PAGE_SIZE);
    assert.strictEqual(children.length, TREE_LIST_PAGE_SIZE + 1);
    assert.strictEqual(
      label(children[TREE_LIST_PAGE_SIZE - 1]),
      `item-${TREE_LIST_PAGE_SIZE - 1}.txt`,
    );
    assert.ok(children[TREE_LIST_PAGE_SIZE] instanceof LoadMoreTreeItem);

    await provider.loadMore(children[TREE_LIST_PAGE_SIZE] as LoadMoreTreeItem);

    assert.strictEqual(calls[1]?.startFileName, `item-${TREE_LIST_PAGE_SIZE}.txt`);
  });

  test("preserves deep prefixes and special characters when listing folders", async () => {
    const prefix = "deep prefix/üñîçødé & symbols/#/";
    const { bucket, calls } = makeBucket([
      { files: [file(`${prefix}file (1).txt`)], nextFileName: null },
    ]);
    const provider = makeProvider(bucket);

    const children = await provider.getChildren(new FolderTreeItem(bucket, prefix));

    assert.deepStrictEqual(children.map(label), ["file (1).txt"]);
    assert.strictEqual(calls[0]?.prefix, prefix);
    assert.strictEqual(calls[0]?.delimiter, "/");
  });

  test("stops loading and shows a cap notice at the tree hard cap", async () => {
    const pages = Array.from({ length: 5 }, (_, pageIndex): ListFileNamesPage => {
      const start = pageIndex * TREE_LIST_PAGE_SIZE;
      return {
        files: Array.from({ length: TREE_LIST_PAGE_SIZE }, (_, itemIndex) =>
          file(`item-${start + itemIndex}.txt`),
        ),
        nextFileName: pageIndex === 4 ? "item-more.txt" : `item-${start + TREE_LIST_PAGE_SIZE}.txt`,
      };
    });
    const { bucket, calls } = makeBucket(pages);
    const provider = makeProvider(bucket);
    const bucketItem = new BucketTreeItem(bucket);

    let children = await provider.getChildren(bucketItem);
    for (let index = 0; index < 4; index++) {
      const loadMore = children[children.length - 1];
      assert.ok(loadMore instanceof LoadMoreTreeItem);
      await provider.loadMore(loadMore);
      children = await provider.getChildren(bucketItem);
    }

    assert.strictEqual(children.length, TREE_LIST_HARD_CAP + 1);
    assert.ok(children[children.length - 1] instanceof ListingLimitTreeItem);
    assert.strictEqual(calls.length, 5);
    assert.strictEqual(
      calls.every((call) => call?.pageSize === TREE_LIST_PAGE_SIZE),
      true,
    );
  });
});

suite("B2 tree provider error handling", () => {
  test("builds a specific tree error message", () => {
    const message = buildTreeErrorMessage(
      classifyError({ status: 403, code: "access_denied", message: "missing cap" }),
    );

    assert.match(message, /Could not load bucket contents/i);
    assert.match(message, /missing permission/i);
  });

  test("returns an empty tree and shows a rate-limit message on list failure", async () => {
    const provider = new B2TreeProvider(fakeAuthService());
    provider.setClient({
      accountInfo: { getAccountId: () => "account-1" },
      async listBuckets() {
        throw classifyError(
          { status: 429, code: "too_many_requests", message: "slow down" },
          { retryAfter: 11 },
        );
      },
    } as unknown as B2Client);

    const { result, messages } = await withShowErrorMessageStub(() => provider.getChildren());

    assert.deepStrictEqual(result, []);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /rate limit/i);
    assert.match(messages[0], /11 seconds/i);
  });
});
