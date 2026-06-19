/**
 * Simulator-backed happy-path and security-boundary tests for B2 language model tools.
 *
 * @module test/suite/lmToolOperations
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { BufferSource, type FileVersion } from "@backblaze-labs/b2-sdk";
import { deleteFileOperation } from "../../tools/operations/deleteFile";
import { downloadFileOperation } from "../../tools/operations/downloadFile";
import { getFileInfoOperation } from "../../tools/operations/getFileInfo";
import { listBucketsOperation } from "../../tools/operations/listBuckets";
import { listFilesOperation } from "../../tools/operations/listFiles";
import {
  MAX_PRESIGN_URL_EXPIRATION_SECONDS,
  presignUrlOperation,
} from "../../tools/operations/presignUrl";
import { uploadFileOperation } from "../../tools/operations/uploadFile";
import type { ToolExtras } from "../../tools/types";
import {
  createSimulatorBucket,
  SIMULATOR_BUCKET_NAME,
  type SimulatorBucketFixture,
} from "../../testSupport/b2Simulator";

const REMOTE_PATH = "folder/source file.txt";
const CONTENT = "hello from the simulator";

interface UploadedToolFixture extends SimulatorBucketFixture {
  readonly extras: ToolExtras;
  readonly uploaded: FileVersion;
}

async function createUploadedToolFixture(): Promise<UploadedToolFixture> {
  const fixture = await createSimulatorBucket();
  const uploaded = await fixture.bucket.upload({
    fileName: REMOTE_PATH,
    source: new BufferSource(Buffer.from(CONTENT)),
  });

  return {
    ...fixture,
    extras: { getClient: () => fixture.client },
    uploaded,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-lm-tools-"));
}

async function withWorkspaceFolders<T>(
  workspacePaths: string[],
  run: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
  const mutableWorkspace = vscode.workspace as unknown as Record<string, unknown>;
  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    value: workspacePaths.map((workspacePath, index) => ({
      uri: vscode.Uri.file(workspacePath),
      name: `workspace-${index}`,
      index,
    })),
  });

  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(vscode.workspace, "workspaceFolders", descriptor);
    } else {
      delete mutableWorkspace.workspaceFolders;
    }
  }
}

async function withWorkspaceFolder<T>(workspacePath: string, run: () => Promise<T>): Promise<T> {
  return withWorkspaceFolders([workspacePath], run);
}

suite("B2 LM tool operations with simulator", () => {
  test("listBuckets returns simulator bucket metadata", async () => {
    const { client } = await createSimulatorBucket();

    const result = await listBucketsOperation.execute({}, { getClient: () => client });

    assert.deepStrictEqual(
      result.buckets.map((bucket) => bucket.name),
      [SIMULATOR_BUCKET_NAME],
    );
    assert.strictEqual(result.count, 1);
  });

  test("uploadFile uploads a local file to B2", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const { client } = await createSimulatorBucket();
    const localPath = path.join(workspaceRoot, "source file.txt");

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.writeFileSync(localPath, CONTENT);

      const uploaded = await withWorkspaceFolder(workspaceRoot, () =>
        uploadFileOperation.execute(
          { localPath: "source file.txt", bucket: SIMULATOR_BUCKET_NAME, remotePath: REMOTE_PATH },
          { getClient: () => client },
        ),
      );

      assert.strictEqual(uploaded.fileName, REMOTE_PATH);
      assert.strictEqual(uploaded.size, Buffer.byteLength(CONTENT));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uploadFile rejects absolute paths outside the workspace", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const outsideRoot = path.join(dir, "outside");
    const localPath = path.join(outsideRoot, "secret.txt");
    const { client } = await createSimulatorBucket();

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(outsideRoot, { recursive: true });
      fs.writeFileSync(localPath, "secret");

      await withWorkspaceFolder(workspaceRoot, () =>
        assert.rejects(
          () =>
            uploadFileOperation.execute(
              { localPath, bucket: SIMULATOR_BUCKET_NAME, remotePath: "loot/secret.txt" },
              { getClient: () => client },
            ),
          /localPath must be a relative path inside the allowed directory/i,
        ),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uploadFile rejects workspace-relative traversal outside the workspace", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const localPath = path.join(dir, "secret.txt");
    const { client } = await createSimulatorBucket();

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.writeFileSync(localPath, "secret");

      await withWorkspaceFolder(workspaceRoot, () =>
        assert.rejects(
          () =>
            uploadFileOperation.execute(
              { localPath: "../secret.txt", bucket: SIMULATOR_BUCKET_NAME },
              { getClient: () => client },
            ),
          /localPath must stay within an open workspace folder/i,
        ),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uploadFile rejects workspace-relative paths through workspace symlinks", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const outsideRoot = path.join(dir, "outside");
    const symlinkPath = path.join(workspaceRoot, "link");
    const localPath = path.join(outsideRoot, "secret.txt");
    const { client } = await createSimulatorBucket();

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(outsideRoot, { recursive: true });
      fs.writeFileSync(localPath, "secret");
      fs.symlinkSync(outsideRoot, symlinkPath, process.platform === "win32" ? "junction" : "dir");

      await withWorkspaceFolder(workspaceRoot, () =>
        assert.rejects(
          () =>
            uploadFileOperation.execute(
              { localPath: path.join("link", "secret.txt"), bucket: SIMULATOR_BUCKET_NAME },
              { getClient: () => client },
            ),
          /localPath must stay within an open workspace folder/i,
        ),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listFiles returns uploaded files under a prefix", async () => {
    const { extras } = await createUploadedToolFixture();

    const result = await listFilesOperation.execute(
      { bucket: SIMULATOR_BUCKET_NAME, prefix: "folder/", limit: 10 },
      extras,
    );

    assert.deepStrictEqual(
      result.files.map((file) => file.name),
      [REMOTE_PATH],
    );
    assert.strictEqual(result.truncated, false);
  });

  test("getFileInfo returns uploaded file metadata", async () => {
    const { extras, uploaded } = await createUploadedToolFixture();

    const info = await getFileInfoOperation.execute(
      { bucket: SIMULATOR_BUCKET_NAME, path: REMOTE_PATH },
      extras,
    );

    assert.strictEqual(info.fileName, REMOTE_PATH);
    assert.strictEqual(info.fileId, uploaded.fileId);
    assert.strictEqual(info.size, Buffer.byteLength(CONTENT));
  });

  test("downloadFile writes the requested B2 object to localPath", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const { extras } = await createUploadedToolFixture();
    const downloadPath = path.join(workspaceRoot, "downloads", "source file.txt");

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });

      const downloaded = await withWorkspaceFolder(workspaceRoot, () =>
        downloadFileOperation.execute(
          {
            bucket: SIMULATOR_BUCKET_NAME,
            path: REMOTE_PATH,
            localPath: path.join("downloads", "source file.txt"),
          },
          extras,
        ),
      );

      assert.strictEqual(downloaded.localPath, downloadPath);
      assert.strictEqual(downloaded.size, Buffer.byteLength(CONTENT));
      assert.strictEqual(fs.readFileSync(downloadPath, "utf8"), CONTENT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloadFile rejects absolute paths outside the workspace", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const outsideRoot = path.join(dir, "outside");
    const escapePath = path.join(outsideRoot, "escape.txt");
    const { extras } = await createUploadedToolFixture();

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(outsideRoot, { recursive: true });

      await withWorkspaceFolder(workspaceRoot, () =>
        assert.rejects(
          () =>
            downloadFileOperation.execute(
              {
                bucket: SIMULATOR_BUCKET_NAME,
                path: REMOTE_PATH,
                localPath: escapePath,
              },
              extras,
            ),
          /localPath must be a relative path inside the allowed directory/i,
        ),
      );

      assert.strictEqual(fs.existsSync(escapePath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloadFile rejects absolute paths inside a secondary workspace folder", async () => {
    const dir = tempDir();
    const firstWorkspace = path.join(dir, "workspace-a");
    const secondWorkspace = path.join(dir, "workspace-b");
    const downloadPath = path.join(secondWorkspace, "downloads", "source file.txt");
    const { extras } = await createUploadedToolFixture();

    try {
      fs.mkdirSync(firstWorkspace, { recursive: true });
      fs.mkdirSync(secondWorkspace, { recursive: true });

      await withWorkspaceFolders([firstWorkspace, secondWorkspace], () =>
        assert.rejects(
          () =>
            downloadFileOperation.execute(
              { bucket: SIMULATOR_BUCKET_NAME, path: REMOTE_PATH, localPath: downloadPath },
              extras,
            ),
          /localPath must be a relative path inside the allowed directory/i,
        ),
      );

      assert.strictEqual(fs.existsSync(downloadPath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloadFile rejects workspace-relative traversal outside the workspace", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const escapePath = path.join(dir, "escape.txt");
    const { client } = await createSimulatorBucket();
    const extras: ToolExtras = { getClient: () => client };

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });

      await withWorkspaceFolder(workspaceRoot, () =>
        assert.rejects(
          () =>
            downloadFileOperation.execute(
              {
                bucket: SIMULATOR_BUCKET_NAME,
                path: REMOTE_PATH,
                localPath: "../escape.txt",
              },
              extras,
            ),
          /localPath must not contain path traversal segments/i,
        ),
      );

      assert.strictEqual(fs.existsSync(escapePath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloadFile rejects workspace-relative paths through workspace symlinks", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const outsideRoot = path.join(dir, "outside");
    const symlinkPath = path.join(workspaceRoot, "link");
    const escapePath = path.join(outsideRoot, "outside.txt");
    const { extras } = await createUploadedToolFixture();

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.mkdirSync(outsideRoot, { recursive: true });
      fs.symlinkSync(outsideRoot, symlinkPath, process.platform === "win32" ? "junction" : "dir");

      await withWorkspaceFolder(workspaceRoot, () =>
        assert.rejects(
          () =>
            downloadFileOperation.execute(
              {
                bucket: SIMULATOR_BUCKET_NAME,
                path: REMOTE_PATH,
                localPath: path.join("link", "outside.txt"),
              },
              extras,
            ),
          /Workspace download directory must be a real directory/i,
        ),
      );

      assert.strictEqual(fs.existsSync(escapePath), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloadFile allows in-workspace names that start with two dots", async () => {
    const dir = tempDir();
    const workspaceRoot = path.join(dir, "workspace");
    const expectedPath = path.join(workspaceRoot, "..notes.txt");
    const { extras } = await createUploadedToolFixture();

    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });

      const downloaded = await withWorkspaceFolder(workspaceRoot, () =>
        downloadFileOperation.execute(
          {
            bucket: SIMULATOR_BUCKET_NAME,
            path: REMOTE_PATH,
            localPath: "..notes.txt",
          },
          extras,
        ),
      );

      assert.strictEqual(downloaded.localPath, expectedPath);
      assert.strictEqual(fs.readFileSync(expectedPath, "utf8"), CONTENT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("presignUrl returns an encoded prefix URL with an authorization query parameter", async () => {
    const { extras } = await createUploadedToolFixture();

    const presigned = await presignUrlOperation.execute(
      { bucket: SIMULATOR_BUCKET_NAME, path: REMOTE_PATH, expiresIn: 123 },
      extras,
    );

    const url = new URL(presigned.url);
    assert.strictEqual(presigned.expiresIn, 123);
    assert.strictEqual(url.pathname, `/file/${SIMULATOR_BUCKET_NAME}/folder/source%20file.txt`);
    assert.ok(url.searchParams.get("Authorization"));
    assert.match(presigned.message, /current and future objects whose names start/i);
  });

  test("presignUrl rejects bucket and folder prefix authorizations", async () => {
    const { extras } = await createUploadedToolFixture();

    for (const unsafePath of ["", "folder/"]) {
      await assert.rejects(
        () =>
          presignUrlOperation.execute(
            { bucket: SIMULATOR_BUCKET_NAME, path: unsafePath, expiresIn: 123 },
            extras,
          ),
        /path must not be empty or a folder prefix/i,
      );
    }
  });

  test("presignUrl documents prefix reachability for later sibling objects", async () => {
    const { sim, bucket, extras } = await createUploadedToolFixture();
    const presigned = await presignUrlOperation.execute(
      { bucket: SIMULATOR_BUCKET_NAME, path: REMOTE_PATH, expiresIn: 123 },
      extras,
    );
    const url = new URL(presigned.url);
    const authorization = url.searchParams.get("Authorization");
    assert.ok(authorization);

    await bucket.upload({
      fileName: `${REMOTE_PATH}.copy`,
      source: new BufferSource(Buffer.from("copy")),
    });

    const siblingPath = `${REMOTE_PATH}.copy`.split("/").map(encodeURIComponent).join("/");
    const siblingDownload = sim.handleDownload(
      `/file/${SIMULATOR_BUCKET_NAME}/${siblingPath}?Authorization=${encodeURIComponent(
        authorization,
      )}`,
      { authorization },
    );

    assert.strictEqual(siblingDownload.status, 200);
    assert.strictEqual(Buffer.from(siblingDownload.data ?? []).toString(), "copy");
    assert.match(presigned.message, /current and future objects whose names start/i);
  });

  test("presignUrl rejects expirations beyond the B2 maximum", async () => {
    const { extras } = await createUploadedToolFixture();

    await assert.rejects(
      () =>
        presignUrlOperation.execute(
          {
            bucket: SIMULATOR_BUCKET_NAME,
            path: REMOTE_PATH,
            expiresIn: MAX_PRESIGN_URL_EXPIRATION_SECONDS + 1,
          },
          extras,
        ),
      /expiresIn must be an integer between 1 and 604800 seconds/i,
    );
  });

  test("deleteFile removes the requested file version", async () => {
    const { bucket, extras } = await createUploadedToolFixture();

    const deleted = await deleteFileOperation.execute(
      { bucket: SIMULATOR_BUCKET_NAME, path: REMOTE_PATH },
      extras,
    );

    assert.match(deleted.message, /Deleted folder\/source file\.txt/);
    assert.strictEqual(await bucket.getFileInfoByName(REMOTE_PATH), null);
  });
});
