import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  probeHarvtoRuntime,
  type RuntimeIdentity,
  readHarvtoLiveSnapshot,
} from "../../src/webui/server/harvto-live-data";

const NOW = new Date("2026-08-21T20:00:00.000Z");
const RAW_SECRET = "secret utility objective must never cross the boundary";
const RAW_MESSAGE = "raw bridge message must never cross the boundary";
const RAW_PATH = "/private/tmp/harvto-sensitive-worktree";
const PRESENT_RUNTIME = {
  label: "Terminal session present; server birth unverified",
  state: "unknown" as const,
};

const liveOptions = (storageRoot: string) => ({
  now: () => NOW,
  runtimeProbe: () => PRESENT_RUNTIME,
  storageRoot,
});

const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");

const writeJsonl = (path: string, values: readonly unknown[]) =>
  writeFileSync(
    path,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8"
  );

const createLane = (): { readonly root: string; readonly runDir: string } => {
  const root = mkdtempSync(join(tmpdir(), "webui-harvto-live-"));
  const repoDir = join(root, HARVTO_REPO_ID);
  const runDir = join(repoDir, "7");
  mkdirSync(join(runDir, "hooks"), { recursive: true });
  mkdirSync(join(runDir, "utility"), { recursive: true });
  writeJson(join(runDir, "manifest.json"), {
    claudeSessionId: "claude-secret-session",
    codexThreadId: "codex-secret-thread",
    createdAt: "2026-08-21T18:00:00.000Z",
    cwd: RAW_PATH,
    driverEffort: "high",
    launchClaimId: "secret-launch-claim",
    pid: 1234,
    primaryAgent: "codex",
    repoId: HARVTO_REPO_ID,
    reviewerEffort: "medium",
    runId: "7",
    state: "submitted",
    status: "running",
    tmuxSession: "harvto-loop-7",
    tmuxSocket: join(root, "private-runtime.sock"),
    updatedAt: "2026-08-21T18:01:00.000Z",
    workspaceBinding: {
      branchRef: "refs/heads/loop222/base",
      repoId: HARVTO_REPO_ID,
      root: RAW_PATH,
    },
  });
  writeJson(join(runDir, "governess-state.json"), {
    bothIdleSince: Date.parse("2026-08-21T18:20:01.000Z"),
    driverLease: {
      epoch: 77,
      expiresAt: "2026-08-21T21:00:00.000Z",
      holder: "codex",
    },
    governessEpoch: 77,
    lifecycleEvents: {
      claude: {
        at: "2026-08-21T18:20:00.000Z",
        evidence: RAW_MESSAGE,
        state: "input-required",
      },
      codex: {
        at: "2026-08-21T18:20:01.000Z",
        evidence: RAW_SECRET,
        state: "input-required",
      },
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
    summary: RAW_SECRET,
    waitingAsk: RAW_MESSAGE,
    waitingConfirmed: true,
  });
  writeJsonl(join(runDir, "hooks", "claude.jsonl"), [
    {
      agent: "claude",
      cwd: RAW_PATH,
      detail: RAW_SECRET,
      event: "Notification",
      sequence: 11,
      state: "input-required",
      ts: "2026-08-21T18:20:00.000Z",
    },
  ]);
  writeJsonl(join(runDir, "hooks", "codex.jsonl"), [
    {
      agent: "codex",
      cwd: RAW_PATH,
      detail: RAW_MESSAGE,
      event: "Stop",
      sequence: 19,
      state: "input-required",
      ts: "2026-08-21T18:20:01.000Z",
    },
  ]);
  writeJsonl(join(runDir, "bridge.jsonl"), [
    {
      at: "2026-08-21T18:19:00.000Z",
      id: "secret-bridge-id",
      kind: "message",
      message: RAW_MESSAGE,
      signature: "secret-signature",
      source: "codex",
      target: "claude",
    },
  ]);
  writeJson(join(runDir, "bridge-reconciliation.json"), {
    lastReason: RAW_SECRET,
    lastReconciledAt: "2026-08-21T19:59:59.000Z",
    pid: 9999,
    schemaVersion: 1,
  });
  writeJsonl(join(runDir, "utility", "jobs.jsonl"), [
    {
      at: "2026-08-21T18:10:00.000Z",
      jobId: "secret-worker-id",
      request: { kind: "inspect", objective: RAW_SECRET },
      state: "pending-route",
    },
    {
      at: "2026-08-21T18:10:01.000Z",
      decision: { reason: RAW_MESSAGE, tierId: "utility-nanny" },
      jobId: "secret-worker-id",
      state: "routed-utility",
    },
    {
      at: "2026-08-21T18:10:02.000Z",
      jobId: "secret-worker-id",
      result: { summary: RAW_SECRET },
      state: "completed",
    },
    {
      at: "2026-08-21T18:11:00.000Z",
      decision: { reason: RAW_MESSAGE, tierId: "utility-nanny" },
      jobId: "secret-escalated-worker-id",
      reason: RAW_SECRET,
      request: { kind: "inspect", objective: RAW_SECRET },
      state: "escalated",
    },
  ]);
  return { root, runDir };
};

const inventory = (root: string): string => {
  const hash = createHash("sha256");
  const visit = (path: string) => {
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

describe("Harvto live Web UI projection", () => {
  test("projects current durable metadata and redacts raw lane content", () => {
    const lane = createLane();
    const before = inventory(lane.root);
    const snapshot = readHarvtoLiveSnapshot(liveOptions(lane.root));
    const after = inventory(lane.root);
    const run = snapshot.fleet.runs[0];

    expect(after).toBe(before);
    expect(isWebUiSnapshot(snapshot)).toBe(true);
    expect(run?.runId).toBe("7");
    expect(run?.lifecycle).toBe("input-required");
    expect(run?.worktree).toBe("Run 7 workspace");
    expect(run?.reasons.map((reason) => reason.code)).toEqual([
      "input-required",
      "active-looking-manifest",
      "audit-partial",
    ]);
    expect(run?.agents.map((agent) => agent.lifecycle)).toEqual([
      "waiting-human",
      "waiting-human",
    ]);
    expect(snapshot.fleet.connection.lastEventAt).toBe(
      "2026-08-21T18:20:01.000Z"
    );
    expect(snapshot.details["7"]?.workers[1]?.counts.completed).toBe(1);
    expect(snapshot.details["7"]?.workers[1]?.counts.escalated).toBe(1);
    expect(snapshot.details["7"]?.workers[1]?.counts.failed).toBe(0);

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      RAW_SECRET,
      RAW_MESSAGE,
      RAW_PATH,
      join(lane.root, "private-runtime.sock"),
      "claude-secret-session",
      "codex-secret-thread",
      "secret-worker-id",
      "secret-escalated-worker-id",
      "secret-bridge-id",
      "secret-signature",
      "secret-launch-claim",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toMatch(/\/(?:Users|private|tmp)\//u);

    const detail = snapshot.details["7"];
    const firstAgent = detail?.agents[0];
    if (!(detail && firstAgent)) {
      throw new Error("expected a projected run detail and first agent");
    }
    const malformedNestedSnapshot = {
      ...snapshot,
      details: {
        ...snapshot.details,
        "7": {
          ...detail,
          agents: [
            {
              ...firstAgent,
              usage: { ...firstAgent.usage, windows: {} },
            },
            ...detail.agents.slice(1),
          ],
        },
      },
    };
    expect(isWebUiSnapshot(malformedNestedSnapshot)).toBe(false);

    const malformedWindowMember = {
      ...snapshot,
      details: {
        ...snapshot.details,
        "7": {
          ...detail,
          agents: [
            {
              ...firstAgent,
              usage: { ...firstAgent.usage, windows: [null] },
            },
            ...detail.agents.slice(1),
          ],
        },
      },
    };
    expect(isWebUiSnapshot(malformedWindowMember)).toBe(false);

    const malformedAuditMember = {
      ...snapshot,
      details: {
        ...snapshot.details,
        "7": {
          ...detail,
          governess: { ...detail.governess, audit: [null] },
        },
      },
    };
    expect(isWebUiSnapshot(malformedAuditMember)).toBe(false);
  });

  test("probes tmux with an exact session target", () => {
    let observedCommand = "";
    let observedArgs: readonly string[] = [];
    const result = probeHarvtoRuntime(
      {
        session: "harvto-loop-7",
        socketPath: "/private/tmp/runtime.sock",
      },
      {
        lstat: () => ({
          isSocket: () => true,
          isSymbolicLink: () => false,
        }),
        spawn: (command, args) => {
          observedCommand = command;
          observedArgs = args;
          return { status: 0, stderr: "" };
        },
      }
    );

    expect(observedCommand).toBe("tmux");
    expect(observedArgs).toEqual([
      "-S",
      "/private/tmp/runtime.sock",
      "has-session",
      "-t",
      "=harvto-loop-7",
    ]);
    expect(result).toEqual(PRESENT_RUNTIME);
  });

  test("probes exact manifest identity and keeps unknown labels fail-closed", () => {
    const lane = createLane();
    const manifestPath = join(lane.runDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeJson(manifestPath, {
      ...manifest,
      driverEffort: "api-key-abc",
    });
    const governessPath = join(lane.runDir, "governess-state.json");
    const governess = JSON.parse(readFileSync(governessPath, "utf8"));
    writeJson(governessPath, {
      ...governess,
      sessionPressure: {
        ...governess.sessionPressure,
        codex: {
          ...governess.sessionPressure.codex,
          model: "api-key-abc",
          phase: "api-key-abc",
        },
      },
    });
    const jobsPath = join(lane.runDir, "utility", "jobs.jsonl");
    const jobs = readFileSync(jobsPath, "utf8").trim().split("\n");
    const firstJob = JSON.parse(jobs[0] ?? "{}");
    jobs[0] = JSON.stringify({
      ...firstJob,
      request: { ...firstJob.request, kind: "api-key-abc" },
    });
    writeFileSync(jobsPath, `${jobs.join("\n")}\n`, "utf8");
    const bridgePath = join(lane.runDir, "bridge.jsonl");
    writeJsonl(bridgePath, [
      {
        at: "2026-08-21T18:19:00.000Z",
        id: "secret-bridge-id",
        kind: "message",
        message: RAW_MESSAGE,
        source: "codex",
        target: "claude",
      },
      {
        at: "2026-08-21T18:19:30.000Z",
        id: "secret-bridge-id",
        kind: "expired",
        reason: RAW_SECRET,
        source: "codex",
        target: "claude",
      },
      {
        at: "2026-08-21T18:19:40.000Z",
        id: "delivery-failed-id",
        kind: "message",
        message: RAW_MESSAGE,
        source: "codex",
        target: "claude",
      },
      {
        at: "2026-08-21T18:19:41.000Z",
        id: "delivery-failed-id",
        kind: "delivery-failed",
        reason: RAW_SECRET,
        source: "codex",
        target: "claude",
      },
      {
        at: "2026-08-21T19:59:58.000Z",
        id: "unknown-bridge-id",
        kind: "api-key-abc",
        source: "codex",
        target: "claude",
      },
    ]);

    let probed: RuntimeIdentity | undefined;
    const snapshot = readHarvtoLiveSnapshot({
      now: () => NOW,
      runtimeProbe: (identity) => {
        probed = identity;
        return { label: "Exact terminal session unavailable", state: "ended" };
      },
      storageRoot: lane.root,
    });
    const detail = snapshot.details["7"];

    expect(probed?.session).toBe("harvto-loop-7");
    expect(probed?.socketPath).toBe(join(lane.root, "private-runtime.sock"));
    expect(snapshot.fleet.connection.lastEventAt).toBe(
      "2026-08-21T18:20:01.000Z"
    );
    expect(detail?.summary.adapters).toEqual([
      {
        kind: "tmux",
        label: "Exact terminal session unavailable",
        lastProbedAt: NOW.toISOString(),
        state: "ended",
      },
    ]);
    expect(detail?.quality.severity).toBe("conflict");
    expect(detail?.agents.map((agent) => agent.lifecycle)).toEqual([
      "stuck",
      "stuck",
    ]);
    expect(detail?.agents[0]?.latestBridgeMessage?.status).toBe("failed");
    expect(detail?.agents[0]?.latestBridgeMessage?.direction).toBe("received");
    expect(detail?.agents[1]?.latestBridgeMessage?.direction).toBe("sent");
    expect(detail?.agents[1]?.reasoningEffort).toBe("unspecified");
    expect(detail?.agents[1]?.model).toBe("Unavailable");
    expect(JSON.stringify(snapshot)).not.toContain("api-key-abc");
  });

  test("fails closed on malformed UTF-8 and identity conflicts", () => {
    const malformed = createLane();
    writeFileSync(
      join(malformed.runDir, "governess-state.json"),
      Buffer.from([0xc3, 0x28])
    );
    expect(() => readHarvtoLiveSnapshot(liveOptions(malformed.root))).toThrow(
      LiveDataUnavailableError
    );

    const mismatch = createLane();
    const manifestPath = join(mismatch.runDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeJson(manifestPath, { ...manifest, repoId: "wrong-lane" });
    expect(() => readHarvtoLiveSnapshot(liveOptions(mismatch.root))).toThrow(
      LiveDataUnavailableError
    );

    const runtimeMismatch = createLane();
    const runtimeManifestPath = join(runtimeMismatch.runDir, "manifest.json");
    const runtimeManifest = JSON.parse(
      readFileSync(runtimeManifestPath, "utf8")
    );
    writeJson(runtimeManifestPath, {
      ...runtimeManifest,
      tmuxSession: "different-session",
    });
    expect(() =>
      readHarvtoLiveSnapshot(liveOptions(runtimeMismatch.root))
    ).toThrow(LiveDataUnavailableError);
  });

  test("allows only same-host read requests and never substitutes fixtures", () => {
    const lane = createLane();
    const options = {
      expectedHost: "127.0.0.1:46327",
      now: () => NOW,
      runtimeProbe: () => PRESENT_RUNTIME,
      storageRoot: lane.root,
    } as const;

    expect(
      handleLiveDataRequest(
        {
          host: "127.0.0.1:46327",
          method: "GET",
          url: "/api/v1/live-snapshot",
        },
        options
      )?.status
    ).toBe(200);
    expect(
      handleLiveDataRequest(
        { host: "evil.example", method: "GET", url: "/api/v1/live-snapshot" },
        options
      )?.status
    ).toBe(403);
    expect(
      handleLiveDataRequest(
        {
          host: "127.0.0.1:46327",
          method: "POST",
          url: "/api/v1/live-snapshot",
        },
        options
      )?.status
    ).toBe(405);
    expect(
      handleLiveDataRequest(
        {
          host: "127.0.0.1:46327",
          method: "GET",
          origin: "http://evil.example",
          url: "/api/v1/live-snapshot",
        },
        options
      )?.status
    ).toBe(403);
    expect(
      handleLiveDataRequest(
        {
          host: "127.0.0.1:46327",
          method: "HEAD",
          url: "/api/v1/live-snapshot",
        },
        options
      )?.body
    ).toBe("");

    writeFileSync(join(lane.runDir, "governess-state.json"), "{", "utf8");
    const failed = handleLiveDataRequest(
      { host: "127.0.0.1:46327", method: "GET", url: "/api/v1/live-snapshot" },
      options
    );
    expect(failed?.status).toBe(503);
    expect(failed?.body).not.toContain("fixture");
  });

  test("browser client rejects server failures and malformed nested DTOs", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            details: {},
            fleet: { runs: [] },
            source: "harvto-live",
            version: "1",
          }),
          { status: 200 }
        );
      await expect(fetchLiveSnapshot()).rejects.toBeInstanceOf(
        LiveSnapshotError
      );

      globalThis.fetch = async () =>
        new Response('{"code":"LIVE_DATA_UNAVAILABLE"}', { status: 503 });
      await expect(fetchLiveSnapshot()).rejects.toMatchObject({ status: 503 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
