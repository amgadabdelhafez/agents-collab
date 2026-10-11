import { describe, expect, spyOn, test } from "bun:test";
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
  SUPERVISOR_MESSAGE_V2_NOT_ENROLLED_BOUND_MS,
  SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS,
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryLedger,
  SupervisorMessageV2NotEnrolledDeferral,
  SupervisorMessageV2ReadinessOutageTracker,
  SupervisorMessageV2ReadinessUnavailableError,
  SupervisorMessageV2RecipientTooEarlyError,
  SupervisorMessageV2RecoveryRunner,
  type SupervisorMessageV2TerminalOutcome,
  supervisorMessageV2WorkflowDefinition,
} from "../../src/loop/supervisor-message-v2-runtime";
import {
  type JsonObject,
  type WorkflowCommandReceipt,
  WorkflowError,
  WorkflowForeignExecutionError,
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

/**
 * As the Temporal port: every command's outcome is kept under its request
 * id, a refusal included, and replayed to each later command with that id.
 */
class RefusalReplayingWorkflowPort extends RecordingWorkflowPort {
  readonly #refused = new Map<string, unknown>();

  override signal(command: WorkflowSignalCommand): WorkflowCommandReceipt {
    if (this.#refused.has(command.requestId)) {
      throw this.#refused.get(command.requestId);
    }
    try {
      return super.signal(command);
    } catch (error) {
      this.#refused.set(command.requestId, error);
      throw error;
    }
  }
}

const harness = (
  options: {
    notEnrolledBoundMs?: number;
    outageBoundMs?: number;
    replayRefusals?: boolean;
  } = {}
) => {
  let clock = Date.parse("2026-09-20T05:00:00.000Z");
  const logs: string[] = [];
  const outage = new SupervisorMessageV2ReadinessOutageTracker({
    boundMs: options.outageBoundMs,
    log: (line) => logs.push(line),
  });
  // When each recipient stopped being enrolled, as the server's enrollment
  // reports it; absent, the recipient is enrolled.
  const notEnrolledSince = new Map<string, number>();
  const notEnrolled = new SupervisorMessageV2NotEnrolledDeferral({
    boundMs: options.notEnrolledBoundMs,
    enrollment: {
      notEnrolledSince: (recipient) => notEnrolledSince.get(recipient),
    },
    log: (line) => logs.push(line),
  });
  const workflows = new (
    options.replayRefusals
      ? RefusalReplayingWorkflowPort
      : RecordingWorkflowPort
  )({
    definitions: [supervisorMessageV2WorkflowDefinition],
    now: () => new Date(clock).toISOString(),
  });
  const ledger = new MemoryLedger();
  const delivered: string[] = [];
  const unready = new Set<string>();
  const providerDown = new Set<string>();
  const readinessStore = { down: false, downFor: new Set<string>() };
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
        if (readinessStore.down || readinessStore.downFor.has(recipient)) {
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
    },
    outage,
    notEnrolled
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
    at: () => new Date(clock),
    coordinator,
    delivered,
    ledger,
    logs,
    notEnrolled,
    notEnrolledSince,
    outage,
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

  test("the recipient's early claim and acknowledge are refused before any signal, so the same request ids pass once the delivery is recorded", async () => {
    // A port that, like Temporal's, replays a refusal to every retry of its
    // request id: a signalled early refusal would refuse the ACK for good.
    const h = harness({ replayRefusals: true });
    h.providerDown.add("supervisor:target");
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("early-ack"),
      "request:early-ack"
    );
    // The recipient already holds the message (a queued Claude entry, a
    // mailbox envelope); the workflow has its first attempt failed and the
    // next not yet due.
    const pending = await h.status(workflowId);
    expect(pending.phase).toBe("retry-scheduled");
    const claimId = `a2a-ack:claim:${workflowId}`;
    const acknowledgeId = `a2a-ack:acknowledge:${workflowId}`;
    const earlyClaim = await h.coordinator
      .claim(scope, workflowId, "supervisor:target", claimId)
      .catch((error: unknown) => error);
    expect(earlyClaim).toBeInstanceOf(
      SupervisorMessageV2RecipientTooEarlyError
    );
    expect(earlyClaim).toBeInstanceOf(WorkflowError);
    expect(earlyClaim).toMatchObject({
      reason: "delivery-not-recorded",
      retryAt: pending.nextRetryAt,
    });
    const earlyAck = await h.coordinator
      .acknowledge(scope, workflowId, "supervisor:target", acknowledgeId)
      .catch((error: unknown) => error);
    expect(earlyAck).toMatchObject({
      reason: "not-claimed",
      retryAt: pending.nextRetryAt,
    });
    // Neither reached the workflow, so nothing is kept under either id.
    expect(h.signalPayloads(workflowId).map((signal) => signal.name)).toEqual([
      "delivery_failed",
    ]);

    // Another supervisor's claim is not "early": the workflow refuses it.
    const intruder = await h.coordinator
      .claim(scope, workflowId, "supervisor:intruder", "intruder:claim")
      .catch((error: unknown) => error);
    expect(intruder).toBeInstanceOf(WorkflowError);
    expect(intruder).not.toBeInstanceOf(
      SupervisorMessageV2RecipientTooEarlyError
    );

    // The retry falls due: the same claim drives the attempt that records
    // the delivery, then claims; the same acknowledge then passes.
    h.providerDown.clear();
    h.advance(500);
    const claimed = await h.coordinator.claim(
      scope,
      workflowId,
      "supervisor:target",
      claimId
    );
    expect(claimed.phase).toBe("claimed");
    expect(claimed.deliveredAt).not.toBeNull();
    const acknowledged = await h.coordinator.acknowledge(
      scope,
      workflowId,
      "supervisor:target",
      acknowledgeId
    );
    expect(acknowledged.phase).toBe("acknowledged");
    expect(acknowledged.acknowledgedAt).not.toBeNull();
  });

  test("a claim while the delivery is still pending (no attempt recorded) is early too, with no retry instant", async () => {
    const h = harness({ replayRefusals: true });
    h.readinessStore.down = true;
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("early-pending"),
      "request:early-pending"
    );
    expect((await h.status(workflowId)).phase).toBe("routed");
    const claimId = `a2a-ack:claim:${workflowId}`;
    await expect(
      h.coordinator.claim(scope, workflowId, "supervisor:target", claimId)
    ).rejects.toMatchObject({ reason: "delivery-not-recorded", retryAt: null });
    expect(h.signalPayloads(workflowId)).toEqual([]);
    h.readinessStore.down = false;
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect(
      (
        await h.coordinator.claim(
          scope,
          workflowId,
          "supervisor:target",
          claimId
        )
      ).phase
    ).toBe("claimed");
  });
});

describe("SupervisorMessageV2 readiness outage deferral bound", () => {
  const entered = (recipient: string) =>
    `V2 delivery to ${recipient} deferred: session readiness store is unavailable`;
  const resumed = (recipient: string, afterMs: number) =>
    `V2 delivery to ${recipient} resumed after ${afterMs}ms: session readiness store answered`;
  const exceeded = (recipient: string, boundMs: number) =>
    `V2 delivery to ${recipient} still deferred after ${boundMs}ms: the readiness store outage now fails delivery attempts`;

  test("an outage logs one line per recipient on entering deferral and one on leaving it, not one per attempt", async () => {
    const h = harness();
    h.readinessStore.down = true;
    await h.coordinator.receive(
      scope,
      inputFor("log-a", "supervisor:a"),
      "request:log-a"
    );
    await h.coordinator.receive(
      scope,
      inputFor("log-b", "supervisor:b"),
      "request:log-b"
    );
    for (let sweep = 0; sweep < 4; sweep += 1) {
      h.advance(30_000);
      expect(await h.coordinator.recoverPending()).toBe(0);
    }
    expect(h.readinessChecks).toHaveLength(10);
    expect(h.logs).toEqual([entered("supervisor:a"), entered("supervisor:b")]);

    h.readinessStore.down = false;
    expect(await h.coordinator.recoverPending()).toBe(2);
    expect(h.delivered).toHaveLength(2);
    const afterOutage = [
      entered("supervisor:a"),
      entered("supervisor:b"),
      resumed("supervisor:a", 120_000),
      resumed("supervisor:b", 120_000),
    ];
    expect(h.logs).toEqual(afterOutage);

    // A later delivery while the store answers says nothing more.
    await h.coordinator.receive(
      scope,
      inputFor("log-a-again", "supervisor:a"),
      "request:log-a-again"
    );
    expect(h.delivered).toHaveLength(3);
    expect(h.logs).toEqual(afterOutage);
  });

  test("a store that answers the seat is not ready ends the outage too", async () => {
    const h = harness();
    h.readinessStore.downFor.add("supervisor:target");
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("outage-then-unready"),
      "request:outage-then-unready"
    );
    h.readinessStore.downFor.clear();
    h.unready.add("supervisor:target");
    h.advance(45_000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(1);
    expect(h.logs).toEqual([
      entered("supervisor:target"),
      resumed("supervisor:target", 45_000),
    ]);
    expect(h.outage.snapshot(h.at()).recipientsDeferred).toBe(0);
  });

  test("the outage counter reports deferred deliveries, outage failures and the recipients in deferral", async () => {
    const h = harness({ outageBoundMs: 60_000 });
    expect(h.outage.snapshot(h.at())).toEqual({
      boundMs: 60_000,
      deferredDeliveries: 0,
      outageFailures: 0,
      recipientsDeferred: 0,
    });
    h.readinessStore.downFor.add("supervisor:a");
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("count-a", "supervisor:a"),
      "request:count-a"
    );
    h.advance(30_000);
    expect(await h.coordinator.recoverPending()).toBe(0);
    expect(h.outage.snapshot(h.at())).toEqual({
      boundMs: 60_000,
      deferredDeliveries: 2,
      outageFailures: 0,
      recipientsDeferred: 1,
    });

    h.advance(30_000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(1);
    expect(h.outage.snapshot(h.at())).toEqual({
      boundMs: 60_000,
      deferredDeliveries: 2,
      outageFailures: 1,
      recipientsDeferred: 1,
    });

    h.readinessStore.downFor.clear();
    h.advance(500);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.outage.snapshot(h.at())).toEqual({
      boundMs: 60_000,
      deferredDeliveries: 2,
      outageFailures: 1,
      recipientsDeferred: 0,
    });
  });

  test("an outage that outlasts its bound becomes a retryable delivery failure that consumes attempts up to the policy bound", async () => {
    const h = harness({ outageBoundMs: 60_000 });
    h.readinessStore.down = true;
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("outage-bound"),
      "request:outage-bound"
    );
    h.advance(59_999);
    expect(await h.coordinator.recoverPending()).toBe(0);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(0);
    expect(h.ledger.deliveries.size).toBe(0);

    h.advance(1);
    expect(await h.coordinator.recoverPending()).toBe(1);
    const failed = await h.status(workflowId);
    expect(failed.phase).toBe("retry-scheduled");
    expect(failed.deliveryAttempts).toBe(1);
    // A normal attempt: it claimed the lease, and its fixed opaque reason
    // names the store, not the seat.
    expect(h.ledger.deliveries.size).toBe(1);
    expect(h.signalPayloads(workflowId)).toEqual([
      {
        name: "delivery_failed",
        payload: {
          permanent: false,
          reason: "session readiness store is unavailable",
        },
      },
    ]);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      h.advance(500);
      await h.coordinator.recoverPending();
      expect((await h.status(workflowId)).deliveryAttempts).toBe(attempt);
    }
    expect((await h.status(workflowId)).phase).toBe("dead-lettered");
    expect(h.delivered).toHaveLength(0);
    expect(h.logs).toEqual([
      entered("supervisor:target"),
      exceeded("supervisor:target", 60_000),
    ]);
  });

  test("one continuous outage observed only every half hour is still one outage", async () => {
    const h = harness();
    h.readinessStore.down = true;
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("sparse-outage"),
      "request:sparse-outage"
    );
    for (let sweep = 0; sweep < 4; sweep += 1) {
      h.advance(1_800_000);
      await h.coordinator.recoverPending();
    }
    // Past the default bound at the first sweep, every sweep is an attempt.
    expect((await h.status(workflowId)).deliveryAttempts).toBe(4);
    expect(h.logs).toEqual([
      entered("supervisor:target"),
      exceeded(
        "supervisor:target",
        SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS
      ),
    ]);
  });

  test("a bound longer than an hour keeps an outage observed every ninety minutes as one outage", async () => {
    const h = harness({ outageBoundMs: 7_200_000 });
    h.readinessStore.down = true;
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("long-bound"),
      "request:long-bound"
    );
    h.advance(5_400_000);
    expect(await h.coordinator.recoverPending()).toBe(0);
    h.advance(5_400_000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(1);
    expect(h.logs).toEqual([
      entered("supervisor:target"),
      exceeded("supervisor:target", 7_200_000),
    ]);
  });

  test("an outage nothing observed for over two hours, with no message waiting on it, is over: the next failure starts a new bound", async () => {
    const h = harness({ outageBoundMs: 60_000 });
    h.readinessStore.down = true;
    const first = await h.coordinator.receive(
      scope,
      inputFor("stale-outage"),
      "request:stale-outage"
    );
    // The deferred message leaves the pending state without another
    // readiness check (here another dispatcher delivers it), so nothing
    // asks the store about this recipient again.
    const envelope = h.workflows.query({
      args: { trustedScope: scope, workflowId: first.workflowId },
      name: "delivery_request",
      workflowId: first.workflowId,
    }).value as SupervisorMessageV2DeliveryEnvelope;
    await h.ledger.claim(envelope, scope, "v2-dispatcher:other", h.at());
    h.advance(7_200_000);
    // Still within two hours of its last observation: the same outage.
    expect(h.outage.snapshot(h.at()).recipientsDeferred).toBe(1);
    h.advance(1);
    // Nothing observed it for over two hours: no phantom recipient.
    expect(h.outage.snapshot(h.at()).recipientsDeferred).toBe(0);
    expect(h.outage.recipients(h.at())).toEqual([]);
    // A later, separate outage defers under its own bound instead of
    // failing the new message's first attempt at once.
    const second = await h.coordinator.receive(
      scope,
      inputFor("stale-outage-later"),
      "request:stale-outage-later"
    );
    expect(await h.status(second.workflowId)).toMatchObject({
      deliveryAttempts: 0,
      phase: "routed",
    });
    expect(h.outage.recipients(h.at())).toEqual(["supervisor:target"]);
    expect(h.logs).toEqual([
      entered("supervisor:target"),
      entered("supervisor:target"),
    ]);
  });

  test("a later outage defers again after a message it failed has ended, even when that message waited on a long retry", async () => {
    const h = harness({ outageBoundMs: 60_000 });
    h.readinessStore.down = true;
    const input = inputFor("ended-outage");
    input.policy = {
      ...input.policy,
      maxDeliveryAttempts: 2,
      retryDelayMs: 86_400_000,
    };
    const { workflowId } = await h.coordinator.receive(
      scope,
      input,
      "request:ended-outage"
    );
    h.advance(60_000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    h.advance(86_400_000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    // The outage failed its last attempt: nothing waits on the outage now.
    expect(await h.status(workflowId)).toMatchObject({
      deliveryAttempts: 2,
      phase: "dead-lettered",
    });
    // The store recovers and fails again three hours later, with nothing
    // having asked it about this recipient in between.
    h.advance(10_800_000);
    expect(h.outage.snapshot(h.at()).recipientsDeferred).toBe(0);
    const later = await h.coordinator.receive(
      scope,
      inputFor("ended-outage-later"),
      "request:ended-outage-later"
    );
    expect(await h.status(later.workflowId)).toMatchObject({
      deliveryAttempts: 0,
      phase: "routed",
    });
    expect(h.logs).toEqual([
      entered("supervisor:target"),
      exceeded("supervisor:target", 60_000),
      entered("supervisor:target"),
    ]);
  });

  test("a store answer for one recipient does not end another recipient's outage", async () => {
    const h = harness({ outageBoundMs: 60_000 });
    h.readinessStore.downFor.add("supervisor:a");
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("partial-a", "supervisor:a"),
      "request:partial-a"
    );
    h.advance(30_000);
    await h.coordinator.receive(
      scope,
      inputFor("partial-b", "supervisor:b"),
      "request:partial-b"
    );
    expect(h.delivered).toHaveLength(1);
    // A failure the store keeps for one recipient still meets its bound,
    // measured from that recipient's first failure.
    h.advance(30_000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(1);
    expect(h.outage.recipients(h.at())).toEqual(["supervisor:a"]);
  });

  test("an outage is measured from its start, however long a message waits on its retry delay", async () => {
    const h = harness({ outageBoundMs: 60_000 });
    h.readinessStore.down = true;
    const input = inputFor("long-retry-outage");
    input.policy = { ...input.policy, retryDelayMs: 86_400_000 };
    const { workflowId } = await h.coordinator.receive(
      scope,
      input,
      "request:long-retry-outage"
    );
    h.advance(60_000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect(await h.status(workflowId)).toMatchObject({
      deliveryAttempts: 1,
      phase: "retry-scheduled",
    });
    // Nothing observes the outage while the message waits a day; only
    // deliveries a sweep observed within two hours are reported.
    h.advance(10_800_000);
    expect(h.outage.snapshot(h.at()).recipientsDeferred).toBe(0);
    // The retry falls due a day later, the store still down: that is a
    // second failed attempt, not a fresh bound of deferral.
    h.advance(86_400_000 - 10_800_000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(2);
    expect(h.logs).toEqual([
      entered("supervisor:target"),
      exceeded("supervisor:target", 60_000),
    ]);
    expect(h.outage.snapshot(h.at())).toMatchObject({
      outageFailures: 2,
      recipientsDeferred: 1,
    });
  });

  test("outage failures count only the attempts the outage failed, not a verdict another dispatcher's lease absorbed", async () => {
    const h = harness({ outageBoundMs: 60_000 });
    h.readinessStore.down = true;
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("held-outage"),
      "request:held-outage"
    );
    h.advance(60_000);
    // Another dispatcher holds this attempt's lease when the bound passes.
    const envelope = h.workflows.query({
      args: { trustedScope: scope, workflowId },
      name: "delivery_request",
      workflowId,
    }).value as SupervisorMessageV2DeliveryEnvelope;
    await h.ledger.claim(envelope, scope, "v2-dispatcher:other", h.at());
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(0);
    expect(h.signals(workflowId)).toEqual([]);
    expect(h.outage.snapshot(h.at()).outageFailures).toBe(0);
    // Once that lease lapses this dispatcher fails the attempt: one failure.
    h.advance(LEASE_MS);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(1);
    expect(h.outage.snapshot(h.at()).outageFailures).toBe(1);
  });

  test("the outage bound is a whole number of milliseconds from one second to one day, fifteen minutes by default", () => {
    expect(SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS).toBe(900_000);
    expect(
      new SupervisorMessageV2ReadinessOutageTracker().snapshot().boundMs
    ).toBe(900_000);
    for (const boundMs of [999, 86_400_001, 1500.5, Number.NaN]) {
      expect(
        () => new SupervisorMessageV2ReadinessOutageTracker({ boundMs })
      ).toThrow("V2 readiness outage bound is invalid");
    }
    for (const boundMs of [1000, 86_400_000]) {
      expect(
        new SupervisorMessageV2ReadinessOutageTracker({ boundMs }).snapshot()
          .boundMs
      ).toBe(boundMs);
    }
  });

  test("a coordinator built without a tracker still logs and bounds an outage at the default", async () => {
    let clock = Date.parse("2026-09-20T05:00:00.000Z");
    const workflows = new InMemoryWorkflowPort({
      definitions: [supervisorMessageV2WorkflowDefinition],
      now: () => new Date(clock).toISOString(),
    });
    const coordinator = new SupervisorMessageV2Coordinator(
      workflows,
      { deliver: () => Promise.resolve({ status: "accepted" }) },
      new MemoryLedger(),
      OWNER,
      () => new Date(clock),
      {
        assertReady: () =>
          Promise.reject(new SupervisorMessageV2ReadinessUnavailableError()),
      }
    );
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { workflowId } = await coordinator.receive(
        scope,
        inputFor("default-bound"),
        "request:default-bound"
      );
      expect(errors.mock.calls.map(([line]) => String(line))).toEqual([
        entered("supervisor:target"),
      ]);
      clock += SUPERVISOR_MESSAGE_V2_READINESS_OUTAGE_BOUND_MS - 1;
      await coordinator.recoverPending();
      expect(
        (await coordinator.status(scope, workflowId)).deliveryAttempts
      ).toBe(0);
      clock += 1;
      await coordinator.recoverPending();
      expect(
        (await coordinator.status(scope, workflowId)).deliveryAttempts
      ).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("SupervisorMessageV2 not-enrolled recipient deferral bound", () => {
  const target = "supervisor:target";
  const entered = (recipient: string) =>
    `V2 delivery to ${recipient} deferred: recipient session is not enrolled`;
  const exceeded = (recipient: string, boundMs: number) =>
    `V2 delivery to ${recipient} still deferred after ${boundMs}ms not enrolled: delivery attempts now fail`;
  const resumed = (recipient: string, afterMs: number) =>
    `V2 delivery to ${recipient} resumed after ${afterMs}ms: recipient session is enrolled and ready`;

  test("a not-enrolled recipient's deliveries wait without an attempt or a lease, then deliver once it is enrolled", async () => {
    const h = harness({ notEnrolledBoundMs: 60_000 });
    h.unready.add(target);
    h.notEnrolledSince.set(target, h.at().getTime());
    const { workflowId, projection } = await h.coordinator.receive(
      scope,
      inputFor("not-enrolled-wait"),
      "request:not-enrolled-wait"
    );
    expect(projection.deliveryAttempts).toBe(0);
    for (let sweep = 0; sweep < 3; sweep += 1) {
      h.advance(10_000);
      expect(await h.coordinator.recoverPending()).toBe(0);
    }
    const during = await h.status(workflowId);
    expect(during.phase).toBe("routed");
    expect(during.deliveryAttempts).toBe(0);
    expect(h.signals(workflowId)).toEqual([]);
    expect(h.ledger.deliveries.size).toBe(0);
    expect(h.notEnrolled.snapshot()).toEqual({
      boundMs: 60_000,
      deferredDeliveries: 4,
      notEnrolledFailures: 0,
      recipientsDeferred: 1,
    });

    // The sweep enrolls the seat: nothing waits on enrollment any more,
    // before any delivery observes it. Its next delivery goes through.
    h.notEnrolledSince.delete(target);
    expect(h.notEnrolled.snapshot().recipientsDeferred).toBe(0);
    h.unready.delete(target);
    h.advance(1000);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.logs).toEqual([entered(target), resumed(target, 31_000)]);
    expect(h.notEnrolled.snapshot().recipientsDeferred).toBe(0);
  });

  test("past its bound, measured from when the recipient stopped being enrolled, each delivery is a retryable attempt up to the policy bound", async () => {
    const h = harness({ notEnrolledBoundMs: 60_000 });
    h.unready.add(target);
    // The seat stopped being enrolled 50 seconds before this message.
    h.notEnrolledSince.set(target, h.at().getTime() - 50_000);
    const { workflowId } = await h.coordinator.receive(
      scope,
      inputFor("not-enrolled-bound"),
      "request:not-enrolled-bound"
    );
    h.advance(9999);
    expect(await h.coordinator.recoverPending()).toBe(0);
    expect((await h.status(workflowId)).deliveryAttempts).toBe(0);
    h.advance(1);
    expect(await h.coordinator.recoverPending()).toBe(1);
    expect(await h.status(workflowId)).toMatchObject({
      deliveryAttempts: 1,
      phase: "retry-scheduled",
    });
    // A normal attempt under a lease, with a fixed opaque reason.
    expect(h.ledger.deliveries.size).toBe(1);
    expect(h.signalPayloads(workflowId)).toEqual([
      {
        name: "delivery_failed",
        payload: {
          permanent: false,
          reason: "recipient session is not enrolled",
        },
      },
    ]);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      h.advance(500);
      await h.coordinator.recoverPending();
      expect((await h.status(workflowId)).deliveryAttempts).toBe(attempt);
    }
    expect((await h.status(workflowId)).phase).toBe("dead-lettered");
    expect(h.delivered).toHaveLength(0);
    expect(h.logs).toEqual([entered(target), exceeded(target, 60_000)]);
    expect(h.notEnrolled.snapshot()).toMatchObject({
      deferredDeliveries: 2,
      notEnrolledFailures: 5,
    });
  });

  test("the not-enrolled bound does not restart while a message waits on a long retry delay", async () => {
    const h = harness({ notEnrolledBoundMs: 60_000 });
    h.unready.add(target);
    h.notEnrolledSince.set(target, h.at().getTime());
    const input = inputFor("not-enrolled-long-retry");
    input.policy = { ...input.policy, retryDelayMs: 7_200_000 };
    const { workflowId } = await h.coordinator.receive(
      scope,
      input,
      "request:not-enrolled-long-retry"
    );
    h.advance(60_000);
    await h.coordinator.recoverPending();
    expect((await h.status(workflowId)).deliveryAttempts).toBe(1);
    h.advance(7_200_000);
    await h.coordinator.recoverPending();
    expect((await h.status(workflowId)).deliveryAttempts).toBe(2);
    expect(h.logs).toEqual([entered(target), exceeded(target, 60_000)]);
  });

  test("an enrolled recipient whose seat is not ready still spends an attempt", async () => {
    const h = harness({ notEnrolledBoundMs: 60_000 });
    h.unready.add(target);
    const { projection } = await h.coordinator.receive(
      scope,
      inputFor("enrolled-unready"),
      "request:enrolled-unready"
    );
    expect(projection.deliveryAttempts).toBe(1);
    expect(h.logs).toEqual([]);
    expect(h.notEnrolled.snapshot()).toEqual({
      boundMs: 60_000,
      deferredDeliveries: 0,
      notEnrolledFailures: 0,
      recipientsDeferred: 0,
    });
  });

  test("a not-enrolled recipient the store still finds ready is delivered", async () => {
    const h = harness({ notEnrolledBoundMs: 60_000 });
    h.notEnrolledSince.set(target, h.at().getTime());
    const { projection } = await h.coordinator.receive(
      scope,
      inputFor("not-enrolled-ready"),
      "request:not-enrolled-ready"
    );
    expect(projection.deliveryAttempts).toBe(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.notEnrolled.snapshot().deferredDeliveries).toBe(0);
  });

  test("the not-enrolled bound is a whole number of milliseconds from one second to one day, fifteen minutes by default", () => {
    expect(SUPERVISOR_MESSAGE_V2_NOT_ENROLLED_BOUND_MS).toBe(900_000);
    expect(
      new SupervisorMessageV2NotEnrolledDeferral().snapshot().boundMs
    ).toBe(900_000);
    for (const boundMs of [999, 86_400_001, 1500.5, Number.NaN]) {
      expect(
        () => new SupervisorMessageV2NotEnrolledDeferral({ boundMs })
      ).toThrow("V2 not-enrolled deferral bound is invalid");
    }
    // Without an enrollment port nothing is ever reported as not enrolled.
    expect(
      new SupervisorMessageV2NotEnrolledDeferral().unready(target, new Date())
    ).toBeUndefined();
  });
});

describe("SupervisorMessageV2 recovery with a foreign-owned workflow ID", () => {
  // A V2 workflow ID is unique per Temporal namespace, not per deployment.
  // When another deployment (its execution on another task queue) already
  // holds an ID this ledger recorded a start intent for, the Temporal port
  // refuses with its foreign-execution conflict. That one record must not
  // refuse the whole service start. (Another workflow type on this
  // deployment's own queue is a plain conflict and does refuse it.)
  const FOREIGN = "belongs to another task queue";
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
            new WorkflowForeignExecutionError(
              `workflow ${command.workflowId} ${FOREIGN}`
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
    const skipped = `V2 recovery skipped workflow ${s.foreignId} for supervisor:a-foreign: WorkflowError (conflict): workflow ${s.foreignId} ${FOREIGN}`;
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
      `workflow ${s.foreignId} ${FOREIGN}`
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
