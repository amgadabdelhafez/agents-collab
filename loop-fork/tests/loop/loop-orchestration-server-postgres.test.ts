import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { serve } from "bun";
import { PostgresA2ATaskStore } from "../../src/loop/a2a-postgres-task-store";
import { WORKFLOW_IDS_METADATA_KEY } from "../../src/loop/a2a-supervisor-executor";
import {
  type A2AV2Config,
  configuredA2AV2RebindAuthority,
  enrollConfiguredA2AV2Session,
  runLoopOrchestrationServer,
} from "../../src/loop/loop-orchestration-server";
import { runOrchestrationCommand } from "../../src/loop/orchestration-command";
import { createRunManifest, writeRunManifest } from "../../src/loop/run-state";
import {
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  SupervisorResultGraphKey,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import { SUPERVISOR_MESSAGE_WORKFLOW_TYPE } from "../../src/loop/supervisor-message-workflow";
import {
  deriveSupervisorSessionDescriptorV2Id,
  PostgresSupervisorSessionV2Store,
  type SupervisorSessionDescriptorV2,
} from "../../src/loop/supervisor-session-v2";
import { temporalWorkflow } from "../../src/loop/temporal-workflow";
import { DisposablePostgres } from "../support/disposable-postgres";

// Real PostgreSQL (task-owned Docker container) for the session store, and a
// real local Temporal dev server for the composition proof. Only the seats'
// external processes are absent: their bridge state is the run manifest the
// Loop launcher writes, which these tests write directly.

let postgres: DisposablePostgres;

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
}, 120_000);

afterAll(async () => {
  await postgres?.close();
});

const START = Date.parse("2026-10-05T00:00:00.000Z");
const at = (offsetMs: number) => () => new Date(START + offsetMs).toISOString();

const a2aConfig = (tenant: string): A2AV2Config => ({
  databaseUrlEnv: "LOOP_TEST_A2A_DATABASE_URL",
  endpointRef: "endpoint:codex-app-server",
  policy: {
    claimTimeoutMs: 60_000,
    escalationTimeoutMs: 120_000,
    maxDeliveryAttempts: 3,
    retryDelayMs: 1000,
  },
  principal: "principal:harness",
  recipient: "supervisor:harness",
  routePath: "/a2a/v2",
  sessionTtlMs: 60_000,
  tenant,
});

const scopeOf = (config: A2AV2Config) => ({
  principal: config.principal,
  tenantId: config.tenant,
});

const unusedProvider = {
  ready: () => {
    throw new Error("enrollment must not probe the provider");
  },
};

/** One server process's own connection to the shared session store. */
const connectStore = async (
  config: A2AV2Config,
  authority: Parameters<
    typeof PostgresSupervisorSessionV2Store.connect
  >[0]["authority"] = configuredA2AV2RebindAuthority(config)
) => {
  const store = await PostgresSupervisorSessionV2Store.connect({
    authority,
    databaseUrl: postgres.databaseUrl(),
    now: at(0),
    provider: unusedProvider,
  });
  await store.migrate();
  return store;
};

/** The governed port enrollment uses, recording each rejected rebind. */
const portOf = (
  store: PostgresSupervisorSessionV2Store,
  hooks: { afterCurrent?: () => Promise<void> } = {}
) => {
  const rebindErrors: string[] = [];
  let reads = 0;
  return {
    rebindErrors,
    service: {
      async currentSession(
        scope: { principal: string; tenantId: string },
        recipient: string
      ) {
        const current = await store.current(scope, recipient);
        reads += 1;
        if (reads === 1) {
          await hooks.afterCurrent?.();
        }
        return current;
      },
      registerSession: (
        scope: { principal: string; tenantId: string },
        descriptor: SupervisorSessionDescriptorV2
      ) => store.register(scope, descriptor),
      async rebindSession(
        scope: { principal: string; tenantId: string },
        descriptor: SupervisorSessionDescriptorV2
      ) {
        try {
          return await store.rebind(scope, descriptor);
        } catch (error) {
          rebindErrors.push(
            error instanceof Error ? error.message : String(error)
          );
          throw error;
        }
      },
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
    }) as never,
});

const tenant = () => `tenant:race-${randomUUID().slice(0, 8)}`;

test("PostgreSQL: two enrollers registering one seat at once converge on one descriptor", async () => {
  const config = a2aConfig(tenant());
  const [left, right] = [
    await connectStore(config),
    await connectStore(config),
  ];
  try {
    const seat = codexSeat({ id: "thread-a" });
    const [a, b] = await Promise.all([
      enrollConfiguredA2AV2Session({
        ...seat,
        config,
        now: at(0),
        service: portOf(left).service,
      }),
      enrollConfiguredA2AV2Session({
        ...seat,
        config,
        now: at(1),
        service: portOf(right).service,
      }),
    ]);
    const stored = await left.current(scopeOf(config), config.recipient);
    expect(stored).toMatchObject({
      revision: 1,
      sessionRef: "session:thread-a",
    });
    expect(a).toEqual(stored as SupervisorSessionDescriptorV2);
    expect(b).toEqual(stored as SupervisorSessionDescriptorV2);
  } finally {
    await left.close();
    await right.close();
  }
});

test("PostgreSQL: two enrollers renewing an expired seat at once converge on one revision", async () => {
  const config = a2aConfig(tenant());
  const [left, right] = [
    await connectStore(config),
    await connectStore(config),
  ];
  try {
    const seat = codexSeat({ id: "thread-a" });
    await enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(0),
      service: portOf(left).service,
    });
    const leftPort = portOf(left);
    const rightPort = portOf(right);
    const [a, b] = await Promise.all([
      enrollConfiguredA2AV2Session({
        ...seat,
        config,
        now: at(61_000),
        service: leftPort.service,
      }),
      enrollConfiguredA2AV2Session({
        ...seat,
        config,
        now: at(61_001),
        service: rightPort.service,
      }),
    ]);
    const stored = await left.current(scopeOf(config), config.recipient);
    expect(stored?.revision).toBe(2);
    expect(a).toEqual(stored as SupervisorSessionDescriptorV2);
    expect(b).toEqual(stored as SupervisorSessionDescriptorV2);
    // Exactly one write won; the other lost it in the store and converged.
    expect([...leftPort.rebindErrors, ...rightPort.rebindErrors]).toHaveLength(
      1
    );
  } finally {
    await left.close();
    await right.close();
  }
});

test("PostgreSQL: an enroller whose read went stale converges on the winner's rebind", async () => {
  const config = a2aConfig(tenant());
  const [left, right] = [
    await connectStore(config),
    await connectStore(config),
  ];
  try {
    const seat = codexSeat({ id: "thread-a" });
    await enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(0),
      service: portOf(left).service,
    });
    // Between this enroller's read and its write, another instance rebinds.
    let winner: SupervisorSessionDescriptorV2 | undefined;
    const late = portOf(left, {
      afterCurrent: async () => {
        winner = await enrollConfiguredA2AV2Session({
          ...seat,
          config,
          now: at(61_000),
          service: portOf(right).service,
        });
      },
    });
    const result = await enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(61_001),
      service: late.service,
    });
    expect(late.rebindErrors).toEqual(["session rebind revision is stale"]);
    expect(winner?.revision).toBe(2);
    expect(result).toEqual(winner as SupervisorSessionDescriptorV2);
    expect(await left.current(scopeOf(config), config.recipient)).toEqual(
      winner
    );
  } finally {
    await left.close();
    await right.close();
  }
});

test("PostgreSQL: an enroller that loses the revision inside its rebind converges on the winner", async () => {
  const config = a2aConfig(tenant());
  const plain = configuredA2AV2RebindAuthority(config);
  const right = await connectStore(config);
  let winner: SupervisorSessionDescriptorV2 | undefined;
  let decisions = 0;
  const seat = codexSeat({ id: "thread-a" });
  // The store reads the revision, asks authority, then updates. Another
  // instance's rebind lands while authority is deciding, so this update finds
  // the revision moved underneath it.
  const left = await connectStore(config, {
    async decide(input) {
      decisions += 1;
      if (decisions === 1) {
        winner = await enrollConfiguredA2AV2Session({
          ...seat,
          config,
          now: at(61_000),
          service: portOf(right).service,
        });
      }
      return plain.decide(input);
    },
  });
  try {
    await enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(0),
      service: portOf(right).service,
    });
    const losing = portOf(left);
    const result = await enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(61_001),
      service: losing.service,
    });
    expect(losing.rebindErrors).toEqual([
      "session rebind lost the current revision",
    ]);
    expect(winner?.revision).toBe(2);
    expect(result).toEqual(winner as SupervisorSessionDescriptorV2);
    expect(await right.current(scopeOf(config), config.recipient)).toEqual(
      winner
    );
  } finally {
    await left.close();
    await right.close();
  }
});

test("PostgreSQL: a governed rebind denial still fails enrollment", async () => {
  const config = a2aConfig(tenant());
  const store = await connectStore(config);
  try {
    const seat = codexSeat({ id: "thread-a" });
    await enrollConfiguredA2AV2Session({
      ...seat,
      config,
      now: at(0),
      service: portOf(store).service,
    });
    await expect(
      enrollConfiguredA2AV2Session({
        ...seat,
        config: { ...config, endpointRef: "endpoint:elsewhere" },
        now: at(1000),
        service: portOf(store).service,
      })
    ).rejects.toThrow("session rebind denied");
    expect(
      (await store.current(scopeOf(config), config.recipient))?.revision
    ).toBe(1);
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// The production composition: runLoopOrchestrationServer itself.

const freePort = (): number => {
  const probe = serve({
    fetch: () => new Response(null),
    hostname: "127.0.0.1",
    port: 0,
  });
  const port = probe.port;
  probe.stop(true);
  if (!port) {
    throw new Error("no free loopback port");
  }
  return port;
};

const waitFor = async <T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await probe();
    if (last !== undefined) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const PEER = "supervisor:harness-peer";

const compositionFixture = (input: {
  address: string;
  /** Extra a2aV2 config fields and the environment they name. */
  a2aExtra?: Record<string, unknown>;
  envExtra?: Record<string, string>;
  /** Also configure the run's Claude seat as a peer recipient. */
  peer?: boolean;
  readinessOutageBoundMs?: number;
  /** The deployment (task queue); a fresh one unless the test derives ids
   * for it before the config exists. */
  taskQueue?: string;
  tenant: string;
  thread: string;
}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loop-orch-compose-")));
  const runDir = join(root, "run");
  const manifestPath = join(runDir, "manifest.json");
  const writeSeat = (thread: string, claudeSessionId = "") =>
    writeRunManifest(
      manifestPath,
      createRunManifest(
        {
          claudeSessionId,
          codexRemoteUrl: "ws://127.0.0.1:4500",
          codexThreadId: thread,
          cwd: root,
          mode: "paired",
          pid: process.pid,
          primaryAgent: "codex",
          repoId: "repo-compose",
          runId: "1",
          state: "working",
          tmuxPaneLeft: "%1",
          tmuxPaneLeftAgent: "claude",
          tmuxPaneRight: "%2",
          tmuxPaneRightAgent: "codex",
        },
        "2026-10-05T00:00:00.000Z"
      )
    );
  writeSeat(input.thread);
  const port = freePort();
  const taskQueue =
    input.taskQueue ?? `orchestration-composition-${randomUUID().slice(0, 8)}`;
  const configPath = join(root, "orchestration.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      a2aV2: {
        databaseUrlEnv: "LOOP_TEST_A2A_DATABASE_URL",
        endpointRef: "endpoint:codex-app-server",
        policy: {
          claimTimeoutMs: 60_000,
          escalationTimeoutMs: 120_000,
          maxDeliveryAttempts: 3,
          retryDelayMs: 1000,
        },
        principal: "principal:harness",
        ...(input.readinessOutageBoundMs === undefined
          ? {}
          : { readinessOutageBoundMs: input.readinessOutageBoundMs }),
        recipient: "supervisor:harness",
        routePath: "/a2a/v2",
        sessionTtlMs: 60_000,
        tenant: input.tenant,
        ...input.a2aExtra,
      },
      address: input.address,
      buildId: "orchestration-composition.v1",
      grants: [
        {
          from: "supervisor:sender",
          operations: ["receive"],
          principal: "principal:harness",
          to: "supervisor:harness",
        },
      ],
      hostname: "127.0.0.1",
      identity: "orchestration-composition",
      namespace: "default",
      port,
      schema: "loop-orchestration-server.v1",
      stateDir: join(root, "state"),
      supervisors: [
        {
          manifestPath,
          principal: "principal:harness",
          seat: "codex",
          supervisorId: "supervisor:harness",
          tokenEnv: "LOOP_TEST_HARNESS_TOKEN",
        },
        ...(input.peer
          ? [
              {
                manifestPath,
                principal: "principal:harness",
                seat: "claude",
                supervisorId: PEER,
                tokenEnv: "LOOP_TEST_PEER_TOKEN",
              },
            ]
          : []),
      ],
      taskQueue,
    })
  );
  return {
    configPath,
    taskQueue,
    env: {
      LOOP_TEST_A2A_DATABASE_URL: postgres.databaseUrl(),
      LOOP_TEST_HARNESS_TOKEN: randomUUID(),
      LOOP_TEST_PEER_TOKEN: randomUUID(),
      ...input.envExtra,
    } as Record<string, string>,
    port,
    remove: () => rmSync(root, { force: true, recursive: true }),
    writeSeat,
  };
};

const sessionDescriptor = (
  config: A2AV2Config,
  input: { expiresAt: string; issuedAt: string; thread: string }
): SupervisorSessionDescriptorV2 => ({
  descriptorId: deriveSupervisorSessionDescriptorV2Id(
    scopeOf(config),
    config.recipient
  ),
  endpointDigest: createHash("sha256")
    .update("ws://127.0.0.1:4500")
    .digest("hex"),
  endpointRef: config.endpointRef,
  expiresAt: input.expiresAt,
  issuedAt: input.issuedAt,
  principal: config.principal,
  provider: "codex-app-server",
  recipient: config.recipient,
  revision: 1,
  schema: "supervisor-session-descriptor.v2",
  sessionRef: `session:${input.thread}`,
  tenantId: config.tenant,
});

/** The server's /healthz body. */
const health = async (fixture: { port: number }): Promise<unknown> =>
  (await fetch(`http://127.0.0.1:${fixture.port}/healthz`)).json();

/** Runs the real server; `ready` is "ready" or why it never got there. */
const startServer = (
  fixture: ReturnType<typeof compositionFixture>,
  signal: AbortSignal
) => {
  const running = runLoopOrchestrationServer(fixture.configPath, fixture.env, {
    signal,
  });
  const failed = running.then(
    () => "server stopped before it became ready",
    (error: unknown) =>
      `server failed: ${error instanceof Error ? error.message : String(error)}`
  );
  const ready = Promise.race([
    failed,
    waitFor("the server to report ready", async () => {
      const response = await fetch(
        `http://127.0.0.1:${fixture.port}/healthz`
      ).catch(() => undefined);
      const body = (await response?.json().catch(() => undefined)) as
        | { state?: string }
        | undefined;
      return body?.state === "ready" ? "ready" : undefined;
    }),
  ]);
  return { ready, running };
};

let temporal: TestWorkflowEnvironment | undefined;
const temporalEnvironment = async (): Promise<TestWorkflowEnvironment> => {
  temporal ??= await TestWorkflowEnvironment.createLocal();
  return temporal;
};

afterAll(async () => {
  await temporal?.teardown();
});

test("the orchestration server enrolls at start and keeps the enrollment current through its sweep", async () => {
  const environment = await temporalEnvironment();
  const config = a2aConfig(tenant());
  const fixture = compositionFixture({
    address: environment.address,
    tenant: config.tenant,
    thread: "thread-a",
  });
  const admin = await connectStore(config);
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    // A descriptor left by an earlier server run, expired while it was down,
    // naming a Codex thread that has since been replaced.
    await admin.register(
      scopeOf(config),
      sessionDescriptor(config, {
        expiresAt: "2026-01-01T00:01:00.000Z",
        issuedAt: "2026-01-01T00:00:00.000Z",
        thread: "thread-old",
      })
    );
    const started = startServer(fixture, stop.signal);
    running = started.running;
    expect(await started.ready).toBe("ready");
    // Start-time enrollment (before the host's recovery sweep) rebound the
    // stale descriptor to the live thread.
    expect(
      await admin.current(scopeOf(config), config.recipient)
    ).toMatchObject({
      revision: 2,
      sessionRef: "session:thread-a",
    });
    // The Codex thread restarts while the server runs: the server's own
    // reconciliation sweep rebinds it, with no restart and no client call.
    fixture.writeSeat("thread-b");
    const rebound = await waitFor("the sweep to rebind", async () => {
      const current = await admin.current(scopeOf(config), config.recipient);
      return current?.sessionRef === "session:thread-b" ? current : undefined;
    });
    expect(rebound.revision).toBe(3);
  } finally {
    stop.abort();
    await running?.catch(() => undefined);
    await admin.close();
    fixture.remove();
  }
}, 120_000);

test("the orchestration server refuses to start when a configured seat cannot be enrolled", async () => {
  const environment = await temporalEnvironment();
  const config = a2aConfig(tenant());
  // No Codex thread in the run manifest: the seat's session is unavailable.
  const fixture = compositionFixture({
    address: environment.address,
    tenant: config.tenant,
    thread: "",
  });
  const admin = await connectStore(config);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 30_000);
  try {
    const outcome = await runLoopOrchestrationServer(
      fixture.configPath,
      fixture.env,
      { signal: stop.signal }
    ).then(
      () => "started",
      (error: unknown) => (error instanceof Error ? error.message : "")
    );
    expect(outcome).toBe("configured A2A V2 recipient session is unavailable");
    expect(
      await admin.current(scopeOf(config), config.recipient)
    ).toBeUndefined();
  } finally {
    clearTimeout(timer);
    stop.abort();
    await admin.close();
    fixture.remove();
  }
}, 120_000);

test("the orchestration server starts with a stopped peer seat, reports it not enrolled, and enrolls it from the sweep", async () => {
  const environment = await temporalEnvironment();
  const config = a2aConfig(tenant());
  // The Codex recipient is live; the Claude peer seat has no session yet.
  const fixture = compositionFixture({
    address: environment.address,
    peer: true,
    tenant: config.tenant,
    thread: "thread-a",
  });
  const admin = await connectStore(config);
  const errors = spyOn(console, "error");
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const started = startServer(fixture, stop.signal);
    running = started.running;
    expect(await started.ready).toBe("ready");
    expect(
      await admin.current(scopeOf(config), config.recipient)
    ).toMatchObject({ revision: 1, sessionRef: "session:thread-a" });
    expect(await admin.current(scopeOf(config), PEER)).toBeUndefined();
    const lines = () => errors.mock.calls.map(([line]) => String(line));
    expect(lines()).toContain(
      `orchestration A2A V2 session enrollment failed for ${PEER}: configured A2A V2 recipient session is unavailable`
    );
    // /healthz stays ready for the live recipient and names the peer.
    expect(await health(fixture)).toEqual({
      // The readiness-outage counters (decision 8) sit beside notEnrolled.
      a2aV2ReadinessOutage: {
        boundMs: 900_000,
        deferredDeliveries: 0,
        outageFailures: 0,
        recipientsDeferred: 0,
      },
      notEnrolled: [PEER],
      schema: "loop-orchestration-health.v1",
      state: "ready",
    });
    // The peer's Claude session comes up while the server runs: the existing
    // reconciliation sweep enrolls it after its retry delay, no restart.
    fixture.writeSeat("thread-a", "claude-peer-session");
    const enrolled = await waitFor("the sweep to enroll the peer", async () => {
      const current = await admin.current(scopeOf(config), PEER);
      return current ? current : undefined;
    });
    expect(enrolled).toMatchObject({
      provider: "claude-code",
      revision: 1,
      sessionRef: "session:claude-peer-session",
    });
    await waitFor("the recovery line", () =>
      Promise.resolve(
        lines().includes(
          `orchestration A2A V2 session enrollment recovered for ${PEER}`
        )
          ? true
          : undefined
      )
    );
    expect(await health(fixture)).toEqual({
      // The readiness-outage counters (decision 8) sit beside notEnrolled.
      a2aV2ReadinessOutage: {
        boundMs: 900_000,
        deferredDeliveries: 0,
        outageFailures: 0,
        recipientsDeferred: 0,
      },
      notEnrolled: [],
      schema: "loop-orchestration-health.v1",
      state: "ready",
    });
  } finally {
    stop.abort();
    await running?.catch(() => undefined);
    errors.mockRestore();
    await admin.close();
    fixture.remove();
  }
}, 120_000);

test("a V2 delivery pending for a stopped peer at start neither refuses start nor reaches the provider: it spends one attempt on the readiness refusal", async () => {
  const environment = await temporalEnvironment();
  const config = a2aConfig(tenant());
  const fixture = compositionFixture({
    address: environment.address,
    peer: true,
    tenant: config.tenant,
    thread: "thread-a",
  });
  const [fixtureV2] = supervisorMessageV2ReplayFixtures;
  if (!fixtureV2) {
    throw new Error("missing V2 fixture");
  }
  const scope = scopeOf(config);
  const dedupeKey = `peer-pending-${randomUUID().slice(0, 8)}`;
  // The server's ledger mints ids for its deployment, its task queue.
  const workflowId = deriveSupervisorMessageV2WorkflowId(
    scope,
    dedupeKey,
    fixture.taskQueue
  );
  const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    postgres.databaseUrl(),
    { deployment: fixture.taskQueue }
  );
  const errors = spyOn(console, "error");
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    await ledger.migrate();
    // Accepted for the peer while the server was down; still pending.
    await ledger.recordStartIntent(workflowId, scope, {
      ...structuredClone(fixtureV2.input),
      dedupeKey,
      from: "supervisor:sender",
      messageId: `message-${dedupeKey}`,
      policy: {
        claimTimeoutMs: 60_000,
        escalationTimeoutMs: 120_000,
        maxDeliveryAttempts: 3,
        // Long enough that only start-time recovery attempts it here.
        retryDelayMs: 600_000,
      },
      principal: scope.principal,
      receivedAt: new Date().toISOString(),
      tenantId: scope.tenantId,
      threadId: `thread-${dedupeKey}`,
      to: PEER,
    });
    const started = startServer(fixture, stop.signal);
    running = started.running;
    expect(await started.ready).toBe("ready");
    const status = await waitFor("the start-time attempt", async () => {
      const result = (await environment.client.workflow
        .getHandle(workflowId)
        .query("workflow-port-query", "status", { trustedScope: scope })
        .catch(() => undefined)) as
        | { value?: { deliveryAttempts?: number } }
        | undefined;
      return (result?.value?.deliveryAttempts ?? 0) >= 1
        ? result?.value
        : undefined;
    });
    expect(status).toMatchObject({
      deadLetteredAt: null,
      deliveredAt: null,
      deliveryAttempts: 1,
      phase: "retry-scheduled",
      to: PEER,
    });
    // The record was recovered, not skipped: no recovery failure for it.
    expect(
      errors.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes(workflowId))
    ).toEqual([]);
    expect(await health(fixture)).toMatchObject({ notEnrolled: [PEER] });
  } finally {
    stop.abort();
    await running?.catch(() => undefined);
    errors.mockRestore();
    await environment.client.workflow
      .getHandle(workflowId)
      .terminate()
      .catch(() => undefined);
    await ledger.close();
    fixture.remove();
  }
}, 120_000);

test("the orchestration server starts when a recorded V2 workflow ID is held by a foreign execution", async () => {
  const environment = await temporalEnvironment();
  const config = a2aConfig(tenant());
  const fixture = compositionFixture({
    address: environment.address,
    tenant: config.tenant,
    thread: "thread-a",
  });
  const [fixtureV2] = supervisorMessageV2ReplayFixtures;
  if (!fixtureV2) {
    throw new Error("missing V2 fixture");
  }
  const v2Scope = fixtureV2.expectedScope;
  const dedupeKey = `foreign-${randomUUID().slice(0, 8)}`;
  // The server's ledger mints ids for its deployment, its task queue.
  const workflowId = deriveSupervisorMessageV2WorkflowId(
    v2Scope,
    dedupeKey,
    fixture.taskQueue
  );
  const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    postgres.databaseUrl(),
    { deployment: fixture.taskQueue }
  );
  const errors = spyOn(console, "error");
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    await ledger.migrate();
    // This deployment recorded a V2 start intent for the ID...
    await ledger.recordStartIntent(workflowId, v2Scope, {
      ...structuredClone(fixtureV2.input),
      dedupeKey,
    });
    // ...but the ID is already held in the namespace by another deployment's
    // execution, on its own task queue.
    await environment.client.workflow.start(temporalWorkflow, {
      args: [
        {
          at: "2026-10-05T00:00:00.000Z",
          input: {
            artifactRefs: [],
            body: "foreign execution",
            dedupeKey,
            from: "supervisor:source",
            messageId: `message-${dedupeKey}`,
            policy: {
              claimTimeoutMs: 60_000,
              escalationTimeoutMs: 120_000,
              maxDeliveryAttempts: 2,
              retryDelayMs: 500,
            },
            receivedAt: "2026-10-05T00:00:00.000Z",
            threadId: `thread-${dedupeKey}`,
            to: "supervisor:target",
          },
          requestId: "foreign:start",
          workflowId,
          workflowType: SUPERVISOR_MESSAGE_WORKFLOW_TYPE,
        },
      ],
      taskQueue: `${fixture.taskQueue}-foreign`,
      workflowId,
    });
    const started = startServer(fixture, stop.signal);
    running = started.running;
    expect(await started.ready).toBe("ready");
    expect(errors.mock.calls.map(([line]) => String(line))).toContain(
      `V2 recovery skipped workflow ${workflowId} for ${fixtureV2.input.to}: WorkflowError (conflict): workflow ${workflowId} belongs to another task queue`
    );
  } finally {
    stop.abort();
    await running?.catch(() => undefined);
    errors.mockRestore();
    await environment.client.workflow
      .getHandle(workflowId)
      .terminate()
      .catch(() => undefined);
    await ledger.close();
    fixture.remove();
  }
}, 120_000);

test("the orchestration server refuses to start while its own queue holds another workflow type under a recorded V2 id, names the quarantine command, and starts once an operator quarantines it", async () => {
  const environment = await temporalEnvironment();
  const config = a2aConfig(tenant());
  const fixture = compositionFixture({
    address: environment.address,
    tenant: config.tenant,
    thread: "thread-a",
  });
  const [fixtureV2] = supervisorMessageV2ReplayFixtures;
  if (!fixtureV2) {
    throw new Error("missing V2 fixture");
  }
  // Recorded in the route's own scope, so its status surface lists it.
  const v2Scope = scopeOf(config);
  const dedupeKey = `same-queue-${randomUUID().slice(0, 8)}`;
  const workflowId = deriveSupervisorMessageV2WorkflowId(
    v2Scope,
    dedupeKey,
    fixture.taskQueue
  );
  const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    postgres.databaseUrl(),
    { deployment: fixture.taskQueue }
  );
  const errors = spyOn(console, "error");
  const lines = () => errors.mock.calls.map(([line]) => String(line));
  const refusedStop = new AbortController();
  let refusedRun: Promise<void> | undefined;
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    await ledger.migrate();
    await ledger.recordStartIntent(workflowId, v2Scope, {
      ...structuredClone(fixtureV2.input),
      dedupeKey,
      principal: v2Scope.principal,
      tenantId: v2Scope.tenantId,
    });
    // This deployment's own queue holds the id, as another workflow type.
    await environment.client.workflow.start(temporalWorkflow, {
      args: [
        {
          at: "2026-10-05T00:00:00.000Z",
          input: {
            artifactRefs: [],
            body: "another workflow type under a message id",
            dedupeKey,
            from: "supervisor:source",
            messageId: `message-${dedupeKey}`,
            policy: {
              claimTimeoutMs: 60_000,
              escalationTimeoutMs: 120_000,
              maxDeliveryAttempts: 2,
              retryDelayMs: 500,
            },
            receivedAt: "2026-10-05T00:00:00.000Z",
            threadId: `thread-${dedupeKey}`,
            to: "supervisor:target",
          },
          requestId: "same-queue:start",
          workflowId,
          workflowType: SUPERVISOR_MESSAGE_WORKFLOW_TYPE,
        },
      ],
      taskQueue: fixture.taskQueue,
      workflowId,
    });

    const refused = startServer(fixture, refusedStop.signal);
    refusedRun = refused.running;
    expect(await refused.ready).toBe(
      "server failed: Supervisor A2A V2 service initialization failed at runtime-host (SupervisorMessageV2RecoveryStartupError)"
    );
    expect(lines()).toContain(
      `V2 initial recovery failed for 1 recorded start: workflow ${workflowId} for ${fixtureV2.input.to}: WorkflowError (conflict): workflow ${workflowId} already exists as ${SUPERVISOR_MESSAGE_WORKFLOW_TYPE} [to start without it: loop orchestration v2-quarantine ${fixture.configPath} ${workflowId} --reason '<why>']`
    );

    // The operator runs the named command.
    const printed: string[] = [];
    await runOrchestrationCommand(
      [
        "orchestration",
        "v2-quarantine",
        fixture.configPath,
        workflowId,
        "--reason",
        "V1 execution under a V2 id",
        "--by",
        "operator-test",
      ],
      () => {
        throw new Error("the server must not start");
      },
      { env: fixture.env, write: (text) => printed.push(text) }
    );
    expect(printed).toHaveLength(1);
    const [entry] = await ledger.recoveryQuarantines();
    if (!entry) {
      throw new Error("the quarantine was not recorded");
    }
    // Another tenant's quarantined record of this deployment: logged at
    // start, but never listed on this route's tenant-scoped status surface.
    const elsewhere = { principal: v2Scope.principal, tenantId: tenant() };
    const elsewhereKey = `elsewhere-${randomUUID().slice(0, 8)}`;
    const elsewhereId = deriveSupervisorMessageV2WorkflowId(
      elsewhere,
      elsewhereKey,
      fixture.taskQueue
    );
    await ledger.recordStartIntent(elsewhereId, elsewhere, {
      ...structuredClone(fixtureV2.input),
      dedupeKey: elsewhereKey,
      principal: elsewhere.principal,
      tenantId: elsewhere.tenantId,
    });
    await ledger.quarantineRecovery(elsewhereId, {
      by: "operator-test",
      reason: "another tenant's hold",
    });

    const started = startServer(fixture, stop.signal);
    running = started.running;
    expect(await started.ready).toBe("ready");
    expect(lines()).toContain(
      `V2 recovery QUARANTINED workflow ${workflowId} for ${fixtureV2.input.to}: skipped until released (quarantined by operator-test at ${entry.at}: V1 execution under a V2 id); release it with: loop orchestration v2-quarantine-release ${fixture.configPath} ${workflowId} --reason '<why>'`
    );
    // Reported on the authenticated status surface only.
    const status = await fetch(
      `http://127.0.0.1:${fixture.port}/a2a/v2/assignment`,
      {
        headers: {
          authorization: `Bearer ${fixture.env.LOOP_TEST_HARNESS_TOKEN}`,
        },
      }
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      recoveryQuarantine: [
        {
          at: entry.at,
          by: "operator-test",
          reason: "V1 execution under a V2 id",
          recipient: fixtureV2.input.to,
          workflowId,
        },
      ],
      schema: "supervisor-result-assignment-status.v1",
      unpublishable: [],
    });
    const anonymous = await fetch(
      `http://127.0.0.1:${fixture.port}/a2a/v2/assignment`
    );
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(await health(fixture))).not.toContain(workflowId);
  } finally {
    refusedStop.abort();
    await refusedRun?.catch(() => undefined);
    stop.abort();
    await running?.catch(() => undefined);
    errors.mockRestore();
    await environment.client.workflow
      .getHandle(workflowId)
      .terminate()
      .catch(() => undefined);
    await ledger.close();
    fixture.remove();
  }
}, 120_000);

test("the orchestration server starts a message's result graph under its keyed id and binds it only through the configured graph tasks", async () => {
  const environment = await temporalEnvironment();
  const config = a2aConfig(tenant());
  const scope = scopeOf(config);
  const [fixtureV2] = supervisorMessageV2ReplayFixtures;
  if (!fixtureV2) {
    throw new Error("missing V2 fixture");
  }
  const dedupeKey = `keyed-${randomUUID().slice(0, 8)}`;
  // The server mints message ids for its deployment, its task queue.
  const taskQueue = `orchestration-composition-${randomUUID().slice(0, 8)}`;
  const messageWorkflowId = deriveSupervisorMessageV2WorkflowId(
    scope,
    dedupeKey,
    taskQueue
  );
  // A throwaway host secret, passed only through the environment.
  const secret = randomBytes(32).toString("hex");
  const graphWorkflowId = deriveSupervisorMessageV2ResultGraphWorkflowId(
    SupervisorResultGraphKey.fromSecret(secret),
    scope,
    messageWorkflowId
  );
  const fixture = compositionFixture({
    address: environment.address,
    a2aExtra: {
      resultArtifacts: [
        {
          artifactRef: `artifact://sha256/${"e".repeat(64)}`,
          commit: "b".repeat(40),
          graphTaskId: "result-node",
          graphWorkflowId,
          path: "results/accepted.md",
          repositoryRoot: "/nonexistent/repository",
        },
      ],
      resultGraphKeyEnv: "LOOP_TEST_RESULT_GRAPH_KEY",
    },
    envExtra: { LOOP_TEST_RESULT_GRAPH_KEY: secret },
    taskQueue,
    tenant: config.tenant,
    thread: "thread-a",
  });
  const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    postgres.databaseUrl(),
    { deployment: taskQueue }
  );
  const tasks = await PostgresA2ATaskStore.connect({
    databaseUrl: postgres.databaseUrl(),
  });
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    // The operator tool computes, from the same config and environment, the
    // id this server derives.
    const printed: string[] = [];
    await runOrchestrationCommand(
      [
        "orchestration",
        "result-graph-id",
        fixture.configPath,
        messageWorkflowId,
      ],
      () => Promise.reject(new Error("must not start the server")),
      {
        env: fixture.env,
        write: (text) => printed.push(text),
      }
    );
    expect(printed).toEqual([`${graphWorkflowId}\n`]);
    await ledger.migrate();
    await tasks.migrate();
    // A message this route's scope sent, already acknowledged by its
    // recipient (so recovery leaves it alone), and its A2A task.
    await ledger.recordStartIntent(messageWorkflowId, scope, {
      ...structuredClone(fixtureV2.input),
      dedupeKey,
      messageId: `message-${dedupeKey}`,
      principal: scope.principal,
      tenantId: scope.tenantId,
      threadId: `thread-${dedupeKey}`,
      to: "supervisor:target",
    });
    await ledger.recordTerminalOutcome(
      messageWorkflowId,
      scope,
      "acknowledged"
    );
    await tasks.save(
      {
        id: "task:keyed-server",
        contextId: "context:keyed-server",
        history: [],
        artifacts: [],
        metadata: { [WORKFLOW_IDS_METADATA_KEY]: [messageWorkflowId] },
        status: {
          state: TaskState.TASK_STATE_WORKING,
          timestamp: "2026-10-05T00:00:00.000Z",
          message: undefined,
        },
      },
      new ServerCallContext({
        tenant: scope.tenantId,
        user: { isAuthenticated: true, userName: scope.principal },
      })
    );
    const started = startServer(fixture, stop.signal);
    running = started.running;
    expect(await started.ready).toBe("ready");
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${fixture.port}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.env.LOOP_TEST_HARNESS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const graphInput = {
      schema: "task-graph.v1",
      graphId: "keyed-server-proof",
      nodes: [
        {
          taskId: "result-node",
          acceptanceChecks: [{ checkId: "artifact", kind: "artifact" }],
          authorityGates: [],
          dependencies: [],
          ownerRepository: "agents-collab",
          readScopes: ["src"],
          writeScopes: [],
          specArtifactRef: `artifact://sha256/${"e".repeat(64)}`,
        },
        {
          taskId: "unconfigured-node",
          acceptanceChecks: [{ checkId: "artifact", kind: "artifact" }],
          authorityGates: [],
          dependencies: [],
          ownerRepository: "agents-collab",
          readScopes: ["src"],
          writeScopes: [],
          specArtifactRef: `artifact://sha256/${"e".repeat(64)}`,
        },
      ],
    };
    // No control-surface caller may pre-start the derived id itself.
    const squat = await post("/api/v1/task-graphs/start", {
      input: graphInput,
      requestId: "squat",
      workflowId: graphWorkflowId,
    });
    expect(squat.status).toBe(403);
    const start = await post("/a2a/v2/result-graph", {
      input: graphInput,
      messageWorkflowId,
      requestId: "keyed-server-start",
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({
      graphWorkflowId,
      messageWorkflowId,
      created: true,
    });
    const binding = {
      a2aTaskId: "task:keyed-server",
      graphTaskId: "result-node",
      graphWorkflowId,
      messageWorkflowId,
      recipient: "supervisor:target",
    };
    // Only the operator-configured graph task of the keyed graph binds.
    expect(
      (
        await post("/a2a/v2/assignment", {
          ...binding,
          graphTaskId: "unconfigured-node",
        })
      ).status
    ).toBe(409);
    const assigned = await post("/a2a/v2/assignment", binding);
    expect(assigned.status).toBe(200);
    await expect(
      ledger.resultBinding(scope, messageWorkflowId, "task:keyed-server")
    ).resolves.toBeUndefined(); // this ledger holds no key: it cannot verify
    const keyed = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      postgres.databaseUrl(),
      {
        deployment: taskQueue,
        resultGraphKey: SupervisorResultGraphKey.fromSecret(secret),
      }
    );
    try {
      await expect(
        keyed.resultBinding(scope, messageWorkflowId, "task:keyed-server")
      ).resolves.toEqual(binding);
    } finally {
      await keyed.close();
    }
    const listed = await fetch(
      `http://127.0.0.1:${fixture.port}/a2a/v2/assignment`,
      {
        headers: {
          authorization: `Bearer ${fixture.env.LOOP_TEST_HARNESS_TOKEN}`,
        },
      }
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      recoveryQuarantine: [],
      schema: "supervisor-result-assignment-status.v1",
      unpublishable: [],
    });
  } finally {
    stop.abort();
    await running?.catch(() => undefined);
    await environment.client.workflow
      .getHandle(graphWorkflowId)
      .terminate()
      .catch(() => undefined);
    await tasks.close();
    await ledger.close();
    fixture.remove();
  }
}, 120_000);

test("the orchestration server reports its configured readiness-outage bound and counters on /healthz", async () => {
  const environment = await temporalEnvironment();
  const config = a2aConfig(tenant());
  const fixture = compositionFixture({
    address: environment.address,
    readinessOutageBoundMs: 120_000,
    tenant: config.tenant,
    thread: "thread-a",
  });
  const stop = new AbortController();
  let running: Promise<void> | undefined;
  try {
    const started = startServer(fixture, stop.signal);
    running = started.running;
    expect(await started.ready).toBe("ready");
    const body = await (
      await fetch(`http://127.0.0.1:${fixture.port}/healthz`)
    ).json();
    expect(body).toEqual({
      a2aV2ReadinessOutage: {
        boundMs: 120_000,
        deferredDeliveries: 0,
        outageFailures: 0,
        recipientsDeferred: 0,
      },
      // Every configured seat is enrolled (session retention's field).
      notEnrolled: [],
      schema: "loop-orchestration-health.v1",
      state: "ready",
    });
  } finally {
    stop.abort();
    await running?.catch(() => undefined);
    fixture.remove();
  }
}, 120_000);
