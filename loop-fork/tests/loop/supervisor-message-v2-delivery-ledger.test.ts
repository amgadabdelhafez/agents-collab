import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL, sleep } from "bun";
import type { SupervisorA2AResultBinding } from "../../src/loop/a2a-supervisor-result";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2ResultGraphWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2DeliveryEnvelope,
  type SupervisorMessageV2Input,
  SupervisorResultGraphKey,
  type TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import {
  PostgresSupervisorMessageV2DeliveryLedger,
  SupervisorMessageV2WorkflowIdFormatError,
} from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import {
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryOutcome,
  SupervisorMessageV2RecoveryRunner,
  SupervisorMessageV2RecoveryStartupError,
  type SupervisorMessageV2TerminalOutcome,
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

/**
 * The base-era build's own ledger code: the files of 40097564 this ledger
 * class needs, vendored unmodified under tests/fixtures. Each is pinned to
 * its git blob id at that commit, so the rollback tests below run the code a
 * rollback runs, not a re-statement of it. They are an old build, so the
 * project typecheck excludes them and they load by path, like the deployed
 * builds in orchestration-rollback-to-deployed.test.ts; the shapes below are
 * only what these tests call.
 */
const BASE_ERA_DIR = join(import.meta.dir, "../fixtures/base-era-40097564");
interface BaseEraLedgerInstance {
  bindResult(
    scope: TrustedSupervisorMessageV2Scope,
    binding: SupervisorA2AResultBinding
  ): Promise<void>;
  close(): Promise<void>;
  migrate(): Promise<void>;
  recordStartIntent(
    workflowId: string,
    scope: TrustedSupervisorMessageV2Scope,
    input: SupervisorMessageV2Input
  ): Promise<SupervisorMessageV2Input>;
  recordTerminalOutcome(
    workflowId: string,
    scope: TrustedSupervisorMessageV2Scope,
    outcome: "acknowledged"
  ): Promise<void>;
  recoverableStarts(): Promise<readonly { workflowId: string }[]>;
  resultBinding(
    scope: TrustedSupervisorMessageV2Scope,
    workflowId: string,
    taskId: string
  ): Promise<SupervisorA2AResultBinding | undefined>;
}
const baseEraContract: {
  deriveSupervisorMessageV2ResultGraphWorkflowId(
    scope: TrustedSupervisorMessageV2Scope,
    workflowId: string
  ): string;
  deriveSupervisorMessageV2WorkflowId(
    scope: TrustedSupervisorMessageV2Scope,
    dedupeKey: string
  ): string;
} = await import(join(BASE_ERA_DIR, "supervisor-message-v2-contract.ts"));
const baseEraContractId = baseEraContract.deriveSupervisorMessageV2WorkflowId;
const baseEraResultGraphId =
  baseEraContract.deriveSupervisorMessageV2ResultGraphWorkflowId;
const BaseEraLedger: {
  connect(databaseUrl: string): Promise<BaseEraLedgerInstance>;
} = (
  await import(join(BASE_ERA_DIR, "supervisor-message-v2-delivery-ledger.ts"))
).PostgresSupervisorMessageV2DeliveryLedger;

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
/** The build these ledgers record as the writer of their id format. */
const BUILD = "ledger-test-build.v1";
/** A ledger that has opted in to deployment-scoped workflow ids. */
const DEPLOYMENT_FORMAT = {
  buildId: BUILD,
  deployment: DEPLOYMENT,
  workflowIdFormat: "deployment",
} as const;
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
    DEPLOYMENT_FORMAT
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
      DEPLOYMENT_FORMAT
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
      DEPLOYMENT_FORMAT
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

  test("migrates a ledger left by the 3f7a70f2 build: its 'completed' CHECK is replaced and stored 'completed' becomes 'acknowledged'", async () => {
    const databaseUrl = await freshDatabase();
    const legacySql = new SQL(databaseUrl);
    opened.push({ close: () => legacySql.close({ timeout: 0 }) });
    await legacySql.connect();
    // The schema exactly as 3f7a70f2's migrate() left it: the terminal marker
    // with a CHECK that allows 'completed' and refuses 'acknowledged'.
    await legacySql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_delivery_ledger (delivery_id TEXT PRIMARY KEY, envelope_json JSONB NOT NULL, completed_at TIMESTAMPTZ, lease_owner TEXT, lease_fence BIGINT NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ)`;
    await legacySql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_start_intent (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, input_json JSONB NOT NULL)`;
    await legacySql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_result_binding (
      workflow_id TEXT NOT NULL REFERENCES loop_supervisor_message_v2_start_intent(workflow_id),
      a2a_task_id TEXT NOT NULL, tenant_id TEXT NOT NULL, principal TEXT NOT NULL,
      binding_json JSONB NOT NULL, PRIMARY KEY (workflow_id, a2a_task_id)
    )`;
    await legacySql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS terminal_outcome TEXT CHECK (terminal_outcome IN ('completed', 'canceled', 'dead-lettered', 'exhausted', 'terminated'))`;
    await legacySql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ`;
    const acked = inputFor(`acked-${randomUUID()}`);
    const canceled = inputFor(`canceled-${randomUUID()}`);
    const open = inputFor(`open-${randomUUID()}`);
    const ackedId = legacyWorkflowIdOf(acked);
    const canceledId = legacyWorkflowIdOf(canceled);
    const openId = legacyWorkflowIdOf(open);
    await legacySql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json, terminal_outcome, terminal_at) VALUES
      (${ackedId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(acked)}::jsonb, 'completed', now()),
      (${canceledId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(canceled)}::jsonb, 'canceled', now()),
      (${openId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(open)}::jsonb, NULL, NULL)`;
    const checks = () =>
      legacySql<{ definition: string; oid: number }[]>`
        SELECT c.oid::integer AS oid, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'loop_supervisor_message_v2_start_intent'::regclass
          AND c.contype = 'c' AND a.attname = 'terminal_outcome'`;

    const migrated = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      { buildId: BUILD, deployment: DEPLOYMENT }
    );
    opened.push(migrated);
    await migrated.migrate();
    const replaced = await checks();
    await migrated.migrate();

    // Idempotent: one CHECK, rewritten once and left alone after that.
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.definition).toContain("'acknowledged'");
    expect(replaced[0]?.definition).not.toContain("'completed'");
    expect(await checks()).toEqual(replaced);
    // The intermediate build's recipient ACK is read as what it was.
    await expect(migrated.terminalOutcome(ackedId, SCOPE)).resolves.toBe(
      "acknowledged"
    );
    await expect(migrated.terminalOutcome(canceledId, SCOPE)).resolves.toBe(
      "canceled"
    );
    await expect(migrated.terminalOutcome(openId, SCOPE)).resolves.toBe(
      undefined
    );
    // No row is lost: the sweep still reads all three intents.
    expect(
      (await migrated.recoverableStarts())
        .map((start) => start.workflowId)
        .sort()
    ).toEqual([ackedId, canceledId, openId].sort());
    // An acknowledgement can now be recorded, and 'completed' never again.
    await migrated.recordTerminalOutcome(openId, SCOPE, "acknowledged");
    await expect(migrated.terminalOutcome(openId, SCOPE)).resolves.toBe(
      "acknowledged"
    );
    const completed =
      await legacySql`UPDATE loop_supervisor_message_v2_start_intent SET terminal_outcome = 'completed' WHERE workflow_id = ${canceledId}`.then(
        () => "accepted",
        () => "rejected by the CHECK constraint"
      );
    expect(completed).toBe("rejected by the CHECK constraint");
  });

  test("replaces any terminal_outcome CHECK that is not the current list, including hand-edited ones", async () => {
    const variants: Record<string, string | undefined> = {
      // An operator widened the CHECK to let the intermediate build write on.
      "hand-widened": `CHECK (terminal_outcome IN ('acknowledged', 'completed', 'canceled', 'dead-lettered', 'exhausted', 'terminated'))`,
      // Narrowed by hand: no 'completed', but it refuses 'exhausted'.
      "hand-narrowed": `CHECK (terminal_outcome IN ('acknowledged', 'canceled', 'dead-lettered', 'terminated'))`,
      // Dropped by hand.
      dropped: undefined,
    };
    for (const [label, check] of Object.entries(variants)) {
      const databaseUrl = await freshDatabase();
      const handSql = new SQL(databaseUrl);
      opened.push({ close: () => handSql.close({ timeout: 0 }) });
      await handSql.connect();
      await handSql`CREATE TABLE loop_supervisor_message_v2_start_intent (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, input_json JSONB NOT NULL)`;
      await handSql.unsafe(
        `ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN terminal_outcome TEXT ${check ?? ""}`
      );
      const ids: {
        outcome: SupervisorMessageV2TerminalOutcome;
        workflowId: string;
      }[] = [];
      for (const outcome of [
        "acknowledged",
        "canceled",
        "dead-lettered",
        "exhausted",
        "terminated",
      ] as const) {
        const input = inputFor(`${label}-${outcome}-${randomUUID()}`);
        ids.push({ outcome, workflowId: legacyWorkflowIdOf(input) });
        await handSql`INSERT INTO loop_supervisor_message_v2_start_intent VALUES (${legacyWorkflowIdOf(input)}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(input)}::jsonb, NULL)`;
      }
      const ledgerFor = await PostgresSupervisorMessageV2DeliveryLedger.connect(
        databaseUrl,
        { buildId: BUILD, deployment: DEPLOYMENT }
      );
      opened.push(ledgerFor);
      await ledgerFor.migrate();
      const definitions = await handSql<{ definition: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'loop_supervisor_message_v2_start_intent'::regclass
          AND c.contype = 'c' AND a.attname = 'terminal_outcome'`;
      expect(`${label}: ${definitions.length}`).toBe(`${label}: 1`);
      expect(definitions[0]?.definition).not.toContain("'completed'");
      // Every current outcome is accepted after the migration.
      for (const { outcome, workflowId } of ids) {
        await ledgerFor.recordTerminalOutcome(workflowId, SCOPE, outcome);
        await expect(
          ledgerFor.terminalOutcome(workflowId, SCOPE)
        ).resolves.toBe(outcome);
      }
      const completed =
        await handSql`UPDATE loop_supervisor_message_v2_start_intent SET terminal_outcome = 'completed'`.then(
          () => "accepted",
          () => "rejected by the CHECK constraint"
        );
      expect(`${label}: ${completed}`).toBe(
        `${label}: rejected by the CHECK constraint`
      );
    }
  });

  test("hosts replacing one database's retired CHECK at the same time all start", async () => {
    const databaseUrl = await freshDatabase();
    // Every table exists, as on a host that ran 3f7a70f2 and later builds;
    // only the terminal_outcome CHECK and a stored 'completed' are that
    // build's. The CHECK carries a hand-chosen name, so a host that read the
    // catalog before another replaced it cannot drop it twice. (Racing
    // CREATE TABLE IF NOT EXISTS on an empty database is a separate, older
    // limit of migrate.)
    const first = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      { buildId: BUILD, deployment: DEPLOYMENT }
    );
    opened.push(first);
    await first.migrate();
    const legacySql = new SQL(databaseUrl);
    opened.push({ close: () => legacySql.close({ timeout: 0 }) });
    await legacySql.connect();
    await legacySql`ALTER TABLE loop_supervisor_message_v2_start_intent DROP CONSTRAINT loop_supervisor_message_v2_start_intent_terminal_outcome_check`;
    await legacySql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD CONSTRAINT terminal_outcome_retired_check CHECK (terminal_outcome IN ('completed', 'canceled', 'dead-lettered', 'exhausted', 'terminated'))`;
    const input = inputFor(`concurrent-${randomUUID()}`);
    const workflowId = legacyWorkflowIdOf(input);
    await legacySql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json, terminal_outcome) VALUES (${workflowId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(input)}::jsonb, 'completed')`;
    const hosts = await Promise.all(
      Array.from({ length: 4 }, () =>
        PostgresSupervisorMessageV2DeliveryLedger.connect(databaseUrl, {
          buildId: BUILD,
          deployment: DEPLOYMENT,
        })
      )
    );
    opened.push(...hosts);
    const results = await Promise.allSettled(
      hosts.map((host) => host.migrate())
    );
    expect(
      results.map((result) =>
        result.status === "rejected" ? String(result.reason) : result.status
      )
    ).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    await expect(first.terminalOutcome(workflowId, SCOPE)).resolves.toBe(
      "acknowledged"
    );
  });

  test("leaves a current terminal_outcome CHECK in place on every migrate", async () => {
    const url = await freshDatabase();
    const twice = await PostgresSupervisorMessageV2DeliveryLedger.connect(url, {
      buildId: BUILD,
      deployment: DEPLOYMENT,
    });
    opened.push(twice);
    const catalog = new SQL(url);
    opened.push({ close: () => catalog.close({ timeout: 0 }) });
    await catalog.connect();
    const checks = () =>
      catalog<{ name: string; oid: number }[]>`
        SELECT c.conname AS name, c.oid::integer AS oid
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'loop_supervisor_message_v2_start_intent'::regclass
          AND c.contype = 'c' AND a.attname = 'terminal_outcome'`;
    await twice.migrate();
    const first = await checks();
    await twice.migrate();
    expect(first).toEqual([
      {
        name: "loop_supervisor_message_v2_start_intent_terminal_outcome_check",
        oid: expect.any(Number),
      },
    ]);
    // Not dropped and re-added: the same constraint survives every start.
    expect(await checks()).toEqual(first);
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
      DEPLOYMENT_FORMAT
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
        options as unknown as typeof DEPLOYMENT_FORMAT
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
      `V2 recovery ledger row ${current} has an invalid workflow binding`
    );
  });

  test("deployment-write mode never mints a legacy-format intent for a new message", async () => {
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
      DEPLOYMENT_FORMAT
    );
    opened.push(here);
    await here.migrate();
    const there = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      databaseUrl,
      { ...DEPLOYMENT_FORMAT, deployment: "another-deployment-queue" }
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

/**
 * The workflow id derivation every base-era host (before the deployment
 * discriminator, 40097564) used, reimplemented here independently of the
 * contract module so a change there cannot move both sides at once.
 */
const baseEraWorkflowId = (
  scope: TrustedSupervisorMessageV2Scope,
  dedupeKey: string
): string => {
  const hash = createHash("sha256");
  for (const value of [
    "supervisor-message",
    "v2",
    "workflow",
    scope.tenantId,
    scope.principal,
    dedupeKey,
  ]) {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
    hash.update(Buffer.from([0]));
  }
  return `supervisor-message-workflow:v2:${hash.digest("hex")}`;
};

/**
 * The base-era build's ledger statements against one database, as
 * 40097564 issues them: it cannot be changed, so a rollback runs exactly
 * these. Its migrate is idempotent DDL; its start intent never names a
 * deployment; its recovery reads every row and refuses any id that is not
 * its own derivation.
 */
const baseEraBuild = (sql: SQL) => ({
  async migrate(): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_delivery_ledger (delivery_id TEXT PRIMARY KEY, envelope_json JSONB NOT NULL, completed_at TIMESTAMPTZ, lease_owner TEXT, lease_fence BIGINT NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ)`;
    await sql`CREATE TABLE IF NOT EXISTS loop_supervisor_message_v2_start_intent (workflow_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, principal TEXT NOT NULL, input_json JSONB NOT NULL)`;
    await sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS terminal_outcome TEXT CHECK (terminal_outcome IN ('acknowledged', 'canceled', 'dead-lettered', 'exhausted', 'terminated'))`;
    await sql`ALTER TABLE loop_supervisor_message_v2_start_intent ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ`;
  },
  /** Its `recordStartIntent` write, settled to the error message or id. */
  async recordStartIntent(input: SupervisorMessageV2Input): Promise<string> {
    const workflowId = baseEraWorkflowId(SCOPE, input.dedupeKey);
    return await sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json) VALUES (${workflowId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(input)}::jsonb) ON CONFLICT (workflow_id) DO NOTHING`.then(
      () => workflowId,
      (error: Error) => error.message
    );
  },
  /** Its `recoverableStarts`: every row, each bound to its own derivation. */
  async recoverableStarts(): Promise<string[]> {
    const rows = await sql<
      {
        input_json: unknown;
        principal: string;
        tenant_id: string;
        workflow_id: string;
      }[]
    >`SELECT input_json, principal, tenant_id, workflow_id FROM loop_supervisor_message_v2_start_intent ORDER BY workflow_id`;
    return rows.map((row) => {
      const input = (
        typeof row.input_json === "string"
          ? JSON.parse(row.input_json)
          : row.input_json
      ) as SupervisorMessageV2Input;
      if (
        row.workflow_id !==
        baseEraWorkflowId(
          { principal: row.principal, tenantId: row.tenant_id },
          input.dedupeKey
        )
      ) {
        throw new Error(
          "V2 recovery ledger row has an invalid workflow binding"
        );
      }
      return row.workflow_id;
    });
  },
});

const formatRefusal = (recorded: string, build: string, written: string) =>
  `V2 delivery ledger writes "${recorded}" workflow ids (recorded by build ${build}); a "${written}" start intent is refused. Every host sharing this ledger database must run a build that supports the recorded format, with the same a2aV2.workflowIdFormat`;

describe("V2 workflow id format marker on PostgreSQL", () => {
  /** One database, opened by successive builds of this host. */
  const sharedDatabase = async () => {
    const databaseUrl = await freshDatabase();
    const sql = new SQL(databaseUrl);
    opened.push({ close: () => sql.close({ timeout: 0 }) });
    await sql.connect();
    const open = async (
      buildId: string,
      workflowIdFormat?: "deployment" | "legacy"
    ) => {
      const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
        databaseUrl,
        {
          buildId,
          deployment: DEPLOYMENT,
          ...(workflowIdFormat ? { workflowIdFormat } : {}),
        }
      );
      opened.push(ledger);
      return ledger;
    };
    const marker = async () =>
      await sql<
        { build_id: string | null; value: string | null }[]
      >`SELECT value, build_id FROM loop_supervisor_message_v2_schema_marker WHERE name = 'workflow-id-format.v1'`;
    const intents = async () =>
      await sql<
        { deployment: string | null; workflow_id: string }[]
      >`SELECT workflow_id, deployment FROM loop_supervisor_message_v2_start_intent ORDER BY workflow_id`;
    return { databaseUrl, intents, marker, open, sql };
  };

  const refusalOf = (work: Promise<unknown>) =>
    work.then(
      () => "accepted",
      (error: Error) => error.message
    );

  test("defaults to legacy-write mode: mints the base-era workflow id byte for byte and records the format with its build", async () => {
    const { intents, marker, open } = await sharedDatabase();
    const ledger = await open("upgrade-build.v1");
    await ledger.migrate();
    const input = inputFor(fixture.input.dedupeKey);

    const workflowId = await ledger.workflowIdFor(SCOPE, input.dedupeKey);
    await ledger.recordStartIntent(workflowId, SCOPE, input);

    // The value every base-era host derived for this fixture.
    expect(workflowId).toBe(
      "supervisor-message-workflow:v2:7f52fd713e6acb1e3cbb1c20b2b86ce2eb3ca96c2c9eb7ce857798afff31e0af"
    );
    expect(workflowId).toBe(baseEraWorkflowId(SCOPE, input.dedupeKey));
    expect(await intents()).toEqual([
      { deployment: null, workflow_id: workflowId },
    ]);
    expect(await marker()).toEqual([
      { build_id: "upgrade-build.v1", value: "legacy" },
    ]);
    expect(ledger.workflowIdFormat).toBe("legacy");
    expect(
      (await ledger.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual([workflowId]);
  });

  test("legacy-write mode never mints a deployment workflow id", async () => {
    const { intents, open } = await sharedDatabase();
    const ledger = await open("upgrade-build.v1", "legacy");
    await ledger.migrate();
    const input = inputFor(`legacy-mode-${randomUUID()}`);

    expect(
      await refusalOf(
        ledger.recordStartIntent(workflowIdOf(input), SCOPE, input)
      )
    ).toBe(
      'V2 deployment workflow id has no recorded start intent; this ledger writes legacy workflow ids (a2aV2.workflowIdFormat "legacy")'
    );
    expect(await intents()).toEqual([]);
  });

  test("rollback: the base-era build reads, recovers and deduplicates what legacy-write mode recorded, and this build reads what it records", async () => {
    const { open, sql } = await sharedDatabase();
    const upgraded = await open("upgrade-build.v1");
    await upgraded.migrate();
    const first = inputFor(`rollback-first-${randomUUID()}`);
    const second = inputFor(`rollback-second-${randomUUID()}`);
    for (const input of [first, second]) {
      await upgraded.recordStartIntent(
        await upgraded.workflowIdFor(SCOPE, input.dedupeKey),
        SCOPE,
        input
      );
    }

    // Roll back: the base-era build migrates, recovers and takes a sender
    // retry over the same database.
    const baseEra = baseEraBuild(sql);
    await baseEra.migrate();
    expect(await baseEra.recoverableStarts()).toEqual(
      [first, second]
        .map((input) => baseEraWorkflowId(SCOPE, input.dedupeKey))
        .sort()
    );
    expect(await baseEra.recordStartIntent(first)).toBe(
      baseEraWorkflowId(SCOPE, first.dedupeKey)
    );
    const third = inputFor(`rollback-third-${randomUUID()}`);
    expect(await baseEra.recordStartIntent(third)).toBe(
      baseEraWorkflowId(SCOPE, third.dedupeKey)
    );
    expect(await baseEra.recoverableStarts()).toHaveLength(3);

    // Roll forward again: this build reads the base-era row as its own.
    const again = await open("upgrade-build.v2");
    await again.migrate();
    expect(await again.workflowIdFor(SCOPE, third.dedupeKey)).toBe(
      baseEraWorkflowId(SCOPE, third.dedupeKey)
    );
    expect(
      (await again.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual(await baseEra.recoverableStarts());
  });

  test("flips to deployment ids only on explicit opt-in; afterwards the base-era build's writes are refused with an exact message", async () => {
    const { intents, marker, open, sql } = await sharedDatabase();
    const upgraded = await open("upgrade-build.v1");
    await upgraded.migrate();
    const held = inputFor(`flip-held-${randomUUID()}`);
    const heldId = await upgraded.workflowIdFor(SCOPE, held.dedupeKey);
    await upgraded.recordStartIntent(heldId, SCOPE, held);

    const flipped = await open("flip-build.v1", "deployment");
    await flipped.migrate();

    expect(flipped.workflowIdFormat).toBe("deployment");
    expect(await marker()).toEqual([
      { build_id: "flip-build.v1", value: "deployment" },
    ]);
    const fresh = inputFor(`flip-fresh-${randomUUID()}`);
    const freshId = await flipped.workflowIdFor(SCOPE, fresh.dedupeKey);
    expect(freshId).toBe(workflowIdOf(fresh));
    await flipped.recordStartIntent(freshId, SCOPE, fresh);
    // The message accepted before the flip keeps its legacy id.
    expect(await flipped.workflowIdFor(SCOPE, held.dedupeKey)).toBe(heldId);
    expect(await intents()).toEqual(
      [
        { deployment: null, workflow_id: heldId },
        { deployment: DEPLOYMENT, workflow_id: freshId },
      ].sort((left, right) => left.workflow_id.localeCompare(right.workflow_id))
    );

    // A base-era host sharing the database can no longer record anything.
    const baseEra = baseEraBuild(sql);
    await baseEra.migrate();
    for (const input of [held, inputFor(`flip-base-era-${randomUUID()}`)]) {
      expect(await baseEra.recordStartIntent(input)).toBe(
        formatRefusal("deployment", "flip-build.v1", "legacy")
      );
    }
    // Its recovery refuses the deployment-format row rather than starting it.
    expect(await refusalOf(baseEra.recoverableStarts())).toBe(
      "V2 recovery ledger row has an invalid workflow binding"
    );

    // Omitting the setting keeps the recorded format; it never flips back.
    const restarted = await open("flip-build.v2");
    await restarted.migrate();
    expect(restarted.workflowIdFormat).toBe("deployment");
    expect(await marker()).toEqual([
      { build_id: "flip-build.v1", value: "deployment" },
    ]);
  });

  test("refuses to return to legacy ids while deployment-format intents are unsettled, then returns once they settle", async () => {
    const { marker, open } = await sharedDatabase();
    const flipped = await open("flip-build.v1", "deployment");
    await flipped.migrate();
    const pending = inputFor(`flip-back-${randomUUID()}`);
    const pendingId = workflowIdOf(pending);
    await flipped.recordStartIntent(pendingId, SCOPE, pending);

    const early = await open("flip-back-build.v1", "legacy");
    expect(await refusalOf(early.migrate())).toBe(
      'V2 delivery ledger cannot return to legacy workflow ids: 1 deployment-format start intents have no terminal outcome. Keep a2aV2.workflowIdFormat "deployment" until they settle'
    );
    // Typed, so the service reports it verbatim instead of as unclassified.
    expect(
      await early.migrate().catch((error: unknown) => error)
    ).toBeInstanceOf(SupervisorMessageV2WorkflowIdFormatError);
    expect(await marker()).toEqual([
      { build_id: "flip-build.v1", value: "deployment" },
    ]);

    await flipped.recordTerminalOutcome(pendingId, SCOPE, "acknowledged");
    const settled = await open("flip-back-build.v2", "legacy");
    await settled.migrate();
    expect(settled.workflowIdFormat).toBe("legacy");
    expect(await marker()).toEqual([
      { build_id: "flip-back-build.v2", value: "legacy" },
    ]);
    // The settled message still resolves to its deployment id.
    expect(await settled.workflowIdFor(SCOPE, pending.dedupeKey)).toBe(
      pendingId
    );
    await settled.recordStartIntent(pendingId, SCOPE, pending);

    // A host still running in deployment mode cannot write past the flip.
    const late = inputFor(`flip-back-late-${randomUUID()}`);
    expect(
      await refusalOf(
        flipped.recordStartIntent(workflowIdOf(late), SCOPE, late)
      )
    ).toBe(formatRefusal("legacy", "flip-back-build.v2", "deployment"));
  });

  test("a quarantined deployment-format record keeps blocking a return to legacy ids: a quarantine is not a terminal outcome", async () => {
    const { marker, open } = await sharedDatabase();
    const flipped = await open("quarantine-flip-build.v1", "deployment");
    await flipped.migrate();
    const stuck = inputFor(`quarantined-flip-back-${randomUUID()}`);
    const stuckId = workflowIdOf(stuck);
    await flipped.recordStartIntent(stuckId, SCOPE, stuck);
    await flipped.quarantineRecovery(stuckId, {
      by: "operator-a",
      reason: "fails every start",
    });
    const refusal =
      'V2 delivery ledger cannot return to legacy workflow ids: 1 deployment-format start intents have no terminal outcome. Keep a2aV2.workflowIdFormat "deployment" until they settle';

    // Quarantined: still counted, so legacy ids stay refused.
    const whileQuarantined = await open("quarantine-flip-back.v1", "legacy");
    expect(await refusalOf(whileQuarantined.migrate())).toBe(refusal);
    // Released but not yet settled: still refused.
    await flipped.releaseRecoveryQuarantine(stuckId, {
      by: "operator-a",
      reason: "fixed the recipient",
    });
    const released = await open("quarantine-flip-back.v2", "legacy");
    expect(await refusalOf(released.migrate())).toBe(refusal);
    expect(await marker()).toEqual([
      { build_id: "quarantine-flip-build.v1", value: "deployment" },
    ]);

    // Only a terminal outcome, recorded by recovery, settles it.
    await flipped.recordTerminalOutcome(stuckId, SCOPE, "acknowledged");
    const settled = await open("quarantine-flip-back.v3", "legacy");
    await settled.migrate();
    expect(settled.workflowIdFormat).toBe("legacy");
  });

  test("a return to legacy ids waits for a deployment-format write in flight and counts it", async () => {
    const { marker, open, sql } = await sharedDatabase();
    const flipped = await open("flip-build.v1", "deployment");
    await flipped.migrate();
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    const until = async (label: string, done: () => Promise<boolean>) => {
      const deadline = Date.now() + 10_000;
      while (!(await done())) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}`);
        }
        await sleep(20);
      }
    };

    // Another start holds the format lock, so the return waits inside it.
    const holderReleased = gate();
    const holderHeld = gate();
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('loop_supervisor_message_v2_workflow_id_format'))`;
      holderHeld.open();
      await holderReleased.opened;
    });
    await holderHeld.opened;
    const returning = await open("flip-back-build.v1", "legacy");
    let settled = false;
    const outcome = refusalOf(returning.migrate()).finally(() => {
      settled = true;
    });
    await until("the return to wait for the format lock", async () => {
      const rows = await sql<
        { count: number }[]
      >`SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      return rows[0]?.count === 1;
    });

    // A deployment-format write begins after the return's schema changes
    // and is still uncommitted when the return takes the lock.
    const pending = inputFor(`in-flight-${randomUUID()}`);
    const writeCommitted = gate();
    const writeRecorded = gate();
    const write = sql.begin(async (tx) => {
      await tx`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json, deployment) VALUES (${workflowIdOf(pending)}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(pending)}::jsonb, ${DEPLOYMENT})`;
      writeRecorded.open();
      await writeCommitted.opened;
    });
    await writeRecorded.opened;
    holderReleased.open();
    await holder;
    await sleep(300);
    expect(settled).toBe(false);

    writeCommitted.open();
    await write;
    expect(await outcome).toBe(
      'V2 delivery ledger cannot return to legacy workflow ids: 1 deployment-format start intents have no terminal outcome. Keep a2aV2.workflowIdFormat "deployment" until they settle'
    );
    expect(await marker()).toEqual([
      { build_id: "flip-build.v1", value: "deployment" },
    ]);
  });

  test("never starts the same message twice across legacy, deployment and back to legacy, through recovery and sender retries", async () => {
    const { open, sql } = await sharedDatabase();
    // One engine outlives every host build.
    const workflows = new RetentionWorkflowPort();
    const created: string[] = [];
    const start = workflows.start.bind(workflows);
    workflows.start = (command: WorkflowStartCommand) => {
      const receipt = start(command);
      if (receipt.created) {
        created.push(command.workflowId);
      }
      return receipt;
    };
    const delivered: string[] = [];
    const host = async (
      buildId: string,
      workflowIdFormat?: "deployment" | "legacy"
    ) => {
      const ledger = await open(buildId, workflowIdFormat);
      await ledger.migrate();
      return new SupervisorMessageV2Coordinator(
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
    };
    const a = inputFor(`mixed-a-${randomUUID()}`);
    const b = inputFor(`mixed-b-${randomUUID()}`);
    const c = inputFor(`mixed-c-${randomUUID()}`);
    const legacyA = legacyWorkflowIdOf(a);
    const deploymentB = workflowIdOf(b);
    const legacyC = legacyWorkflowIdOf(c);

    const legacyHost = await host("mixed-build.v1");
    expect((await legacyHost.receive(SCOPE, a, "a-1")).workflowId).toBe(
      legacyA
    );
    expect((await legacyHost.receive(SCOPE, a, "a-2")).created).toBe(false);

    const deploymentHost = await host("mixed-build.v2", "deployment");
    expect((await deploymentHost.receive(SCOPE, a, "a-3")).workflowId).toBe(
      legacyA
    );
    expect((await deploymentHost.receive(SCOPE, b, "b-1")).workflowId).toBe(
      deploymentB
    );
    await deploymentHost.recoverPending();
    await deploymentHost.claim(SCOPE, deploymentB, b.to, "b-claim");
    await deploymentHost.acknowledge(SCOPE, deploymentB, b.to, "b-ack");
    workflows.purge(deploymentB);

    const returnedHost = await host("mixed-build.v3", "legacy");
    await returnedHost.recoverPending();
    // A sender retry of the settled message resolves to its deployment id,
    // whose execution retention purged: refused, never started again.
    await expect(returnedHost.receive(SCOPE, b, "b-2")).rejects.toMatchObject({
      code: "conflict",
      name: "WorkflowError",
    });
    expect((await returnedHost.receive(SCOPE, a, "a-4")).workflowId).toBe(
      legacyA
    );
    expect((await returnedHost.receive(SCOPE, c, "c-1")).workflowId).toBe(
      legacyC
    );
    await returnedHost.recoverPending();
    // The base-era build cannot start the settled message under its legacy id.
    expect(await baseEraBuild(sql).recordStartIntent(b)).toBe(
      `V2 start intent ${legacyWorkflowIdOf(b)} is held under a deployment workflow id; it is never recorded again under its legacy id`
    );

    expect(created).toEqual([legacyA, deploymentB, legacyC]);
    expect(delivered.sort()).toEqual(
      [
        deriveSupervisorMessageV2DeliveryId(SCOPE, legacyA, 1),
        deriveSupervisorMessageV2DeliveryId(SCOPE, deploymentB, 1),
        deriveSupervisorMessageV2DeliveryId(SCOPE, legacyC, 1),
      ].sort()
    );
  });

  test("refuses to start on a recorded format this build does not support, naming the format and the build", async () => {
    const { open, sql } = await sharedDatabase();
    const first = await open("upgrade-build.v1");
    await first.migrate();
    await sql`UPDATE loop_supervisor_message_v2_schema_marker SET value = 'tenant-scoped.v3', build_id = 'future-build.v9' WHERE name = 'workflow-id-format.v1'`;

    for (const format of [undefined, "legacy", "deployment"] as const) {
      const later = await open("upgrade-build.v2", format);
      expect(await refusalOf(later.migrate())).toBe(
        'V2 delivery ledger records workflow id format "tenant-scoped.v3" (written by build future-build.v9), which this build does not support; it supports "legacy" and "deployment". Run a build that supports the recorded format'
      );
      expect(
        await later.migrate().catch((error: unknown) => error)
      ).toBeInstanceOf(SupervisorMessageV2WorkflowIdFormatError);
      expect(later.workflowIdFormat).toBeUndefined();
      expect(
        await refusalOf(later.workflowIdFor(SCOPE, `unsupported-${format}`))
      ).toBe(
        "V2 delivery ledger has no workflow id format: migrate() must succeed first"
      );
    }
    // Neither format can be written under it.
    expect(
      await baseEraBuild(sql).recordStartIntent(
        inputFor(`future-${randomUUID()}`)
      )
    ).toBe(formatRefusal("tenant-scoped.v3", "future-build.v9", "legacy"));

    // Marker text outside the id grammar is never repeated in the message.
    await sql`UPDATE loop_supervisor_message_v2_schema_marker SET value = ${"v3 format\nsecond line"}, build_id = NULL WHERE name = 'workflow-id-format.v1'`;
    const unreadable = await open("upgrade-build.v3");
    expect(await refusalOf(unreadable.migrate())).toBe(
      'V2 delivery ledger records workflow id format "<unreadable>" (written by build <unreadable>), which this build does not support; it supports "legacy" and "deployment". Run a build that supports the recorded format'
    );
  });

  test("a database a deployment-id build wrote before the marker existed keeps deployment ids only on explicit opt-in", async () => {
    const { marker, open, sql } = await sharedDatabase();
    // The pre-marker deployment-id build: deployment rows, no marker.
    const preMarker = await open("pre-marker-build.v1");
    await preMarker.migrate();
    await sql`DELETE FROM loop_supervisor_message_v2_schema_marker WHERE name = 'workflow-id-format.v1'`;
    await sql`DROP TRIGGER loop_supervisor_message_v2_start_intent_format_guard_v1 ON loop_supervisor_message_v2_start_intent`;
    const pending = inputFor(`pre-marker-${randomUUID()}`);
    const pendingId = workflowIdOf(pending);
    await sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json, deployment) VALUES (${pendingId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(pending)}::jsonb, ${DEPLOYMENT})`;

    // The default is legacy, which these unsettled rows forbid.
    const defaulted = await open("marker-build.v1");
    expect(await refusalOf(defaulted.migrate())).toBe(
      'V2 delivery ledger cannot return to legacy workflow ids: 1 deployment-format start intents have no terminal outcome. Keep a2aV2.workflowIdFormat "deployment" until they settle'
    );
    expect(await marker()).toEqual([]);

    const optedIn = await open("marker-build.v1", "deployment");
    await optedIn.migrate();
    expect(await marker()).toEqual([
      { build_id: "marker-build.v1", value: "deployment" },
    ]);
    expect(await optedIn.workflowIdFor(SCOPE, pending.dedupeKey)).toBe(
      pendingId
    );

    // Once settled, returning to legacy guards its legacy id too.
    await optedIn.recordTerminalOutcome(pendingId, SCOPE, "acknowledged");
    const returned = await open("marker-build.v2", "legacy");
    await returned.migrate();
    expect(await baseEraBuild(sql).recordStartIntent(pending)).toBe(
      `V2 start intent ${legacyWorkflowIdOf(pending)} is held under a deployment workflow id; it is never recorded again under its legacy id`
    );
  });

  test("refuses an invalid build id or workflow id format at connect", async () => {
    for (const [options, message] of [
      [{ deployment: DEPLOYMENT }, "V2 delivery ledger build id is invalid"],
      [
        { buildId: "build with spaces", deployment: DEPLOYMENT },
        "V2 delivery ledger build id is invalid",
      ],
      [
        { ...DEPLOYMENT_FORMAT, workflowIdFormat: "tenant" },
        "V2 delivery ledger workflow id format is invalid",
      ],
    ] as const) {
      const refused = await PostgresSupervisorMessageV2DeliveryLedger.connect(
        postgres.databaseUrl(),
        options as unknown as typeof DEPLOYMENT_FORMAT
      ).then(
        async (connected) => {
          await connected.close();
          return "connected";
        },
        (error: Error) => error.message
      );
      expect(refused).toBe(message);
    }
  });
});

/** Each vendored base-era file and its git blob id at 40097564. */
const BASE_ERA_BLOBS = {
  "supervisor-message-v2-contract.ts":
    "d0817f1d208cfa571f199de91ef9820301294e06",
  "supervisor-message-v2-delivery-ledger.ts":
    "7627d03498d12eca502d03d339628120569d357c",
  "supervisor-message-v2-runtime.ts":
    "dec3179efce0947012f581f34ce1a9f9b7538f90",
  "supervisor-message-v2-workflow-identity.ts":
    "42d53804edaa8e891df4e3c2dc6d7439669dab7c",
  "supervisor-message-workflow.ts": "5b47b5b8a92d3308c924c48b7de08013cbb12ec4",
  "workflow-port.ts": "b7cc06349ae1801367cda6e6c2d23e27626aec7a",
} as const;

/** `git hash-object` of a file's bytes. */
const gitBlobId = (bytes: Buffer): string =>
  createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");

describe("V2 rollback to the real base-era (40097564) ledger on PostgreSQL", () => {
  /** One database shared by this build's ledgers and the base-era ledger. */
  const sharedDatabase = async () => {
    const databaseUrl = await freshDatabase();
    const open = async (
      buildId: string,
      options: {
        deployment?: string;
        resultGraphKey?: SupervisorResultGraphKey;
        workflowIdFormat?: "deployment" | "legacy";
      } = {}
    ) => {
      const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
        databaseUrl,
        { buildId, deployment: DEPLOYMENT, ...options }
      );
      opened.push(ledger);
      await ledger.migrate();
      return ledger;
    };
    const openBaseEra = async () => {
      const ledger = await BaseEraLedger.connect(databaseUrl);
      opened.push(ledger);
      await ledger.migrate();
      return ledger;
    };
    return { open, openBaseEra };
  };

  const settle = (work: Promise<unknown>) =>
    work.then(
      () => "accepted",
      (error: Error) => error.message
    );

  test("the vendored base-era ledger files are byte-identical to 40097564", () => {
    for (const [file, blob] of Object.entries(BASE_ERA_BLOBS)) {
      expect({
        blob: gitBlobId(readFileSync(join(BASE_ERA_DIR, file))),
        file,
      }).toEqual({ blob, file });
    }
  });

  test("rollback: the real base-era ledger migrates, recovers, deduplicates and records over default legacy-write rows, and this build reads its rows back", async () => {
    const { open, openBaseEra } = await sharedDatabase();
    const upgraded = await open("upgrade-build.v1");
    const first = inputFor(`real-rollback-first-${randomUUID()}`);
    const second = inputFor(`real-rollback-second-${randomUUID()}`);
    const recorded: string[] = [];
    for (const input of [first, second]) {
      const workflowId = await upgraded.workflowIdFor(SCOPE, input.dedupeKey);
      // The id the base-era contract derives, from its own code.
      expect(workflowId).toBe(baseEraContractId(SCOPE, input.dedupeKey));
      await upgraded.recordStartIntent(workflowId, SCOPE, input);
      recorded.push(workflowId);
    }

    const baseEra = await openBaseEra();
    expect(
      (await baseEra.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual([...recorded].sort());
    // A sender retry of a message this build accepted, a new message, and
    // a terminal outcome, all through the base-era code.
    const [firstId, secondId] = recorded as [string, string];
    expect(await settle(baseEra.recordStartIntent(firstId, SCOPE, first))).toBe(
      "accepted"
    );
    const third = inputFor(`real-rollback-third-${randomUUID()}`);
    const thirdId = baseEraContractId(SCOPE, third.dedupeKey);
    expect(await settle(baseEra.recordStartIntent(thirdId, SCOPE, third))).toBe(
      "accepted"
    );
    await baseEra.recordTerminalOutcome(secondId, SCOPE, "acknowledged");
    expect(await baseEra.recoverableStarts()).toHaveLength(3);

    // Roll forward again: this build reads every base-era row as its own.
    const again = await open("upgrade-build.v2");
    expect(again.workflowIdFormat).toBe("legacy");
    expect(await again.workflowIdFor(SCOPE, third.dedupeKey)).toBe(thirdId);
    expect(await again.terminalOutcome(secondId, SCOPE)).toBe("acknowledged");
    expect(
      (await again.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual([firstId, secondId, thirdId].sort());
  });

  test("after the flip to deployment ids the real base-era ledger can record nothing, and its recovery refuses instead of starting", async () => {
    const { open, openBaseEra } = await sharedDatabase();
    const upgraded = await open("upgrade-build.v1");
    const held = inputFor(`real-flip-held-${randomUUID()}`);
    const heldId = await upgraded.workflowIdFor(SCOPE, held.dedupeKey);
    await upgraded.recordStartIntent(heldId, SCOPE, held);
    const flipped = await open("flip-build.v1", {
      workflowIdFormat: "deployment",
    });
    const fresh = inputFor(`real-flip-fresh-${randomUUID()}`);
    await flipped.recordStartIntent(workflowIdOf(fresh), SCOPE, fresh);

    const baseEra = await openBaseEra();
    const newcomer = inputFor(`real-flip-newcomer-${randomUUID()}`);
    for (const input of [held, newcomer]) {
      expect(
        await settle(
          baseEra.recordStartIntent(
            baseEraContractId(SCOPE, input.dedupeKey),
            SCOPE,
            input
          )
        )
      ).toBe(formatRefusal("deployment", "flip-build.v1", "legacy"));
    }
    expect(await settle(baseEra.recoverableStarts())).toBe(
      "V2 recovery ledger row has an invalid workflow binding"
    );
  });

  test("rollback limit: the base-era ledger does not publish a result this build bound to its keyed graph, and the database refuses its re-bind of that message to its unkeyed graph", async () => {
    const { open, openBaseEra } = await sharedDatabase();
    const key = SupervisorResultGraphKey.fromSecret(
      randomBytes(32).toString("hex")
    );
    const upgraded = await open("upgrade-build.v1", { resultGraphKey: key });
    const input = inputFor(`real-rollback-binding-${randomUUID()}`);
    const workflowId = await upgraded.workflowIdFor(SCOPE, input.dedupeKey);
    await upgraded.recordStartIntent(workflowId, SCOPE, input);
    const keyed: SupervisorA2AResultBinding = {
      a2aTaskId: "task:rollback-binding",
      graphTaskId: "result-node",
      graphWorkflowId: deriveSupervisorMessageV2ResultGraphWorkflowId(
        key,
        SCOPE,
        workflowId
      ),
      messageWorkflowId: workflowId,
      recipient: input.to,
    };
    await upgraded.bindResult(SCOPE, keyed);
    expect(
      await upgraded.resultBinding(SCOPE, workflowId, keyed.a2aTaskId)
    ).toEqual(keyed);

    const baseEra = await openBaseEra();
    expect(
      await baseEra.resultBinding(SCOPE, workflowId, keyed.a2aTaskId)
    ).toBeUndefined();
    const unkeyed = {
      ...keyed,
      graphWorkflowId: baseEraResultGraphId(SCOPE, workflowId),
    };
    // Since the result graph key rotation, a binding recorded under a key is
    // immutable in the database itself, for every writer: the base-era
    // ledger's replacement of a "body-chosen" binding is refused, and the
    // keyed binding stays as this build recorded it.
    await expect(baseEra.bindResult(SCOPE, unkeyed)).rejects.toThrow(
      "result binding recorded under a result graph key is immutable"
    );
    expect(
      await baseEra.resultBinding(SCOPE, workflowId, keyed.a2aTaskId)
    ).toBeUndefined();
    expect(
      await upgraded.resultBinding(SCOPE, workflowId, keyed.a2aTaskId)
    ).toEqual(keyed);
  });

  test("default legacy-write mode does not isolate deployments that share a database: each recovers and resolves the other's messages until the flip", async () => {
    const { open } = await sharedDatabase();
    const queueA = await open("upgrade-build.v1", { deployment: "queue-a" });
    const queueB = await open("upgrade-build.v1", { deployment: "queue-b" });
    expect([queueA.workflowIdFormat, queueB.workflowIdFormat]).toEqual([
      "legacy",
      "legacy",
    ]);
    const input = inputFor(`shared-legacy-${randomUUID()}`);
    const workflowId = await queueB.workflowIdFor(SCOPE, input.dedupeKey);
    await queueB.recordStartIntent(workflowId, SCOPE, input);

    // queue-a recovers queue-b's intent and resolves its dedupe key to it.
    expect(
      (await queueA.recoverableStarts()).map((start) => start.workflowId)
    ).toEqual([workflowId]);
    expect(await queueA.workflowIdFor(SCOPE, input.dedupeKey)).toBe(workflowId);
    expect(await settle(queueA.startIntent(workflowId, SCOPE))).toBe(
      "accepted"
    );
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
      DEPLOYMENT_FORMAT
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
      /** A new process's runner over the same ledger: a host restart. */
      restart: () => {
        const restartLines: string[] = [];
        const restarted = new SupervisorMessageV2RecoveryRunner({
          coordinator,
          intervalMs: 1000,
          log: (line) => restartLines.push(line),
          now: () => clock,
          operatorConfigPath: "/srv/loop/orchestration.json",
          timer: { clearInterval: () => undefined, setInterval: () => 1 },
        });
        opened.push(restarted);
        return { lines: restartLines, runner: restarted };
      },
      runner,
      sql,
      url,
    };
  };

  const startOutcome = (runner: SupervisorMessageV2RecoveryRunner) =>
    runner.start().then(
      () => "started",
      (error: unknown) => error
    );

  test("an operator quarantine lets every start skip a persistently failing record loudly, and its release returns it to recovery", async () => {
    const h = await failingHarness();
    const refused = await h.canceledIntent();
    await h.refuseOutcomeOf(refused.workflowId);
    const quarantineCommand = `loop orchestration v2-quarantine /srv/loop/orchestration.json ${refused.workflowId} --reason '<why>'`;

    // Decision 7: never skipped by itself. The refusal names the record and
    // the exact command that quarantines it.
    const first = h.restart();
    const refusal = await startOutcome(first.runner);
    expect(refusal).toBeInstanceOf(SupervisorMessageV2RecoveryStartupError);
    expect((refusal as Error).message).toContain(
      `workflow ${refused.workflowId} for ${refused.input.to}: `
    );
    expect((refusal as Error).message).toContain(quarantineCommand);
    expect(first.lines).toEqual([(refusal as Error).message]);

    const quarantined = await h.ledger.quarantineRecovery(refused.workflowId, {
      by: "operator-a",
      reason: "PostgreSQL refuses its outcome; investigating",
    });
    expect(quarantined.created).toBe(true);
    expect(quarantined.quarantine).toEqual({
      at: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      ),
      by: "operator-a",
      reason: "PostgreSQL refuses its outcome; investigating",
      recipient: refused.input.to,
      tenantId: SCOPE.tenantId,
      workflowId: refused.workflowId,
    });
    const { at } = quarantined.quarantine;
    const loud = `V2 recovery QUARANTINED workflow ${refused.workflowId} for ${refused.input.to}: skipped until released (quarantined by operator-a at ${at}: PostgreSQL refuses its outcome; investigating); release it with: loop orchestration v2-quarantine-release /srv/loop/orchestration.json ${refused.workflowId} --reason '<why>'`;

    // Every start skips it, and says so.
    for (const _restart of [1, 2]) {
      const next = h.restart();
      expect(await startOutcome(next.runner)).toBe("started");
      expect(next.lines).toEqual([loud]);
    }
    expect(await h.ledger.terminalOutcome(refused.workflowId, SCOPE)).toBe(
      undefined
    );

    // Released, it is recovered normally again: still failing, so startup
    // refuses again until the cause is fixed.
    await h.ledger.releaseRecoveryQuarantine(refused.workflowId, {
      by: "operator-b",
      reason: "trigger understood",
    });
    expect(await startOutcome(h.restart().runner)).toBeInstanceOf(
      SupervisorMessageV2RecoveryStartupError
    );
    await h.acceptOutcomes();
    const healed = h.restart();
    expect(await startOutcome(healed.runner)).toBe("started");
    expect(healed.lines).toEqual([]);
    expect(await h.ledger.terminalOutcome(refused.workflowId, SCOPE)).toBe(
      "canceled"
    );
  });

  test("a quarantine records who, when and why durably, refuses records that are not this deployment's open ones, and keeps release history", async () => {
    const h = await failingHarness();
    const open = await h.canceledIntent();
    const by = { by: "operator-a", reason: "hold for investigation" };

    const first = await h.ledger.quarantineRecovery(open.workflowId, by);
    const again = await h.ledger.quarantineRecovery(open.workflowId, {
      by: "operator-z",
      reason: "a second operator",
    });
    // Idempotent: the first quarantine stands, unchanged.
    expect(again).toEqual({ created: false, quarantine: first.quarantine });
    expect(await h.ledger.recoveryQuarantines()).toEqual([first.quarantine]);
    expect(await h.ledger.recoveryQuarantines(SCOPE.tenantId)).toEqual([
      first.quarantine,
    ]);
    expect(await h.ledger.recoveryQuarantines("tenant:other")).toEqual([]);
    expect(
      (await h.ledger.recoverableStarts()).find(
        (start) => start.workflowId === open.workflowId
      )
    ).toEqual({
      quarantine: {
        at: first.quarantine.at,
        by: "operator-a",
        reason: "hold for investigation",
      },
      recipient: open.input.to,
      workflowId: open.workflowId,
    });

    const refusalOf = (promise: Promise<unknown>) =>
      promise.then(
        () => "accepted",
        (error: Error) => error.message
      );
    // Unknown, another deployment's, and closed records are refused.
    const unknown = workflowIdOf(inputFor(`unknown-${randomUUID()}`));
    expect(await refusalOf(h.ledger.quarantineRecovery(unknown, by))).toBe(
      `V2 workflow ${unknown} has no start intent recorded by this deployment`
    );
    const theirs = inputFor(`theirs-${randomUUID()}`);
    const theirId = deriveSupervisorMessageV2WorkflowId(
      SCOPE,
      theirs.dedupeKey,
      "another-deployment-queue"
    );
    await h.sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json, deployment) VALUES (${theirId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(theirs)}::jsonb, ${"another-deployment-queue"})`;
    expect(await refusalOf(h.ledger.quarantineRecovery(theirId, by))).toBe(
      `V2 workflow ${theirId} has no start intent recorded by this deployment`
    );
    const closed = await h.canceledIntent();
    await h.ledger.recordTerminalOutcome(closed.workflowId, SCOPE, "canceled");
    expect(
      await refusalOf(h.ledger.quarantineRecovery(closed.workflowId, by))
    ).toBe(
      `V2 workflow ${closed.workflowId} already has a terminal outcome; recovery leaves it alone`
    );
    for (const invalid of [
      { by: "", reason: "why" },
      { by: "operator", reason: "" },
      { by: "operator", reason: "two\nlines" },
      { by: "o".repeat(201), reason: "why" },
      { by: "operator", reason: "r".repeat(1001) },
    ]) {
      expect(
        await refusalOf(h.ledger.quarantineRecovery(open.workflowId, invalid))
      ).toBe(
        "V2 recovery quarantine needs an operator (1-200 characters) and a reason (1-1000 characters) without control characters"
      );
    }

    // A pre-discriminator row is recovered by every deployment sharing the
    // database; another deployment's quarantine of it is not this one's.
    // This database records "deployment", whose format guard refuses a new
    // legacy row, so the row is seeded as one recorded before that flip.
    const legacy = inputFor(`legacy-shared-${randomUUID()}`);
    const legacyId = legacyWorkflowIdOf(legacy);
    await h.sql.begin(async (tx) => {
      await tx`ALTER TABLE loop_supervisor_message_v2_start_intent DISABLE TRIGGER loop_supervisor_message_v2_start_intent_format_guard_v1`;
      await tx`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json) VALUES (${legacyId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(legacy)}::jsonb)`;
      await tx`ALTER TABLE loop_supervisor_message_v2_start_intent ENABLE TRIGGER loop_supervisor_message_v2_start_intent_format_guard_v1`;
    });
    const other = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      h.url,
      { ...DEPLOYMENT_FORMAT, deployment: "another-deployment-queue" }
    );
    opened.push(other);
    await other.quarantineRecovery(legacyId, {
      by: "operator-other",
      reason: "their own hold",
    });
    expect(
      (await other.recoveryQuarantines()).map((entry) => entry.workflowId)
    ).toEqual([legacyId]);
    expect(
      (await h.ledger.recoveryQuarantines()).map((entry) => entry.workflowId)
    ).toEqual([open.workflowId]);
    const ours = (await h.ledger.recoverableStarts()).find(
      (start) => start.workflowId === legacyId
    );
    expect(ours && "quarantine" in ours).toBe(false);
    expect(
      await refusalOf(
        h.ledger.releaseRecoveryQuarantine(legacyId, {
          by: "operator-b",
          reason: "not ours",
        })
      )
    ).toBe(`V2 workflow ${legacyId} is not quarantined`);

    expect(
      await refusalOf(
        h.ledger.releaseRecoveryQuarantine(open.workflowId, {
          by: "operator-b",
          reason: "",
        })
      )
    ).toBe(
      "V2 recovery quarantine needs an operator (1-200 characters) and a reason (1-1000 characters) without control characters"
    );

    // Release: the record leaves the list, and history keeps both sides.
    const released = await h.ledger.releaseRecoveryQuarantine(open.workflowId, {
      by: "operator-b",
      reason: "cause fixed",
    });
    expect(released).toEqual(first.quarantine);
    expect(await h.ledger.recoveryQuarantines()).toEqual([]);
    expect(
      await refusalOf(
        h.ledger.releaseRecoveryQuarantine(open.workflowId, {
          by: "operator-b",
          reason: "again",
        })
      )
    ).toBe(`V2 workflow ${open.workflowId} is not quarantined`);
    const requarantined = await h.ledger.quarantineRecovery(
      open.workflowId,
      by
    );
    expect(requarantined.created).toBe(true);
    const history = await h.sql<
      {
        deployment: string;
        quarantined_by: string;
        reason: string;
        release_reason: string | null;
        released: boolean;
        released_by: string | null;
      }[]
    >`SELECT deployment, quarantined_by, reason, released_by, release_reason, released_at IS NOT NULL AS released FROM loop_supervisor_message_v2_recovery_quarantine WHERE workflow_id = ${open.workflowId} ORDER BY id`;
    expect(history).toEqual([
      {
        deployment: DEPLOYMENT,
        quarantined_by: "operator-a",
        reason: "hold for investigation",
        release_reason: "cause fixed",
        released: true,
        released_by: "operator-b",
      },
      {
        deployment: DEPLOYMENT,
        quarantined_by: "operator-a",
        reason: "hold for investigation",
        release_reason: null,
        released: false,
        released_by: null,
      },
    ]);
  });

  test("a quarantined unreadable row no longer fails the whole sweep, and is named when it does", async () => {
    const h = await failingHarness();
    const healthy = inputFor(`healthy-${randomUUID()}`);
    const healthyId = workflowIdOf(healthy);
    await h.ledger.recordStartIntent(healthyId, SCOPE, healthy);
    const broken = inputFor(`broken-${randomUUID()}`);
    const brokenId = workflowIdOf(broken);
    await h.ledger.recordStartIntent(brokenId, SCOPE, broken);
    // A deployment-format id on a row claiming no deployment: unreadable as
    // either format, so listing it fails the whole sweep.
    await h.sql`UPDATE loop_supervisor_message_v2_start_intent SET deployment = NULL WHERE workflow_id = ${brokenId}`;

    const refused = h.restart();
    const refusal = await startOutcome(refused.runner);
    expect(refusal).toBeInstanceOf(SupervisorMessageV2RecoveryStartupError);
    expect((refusal as Error).message).toBe(
      `V2 initial recovery failed for 1 recorded start: workflow ${brokenId} for an unreadable recipient: SupervisorMessageV2RecoveryRecordError: V2 recovery ledger row ${brokenId} has an invalid workflow binding [to start without it: loop orchestration v2-quarantine /srv/loop/orchestration.json ${brokenId} --reason '<why>']`
    );

    await h.ledger.quarantineRecovery(brokenId, {
      by: "operator-a",
      reason: "tampered row",
    });
    const started = h.restart();
    expect(await startOutcome(started.runner)).toBe("started");
    expect(started.lines).toHaveLength(1);
    expect(started.lines[0]).toStartWith(
      `V2 recovery QUARANTINED workflow ${brokenId} for ${broken.to}: skipped until released (quarantined by operator-a at `
    );
    expect(h.delivered).toEqual([
      deriveSupervisorMessageV2DeliveryId(SCOPE, healthyId, 1),
    ]);
  });

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
