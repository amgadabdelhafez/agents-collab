import { spawnSync } from "node:child_process";

/** Process facts consulted before a recorded PID may lose ownership. */
export interface PidOwnershipDeps {
  isPidAlive: (pid: number) => boolean;
  pidStartedAt: (pid: number) => number | undefined;
}

export const defaultPidLiveness = (pid: number): boolean => {
  if (!(Number.isInteger(pid) && pid > 0)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const defaultPidStartedAt = (pid: number): number | undefined => {
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    return undefined;
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (result.status !== 0 || result.error) {
    return undefined;
  }
  const value = Date.parse(result.stdout.trim());
  return Number.isFinite(value) ? value : undefined;
};

export const defaultPidOwnershipDeps: PidOwnershipDeps = {
  isPidAlive: defaultPidLiveness,
  pidStartedAt: defaultPidStartedAt,
};

/**
 * A live numeric PID is ownership evidence only when it can still be the
 * process recorded before workspace handback. PID values are reusable. A
 * process whose independently observed start time is strictly after the valid
 * release timestamp is positively unrelated to the released run. Missing or
 * ambiguous start evidence remains fail-closed.
 */
export const pidCanStillOwnRun = (
  pid: number,
  releasedAt: string,
  deps: PidOwnershipDeps
): boolean => {
  if (!deps.isPidAlive(pid)) {
    return false;
  }
  const startedAt = deps.pidStartedAt(pid);
  const releasedAtMs = Date.parse(releasedAt);
  return (
    startedAt === undefined ||
    !Number.isFinite(releasedAtMs) ||
    startedAt <= releasedAtMs
  );
};
