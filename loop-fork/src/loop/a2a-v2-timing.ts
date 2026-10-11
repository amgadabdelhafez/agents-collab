// Debug-only per-phase timing for the A2A V2 send path.
//
// Off unless LOOP_A2A_V2_TIMING=1 is set in the server's environment. When
// on, every call through a wrapped port (the Temporal workflow port, the
// delivery ledger, the delivery and readiness ports) and every V2 HTTP request
// writes one line to standard error with the port, the method, the elapsed
// milliseconds and whether it threw; an event-loop lag probe reports any
// stall of the server's main thread longer than 100 ms. Lines carry method
// names and workflow ids only: never a body, token or connection string.
//
// This module is never imported by workflow code (the Temporal workflow
// bundle), so it may use process and timers freely.

export const A2A_V2_TIMING_ENV = "LOOP_A2A_V2_TIMING";

export const a2aV2TimingEnabled = (
  env: NodeJS.ProcessEnv = process.env
): boolean => env[A2A_V2_TIMING_ENV] === "1";

type TimingLog = (line: string) => void;

const defaultLog: TimingLog = (line) => console.error(line);

const workflowIdOf = (args: readonly unknown[]): string | undefined => {
  for (const arg of args) {
    if (typeof arg === "string" && arg.includes(":v2:")) {
      return arg;
    }
    if (
      arg &&
      typeof arg === "object" &&
      typeof (arg as { workflowId?: unknown }).workflowId === "string"
    ) {
      return (arg as { workflowId: string }).workflowId;
    }
  }
  return undefined;
};

const lineOf = (
  port: string,
  method: string,
  args: readonly unknown[],
  startedAt: number,
  outcome: "ok" | "threw"
): string => {
  const workflowId = workflowIdOf(args);
  const name =
    method === "query" || method === "signal"
      ? `${method}:${String((args[0] as { name?: unknown })?.name ?? "")}`
      : method;
  return `[a2a-v2-timing] ${port}.${name} ${(performance.now() - startedAt).toFixed(1)}ms ${outcome}${workflowId ? ` ${workflowId.slice(-12)}` : ""}`;
};

/**
 * The same object, every method call timed. Methods run with the real target
 * as `this` (the ports keep private fields), and getters read through it.
 */
export const timedPort = <T extends object>(
  port: string,
  target: T,
  log: TimingLog = defaultLog
): T =>
  new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      return (...args: unknown[]) => {
        const startedAt = performance.now();
        let result: unknown;
        try {
          result = value.apply(object, args);
        } catch (error) {
          log(lineOf(port, property, args, startedAt, "threw"));
          throw error;
        }
        if (result instanceof Promise) {
          return result.then(
            (resolved) => {
              log(lineOf(port, property, args, startedAt, "ok"));
              return resolved;
            },
            (error: unknown) => {
              log(lineOf(port, property, args, startedAt, "threw"));
              throw error;
            }
          );
        }
        log(lineOf(port, property, args, startedAt, "ok"));
        return result;
      };
    },
  });

/** A handler whose every request is timed, by method and path. */
export const timedHandler =
  <A extends unknown[]>(
    handler: (request: Request, ...rest: A) => Promise<Response>,
    log: TimingLog = defaultLog
  ) =>
  async (request: Request, ...rest: A): Promise<Response> => {
    const startedAt = performance.now();
    const { pathname } = new URL(request.url);
    try {
      const response = await handler(request, ...rest);
      log(
        `[a2a-v2-timing] http ${request.method} ${pathname} ${(performance.now() - startedAt).toFixed(1)}ms ${response.status}`
      );
      return response;
    } catch (error) {
      log(
        `[a2a-v2-timing] http ${request.method} ${pathname} ${(performance.now() - startedAt).toFixed(1)}ms threw`
      );
      throw error;
    }
  };

export interface A2AV2TimingProbe {
  /** The handler, each request timed; the handler itself when off. */
  handler<A extends unknown[]>(
    handler: (request: Request, ...rest: A) => Promise<Response>
  ): (request: Request, ...rest: A) => Promise<Response>;
  /** `run`, each call over 50 ms reported; `run` itself when off. */
  pass<T>(label: string, run: () => Promise<T>): () => Promise<T>;
  /** Stops the event-loop lag probe, if one runs. */
  stop(): void;
}

/**
 * The server's timing probe: on with LOOP_A2A_V2_TIMING=1 (it then starts the
 * event-loop lag probe), and otherwise identity wraps that cost nothing.
 */
export const a2aV2TimingProbe = (
  env: NodeJS.ProcessEnv = process.env,
  log: TimingLog = defaultLog
): A2AV2TimingProbe => {
  if (!a2aV2TimingEnabled(env)) {
    return {
      handler: (handler) => handler,
      pass: (_label, run) => run,
      stop: () => undefined,
    };
  }
  const stop = startEventLoopLagProbe(log);
  return {
    handler: (handler) => timedHandler(handler, log),
    pass:
      <T>(label: string, run: () => Promise<T>) =>
      async () => {
        const startedAt = performance.now();
        try {
          return await run();
        } finally {
          const elapsed = performance.now() - startedAt;
          if (elapsed > 50) {
            log(`[a2a-v2-timing] ${label} ${elapsed.toFixed(0)}ms`);
          }
        }
      },
    stop,
  };
};

/**
 * Reports each main-thread stall over `thresholdMs`: a probe scheduled every
 * `periodMs` that ran late by that much was blocked. Returns its stop.
 */
export const startEventLoopLagProbe = (
  log: TimingLog = defaultLog,
  periodMs = 50,
  thresholdMs = 100
): (() => void) => {
  let expected = performance.now() + periodMs;
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    if (lag > thresholdMs) {
      log(`[a2a-v2-timing] event-loop stalled ${lag.toFixed(0)}ms`);
    }
    expected = now + periodMs;
  }, periodMs);
  timer.unref?.();
  return () => clearInterval(timer);
};
