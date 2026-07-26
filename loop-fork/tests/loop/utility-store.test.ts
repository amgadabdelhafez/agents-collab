import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  activateUtilityEpoch,
  appendUtilityJobEvent,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readPendingRouteRequests,
  readUtilityJob,
  transitionUtilityJob,
  utilityRunPaths,
} from "../../src/loop/utility-store";

const tempDirs: string[] = [];
const makeRunDir = (): string => {
  const runDir = mkdtempSync(join(tmpdir(), "utility-store-"));
  tempDirs.push(runDir);
  return runDir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const makeRequest = (id = "job-1", writeScope = ["src/parser.ts"]) =>
  createUtilityRouteRequest(
    {
      acceptanceCriteria: ["Focused test passes"],
      authority: {},
      createdAt: "2026-07-25T10:00:00.000Z",
      id,
      idempotencyKey: `request-${id}`,
      kind: "edit",
      objective: "Make a bounded edit",
      readScope: [...writeScope],
      requester: "claude",
      requiredCapabilities: ["scoped-edit"],
      risk: "low",
      writeScope,
    },
    {}
  );

const routeToUtility = (
  runDir: string,
  id = "job-1",
  scope?: string[],
  epoch = 12
) => {
  activateUtilityEpoch(runDir, epoch);
  appendUtilityRouteRequest(runDir, makeRequest(id, scope));
  return transitionUtilityJob(runDir, id, "routed-utility", {
    at: "2026-07-25T10:01:00.000Z",
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "cheap-oss",
    },
    eventId: `decision-${id}`,
    routeEpoch: epoch,
  });
};

test("persists route requests and reads pending jobs", () => {
  const runDir = makeRunDir();
  const request = makeRequest();

  const snapshot = appendUtilityRouteRequest(runDir, request);

  expect(snapshot.state).toBe("pending-route");
  expect(snapshot.request.requester).toBe("claude");
  expect(readPendingRouteRequests(runDir)).toHaveLength(1);
  expect(readUtilityJob(runDir, request.id)?.request.objective).toBe(
    "Make a bounded edit"
  );
  expect(readFileSync(utilityRunPaths(runDir).eventsFile, "utf8")).toContain(
    '"type":"route-requested"'
  );
});

test("deduplicates route requests by idempotency key", () => {
  const runDir = makeRunDir();
  const request = makeRequest();

  appendUtilityRouteRequest(runDir, request);
  const duplicate = appendUtilityRouteRequest(runDir, {
    ...request,
    id: "different-job-id",
  });

  expect(duplicate.jobId).toBe("job-1");
  const lines = readFileSync(utilityRunPaths(runDir).eventsFile, "utf8")
    .trim()
    .split("\n");
  expect(lines).toHaveLength(1);
});

test("makes event ids idempotent and rejects collisions", () => {
  const runDir = makeRunDir();
  const request = makeRequest();
  const event = {
    at: request.createdAt,
    eventId: "event-1",
    jobId: request.id,
    request,
    state: "pending-route" as const,
    type: "route-requested" as const,
  };

  appendUtilityJobEvent(runDir, event);
  appendUtilityJobEvent(runDir, event);
  expect(() =>
    appendUtilityJobEvent(runDir, { ...event, at: "different" })
  ).toThrow("event id collision");
});

test("claims a routed job with a durable governess epoch", () => {
  const runDir = makeRunDir();
  routeToUtility(runDir);

  const claimed = claimUtilityJob(runDir, 12, {
    at: "2026-07-25T10:02:00.000Z",
    workerId: "worker-a",
  });

  expect(claimed?.state).toBe("claimed");
  expect(claimed?.claim).toEqual({ epoch: 12, workerId: "worker-a" });
  expect(readUtilityJob(runDir, "job-1")?.claim?.epoch).toBe(12);
  expect(claimUtilityJob(runDir, 12)).toBeUndefined();
});

test("does not claim overlapping write scopes concurrently", () => {
  const runDir = makeRunDir();
  routeToUtility(runDir, "job-1", ["src/parser.ts"], 1);
  routeToUtility(runDir, "job-2", ["src"], 1);

  expect(claimUtilityJob(runDir, 1)?.jobId).toBe("job-1");
  expect(claimUtilityJob(runDir, 1)).toBeUndefined();
});

test("a successor epoch atomically fences workers from the prior route", () => {
  const runDir = makeRunDir();
  routeToUtility(runDir, "job-1", ["src/parser.ts"], 4);

  expect(activateUtilityEpoch(runDir, 5)).toBe(true);
  expect(claimUtilityJob(runDir, 4, { jobId: "job-1" })).toBeUndefined();
  expect(activateUtilityEpoch(runDir, 3)).toBe(false);
});

test("enforces safe transitions and epoch claims", () => {
  const runDir = makeRunDir();
  appendUtilityRouteRequest(runDir, makeRequest());

  expect(() => transitionUtilityJob(runDir, "job-1", "running")).toThrow(
    "invalid utility transition"
  );
  expect(() => claimUtilityJob(runDir, 0)).toThrow("positive governess epoch");
  expect(() => transitionUtilityJob(runDir, "job-1", "claimed")).toThrow(
    "claimUtilityJob"
  );
});

test("persists compact results and makes terminal jobs immutable", () => {
  const runDir = makeRunDir();
  routeToUtility(runDir);
  claimUtilityJob(runDir, 12);
  transitionUtilityJob(runDir, "job-1", "running", {
    eventId: "running-1",
  });
  const completed = transitionUtilityJob(runDir, "job-1", "completed", {
    eventId: "completed-1",
    result: {
      artifactRefs: [
        { kind: "diff", path: "utility/artifacts/job-1.patch", bytes: 20 },
      ],
      checks: [{ command: ["bun", "test"], exitCode: 0, summary: "passed" }],
      filesChanged: ["src/parser.ts"],
      status: "completed",
      summary: "Applied the bounded parser edit.",
    },
  });

  expect(completed.result?.artifactRefs[0]?.kind).toBe("diff");
  expect(() =>
    transitionUtilityJob(runDir, "job-1", "failed", {
      result: {
        artifactRefs: [],
        checks: [],
        filesChanged: [],
        status: "failed",
        summary: "late failure",
      },
    })
  ).toThrow("terminal");
});

test("fails closed on a malformed journal", () => {
  const runDir = makeRunDir();
  const paths = utilityRunPaths(runDir);
  mkdirSync(paths.rootDir, { recursive: true });
  writeFileSync(paths.eventsFile, "not-json\n", { flag: "w" });

  expect(() => readPendingRouteRequests(runDir)).toThrow(
    "malformed utility event"
  );
});
