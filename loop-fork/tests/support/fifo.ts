import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * A FIFO stands in for a file whose open macOS parks behind a privacy (TCC)
 * prompt: opening it for reading waits until a writer appears. An async read
 * waits on a worker thread and the event loop keeps running; `readFileSync`
 * freezes the event loop, exactly as the parked open froze the orchestration
 * server on 2026-10-11 (tests/loop/mailbox-file-access.test.ts proves both).
 */
export const makeFifo = (path: string): void => {
  const made = spawnSync("mkfifo", [path]);
  if (made.status !== 0) {
    throw new Error(`mkfifo ${path} failed: ${made.stderr.toString()}`);
  }
};

/**
 * Answers the "prompt": opens the FIFO's write end without blocking and
 * closes it, so every reader parked on it gets end-of-file and its thread is
 * released. ENXIO means no reader is parked yet; it is retried briefly, then
 * there is nothing to release.
 */
export const releaseFifo = async (path: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const handle = await open(
        path,
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
        constants.O_WRONLY | constants.O_NONBLOCK
      );
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENXIO") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return false;
};
