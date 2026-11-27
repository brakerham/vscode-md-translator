/**
 * Small abort/timing helpers shared by the provider and the service.
 * Everything here is environment-agnostic (Node or DOM) and unit-testable.
 */

export interface CombinedAbort {
  /** Aborts when the external signal aborts or the internal timeout fires. */
  readonly signal: AbortSignal;
  /** True once the internal timeout fired (as opposed to the external signal). */
  didTimeout(): boolean;
  dispose(): void;
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

/** Combines caller cancellation with a deadline covering the response body. */
export function combineAbortSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): CombinedAbort {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(abortError('Request timed out.'));
  }, timeoutMs);
  const forwardExternal = (): void => controller.abort(external?.reason);
  if (external?.aborted) forwardExternal();
  else external?.addEventListener('abort', forwardExternal, { once: true });
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', forwardExternal);
    },
  };
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
