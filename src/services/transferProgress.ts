/**
 * VS Code progress and cancellation helpers for transfer operations.
 *
 * @module services/transferProgress
 */

import * as vscode from "vscode";
import type { ProgressEvent, ProgressListener } from "@backblaze-labs/b2-sdk";
import { humanSize } from "../utils/humanSize";

export interface TransferProgressOptions {
  readonly title: string;
  readonly token?: vscode.CancellationToken;
}

export interface TransferRunContext {
  readonly progress: vscode.Progress<{ message?: string; increment?: number }>;
  readonly signal: AbortSignal;
}

function cancellationError(): vscode.CancellationError {
  return new vscode.CancellationError();
}

export async function withCancellableTransferProgress<T>(
  options: TransferProgressOptions,
  run: (context: TransferRunContext) => Promise<T>,
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.title,
      cancellable: true,
    },
    async (progress, progressToken) => {
      const controller = new AbortController();
      const disposables: vscode.Disposable[] = [];

      const cancel = () => {
        if (!controller.signal.aborted) {
          controller.abort(cancellationError());
        }
      };

      if (options.token?.isCancellationRequested || progressToken.isCancellationRequested) {
        throw cancellationError();
      }

      if (options.token) {
        disposables.push(options.token.onCancellationRequested(cancel));
      }
      disposables.push(progressToken.onCancellationRequested(cancel));

      try {
        return await run({ progress, signal: controller.signal });
      } catch (error) {
        if (
          controller.signal.aborted ||
          options.token?.isCancellationRequested ||
          progressToken.isCancellationRequested
        ) {
          throw cancellationError();
        }
        throw error;
      } finally {
        for (const disposable of disposables) {
          disposable.dispose();
        }
      }
    },
  );
}

export function createTransferProgressReporter(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  totalBytesOverride?: number,
): ProgressListener {
  let previousPercent = 0;

  return (event: ProgressEvent) => {
    const totalBytes = event.totalBytes ?? totalBytesOverride ?? null;
    const report: { message?: string; increment?: number } = {
      message:
        totalBytes && totalBytes > 0
          ? `${humanSize(event.bytesTransferred)} of ${humanSize(totalBytes)}`
          : humanSize(event.bytesTransferred),
    };

    if (totalBytes && totalBytes > 0) {
      const percent = Math.min(100, (event.bytesTransferred / totalBytes) * 100);
      const increment = percent - previousPercent;
      previousPercent = percent;
      if (increment > 0) {
        report.increment = increment;
      }
    }

    progress.report(report);
  };
}
