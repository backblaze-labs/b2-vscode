/**
 * Simulator-backed happy-path tests for all B2 language model tool operations.
 *
 * @module test/suite/lmToolOperations
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { B2Client } from "@backblaze-labs/b2-sdk";
// @ts-expect-error Classic moduleResolution does not read this package export map.
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";
import { deleteFileOperation } from "../../tools/operations/deleteFile";
import { downloadFileOperation } from "../../tools/operations/downloadFile";
import { getFileInfoOperation } from "../../tools/operations/getFileInfo";
import { listBucketsOperation } from "../../tools/operations/listBuckets";
import { listFilesOperation } from "../../tools/operations/listFiles";
import { presignUrlOperation } from "../../tools/operations/presignUrl";
import { uploadFileOperation } from "../../tools/operations/uploadFile";
import type { ToolExtras } from "../../tools/types";

async function createSimulatorClient(): Promise<B2Client> {
  const sim = new B2Simulator();
  const client = new B2Client({
    applicationKeyId: "test-key-id",
    applicationKey: "test-application-key",
    transport: sim.transport(),
  });

  await client.authorize();
  await client.createBucket({ bucketName: "bucket", bucketType: "allPrivate" });
  return client;
}

suite("B2 LM tool operations with simulator", () => {
  test("executes all seven tool operations without a live B2 account", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-vscode-lm-tools-"));
    const client = await createSimulatorClient();
    const extras: ToolExtras = { getClient: () => client };
    const localPath = path.join(dir, "source file.txt");
    const downloadPath = path.join(dir, "downloads", "source file.txt");
    const remotePath = "folder/source file.txt";
    const content = "hello from the simulator";

    try {
      fs.writeFileSync(localPath, content);

      const uploaded = await uploadFileOperation.execute(
        { localPath, bucket: "bucket", remotePath },
        extras,
      );
      assert.strictEqual(uploaded.fileName, remotePath);
      assert.strictEqual(uploaded.size, Buffer.byteLength(content));

      const buckets = await listBucketsOperation.execute({}, extras);
      assert.deepStrictEqual(
        buckets.buckets.map((bucket) => bucket.name),
        ["bucket"],
      );
      assert.strictEqual(buckets.count, 1);

      const files = await listFilesOperation.execute(
        { bucket: "bucket", prefix: "folder/", limit: 10 },
        extras,
      );
      assert.deepStrictEqual(
        files.files.map((file) => file.name),
        [remotePath],
      );
      assert.strictEqual(files.truncated, false);

      const info = await getFileInfoOperation.execute(
        { bucket: "bucket", path: remotePath },
        extras,
      );
      assert.strictEqual(info.fileName, remotePath);
      assert.strictEqual(info.fileId, uploaded.fileId);
      assert.strictEqual(info.size, Buffer.byteLength(content));

      const downloaded = await downloadFileOperation.execute(
        { bucket: "bucket", path: remotePath, localPath: downloadPath },
        extras,
      );
      assert.strictEqual(downloaded.localPath, downloadPath);
      assert.strictEqual(downloaded.size, Buffer.byteLength(content));
      assert.strictEqual(fs.readFileSync(downloadPath, "utf8"), content);

      const presigned = await presignUrlOperation.execute(
        { bucket: "bucket", path: remotePath, expiresIn: 123 },
        extras,
      );
      assert.strictEqual(presigned.expiresIn, 123);
      assert.match(
        presigned.url,
        /\/file\/bucket\/folder\/source%20file\.txt\?Authorization=sim_dl_auth_/,
      );

      const deleted = await deleteFileOperation.execute(
        { bucket: "bucket", path: remotePath },
        extras,
      );
      assert.match(deleted.message, /Deleted folder\/source file\.txt/);

      const bucket = await client.getBucket("bucket");
      assert.ok(bucket);
      assert.strictEqual(await bucket.getFileInfoByName(remotePath), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
