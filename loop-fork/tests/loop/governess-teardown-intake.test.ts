import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTeardownRequest,
  pendingTeardowns,
  processPendingTeardowns,
  teardownRequestId,
} from "../../src/loop/governess-interaction-intake";

const KEY = "a".repeat(64);
const AT = "2026-09-14T02:53:38.648Z";

// Exact shape recorded by the producer control surface on 2026-09-13.
const request = (
  repoId = "repo-1",
  runId = "2",
  reason = "operator ended the run from the phone"
) => ({
  idempotencyKeyHash: KEY,
  kind: "lifecycle-teardown",
  reason,
  repoId,
  requestId: teardownRequestId(repoId, runId, KEY),
  runId,
  submittedAt: AT,
  version: "1",
});

const withRun = (run: (runDir: string, eventsFile: string) => void): void => {
  const runDir = mkdtempSync(join(tmpdir(), "teardown-intake-"));
  try {
    mkdirSync(join(runDir, "interaction-actions"));
    run(runDir, join(runDir, "interaction-actions", "events.jsonl"));
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
};

const requested = (value: ReturnType<typeof request>) =>
  `${JSON.stringify({ at: AT, eventId: `requested:${value.requestId}`, request: value, requestId: value.requestId, type: "requested", version: "1" })}\n`;

const events = (eventsFile: string) =>
  readFileSync(eventsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("the producer's recorded request id and shape are accepted", () => {
  // requestId observed in the live journal for directive-test-oss run 1.
  const live = {
    idempotencyKeyHash:
      "6c743f883c1bf8897e613f8977b90651bb3ff0df54b1f8f66f3e6af67db66b25",
    kind: "lifecycle-teardown",
    reason: "operator ended the run from the phone",
    repoId: "directive-test-oss-12fd0836cc5a",
    requestId: "iar_0509669bd39ef4e16ac93768b01078e1",
    runId: "1",
    submittedAt: "2026-09-14T02:53:38.648Z",
    version: "1",
  };
  expect(isTeardownRequest(live)).toBe(true);
  expect(isTeardownRequest({ ...live, extra: 1 })).toBe(false);
  expect(
    isTeardownRequest({ ...live, requestId: "iar_" + "0".repeat(32) })
  ).toBe(false);
});

test("a pending teardown for this run is accepted, then executed once", () => {
  withRun((runDir, eventsFile) => {
    const value = request();
    writeFileSync(eventsFile, requested(value));
    const reasons: string[] = [];
    const input = {
      fenceCurrent: () => true,
      now: () => Date.parse(AT) + 1000,
      repoId: "repo-1",
      runDir,
      runId: "2",
      teardown: (reason: string) => reasons.push(reason),
    };
    expect(processPendingTeardowns(input)).toBe(1);
    expect(reasons).toEqual(["operator ended the run from the phone"]);
    const journal = events(eventsFile);
    expect(journal.map((event) => event.type)).toEqual([
      "requested",
      "accepted",
    ]);
    expect(journal[1].requestId).toBe(value.requestId);
    expect(existsSync(join(runDir, "interaction-actions", "events.lock"))).toBe(
      false
    );
    expect(processPendingTeardowns(input)).toBe(0);
    expect(reasons).toHaveLength(1);
  });
});

test("an unfenced Governess leaves the request pending and does not stop the run", () => {
  withRun((runDir, eventsFile) => {
    writeFileSync(eventsFile, requested(request()));
    let stopped = false;
    const processed = processPendingTeardowns({
      fenceCurrent: () => false,
      now: () => Date.parse(AT),
      repoId: "repo-1",
      runDir,
      runId: "2",
      teardown: () => {
        stopped = true;
      },
    });
    expect(processed).toBe(0);
    expect(stopped).toBe(false);
    expect(pendingTeardowns(runDir)).toHaveLength(1);
  });
});

test("a teardown naming another run is denied and never executed", () => {
  withRun((runDir, eventsFile) => {
    writeFileSync(eventsFile, requested(request("other-repo", "9")));
    let stopped = false;
    const processed = processPendingTeardowns({
      fenceCurrent: () => true,
      now: () => Date.parse(AT),
      repoId: "repo-1",
      runDir,
      runId: "2",
      teardown: () => {
        stopped = true;
      },
    });
    expect(processed).toBe(1);
    expect(stopped).toBe(false);
    const journal = events(eventsFile);
    expect(journal[1]).toMatchObject({
      reason: "lifecycle-run-mismatch",
      type: "denied",
    });
  });
});

test("other request kinds and already terminal teardowns are left untouched", () => {
  withRun((runDir, eventsFile) => {
    const done = request();
    const other = {
      at: AT,
      eventId: "requested:iar_x",
      request: { kind: "answer" },
      requestId: "iar_x",
      type: "requested",
      version: "1",
    };
    writeFileSync(
      eventsFile,
      `${requested(done)}${JSON.stringify({ at: AT, eventId: "accepted:1", requestId: done.requestId, type: "accepted", version: "1" })}\n${JSON.stringify(other)}\n`
    );
    const before = readFileSync(eventsFile, "utf8");
    expect(pendingTeardowns(runDir)).toEqual([]);
    expect(
      processPendingTeardowns({
        fenceCurrent: () => true,
        now: () => Date.parse(AT),
        repoId: "repo-1",
        runDir,
        runId: "2",
        teardown: () => {
          throw new Error("must not run");
        },
      })
    ).toBe(0);
    expect(readFileSync(eventsFile, "utf8")).toBe(before);
  });
});

test("a missing journal is simply nothing to do", () => {
  withRun((runDir) => {
    expect(pendingTeardowns(runDir)).toEqual([]);
  });
});
