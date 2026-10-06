import { describe, expect, test } from "bun:test";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import type {
  SupervisorMessageV2DeliveryEnvelope,
  SupervisorMessageV2Input,
  TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import { deriveSupervisorMessageV2WorkflowId } from "../../src/loop/supervisor-message-v2-contract";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import {
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryLedger,
  SupervisorMessageV2RecoveryRunner,
  supervisorMessageV2WorkflowDefinition,
} from "../../src/loop/supervisor-message-v2-runtime";
import { WorkflowError, type WorkflowPort } from "../../src/loop/workflow-port";

const fixture = structuredClone(supervisorMessageV2ReplayFixtures[0]);
if (!fixture) {
  throw new Error("missing V2 tenant-scope fixture");
}
const scope: TrustedSupervisorMessageV2Scope = fixture.expectedScope;
const OWNER = "v2-dispatcher:runtime-test";
const LEASE_MS = 30_000;

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

  recoverableStarts() {
    return Promise.resolve(
      [...this.starts.entries()].map(([workflowId, start]) => ({
        ...start,
        workflowId,
      }))
    );
  }
}

const harness = () => {
  let clock = Date.parse("2026-09-20T05:00:00.000Z");
  const workflows = new InMemoryWorkflowPort({
    definitions: [supervisorMessageV2WorkflowDefinition],
    now: () => new Date(clock).toISOString(),
  });
  const ledger = new MemoryLedger();
  const delivered: string[] = [];
  const unready = new Set<string>();
  const providerDown = new Set<string>();
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
  return {
    advance(ms: number) {
      clock += ms;
    },
    coordinator,
    delivered,
    ledger,
    providerDown,
    readinessChecks,
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
    // The readiness refusal is opaque in durable workflow state.
    const state = h.workflows.inspect(workflowId);
    expect(JSON.stringify(state)).not.toContain("secret-detail");

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
    const workflowId = deriveSupervisorMessageV2WorkflowId(scope, "held-lease");
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
    const foreignId = deriveSupervisorMessageV2WorkflowId(scope, "foreign");
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
