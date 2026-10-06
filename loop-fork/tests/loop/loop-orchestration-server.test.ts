import { expect, test } from "bun:test";
import type { BridgeStatus } from "../../src/loop/bridge-store";
import {
  type A2AV2Config,
  type A2AV2EnrollmentOutcome,
  ConfiguredA2AV2SessionEnrollment,
  configuredA2AV2RebindAuthority,
  createOrchestrationSweep,
  enrollConfiguredA2AV2Session,
  parseLoopOrchestrationConfig,
  requireA2AV2Enrollment,
} from "../../src/loop/loop-orchestration-server";
import type { SupervisorSessionDescriptorV2 } from "../../src/loop/supervisor-session-v2";

const config = () => ({
  address: "127.0.0.1:7233",
  buildId: "loop-orchestration.v1",
  grants: [
    {
      from: "supervisor:harvto",
      operations: ["receive"],
      principal: "principal:harvto",
      to: "supervisor:harness",
    },
  ],
  hostname: "127.0.0.1",
  identity: "loop-orchestration@local",
  namespace: "default",
  port: 7321,
  schema: "loop-orchestration-server.v1",
  stateDir: "/private/tmp/loop-orchestration-state",
  supervisors: [
    {
      manifestPath: "/Users/example/.loop/runs/harness/1/manifest.json",
      principal: "principal:harness",
      supervisorId: "supervisor:harness",
      tokenEnv: "LOOP_HARNESS_ORCHESTRATION_TOKEN",
    },
  ],
  taskQueue: "loop-orchestration",
});

test("orchestration config binds loopback routes, grants, and secret environment names", () => {
  expect(parseLoopOrchestrationConfig(config())).toMatchObject({
    hostname: "127.0.0.1",
    supervisors: [
      {
        supervisorId: "supervisor:harness",
        tokenEnv: "LOOP_HARNESS_ORCHESTRATION_TOKEN",
      },
    ],
  });
});

test("orchestration config rejects inline secrets, remote listeners, and unknown grants", () => {
  expect(() =>
    parseLoopOrchestrationConfig({ ...config(), secret: "must-not-persist" })
  ).toThrow("invalid fields");
  expect(() =>
    parseLoopOrchestrationConfig({ ...config(), hostname: "0.0.0.0" })
  ).toThrow("hostname is invalid");
  const invalid = config();
  const [grant] = invalid.grants;
  if (!grant) {
    throw new Error("test fixture grant is missing");
  }
  grant.operations = ["delete"];
  expect(() => parseLoopOrchestrationConfig(invalid)).toThrow(
    "grant operations are invalid"
  );
});

const a2aV2 = (resultArtifacts: unknown[]) => ({
  ...config(),
  a2aV2: {
    databaseUrlEnv: "LOOP_A2A_V2_DATABASE_URL",
    endpointRef: "endpoint:local-a2a",
    policy: {
      claimTimeoutMs: 60_000,
      escalationTimeoutMs: 120_000,
      maxDeliveryAttempts: 3,
      retryDelayMs: 1000,
    },
    principal: "principal:harness",
    recipient: "supervisor:harness",
    resultArtifacts,
    routePath: "/a2a",
    sessionTtlMs: 3_600_000,
    tenant: "tenant:local",
  },
});
const artifact = {
  artifactRef: `artifact://sha256/${"a".repeat(64)}`,
  commit: "b".repeat(40),
  path: "results/accepted.md",
  repositoryRoot: "/Users/example/repo",
};

test("orchestration config refuses a result artifact in the retired shape with the exact migration", () => {
  expect(() => parseLoopOrchestrationConfig(a2aV2([artifact]))).toThrow(
    "orchestration a2aV2 resultArtifacts[0] uses the retired shape {artifactRef, commit, path, repositoryRoot}: add graphWorkflowId and graphTaskId"
  );
});

test("orchestration config refuses a result artifact for a graph no message result can bind to", () => {
  expect(() =>
    parseLoopOrchestrationConfig(
      a2aV2([
        {
          ...artifact,
          graphTaskId: "result-node",
          graphWorkflowId: "task-graph:chosen-by-operator",
        },
      ])
    )
  ).toThrow(
    "orchestration a2aV2 resultArtifacts[0] graphWorkflowId is not a message-derived result graph"
  );
});

test("orchestration config accepts a result artifact bound to a message-derived graph task", () => {
  const graphWorkflowId = `supervisor-result-graph:v2:${"c".repeat(64)}`;
  expect(
    parseLoopOrchestrationConfig(
      a2aV2([{ ...artifact, graphTaskId: "result-node", graphWorkflowId }])
    ).a2aV2?.resultArtifacts
  ).toEqual([{ ...artifact, graphTaskId: "result-node", graphWorkflowId }]);
});

const a2aConfig = (): A2AV2Config => ({
  databaseUrlEnv: "LOOP_A2A_DATABASE_URL",
  endpointRef: "endpoint:codex-app-server",
  policy: {
    claimTimeoutMs: 60_000,
    escalationTimeoutMs: 60_000,
    maxDeliveryAttempts: 3,
    retryDelayMs: 1000,
  },
  principal: "principal:harness",
  recipient: "supervisor:harness",
  routePath: "/a2a/v2",
  sessionTtlMs: 60_000,
  tenant: "tenant:local",
});

const START = Date.parse("2026-10-05T00:00:00.000Z");
const at = (offsetMs: number) => () => new Date(START + offsetMs).toISOString();

const canonical = (value: unknown): string =>
  JSON.stringify(value, Object.keys(value as object).sort());

const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The Postgres session store's contract, in memory: register is insert-or-match,
 * rebind is authority-gated compare-and-set on the revision read. Each call
 * yields between its read and its write so two callers interleave the way two
 * server processes do against one database.
 */
const sessionStore = (config: A2AV2Config) => {
  const rows = new Map<string, SupervisorSessionDescriptorV2>();
  const calls = { current: 0, rebind: 0, register: 0 };
  const authority = configuredA2AV2RebindAuthority(config);
  return {
    calls,
    rows,
    async currentSession(_scope: unknown, recipient: string) {
      calls.current += 1;
      await yieldTurn();
      return rows.get(recipient);
    },
    async registerSession(
      _scope: unknown,
      next: SupervisorSessionDescriptorV2
    ) {
      calls.register += 1;
      await yieldTurn();
      if (!rows.has(next.recipient)) {
        rows.set(next.recipient, next);
      }
      const current = rows.get(next.recipient);
      if (!current || canonical(current) !== canonical(next)) {
        throw new Error(
          "session descriptor conflicts with the current registration"
        );
      }
      return current;
    },
    async rebindSession(
      scope: { principal: string; tenantId: string },
      next: SupervisorSessionDescriptorV2
    ) {
      calls.rebind += 1;
      const current = rows.get(next.recipient);
      if (!current || current.descriptorId !== next.descriptorId) {
        throw new Error("session descriptor is not registered");
      }
      if (next.revision !== current.revision + 1) {
        throw new Error("session rebind revision is stale");
      }
      const decision = authority.decide({ current, next, trustedScope: scope });
      if (!decision.allowed) {
        throw new Error(`session rebind denied: ${decision.reasonCode}`);
      }
      await yieldTurn();
      if (rows.get(next.recipient)?.revision !== current.revision) {
        throw new Error("session rebind lost the current revision");
      }
      rows.set(next.recipient, next);
      return { descriptor: next, receipt: {} as never };
    },
  };
};

const codexSeat = (thread: { id: string }) => ({
  directory: {
    resolve: () => ({ runDir: "/run/harness", target: "codex" as const }),
  },
  status: () =>
    ({
      claudeChannelServer: "",
      claudeSessionId: "",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: thread.id,
    }) as BridgeStatus,
});

test("A2A V2 enrollment renews a live session before it expires", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const seat = codexSeat({ id: "thread-a" });
  const enroll = (offsetMs: number) =>
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(offsetMs),
      service: store,
    });
  await enroll(0);
  await enroll(10_000);
  expect(store.rows.get(config.recipient)?.revision).toBe(1);
  // Inside the last half of its lifetime: renewed now, not refused later.
  await enroll(40_000);
  expect(store.rows.get(config.recipient)).toMatchObject({
    expiresAt: new Date(START + 100_000).toISOString(),
    revision: 2,
    sessionRef: "session:thread-a",
  });
});

test("A2A V2 enrollment rebinds a restarted seat through the governed path", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const thread = { id: "thread-a" };
  const seat = codexSeat(thread);
  await enrollConfiguredA2AV2Session({
    ...seat,
    config,
    now: at(0),
    service: store,
  });
  thread.id = "thread-b";
  await enrollConfiguredA2AV2Session({
    ...seat,
    config,
    now: at(1000),
    service: store,
  });
  expect(store.calls.rebind).toBe(1);
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 2,
    sessionRef: "session:thread-b",
  });
});

test("A2A V2 enrollment losing a rebind race converges instead of failing", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const seat = codexSeat({ id: "thread-a" });
  await enrollConfiguredA2AV2Session({
    ...seat,
    config,
    now: at(0),
    service: store,
  });
  // Two server instances start together after the session expired.
  await Promise.all([
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(61_000),
      service: store,
    }),
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(61_001),
      service: store,
    }),
  ]);
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 2,
    sessionRef: "session:thread-a",
  });
});

test("A2A V2 enrollment losing a first-registration race converges instead of failing", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const seat = codexSeat({ id: "thread-a" });
  await Promise.all([
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(0),
      service: store,
    }),
    enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(1),
      service: store,
    }),
  ]);
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 1,
    sessionRef: "session:thread-a",
  });
});

test("A2A V2 enrollment still fails on a governed rebind denial", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const seat = codexSeat({ id: "thread-a" });
  await enrollConfiguredA2AV2Session({
    ...seat,
    config,
    now: at(0),
    service: store,
  });
  // A different endpoint reference is outside the configured rebind grant.
  await expect(
    enrollConfiguredA2AV2Session({
      ...seat,
      config: { ...config, endpointRef: "endpoint:elsewhere" },
      now: at(1000),
      service: store,
    })
  ).rejects.toThrow("session rebind denied");
  expect(store.rows.get(config.recipient)?.revision).toBe(1);
});

test("A2A V2 enrollment sweep renews before expiry and rebinds a restarted seat", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const thread = { id: "thread-a" };
  const clock = { offsetMs: 0 };
  const enrollment = new ConfiguredA2AV2SessionEnrollment({
    ...codexSeat(thread),
    config,
    now: () => at(clock.offsetMs)(),
    recipients: [config.recipient],
    service: store,
  });
  await enrollment.maintain();
  expect(store.rows.get(config.recipient)?.revision).toBe(1);
  // A quiet sweep reads the seat's bridge status, not the store.
  const reads = store.calls.current;
  clock.offsetMs = 10_000;
  await enrollment.maintain();
  expect(store.calls.current).toBe(reads);
  // The Codex thread restarted: the next sweep rebinds instead of leaving
  // readiness to refuse every delivery as "identity changed".
  thread.id = "thread-b";
  clock.offsetMs = 11_000;
  await enrollment.maintain();
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 2,
    sessionRef: "session:thread-b",
  });
  // Past half its lifetime: renewed before it expires.
  clock.offsetMs = 42_000;
  await enrollment.maintain();
  expect(store.rows.get(config.recipient)).toMatchObject({
    expiresAt: new Date(START + 102_000).toISOString(),
    revision: 3,
    sessionRef: "session:thread-b",
  });
});

test("A2A V2 enrollment sweep reports an unavailable seat and retries it later", async () => {
  const config = a2aConfig();
  const store = sessionStore(config);
  const thread = { id: "" };
  const clock = { offsetMs: 0 };
  const enrollment = new ConfiguredA2AV2SessionEnrollment({
    ...codexSeat(thread),
    config,
    now: () => at(clock.offsetMs)(),
    recipients: [config.recipient],
    service: store,
  });
  const [failed] = await enrollment.maintain();
  expect(failed).toMatchObject({
    recipient: config.recipient,
    state: "failed",
  });
  expect(failed?.state === "failed" && failureText(failed.error)).toBe(
    "configured A2A V2 recipient session is unavailable"
  );
  expect(() => requireA2AV2Enrollment(failed ? [failed] : [])).toThrow(
    "configured A2A V2 recipient session is unavailable"
  );
  thread.id = "thread-a";
  clock.offsetMs = 1000;
  // Inside the retry delay the seat is not re-attempted, and says so.
  expect(await enrollment.maintain()).toEqual([
    { recipient: config.recipient, state: "deferred" },
  ]);
  expect(store.rows.get(config.recipient)).toBeUndefined();
  clock.offsetMs = 5000;
  expect(await enrollment.maintain()).toEqual([
    { recipient: config.recipient, state: "enrolled" },
  ]);
  expect(store.rows.get(config.recipient)).toMatchObject({
    revision: 1,
    sessionRef: "session:thread-a",
  });
  clock.offsetMs = 6000;
  expect(await enrollment.maintain()).toEqual([
    { recipient: config.recipient, state: "unchanged" },
  ]);
});

const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sweepProbe = (
  enrollment?: () => Promise<A2AV2EnrollmentOutcome[]>,
  reconcile: () => Promise<void> = () => Promise.resolve()
) => {
  const calls = { maintain: 0, reconcile: 0 };
  const healthy: boolean[] = [];
  const logs: string[] = [];
  const sweep = createOrchestrationSweep({
    enrollment: enrollment
      ? {
          maintain: () => {
            calls.maintain += 1;
            return enrollment();
          },
        }
      : undefined,
    log: (line) => logs.push(line),
    reconcilers: [
      {
        reconcile: () => {
          calls.reconcile += 1;
          return reconcile();
        },
      },
    ],
    setHealthy: (value) => healthy.push(value),
  });
  return { calls, healthy, logs, sweep };
};

test("orchestration sweep drives enrollment without holding bridge reconciliation behind it", async () => {
  // A hung Postgres call inside enrollment must not stop bridge and mailbox
  // ACK reconciliation, nor be re-entered by the next tick.
  const probe = sweepProbe(
    () => new Promise<A2AV2EnrollmentOutcome[]>(() => undefined)
  );
  await probe.sweep();
  await probe.sweep();
  await probe.sweep();
  expect(probe.calls).toEqual({ maintain: 1, reconcile: 3 });
  expect(probe.healthy).toEqual([true, true, true]);
  expect(probe.logs).toEqual([]);
});

test("orchestration sweep retries enrollment every tick and reports each changed failure once", async () => {
  const seat = "supervisor:harness";
  const peer = "supervisor:harness-peer";
  const down = (recipient: string): A2AV2EnrollmentOutcome => ({
    error: new Error("seat unavailable"),
    recipient,
    state: "failed",
  });
  const passes: A2AV2EnrollmentOutcome[][] = [
    [down(seat), { recipient: peer, state: "enrolled" }],
    [down(seat), { recipient: peer, state: "unchanged" }],
    [
      { recipient: seat, state: "enrolled" },
      { recipient: peer, state: "unchanged" },
    ],
    [down(seat), down(peer)],
    // An unexpected rejection of the pass itself is reported, once.
    [],
  ];
  const probe = sweepProbe(() => {
    const pass = passes.shift();
    return pass ? Promise.resolve(pass) : Promise.reject(new Error("defect"));
  });
  for (let tick = 0; tick < 6; tick += 1) {
    await probe.sweep();
    await yieldTurn();
  }
  expect(probe.calls.maintain).toBe(6);
  expect(probe.logs).toEqual([
    `orchestration A2A V2 session enrollment failed for ${seat}: seat unavailable`,
    `orchestration A2A V2 session enrollment recovered for ${seat}`,
    `orchestration A2A V2 session enrollment failed for ${seat}: seat unavailable`,
    `orchestration A2A V2 session enrollment failed for ${peer}: seat unavailable`,
    "orchestration A2A V2 session enrollment pass failed: defect",
  ]);
  // Enrollment has its own verdict; it does not mark reconciliation down.
  expect(probe.healthy).toEqual([true, true, true, true, true, true]);
});

test("orchestration sweep marks reconciliation down on its own failure and still drives enrollment", async () => {
  const probe = sweepProbe(
    () => Promise.resolve([]),
    () => Promise.reject(new Error("bridge unreadable"))
  );
  await probe.sweep();
  expect(probe.calls).toEqual({ maintain: 1, reconcile: 1 });
  expect(probe.healthy).toEqual([false]);
  expect(probe.logs).toEqual([
    "orchestration bridge reconciliation failed: bridge unreadable",
  ]);
});

test("orchestration sweep reports recovery only after a real enrollment, not while the seat waits out its retry delay", async () => {
  // A stopped seat sits in retry backoff between attempts. A sweep that
  // skips it has not recovered it, so it must not log a recovery and reset
  // the dedupe key (which made a down seat log a false recovery every ~5s).
  const config = a2aConfig();
  const store = sessionStore(config);
  const thread = { id: "" };
  const clock = { offsetMs: 0 };
  const enrollment = new ConfiguredA2AV2SessionEnrollment({
    ...codexSeat(thread),
    config,
    now: () => at(clock.offsetMs)(),
    recipients: [config.recipient],
    service: store,
  });
  let pending: Promise<unknown> = Promise.resolve();
  const logs: string[] = [];
  const sweep = createOrchestrationSweep({
    enrollment: {
      maintain: () => {
        const run = enrollment.maintain();
        pending = run;
        return run;
      },
    } as Pick<ConfiguredA2AV2SessionEnrollment, "maintain">,
    log: (line) => logs.push(line),
    reconcilers: [],
    setHealthy: () => undefined,
  });
  const tick = async (offsetMs: number) => {
    clock.offsetMs = offsetMs;
    await sweep();
    await pending.catch(() => undefined);
    await yieldTurn();
  };
  const failed =
    "orchestration A2A V2 session enrollment failed for supervisor:harness: configured A2A V2 recipient session is unavailable";
  await tick(0);
  // Still down, then back up, but both inside the retry delay: not attempted.
  await tick(1000);
  thread.id = "thread-a";
  await tick(2000);
  expect(store.rows.get(config.recipient)).toBeUndefined();
  expect(logs).toEqual([failed]);
  await tick(5000);
  expect(store.rows.get(config.recipient)?.sessionRef).toBe("session:thread-a");
  await tick(6000);
  expect(logs).toEqual([
    failed,
    "orchestration A2A V2 session enrollment recovered for supervisor:harness",
  ]);
});
