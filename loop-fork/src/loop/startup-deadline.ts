/**
 * Bounded startup work for the orchestration server.
 *
 * On 2026-10-11 the launchd-run server never opened its port: a synchronous
 * read of a mailbox under ~/Documents was parked by a macOS privacy (TCC)
 * prompt, which froze the event loop before `serve()`. Startup now binds
 * first and bounds every step that can wait on something outside the
 * process. A deadline cannot stop the work it bounds; it stops the WAIT, and
 * `releaseLate` gives back whatever the work produces after it was abandoned
 * (a connection, a service), so a late success never leaks a resource.
 */
export class DeadlineExceededError extends Error {
  readonly label: string;
  readonly ms: number;

  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${ms}ms`);
    this.name = "DeadlineExceededError";
    this.label = label;
    this.ms = ms;
  }
}

const releaseQuietly = <T>(
  releaseLate: ((value: T) => unknown) | undefined,
  value: T
): void => {
  if (!releaseLate) {
    return;
  }
  try {
    Promise.resolve(releaseLate(value)).catch(() => undefined);
  } catch {
    // A failed release of abandoned work has no one left to report to.
  }
};

/**
 * `work`'s outcome when it settles within `ms`; otherwise a
 * `DeadlineExceededError` naming `label`. Work that settles after the
 * deadline is released (a value) or ignored (a rejection), never surfaced.
 */
export const withDeadline = <T>(
  work: Promise<T>,
  ms: number,
  label: string,
  releaseLate?: (value: T) => unknown
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new DeadlineExceededError(label, ms));
    }, ms);
    work.then(
      (value) => {
        if (expired) {
          releaseQuietly(releaseLate, value);
          return;
        }
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (expired) {
          return;
        }
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/** Exponential backoff from `baseMs`, doubling per attempt, up to `maxMs`. */
export const retryDelayMs = (
  attempt: number,
  baseMs: number,
  maxMs: number
): number => Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

/** Waits `ms`, or less when `signal` aborts (at once when it already has). */
export const sleepUnlessAborted = (
  ms: number,
  signal: AbortSignal
): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
