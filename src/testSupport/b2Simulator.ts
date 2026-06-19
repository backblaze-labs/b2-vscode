import { B2Client, type Bucket } from "@backblaze-labs/b2-sdk";
// @ts-expect-error Classic moduleResolution does not read this package export map.
import { B2Simulator } from "@backblaze-labs/b2-sdk/simulator";

export const SIMULATOR_BUCKET_NAME = "bucket";

export interface SimulatorClientFixture {
  readonly sim: B2Simulator;
  readonly client: B2Client;
}

export interface SimulatorBucketFixture extends SimulatorClientFixture {
  readonly bucket: Bucket;
}

export async function createSimulatorClient(): Promise<SimulatorClientFixture> {
  const sim = new B2Simulator();
  const client = new B2Client({
    applicationKeyId: "test-key-id",
    applicationKey: "test-application-key",
    transport: sim.transport(),
  });

  await client.authorize();
  return { sim, client };
}

export async function createSimulatorBucket(
  bucketName = SIMULATOR_BUCKET_NAME,
): Promise<SimulatorBucketFixture> {
  const { sim, client } = await createSimulatorClient();
  const bucket = await client.createBucket({ bucketName, bucketType: "allPrivate" });

  return { sim, client, bucket };
}
