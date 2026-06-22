/**
 * Transfer timeout helpers.
 *
 * @module services/transferTimeout
 */

export const DEFAULT_TRANSFER_STALL_TIMEOUT_MS = 5 * 60 * 1000;

export class TransferStallTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferStallTimeoutError";
  }
}

export interface TransferTimeoutOptions {
  readonly signal?: AbortSignal;
  readonly stallTimeoutMs?: number;
}

export interface ActivityAbortSignal {
  readonly signal: AbortSignal;
  markActivity(): void;
  timeoutError(): TransferStallTimeoutError | undefined;
  dispose(): void;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createActivityAbortSignal(
  parentSignal: AbortSignal | undefined,
  stallTimeoutMs: number,
  description: string,
): ActivityAbortSignal {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut: TransferStallTimeoutError | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const markActivity = () => {
    clearTimer();
    if (stallTimeoutMs <= 0 || controller.signal.aborted) {
      return;
    }

    timer = setTimeout(() => {
      timedOut = new TransferStallTimeoutError(
        `${description} stalled for ${stallTimeoutMs} ms with no transfer activity.`,
      );
      controller.abort(timedOut);
    }, stallTimeoutMs);
    timer.unref?.();
  };

  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    markActivity();
  }

  return {
    signal: controller.signal,
    markActivity,
    timeoutError: () => timedOut,
    dispose() {
      clearTimer();
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function normalizeTransferError(error: unknown, activity: ActivityAbortSignal): never {
  const timeoutError = activity.timeoutError();
  if (timeoutError && (activity.signal.aborted || isAbortLikeError(error))) {
    throw timeoutError;
  }

  throw error;
}

export function abortPromise(signal: AbortSignal): Promise<never> {
  const abortReason = () => signal.reason ?? new DOMException("Aborted", "AbortError");

  if (signal.aborted) {
    return Promise.reject(abortReason());
  }

  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortReason()), { once: true });
  });
}

export async function withTransferStallTimeout<T>(
  description: string,
  options: TransferTimeoutOptions,
  run: (signal: AbortSignal, markActivity: () => void) => Promise<T>,
): Promise<T> {
  const activity = createActivityAbortSignal(
    options.signal,
    options.stallTimeoutMs ?? DEFAULT_TRANSFER_STALL_TIMEOUT_MS,
    description,
  );

  try {
    return await Promise.race([
      run(activity.signal, activity.markActivity),
      abortPromise(activity.signal),
    ]);
  } catch (error) {
    normalizeTransferError(error, activity);
  } finally {
    activity.dispose();
  }
}

export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return run(new AbortController().signal);
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new Error(`${description} timed out after ${timeoutMs} ms.`);
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timer.unref?.();
  });
  const operation = run(controller.signal);
  void operation.catch(() => undefined);

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
