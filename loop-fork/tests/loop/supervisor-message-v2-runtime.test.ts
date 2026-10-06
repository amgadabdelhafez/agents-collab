import { describe, expect, test } from "bun:test";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import type {
  SupervisorMessageV2DeliveryEnvelope,
  SupervisorMessageV2Input,
  TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import {
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
} from "../../src/loop/supervisor-message-v2-contract";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import {
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryLedger,
  SupervisorMessageV2ReadinessUnavailableError,
  SupervisorMessageV2RecoveryRunner,
  type SupervisorMessageV2TerminalOutcome,
  supervisorMessageV2WorkflowDefinition,
} from "../../src/loop/supervisor-message-v2-runtime";
import {
  type JsonObject,
  type WorkflowCommandReceipt,
  WorkflowError,
  type WorkflowPort,
  type WorkflowSignalCommand,
} from "../../src/loop/workflow-port";

const fixture = structuredClone(supervisorMessageV2ReplayFixtures[0]);
if (!fixture) {
  throw new Error("missing V2 tenant-scope fixture");
}
const scope: TrustedSupervisorMessageV2Scope = fixture.expectedScope;
const OWNER = "v2-dispatcher:runtime-test";
const LEASE_MS = 30_000;
const DEPLOYMENT = "runtime-test-queue";

const inputFor = (
  dedupeKey: string,
  to = "supervisor:target"
): SupervisorMessageV2Input => ({
  ...structuredClone(fixture.input),
  dedupeKey,
  messageId: `message-${dedupeKey}`,
  policy: {
    claimTimeoutMs: 600_000,
    escalationTimeoutMs: 600_000,
    maxDeliveryAttempts: 5,
    retryDelayMs: 500,
  },
  threadId: `thread-${dedupeKey}`,
  to,
});

/** Minimal in-memory model of the Postgres ledger's lease semantics. */
class MemoryLedger implements SupervisorMessageV2DeliveryLedger {
  readonly deployment = DEPLOYMENT;

  /** As the Postgres ledger: a dedupe key held under its legacy id keeps it. */
  workflowIdFor(
    trustedScope: TrustedSupervisorMessageV2Scope,
    dedupeKey: string
  ): Promise<string> {
    const legacy = deriveSupervisorMessageV2LegacyWorkflowId(
      trustedScope,
      dedupeKey
    );
    return Promise.resolve(
      this.starts.has(legacy)
        ? legacy
        : deriveSupervisorMessageV2WorkflowId(
            trustedScope,
            dedupeKey,
            DEPLOYMENT
          )
    );
  }

  readonly deliveries = new Map<
    string,
    { completed: boolean; fence: number; owner?: string; until: number }
  >();
  readonly starts = new Map<
    string,
    {
      input: SupervisorMessageV2Input;
      trustedScope: TrustedSupervisorMessageV2Scope;
    }
  >();

  assertStartIntent(workflowId: string): Promise<void> {
    if (!this.starts.has(workflowId)) {
      return Promise.reject(new Error("start intent is absent"));
    }
    return Promise.resolve();
  }

  startIntent(workflowId: string): Promise<SupervisorMessageV2Input> {
    const start = this.starts.get(workflowId);
    return start
      ? Promise.resolve(start.input)
      : Promise.reject(new Error("start intent is absent"));
  }

  claim(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    _trustedScope: TrustedSupervisorMessageV2Scope,
    owner: string,
    now: Date
  ) {
    const row = this.deliveries.get(envelope.deliveryId) ?? {
      completed: false,
      fence: 0,
      until: 0,
    };
    this.deliveries.set(envelope.deliveryId, row);
    if (row.completed) {
      return Promise.resolve({ fence: 0, state: "succeeded" as const });
    }
    if (row.until > now.getTime()) {
      return Promise.resolve({ fence: 0, state: "busy" as const });
    }
    row.fence += 1;
    row.owner = owner;
    row.until = now.getTime() + LEASE_MS;
    return Promise.resolve({ fence: row.fence, state: "claimed" as const });
  }

  complete(): Promise<void> {
    return Promise.reject(new Error("unused"));
  }

  completeClaim(
    envelope: SupervisorMessageV2DeliveryEnvelope,
    _trustedScope: TrustedSupervisorMessageV2Scope,
    owner: string,
    fence: number
  ): Promise<void> {
    const row = this.deliveries.get(envelope.deliveryId);
    if (row && row.owner === owner && row.fence === fence) {
      row.completed = true;
    }
    return Promise.resolve();
  }

  prepare(): Promise<"new" | "succeeded"> {
    return Promise.reject(new Error("unused"));
  }

  recordStartIntent(
    workflowId: string,
    trustedScope: TrustedSupervisorMessageV2Scope,
    input: SupervisorMessageV2Input
  ): Promise<SupervisorMessageV2Input> {
    const existing = this.starts.get(workflowId);
    if (existing) {
      return Promise.resolve(existing.input);
    }
    this.starts.set(workflowId, { input, trustedScope });
    return Promise.resolve(input);
  }

  hasCompletedDelivery(): Promise<boolean> {
    return Promise.resolve(false);
  }

  readonly terminal = new Map<string, SupervisorMessageV2TerminalOutcome>();

  recordTerminalOutcome(
    workflowId: string,
    _trustedScope: TrustedSupervisorMessageV2Scope,
    outcome: SupervisorMessageV2TerminalOutcome
  ): Promise<void> {
    if (!this.terminal.has(workflowId)) {
      this.terminal.set(workflowId, outcome);
    }
    return Promise.resolve();
  }

  terminalOutcome(
    workflowId: string
  ): Promise<SupervisorMessageV2TerminalOutcome | undefined> {
    return Promise.resolve(this.terminal.get(workflowId));
  }

  recoverableStarts() {
    return Promise.resolve(
      [...this.starts.entries()].map(([workflowId, start]) => ({
        ...start,
        workflowId,
      }))
    );
  }
}

/**
 * The in-memory port's inspect() exposes only event names, never payloads or
 * state, so it cannot show what a signal wrote. Record each signal command as
 * it enters the port: the payload is exactly what the workflow folds into its
 * durable state (delivery_failed's reason becomes lastFailure).
 */
class RecordingWorkflowPort extends InMemoryWorkflowPort {
  readonly signaled: {
    name: string;
    payload: JsonObject | undefined;
    workflowId: string;
  }[] = [];

  override signal(command: WorkflowSignalCommand): WorkflowCommandReceipt {
    this.signaled.push(
      structuredClone({
        name: command.name,
        payload: command.payload,
        workflowId: command.workflowId,
      })
    );
    return super.signal(command);
  }
}

const harness = () => {
  let clock = Date.parse("2026-09-20T05:00:00.000Z");
  const workflows = new RecordingWorkflowPort({
    definitions: [supervisorMessageV2WorkflowDefinition],
    now: () => new Date(clock).toISOString(),
  });
  const ledger = new MemoryLedger();
  const delivered: string[] = [];
  const unready = new Set<string>();
  const providerDown = new Set<string>();
  const readinessStore = { down: false };
  const readinessChecks: string[] = [];
  const coordinator = new SupervisorMessageV2Coordinator(
    workflows,
    {
      deliver(envelope) {
        if (providerDown.has(envelope.target)) {
          return Promise.resolve({
            reason: "provider unavailable",
            status: "transient-failure",
          });
        }
        delivered.push(envelope.deliveryId);
        return Promise.resolve({ status: "accepted" });
      },
    },
    ledger,
    OWNER,
    () => new Date(clock),
    {
      assertReady(_trustedScope, recipient) {
        readinessChecks.push(recipient);
        if (readinessStore.down) {
          return Promise.reject(
            new SupervisorMessageV2ReadinessUnavailableError()
          );
        }
        if (unready.has(recipient)) {
          return Promise.reject(
            new Error(
              "current session descriptor is expired endpoint:secret-detail"
            )
          );
        }
        return Promise.resolve({ status: "ready" });
      },
    }
  );
  const status = (workflowId: string) => coordinator.status(scope, workflowId);
  const signals = (workflowId: string) =>
    workflows
      .inspect(workflowId)
      .history.filter((event) => event.kind === "signaled")
      .map((event) => event.name);
  const signalPayloads = (workflowId: string) =>
    workflows.signaled
      .filter((command) => command.workflowId === workflowId)
      .map(({ name, payload }) => ({ name, payload }));
  return {
    advance(ms: number) {
      clock += ms;
    },
    coordinator,
    delivered,
    ledger,
    providerDown,
    readinessChecks,
    readinessStore,
    signalPayloads,
    signals,
    status,
    unready,
    workflows,
  };
};

describe("SupervisorMessageV2Coordinator delivery readiness", () => {
  test("a ready seat is delivered exactly once across receive replay and recovery", async () => {
    const h = harness();
    const input = inputFor("ready-once");
    const first = await h.coordinator.receive(scope, input, "request:ready");
    expect(first.projection.phase).toBe("routed");
    expect(first.projection.deliveredAt).not.toBeNull();
    expect(first.projection.deliveryAttempts).toBe(1);
    expect(h.delivered).toHaveLength(1);

    const replay = await h.coordinator.receive(scope, input, "request:ready");
    expect(replay.created).toBe(false);
    expect(await h.coordinator.recoverPending()).toBe(0);
    expect(h.delivered).toHaveLength(1);
    expect(h.signals(first.workflowId)).toEqual(["delivery_succeeded"]);
  });

  test("an unready seat on receive becomes a retryable delivery_failed, then delivers once when ready", async () => {
    const h = harness();
    h.unready.add("supervisor:target");
    const received = await h.coordinator.receive(
      scope,
      inputFor("stale-seat"),
      "request:stale"
    );
    const { workflowId } = received;
    expect(received.projection.phase).toBe("retry-scheduled");
    expect(received.projection.actionRequired).toBe("retry");
    expect(received.projection.deliveryAttempts).toBe(1);
    expect(received.projection.nextRetryAt).not.toBeNull();
    expect(h.delivered).toHaveLength(0);
    expect(h.signals(workflowId)).toEqual(["delivery_failed"]);
    // The readiness refusal reaches durable workflow state only as a fixed
    // opaque reason: delivery_failed's payload is what becomes lastFailure.
    expect(h.signalPayloads(workflowId)).toEqual([
      {
        name: "delivery_failed",
        payload: { permanent: false, reason: "recipient session is not ready" },
      },
    ]);
    expect(JSON.stringify(h.signalPayloads(workflowId))).not.toContain(
      "secret-detail"
    );
    expect(JSON.stringify(received.projection)).not.toContain("secret-detail");

    // Not yet due: recovery leaves the scheduled retry alone.
    expect(await h.coordinator.recoverPending()).toBe(0);
    expect(h.delivered).toHaveLength(0);

    h.unready.delete("supervisor:target");
    h.advance(500);
    expect(await h.coordinator.recoverPending()).toBe(1);
    const recovered = await h.status(workflowId);
    expect(recovered.phase).toBe("routed");
    expect(recovered.deliveredAt).not.toBeNull();
    expect(recovered.deliveryAttempts).toBe(2);
    expect(h.delivered).toHaveLength(1);

    expect(await h.coordinator.recoverPending()).toBe(0);
    expect(h.delivered).toHaveLength(1);
    expect(h.signals(workflowId)).toEqual([
      "delivery_failed",
      "retry_due",
      "delivery_succeeded",
    ]);
  });

  test("a stale seat does not abort the recovery sweep for other ready seats", async () => {
    const h = harness();
    h.providerDown.add("supervisor:a-stale");
    h.providerDown.add("supervisor:z-ready");
    const stale = await h.coordinator.receive(
      scope,
      inputFor("sweep-stale", "supervisor:a-stale"),
      "request:sweep-stale"
    );
    const ready = await h.coordinator.receive(
      scope,
      inputFor("sweep-ready", "supervisor:z-ready"),
      "request:sweep-ready"
    );
    expect(h.delivered).toHaveLength(0);
    h.providerDown.clear();
    h.unready.add("supervisor:a-stale");
    h.advance(500);
    // Each workflow is visited regardless of the other's readiness.
    await h.coordinator.recoverPending();
    expect((await h.status(ready.workflowId)).deliveredAt).not.toBeNull();
    const stillStale = await h.status(stale.workflowId);
    expect(stillStale.phase).toBe("retry-scheduled");
    expect(stillStale.deliveryAttempts).toBe(2);
    expect(h.delivered).toHaveLength(1);
  });

  test("a readiness refusal does not fail a delivery another dispatcher holds", async () => {
    const h = harness();
    h.unready.add("supervisor:target");
    const workflowId = deriveSupervisorMessageV2WorkflowId(
      scope,
      "held-lease",
      DEPLOYMENT
    );
    // Pretend another dispatcher already holds this attempt's lease.
    h.ledger.starts.set(workflowId, {
      input: inputFor("held-lease"),
      trustedScope: scope,
    });
    await h.workflows.start({
      input: { input: inputFor("held-lease"), trustedScope: scope },
      requestId: "other:start",
      workflowId,
      workflowType: supervisorMessageV2WorkflowDefinition.type,
    });
    const envelope = h.workflows.query({
      args: { trustedScope: scope, workflowId },
      name: "delivery_request",
      workflowId,
    }).value as SupervisorMessageV2DeliveryEnvelope;
    await h.ledger.claim(
      envelope,
      scope,
      "v2-dispatcher:other",
      new Date(Date.parse("2026-09-20T05:00:00.000Z"))
    );

    expect(await h.coordinator.recoverPending()).toBe(1);
    const projection = await h.status(workflowId);
    expect(projection.phase).toBe("routed");
    expect(projection.deliveryAttempts).toBe(0);
    expect(h.signals(workflowId)).toEqual([]);
    expect(h.delivered).toHaveLength(0);
  });

  test("a claimant's due retry with an unready seat records a retryable delivery_failed", async () => {
    const h = harness();
    h.providerDown.add("supervisor:target");
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("claim-stale"),
      "request:claim-stale"
    );
    h.providerDown.clear();
    h.unready.add("supervisor:target");
    h.advance(500);

    const claim = h.coordinator.claim(
      scope,
      workflowId,
      "supervisor:target",
      "claim:1"
    );
    // The claim itself is refused by the canonical workflow rule (delivery not
    // accepted), not by a raw readiness error escaping the delivery boundary.
    await expect(claim).rejects.toBeInstanceOf(WorkflowError);
    const afterRefusal = await h.status(workflowId);
    expect(afterRefusal.phase).toBe("retry-scheduled");
    expect(afterRefusal.deliveryAttempts).toBe(2);
    expect(afterRefusal.nextRetryAt).not.toBeNull();
    expect(h.delivered).toHaveLength(0);
    expect(h.signals(workflowId)).toEqual([
      "delivery_failed",
      "retry_due",
      "delivery_failed",
    ]);

    h.unready.delete("supervisor:target");
    h.advance(500);
    const claimed = await h.coordinator.claim(
      scope,
      workflowId,
      "supervisor:target",
      "claim:2"
    );
    expect(claimed.phase).toBe("claimed");
    expect(claimed.claimedBy).toBe("supervisor:target");
    expect(h.delivered).toHaveLength(1);
  });

  test("an unready seat still consumes delivery attempts and dead-letters at the policy bound", async () => {
    const h = harness();
    h.unready.add("supervisor:target");
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("unready-bound"),
      "request:unready-bound"
    );
    expect((await h.status(workflowId)).deliveryAttempts).toBe(1);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      h.advance(500);
      await h.coordinator.recoverPending();
      expect((await h.status(workflowId)).deliveryAttempts).toBe(attempt);
    }
    const final = await h.status(workflowId);
    expect(final.phase).toBe("dead-lettered");
    expect(final.deadLetteredAt).not.toBeNull();
    expect(h.delivered).toHaveLength(0);
  });

  test("a readiness store outage defers delivery without consuming an attempt or a lease", async () => {
    const h = harness();
    h.readinessStore.down = true;
    const received = await h.coordinator.receive(
      scope,
      inputFor("store-outage"),
      "request:store-outage"
    );
    const { workflowId } = received;
    // The sender sees the durable, still-pending message, not a raw error.
    expect(received.projection.phase).toBe("routed");
    expect(received.projection.deliveryAttempts).toBe(0);
    expect(received.projection.deliveredAt).toBeNull();
    expect(h.signals(workflowId)).toEqual([]);
    expect(h.ledger.deliveries.size).toBe(0);
    expect(h.delivered).toHaveLength(0);

    // Outlast the delivery-attempt bound (5) on the existing recovery sweep.
    for (let sweep = 0; sweep < 8; sweep += 1) {
      h.advance(500);
      expect(await h.coordinator.recoverPending()).toBe(0);
    }
    const during = await h.status(workflowId);
    expect(during.phase).toBe("routed");
    expect(during.deliveryAttempts).toBe(0);
    expect(during.deadLetteredAt).toBeNull();
    expect(h.signals(workflowId)).toEqual([]);
    expect(h.ledger.deliveries.size).toBe(0);
    expect(h.readinessChecks).toHaveLength(9);

    h.readinessStore.down = false;
    expect(await h.coordinator.recoverPending()).toBe(1);
    const recovered = await h.status(workflowId);
    expect(recovered.deliveredAt).not.toBeNull();
    expect(recovered.deliveryAttempts).toBe(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.signals(workflowId)).toEqual(["delivery_succeeded"]);
  });

  test("a readiness store outage on a claimant's due retry leaves the attempt for recovery", async () => {
    const h = harness();
    h.providerDown.add("supervisor:target");
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("claim-outage"),
      "request:claim-outage"
    );
    h.providerDown.clear();
    h.readinessStore.down = true;
    h.advance(500);

    await expect(
      h.coordinator.claim(scope, workflowId, "supervisor:target", "claim:1")
    ).rejects.toBeInstanceOf(WorkflowError);
    const deferred = await h.status(workflowId);
    expect(deferred.phase).toBe("routed");
    expect(deferred.deliveryAttempts).toBe(1);
    expect(h.signals(workflowId)).toEqual(["delivery_failed", "retry_due"]);
    expect(h.delivered).toHaveLength(0);

    h.readinessStore.down = false;
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect(h.delivered).toHaveLength(1);
    const claimed = await h.coordinator.claim(
      scope,
      workflowId,
      "supervisor:target",
      "claim:2"
    );
    expect(claimed.phase).toBe("claimed");
    expect(claimed.deliveryAttempts).toBe(2);
  });
});

describe("SupervisorMessageV2 recovery with a foreign-owned workflow ID", () => {
  // A V2 workflow ID is unique per Temporal namespace, not per deployment.
  // When another deployment (or another workflow type) already holds an ID
  // this ledger recorded a start intent for, the Temporal port refuses with
  // a conflict. That one record must not refuse the whole service start.
  const FOREIGN_TYPE = "supervisor-message.v1";
  const foreignPort = (
    inner: InMemoryWorkflowPort,
    foreign: ReadonlySet<string>
  ): WorkflowPort => ({
    cancel: (command) => inner.cancel(command),
    inspect: (workflowId) => inner.inspect(workflowId),
    query: (command) => inner.query(command),
    signal: (command) => inner.signal(command),
    start: (command) =>
      foreign.has(command.workflowId)
        ? Promise.reject(
            new WorkflowError(
              "conflict",
              `workflow ${command.workflowId} already exists as ${FOREIGN_TYPE}`
            )
          )
        : inner.start(command),
  });

  const setup = () => {
    let clock = Date.parse("2026-09-20T05:00:00.000Z");
    const inner = new InMemoryWorkflowPort({
      definitions: [supervisorMessageV2WorkflowDefinition],
      now: () => new Date(clock).toISOString(),
    });
    const foreignId = deriveSupervisorMessageV2WorkflowId(
      scope,
      "foreign",
      DEPLOYMENT
    );
    const ledger = new MemoryLedger();
    const delivered: string[] = [];
    const providerDown = new Set<string>();
    const coordinator = new SupervisorMessageV2Coordinator(
      foreignPort(inner, new Set([foreignId])),
      {
        deliver(envelope) {
          if (providerDown.has(envelope.target)) {
            return Promise.resolve({
              reason: "provider unavailable",
              status: "transient-failure",
            });
          }
          delivered.push(envelope.target);
          return Promise.resolve({ status: "accepted" });
        },
      },
      ledger,
      OWNER,
      () => new Date(clock)
    );
    // Recorded first, so it is visited before the healthy recipient.
    ledger.starts.set(foreignId, {
      input: inputFor("foreign", "supervisor:a-foreign"),
      trustedScope: scope,
    });
    const logs: string[] = [];
    const runner = new SupervisorMessageV2RecoveryRunner({
      coordinator,
      intervalMs: 1000,
      log: (line) => logs.push(line),
      timer: { clearInterval: () => undefined, setInterval: () => 1 },
    });
    return {
      advance: (ms: number) => {
        clock += ms;
      },
      coordinator,
      delivered,
      foreignId,
      logs,
      providerDown,
      runner,
    };
  };

  test("service-start recovery skips the foreign ID, recovers every other recipient, and says which ID and recipient", async () => {
    const s = setup();
    s.providerDown.add("supervisor:z-ready");
    const pending = await s.coordinator.receive(
      scope,
      inputFor("pending", "supervisor:z-ready"),
      "request:pending"
    );
    expect(pending.projection.phase).toBe("retry-scheduled");
    s.providerDown.clear();
    s.advance(500);

    await s.runner.start();

    expect(s.delivered).toEqual(["supervisor:z-ready"]);
    const skipped = `V2 recovery skipped workflow ${s.foreignId} for supervisor:a-foreign: WorkflowError (conflict): workflow ${s.foreignId} already exists as ${FOREIGN_TYPE}`;
    expect(s.logs).toEqual([skipped]);
    // The next sweep still skips it, without repeating the same line.
    expect(await s.runner.sweep()).toBe(0);
    expect(s.logs).toEqual([skipped]);
    await s.runner.close();
  });

  test("a direct recovery call still fails after recovering the other recipients", async () => {
    const s = setup();
    s.providerDown.add("supervisor:z-ready");
    await s.coordinator.receive(
      scope,
      inputFor("pending", "supervisor:z-ready"),
      "request:pending"
    );
    s.providerDown.clear();
    s.advance(500);
    await expect(s.coordinator.recoverPending()).rejects.toThrow(
      `workflow ${s.foreignId} already exists as ${FOREIGN_TYPE}`
    );
    expect(s.delivered).toEqual(["supervisor:z-ready"]);
  });
});

describe("SupervisorMessageV2 workflow id deployment", () => {
  const portOn = (taskQueue: string | undefined): WorkflowPort => {
    const inner = new InMemoryWorkflowPort({
      definitions: [supervisorMessageV2WorkflowDefinition],
    });
    return {
      cancel: (command) => inner.cancel(command),
      inspect: (workflowId) => inner.inspect(workflowId),
      query: (command) => inner.query(command),
      signal: (command) => inner.signal(command),
      start: (command) => inner.start(command),
      ...(taskQueue === undefined ? {} : { taskQueue }),
    };
  };
  const coordinatorOn = (workflows: WorkflowPort) =>
    new SupervisorMessageV2Coordinator(
      workflows,
      { deliver: () => Promise.resolve({ status: "accepted" }) },
      new MemoryLedger(),
      OWNER
    );

  test("refuses a ledger whose deployment is not the workflow port's task queue", () => {
    expect(() => coordinatorOn(portOn("another-queue"))).toThrow(
      "SupervisorMessage V2 ledger deployment does not match the workflow port task queue"
    );
    expect(() => coordinatorOn(portOn(DEPLOYMENT))).not.toThrow();
    // A port that names no queue (in-memory, test) composes as before.
    expect(() => coordinatorOn(portOn(undefined))).not.toThrow();
  });

  test("mints the deployment workflow id for a new message", async () => {
    const h = harness();
    const received = await h.coordinator.receive(
      scope,
      inputFor("new-format"),
      "request:new"
    );
    expect(received.workflowId).toBe(
      deriveSupervisorMessageV2WorkflowId(scope, "new-format", DEPLOYMENT)
    );
    expect(received.workflowId).toMatch(
      /^supervisor-message-workflow:v2:deployment:[a-f0-9]{64}$/
    );
    expect(received.workflowId).not.toBe(
      deriveSupervisorMessageV2LegacyWorkflowId(scope, "new-format")
    );
  });

  test("a sender retry of a message accepted under the legacy id resolves to it and never starts it twice", async () => {
    const h = harness();
    const input = inputFor("legacy-accepted");
    const legacy = deriveSupervisorMessageV2LegacyWorkflowId(
      scope,
      "legacy-accepted"
    );
    // As the pre-discriminator host left it: intent recorded and execution
    // started under the legacy id, then delivered by recovery.
    h.ledger.starts.set(legacy, { input, trustedScope: scope });
    await h.workflows.start({
      input: { input, trustedScope: scope },
      requestId: "legacy:start",
      workflowId: legacy,
      workflowType: supervisorMessageV2WorkflowDefinition.type,
    });
    await h.coordinator.recoverPending();
    expect(h.delivered).toHaveLength(1);

    const retry = await h.coordinator.receive(scope, input, "request:retry");

    expect(retry.workflowId).toBe(legacy);
    expect(retry.created).toBe(false);
    expect(h.delivered).toHaveLength(1);
    expect([...h.ledger.starts.keys()]).toEqual([legacy]);
  });
});
