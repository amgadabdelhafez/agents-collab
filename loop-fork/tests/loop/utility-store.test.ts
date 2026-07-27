import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Subprocess, sleep, spawn } from "bun";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  activateUtilityEpoch,
  appendUtilityJobEvent,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readPendingRouteRequests,
  readUtilityJob,
  recordUtilityPatchApplication,
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
    workerPid: 4321,
  });

  expect(claimed?.state).toBe("claimed");
  expect(claimed?.claim).toEqual({
    epoch: 12,
    workerId: "worker-a",
    workerPid: 4321,
  });
  expect(readUtilityJob(runDir, "job-1")?.claim?.epoch).toBe(12);
  expect(claimUtilityJob(runDir, 12)).toBeUndefined();
});

test("waits for a fresh contended lock instead of fencing a concurrent worker", async () => {
  const runDir = makeRunDir();
  routeToUtility(runDir);
  const paths = utilityRunPaths(runDir);
  const readyFile = join(runDir, "lock-holder-ready");
  const child = spawn({
    cmd: [
      process.execPath,
      "-e",
      [
        'import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync, writeSync } from "node:fs";',
        "const lockFile = process.env.UTILITY_TEST_LOCK;",
        "const readyFile = process.env.UTILITY_TEST_READY;",
        'if (!(lockFile && readyFile)) throw new Error("missing test paths");',
        'const descriptor = openSync(lockFile, "wx", 0o600);',
        'writeFileSync(readyFile, "ready\\n");',
        "Bun.sleepSync(40);",
        'writeSync(descriptor, String(process.pid) + "\\n");',
        "fsyncSync(descriptor);",
        "Bun.sleepSync(80);",
        "closeSync(descriptor);",
        "unlinkSync(lockFile);",
      ].join(" "),
    ],
    env: {
      ...process.env,
      UTILITY_TEST_LOCK: paths.lockFile,
      UTILITY_TEST_READY: readyFile,
    },
    stderr: "pipe",
    stdout: "ignore",
  });
  try {
    const readyDeadline = Date.now() + 2000;
    while (!existsSync(readyFile) && Date.now() < readyDeadline) {
      await sleep(5);
    }
    expect(existsSync(readyFile)).toBe(true);

    const startedAt = Date.now();
    const claimed = claimUtilityJob(runDir, 12, {
      workerId: "worker-after-contention",
      workerPid: 4321,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
    expect(claimed?.jobId).toBe("job-1");
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("two contending worker processes claim distinct routed jobs", async () => {
  const runDir = makeRunDir();
  routeToUtility(runDir, "worker-a", [], 12);
  routeToUtility(runDir, "worker-b", [], 12);
  const paths = utilityRunPaths(runDir);
  const readyFile = join(runDir, "concurrent-lock-holder-ready");
  const holder = spawn({
    cmd: [
      process.execPath,
      "-e",
      [
        'import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync, writeSync } from "node:fs";',
        "const lockFile = process.env.UTILITY_TEST_LOCK;",
        "const readyFile = process.env.UTILITY_TEST_READY;",
        'if (!(lockFile && readyFile)) throw new Error("missing test paths");',
        'const descriptor = openSync(lockFile, "wx", 0o600);',
        'writeSync(descriptor, String(process.pid) + ":holder\\n");',
        "fsyncSync(descriptor);",
        'writeFileSync(readyFile, "ready\\n");',
        "Bun.sleepSync(300);",
        "closeSync(descriptor);",
        "unlinkSync(lockFile);",
      ].join(" "),
    ],
    env: {
      ...process.env,
      UTILITY_TEST_LOCK: paths.lockFile,
      UTILITY_TEST_READY: readyFile,
    },
    stderr: "pipe",
    stdout: "ignore",
  });
  const children: Subprocess[] = [];
  try {
    const readyDeadline = Date.now() + 2000;
    while (!existsSync(readyFile) && Date.now() < readyDeadline) {
      await sleep(5);
    }
    expect(existsSync(readyFile)).toBe(true);
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, "../../src/loop/utility-store.ts")
    ).href;
    const workerScript = [
      "const moduleUrl = process.env.UTILITY_TEST_MODULE;",
      "const runDir = process.env.UTILITY_TEST_RUN_DIR;",
      "const jobId = process.env.UTILITY_TEST_JOB_ID;",
      'if (!(moduleUrl && runDir && jobId)) throw new Error("missing test inputs");',
      "const { claimUtilityJob } = await import(moduleUrl);",
      "const claimed = claimUtilityJob(runDir, 12, { jobId });",
      'process.stdout.write(String(claimed?.jobId ?? "none") + "\\n");',
    ].join(" ");
    for (const jobId of ["worker-a", "worker-b"]) {
      children.push(
        spawn({
          cmd: [process.execPath, "-e", workerScript],
          env: {
            ...process.env,
            UTILITY_TEST_JOB_ID: jobId,
            UTILITY_TEST_MODULE: moduleUrl,
            UTILITY_TEST_RUN_DIR: runDir,
          },
          stderr: "pipe",
          stdout: "pipe",
        })
      );
    }

    const [outputs, errors, exitCodes, holderExit] = await Promise.all([
      Promise.all(
        children.map(async (child) =>
          (await new Response(child.stdout).text()).trim()
        )
      ),
      Promise.all(
        children.map(async (child) =>
          (await new Response(child.stderr).text()).trim()
        )
      ),
      Promise.all(children.map(async (child) => child.exited)),
      holder.exited,
    ]);

    expect(errors).toEqual(["", ""]);
    expect(exitCodes).toEqual([0, 0]);
    expect(holderExit).toBe(0);
    expect(outputs.sort()).toEqual(["worker-a", "worker-b"]);
  } finally {
    holder.kill();
    await holder.exited;
    for (const child of children) {
      child.kill();
      await child.exited;
    }
  }
});

test("fails closed after a bounded wait without removing a live owner lock", () => {
  const runDir = makeRunDir();
  const paths = utilityRunPaths(runDir);
  mkdirSync(paths.rootDir, { recursive: true });
  writeFileSync(paths.lockFile, "999:existing-owner\n");

  const startedAt = Date.now();
  expect(() => appendUtilityRouteRequest(runDir, makeRequest())).toThrow(
    "utility store is busy"
  );

  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1900);
  expect(readFileSync(paths.lockFile, "utf8")).toBe("999:existing-owner\n");
});

test("recovers a lock only after its stale-age boundary", () => {
  const runDir = makeRunDir();
  const paths = utilityRunPaths(runDir);
  mkdirSync(paths.rootDir, { recursive: true });
  writeFileSync(paths.lockFile, "999:abandoned-owner\n");
  const staleAt = new Date(Date.now() - 31_000);
  utimesSync(paths.lockFile, staleAt, staleAt);

  expect(appendUtilityRouteRequest(runDir, makeRequest()).state).toBe(
    "pending-route"
  );
  expect(existsSync(paths.lockFile)).toBe(false);
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

test("journals a patch application after completion without reopening the job", () => {
  const runDir = makeRunDir();
  routeToUtility(runDir);
  claimUtilityJob(runDir, 12, { workerPid: 5151 });
  transitionUtilityJob(runDir, "job-1", "running");
  transitionUtilityJob(runDir, "job-1", "completed", {
    result: {
      artifactRefs: [
        {
          kind: "diff",
          path: "/repo/.loop/utility-artifacts/job-1/patch.patch",
          sha256: "a".repeat(64),
        },
      ],
      checks: [],
      filesChanged: [],
      status: "completed",
      summary: "patch proposed",
    },
  });
  const application = {
    appliedAt: "2026-07-26T16:30:00.000Z",
    appliedBy: "claude" as const,
    manifestPath: ".loop/utility-artifacts/job-1/patch.json",
    manifestSha256: "d".repeat(64),
    patchPath: ".loop/utility-artifacts/job-1/patch.patch",
    patchSha256: "a".repeat(64),
    postimages: [{ path: "src/parser.ts", sha256: "c".repeat(64) }],
    preimages: [{ path: "src/parser.ts", sha256: "b".repeat(64) }],
  };

  const applied = recordUtilityPatchApplication(
    runDir,
    "job-1",
    application
  );
  expect(applied.state).toBe("completed");
  expect(applied.application).toEqual(application);
  expect(
    recordUtilityPatchApplication(runDir, "job-1", application).events.filter(
      (event) => event.type === "patch-applied"
    )
  ).toHaveLength(1);
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
