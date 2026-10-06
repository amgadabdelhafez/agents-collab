import {
  afterAll,
  afterEach,
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
  deriveSupervisorMessageV2LegacyWorkflowId,
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
  SupervisorMessageV2RecoveryRunner,
  SupervisorMessageV2RecoveryStartupError,
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
/** This ledger's deployment discriminator (its host's task queue). */
const DEPLOYMENT = "ledger-test-queue";
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
    input.dedupeKey,
    DEPLOYMENT
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
    postgres.databaseUrl(),
    { deployment: DEPLOYMENT }
  );
  await ledger.migrate();
  raw = new SQL(postgres.databaseUrl());
  await raw.connect();
}, 60_000);

/** Each ledger holds a connection pool; release them before the server's limit. */
const closeOpened = async () => {
  for (const resource of opened.splice(0).reverse()) {
    await resource.close().catch(() => undefined);
  }
};

afterEach(closeOpened);

afterAll(async () => {
  await closeOpened();
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
      await freshDatabase(),
      { deployment: DEPLOYMENT }
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
  deriveSupervisorMessageV2WorkflowId(SCOPE, input.dedupeKey, DEPLOYMENT);
const legacyWorkflowIdOf = (input: SupervisorMessageV2Input) =>
  deriveSupervisorMessageV2LegacyWorkflowId(SCOPE, input.dedupeKey);

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
      input.dedupeKey,
      DEPLOYMENT
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
    const legacy = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      { deployment: DEPLOYMENT }
    );
    try {
      const input = inputFor(`legacy-${randomUUID()}`);
      // A table this old predates the deployment discriminator too.
      const workflowId = legacyWorkflowIdOf(input);
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

/**
 * The workflow id format change. A pre-discriminator host recorded intents
 * (no `deployment` column) and started executions under the legacy id. These
 * tests write such rows exactly as that host did and prove the new ledger and
 * coordinator recover, acknowledge and deduplicate them under the legacy id,
 * and never start the same message a second time under the new format.
 */
describe("V2 workflow id deployment discriminator on PostgreSQL", () => {
  /** The pre-discriminator schema and row, as the previous host wrote them. */
  const legacyDatabase = async (input: SupervisorMessageV2Input) => {
    const databaseUrl = await freshDatabase();
    const legacySql = new SQL(databaseUrl);
    opened.push({ close: () => legacySql.close({ timeout: 0 }) });
    await legacySql.connect();
    await legacySql`CREATE TABLE loop_supervisor_message_v2_start_intent (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, input_json JSONB NOT NULL, terminal_outcome TEXT CHECK (terminal_outcome IN ('acknowledged', 'canceled', 'dead-lettered', 'exhausted', 'terminated')), terminal_at TIMESTAMPTZ)`;
    const legacyId = legacyWorkflowIdOf(input);
    await legacySql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json) VALUES (${legacyId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(input)}::jsonb)`;
    const upgraded = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      { deployment: DEPLOYMENT }
    );
    opened.push(upgraded);
    await upgraded.migrate();
    return { legacyId, legacySql, upgraded };
  };

  const coordinatorOver = (
    ledger: PostgresSupervisorMessageV2DeliveryLedger
  ) => {
    const workflows = new RetentionWorkflowPort();
    const delivered: string[] = [];
    const coordinator = new SupervisorMessageV2Coordinator(
      workflows,
      {
        deliver(envelope) {
          delivered.push(envelope.deliveryId);
          return Promise.resolve({ status: "accepted" });
        },
      },
      ledger,
      OWNER,
      () => NOW
    );
    return { coordinator, delivered, workflows };
  };

  test("refuses a missing or invalid deployment at connect", async () => {
    for (const options of [
      undefined,
      {},
      { deployment: "" },
      { deployment: "queue with spaces" },
    ]) {
      const refused = await PostgresSupervisorMessageV2DeliveryLedger.connect(
        postgres.databaseUrl(),
        options as unknown as { deployment: string }
      ).then(
        async (opened) => {
          await opened.close();
          return "connected";
        },
        (error: Error) => error.message
      );
      expect(refused).toBe("V2 delivery ledger deployment is invalid");
    }
    expect(ledger.deployment).toBe(DEPLOYMENT);
  });

  test("migrates a pre-discriminator row in place: legacy id kept, deployment NULL, recoverable and authorized", async () => {
    const input = inputFor(`legacy-row-${randomUUID()}`);
    const { legacyId, legacySql, upgraded } = await legacyDatabase(input);
    await upgraded.migrate();

    const rows = await legacySql<
      { deployment: string | null; workflow_id: string }[]
    >`SELECT workflow_id, deployment FROM loop_supervisor_message_v2_start_intent`;
    expect(rows).toEqual([{ deployment: null, workflow_id: legacyId }]);
    expect(
      (await upgraded.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual([legacyId]);
    expect((await upgraded.startIntent(legacyId, SCOPE)).dedupeKey).toBe(
      input.dedupeKey
    );
    expect(
      await upgraded.recipientAssignment({
        recipient: input.to,
        tenantId: SCOPE.tenantId,
        workflowId: legacyId,
      })
    ).toEqual(SCOPE);
    expect(await upgraded.workflowIdFor(SCOPE, input.dedupeKey)).toBe(legacyId);
    // Another scope never resolves to this scope's legacy row.
    expect(await upgraded.workflowIdFor(FOREIGN, input.dedupeKey)).toBe(
      deriveSupervisorMessageV2WorkflowId(FOREIGN, input.dedupeKey, DEPLOYMENT)
    );
  });

  test("a message accepted under the legacy id is not started twice across the format change", async () => {
    const input = inputFor(`legacy-dedupe-${randomUUID()}`);
    const { legacyId, upgraded } = await legacyDatabase(input);
    const { coordinator, delivered, workflows } = coordinatorOver(upgraded);
    // The previous host started the execution under the legacy id and the
    // first delivery attempt went out.
    workflows.start({
      input: { input, trustedScope: SCOPE },
      requestId: "legacy-host-start",
      workflowId: legacyId,
      workflowType: "supervisor-message.v2",
    });
    expect(await coordinator.recoverPending()).toBe(1);
    expect(delivered).toEqual([
      deriveSupervisorMessageV2DeliveryId(SCOPE, legacyId, 1),
    ]);

    // The sender retries the same dedupe key after the upgrade.
    const retried = await coordinator.receive(SCOPE, input, "sender-retry");

    expect(retried.workflowId).toBe(legacyId);
    expect(retried.created).toBe(false);
    expect(workflows.starts.filter((id) => id !== legacyId)).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(
      (await upgraded.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual([legacyId]);

    // Acknowledged under the legacy id, and recorded on its legacy row.
    await coordinator.claim(SCOPE, legacyId, input.to, "legacy-claim");
    const acknowledged = await coordinator.acknowledge(
      SCOPE,
      legacyId,
      input.to,
      "legacy-ack"
    );
    expect(acknowledged.phase).toBe("acknowledged");
    expect(await upgraded.terminalOutcome(legacyId, SCOPE)).toBe(
      "acknowledged"
    );
  });

  test("a legacy intent whose execution never started is recovered under its legacy id only", async () => {
    const input = inputFor(`legacy-unstarted-${randomUUID()}`);
    const { legacyId, upgraded } = await legacyDatabase(input);
    const { coordinator, delivered, workflows } = coordinatorOver(upgraded);

    await coordinator.recoverPending();
    await coordinator.receive(SCOPE, input, "sender-retry");

    expect([...new Set(workflows.starts)]).toEqual([legacyId]);
    expect(delivered).toEqual([
      deriveSupervisorMessageV2DeliveryId(SCOPE, legacyId, 1),
    ]);
  });

  test("refuses to record a deployment-format intent for a dedupe key held under its legacy id", async () => {
    const input = inputFor(`legacy-held-${randomUUID()}`);
    const { legacySql, upgraded } = await legacyDatabase(input);
    const current = workflowIdOf(input);

    const refused = await upgraded
      .recordStartIntent(current, SCOPE, input)
      .then(
        () => "recorded",
        (error: Error) => error.message
      );

    expect(refused).toBe(
      "V2 workflow start intent is held under its legacy workflow id"
    );
    const rows = await legacySql<
      { count: number }[]
    >`SELECT count(*)::integer AS count FROM loop_supervisor_message_v2_start_intent WHERE workflow_id = ${current}`;
    expect(rows[0]?.count).toBe(0);
  });

  test("recognises an id only with the deployment that owns its format", async () => {
    const legacyInput = inputFor(`legacy-owner-${randomUUID()}`);
    const { legacyId, legacySql, upgraded } = await legacyDatabase(legacyInput);
    const input = inputFor(`current-owner-${randomUUID()}`);
    const current = workflowIdOf(input);
    await upgraded.recordStartIntent(current, SCOPE, input);
    const refusal = (workflowId: string) =>
      upgraded.startIntent(workflowId, SCOPE).then(
        () => "read",
        (error: Error) => error.message
      );
    expect(await refusal(current)).toBe("read");
    expect(await refusal(legacyId)).toBe("read");

    // A deployment-format row recorded as another deployment's, and a
    // legacy-format row that claims a deployment, are neither of them ours.
    await legacySql`UPDATE loop_supervisor_message_v2_start_intent SET deployment = 'another-deployment-queue'`;

    for (const workflowId of [current, legacyId]) {
      expect(await refusal(workflowId)).toBe(
        "V2 workflow start intent has an invalid workflow binding"
      );
    }
    const rerecorded = await upgraded
      .recordStartIntent(current, SCOPE, input)
      .then(
        () => "recorded",
        (error: Error) => error.message
      );
    expect(rerecorded).toBe(
      "V2 workflow start intent conflicts with the existing binding"
    );
    expect(await upgraded.workflowIdFor(SCOPE, legacyInput.dedupeKey)).toBe(
      workflowIdOf(legacyInput)
    );
    expect(await upgraded.recoverableStarts()).toEqual([]);

    // A deployment-format id on a row that claims no deployment is not a
    // legacy row: recovery refuses it rather than adopting it.
    await legacySql`UPDATE loop_supervisor_message_v2_start_intent SET deployment = NULL WHERE workflow_id = ${current}`;
    const swept = await upgraded.recoverableStarts().then(
      () => "listed",
      (error: Error) => error.message
    );
    expect(swept).toBe(
      "V2 recovery ledger row has an invalid workflow binding"
    );
  });

  test("never mints a legacy-format intent for a new message", async () => {
    const isolated = await freshLedger();
    const input = inputFor(`legacy-mint-${randomUUID()}`);

    const refused = await isolated
      .recordStartIntent(legacyWorkflowIdOf(input), SCOPE, input)
      .then(
        () => "recorded",
        (error: Error) => error.message
      );

    expect(refused).toBe(
      "V2 legacy workflow id has no recorded start intent; a new message uses its deployment workflow id"
    );
    expect(await isolated.workflowIdFor(SCOPE, input.dedupeKey)).toBe(
      workflowIdOf(input)
    );
    expect(await isolated.recoverableStarts()).toEqual([]);
  });

  test("records the deployment on a new intent and keeps another deployment's intents out of recovery and authorization", async () => {
    const databaseUrl = await freshDatabase();
    const here = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      { deployment: DEPLOYMENT }
    );
    opened.push(here);
    await here.migrate();
    const there = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      { deployment: "another-deployment-queue" }
    );
    opened.push(there);
    await there.migrate();
    const input = inputFor(`shared-db-${randomUUID()}`);
    const workflowId = workflowIdOf(input);
    await here.recordStartIntent(workflowId, SCOPE, input);

    const shared = new SQL(databaseUrl);
    opened.push({ close: () => shared.close({ timeout: 0 }) });
    await shared.connect();
    expect(
      await shared<
        { deployment: string | null; workflow_id: string }[]
      >`SELECT workflow_id, deployment FROM loop_supervisor_message_v2_start_intent`
    ).toEqual([{ deployment: DEPLOYMENT, workflow_id: workflowId }]);
    expect(
      (await here.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual([workflowId]);
    expect(await there.recoverableStarts()).toEqual([]);
    const foreignRead = await there.startIntent(workflowId, SCOPE).then(
      () => "read",
      (error: Error) => error.message
    );
    expect(foreignRead).toBe(
      "V2 workflow start intent has an invalid workflow binding"
    );
    expect(
      await there.recipientAssignment({
        recipient: input.to,
        tenantId: SCOPE.tenantId,
        workflowId,
      })
    ).toBeUndefined();
    // The same message on the other deployment gets its own id and intent.
    const theirs = await there.workflowIdFor(SCOPE, input.dedupeKey);
    expect(theirs).not.toBe(workflowId);
    await there.recordStartIntent(theirs, SCOPE, input);
    expect(
      (await there.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual([theirs]);
  });
});

describe("V2 recovery runner on PostgreSQL", () => {
  const INJECTED = "injected terminal outcome failure";

  /**
   * A deployment whose PostgreSQL ledger refuses to record one workflow's
   * terminal outcome: a real per-record database error, not a stub.
   */
  const failingHarness = async () => {
    const url = await freshDatabase();
    const isolated = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      url,
      { deployment: DEPLOYMENT }
    );
    opened.push(isolated);
    await isolated.migrate();
    const sql = new SQL(url);
    await sql.connect();
    opened.push({ close: () => sql.close({ timeout: 0 }) });
    await sql.unsafe(
      `CREATE FUNCTION refuse_terminal_outcome() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION '${INJECTED}'; END $body$`
    );
    const workflows = new RetentionWorkflowPort();
    const delivered: string[] = [];
    const coordinator = new SupervisorMessageV2Coordinator(
      workflows,
      {
        deliver(envelope) {
          delivered.push(envelope.deliveryId);
          return Promise.resolve({ status: "accepted" });
        },
      },
      isolated,
      OWNER,
      () => NOW
    );
    let clock = NOW.getTime();
    const lines: string[] = [];
    const runner = new SupervisorMessageV2RecoveryRunner({
      coordinator,
      intervalMs: 1000,
      log: (line) => lines.push(line),
      now: () => clock,
      timer: { clearInterval: () => undefined, setInterval: () => 1 },
    });
    opened.push(runner);
    /** A started message canceled before any delivery: a sweep records "canceled". */
    const canceledIntent = async () => {
      const input = inputFor(`refused-${randomUUID()}`);
      const workflowId = workflowIdOf(input);
      await isolated.recordStartIntent(workflowId, SCOPE, input);
      workflows.start({
        input: { input, trustedScope: SCOPE },
        requestId: "refused-start",
        workflowId,
        workflowType: "supervisor-message.v2",
      });
      workflows.cancel({
        reason: "operator",
        requestId: "operator-cancel",
        workflowId,
      });
      return { input, workflowId };
    };
    return {
      /** Let PostgreSQL record every outcome again. */
      acceptOutcomes: async () => {
        await sql.unsafe(
          "DROP TRIGGER refuse_terminal_outcome ON loop_supervisor_message_v2_start_intent"
        );
      },
      advance: (ms: number) => {
        clock += ms;
      },
      canceledIntent,
      delivered,
      ledger: isolated,
      lines,
      /** Make PostgreSQL refuse this one workflow's terminal outcome. */
      refuseOutcomeOf: async (workflowId: string) => {
        if (
          !/^supervisor-message-workflow:v2:(?:deployment:)?[a-f0-9]{64}$/.test(
            workflowId
          )
        ) {
          throw new Error("unexpected workflow ID shape");
        }
        await sql.unsafe(
          `CREATE TRIGGER refuse_terminal_outcome BEFORE UPDATE OF terminal_outcome ON loop_supervisor_message_v2_start_intent FOR EACH ROW WHEN (OLD.workflow_id = '${workflowId}') EXECUTE FUNCTION refuse_terminal_outcome()`
        );
      },
      runner,
    };
  };

  test("service start refuses a PostgreSQL failure for one record after recovering the others", async () => {
    const h = await failingHarness();
    const refused = await h.canceledIntent();
    await h.refuseOutcomeOf(refused.workflowId);
    const healthy = inputFor(`healthy-${randomUUID()}`);
    const healthyId = workflowIdOf(healthy);
    await h.ledger.recordStartIntent(healthyId, SCOPE, healthy);

    const error = await h.runner.start().then(
      () => undefined,
      (failure: unknown) => failure
    );

    expect(error).toBeInstanceOf(SupervisorMessageV2RecoveryStartupError);
    const failures = (error as SupervisorMessageV2RecoveryStartupError)
      .failures;
    expect(
      failures.map((failure) => [
        failure.workflowId,
        failure.recipient,
        failure.kind,
        (failure.error as Error).message,
      ])
    ).toEqual([[refused.workflowId, refused.input.to, "failed", INJECTED]]);
    expect((error as Error).message).toStartWith(
      `V2 initial recovery failed for 1 recorded start: workflow ${refused.workflowId} for ${refused.input.to}: `
    );
    expect(await h.ledger.terminalOutcome(refused.workflowId, SCOPE)).toBe(
      undefined
    );
    // The healthy intent was started and delivered before the refusal.
    expect(h.delivered).toEqual([
      deriveSupervisorMessageV2DeliveryId(SCOPE, healthyId, 1),
    ]);
  });

  test("a periodic sweep retries a PostgreSQL failure with backoff, logs it, and records the outcome once it clears", async () => {
    const h = await failingHarness();
    await h.runner.start();
    const refused = await h.canceledIntent();
    await h.refuseOutcomeOf(refused.workflowId);

    await h.runner.sweep();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toStartWith(
      `V2 recovery of workflow ${refused.workflowId} for ${refused.input.to} failed (attempt 1); retrying in 1000 ms: `
    );
    expect(h.lines[0]).toEndWith(INJECTED);

    // Not due yet: no attempt and no line, even once PostgreSQL accepts again.
    await h.acceptOutcomes();
    await h.runner.sweep();
    expect(h.lines).toHaveLength(1);
    expect(await h.ledger.terminalOutcome(refused.workflowId, SCOPE)).toBe(
      undefined
    );

    h.advance(1000);
    await h.runner.sweep();
    expect(h.lines.slice(1)).toEqual([
      `V2 recovery of workflow ${refused.workflowId} for ${refused.input.to} resumed after 1 failed attempt`,
    ]);
    expect(await h.ledger.terminalOutcome(refused.workflowId, SCOPE)).toBe(
      "canceled"
    );
  });
});
