import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGovernessWake,
  type GovernessWake,
  governessWakeEnabled,
  governessWakePaths,
} from "../../src/loop/governess-wake";

const dirs: string[] = [];
const wakes: GovernessWake[] = [];

const fixtureDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "governess-wake-"));
  dirs.push(dir);
  return dir;
};

const track = (wake: GovernessWake): GovernessWake => {
  wakes.push(wake);
  return wake;
};

const touch = (dir: string, name: string, body = "x\n"): void => {
  appendFileSync(join(dir, name), body, "utf8");
};

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

afterEach(() => {
  for (const wake of wakes.splice(0)) {
    wake.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("governessWakePaths watches the run dir and the agent hook dir", () => {
  expect(governessWakePaths("/runs/7")).toEqual(["/runs/7", "/runs/7/hooks"]);
});

test("governessWakeEnabled defaults on and honours the kill switch", () => {
  expect(governessWakeEnabled({})).toBe(true);
  expect(governessWakeEnabled({ LOOP_GOVERNESS_WAKE: "1" })).toBe(true);
  expect(governessWakeEnabled({ LOOP_GOVERNESS_WAKE: "0" })).toBe(false);
  expect(governessWakeEnabled({ LOOP_GOVERNESS_WAKE: "false" })).toBe(false);
  expect(governessWakeEnabled({ LOOP_GOVERNESS_WAKE: " OFF " })).toBe(false);
});

test("wait resolves on a watched file change well before the fallback", async () => {
  const dir = fixtureDir();
  const wake = track(createGovernessWake({ debounceMs: 5, paths: [dir] }));
  expect(wake.watching).toBe(true);

  const started = Date.now();
  const pending = wake.wait(5000);
  await settle(20);
  touch(dir, "claude.jsonl");

  expect(await pending).toBe("event");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("wait falls back to timeout when nothing changes", async () => {
  const dir = fixtureDir();
  const wake = track(createGovernessWake({ debounceMs: 5, paths: [dir] }));

  expect(await wake.wait(40)).toBe("timeout");
  expect(wake.stats().timeouts).toBe(1);
  expect(wake.stats().wakes).toBe(0);
});

test("a change between waits is not lost (level-triggered)", async () => {
  const dir = fixtureDir();
  const wake = track(createGovernessWake({ debounceMs: 5, paths: [dir] }));

  // Nobody is waiting when the write lands.
  touch(dir, "codex.jsonl");
  await settle(60);

  const started = Date.now();
  expect(await wake.wait(5000)).toBe("event");
  expect(Date.now() - started).toBeLessThan(100);
});

test("a burst of writes debounces to a single wake", async () => {
  const dir = fixtureDir();
  const wake = track(createGovernessWake({ debounceMs: 60, paths: [dir] }));

  for (let i = 0; i < 20; i += 1) {
    touch(dir, "claude.jsonl", `line ${i}\n`);
  }
  await settle(200);

  const observed = wake.stats();
  expect(observed.events).toBeGreaterThan(0);
  // The whole burst collapses into one delivered wake, not one per write.
  expect(observed.wakes).toBe(1);
});

test("debounce collapses many raw events into one wake", async () => {
  let fire = (): void => undefined;
  const wake = track(
    createGovernessWake({
      debounceMs: 40,
      paths: ["fixture"],
      watchDir: (_path, onChange) => {
        fire = onChange;
        return { close: () => undefined };
      },
    })
  );

  // Deterministic: 50 raw watcher callbacks inside one debounce window.
  for (let i = 0; i < 50; i += 1) {
    fire();
  }
  expect(wake.stats().events).toBe(50);
  expect(wake.stats().wakes).toBe(0);

  expect(await wake.wait(1000)).toBe("event");
  expect(wake.stats().wakes).toBe(1);
});

test("a second burst after the first wake delivers exactly one more wake", async () => {
  const dir = fixtureDir();
  const wake = track(createGovernessWake({ debounceMs: 30, paths: [dir] }));

  touch(dir, "claude.jsonl");
  await settle(120);
  expect(await wake.wait(1000)).toBe("event");

  touch(dir, "claude.jsonl", "again\n");
  expect(await wake.wait(1000)).toBe("event");
  expect(wake.stats().wakes).toBe(2);
});

test("an unwatchable path degrades to timeout-only polling", async () => {
  const dir = fixtureDir();
  const wake = track(
    createGovernessWake({
      debounceMs: 5,
      paths: [join(dir, "definitely-missing")],
    })
  );

  expect(wake.watching).toBe(false);
  expect(await wake.wait(30)).toBe("timeout");
});

test("a watcher that throws on install leaves the others working", () => {
  const dir = fixtureDir();
  const wake = track(
    createGovernessWake({
      debounceMs: 5,
      paths: ["bad", dir],
      watchDir: (path, _onChange) => {
        if (path === "bad") {
          throw new Error("boom");
        }
        return { close: () => undefined };
      },
    })
  );

  expect(wake.watching).toBe(true);
});

test("a wake consumed by an abandoned waiter still resolves within the fallback", async () => {
  const dir = fixtureDir();
  const wake = track(createGovernessWake({ debounceMs: 5, paths: [dir] }));

  // Simulate the loop losing a Promise.race: this waiter is never awaited by
  // the caller, but it still consumes the pending flag.
  const abandoned = wake.wait(5000);
  touch(dir, "claude.jsonl");
  expect(await abandoned).toBe("event");

  // The next wait must still be bounded by the fallback timeout, i.e. never
  // worse than the fixed-interval poll it replaces.
  const started = Date.now();
  expect(await wake.wait(50)).toBe("timeout");
  expect(Date.now() - started).toBeGreaterThanOrEqual(40);
});

test("close stops delivery and releases pending waiters", async () => {
  const dir = fixtureDir();
  const wake = createGovernessWake({ debounceMs: 5, paths: [dir] });

  const pending = wake.wait(5000);
  wake.close();
  expect(await pending).toBe("timeout");

  touch(dir, "claude.jsonl");
  await settle(40);
  expect(wake.stats().wakes).toBe(0);
  expect(await wake.wait(10)).toBe("timeout");

  // close is idempotent.
  wake.close();
});

test("watching many directories wakes on a change in any of them", async () => {
  const first = fixtureDir();
  const second = fixtureDir();
  const wake = track(
    createGovernessWake({ debounceMs: 5, paths: [first, second] })
  );

  const pending = wake.wait(5000);
  await settle(20);
  touch(second, "bridge.jsonl");
  expect(await pending).toBe("event");
});
