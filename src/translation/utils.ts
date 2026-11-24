/**
 * Small abort/timing helpers shared by the provider and the service.
 * Everything here is environment-agnostic (Node or DOM) and unit-testable.
 */

export interface CombinedAbort {
  /** Aborts when the external signal aborts or the internal timeout fires. */
  readonly signal: AbortSignal;
  /** True once the internal timeout fired (as opposed to the external signal). */
  didTimeout(): boolean;
}

/** DOMException is not available in every environment; degrade gracefully. */
function abortError(message = 'The operation was aborted.'): Error {
  try {
    return new DOMException(message, 'AbortError');
  } catch {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }
}

/** Reads the optional abort reason without depending on newer DOM libs. */
function signalReason(signal: AbortSignal): unknown {
  return (signal as { reason?: unknown }).reason;
}

/** Unrefs a timer when the runtime supports it (Node); best effort only. */
function tryUnref(timer: ReturnType<typeof setTimeout>): void {
  try {
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    // Unref is an optimisation; ignore environments without it.
  }
}

/**
 * Combines an external AbortSignal with an internal timeout into a single
 * signal. Prefers AbortSignal.any/AbortSignal.timeout and falls back to a
 * manual AbortController on older runtimes. `didTimeout()` distinguishes an
 * internal timeout from an external abort, so callers can map the fetch
 * failure to the right error kind.
 */
export function combineAbortSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): CombinedAbort {
  let timedOut = false;
  const markTimedOut = (): void => {
    timedOut = true;
  };

  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    timeoutSignal.addEventListener('abort', markTimedOut, { once: true });
    const parts: AbortSignal[] = [timeoutSignal];
    if (external) {
      parts.push(external);
    }
    const signal = AbortSignal.any(parts);
    return { signal, didTimeout: () => timedOut };
  }

  // Manual fallback for runtimes without AbortSignal.any / AbortSignal.timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    markTimedOut();
    controller.abort(abortError('Request timed out.'));
  }, timeoutMs);
  tryUnref(timer);

  const forwardExternal = (): void => {
    if (external) {
      controller.abort(signalReason(external));
    }
  };

  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', forwardExternal);
    },
    { once: true },
  );

  if (external) {
    if (external.aborted) {
      forwardExternal();
    } else {
      external.addEventListener('abort', forwardExternal, { once: true });
    }
  }
  return { signal: controller.signal, didTimeout: () => timedOut };
}

/** Resolves after ms; rejects early with an AbortError if the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
