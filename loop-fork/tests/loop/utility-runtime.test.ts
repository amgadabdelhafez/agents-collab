import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";
import { readBridgeEvents } from "../../src/loop/bridge-store";
import {
  appendDelegationEvent,
  makeDelegationEvent,
} from "../../src/loop/delegation-policy";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  applyUtilityJobPatch,
  buildUtilityWorkerEnvironment,
  processPendingUtilityRoutes,
  renderUtilityPane,
  resolveUtilityRuntimeConfig,
  runUtilityWorker,
} from "../../src/loop/utility-runtime";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  claimUtilityJob,
  readUtilityJob,
  transitionUtilityJob,
} from "../../src/loop/utility-store";
import { createUtilityToolBroker } from "../../src/loop/utility-tools";

const completedEditProposal = async (
  repoRoot: string,
  runDir: string,
  jobId: string
): Promise<{
  manifestPath: string;
  manifestSha256: string;
  patchPath: string;
  patchSha256: string;
}> => {
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repoRoot, "src", "sample.ts"), "export const n = 1;\n");
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["propose one guarded patch"],
    authority: {},
    id: jobId,
    kind: "edit",
    objective: "Increment the sample value",
    readScope: ["src/sample.ts"],
    requester: "claude",
    requiredCapabilities: ["inspect", "scoped-edit"],
    risk: "low",
    writeScope: ["src/sample.ts"],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 30);
  transitionUtilityJob(runDir, jobId, "routed-utility", { routeEpoch: 30 });
  claimUtilityJob(runDir, 30, { jobId, workerPid: 6060 });
  transitionUtilityJob(runDir, jobId, "running");
  const broker = await createUtilityToolBroker({
    artifactDir: `.loop/runs/apply/utility/artifacts/${jobId}`,
    commandAllowlist: [],
    readScopes: ["src/sample.ts"],
    repoRoot,
    writeScopes: ["src/sample.ts"],
  });
  const patch = [
    "diff --git a/src/sample.ts b/src/sample.ts",
    "--- a/src/sample.ts",
    "+++ b/src/sample.ts",
    "@@ -1 +1 @@",
    "-export const n = 1;",
    "+export const n = 2;",
    "",
  ].join("\n");
  const proposal = await broker.execute({
    arguments: { patch, summary: "increment sample" },
    name: "propose_patch",
  });
  if (!(proposal.ok && proposal.artifact)) {
    throw new Error("failed to create guarded patch fixture");
  }
  transitionUtilityJob(runDir, jobId, "completed", {
    result: {
      artifactRefs: [
        {
          kind: "diff",
          manifestPath: proposal.artifact.manifestPath,
          manifestSha256: proposal.artifact.manifestSha256,
          path: proposal.artifact.path,
          sha256: proposal.artifact.sha256,
        },
      ],
      checks: [],
      filesChanged: [],
      status: "completed",
      summary: "guarded patch proposed",
    },
  });
  return {
    manifestPath: proposal.artifact.manifestPath ?? "",
    manifestSha256: proposal.artifact.manifestSha256 ?? "",
    patchPath: proposal.artifact.path,
    patchSha256: proposal.artifact.sha256,
  };
};

test("OpenRouter GLM is the default but remains disabled without a credential", () => {
  const config = resolveUtilityRuntimeConfig({
    LOOP_UTILITY_API_KEY_FILE: "",
  });
  expect(config.model).toBe("z-ai/glm-5.2");
  expect(config.endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(config.enabled).toBe(false);
  expect(config.availability.code).toBe("key-file-disabled");
  expect(config.providerSort).toBe("balanced");
});

test("a mode-0600 key file enables the tier without exporting the secret", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-utility-key-"));
  const keyFile = join(root, "openrouter.key");
  writeFileSync(keyFile, "test-secret\n", { mode: 0o600 });
  try {
    expect(
      resolveUtilityRuntimeConfig({ LOOP_UTILITY_API_KEY_FILE: keyFile })
    ).toMatchObject({
      apiKey: "test-secret",
      availability: { code: "ready-key-file" },
      enabled: true,
    });
    chmodSync(keyFile, 0o644);
    expect(
      resolveUtilityRuntimeConfig({ LOOP_UTILITY_API_KEY_FILE: keyFile })
    ).toMatchObject({
      availability: {
        code: "key-file-permissions",
        message: expect.stringContaining("chmod 600"),
      },
      enabled: false,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("detached utility worker environment is allowlist-built, not inherited", () => {
  expect(
    buildUtilityWorkerEnvironment({
      HOME: "/Users/example",
      LOOP_UTILITY_API_KEY: "direct-secret",
      LOOP_UTILITY_API_KEY_FILE: "/safe/openrouter.key",
      LOOP_UTILITY_MODEL: "local-model",
      OPENROUTER_API_KEY: "openrouter-secret",
      PATH: "/bin",
      RANDOM_TOKEN: "unrelated-secret",
    })
  ).toEqual({
    CI: "1",
    HOME: "/Users/example",
    LOOP_UTILITY_API_KEY_FILE: "/safe/openrouter.key",
    LOOP_UTILITY_MODEL: "local-model",
    NO_COLOR: "1",
    PATH: "/bin",
  });
});

test("governess passes only the minimal key-file worker environment", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-worker-env-"));
  const runDir = join(repoRoot, ".loop", "runs", "worker-env-run");
  const keyFile = join(repoRoot, "openrouter.key");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(keyFile, "file-secret\n", { mode: 0o600 });
  appendUtilityRouteRequest(
    runDir,
    createUtilityRouteRequest({
      acceptanceCriteria: ["inspect"],
      authority: {},
      id: "worker-env-job",
      kind: "inspect",
      objective: "Inspect one file",
      readScope: ["src"],
      requester: "claude",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    })
  );
  let childEnv: NodeJS.ProcessEnv | undefined;
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 15,
        peer: "codex",
        repoRoot,
        runDir,
      },
      {
        HOME: "/Users/example",
        LOOP_UTILITY_API_KEY: "direct-secret",
        LOOP_UTILITY_API_KEY_FILE: keyFile,
        LOOP_UTILITY_MODEL: "z-ai/glm-5.2",
        OPENROUTER_API_KEY: "openrouter-secret",
        PATH: "/bin",
        RANDOM_TOKEN: "unrelated-secret",
      },
      {
        spawnWorker: (input) => {
          childEnv = input.env;
          return true;
        },
      }
    );
    expect(childEnv).toEqual({
      CI: "1",
      HOME: "/Users/example",
      LOOP_UTILITY_API_KEY_FILE: keyFile,
      LOOP_UTILITY_MODEL: "z-ai/glm-5.2",
      NO_COLOR: "1",
      PATH: "/bin",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("governess route processing dispatches eligible work without provider I/O", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-route-"));
  const runDir = join(repoRoot, ".loop", "runs", "route-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["locate one file"],
    authority: {},
    id: "route-job",
    kind: "inspect",
    objective: "Locate a file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  const spawned: string[] = [];
  try {
    const count = await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 11,
        peer: "codex",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: ({ jobId }) => {
          spawned.push(jobId);
          return true;
        },
      }
    );
    expect(count).toBe(1);
    expect(spawned).toEqual([request.id]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      decision: { target: "utility", tierId: "utility-default" },
      state: "routed-utility",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("active estimate-less jobs cannot reserve beyond the run cost cap", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-run-budget-"));
  const runDir = join(repoRoot, ".loop", "runs", "budget-run");
  mkdirSync(runDir, { recursive: true });
  for (const id of ["budget-a", "budget-b", "budget-c"]) {
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["inspect one scope"],
        authority: {},
        id,
        kind: "inspect",
        objective: `Inspect ${id}`,
        readScope: ["src"],
        requester: "claude",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      })
    );
  }
  const spawned: string[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 18,
        peer: "codex",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_MAX_JOB_USD: "0.05",
        LOOP_UTILITY_MAX_RUN_USD: "0.10",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        spawnWorker: ({ jobId }) => {
          spawned.push(jobId);
          return true;
        },
      }
    );

    expect(spawned).toEqual(["budget-a", "budget-b"]);
    expect(readUtilityJob(runDir, "budget-c")).toMatchObject({
      decision: { reason: "budget-exceeded", target: "driver" },
      state: "routed-driver",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("safe key diagnostics persist in route status and the observer pane", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-diagnostic-"));
  const runDir = join(repoRoot, ".loop", "runs", "diagnostic-run");
  const keyFile = join(repoRoot, "openrouter.key");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(keyFile, "never-render-this-secret\n", { mode: 0o644 });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect one scope"],
    authority: {},
    id: "diagnostic-job",
    kind: "inspect",
    objective: "Inspect configuration",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 19,
        peer: "claude",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_API_KEY_FILE: keyFile }
    );

    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      decision: {
        detail: expect.stringContaining("chmod 600"),
        reason: "utility-unavailable",
        target: "driver",
      },
      state: "routed-driver",
    });
    const pane = renderUtilityPane(runDir, {
      LOOP_UTILITY_API_KEY_FILE: keyFile,
    });
    expect(pane).toContain("driver/utility-unavailable");
    expect(pane).toContain("chmod 600");
    expect(pane).not.toContain("never-render-this-secret");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("spawn failure terminates the job instead of stranding routed utility work", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-spawn-"));
  const runDir = join(repoRoot, ".loop", "runs", "spawn-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "spawn-job",
    kind: "inspect",
    objective: "Inspect a file",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 12,
        peer: "claude",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => false }
    );
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "utility worker process failed to start",
        status: "failed",
      },
      state: "failed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an unclaimed routed job fails closed after its claim deadline", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-unclaimed-"));
  const runDir = join(repoRoot, ".loop", "runs", "unclaimed-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "unclaimed-job",
    kind: "inspect",
    objective: "Inspect a file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 14);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    at: "2020-01-01T00:00:00.000Z",
    routeEpoch: 14,
  });
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 14,
        peer: "codex",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_MAX_CLAIM_WAIT_MS: "1" }
    );
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "utility worker did not claim the routed job",
        status: "failed",
      },
      state: "failed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a dead claimed worker fails immediately and releases its write scope", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-dead-worker-"));
  const runDir = join(repoRoot, ".loop", "runs", "dead-worker-run");
  mkdirSync(runDir, { recursive: true });
  for (const id of ["dead-edit", "replacement-edit"]) {
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["propose patch"],
        authority: {},
        id,
        kind: "edit",
        objective: `Edit ${id}`,
        readScope: ["src/shared.ts"],
        requester: "codex",
        requiredCapabilities: ["scoped-edit"],
        risk: "low",
        writeScope: ["src/shared.ts"],
      })
    );
  }
  activateUtilityEpoch(runDir, 20);
  transitionUtilityJob(runDir, "dead-edit", "routed-utility", {
    routeEpoch: 20,
  });
  claimUtilityJob(runDir, 20, {
    jobId: "dead-edit",
    workerId: "utility-4242",
    workerPid: 4242,
  });
  transitionUtilityJob(runDir, "dead-edit", "running");
  const spawned: string[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 20,
        peer: "claude",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      {
        isWorkerAlive: () => false,
        spawnWorker: ({ jobId }) => {
          spawned.push(jobId);
          return true;
        },
      }
    );
    expect(readUtilityJob(runDir, "dead-edit")).toMatchObject({
      result: {
        blocker: "utility worker process is no longer alive",
        status: "failed",
      },
      state: "failed",
    });
    expect(readUtilityJob(runDir, "replacement-edit")?.state).toBe(
      "routed-utility"
    );
    expect(spawned).toEqual(["replacement-edit"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a live worker remains claimed before its external runtime deadline", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-live-worker-"));
  const runDir = join(repoRoot, ".loop", "runs", "live-worker-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "live-worker",
    kind: "inspect",
    objective: "Inspect one file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 21);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 21,
  });
  claimUtilityJob(runDir, 21, {
    at: "2026-07-26T16:00:00.000Z",
    jobId: request.id,
    workerPid: 4343,
  });
  transitionUtilityJob(runDir, request.id, "running", {
    at: "2026-07-26T16:00:01.000Z",
  });
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 21,
        peer: "codex",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_MAX_RUNTIME_MS: "10000" },
      {
        isWorkerAlive: () => true,
        now: () => Date.parse("2026-07-26T16:00:05.000Z"),
      }
    );
    expect(readUtilityJob(runDir, request.id)?.state).toBe("running");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("governess externally terminates a live worker past its runtime", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-runtime-kill-"));
  const runDir = join(repoRoot, ".loop", "runs", "runtime-kill-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "timed-out-worker",
    kind: "inspect",
    objective: "Inspect one file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 22);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 22,
  });
  claimUtilityJob(runDir, 22, {
    at: "2026-07-26T16:00:00.000Z",
    jobId: request.id,
    workerPid: 4444,
  });
  transitionUtilityJob(runDir, request.id, "running", {
    at: "2026-07-26T16:00:01.000Z",
  });
  const terminated: number[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 22,
        peer: "codex",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_MAX_RUNTIME_MS: "1000" },
      {
        isWorkerAlive: () => true,
        now: () => Date.parse("2026-07-26T16:00:05.000Z"),
        terminateWorker: (pid) => {
          terminated.push(pid);
          return true;
        },
      }
    );
    expect(terminated).toEqual([4444]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "utility job exceeded its runtime limit and was terminated",
      },
      state: "failed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("terminal completion racing the reaper is preserved", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-reaper-race-"));
  const runDir = join(repoRoot, ".loop", "runs", "reaper-race-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect"],
    authority: {},
    id: "racing-worker",
    kind: "inspect",
    objective: "Inspect one file",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 23);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 23,
  });
  claimUtilityJob(runDir, 23, {
    at: "2026-07-26T16:00:00.000Z",
    jobId: request.id,
    workerPid: 4545,
  });
  transitionUtilityJob(runDir, request.id, "running", {
    at: "2026-07-26T16:00:01.000Z",
  });
  let completed = false;
  const terminated: number[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "claude",
        epoch: 23,
        peer: "codex",
        repoRoot,
        runDir,
      },
      { LOOP_UTILITY_MAX_RUNTIME_MS: "1000" },
      {
        isWorkerAlive: () => {
          if (!completed) {
            completed = true;
            transitionUtilityJob(runDir, request.id, "completed", {
              result: {
                artifactRefs: [],
                checks: [],
                filesChanged: [],
                status: "completed",
                summary: "completed during reaper probe",
              },
            });
          }
          return true;
        },
        now: () => Date.parse("2026-07-26T16:00:05.000Z"),
        terminateWorker: (pid) => {
          terminated.push(pid);
          return true;
        },
      }
    );
    expect(terminated).toEqual([]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: { summary: "completed during reaper probe" },
      state: "completed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("overlapping utility writes are not dispatched concurrently", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-conflict-"));
  const runDir = join(repoRoot, ".loop", "runs", "conflict-run");
  mkdirSync(runDir, { recursive: true });
  for (const id of ["edit-a", "edit-b"]) {
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["propose patch"],
        authority: {},
        id,
        kind: "edit",
        objective: `Edit ${id}`,
        readScope: ["src/shared.ts"],
        requester: "codex",
        requiredCapabilities: ["scoped-edit"],
        risk: "low",
        writeScope: ["src/shared.ts"],
      })
    );
  }
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 13,
        peer: "claude",
        repoRoot,
        runDir,
      },
      {
        LOOP_UTILITY_ENABLED: "1",
        LOOP_UTILITY_URL: "http://127.0.0.1:9876/v1/chat/completions",
      },
      { spawnWorker: () => true }
    );
    expect(readUtilityJob(runDir, "edit-a")?.state).toBe("routed-utility");
    expect(readUtilityJob(runDir, "edit-b")).toMatchObject({
      decision: { reason: "write-conflict", target: "driver" },
      state: "routed-driver",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("utility pane reports current work, tool activity, usage, and idle state", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-pane-"));
  try {
    expect(renderUtilityPane(runDir, {})).toContain(
      "waiting for first request"
    );
    appendUtilityRouteRequest(
      runDir,
      createUtilityRouteRequest({
        acceptanceCriteria: ["locate the config"],
        authority: {},
        createdAt: "2026-07-25T11:59:59.000Z",
        id: "inspect-config",
        kind: "inspect",
        objective:
          "Inspect src/loop/utility-runtime.ts for the requested bounded source slice (1221-1290) and return concise relevant evidence.\u001b[31m",
        readScope: ["src"],
        requester: "codex",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      })
    );
    activateUtilityEpoch(runDir, 1);
    transitionUtilityJob(runDir, "inspect-config", "routed-utility", {
      at: "2026-07-25T11:59:59.100Z",
      decision: {
        reason: "utility-eligible",
        target: "utility",
        tierId: "openrouter-glm",
      },
      routeEpoch: 1,
    });
    claimUtilityJob(runDir, 1, {
      at: "2026-07-25T11:59:59.200Z",
      jobId: "inspect-config",
      workerId: "test-worker",
      workerPid: process.pid,
    });
    transitionUtilityJob(runDir, "inspect-config", "running", {
      at: "2026-07-25T11:59:59.300Z",
    });
    writeFileSync(
      join(runDir, "utility", "tool-events.jsonl"),
      `${JSON.stringify({
        at: "2026-07-25T12:00:00.000Z",
        durationMs: 12,
        jobId: "inspect-config",
        ok: true,
        tool: "search_repo",
      })}\n`
    );
    appendDelegationEvent(
      runDir,
      makeDelegationEvent({
        agent: "claude",
        disposition: "auto-routed",
        fingerprint: "a".repeat(64),
        operation: "git-status",
        reason: "git-status",
        source: "claude-hook",
        taskId: "inspect-config",
      })
    );
    appendDelegationEvent(
      runDir,
      makeDelegationEvent({
        agent: "codex",
        disposition: "missed-candidate",
        fingerprint: "b".repeat(64),
        operation: "scoped-search",
        reason: "codex-tool-hook-unavailable",
        source: "codex-app-server",
      })
    );
    writeFileSync(
      join(runDir, "utility", "usage.jsonl"),
      `${JSON.stringify({
        at: "2026-07-25T12:00:01.000Z",
        durationMs: 11_000,
        jobId: "inspect-config",
        model: "z-ai/glm-5.2",
        modelCalls: 2,
        status: "completed",
        toolCalls: 1,
        usage: {
          cachedInputTokens: 500,
          cost: 0.004_416,
          inputTokens: 900,
          outputTokens: 334,
          totalTokens: 1234,
        },
      })}\n`
    );
    transitionUtilityJob(runDir, "inspect-config", "completed", {
      at: "2026-07-25T12:00:02.000Z",
      result: {
        artifactRefs: [],
        checks: [],
        filesChanged: [],
        status: "completed",
        summary:
          "**Outcome:** Inspected the requested lines. **Evidence (src/loop/utility-runtime.ts):** Found the active configuration; no secret values were read.",
      },
    });

    const pane = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 120, rows: 20 }
    );
    expect(pane).toContain("GLM-5.2 OFFLINE · idle · jobs 1 a0 q0 d1 f0");
    expect(pane).toContain("USAGE 2 calls · 1 tools · 1,234 tok · $0.0044");
    expect(pane).toContain("TOKENS in 900 · cache 500 · out 334");
    expect(pane).toContain("RECENT JOBS · request / tool / result");
    expect(pane).toContain("GLM TOOL inspect-");
    expect(pane).toContain("search_repo ok 12ms");
    expect(pane).toContain("CODEX→GLM inspect-");
    expect(pane).toContain("read utility-runtime.ts lines 1221–1290");
    expect(pane).toContain("GLM OK inspect- · 11s · 2c/1t");
    expect(pane).toContain("1,234 tok · $0.0044");
    expect(pane).toContain("Found the active configuration");
    expect(pane).not.toContain("Inspected the requested lines");
    expect(pane).toContain("ROUTE utility/eligible · auto 1 · exp 0 · miss 1");
    expect(pane).not.toContain("\u001b[31m");

    const compact = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 58, rows: 10 }
    );
    expect(compact.split("\n")).toHaveLength(10);
    expect(compact.split("\n").every((line) => line.length <= 58)).toBe(true);
    expect(compact).toContain("REQ inspect-");
    expect(compact).toContain("TOOL search_repo ok 12ms");
    expect(compact).toContain(
      "OK inspect- · 11s · 2c/1t · 1,234 tok · $0.0044"
    );
    expect(compact).toContain("Found the active configuration");

    appendFileSync(join(runDir, "utility", "jobs.jsonl"), "{torn\n");
    expect(() =>
      renderUtilityPane(
        runDir,
        { LOOP_UTILITY_API_KEY_FILE: "" },
        { columns: 58, rows: 20 }
      )
    ).not.toThrow();
    expect(
      renderUtilityPane(
        runDir,
        { LOOP_UTILITY_API_KEY_FILE: "" },
        { columns: 58, rows: 20 }
      )
    ).toContain("Found the active configuration");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("utility pane keeps a failed worker response visible within its viewport", () => {
  const runDir = mkdtempSync(join(tmpdir(), "loop-utility-pane-failure-"));
  try {
    const request = createUtilityRouteRequest({
      acceptanceCriteria: ["return a bounded result"],
      authority: {},
      createdAt: "2026-07-25T13:00:00.000Z",
      id: "failed-pane-job",
      kind: "inspect",
      objective: "Inspect one source slice without widening scope",
      readScope: ["src"],
      requester: "claude",
      requiredCapabilities: ["inspect"],
      risk: "low",
      writeScope: [],
    });
    appendUtilityRouteRequest(runDir, request);
    transitionUtilityJob(runDir, request.id, "routed-utility", {
      at: "2026-07-25T13:00:00.100Z",
      decision: { reason: "utility-eligible", target: "utility" },
      routeEpoch: 1,
    });
    transitionUtilityJob(runDir, request.id, "failed", {
      at: "2026-07-25T13:00:01.000Z",
      result: {
        artifactRefs: [],
        blocker:
          "Worker token cap exceeded before a source-backed response could be produced.",
        checks: [],
        filesChanged: [],
        status: "failed",
        summary: "Utility worker failed closed.",
      },
    });

    const pane = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 52, rows: 12 }
    );
    const lines = pane.split("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((line) => line.length <= 52)).toBe(true);
    expect(pane).toContain("GLM FAIL failed-p");
    expect(pane).toContain("Worker token cap exceeded");

    const tiny = renderUtilityPane(
      runDir,
      { LOOP_UTILITY_API_KEY_FILE: "" },
      { columns: 20, rows: 5 }
    ).split("\n");
    expect(tiny).toHaveLength(5);
    expect(tiny.every((line) => line.length <= 20)).toBe(true);
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
});

test("a new governess epoch fences an orphaned utility claim", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-fence-"));
  const runDir = join(repoRoot, ".loop", "runs", "fence-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["finish"],
    authority: {},
    id: "fenced-job",
    kind: "inspect",
    objective: "Inspect one scope",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 4);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 4,
  });
  claimUtilityJob(runDir, 4, { jobId: request.id, workerPid: 4646 });
  const terminated: number[] = [];
  try {
    await processPendingUtilityRoutes(
      {
        currentDriver: "codex",
        epoch: 5,
        peer: "claude",
        repoRoot,
        runDir,
      },
      {},
      {
        isWorkerAlive: () => true,
        terminateWorker: (pid) => {
          terminated.push(pid);
          return true;
        },
      }
    );
    expect(terminated).toEqual([4646]);
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "utility claim belongs to a stale governess epoch",
        status: "failed",
      },
      state: "failed",
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("peer routing is relative to the requester, not the current driver", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-peer-"));
  const runDir = join(repoRoot, ".loop", "runs", "peer-run");
  mkdirSync(runDir, { recursive: true });
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["review it"],
    authority: {},
    id: "review-job",
    kind: "review",
    objective: "Review a bounded proposal",
    readScope: ["src"],
    requester: "claude",
    requiredCapabilities: [],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  try {
    await processPendingUtilityRoutes({
      currentDriver: "codex",
      epoch: 5,
      peer: "claude",
      repoRoot,
      runDir,
    });
    expect(readBridgeEvents(runDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "utility",
          target: "codex",
          taskId: request.id,
        }),
      ])
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a full agent applies a completed utility patch with pre/postimage journal proof", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-guarded-apply-"));
  const runDir = join(repoRoot, ".loop", "runs", "apply");
  try {
    const proposal = await completedEditProposal(
      repoRoot,
      runDir,
      "guarded-edit"
    );
    const applied = await applyUtilityJobPatch(
      runDir,
      "guarded-edit",
      proposal.patchSha256,
      "codex"
    );
    expect(applied.status).toBe("applied");
    expect(readFileSync(join(repoRoot, "src", "sample.ts"), "utf8")).toBe(
      "export const n = 2;\n"
    );
    const expectedPostimage = createHash("sha256")
      .update("export const n = 2;\n")
      .digest("hex");
    expect(readUtilityJob(runDir, "guarded-edit")?.application).toMatchObject({
      appliedBy: "codex",
      patchSha256: proposal.patchSha256,
      postimages: [{ path: "src/sample.ts", sha256: expectedPostimage }],
    });

    const repeated = await applyUtilityJobPatch(
      runDir,
      "guarded-edit",
      proposal.patchSha256,
      "claude"
    );
    expect(repeated.status).toBe("already-applied");

    writeFileSync(join(repoRoot, "src", "sample.ts"), "later drift\n");
    await expect(
      applyUtilityJobPatch(
        runDir,
        "guarded-edit",
        proposal.patchSha256,
        "claude"
      )
    ).rejects.toThrow("postimage drift detected");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("guarded patch application refuses wrong hashes and proposal-time drift", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-guarded-drift-"));
  const runDir = join(repoRoot, ".loop", "runs", "apply");
  try {
    const proposal = await completedEditProposal(
      repoRoot,
      runDir,
      "drifted-edit"
    );
    await expect(
      applyUtilityJobPatch(runDir, "drifted-edit", "0".repeat(64), "codex")
    ).rejects.toThrow("missing or ambiguous");

    const originalManifest = readFileSync(proposal.manifestPath, "utf8");
    writeFileSync(proposal.manifestPath, `${originalManifest} `);
    await expect(
      applyUtilityJobPatch(
        runDir,
        "drifted-edit",
        proposal.patchSha256,
        "codex"
      )
    ).rejects.toThrow("manifest hash does not match");
    writeFileSync(proposal.manifestPath, originalManifest);

    writeFileSync(join(repoRoot, "src", "sample.ts"), "concurrent edit\n");
    await expect(
      applyUtilityJobPatch(
        runDir,
        "drifted-edit",
        proposal.patchSha256,
        "codex"
      )
    ).rejects.toThrow("preimage drift detected");
    expect(readUtilityJob(runDir, "drifted-edit")?.application).toBeUndefined();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("utility worker completes against an OpenAI-compatible local endpoint", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-runtime-"));
  const runDir = join(repoRoot, ".loop", "runs", "test-run");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "sample.ts"),
    "export const ok = true;\n"
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["report completion"],
    authority: {},
    id: "job-1",
    kind: "inspect",
    objective: "Confirm the sample file exists",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 7);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    decision: {
      reason: "utility-eligible",
      target: "utility",
      tierId: "utility-default",
    },
    routeEpoch: 7,
  });
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return Response.json({
        choices: [
          {
            finish_reason: providerCalls === 1 ? "tool_calls" : "stop",
            message:
              providerCalls === 1
                ? {
                    content: null,
                    role: "assistant",
                    tool_calls: [
                      {
                        function: {
                          arguments: '{"path":"src/sample.ts"}',
                          name: "read_file",
                        },
                        id: "read-1",
                        type: "function",
                      },
                    ],
                  }
                : { content: "Sample file confirmed.", role: "assistant" },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 7, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: { status: "completed", summary: "Sample file confirmed." },
      state: "completed",
    });
    expect(readBridgeEvents(runDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          message: expect.stringContaining("Utility result job-1"),
          source: "utility",
          target: "codex",
        }),
      ])
    );
    expect(
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toContain('"tool":"read_file"');
    expect(
      readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8")
    ).toContain('"toolRounds":1');
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("utility worker rejects prose-only completion without repository evidence", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-no-evidence-"));
  const runDir = join(repoRoot, ".loop", "runs", "no-evidence");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repoRoot, "src", "sample.ts"), "export {};\n");
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["inspect with evidence"],
    authority: {},
    id: "no-evidence-job",
    kind: "inspect",
    objective: "Inspect the sample",
    readScope: ["src"],
    requester: "codex",
    requiredCapabilities: ["inspect"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 8);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 8,
  });
  const server = serve({
    fetch: () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Trust me, it exists.", role: "assistant" },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
      }),
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 8, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "utility task completed without repository tool evidence",
        status: "failed",
      },
      state: "failed",
    });
    expect(
      readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8")
    ).toContain('"status":"failed"');
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a failing focused check cannot satisfy command completion evidence", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "loop-utility-check-fail-"));
  const runDir = join(repoRoot, ".loop", "runs", "check-fail");
  mkdirSync(join(repoRoot, "tests"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(repoRoot, "tests", "fail.test.ts"),
    'import { expect, test } from "bun:test";\ntest("fails", () => expect(1).toBe(2));\n'
  );
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({ cwd: repoRoot })
  );
  const request = createUtilityRouteRequest({
    acceptanceCriteria: ["focused check passes"],
    authority: {},
    id: "failing-check-job",
    kind: "command",
    objective: "Run the focused check",
    readScope: ["tests"],
    requester: "claude",
    requiredCapabilities: ["focused-verify"],
    risk: "low",
    writeScope: [],
  });
  appendUtilityRouteRequest(runDir, request);
  activateUtilityEpoch(runDir, 9);
  transitionUtilityJob(runDir, request.id, "routed-utility", {
    routeEpoch: 9,
  });
  let providerCalls = 0;
  const server = serve({
    fetch: () => {
      providerCalls += 1;
      return Response.json({
        choices: [
          {
            finish_reason: providerCalls === 1 ? "tool_calls" : "stop",
            message:
              providerCalls === 1
                ? {
                    content: null,
                    role: "assistant",
                    tool_calls: [
                      {
                        function: {
                          arguments:
                            '{"argv":["bun","test","tests/fail.test.ts"],"cwd":"tests"}',
                          name: "run_check",
                        },
                        id: "check-1",
                        type: "function",
                      },
                    ],
                  }
                : { content: "The check ran.", role: "assistant" },
          },
        ],
        model: "local-test",
        usage: { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 },
      });
    },
    port: 0,
  });
  try {
    await runUtilityWorker(runDir, 9, request.id, {
      LOOP_UTILITY_ENABLED: "1",
      LOOP_UTILITY_MODEL: "local-test",
      LOOP_UTILITY_URL: `http://127.0.0.1:${server.port}/v1/chat/completions`,
    });
    expect(readUtilityJob(runDir, request.id)).toMatchObject({
      result: {
        blocker: "utility command completed without a successful focused check",
        status: "failed",
      },
      state: "failed",
    });
    expect(
      readFileSync(join(runDir, "utility", "tool-events.jsonl"), "utf8")
    ).toContain('"exitCode":1');
  } finally {
    server.stop(true);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
