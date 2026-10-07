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
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { SQL } from "bun";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2LegacyWorkflowId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2Input,
  type TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import { PostgresSupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-delivery-ledger";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import {
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryOutcome,
  SupervisorMessageV2RecoveryRunner,
} from "../../src/loop/supervisor-message-v2-runtime";
import { temporalWorkflowBundleBase64 } from "../../src/loop/temporal-workflow-bundle.generated";
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
import {
  WorkflowError,
  WorkflowForeignExecutionError,
} from "../../src/loop/workflow-port";
import { DisposablePostgres } from "../support/disposable-postgres";

/**
 * The coordinator's terminal-marker paths on a real Temporal dev server and a
 * real PostgreSQL ledger. The generic Temporal workflow never returns: a
 * message's own terminal phase (acknowledged, canceled, dead-lettered) leaves
 * the execution RUNNING, and only an engine-level terminate, cancel or timeout
 * closes it, which is what retention can later purge. These tests drive both
 * kinds of closure, and a second deployment sharing the namespace.
 *
 * Assertions read values first and compare them synchronously: a failing
 * `expect(promise).resolves` stalls for about 45 seconds under this runner
 * with a live Temporal connection open.
 */

const fixture = structuredClone(supervisorMessageV2ReplayFixtures[0]);
if (!fixture) {
  throw new Error("missing V2 fixture");
}
const SCOPE: TrustedSupervisorMessageV2Scope = fixture.expectedScope;
const OWNER_DISPATCH = "v2-dispatcher:temporal-retention-owner";
const FOREIGN_DISPATCH = "v2-dispatcher:temporal-retention-foreign";
/** The build these ledgers record as the writer of their id format. */
const RETENTION_BUILD = "temporal-retention.v1";

setDefaultTimeout(60_000);

let environment: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
let owner: TemporalWorkflowPort;
let foreign: TemporalWorkflowPort;
let postgres: DisposablePostgres;
let raw: SQL;
const opened: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  postgres = await DisposablePostgres.create();
  raw = new SQL(postgres.databaseUrl());
  await raw.connect();
  environment = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `v2-retention-owner-${process.pid}`;
  worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue,
    workflowsPath: new URL(
      "../../src/loop/temporal-workflow.ts",
      import.meta.url
    ).pathname,
  });
  workerRun = worker.run();
  owner = new TemporalWorkflowPort(environment.client.workflow, { taskQueue });
  // A second deployment in the same namespace, under its own task queue.
  foreign = new TemporalWorkflowPort(environment.client.workflow, {
    taskQueue: `v2-retention-foreign-${process.pid}`,
  });
}, 180_000);

/** Each ledger holds a connection pool; release them before the server's limit. */
const closeOpened = async () => {
  for (const resource of opened.splice(0).reverse()) {
    await resource.close().catch(() => undefined);
  }
};

afterEach(closeOpened);

afterAll(async () => {
  await closeOpened();
  if (worker?.getState() === "RUNNING") {
    worker.shutdown();
  }
  await workerRun;
  await environment?.teardown();
  await raw?.close({ timeout: 0 });
  await postgres?.close();
});

/** Each ledger's database URL, for writing rows as a previous host did. */
const databaseOf = new Map<PostgresSupervisorMessageV2DeliveryLedger, string>();

/**
 * A ledger in a database of its own: one deployment's durable state. Its
 * deployment is the task queue of the port it is composed with.
 */
const freshLedger = async (
  deployment: string = owner.taskQueue
): Promise<PostgresSupervisorMessageV2DeliveryLedger> => {
  const name = `retention_${randomUUID().replaceAll("-", "")}`;
  await raw.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(postgres.databaseUrl());
  url.pathname = `/${name}`;
  // This host has opted in to deployment-scoped workflow ids.
  const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    url.toString(),
    { buildId: RETENTION_BUILD, deployment, workflowIdFormat: "deployment" }
  );
  opened.push(ledger);
  databaseOf.set(ledger, url.toString());
  await ledger.migrate();
  return ledger;
};

/**
 * A start intent exactly as a pre-discriminator host recorded it: the legacy
 * id, and no deployment (the migrated column stays NULL). That host writes
 * only while the database records the legacy format, so the database is
 * returned to it (by this build in legacy-write mode) for the write, and the
 * ledger then opts in to deployment ids again, as an upgrade would.
 */
const recordLegacyIntent = async (
  ledger: PostgresSupervisorMessageV2DeliveryLedger,
  input: SupervisorMessageV2Input
): Promise<string> => {
  const legacyId = deriveSupervisorMessageV2LegacyWorkflowId(
    SCOPE,
    input.dedupeKey
  );
  const url = databaseOf.get(ledger) ?? "";
  const legacyWrite = await PostgresSupervisorMessageV2DeliveryLedger.connect(
    url,
    {
      buildId: RETENTION_BUILD,
      deployment: ledger.deployment,
      workflowIdFormat: "legacy",
    }
  );
  const sql = new SQL(url);
  await sql.connect();
  try {
    await legacyWrite.migrate();
    await sql`INSERT INTO loop_supervisor_message_v2_start_intent (workflow_id, tenant_id, principal, input_json) VALUES (${legacyId}, ${SCOPE.tenantId}, ${SCOPE.principal}, ${JSON.stringify(input)}::jsonb)`;
  } finally {
    await sql.close({ timeout: 0 });
    await legacyWrite.close();
  }
  await ledger.migrate();
  return legacyId;
};

/** The execution a pre-discriminator host started under the legacy id. */
const startLegacyExecution = (
  input: SupervisorMessageV2Input,
  legacyId: string
) =>
  owner.start({
    input: { input, trustedScope: SCOPE },
    requestId: `legacy-host-start:${legacyId}`,
    workflowId: legacyId,
    workflowType: "supervisor-message.v2",
  });

const inputFor = (maxDeliveryAttempts = 3): SupervisorMessageV2Input => {
  const dedupeKey = `temporal-retention-${randomUUID()}`;
  return {
    ...structuredClone(fixture.input),
    dedupeKey,
    messageId: `message-${dedupeKey}`,
    policy: {
      claimTimeoutMs: 600_000,
      escalationTimeoutMs: 600_000,
      maxDeliveryAttempts,
      retryDelayMs: 600_000,
    },
    principal: SCOPE.principal,
    tenantId: SCOPE.tenantId,
    threadId: `thread-${dedupeKey}`,
  };
};

const coordinatorFor = (
  workflows: TemporalWorkflowPort,
  ledger: PostgresSupervisorMessageV2DeliveryLedger,
  outcome: () => SupervisorMessageV2DeliveryOutcome = () => ({
    status: "accepted",
  }),
  dispatchOwner = OWNER_DISPATCH
) => {
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
    dispatchOwner
  );
  return { coordinator, delivered };
};

/** Settles a promise into a comparable value without a `.rejects` matcher. */
const settle = async (promise: Promise<unknown>) => {
  try {
    return { value: await promise };
  } catch (error) {
    return {
      error: {
        code: (error as { code?: unknown }).code,
        name: (error as Error).name,
      },
    };
  }
};
const CONFLICT = { error: { code: "conflict", name: "WorkflowError" } };

describe("V2 terminal marker on real Temporal and PostgreSQL", () => {
  test("records dead-lettered when a permanent delivery failure ends the message", async () => {
    const ledger = await freshLedger();
    const { coordinator } = coordinatorFor(owner, ledger, () => ({
      reason: "recipient refused",
      status: "permanent-failure",
    }));

    const received = await coordinator.receive(SCOPE, inputFor(3), "receive");

    expect(received.projection.phase).toBe("dead-lettered");
    // The message ended; the engine execution did not.
    expect(await owner.presence(received.workflowId)).toBe("running");
    expect(await ledger.terminalOutcome(received.workflowId, SCOPE)).toBe(
      "dead-lettered"
    );
  });

  test("labels a failed last attempt exhausted on the delivery path and on both sweep paths", async () => {
    for (const failure of ["permanent-failure", "transient-failure"] as const) {
      const delivering = await freshLedger();
      const { coordinator } = coordinatorFor(owner, delivering, () => ({
        reason: "recipient unavailable",
        status: failure,
      }));
      const input = inputFor(1);
      const { workflowId } = await coordinator.receive(
        SCOPE,
        input,
        `receive-${failure}`
      );
      const delivered = await delivering.terminalOutcome(workflowId, SCOPE);
      expect(delivered).toBe("exhausted");

      // Ledgers of the same deployment that hold the intent with no marker,
      // as if the delivering process stopped before recording it: a sweep
      // over the running execution, then over the terminated one.
      const swept: unknown[] = [];
      for (const close of [false, true]) {
        if (close) {
          await environment.client.workflow
            .getHandle(workflowId)
            .terminate("operator terminate");
          expect(await owner.presence(workflowId)).toBe("closed");
        }
        const sweeping = await freshLedger();
        await sweeping.recordStartIntent(workflowId, SCOPE, input);
        expect(
          await coordinatorFor(owner, sweeping).coordinator.recoverPending()
        ).toBe(0);
        swept.push(await sweeping.terminalOutcome(workflowId, SCOPE));
      }
      expect(swept).toEqual([delivered, delivered]);
    }
  });

  test("records acknowledged, not completed, when the recipient acknowledges", async () => {
    const ledger = await freshLedger();
    const { coordinator } = coordinatorFor(owner, ledger);
    const input = inputFor();
    const { workflowId } = await coordinator.receive(SCOPE, input, "receive");

    await coordinator.claim(SCOPE, workflowId, input.to, "claim");
    const acknowledged = await coordinator.acknowledge(
      SCOPE,
      workflowId,
      input.to,
      "acknowledge"
    );

    expect(acknowledged.phase).toBe("acknowledged");
    expect(await ledger.terminalOutcome(workflowId, SCOPE)).toBe(
      "acknowledged"
    );
  });

  test("a sweep records a cancel issued outside the coordinator while the execution still runs", async () => {
    const ledger = await freshLedger();
    const { coordinator, delivered } = coordinatorFor(owner, ledger);
    const { workflowId } = await coordinator.receive(
      SCOPE,
      inputFor(),
      "receive"
    );
    expect(delivered).toHaveLength(1);

    await owner.cancel({
      reason: "operator",
      requestId: "operator-cancel",
      workflowId,
    });
    expect(await ledger.terminalOutcome(workflowId, SCOPE)).toBe(undefined);
    expect(await owner.presence(workflowId)).toBe("running");

    expect(await coordinator.recoverPending()).toBe(0);

    expect(await ledger.terminalOutcome(workflowId, SCOPE)).toBe("canceled");
    expect(delivered).toHaveLength(1);
  });

  test("a sweep records terminated for an execution the engine closed while its message was open", async () => {
    for (const close of ["terminate", "cancel"] as const) {
      const ledger = await freshLedger();
      const { coordinator } = coordinatorFor(owner, ledger);
      const { workflowId } = await coordinator.receive(
        SCOPE,
        inputFor(),
        `receive-${close}`
      );
      const handle = environment.client.workflow.getHandle(workflowId);
      if (close === "terminate") {
        await handle.terminate("operator terminate");
      } else {
        await handle.cancel();
        await handle.result().catch(() => undefined);
      }
      expect(await owner.presence(workflowId)).toBe("closed");

      expect(await coordinator.recoverPending()).toBe(0);

      expect(await ledger.terminalOutcome(workflowId, SCOPE)).toBe(
        "terminated"
      );
    }
  });

  test("another deployment's sweep never records the owner's outcome, and its host still starts", async () => {
    const ownerLedger = await freshLedger();
    const ownerSide = coordinatorFor(owner, ownerLedger);
    const input = inputFor();

    // Both deployments accepted the same dedupe key in the same scope before
    // workflow ids carried a deployment, so both hold it under the one legacy
    // id: the namespace collision the format change removes for new messages
    // but cannot remove for intents already recorded.
    const foreignLedger = await freshLedger(foreign.taskQueue);
    const foreignSide = coordinatorFor(
      foreign,
      foreignLedger,
      () => {
        throw new Error("a foreign execution must never be delivered");
      },
      FOREIGN_DISPATCH
    );
    const workflowId = await recordLegacyIntent(ownerLedger, input);
    expect(await recordLegacyIntent(foreignLedger, input)).toBe(workflowId);
    await ownerSide.coordinator.receive(SCOPE, input, "owner-receive");
    expect(
      await settle(
        foreignSide.coordinator.receive(SCOPE, input, "foreign-receive")
      )
    ).toEqual(CONFLICT);

    // Owner execution running: the foreign sweep defers, records nothing.
    const runningSweep = await settle(foreignSide.coordinator.recoverPending());
    expect(await foreignLedger.terminalOutcome(workflowId, SCOPE)).toBe(
      undefined
    );
    expect(runningSweep).toEqual(CONFLICT);

    // Owner execution closed by the engine: still not the foreign outcome.
    // The durable marker is checked first: it is the permanent damage.
    await environment.client.workflow
      .getHandle(workflowId)
      .terminate("operator terminate");
    expect(await owner.presence(workflowId)).toBe("closed");
    const closedSweep = await settle(foreignSide.coordinator.recoverPending());
    expect(await foreignLedger.terminalOutcome(workflowId, SCOPE)).toBe(
      undefined
    );
    expect(closedSweep).toEqual(CONFLICT);
    expect(await settle(foreign.presence(workflowId))).toEqual(CONFLICT);

    // The foreign host's startup survives the held ID and keeps sweeping.
    const lines: string[] = [];
    const intervals: (() => void)[] = [];
    const runner = new SupervisorMessageV2RecoveryRunner({
      coordinator: foreignSide.coordinator,
      intervalMs: 1000,
      log: (line) => lines.push(line),
      timer: {
        clearInterval: () => undefined,
        setInterval: (callback) => {
          intervals.push(callback);
          return intervals.length;
        },
      },
    });
    try {
      expect(await settle(runner.start())).toEqual({ value: undefined });
      expect(intervals).toHaveLength(1);
      // The held ID is reported per record (which workflow and recipient)
      // instead of failing the sweep, so startup never sees the conflict.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith(
        `V2 recovery skipped workflow ${workflowId} for ${input.to}: WorkflowError (conflict): `
      );
    } finally {
      await runner.close();
    }
    expect(await foreignLedger.terminalOutcome(workflowId, SCOPE)).toBe(
      undefined
    );

    // The owner's own sweep records its outcome.
    expect(await ownerSide.coordinator.recoverPending()).toBe(0);
    expect(await ownerLedger.terminalOutcome(workflowId, SCOPE)).toBe(
      "terminated"
    );
  });
});

describe("V2 workflow id deployment discriminator on real Temporal and PostgreSQL", () => {
  test("the shipped workflow bundle delivers a message under its deployment-format id", async () => {
    // The orchestration server runs this generated bundle in process, not
    // the workflow source: its delivery_request must accept the new id.
    const taskQueue = `v2-bundle-${process.pid}`;
    const bundled = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowBundle: {
        code: Buffer.from(temporalWorkflowBundleBase64, "base64").toString(
          "utf8"
        ),
      },
    });
    const bundledRun = bundled.run();
    try {
      const port = new TemporalWorkflowPort(environment.client.workflow, {
        taskQueue,
      });
      const { coordinator, delivered } = coordinatorFor(
        port,
        await freshLedger(taskQueue)
      );
      const input = inputFor();
      const received = await settle(
        coordinator.receive(SCOPE, input, "bundle-receive")
      );
      const workflowId = deriveSupervisorMessageV2WorkflowId(
        SCOPE,
        input.dedupeKey,
        taskQueue
      );
      expect(received).toMatchObject({
        value: { projection: { deliveryAttempts: 1 }, workflowId },
      });
      expect(delivered).toEqual([
        deriveSupervisorMessageV2DeliveryId(SCOPE, workflowId, 1),
      ]);
    } finally {
      bundled.shutdown();
      await bundledRun;
    }
  }, 120_000);

  test("two deployments sharing a namespace run the same message under their own ids", async () => {
    // The other deployment's own worker, polling its own queue.
    const foreignWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: foreign.taskQueue,
      workflowsPath: new URL(
        "../../src/loop/temporal-workflow.ts",
        import.meta.url
      ).pathname,
    });
    const foreignRun = foreignWorker.run();
    try {
      await bothDeploymentsReceive();
    } finally {
      foreignWorker.shutdown();
      await foreignRun;
    }
  }, 120_000);

  const bothDeploymentsReceive = async () => {
    const input = inputFor();
    const ownerLedger = await freshLedger();
    const ownerSide = coordinatorFor(owner, ownerLedger);
    const foreignLedger = await freshLedger(foreign.taskQueue);
    const foreignSide = coordinatorFor(
      foreign,
      foreignLedger,
      undefined,
      FOREIGN_DISPATCH
    );

    const ours = await settle(
      ownerSide.coordinator.receive(SCOPE, input, "owner-receive")
    );
    const theirs = await settle(
      foreignSide.coordinator.receive(SCOPE, input, "foreign-receive")
    );

    expect(ours).toMatchObject({ value: { created: true } });
    expect(theirs).toMatchObject({ value: { created: true } });
    const ourId = (ours as { value: { workflowId: string } }).value.workflowId;
    const theirId = (theirs as { value: { workflowId: string } }).value
      .workflowId;
    expect(ourId).toBe(
      deriveSupervisorMessageV2WorkflowId(
        SCOPE,
        input.dedupeKey,
        owner.taskQueue
      )
    );
    expect(theirId).toBe(
      deriveSupervisorMessageV2WorkflowId(
        SCOPE,
        input.dedupeKey,
        foreign.taskQueue
      )
    );
    expect(ownerSide.delivered).toHaveLength(1);
    expect(foreignSide.delivered).toHaveLength(1);
    // Each execution runs on its own deployment's queue only.
    expect(await owner.presence(ourId)).toBe("running");
    expect(await foreign.presence(theirId)).toBe("running");
    expect(await settle(foreign.presence(ourId))).toEqual(CONFLICT);
    expect(await settle(owner.presence(theirId))).toEqual(CONFLICT);
  };

  test("an in-flight legacy execution is recovered, deduplicated and acknowledged under its legacy id", async () => {
    const input = inputFor();
    const ledger = await freshLedger();
    const { coordinator, delivered } = coordinatorFor(owner, ledger);
    // The pre-discriminator host recorded the intent and started the
    // execution, then stopped before delivering.
    const legacyId = await recordLegacyIntent(ledger, input);
    await startLegacyExecution(input, legacyId);

    expect(await coordinator.recoverPending()).toBe(1);
    expect(delivered).toEqual([
      deriveSupervisorMessageV2DeliveryId(SCOPE, legacyId, 1),
    ]);

    // A sender retry after the upgrade: the same execution, not a new one.
    const retried = await coordinator.receive(SCOPE, input, "sender-retry");
    expect(retried.workflowId).toBe(legacyId);
    expect(retried.created).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(
      await owner.presence(
        deriveSupervisorMessageV2WorkflowId(
          SCOPE,
          input.dedupeKey,
          owner.taskQueue
        )
      )
    ).toBe("missing");

    await coordinator.claim(SCOPE, legacyId, input.to, "legacy-claim");
    const acknowledged = await coordinator.acknowledge(
      SCOPE,
      legacyId,
      input.to,
      "legacy-ack"
    );
    expect(acknowledged.phase).toBe("acknowledged");
    expect(await ledger.terminalOutcome(legacyId, SCOPE)).toBe("acknowledged");
    expect(await coordinator.recoverPending()).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  /**
   * A legacy id both deployments hold: the owner's execution runs on its
   * queue, and the other deployment's coordinator addresses it by that id.
   * Its status read, claim and acknowledgement are each refused before
   * reaching the execution, and nothing is recorded on either side.
   */
  const heldLegacyMessage = async () => {
    const input = inputFor();
    const ownerLedger = await freshLedger();
    const ownerSide = coordinatorFor(owner, ownerLedger);
    const foreignLedger = await freshLedger(foreign.taskQueue);
    const foreignSide = coordinatorFor(
      foreign,
      foreignLedger,
      () => {
        throw new Error("a foreign execution must never be delivered");
      },
      FOREIGN_DISPATCH
    );
    const workflowId = await recordLegacyIntent(ownerLedger, input);
    await recordLegacyIntent(foreignLedger, input);
    await ownerSide.coordinator.receive(SCOPE, input, "owner-receive");
    const before = await ownerSide.coordinator.status(SCOPE, workflowId);
    expect(before.phase).toBe("routed");
    return { before, foreignLedger, foreignSide, input, ownerSide, workflowId };
  };

  test("refuses another deployment's status read of the owner's execution", async () => {
    const { foreignSide, workflowId } = await heldLegacyMessage();
    expect(
      await settle(foreignSide.coordinator.status(SCOPE, workflowId))
    ).toEqual(CONFLICT);
  });

  test("refuses another deployment's claim of the owner's execution and leaves it unclaimed", async () => {
    const { before, foreignSide, input, ownerSide, workflowId } =
      await heldLegacyMessage();
    expect(
      await settle(
        foreignSide.coordinator.claim(
          SCOPE,
          workflowId,
          input.to,
          "foreign-claim"
        )
      )
    ).toEqual(CONFLICT);
    expect(await ownerSide.coordinator.status(SCOPE, workflowId)).toEqual(
      before
    );
  });

  test("refuses another deployment's acknowledgement of the owner's execution and records nothing", async () => {
    const { before, foreignLedger, foreignSide, input, ownerSide, workflowId } =
      await heldLegacyMessage();
    await ownerSide.coordinator.claim(SCOPE, workflowId, input.to, "claim");
    const claimed = await ownerSide.coordinator.status(SCOPE, workflowId);
    expect(claimed.phase).not.toBe(before.phase);
    expect(
      await settle(
        foreignSide.coordinator.acknowledge(
          SCOPE,
          workflowId,
          input.to,
          "foreign-ack"
        )
      )
    ).toEqual(CONFLICT);
    expect(await ownerSide.coordinator.status(SCOPE, workflowId)).toEqual(
      claimed
    );
    expect(await foreignLedger.terminalOutcome(workflowId, SCOPE)).toBe(
      undefined
    );
  });
});

/** Another workflow type, task-graph.v1, under `workflowId` on our own queue. */
const startTaskGraphUnder = async (workflowId: string): Promise<void> => {
  await owner.start({
    input: {
      graphId: "same-queue-conflict",
      nodes: [
        {
          acceptanceChecks: [{ checkId: "artifact", kind: "artifact" }],
          authorityGates: [],
          dependencies: [],
          ownerRepository: "agents-collab",
          readScopes: ["src"],
          specArtifactRef: `artifact://sha256/${"a".repeat(64)}`,
          taskId: "node",
          writeScopes: [],
        },
      ],
      schema: "task-graph.v1",
    },
    requestId: "same-queue-conflict",
    workflowId,
    workflowType: "task-graph.v1",
  });
};

describe("V2 recovery of a same-queue workflow type conflict on real Temporal and PostgreSQL", () => {
  test("another workflow type under a recorded id on this deployment's own queue refuses startup until an operator quarantines it", async () => {
    const ledger = await freshLedger();
    const { coordinator } = coordinatorFor(owner, ledger, () => {
      throw new Error("the conflicting execution must never be delivered");
    });
    const input = inputFor();
    const workflowId = deriveSupervisorMessageV2WorkflowId(
      SCOPE,
      input.dedupeKey,
      owner.taskQueue
    );
    await ledger.recordStartIntent(workflowId, SCOPE, input);
    // Our own queue holds the id, as another workflow type: no other
    // deployment is involved, so this is not a foreign execution.
    await startTaskGraphUnder(workflowId);
    try {
      // The port tells the two conflicts apart.
      const sameQueue = await owner
        .start({
          input: { input, trustedScope: SCOPE },
          requestId: "probe",
          workflowId,
          workflowType: "supervisor-message.v2",
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(sameQueue).toBeInstanceOf(WorkflowError);
      expect(sameQueue).not.toBeInstanceOf(WorkflowForeignExecutionError);
      expect((sameQueue as WorkflowError).code).toBe("conflict");
      const otherQueue = await foreign.presence(workflowId).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(otherQueue).toBeInstanceOf(WorkflowForeignExecutionError);

      const runnerOf = () => {
        const lines: string[] = [];
        const runner = new SupervisorMessageV2RecoveryRunner({
          coordinator,
          intervalMs: 1000,
          log: (line) => lines.push(line),
          operatorConfigPath: "/srv/loop/orchestration.json",
          timer: { clearInterval: () => undefined, setInterval: () => 1 },
        });
        opened.push(runner);
        return { lines, runner };
      };
      const refused = runnerOf();
      const refusal = await settle(refused.runner.start());
      expect(refusal).toEqual({
        error: {
          code: undefined,
          name: "SupervisorMessageV2RecoveryStartupError",
        },
      });
      expect(refused.lines).toEqual([
        `V2 initial recovery failed for 1 recorded start: workflow ${workflowId} for ${input.to}: WorkflowError (conflict): workflow ${workflowId} already exists as task-graph.v1 [to start without it: loop orchestration v2-quarantine /srv/loop/orchestration.json ${workflowId} --reason '<why>']`,
      ]);

      await ledger.quarantineRecovery(workflowId, {
        by: "operator-a",
        reason: "task graph started under a message id",
      });
      const started = runnerOf();
      expect(await settle(started.runner.start())).toEqual({
        value: undefined,
      });
      expect(started.lines).toHaveLength(1);
      expect(started.lines[0]).toStartWith(
        `V2 recovery QUARANTINED workflow ${workflowId} for ${input.to}: skipped until released (quarantined by operator-a at `
      );
      expect(await ledger.terminalOutcome(workflowId, SCOPE)).toBe(undefined);
    } finally {
      await environment.client.workflow
        .getHandle(workflowId)
        .terminate()
        .catch(() => undefined);
    }
  });

  test("a CLOSED execution of another workflow type under a recorded id on this deployment's own queue refuses startup and records no outcome", async () => {
    const ledger = await freshLedger();
    const { coordinator } = coordinatorFor(owner, ledger, () => {
      throw new Error("the conflicting execution must never be delivered");
    });
    const input = inputFor();
    const workflowId = deriveSupervisorMessageV2WorkflowId(
      SCOPE,
      input.dedupeKey,
      owner.taskQueue
    );
    await ledger.recordStartIntent(workflowId, SCOPE, input);
    await startTaskGraphUnder(workflowId);
    // Closed, on our own queue: presence says "closed", and recovery would
    // otherwise read the other type's status as this message's outcome.
    await environment.client.workflow.getHandle(workflowId).terminate();
    expect(await owner.presence(workflowId)).toBe("closed");

    const lines: string[] = [];
    const runner = new SupervisorMessageV2RecoveryRunner({
      coordinator,
      intervalMs: 1000,
      log: (line) => lines.push(line),
      operatorConfigPath: "/srv/loop/orchestration.json",
      timer: { clearInterval: () => undefined, setInterval: () => 1 },
    });
    opened.push(runner);
    const refusal = await settle(runner.start());
    expect(refusal).toEqual({
      error: {
        code: undefined,
        name: "SupervisorMessageV2RecoveryStartupError",
      },
    });
    expect(lines).toEqual([
      `V2 initial recovery failed for 1 recorded start: workflow ${workflowId} for ${input.to}: WorkflowError (conflict): workflow ${workflowId} is not a supervisor-message.v2 execution [to start without it: loop orchestration v2-quarantine /srv/loop/orchestration.json ${workflowId} --reason '<why>']`,
    ]);
    // Nothing was recorded as this message's outcome.
    expect(await ledger.terminalOutcome(workflowId, SCOPE)).toBe(undefined);
  });
});
