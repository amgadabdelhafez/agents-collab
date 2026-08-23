import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchLiveSnapshot,
  isWebUiSnapshot,
  LiveSnapshotError,
} from "../../src/webui/api";
import {
  HARVTO_REPO_ID,
  handleLiveDataRequest,
  LiveDataUnavailableError,
  probeLoopRuntime,
  type RuntimeIdentity,
  readLoopRegistryLiveSnapshot,
} from "../../src/webui/server/harvto-live-data";
import type {
  RunDetailDTO,
  RunLifecycle,
  WebUiSnapshotDTO,
} from "../../src/webui/types";

const AI_CUR_REPO_ID = "ai-cur-458d3aca27ff";
const NOW = new Date("2026-08-21T20:00:00.000Z");
const PRESENT_RUNTIME = {
  label: "Terminal session present; server birth unverified",
  state: "unknown" as const,
};
const JSON_BYTE_LIMIT = 512 * 1024;
const JSONL_BYTE_LIMIT = 4 * 1024 * 1024;
const JSONL_LINE_LIMIT = 10_000;
const REPOSITORY_ENTRY_LIMIT = 256;
const RUN_ENTRY_LIMIT = 1024;
const TOTAL_RUN_DIRECTORY_LIMIT = 4096;
const ACTIVE_RUN_LIMIT = 64;
const WORKER_ACTIVITY_LIMIT = 8;

interface RunFixtureOptions {
  readonly createdAt?: string;
  readonly durableState?: RunLifecycle;
  readonly eventAt?: string;
  readonly primaryAgent?: "claude" | "codex";
  readonly rawSecret?: string;
  readonly session?: string;
  readonly state?: RunLifecycle;
  readonly status?: string;
  readonly trailingHookWithoutState?: boolean;
  readonly updatedAt?: string;
  readonly workspaceRepoId?: string;
}

interface RunFixture {
  readonly manifestPath: string;
  readonly rawValues: readonly string[];
  readonly repoDir: string;
  readonly repoId: string;
  readonly routeId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly session: string;
  readonly socketPath: string;
}

const registryRoots = new Set<string>();

afterEach(() => {
  for (const root of registryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  registryRoots.clear();
});

const createRegistry = (): string => {
  const root = mkdtempSync(join(tmpdir(), "webui-loop-registry-"));
  registryRoots.add(root);
  return root;
};

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
};

const writeJsonl = (path: string, values: readonly unknown[]): void => {
  writeFileSync(
    path,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8"
  );
};

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const repoSlug = (repoId: string): string => repoId.slice(0, -13);

const boundedRepoId = (index: number): string =>
  `bound-${index}-${index.toString(16).padStart(12, "0")}`;

const createNumberedDirectories = (
  parent: string,
  count: number,
  start = 1
): void => {
  for (let offset = 0; offset < count; offset += 1) {
    mkdirSync(join(parent, String(start + offset)), { recursive: true });
  }
};

const createManifestOnlyActiveRun = (
  root: string,
  repoId: string,
  runId: string
): void => {
  const runDir = join(root, repoId, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "manifest.json"), {
    createdAt: "2026-08-21T18:00:00.000Z",
    primaryAgent: "codex",
    repoId,
    runId,
    state: "working",
    status: "running",
    tmuxSession: `${repoSlug(repoId)}-loop-${runId}`,
    tmuxSocket: join(root, "bounded-runtime.sock"),
    updatedAt: "2026-08-21T18:01:00.000Z",
  });
};

const expectUnavailableReason = (
  operation: () => unknown,
  reason: string
): void => {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LiveDataUnavailableError);
  expect((caught as LiveDataUnavailableError).reason).toBe(reason);
};

const isoBefore = (value: string, milliseconds: number): string =>
  new Date(Date.parse(value) - milliseconds).toISOString();

const isoAfter = (value: string, milliseconds: number): string =>
  new Date(Date.parse(value) + milliseconds).toISOString();

const statusFor = (state: RunLifecycle): string => {
  if (state === "completed") {
    return "done";
  }
  if (state === "failed") {
    return "failed";
  }
  if (state === "stopped") {
    return "stopped";
  }
  return "running";
};

const createRun = (
  root: string,
  repoId: string,
  runId: string,
  options: RunFixtureOptions = {}
): RunFixture => {
  const repoDir = join(root, repoId);
  const runDir = join(repoDir, runId);
  const state = options.state ?? "submitted";
  const status = options.status ?? statusFor(state);
  const eventAt = options.eventAt ?? "2026-08-21T18:20:01.000Z";
  const createdAt = options.createdAt ?? isoBefore(eventAt, 20 * 60 * 1000);
  const updatedAt = options.updatedAt ?? isoBefore(eventAt, 60 * 1000);
  const primaryAgent = options.primaryAgent ?? "codex";
  const durableState =
    options.durableState ?? (state === "submitted" ? "working" : state);
  const secret =
    options.rawSecret ??
    `secret payload for ${repoId} run ${runId} must never cross the boundary`;
  const rawPath = `/private/tmp/${repoSlug(repoId)}-${runId}-sensitive-worktree`;
  const session = options.session ?? `${repoSlug(repoId)}-loop-${runId}`;
  const socketPath = join(root, `${repoSlug(repoId)}-${runId}.sock`);
  const manifestPath = join(runDir, "manifest.json");
  const claudeAt = isoBefore(eventAt, 1000);
  const codexAt = eventAt;

  mkdirSync(join(runDir, "hooks"), { recursive: true });
  mkdirSync(join(runDir, "utility"), { recursive: true });
  writeJson(manifestPath, {
    claudeSessionId: `${secret}-claude-session`,
    codexThreadId: `${secret}-codex-thread`,
    createdAt,
    cwd: rawPath,
    driverEffort: "high",
    launchClaimId: `${secret}-launch-claim`,
    pid: 1234,
    primaryAgent,
    repoId,
    reviewerEffort: "medium",
    runId,
    state,
    status,
    tmuxSession: session,
    tmuxSocket: socketPath,
    updatedAt,
    workspaceBinding: {
      branchRef: "refs/heads/private-loop-worktree",
      repoId: options.workspaceRepoId ?? repoId,
      root: rawPath,
    },
  });
  writeJson(join(runDir, "governess-state.json"), {
    bothIdleSince: Date.parse(codexAt),
    driverLease: {
      epoch: Number(runId) || 1,
      expiresAt: isoAfter(NOW.toISOString(), 60 * 60 * 1000),
      holder: primaryAgent,
    },
    governessEpoch: Number(runId) || 1,
    lifecycleEvents: {
      claude: { at: claudeAt, evidence: secret, state: durableState },
      codex: { at: codexAt, evidence: secret, state: durableState },
    },
    recoveries: 0,
    sessionPressure: {
      claude: {
        compactions: 0,
        contextUsedPct: 11,
        model: "claude-opus-5",
        phase: "healthy",
      },
      codex: {
        compactions: 1,
        contextUsedPct: 83,
        model: "gpt-5.6-sol",
        phase: "prepare",
      },
    },
    summary: secret,
    waitingAsk: secret,
    waitingConfirmed: durableState === "input-required",
  });

  const claudeRows: unknown[] = [
    {
      agent: "claude",
      cwd: rawPath,
      detail: secret,
      event: options.trailingHookWithoutState ? "PreToolUse" : "Notification",
      sequence: 11,
      state: durableState,
      ts: claudeAt,
    },
  ];
  const codexRows: unknown[] = [
    {
      agent: "codex",
      cwd: rawPath,
      detail: secret,
      event: "Stop",
      sequence: 19,
      state: durableState,
      ts: codexAt,
    },
  ];
  if (options.trailingHookWithoutState) {
    claudeRows.push({
      agent: "claude",
      cwd: rawPath,
      event: "PostToolUse",
      sequence: 12,
      tool: "secret-tool",
      ts: isoAfter(eventAt, 1000),
    });
    codexRows.push({
      agent: "codex",
      cwd: rawPath,
      event: "PostToolUse",
      sequence: 20,
      tool: "secret-tool",
      ts: isoAfter(eventAt, 1000),
    });
  }
  writeJsonl(join(runDir, "hooks", "claude.jsonl"), claudeRows);
  writeJsonl(join(runDir, "hooks", "codex.jsonl"), codexRows);
  writeJsonl(join(runDir, "bridge.jsonl"), [
    {
      at: isoBefore(eventAt, 20_000),
      id: `${secret}-bridge-id`,
      kind: "message",
      message: secret,
      signature: `${secret}-signature`,
      source: "codex",
      target: "claude",
    },
  ]);
  writeJson(join(runDir, "bridge-reconciliation.json"), {
    lastReason: secret,
    lastReconciledAt: isoAfter(eventAt, 60_000),
    pid: 9999,
    schemaVersion: 1,
  });
  writeJsonl(join(runDir, "utility", "jobs.jsonl"), [
    {
      at: isoBefore(eventAt, 50_000),
      jobId: `${secret}-worker-id`,
      request: { kind: "inspect", objective: secret },
      state: "pending-route",
    },
    {
      at: isoBefore(eventAt, 45_000),
      decision: { reason: secret, tierId: "utility-nanny" },
      jobId: `${secret}-worker-id`,
      state: "routed-utility",
    },
    {
      at: isoBefore(eventAt, 40_000),
      jobId: `${secret}-worker-id`,
      result: { summary: secret },
      state: "completed",
    },
  ]);

  return {
    manifestPath,
    rawValues: [
      secret,
      rawPath,
      session,
      socketPath,
      `${secret}-claude-session`,
      `${secret}-codex-thread`,
      `${secret}-launch-claim`,
      `${secret}-bridge-id`,
      `${secret}-signature`,
      `${secret}-worker-id`,
    ],
    repoDir,
    repoId,
    routeId: `${repoId}:${runId}`,
    runDir,
    runId,
    session,
    socketPath,
  };
};

const liveOptions = (storageRoot: string) => ({
  now: () => NOW,
  runtimeProbe: () => PRESENT_RUNTIME,
  storageRoot,
});

const inventory = (root: string): string => {
  const hash = createHash("sha256");
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const child = join(path, entry.name);
      hash.update(entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else {
        hash.update(readFileSync(child));
      }
    }
  };
  visit(root);
  return hash.digest("hex");
};

const detailIds = (detail: RunDetailDTO): ReadonlySet<string> =>
  new Set([
    ...detail.agents.map((agent) => agent.id),
    ...detail.evidence.map((evidence) => evidence.id),
    ...detail.timeline.map((event) => event.id),
    ...detail.workers.flatMap((tier) =>
      tier.activity.map((activity) => activity.id)
    ),
  ]);

const expectDisjoint = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): void => {
  expect([...left].filter((value) => right.has(value))).toEqual([]);
};

const cloneSnapshot = (
  snapshot: WebUiSnapshotDTO,
  update: Readonly<Record<string, unknown>>
): unknown => ({ ...snapshot, ...update });

describe("active loop registry Web UI projection", () => {
  test("projects duplicate run numbers across repositories without identity collisions", () => {
    const root = createRegistry();
    const harvto = createRun(root, HARVTO_REPO_ID, "7", {
      durableState: "input-required",
      rawSecret: "harvto secret must remain private",
    });
    const aiCur = createRun(root, AI_CUR_REPO_ID, "7", {
      durableState: "working",
      primaryAgent: "claude",
      rawSecret: "ai cur secret must remain private",
    });
    const before = inventory(root);

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));

    expect(inventory(root)).toBe(before);
    expect(isWebUiSnapshot(snapshot)).toBe(true);
    expect(snapshot.source).toBe("loop-registry-live");
    expect(snapshot.fleet.runs.map((run) => run.routeId).sort()).toEqual(
      [harvto.routeId, aiCur.routeId].sort()
    );
    expect(Object.keys(snapshot.details).sort()).toEqual(
      [harvto.routeId, aiCur.routeId].sort()
    );
    expect(snapshot.details[harvto.routeId]?.summary.repoId).toBe(
      HARVTO_REPO_ID
    );
    expect(snapshot.details[aiCur.routeId]?.summary.repoId).toBe(
      AI_CUR_REPO_ID
    );
    expect(snapshot.details[harvto.routeId]?.summary.runId).toBe("7");
    expect(snapshot.details[aiCur.routeId]?.summary.runId).toBe("7");
    expect(snapshot.details[harvto.routeId]?.summary.lifecycle).toBe(
      "input-required"
    );
    expect(snapshot.details[harvto.routeId]?.workers[1]?.counts.completed).toBe(
      1
    );

    const harvtoDetail = snapshot.details[harvto.routeId];
    const aiCurDetail = snapshot.details[aiCur.routeId];
    if (!(harvtoDetail && aiCurDetail)) {
      throw new Error("expected both projected run details");
    }
    expectDisjoint(detailIds(harvtoDetail), detailIds(aiCurDetail));
  });

  test("discovers every direct active run and excludes terminal or noncanonical entries", () => {
    const root = createRegistry();
    const harvto7 = createRun(root, HARVTO_REPO_ID, "7");
    const harvto8 = createRun(root, HARVTO_REPO_ID, "8", {
      state: "reviewing",
    });
    const aiCur7 = createRun(root, AI_CUR_REPO_ID, "7", {
      state: "blocked",
    });
    createRun(root, HARVTO_REPO_ID, "9", { state: "completed" });
    createRun(root, AI_CUR_REPO_ID, "draft", { state: "working" });
    mkdirSync(join(harvto7.runDir, "handoff", "123"), { recursive: true });
    writeJson(join(harvto7.runDir, "handoff", "123", "manifest.json"), {
      repoId: HARVTO_REPO_ID,
      runId: "123",
      state: "working",
      status: "running",
    });
    mkdirSync(join(harvto7.repoDir, "10"), { recursive: true });
    const symlinkTarget = join(root, "symlink-target");
    mkdirSync(symlinkTarget, { recursive: true });
    symlinkSync(symlinkTarget, join(harvto7.repoDir, "11"), "dir");

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));

    expect(snapshot.fleet.runs.map((run) => run.routeId).sort()).toEqual(
      [harvto7.routeId, harvto8.routeId, aiCur7.routeId].sort()
    );
    expect(snapshot.fleet.runs.map((run) => run.lifecycle).sort()).toEqual([
      "blocked",
      "reviewing",
      "working",
    ]);
    expect(snapshot.fleet.connection.state).toBe("behind");
    expect(snapshot.fleet.quality.summary).toContain("some registry evidence");
    expect(JSON.stringify(snapshot)).not.toContain(":123");
    expect(JSON.stringify(snapshot)).not.toContain(":draft");
  });

  test("rejects a repository replaced by an external symlink after root enumeration", () => {
    const root = createRegistry();
    const healthy = createRun(root, HARVTO_REPO_ID, "7");
    const replaced = createRun(root, AI_CUR_REPO_ID, "52");
    const outsideRoot = createRegistry();
    const outsideSecret = "outside repository manifest must not be read";
    const outside = createRun(outsideRoot, AI_CUR_REPO_ID, "52", {
      rawSecret: outsideSecret,
    });
    let swapped = false;

    const snapshot = readLoopRegistryLiveSnapshot({
      ...liveOptions(root),
      registryFs: {
        lstat: (path) => lstatSync(path),
        readDirectory: (path) => {
          const entries = readdirSync(path, { withFileTypes: true });
          if (path === root && !swapped) {
            rmSync(replaced.repoDir, { force: true, recursive: true });
            symlinkSync(outside.repoDir, replaced.repoDir, "dir");
            swapped = true;
          }
          return entries;
        },
      },
    });

    expect(swapped).toBe(true);
    expect(snapshot.fleet.runs.map((run) => run.routeId)).toEqual([
      healthy.routeId,
    ]);
    expect(snapshot.fleet.connection.state).toBe("behind");
    expect(JSON.stringify(snapshot)).not.toContain(outsideSecret);
  });

  test("fails closed when the registry root is replaced after enumeration", () => {
    const root = createRegistry();
    createRun(root, HARVTO_REPO_ID, "7");
    const outsideRoot = createRegistry();
    createRun(outsideRoot, HARVTO_REPO_ID, "7", {
      rawSecret: "outside registry root must not be read",
    });
    let rootStatCount = 0;
    let swapped = false;

    expectUnavailableReason(
      () =>
        readLoopRegistryLiveSnapshot({
          ...liveOptions(root),
          registryFs: {
            lstat: (path) => {
              if (path === root) {
                rootStatCount += 1;
                if (rootStatCount === 3) {
                  rmSync(root, { force: true, recursive: true });
                  symlinkSync(outsideRoot, root, "dir");
                  swapped = true;
                }
              }
              return lstatSync(path);
            },
            readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
          },
        }),
      "loop registry directory identity is invalid"
    );
    expect(swapped).toBe(true);
  });

  test("rejects a run replaced by an external symlink after repository enumeration", () => {
    const root = createRegistry();
    const replaced = createRun(root, HARVTO_REPO_ID, "7");
    const healthy = createRun(root, HARVTO_REPO_ID, "8");
    const outsideRoot = createRegistry();
    const outsideSecret = "outside run manifest must not be read";
    const outside = createRun(outsideRoot, HARVTO_REPO_ID, "7", {
      rawSecret: outsideSecret,
    });
    let swapped = false;

    const snapshot = readLoopRegistryLiveSnapshot({
      ...liveOptions(root),
      registryFs: {
        lstat: (path) => lstatSync(path),
        readDirectory: (path) => {
          const entries = readdirSync(path, { withFileTypes: true });
          if (path === replaced.repoDir && !swapped) {
            rmSync(replaced.runDir, { force: true, recursive: true });
            symlinkSync(outside.runDir, replaced.runDir, "dir");
            swapped = true;
          }
          return entries;
        },
      },
    });

    expect(swapped).toBe(true);
    expect(snapshot.fleet.runs.map((run) => run.routeId)).toEqual([
      healthy.routeId,
    ]);
    expect(snapshot.fleet.connection.state).toBe("behind");
    expect(JSON.stringify(snapshot)).not.toContain(outsideSecret);
  });

  test("omits a run whose directory identity changes after candidate discovery", () => {
    const root = createRegistry();
    const replaced = createRun(root, HARVTO_REPO_ID, "7");
    const healthy = createRun(root, HARVTO_REPO_ID, "8");
    const outsideRoot = createRegistry();
    const outsideSecret = "post-discovery outside run must not be projected";
    const outside = createRun(outsideRoot, HARVTO_REPO_ID, "7", {
      rawSecret: outsideSecret,
    });
    let runStatCount = 0;
    let swapped = false;

    const snapshot = readLoopRegistryLiveSnapshot({
      ...liveOptions(root),
      registryFs: {
        lstat: (path) => {
          if (path === replaced.runDir) {
            runStatCount += 1;
            if (runStatCount === 3) {
              rmSync(replaced.runDir, { force: true, recursive: true });
              symlinkSync(outside.runDir, replaced.runDir, "dir");
              swapped = true;
            }
          }
          return lstatSync(path);
        },
        readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
      },
    });

    expect(swapped).toBe(true);
    expect(snapshot.fleet.runs.map((run) => run.routeId)).toEqual([
      healthy.routeId,
    ]);
    expect(snapshot.fleet.connection.state).toBe("behind");
    expect(snapshot.fleet.quality.label).toBe("Partial coverage");
    expect(JSON.stringify(snapshot)).not.toContain(replaced.routeId);
    expect(JSON.stringify(snapshot)).not.toContain(outsideSecret);
  });

  test("does not degrade a run swapped during detailed evidence projection", () => {
    const root = createRegistry();
    const replaced = createRun(root, HARVTO_REPO_ID, "7");
    const healthy = createRun(root, HARVTO_REPO_ID, "8");
    const outsideRoot = createRegistry();
    const outsideRunDir = join(outsideRoot, HARVTO_REPO_ID, "7");
    mkdirSync(outsideRunDir, { recursive: true });
    let swapped = false;

    const snapshot = readLoopRegistryLiveSnapshot({
      ...liveOptions(root),
      runtimeProbe: (identity) => {
        if (identity.session === replaced.session && !swapped) {
          rmSync(replaced.runDir, { force: true, recursive: true });
          symlinkSync(outsideRunDir, replaced.runDir, "dir");
          swapped = true;
        }
        return PRESENT_RUNTIME;
      },
    });

    expect(swapped).toBe(true);
    expect(snapshot.fleet.runs.map((run) => run.routeId)).toEqual([
      healthy.routeId,
    ]);
    expect(snapshot.fleet.connection.state).toBe("behind");
    expect(snapshot.fleet.quality.label).toBe("Partial coverage");
    expect(JSON.stringify(snapshot)).not.toContain(replaced.routeId);
  });

  test("omits a run swapped during manifest-only degradation", () => {
    const root = createRegistry();
    const replaced = createRun(root, HARVTO_REPO_ID, "7");
    const healthy = createRun(root, HARVTO_REPO_ID, "8");
    writeFileSync(
      join(replaced.runDir, "governess-state.json"),
      "{malformed",
      "utf8"
    );
    const outsideRoot = createRegistry();
    const outsideRunDir = join(outsideRoot, HARVTO_REPO_ID, "7");
    mkdirSync(outsideRunDir, { recursive: true });
    let targetProbeCount = 0;
    let swapped = false;

    const snapshot = readLoopRegistryLiveSnapshot({
      ...liveOptions(root),
      runtimeProbe: (identity) => {
        if (identity.session === replaced.session) {
          targetProbeCount += 1;
          if (targetProbeCount === 2) {
            rmSync(replaced.runDir, { force: true, recursive: true });
            symlinkSync(outsideRunDir, replaced.runDir, "dir");
            swapped = true;
          }
        }
        return PRESENT_RUNTIME;
      },
    });

    expect(targetProbeCount).toBe(2);
    expect(swapped).toBe(true);
    expect(snapshot.fleet.runs.map((run) => run.routeId)).toEqual([
      healthy.routeId,
    ]);
    expect(snapshot.fleet.connection.state).toBe("behind");
    expect(snapshot.fleet.quality.label).toBe("Partial coverage");
    expect(JSON.stringify(snapshot)).not.toContain(replaced.routeId);
  });

  test("validates generic exact sessions for Harvto and AI Cur", () => {
    const root = createRegistry();
    const harvto = createRun(root, HARVTO_REPO_ID, "17");
    const aiCur = createRun(root, AI_CUR_REPO_ID, "52", {
      primaryAgent: "claude",
    });
    const observed: RuntimeIdentity[] = [];

    const snapshot = readLoopRegistryLiveSnapshot({
      now: () => NOW,
      runtimeProbe: (identity) => {
        observed.push(identity);
        return PRESENT_RUNTIME;
      },
      storageRoot: root,
    });

    expect(snapshot.fleet.runs).toHaveLength(2);
    expect(
      observed
        .map(({ session, socketPath }) => `${session}|${socketPath}`)
        .sort()
    ).toEqual(
      [
        `${harvto.session}|${harvto.socketPath}`,
        `${aiCur.session}|${aiCur.socketPath}`,
      ].sort()
    );

    writeJson(aiCur.manifestPath, {
      ...readJson(aiCur.manifestPath),
      tmuxSession: "wrong-loop-52",
    });
    const afterMismatch = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(afterMismatch.fleet.runs.map((run) => run.routeId)).toEqual([
      harvto.routeId,
    ]);
    expect(afterMismatch.fleet.connection.state).toBe("behind");
  });

  test("uses the latest valid lifecycle-bearing hook when a trailing row has no state", () => {
    const root = createRegistry();
    const fixture = createRun(root, AI_CUR_REPO_ID, "52", {
      durableState: "reviewing",
      trailingHookWithoutState: true,
    });

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    const detail = snapshot.details[fixture.routeId];
    const claude = detail?.agents.find(
      (agent) => agent.displayName === "Claude"
    );
    const codex = detail?.agents.find((agent) => agent.displayName === "Codex");

    expect(claude?.lastHookEvent).toBe("PostToolUse");
    expect(claude?.lastHookAt).toBe("2026-08-21T18:20:02.000Z");
    expect(claude?.lifecycle).toBe("reviewing");
    expect(claude?.toolsInFlight).toBe(0);
    expect(codex?.lastHookEvent).toBe("PostToolUse");
    expect(codex?.lastHookAt).toBe("2026-08-21T18:20:02.000Z");
    expect(detail?.connection.lastEventAt).toBe("2026-08-21T18:20:02.000Z");
    expect(detail?.connection.streamSequence).toBe(33);
  });

  test("skips invalid hook counters and normalizes invalid compaction counters", () => {
    const root = createRegistry();
    const fixture = createRun(root, AI_CUR_REPO_ID, "52");
    const claudeHookPath = join(fixture.runDir, "hooks", "claude.jsonl");
    writeJsonl(claudeHookPath, [
      {
        agent: "claude",
        event: "Notification",
        sequence: 11,
        state: "working",
        ts: "2026-08-21T18:20:00.000Z",
      },
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((sequence, index) => ({
        agent: "claude",
        event: "PostToolUse",
        sequence,
        state: "working",
        ts: `2026-08-21T18:20:0${index + 2}.000Z`,
      })),
    ]);

    const governessPath = join(fixture.runDir, "governess-state.json");
    const governess = readJson(governessPath);
    const pressure = governess.sessionPressure as Record<string, unknown>;
    const codexPressure = pressure.codex as Record<string, unknown>;
    for (const compactions of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      writeJson(governessPath, {
        ...governess,
        sessionPressure: {
          ...pressure,
          codex: { ...codexPressure, compactions },
        },
      });
      const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
      const detail = snapshot.details[fixture.routeId];
      const codex = detail?.agents.find(
        (agent) => agent.displayName === "Codex"
      );

      expect(detail?.connection.streamSequence).toBe(31);
      expect(codex?.usage.compactions).toBe(0);
      expect(isWebUiSnapshot(snapshot)).toBe(true);
    }
  });

  test("saturates per-run and fleet sequence sums at a safe integer", () => {
    const root = createRegistry();
    const fixtures = [
      createRun(root, HARVTO_REPO_ID, "242"),
      createRun(root, AI_CUR_REPO_ID, "52"),
    ];
    for (const fixture of fixtures) {
      for (const agent of ["claude", "codex"] as const) {
        writeJsonl(join(fixture.runDir, "hooks", `${agent}.jsonl`), [
          {
            agent,
            event: "Notification",
            sequence: Number.MAX_SAFE_INTEGER,
            state: "working",
            ts: "2026-08-21T18:20:01.000Z",
          },
        ]);
      }
    }

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(snapshot.fleet.connection.streamSequence).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(
      Object.values(snapshot.details).every(
        (detail) => detail.connection.streamSequence === Number.MAX_SAFE_INTEGER
      )
    ).toBe(true);
    expect(isWebUiSnapshot(snapshot)).toBe(true);
  });

  test("ignores stale waiting and blocked states when newer per-agent evidence reports progress", () => {
    const root = createRegistry();
    const fixture = createRun(root, AI_CUR_REPO_ID, "52");
    const governessPath = join(fixture.runDir, "governess-state.json");
    writeJson(governessPath, {
      ...readJson(governessPath),
      lifecycleEvents: {
        claude: {
          at: "2026-08-21T18:10:00.000Z",
          state: "input-required",
        },
        codex: { at: "2026-08-21T18:40:00.000Z", state: "reviewing" },
      },
      waitingConfirmed: true,
    });
    writeJsonl(join(fixture.runDir, "hooks", "claude.jsonl"), [
      {
        agent: "claude",
        event: "PreToolUse",
        sequence: 101,
        state: "working",
        ts: "2026-08-21T18:30:00.000Z",
      },
    ]);
    writeJsonl(join(fixture.runDir, "hooks", "codex.jsonl"), [
      {
        agent: "codex",
        event: "PreToolUse",
        sequence: 102,
        state: "blocked",
        ts: "2026-08-21T18:30:00.000Z",
      },
    ]);

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    const detail = snapshot.details[fixture.routeId];
    const claude = detail?.agents.find(
      (agent) => agent.displayName === "Claude"
    );
    const codex = detail?.agents.find((agent) => agent.displayName === "Codex");

    expect(detail?.summary.lifecycle).toBe("reviewing");
    expect(detail?.summary.reasons.map((reason) => reason.code)).not.toContain(
      "input-required"
    );
    expect(detail?.summary.reasons.map((reason) => reason.code)).not.toContain(
      "failed-control"
    );
    expect(claude).toMatchObject({
      lifecycle: "working",
      taskObservedAt: "2026-08-21T18:30:00.000Z",
      taskSource: "latest normalized hook lifecycle",
      toolsInFlight: 1,
    });
    expect(
      claude?.provenance.map(({ sourceKind, state }) => [sourceKind, state])
    ).toEqual([
      ["hook-journal", "current"],
      ["governess-journal", "stale"],
    ]);
    expect(codex).toMatchObject({
      lifecycle: "reviewing",
      taskObservedAt: "2026-08-21T18:40:00.000Z",
      taskSource: "latest persisted Governess lifecycle",
      toolsInFlight: 0,
    });
    expect(
      codex?.provenance.map(({ sourceKind, state }) => [sourceKind, state])
    ).toEqual([
      ["hook-journal", "stale"],
      ["governess-journal", "current"],
    ]);
  });

  test("keeps every provenance timestamp bound to its named source", () => {
    const root = createRegistry();
    const fixture = createRun(root, AI_CUR_REPO_ID, "52");
    const governessPath = join(fixture.runDir, "governess-state.json");
    writeJson(governessPath, {
      ...readJson(governessPath),
      lifecycleEvents: {
        claude: {
          at: "2026-08-21T18:10:00.000Z",
          state: "input-required",
        },
      },
    });
    writeJsonl(join(fixture.runDir, "hooks", "claude.jsonl"), [
      {
        agent: "claude",
        event: "PreToolUse",
        sequence: 101,
        state: "working",
        ts: "2026-08-21T18:30:00.000Z",
      },
    ]);
    writeJsonl(join(fixture.runDir, "hooks", "codex.jsonl"), [
      {
        agent: "codex",
        event: "Notification",
        sequence: 102,
        state: "reviewing",
        ts: "2026-08-21T18:31:00.000Z",
      },
    ]);
    const governessFileObservedAt = new Date(
      lstatSync(governessPath).mtimeMs
    ).toISOString();

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    const detail = snapshot.details[fixture.routeId];
    if (!detail) {
      throw new Error("Missing projected detail for provenance test");
    }
    const governessLifecycleSource = detail.quality.sources.find(
      (candidate) => candidate.sourceKind === "governess-journal"
    );
    const codexGovernessSource = detail.agents
      .find((agent) => agent.displayName === "Codex")
      ?.provenance.find(
        (candidate) => candidate.sourceKind === "governess-journal"
      );
    const governessSources = [
      ...detail.quality.sources,
      ...detail.agents.flatMap((agent) => agent.provenance),
      ...detail.governess.facts.map((fact) => fact.provenance),
      ...detail.evidence.map((evidence) => evidence.provenance),
      ...detail.timeline.map((event) => event.provenance),
    ].filter((candidate) => candidate.sourceKind === "governess-journal");

    expect(governessLifecycleSource).toMatchObject({
      observedAt: "2026-08-21T18:10:00.000Z",
      state: "stale",
    });
    expect(codexGovernessSource).toMatchObject({
      observedAt: governessFileObservedAt,
      state: "missing",
    });
    expect(governessSources.length).toBeGreaterThan(0);
    expect(
      governessSources.every((candidate) =>
        ["2026-08-21T18:10:00.000Z", governessFileObservedAt].includes(
          candidate.observedAt
        )
      )
    ).toBe(true);
    expect(governessSources.map((source) => source.observedAt)).not.toContain(
      "2026-08-21T18:30:00.000Z"
    );
    expect(governessSources.map((source) => source.observedAt)).not.toContain(
      "2026-08-21T18:31:00.000Z"
    );
  });

  test("preserves newer waiting and blocked states when progress evidence is stale", () => {
    const root = createRegistry();
    const fixture = createRun(root, AI_CUR_REPO_ID, "53");
    const governessPath = join(fixture.runDir, "governess-state.json");
    writeJson(governessPath, {
      ...readJson(governessPath),
      lifecycleEvents: {
        claude: {
          at: "2026-08-21T18:40:00.000Z",
          state: "input-required",
        },
        codex: { at: "2026-08-21T18:10:00.000Z", state: "reviewing" },
      },
      waitingConfirmed: true,
    });
    writeJsonl(join(fixture.runDir, "hooks", "claude.jsonl"), [
      {
        agent: "claude",
        event: "PreToolUse",
        sequence: 101,
        state: "working",
        ts: "2026-08-21T18:30:00.000Z",
      },
    ]);
    writeJsonl(join(fixture.runDir, "hooks", "codex.jsonl"), [
      {
        agent: "codex",
        event: "Stop",
        sequence: 102,
        state: "blocked",
        ts: "2026-08-21T18:30:00.000Z",
      },
    ]);

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    const detail = snapshot.details[fixture.routeId];
    const claude = detail?.agents.find(
      (agent) => agent.displayName === "Claude"
    );
    const codex = detail?.agents.find((agent) => agent.displayName === "Codex");

    expect(detail?.summary.lifecycle).toBe("blocked");
    expect(detail?.connection.lastEventAt).toBe("2026-08-21T18:40:00.000Z");
    expect(detail?.summary.lastDurableEventAt).toBe("2026-08-21T18:40:00.000Z");
    expect(snapshot.fleet.connection.lastEventAt).toBe(
      "2026-08-21T18:40:00.000Z"
    );
    expect(
      detail?.timeline.find(
        (event) =>
          event.title === "Newer lifecycle evidence disagrees with manifest"
      )
    ).toMatchObject({
      at: "2026-08-21T18:40:00.000Z",
      provenance: { observedAt: "2026-08-21T18:40:00.000Z" },
    });
    expect(detail?.summary.reasons.map((reason) => reason.code)).toContain(
      "failed-control"
    );
    expect(claude).toMatchObject({
      lifecycle: "waiting-human",
      taskObservedAt: "2026-08-21T18:40:00.000Z",
      taskSource: "latest persisted Governess lifecycle",
      toolsInFlight: 0,
    });
    expect(codex).toMatchObject({
      lifecycle: "stuck",
      taskObservedAt: "2026-08-21T18:30:00.000Z",
      taskSource: "latest normalized hook lifecycle",
      toolsInFlight: 0,
    });
  });

  test("degrades one malformed active detail without suppressing its valid peer", () => {
    const root = createRegistry();
    const valid = createRun(root, HARVTO_REPO_ID, "242", {
      durableState: "input-required",
    });
    const malformed = createRun(root, AI_CUR_REPO_ID, "52");
    writeFileSync(
      join(malformed.runDir, "governess-state.json"),
      Buffer.from([0xc3, 0x28])
    );

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    const validDetail = snapshot.details[valid.routeId];
    const degradedDetail = snapshot.details[malformed.routeId];

    expect(isWebUiSnapshot(snapshot)).toBe(true);
    expect(snapshot.fleet.runs).toHaveLength(2);
    expect(snapshot.fleet.connection.state).toBe("behind");
    expect(validDetail?.quality.severity).not.toBe("corrupt");
    expect(validDetail?.evidence.length).toBeGreaterThan(1);
    expect(degradedDetail?.quality.severity).toBe("corrupt");
    expect(degradedDetail?.summary.reasons[0]?.code).toBe("corrupt-evidence");
    expect(
      degradedDetail?.agents.every((agent) => agent.lifecycle === "limited")
    ).toBe(true);
    expect(degradedDetail?.evidence).toHaveLength(1);
  });

  test("returns 503 when an invalid active manifest leaves no valid candidate", () => {
    const root = createRegistry();
    const invalid = createRun(root, AI_CUR_REPO_ID, "52");
    writeJson(invalid.manifestPath, {
      ...readJson(invalid.manifestPath),
      repoId: HARVTO_REPO_ID,
    });

    expect(() => readLoopRegistryLiveSnapshot(liveOptions(root))).toThrow(
      LiveDataUnavailableError
    );

    const response = handleLiveDataRequest(
      { host: "127.0.0.1:46327", method: "GET", url: "/api/v1/live-snapshot" },
      {
        ...liveOptions(root),
        expectedHost: "127.0.0.1:46327",
      }
    );
    expect(response?.status).toBe(503);
    expect(response?.body).toContain("LIVE_DATA_UNAVAILABLE");
    expect(response?.body).not.toContain("fixture");
  });

  test("returns a validated empty snapshot after a clean no-active scan", () => {
    const root = createRegistry();
    createRun(root, HARVTO_REPO_ID, "1", { state: "completed" });

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    const response = handleLiveDataRequest(
      { host: "127.0.0.1:46327", method: "GET", url: "/api/v1/live-snapshot" },
      {
        ...liveOptions(root),
        expectedHost: "127.0.0.1:46327",
      }
    );

    expect(isWebUiSnapshot(snapshot)).toBe(true);
    expect(snapshot.fleet.runs).toEqual([]);
    expect(snapshot.details).toEqual({});
    expect(snapshot.fleet.connection.state).toBe("live");
    expect(snapshot.fleet.quality.severity).toBe("healthy");
    expect(response?.status).toBe(200);
    expect(isWebUiSnapshot(JSON.parse(response?.body ?? "null"))).toBe(true);
  });

  test("orders active runs deterministically by durable event, repository, and numeric run", () => {
    const root = createRegistry();
    const harvto10 = createRun(root, HARVTO_REPO_ID, "10", {
      eventAt: "2026-08-21T18:30:00.000Z",
    });
    const harvto2 = createRun(root, HARVTO_REPO_ID, "2", {
      eventAt: "2026-08-21T19:00:00.000Z",
    });
    const aiCur7 = createRun(root, AI_CUR_REPO_ID, "7", {
      eventAt: "2026-08-21T18:30:00.000Z",
    });

    const first = readLoopRegistryLiveSnapshot(liveOptions(root));
    const second = readLoopRegistryLiveSnapshot(liveOptions(root));
    const expected = [harvto2.routeId, aiCur7.routeId, harvto10.routeId];

    expect(first.fleet.runs.map((run) => run.routeId)).toEqual(expected);
    expect(second.fleet.runs.map((run) => run.routeId)).toEqual(expected);
    expect(Object.keys(first.details)).toEqual(expected);
    expect(Object.keys(second.details)).toEqual(expected);
  });

  test("allows only same-host GET and HEAD requests", () => {
    const root = createRegistry();
    createRun(root, HARVTO_REPO_ID, "7");
    const options = {
      ...liveOptions(root),
      expectedHost: "127.0.0.1:46327",
    } as const;

    const get = handleLiveDataRequest(
      { host: "127.0.0.1:46327", method: "GET", url: "/api/v1/live-snapshot" },
      options
    );
    const head = handleLiveDataRequest(
      { host: "127.0.0.1:46327", method: "HEAD", url: "/api/v1/live-snapshot" },
      options
    );
    const post = handleLiveDataRequest(
      { host: "127.0.0.1:46327", method: "POST", url: "/api/v1/live-snapshot" },
      options
    );
    const wrongHost = handleLiveDataRequest(
      { host: "evil.example", method: "GET", url: "/api/v1/live-snapshot" },
      options
    );
    const wrongOrigin = handleLiveDataRequest(
      {
        host: "127.0.0.1:46327",
        method: "GET",
        origin: "http://evil.example",
        url: "/api/v1/live-snapshot",
      },
      options
    );

    expect(get?.status).toBe(200);
    expect(isWebUiSnapshot(JSON.parse(get?.body ?? "null"))).toBe(true);
    expect(head).toMatchObject({ body: "", status: 200 });
    expect(post?.status).toBe(405);
    expect(post?.headers.Allow).toBe("GET, HEAD");
    expect(wrongHost?.status).toBe(403);
    expect(wrongOrigin?.status).toBe(403);
    expect(
      handleLiveDataRequest(
        { host: "127.0.0.1:46327", method: "GET", url: "/not-live" },
        options
      )
    ).toBeUndefined();
  });

  test("rejects duplicate, orphaned, missing, and mismatched DTO identities", () => {
    const root = createRegistry();
    const harvto = createRun(root, HARVTO_REPO_ID, "7");
    const aiCur = createRun(root, AI_CUR_REPO_ID, "7");
    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    const first = snapshot.fleet.runs[0];
    const firstDetail = first ? snapshot.details[first.routeId] : undefined;
    if (!(first && firstDetail)) {
      throw new Error("expected a projected run for DTO mutation tests");
    }

    const duplicate = cloneSnapshot(snapshot, {
      fleet: { ...snapshot.fleet, runs: [first, first] },
    });
    const orphan = cloneSnapshot(snapshot, {
      details: {
        ...snapshot.details,
        [`${HARVTO_REPO_ID}:999`]: firstDetail,
      },
    });
    const missing = cloneSnapshot(snapshot, {
      details: Object.fromEntries(
        Object.entries(snapshot.details).filter(
          ([key]) => key !== aiCur.routeId
        )
      ),
    });
    const mismatchedSummary = cloneSnapshot(snapshot, {
      details: {
        ...snapshot.details,
        [first.routeId]: {
          ...firstDetail,
          summary: {
            ...firstDetail.summary,
            repoId:
              first.repoId === AI_CUR_REPO_ID ? HARVTO_REPO_ID : AI_CUR_REPO_ID,
          },
        },
      },
    });
    const mismatchedAuthority = cloneSnapshot(snapshot, {
      details: {
        ...snapshot.details,
        [harvto.routeId]: {
          ...snapshot.details[harvto.routeId],
          authority: {
            ...snapshot.details[harvto.routeId]?.authority,
            runId: "999",
          },
        },
      },
    });
    const malformedWindow = cloneSnapshot(snapshot, {
      details: {
        ...snapshot.details,
        [first.routeId]: {
          ...firstDetail,
          agents: [
            {
              ...firstDetail.agents[0],
              usage: { ...firstDetail.agents[0]?.usage, windows: [null] },
            },
            ...firstDetail.agents.slice(1),
          ],
        },
      },
    });
    const malformedAudit = cloneSnapshot(snapshot, {
      details: {
        ...snapshot.details,
        [first.routeId]: {
          ...firstDetail,
          governess: { ...firstDetail.governess, audit: [null] },
        },
      },
    });

    expect(isWebUiSnapshot(snapshot)).toBe(true);
    expect(isWebUiSnapshot(duplicate)).toBe(false);
    expect(isWebUiSnapshot(orphan)).toBe(false);
    expect(isWebUiSnapshot(missing)).toBe(false);
    expect(isWebUiSnapshot(mismatchedSummary)).toBe(false);
    expect(isWebUiSnapshot(mismatchedAuthority)).toBe(false);
    expect(isWebUiSnapshot(malformedWindow)).toBe(false);
    expect(isWebUiSnapshot(malformedAudit)).toBe(false);
  });

  test("probes every runtime with exact socket and exact session argv", () => {
    const calls: Array<{
      readonly args: readonly string[];
      readonly command: string;
    }> = [];
    for (const identity of [
      { session: "harvto-loop-242", socketPath: "/private/tmp/harvto.sock" },
      { session: "ai-cur-loop-52", socketPath: "/private/tmp/ai-cur.sock" },
    ]) {
      const result = probeLoopRuntime(identity, {
        lstat: () => ({
          isSocket: () => true,
          isSymbolicLink: () => false,
        }),
        spawn: (command, args) => {
          calls.push({ args, command });
          return { status: 0, stderr: "" };
        },
      });
      expect(result).toEqual(PRESENT_RUNTIME);
    }

    expect(calls).toEqual([
      {
        args: [
          "-S",
          "/private/tmp/harvto.sock",
          "has-session",
          "-t",
          "=harvto-loop-242",
        ],
        command: "tmux",
      },
      {
        args: [
          "-S",
          "/private/tmp/ai-cur.sock",
          "has-session",
          "-t",
          "=ai-cur-loop-52",
        ],
        command: "tmux",
      },
    ]);
  });

  test("redacts combined sensitive content from every projected repository", () => {
    const root = createRegistry();
    const fixtures = [
      createRun(root, HARVTO_REPO_ID, "242", {
        rawSecret: "harvto raw objective and credential",
      }),
      createRun(root, AI_CUR_REPO_ID, "52", {
        rawSecret: "ai cur raw objective and credential",
      }),
    ];

    const snapshot = readLoopRegistryLiveSnapshot(liveOptions(root));
    const serialized = JSON.stringify(snapshot);

    for (const forbidden of fixtures.flatMap((fixture) => fixture.rawValues)) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toMatch(/\/(?:Users|private|tmp)\//u);
    expect(snapshot.fleet.runs).toHaveLength(2);
    expect(isWebUiSnapshot(snapshot)).toBe(true);
  });

  test("accepts the repository-entry limit and rejects the next entry", () => {
    const root = createRegistry();
    for (let index = 0; index < REPOSITORY_ENTRY_LIMIT; index += 1) {
      mkdirSync(join(root, `ignored_${index}`));
    }

    const atLimit = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(atLimit.fleet.runs).toEqual([]);

    mkdirSync(join(root, `ignored_${REPOSITORY_ENTRY_LIMIT}`));
    expectUnavailableReason(
      () => readLoopRegistryLiveSnapshot(liveOptions(root)),
      "loop registry exceeds its repository bound"
    );
  });

  test("isolates a repository only after its run-entry limit is exceeded", () => {
    const root = createRegistry();
    const boundedRepo = boundedRepoId(1);
    const boundedRepoDir = join(root, boundedRepo);
    mkdirSync(boundedRepoDir);
    createNumberedDirectories(boundedRepoDir, RUN_ENTRY_LIMIT);
    const peer = createRun(root, AI_CUR_REPO_ID, "52");

    const atLimit = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(atLimit.fleet.runs.map((run) => run.routeId)).toEqual([
      peer.routeId,
    ]);
    expect(atLimit.fleet.connection.state).toBe("live");

    mkdirSync(join(boundedRepoDir, String(RUN_ENTRY_LIMIT + 1)));
    const aboveLimit = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(aboveLimit.fleet.runs.map((run) => run.routeId)).toEqual([
      peer.routeId,
    ]);
    expect(aboveLimit.fleet.connection.state).toBe("behind");
    expect(aboveLimit.fleet.quality.summary).toContain(
      "could not be validated"
    );
  });

  test("accepts the total numeric run-directory limit and rejects the next directory", () => {
    const root = createRegistry();
    for (let index = 1; index <= 4; index += 1) {
      const repoDir = join(root, boundedRepoId(index));
      mkdirSync(repoDir);
      createNumberedDirectories(repoDir, RUN_ENTRY_LIMIT);
    }

    const atLimit = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(atLimit.fleet.runs).toEqual([]);
    expect(4 * RUN_ENTRY_LIMIT).toBe(TOTAL_RUN_DIRECTORY_LIMIT);

    const aboveLimitRepo = join(root, boundedRepoId(5));
    mkdirSync(aboveLimitRepo);
    mkdirSync(join(aboveLimitRepo, "1"));
    expectUnavailableReason(
      () => readLoopRegistryLiveSnapshot(liveOptions(root)),
      "loop registry exceeds its run-directory bound"
    );
  });

  test("accepts the active-run limit and rejects the next validated manifest", () => {
    const root = createRegistry();
    const repoId = boundedRepoId(8);
    for (let runId = 1; runId <= ACTIVE_RUN_LIMIT; runId += 1) {
      createManifestOnlyActiveRun(root, repoId, String(runId));
    }

    const atLimit = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(atLimit.fleet.runs).toHaveLength(ACTIVE_RUN_LIMIT);
    expect(Object.keys(atLimit.details)).toHaveLength(ACTIVE_RUN_LIMIT);

    createManifestOnlyActiveRun(root, repoId, String(ACTIVE_RUN_LIMIT + 1));
    expectUnavailableReason(
      () => readLoopRegistryLiveSnapshot(liveOptions(root)),
      "loop registry exceeds its active-run bound"
    );
  });

  test("accepts the JSON byte limit and degrades only that run above it", () => {
    const root = createRegistry();
    const fixture = createRun(root, HARVTO_REPO_ID, "242");
    const reconciliationPath = join(
      fixture.runDir,
      "bridge-reconciliation.json"
    );
    const atLimit = `{"pad":"${"x".repeat(JSON_BYTE_LIMIT - 10)}"}`;
    expect(Buffer.byteLength(atLimit)).toBe(JSON_BYTE_LIMIT);
    writeFileSync(reconciliationPath, atLimit, "utf8");

    const accepted = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(accepted.details[fixture.routeId]?.quality.severity).not.toBe(
      "corrupt"
    );

    writeFileSync(reconciliationPath, `${atLimit} `, "utf8");
    const degraded = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(degraded.details[fixture.routeId]?.quality.severity).toBe("corrupt");
  });

  test("accepts the JSONL byte limit and degrades only that run above it", () => {
    const root = createRegistry();
    const fixture = createRun(root, HARVTO_REPO_ID, "242");
    const bridgePath = join(fixture.runDir, "bridge.jsonl");
    const atLimit = " ".repeat(JSONL_BYTE_LIMIT);
    expect(Buffer.byteLength(atLimit)).toBe(JSONL_BYTE_LIMIT);
    writeFileSync(bridgePath, atLimit, "utf8");

    const accepted = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(accepted.details[fixture.routeId]?.quality.severity).not.toBe(
      "corrupt"
    );

    writeFileSync(bridgePath, `${atLimit} `, "utf8");
    const degraded = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(degraded.details[fixture.routeId]?.quality.severity).toBe("corrupt");
  });

  test("accepts the JSONL line limit and degrades only that run above it", () => {
    const root = createRegistry();
    const fixture = createRun(root, HARVTO_REPO_ID, "242");
    const bridgePath = join(fixture.runDir, "bridge.jsonl");
    const atLimit = "{}\n".repeat(JSONL_LINE_LIMIT);
    writeFileSync(bridgePath, atLimit, "utf8");

    const accepted = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(accepted.details[fixture.routeId]?.quality.severity).not.toBe(
      "corrupt"
    );

    writeFileSync(bridgePath, `${atLimit}{}\n`, "utf8");
    const degraded = readLoopRegistryLiveSnapshot(liveOptions(root));
    expect(degraded.details[fixture.routeId]?.quality.severity).toBe("corrupt");
  });

  test("keeps worker counts complete while bounding projected activity", () => {
    const root = createRegistry();
    const fixture = createRun(root, HARVTO_REPO_ID, "242");
    const jobsPath = join(fixture.runDir, "utility", "jobs.jsonl");
    const jobs = Array.from(
      { length: WORKER_ACTIVITY_LIMIT + 1 },
      (_, index) => ({
        at: new Date(
          Date.parse("2026-08-21T18:00:00.000Z") + index * 1000
        ).toISOString(),
        decision: { tierId: "utility-nanny" },
        jobId: `bounded-worker-${index}`,
        request: { kind: "inspect" },
        state: "completed",
      })
    );
    writeJsonl(jobsPath, jobs.slice(0, WORKER_ACTIVITY_LIMIT));

    const atLimit = readLoopRegistryLiveSnapshot(liveOptions(root));
    const nannyAtLimit = atLimit.details[fixture.routeId]?.workers.find(
      (worker) => worker.tier === "nanny"
    );
    expect(nannyAtLimit?.counts.completed).toBe(WORKER_ACTIVITY_LIMIT);
    expect(nannyAtLimit?.activity).toHaveLength(WORKER_ACTIVITY_LIMIT);

    writeJsonl(jobsPath, jobs);
    const aboveLimit = readLoopRegistryLiveSnapshot(liveOptions(root));
    const nannyAboveLimit = aboveLimit.details[fixture.routeId]?.workers.find(
      (worker) => worker.tier === "nanny"
    );
    expect(nannyAboveLimit?.counts.completed).toBe(WORKER_ACTIVITY_LIMIT + 1);
    expect(nannyAboveLimit?.activity).toHaveLength(WORKER_ACTIVITY_LIMIT);
  });

  test("browser client rejects server failures and malformed DTO versions", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            details: {},
            fleet: { runs: [] },
            source: "harvto-live",
            version: "1",
          }),
          { status: 200 }
        )) as unknown as typeof globalThis.fetch;
      await expect(fetchLiveSnapshot()).rejects.toBeInstanceOf(
        LiveSnapshotError
      );

      globalThis.fetch = (async () =>
        new Response('{"code":"LIVE_DATA_UNAVAILABLE"}', {
          status: 503,
        })) as unknown as typeof globalThis.fetch;
      await expect(fetchLiveSnapshot()).rejects.toMatchObject({ status: 503 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
