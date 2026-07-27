import { watch } from "node:fs";
import { join } from "node:path";

// Coalesce bursts of filesystem events into a single wake. Agent hook writes
// arrive in clusters (one JSONL append can emit several change events), and a
// tick per event would be the polling problem with extra steps.
export const GOVERNESS_WAKE_DEBOUNCE_MS = 75;

export type GovernessWakeReason = "event" | "timeout";

/**
 * Directories whose writes should wake the governess cycle: the run dir
 * (bridge.jsonl, state) and the agent hook dir (lifecycle evidence).
 */
export const governessWakePaths = (runDir: string): string[] => [
  runDir,
  join(runDir, "hooks"),
];

/** Escape hatch: LOOP_GOVERNESS_WAKE=0 restores pure fixed-interval polling. */
export const governessWakeEnabled = (env: NodeJS.ProcessEnv): boolean => {
  const raw = env.LOOP_GOVERNESS_WAKE?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
};

export interface GovernessWakeStats {
  /** Raw filesystem events seen, before debouncing. */
  events: number;
  /** Waits that ended on the fallback timeout. */
  timeouts: number;
  /** Debounced wakes delivered to a waiter. */
  wakes: number;
}

export interface GovernessWake {
  close: () => void;
  stats: () => GovernessWakeStats;
  /**
   * Resolves "event" when a watched path changed, or "timeout" after
   * timeoutMs. The timeout is the reliability floor: if no watcher could be
   * installed this degrades to exactly the previous fixed-interval poll.
   */
  wait: (timeoutMs: number) => Promise<GovernessWakeReason>;
  /** False when every watcher failed to install; waits are timeout-only. */
  watching: boolean;
}

export interface GovernessWakeOptions {
  debounceMs?: number;
  /** Directories to watch, non-recursively. Unwatchable paths are skipped. */
  paths: string[];
  /** Injectable for tests; defaults to node:fs watch. */
  watchDir?: (path: string, onChange: () => void) => { close: () => void };
}

const defaultWatchDir = (
  path: string,
  onChange: () => void
): { close: () => void } => {
  const watcher = watch(path, () => {
    onChange();
  });
  watcher.on("error", () => {
    // A watcher that dies leaves the fallback timeout in charge.
  });
  return { close: () => watcher.close() };
};

export const createGovernessWake = (
  options: GovernessWakeOptions
): GovernessWake => {
  const debounceMs = options.debounceMs ?? GOVERNESS_WAKE_DEBOUNCE_MS;
  const watchDir = options.watchDir ?? defaultWatchDir;
  const watchers: Array<{ close: () => void }> = [];
  const waiters = new Set<(reason: GovernessWakeReason) => void>();
  const stats: GovernessWakeStats = { events: 0, timeouts: 0, wakes: 0 };
  let pending = false;
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const deliver = (): void => {
    debounce = undefined;
    if (closed) {
      return;
    }
    stats.wakes += 1;
    pending = true;
    const listeners = [...waiters];
    waiters.clear();
    for (const listener of listeners) {
      listener("event");
    }
  };

  const onChange = (): void => {
    if (closed) {
      return;
    }
    stats.events += 1;
    if (debounce) {
      return;
    }
    debounce = setTimeout(deliver, debounceMs);
    debounce.unref?.();
  };

  for (const path of options.paths) {
    try {
      watchers.push(watchDir(path, onChange));
    } catch {
      // Missing or unwatchable path: the fallback timeout still bounds latency.
    }
  }

  const wait = (timeoutMs: number): Promise<GovernessWakeReason> => {
    if (closed) {
      return Promise.resolve("timeout");
    }
    if (pending) {
      pending = false;
      return Promise.resolve("event");
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason: GovernessWakeReason): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        waiters.delete(listener);
        resolve(reason);
      };
      const listener = (reason: GovernessWakeReason): void => {
        // A live waiter consumes the pending flag it was just handed.
        pending = false;
        finish(reason);
      };
      const timer = setTimeout(() => {
        stats.timeouts += 1;
        finish("timeout");
      }, timeoutMs);
      timer.unref?.();
      waiters.add(listener);
    });
  };

  return {
    close: (): void => {
      closed = true;
      if (debounce) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
      }
      watchers.length = 0;
      const listeners = [...waiters];
      waiters.clear();
      for (const listener of listeners) {
        listener("timeout");
      }
    },
    stats: () => ({ ...stats }),
    wait,
    watching: watchers.length > 0,
  };
};
