import { B2Client, type Bucket } from "@backblaze-labs/b2-sdk";
import type { StandaloneSimulator } from "./standaloneSimulator";

export const SIMULATOR_BUCKET_NAME = "bucket";

export interface SimulatorClientFixture {
  readonly sim: StandaloneSimulator;
  readonly client: B2Client;
}

export interface SimulatorBucketFixture extends SimulatorClientFixture {
  readonly bucket: Bucket;
}

export async function createSimulatorClient(
  sim: StandaloneSimulator,
): Promise<SimulatorClientFixture> {
  const client = new B2Client({
    applicationKeyId: "test-key-id",
    applicationKey: "test-application-key",
    transport: sim.transport(),
  });

  await client.authorize();
  return { sim, client };
}

export async function createSimulatorBucket(
  sim: StandaloneSimulator,
  bucketName = SIMULATOR_BUCKET_NAME,
): Promise<SimulatorBucketFixture> {
  const { client } = await createSimulatorClient(sim);
  const bucket = await client.createBucket({ bucketName, bucketType: "allPrivate" });

  return { sim, client, bucket };
}
