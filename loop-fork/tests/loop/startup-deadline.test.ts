import { expect, test } from "bun:test";
import {
  DeadlineExceededError,
  retryDelayMs,
  sleepUnlessAborted,
  withDeadline,
} from "../../src/loop/startup-deadline";

const later = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

test("work that settles in time keeps its value and is never released", async () => {
  const released: string[] = [];
  await expect(
    withDeadline(later(5, "ok"), 200, "fast work", (value) => {
      released.push(value);
    })
  ).resolves.toBe("ok");
  await later(250, undefined);
  expect(released).toEqual([]);
});

test("work that misses its deadline rejects naming the label, and its late value is released once", async () => {
  const released: string[] = [];
  const started = Date.now();
  const error = await withDeadline(
    later(150, "late connection"),
    30,
    "Temporal client connection",
    (value) => {
      released.push(value);
    }
  ).catch((caught: unknown) => caught);
  expect(Date.now() - started).toBeLessThan(140);
  expect(error).toBeInstanceOf(DeadlineExceededError);
  expect((error as Error).message).toBe(
    "Temporal client connection did not finish within 30ms"
  );
  expect(released).toEqual([]);
  await later(200, undefined);
  expect(released).toEqual(["late connection"]);
});

test("a late rejection and a failing release are contained", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const lateFailure = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("late failure")), 40)
    );
    let releasedFailure = false;
    await expect(
      withDeadline(lateFailure, 10, "failing work", () => {
        releasedFailure = true;
      })
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    await expect(
      withDeadline(later(40, "value"), 10, "release throws", () => {
        throw new Error("release failed");
      })
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    await expect(
      withDeadline(later(40, "value"), 10, "release rejects", () =>
        Promise.reject(new Error("release rejected"))
      )
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    await later(100, undefined);
    expect(releasedFailure).toBe(false);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("work that fails in time rejects with its own error", async () => {
  await expect(
    withDeadline(Promise.reject(new Error("refused")), 100, "refusing work")
  ).rejects.toThrow("refused");
});

test("retry delays back off exponentially to a ceiling", () => {
  expect([1, 2, 3, 4, 5, 6].map((n) => retryDelayMs(n, 100, 1000))).toEqual([
    100, 200, 400, 800, 1000, 1000,
  ]);
});

test("a startup sleep ends early when the server is stopped", async () => {
  const stop = new AbortController();
  const started = Date.now();
  const sleeping = sleepUnlessAborted(10_000, stop.signal);
  setTimeout(() => stop.abort(), 20);
  await sleeping;
  expect(Date.now() - started).toBeLessThan(1000);
  // Already stopped: no wait at all.
  const again = Date.now();
  await sleepUnlessAborted(10_000, stop.signal);
  expect(Date.now() - again).toBeLessThan(50);
});
