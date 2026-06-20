/**
 * Upload source identity helpers.
 *
 * @module services/sourceFileIdentity
 */

import * as fs from "fs";

export interface SourceFileIdentity {
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
}

export function sourceIdentityFromStats(realPath: string, stats: fs.Stats): SourceFileIdentity {
  return {
    realPath,
    dev: stats.dev,
    ino: stats.ino,
  };
}

export function assertSameSourceFile(
  expected: SourceFileIdentity | undefined,
  actual: SourceFileIdentity,
): void {
  if (!expected) {
    return;
  }

  if (
    actual.realPath !== expected.realPath ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error("Local upload source changed after workspace authorization.");
  }
}
