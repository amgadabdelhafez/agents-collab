// A V2 send answers once the message is durably accepted, never after its
// delivery attempt.
//
// On 2026-10-11 successive live sends (supervisor:harness-desktop to
// supervisor:portfolio-coordinator, both mailbox-only) answered in about 3 s,
// 15 s, 18 s and 66 s, though every one was delivered. The server answered a
// send only after its first delivery attempt: readiness, the delivery lease,
// the mailbox write, the outcome signal and its observation queries, each a
// round trip to PostgreSQL or Temporal. Its 30 s recovery sweep meanwhile
// re-walked every message not yet acknowledged (none of the mailbox-only
// recipients acknowledges through V2) with a redundant start adoption and a
// delivery_pending query each, on the same worker and database. These tests
// hold both to account: the answer waits on neither the delivery nor the
// number of messages already accepted, and a sweep over delivered messages
// asks the engine only what it needs.

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
  type SupervisorMessageV2DeliveryOutcome,
  type SupervisorMessageV2TerminalOutcome,
  supervisorMessageV2WorkflowDefinition,
} from "../../src/loop/supervisor-message-v2-runtime";
import type {
  WorkflowCancelCommand,
  WorkflowCommandReceipt,
  WorkflowInspection,
  WorkflowPort,
  WorkflowPresence,
  WorkflowQueryCommand,
  WorkflowQueryResult,
  WorkflowSignalCommand,
  WorkflowStartCommand,
  WorkflowStartReceipt,
} from "../../src/loop/workflow-port";

const fixture = structuredClone(supervisorMessageV2ReplayFixtures[0]);
if (!fixture) {
  throw new Error("missing V2 tenant-scope fixture");
}
const scope: TrustedSupervisorMessageV2Scope = fixture.expectedScope;
const DEPLOYMENT = "send-latency-queue";
const LEASE_MS = 30_000;
/** The answer bound a sender may rely on, whatever the delivery costs. */
const SEND_BOUND_MS = 2000;
/** A delivery slower than the bound: the r9b send answered after it. */
const SLOW_DELIVERY_MS = 3000;

const inputFor = (dedupeKey: string): SupervisorMessageV2Input => ({
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
  to: "supervisor:portfolio-coordinator",
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The Postgres ledger's lease semantics, in memory, every call counted. */
class MemoryLedger implements SupervisorMessageV2DeliveryLedger {
  readonly deployment = DEPLOYMENT;
  calls = 0;
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
  readonly terminal = new Map<string, SupervisorMessageV2TerminalOutcome>();

  workflowIdFor(
    trustedScope: TrustedSupervisorMessageV2Scope,
    dedupeKey: string
  ): Promise<string> {
    this.calls += 1;
    return Promise.resolve(
      deriveSupervisorMessageV2WorkflowId(trustedScope, dedupeKey, DEPLOYMENT)
    );
  }

  assertStartIntent(workflowId: string): Promise<void> {
    this.calls += 1;
    return this.starts.has(workflowId)
      ? Promise.resolve()
      : Promise.reject(new Error("start intent is absent"));
  }

  startIntent(workflowId: string): Promise<SupervisorMessageV2Input> {
    this.calls += 1;
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
    this.calls += 1;
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
    this.calls += 1;
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
    this.calls += 1;
    const existing = this.starts.get(workflowId);
    if (existing) {
      return Promise.resolve(existing.input);
    }
    this.starts.set(workflowId, { input, trustedScope });
    return Promise.resolve(input);
  }

  hasCompletedDelivery(): Promise<boolean> {
    this.calls += 1;
    return Promise.resolve(false);
  }

  recordTerminalOutcome(
    workflowId: string,
    _trustedScope: TrustedSupervisorMessageV2Scope,
    outcome: SupervisorMessageV2TerminalOutcome
  ): Promise<void> {
    this.calls += 1;
    if (!this.terminal.has(workflowId)) {
      this.terminal.set(workflowId, outcome);
    }
    return Promise.resolve();
  }

  terminalOutcome(
    workflowId: string
  ): Promise<SupervisorMessageV2TerminalOutcome | undefined> {
    this.calls += 1;
    return Promise.resolve(this.terminal.get(workflowId));
  }

  recoverableStarts() {
    this.calls += 1;
    return Promise.resolve(
      [...this.starts.entries()]
        .filter(([workflowId]) => !this.terminal.has(workflowId))
        .map(([workflowId, start]) => ({ ...start, workflowId }))
    );
  }
}

/**
 * An engine-like port: it answers presence, as the Temporal port does, and
 * every call costs `latencyMs` and is recorded by kind.
 */
class EngineLikePort implements WorkflowPort {
  readonly calls: string[] = [];
  latencyMs = 0;
  readonly #engine = new InMemoryWorkflowPort({
    definitions: [supervisorMessageV2WorkflowDefinition],
  });

  async #cost(kind: string): Promise<void> {
    this.calls.push(kind);
    if (this.latencyMs > 0) {
      await sleep(this.latencyMs);
    }
  }

  cancel(command: WorkflowCancelCommand): WorkflowCommandReceipt {
    return this.#engine.cancel(command);
  }

  inspect(workflowId: string): WorkflowInspection {
    return this.#engine.inspect(workflowId);
  }

  async presence(workflowId: string): Promise<WorkflowPresence> {
    await this.#cost("presence");
    try {
      const status = this.#engine.inspect(workflowId).status;
      return status === "running" ? "running" : "closed";
    } catch {
      return "missing";
    }
  }

  async start(command: WorkflowStartCommand): Promise<WorkflowStartReceipt> {
    await this.#cost("start");
    return this.#engine.start(command);
  }

  async query(command: WorkflowQueryCommand): Promise<WorkflowQueryResult> {
    await this.#cost(`query:${command.name}`);
    return this.#engine.query(command);
  }

  async signal(
    command: WorkflowSignalCommand
  ): Promise<WorkflowCommandReceipt> {
    await this.#cost(`signal:${command.name}`);
    return this.#engine.signal(command);
  }
}

const OWNER = "v2-dispatcher:send-latency-test";

const harness = (
  deliver: (
    envelope: SupervisorMessageV2DeliveryEnvelope
  ) => Promise<SupervisorMessageV2DeliveryOutcome>
) => {
  const workflows = new EngineLikePort();
  const ledger = new MemoryLedger();
  const logs: string[] = [];
  const coordinator = new SupervisorMessageV2Coordinator(
    workflows,
    { deliver },
    ledger,
    OWNER,
    () => new Date(),
    {
      assertReady: () => Promise.resolve({ status: "ready" }),
    },
    undefined,
    undefined,
    { log: (line) => logs.push(line) }
  );
  return { coordinator, ledger, logs, workflows };
};

/** How long `run` takes to settle, in milliseconds. */
const timed = async <T>(run: () => Promise<T>) => {
  const startedAt = performance.now();
  const value = await run();
  return { ms: performance.now() - startedAt, value };
};

describe("a V2 send answers on durable acceptance, not on its delivery attempt", () => {
  test("a send whose delivery takes longer than the bound answers within it, SUBMITTED and neither delivered nor acknowledged; the delivery then completes once", async () => {
    let attempts = 0;
    const h = harness(async () => {
      attempts += 1;
      await sleep(SLOW_DELIVERY_MS);
      return { status: "accepted" };
    });

    const { ms, value } = await timed(() =>
      h.coordinator.receive(scope, inputFor("slow-delivery"), "request:slow")
    );

    expect(ms).toBeLessThan(SEND_BOUND_MS);
    expect(value.created).toBe(true);
    // Accepted durably: the start intent and the execution both exist.
    expect(h.ledger.starts.has(value.workflowId)).toBe(true);
    expect(h.workflows.inspect(value.workflowId).status).toBe("running");
    // The answer is an acceptance: nothing delivered, nothing acknowledged.
    expect(value.projection.phase).toBe("routed");
    expect(value.projection.deliveredAt).toBeNull();
    expect(value.projection.acknowledgedAt).toBeNull();

    await h.coordinator.idle();
    expect(attempts).toBe(1);
    const after = await h.coordinator.status(scope, value.workflowId);
    expect(after.deliveredAt).toBeString();
    // Delivery is not acknowledgement: only the recipient acknowledges.
    expect(after.acknowledgedAt).toBeNull();
    // Delivered and routed: waiting on the recipient's claim.
    expect(after.phase).toBe("routed");
  }, 20_000);

  test("repeated sends do not get slower: each answers within the bound, and the engine and ledger calls a send makes do not grow with the messages already accepted", async () => {
    const h = harness(async () => {
      await sleep(SLOW_DELIVERY_MS);
      return { status: "accepted" };
    });
    // Every engine call costs a little, as a remote one does.
    h.workflows.latencyMs = 5;
    const answers: number[] = [];
    const engineCalls: number[] = [];
    const ledgerCalls: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const engineBefore = h.workflows.calls.length;
      const ledgerBefore = h.ledger.calls;
      const { ms } = await timed(() =>
        h.coordinator.receive(
          scope,
          inputFor(`repeat-${index}`),
          `request:repeat-${index}`
        )
      );
      answers.push(ms);
      engineCalls.push(h.workflows.calls.length - engineBefore);
      ledgerCalls.push(h.ledger.calls - ledgerBefore);
      // The recovery sweep runs between sends, as the live 30 s timer does,
      // over every message accepted so far.
      await h.coordinator.recoverPending();
    }
    for (const ms of answers) {
      expect(ms).toBeLessThan(SEND_BOUND_MS);
    }
    // The last send is no slower than the first, give or take scheduling.
    expect(answers.at(-1) as number).toBeLessThan(
      (answers[0] as number) * 2 + 100
    );
    // Structurally flat: the same calls for the first send and the sixth.
    expect(new Set(engineCalls).size).toBe(1);
    expect(new Set(ledgerCalls).size).toBe(1);
    await h.coordinator.idle();
  }, 30_000);

  test("a sender retry while the first delivery is still in flight answers at once with the same workflow and the message is delivered exactly once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    const h = harness(async (envelope) => {
      await gate;
      delivered.push(envelope.deliveryId);
      return { status: "accepted" };
    });
    const input = inputFor("retry-in-flight");

    const first = await timed(() =>
      h.coordinator.receive(scope, input, "request:first")
    );
    const retry = await timed(() =>
      h.coordinator.receive(scope, input, "request:first")
    );

    expect(first.ms).toBeLessThan(SEND_BOUND_MS);
    expect(retry.ms).toBeLessThan(SEND_BOUND_MS);
    expect(retry.value.workflowId).toBe(first.value.workflowId);
    expect(retry.value.created).toBe(false);
    release();
    await h.coordinator.idle();
    expect(delivered).toHaveLength(1);
    expect(
      (await h.coordinator.status(scope, first.value.workflowId)).deliveredAt
    ).toBeString();
  }, 20_000);

  test("a delivery attempt that throws after the answer is logged, spends one attempt, and leaves the message for recovery", async () => {
    let fail = true;
    const h = harness(() => {
      if (fail) {
        return Promise.reject(new Error("mailbox write failed"));
      }
      return Promise.resolve({ status: "accepted" as const });
    });

    const sent = await h.coordinator.receive(
      scope,
      inputFor("fails-later"),
      "request:fails-later"
    );
    expect(sent.projection.phase).toBe("routed");
    await h.coordinator.idle();

    const failed = await h.coordinator.status(scope, sent.workflowId);
    expect(failed.phase).toBe("retry-scheduled");
    expect(failed.deliveryAttempts).toBe(1);
    expect(h.ledger.terminal.has(sent.workflowId)).toBe(false);

    // The durable path converges it: the next due sweep delivers it.
    fail = false;
    await sleep(600);
    await h.coordinator.recoverPending();
    expect(
      (await h.coordinator.status(scope, sent.workflowId)).deliveredAt
    ).toBeString();
  }, 20_000);

  test("a background delivery that fails outside the attempt itself is logged, never raised to the sender", async () => {
    const h = harness(() => Promise.resolve({ status: "accepted" as const }));
    // The ledger is unreachable for the lease claim: the attempt fails
    // before any provider call, after the send has been answered.
    h.ledger.claim = (() =>
      Promise.reject(new Error("ledger unavailable"))) as MemoryLedger["claim"];

    const sent = await h.coordinator.receive(
      scope,
      inputFor("ledger-down"),
      "request:ledger-down"
    );
    expect(sent.projection.phase).toBe("routed");
    await h.coordinator.idle();

    expect(h.logs.some((line) => line.includes(sent.workflowId))).toBe(true);
    expect(h.logs.join("\n")).toContain("ledger unavailable");
    // Still pending: recovery retries it.
    expect(
      (await h.coordinator.status(scope, sent.workflowId)).deliveredAt
    ).toBeNull();
  }, 20_000);
});

describe("the recovery sweep over delivered, unacknowledged messages", () => {
  test("asks the engine one state query per message, not separate status and delivery_pending queries", async () => {
    const h = harness(() => Promise.resolve({ status: "accepted" as const }));
    for (let index = 0; index < 4; index += 1) {
      await h.coordinator.receive(
        scope,
        inputFor(`swept-${index}`),
        `request:swept-${index}`
      );
    }
    await h.coordinator.idle();
    // Delivered, so still routed and waiting on the recipient's claim.
    for (const workflowId of h.ledger.starts.keys()) {
      expect(
        (await h.coordinator.status(scope, workflowId)).deliveredAt
      ).toBeString();
    }
    h.workflows.calls.length = 0;

    await h.coordinator.recoverPending();

    // Presence, the start adoption that proves the execution is this
    // deployment's own, and one query for both status and pending delivery.
    expect([...h.workflows.calls].sort()).toEqual(
      [
        ...new Array(4).fill("presence"),
        ...new Array(4).fill("query:recovery_status"),
        ...new Array(4).fill("start"),
      ].sort()
    );
  });

  test("a sweep still delivers a routed message whose delivery is pending, and retries one whose retry is due", async () => {
    let fail = true;
    const delivered: string[] = [];
    const h = harness((envelope) => {
      if (fail) {
        return Promise.resolve({
          reason: "seat busy",
          status: "transient-failure" as const,
        });
      }
      delivered.push(envelope.deliveryId);
      return Promise.resolve({ status: "accepted" as const });
    });
    const sent = await h.coordinator.receive(
      scope,
      inputFor("retry-due"),
      "request:retry-due"
    );
    await h.coordinator.idle();
    expect((await h.coordinator.status(scope, sent.workflowId)).phase).toBe(
      "retry-scheduled"
    );
    fail = false;
    await sleep(600);

    await h.coordinator.recoverPending();

    expect(delivered).toHaveLength(1);
    expect(
      (await h.coordinator.status(scope, sent.workflowId)).deliveredAt
    ).toBeString();
  });

  test("still starts an execution whose intent was recorded but never started, and delivers it", async () => {
    const delivered: string[] = [];
    const h = harness((envelope) => {
      delivered.push(envelope.deliveryId);
      return Promise.resolve({ status: "accepted" as const });
    });
    const input = inputFor("never-started");
    const workflowId = deriveSupervisorMessageV2WorkflowId(
      scope,
      "never-started",
      DEPLOYMENT
    );
    // The process stopped between the ledger write and the engine start.
    h.ledger.starts.set(workflowId, { input, trustedScope: scope });

    await h.coordinator.recoverPending();

    expect(h.workflows.calls).toContain("start");
    expect(delivered).toHaveLength(1);
  });
});
