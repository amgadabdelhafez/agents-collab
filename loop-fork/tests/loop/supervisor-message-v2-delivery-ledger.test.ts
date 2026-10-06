import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2DeliveryEnvelope,
  type SupervisorMessageV2Input,
  type TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import {
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryOutcome,
  supervisorMessageV2WorkflowDefinition,
} from "../../src/loop/supervisor-message-v2-runtime";
import {
  type WorkflowCancelCommand,
  WorkflowError,
  type WorkflowPort,
  type WorkflowPresence,
  type WorkflowQueryCommand,
  type WorkflowSignalCommand,
  type WorkflowStartCommand,
} from "../../src/loop/workflow-port";
import { DisposablePostgres } from "../support/disposable-postgres";

const fixture = structuredClone(supervisorMessageV2ReplayFixtures[0]);
if (!fixture) {
  throw new Error("missing V2 fixture");
}
const SCOPE: TrustedSupervisorMessageV2Scope = fixture.expectedScope;
const FOREIGN: TrustedSupervisorMessageV2Scope = {
  principal: "principal:foreign",
  tenantId: "tenant:foreign",
};
// Each recovery test creates a database; leave room for a loaded Docker host.
setDefaultTimeout(20_000);

const OWNER = "v2-dispatcher:ledger-postgres-test";
const NOW = new Date("2026-10-05T12:00:00.000Z");

const inputFor = (
  dedupeKey: string,
  maxDeliveryAttempts = 3,
  scope: TrustedSupervisorMessageV2Scope = SCOPE
): SupervisorMessageV2Input => ({
  ...structuredClone(fixture.input),
  dedupeKey,
  messageId: `message-${dedupeKey}`,
  policy: {
    claimTimeoutMs: 600_000,
    escalationTimeoutMs: 600_000,
    maxDeliveryAttempts,
    retryDelayMs: 1000,
  },
  principal: scope.principal,
  tenantId: scope.tenantId,
  threadId: `thread-${dedupeKey}`,
});

/** The same envelope the V2 workflow's `delivery_request` query issues. */
const envelopeFor = (
  scope: TrustedSupervisorMessageV2Scope,
  input: SupervisorMessageV2Input,
  deliveryAttempt: number
): SupervisorMessageV2DeliveryEnvelope => {
  const workflowId = deriveSupervisorMessageV2WorkflowId(
    scope,
    input.dedupeKey
  );
  const deliveryId = deriveSupervisorMessageV2DeliveryId(
    scope,
    workflowId,
    deliveryAttempt
  );
  return {
    artifactRefs: [...input.artifactRefs],
    body: input.body,
    deliveryAttempt,
    deliveryId,
    idempotencyKey: deliveryId,
    messageId: input.messageId,
    principal: scope.principal,
    schema: "supervisor-message-delivery.v2",
    target: input.to,
    tenantId: scope.tenantId,
    threadId: input.threadId,
    workflowId,
  };
};

/**
 * An in-memory engine with Temporal's retention behavior: only a closed
 * execution can be purged, and a purged ID is unknown, so starting it again
 * creates a fresh execution. Every start is recorded.
 *
 * Unlike the generic Temporal workflow, which stays RUNNING after the message
 * reaches a terminal phase until the engine terminates, cancels or times it
 * out, this engine closes an execution as soon as its message ends. That is
 * the harsher model for retention: every ended message is purgeable. The
 * real-Temporal paths are in supervisor-message-v2-temporal-retention.test.ts.
 */
class RetentionWorkflowPort implements WorkflowPort {
  readonly live: InMemoryWorkflowPort;
  readonly reborn: InMemoryWorkflowPort;
  readonly purged = new Set<string>();
  readonly starts: string[] = [];

  constructor() {
    const options = {
      definitions: [supervisorMessageV2WorkflowDefinition],
      now: () => NOW.toISOString(),
    };
    this.live = new InMemoryWorkflowPort(options);
    this.reborn = new InMemoryWorkflowPort(options);
  }

  purge(workflowId: string): void {
    if (this.presence(workflowId) !== "closed") {
      throw new Error("retention purges only a closed execution");
    }
    this.purged.add(workflowId);
  }

  presence(workflowId: string): WorkflowPresence {
    try {
      return this.#port(workflowId).inspect(workflowId).status === "running"
        ? "running"
        : "closed";
    } catch (error) {
      if (error instanceof WorkflowError && error.code === "not-found") {
        return "missing";
      }
      throw error;
    }
  }

  isClosed(workflowId: string): boolean {
    return this.presence(workflowId) === "closed";
  }

  cancel(command: WorkflowCancelCommand) {
    return this.#port(command.workflowId).cancel(command);
  }

  inspect(workflowId: string) {
    return this.#port(workflowId).inspect(workflowId);
  }

  query(command: WorkflowQueryCommand) {
    return this.#port(command.workflowId).query(command);
  }

  signal(command: WorkflowSignalCommand) {
    return this.#port(command.workflowId).signal(command);
  }

  start(command: WorkflowStartCommand) {
    this.starts.push(command.workflowId);
    return this.#port(command.workflowId).start(command);
  }

  #port(workflowId: string): InMemoryWorkflowPort {
    return this.purged.has(workflowId) ? this.reborn : this.live;
  }
}

let postgres: DisposablePostgres;
let ledger: PostgresSupervisorMessageV2DeliveryLedger;
let raw: SQL;
const opened: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
  ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    postgres.databaseUrl()
  );
  await ledger.migrate();
  raw = new SQL(postgres.databaseUrl());
  await raw.connect();
}, 60_000);

afterAll(async () => {
  for (const resource of opened.reverse()) {
    await resource.close().catch(() => undefined);
  }
  await raw?.close({ timeout: 0 });
  await ledger?.close();
  await postgres?.close();
});

/** A database of its own, so one test's start intents never reach another's sweep. */
const freshDatabase = async (): Promise<string> => {
  const name = `ledger_${randomUUID().replaceAll("-", "")}`;
  await raw.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(postgres.databaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
};

const freshLedger =
  async (): Promise<PostgresSupervisorMessageV2DeliveryLedger> => {
    const isolated = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      await freshDatabase()
    );
    opened.push(isolated);
    await isolated.migrate();
    return isolated;
  };

const harness = async (
  outcome: () => SupervisorMessageV2DeliveryOutcome = () => ({
    status: "accepted",
  })
) => {
  const ledger = await freshLedger();
  const workflows = new RetentionWorkflowPort();
  const delivered: string[] = [];
  const coordinator = new SupervisorMessageV2Coordinator(
    workflows,
    {
      deliver(envelope) {
        delivered.push(envelope.deliveryId);
        return Promise.resolve(outcome());
      },
    },
    ledger,
    OWNER,
    () => NOW
  );
  return { coordinator, delivered, ledger, workflows };
};

const workflowIdOf = (input: SupervisorMessageV2Input) =>
  deriveSupervisorMessageV2WorkflowId(SCOPE, input.dedupeKey);

describe("V2 delivery ledger on PostgreSQL", () => {
  test("stores a bound envelope as a JSON string scalar, which a JSON path cannot read", async () => {
    const input = inputFor(`jsonb-shape-${randomUUID()}`);
    const workflowId = workflowIdOf(input);
    await ledger.recordStartIntent(workflowId, SCOPE, input);
    await ledger.prepare(envelopeFor(SCOPE, input, 1), SCOPE);

    const rows = await raw<
      { kind: string; path: string | null }[]
    >`SELECT jsonb_typeof(envelope_json) AS kind, envelope_json->>'workflowId' AS path FROM loop_supervisor_message_v2_delivery_ledger WHERE delivery_id = ${deriveSupervisorMessageV2DeliveryId(SCOPE, workflowId, 1)}`;

    expect(rows).toEqual([{ kind: "string", path: null }]);
  });

  test("finds a delivery completed on a later attempt through the production claim path", async () => {
    const input = inputFor(`completed-attempt-${randomUUID()}`, 5);
    const workflowId = workflowIdOf(input);
    await ledger.recordStartIntent(workflowId, SCOPE, input);
    const third = envelopeFor(SCOPE, input, 3);
    const claim = await ledger.claim(third, SCOPE, OWNER, NOW, 30_000);
    expect(claim.state).toBe("claimed");

    await expect(ledger.hasCompletedDelivery(workflowId, SCOPE)).resolves.toBe(
      false
    );
    await ledger.completeClaim(third, SCOPE, OWNER, claim.fence);

    await expect(ledger.hasCompletedDelivery(workflowId, SCOPE)).resolves.toBe(
      true
    );
    await expect(
      ledger.hasCompletedDelivery(workflowId, FOREIGN)
    ).resolves.toBe(false);
  });

  test("does not count a completion recorded under another trusted scope", async () => {
    const input = inputFor(`foreign-completion-${randomUUID()}`, 3, FOREIGN);
    const foreignWorkflowId = deriveSupervisorMessageV2WorkflowId(
      FOREIGN,
      input.dedupeKey
    );
    await ledger.recordStartIntent(foreignWorkflowId, FOREIGN, input);
    const envelope = envelopeFor(FOREIGN, input, 1);
    const claim = await ledger.claim(envelope, FOREIGN, OWNER, NOW, 30_000);
    await ledger.completeClaim(envelope, FOREIGN, OWNER, claim.fence);

    await expect(
      ledger.hasCompletedDelivery(foreignWorkflowId, FOREIGN)
    ).resolves.toBe(true);
    await expect(
      ledger.hasCompletedDelivery(foreignWorkflowId, SCOPE)
    ).resolves.toBe(false);
  });

  test("records a terminal outcome once, in its own scope only", async () => {
    const input = inputFor(`terminal-scope-${randomUUID()}`);
    const workflowId = workflowIdOf(input);
    await ledger.recordStartIntent(workflowId, SCOPE, input);

    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      undefined
    );
    await expect(
      ledger.recordTerminalOutcome(workflowId, FOREIGN, "canceled")
    ).rejects.toThrow();
    await expect(
      ledger.recordTerminalOutcome(
        workflowId,
        SCOPE,
        "reopened" as unknown as "canceled"
      )
    ).rejects.toThrow("terminal outcome is invalid");

    await ledger.recordTerminalOutcome(workflowId, SCOPE, "exhausted");
    await ledger.recordTerminalOutcome(workflowId, SCOPE, "acknowledged");

    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      "exhausted"
    );
    await expect(ledger.terminalOutcome(workflowId, FOREIGN)).resolves.toBe(
      undefined
    );
  });

  test("refuses to claim a delivery of a workflow whose terminal outcome is recorded", async () => {
    const input = inputFor(`terminal-claim-${randomUUID()}`);
    const workflowId = workflowIdOf(input);
    await ledger.recordStartIntent(workflowId, SCOPE, input);
    const first = envelopeFor(SCOPE, input, 1);
    const claim = await ledger.claim(first, SCOPE, OWNER, NOW, 30_000);
    expect(claim.state).toBe("claimed");
    await ledger.recordTerminalOutcome(workflowId, SCOPE, "dead-lettered");

    const afterLease = new Date(NOW.getTime() + 60_000);
    await expect(
      ledger.claim(first, SCOPE, OWNER, afterLease, 30_000)
    ).resolves.toEqual({ fence: 0, state: "closed" });
    await expect(
      ledger.claim(envelopeFor(SCOPE, input, 2), SCOPE, OWNER, afterLease, 1)
    ).resolves.toEqual({ fence: 0, state: "closed" });
  });

  test("migrates a ledger created before the terminal marker without losing rows", async () => {
    const databaseUrl = await freshDatabase();
    const legacySql = new SQL(databaseUrl);
    opened.push({ close: () => legacySql.close({ timeout: 0 }) });
    await legacySql.connect();
    await legacySql`CREATE TABLE loop_supervisor_message_v2_start_intent (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, input_json JSONB NOT NULL)`;
    const legacy =
      await PostgresSupervisorMessageV2DeliveryLedger.connect(databaseUrl);
    try {
      const input = inputFor(`legacy-${randomUUID()}`);
      const workflowId = workflowIdOf(input);
      await legacySql`INSERT INTO loop_supervisor_message_v2_start_intent VALUES (${workflowId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(input)}::jsonb)`;

      await legacy.migrate();
      await legacy.migrate();

      expect(
        (await legacy.recoverableStarts()).map((start) => start.workflowId)
      ).toEqual([workflowId]);
      await expect(legacy.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
        undefined
      );
      await legacy.recordTerminalOutcome(workflowId, SCOPE, "canceled");
      await expect(legacy.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
        "canceled"
      );
      // A Bun SQL query runs only once `then` is called; settle it explicitly.
      const reopened =
        await legacySql`UPDATE loop_supervisor_message_v2_start_intent SET terminal_outcome = 'reopened'`.then(
          () => "accepted",
          () => "rejected by the CHECK constraint"
        );
      expect(reopened).toBe("rejected by the CHECK constraint");
      // A delivery/read acknowledgement is never stored as work completion.
      const completed =
        await legacySql`UPDATE loop_supervisor_message_v2_start_intent SET terminal_outcome = 'completed'`.then(
          () => "accepted",
          () => "rejected by the CHECK constraint"
        );
      expect(completed).toBe("rejected by the CHECK constraint");
    } finally {
      await legacy.close();
    }
  });
});

describe("V2 recovery against retention on PostgreSQL", () => {
  test("does not restart a purged workflow whose attempts were exhausted", async () => {
    const { coordinator, delivered, ledger, workflows } = await harness(() => ({
      reason: "provider unavailable",
      status: "transient-failure",
    }));
    const input = inputFor(`exhausted-${randomUUID()}`, 1);
    const workflowId = workflowIdOf(input);
    await coordinator.receive(SCOPE, input, "exhausted-receive");
    expect(workflows.presence(workflowId)).toBe("closed");
    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      "exhausted"
    );

    workflows.purge(workflowId);
    await coordinator.recoverPending();

    expect(workflows.starts).toEqual([workflowId]);
    expect(delivered).toHaveLength(1);
    await expect(
      coordinator.receive(SCOPE, input, "exhausted-sender-retry")
    ).rejects.toMatchObject({ code: "conflict", name: "WorkflowError" });
    expect(workflows.starts).toEqual([workflowId]);
    expect(delivered).toHaveLength(1);
  });

  test("does not restart a purged workflow that was dead-lettered by a permanent failure", async () => {
    const { coordinator, delivered, ledger, workflows } = await harness(() => ({
      reason: "recipient rejected the message",
      status: "permanent-failure",
    }));
    const input = inputFor(`dead-lettered-${randomUUID()}`, 5);
    const workflowId = workflowIdOf(input);
    await coordinator.receive(SCOPE, input, "dead-letter-receive");
    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      "dead-lettered"
    );

    workflows.purge(workflowId);
    await coordinator.recoverPending();

    expect(workflows.starts).toEqual([workflowId]);
    expect(delivered).toHaveLength(1);
  });

  test("records a cancellation the sweep observes and keeps the purged workflow closed", async () => {
    const { coordinator, delivered, ledger, workflows } = await harness();
    const input = inputFor(`canceled-${randomUUID()}`, 3);
    const workflowId = workflowIdOf(input);
    // Started, then canceled before any delivery was attempted: no delivery
    // row exists, so only a terminal marker can tell it from a lost start.
    await ledger.recordStartIntent(workflowId, SCOPE, input);
    workflows.start({
      input: { input, trustedScope: SCOPE },
      requestId: "cancel-start",
      workflowId,
      workflowType: "supervisor-message.v2",
    });
    workflows.cancel({
      reason: "operator",
      requestId: "operator-cancel",
      workflowId,
    });
    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      undefined
    );

    await coordinator.recoverPending();
    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      "canceled"
    );
    workflows.purge(workflowId);
    await coordinator.recoverPending();

    expect(workflows.starts).toEqual([workflowId]);
    expect(delivered).toEqual([]);
  });

  test("does not restart a purged workflow whose delivery completed, from PostgreSQL rows alone", async () => {
    const { coordinator, delivered, ledger, workflows } = await harness();
    const input = inputFor(`delivered-${randomUUID()}`);
    const workflowId = workflowIdOf(input);
    await coordinator.receive(SCOPE, input, "delivered-receive");
    // Closed outside this host, before any sweep could record an outcome.
    workflows.cancel({
      reason: "operator",
      requestId: "operator-cancel",
      workflowId,
    });
    workflows.purge(workflowId);
    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      undefined
    );

    await coordinator.recoverPending();

    expect(workflows.starts).toEqual([workflowId]);
    expect(delivered).toHaveLength(1);
  });

  test("still starts a recorded intent that never reached the engine", async () => {
    const { coordinator, delivered, ledger, workflows } = await harness();
    const input = inputFor(`never-started-${randomUUID()}`);
    const workflowId = workflowIdOf(input);
    await ledger.recordStartIntent(workflowId, SCOPE, input);

    await coordinator.recoverPending();

    expect(workflows.starts).toContain(workflowId);
    expect(delivered).toEqual([
      deriveSupervisorMessageV2DeliveryId(SCOPE, workflowId, 1),
    ]);
  });

  test("records acknowledgement, not completion, when the recipient acknowledges", async () => {
    const { coordinator, ledger } = await harness();
    const input = inputFor(`acknowledged-${randomUUID()}`);
    const workflowId = workflowIdOf(input);
    await coordinator.receive(SCOPE, input, "ack-receive");
    await coordinator.claim(SCOPE, workflowId, input.to, "ack-claim");
    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      undefined
    );

    await coordinator.acknowledge(SCOPE, workflowId, input.to, "ack-ack");

    await expect(ledger.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      "acknowledged"
    );
  });

  test("a resurrected execution cannot deliver once a terminal outcome is recorded", async () => {
    const { coordinator, delivered, ledger, workflows } = await harness();
    const input = inputFor(`resurrected-${randomUUID()}`);
    const workflowId = workflowIdOf(input);
    // As an earlier recovery could leave it: the outcome is recorded, yet a
    // fresh execution of the same ID is running with a delivery pending.
    await ledger.recordStartIntent(workflowId, SCOPE, input);
    await ledger.recordTerminalOutcome(workflowId, SCOPE, "exhausted");
    workflows.start({
      input: { input, trustedScope: SCOPE },
      requestId: "resurrected-start",
      workflowId,
      workflowType: "supervisor-message.v2",
    });

    await coordinator.receive(SCOPE, input, "resurrected-sender-retry");

    expect(delivered).toEqual([]);
  });
});
