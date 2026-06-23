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

export interface FixedTimeoutOptions {
  readonly signal?: AbortSignal;
  readonly createTimeoutError?: (description: string, timeoutMs: number) => Error;
}

export interface ActivityAbortSignal {
  readonly signal: AbortSignal;
  markActivity(): void;
  timeoutError(): TransferStallTimeoutError | undefined;
  dispose(): void;
}

function linkParentAbort(parentSignal: AbortSignal | undefined): {
  readonly controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    controller,
    dispose() {
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createActivityAbortSignal(
  parentSignal: AbortSignal | undefined,
  stallTimeoutMs: number,
  description: string,
): ActivityAbortSignal {
  const linkedAbort = linkParentAbort(parentSignal);
  const { controller } = linkedAbort;
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

  if (!parentSignal?.aborted) {
    markActivity();
  }

  return {
    signal: controller.signal,
    markActivity,
    timeoutError: () => timedOut,
    dispose() {
      clearTimer();
      linkedAbort.dispose();
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

function runWithAbortSignal<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return Promise.resolve().then(() => run(signal));
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
  options: FixedTimeoutOptions = {},
): Promise<T> {
  const parentSignal = options.signal;
  const linkedAbort = linkParentAbort(parentSignal);
  const { controller } = linkedAbort;
  if (timeoutMs <= 0) {
    const operation = runWithAbortSignal(run, controller.signal);
    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, abortPromise(controller.signal)]);
    } finally {
      linkedAbort.dispose();
    }
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeoutError =
        options.createTimeoutError?.(description, timeoutMs) ??
        new Error(`${description} timed out after ${timeoutMs} ms.`);
      if (!controller.signal.aborted) {
        controller.abort(timeoutError);
      }
      reject(timeoutError);
    }, timeoutMs);
    timer.unref?.();
  });
  const operation = runWithAbortSignal(run, controller.signal);
  void operation.catch(() => undefined);

  try {
    return await Promise.race([operation, timeout, abortPromise(controller.signal)]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    linkedAbort.dispose();
  }
}
