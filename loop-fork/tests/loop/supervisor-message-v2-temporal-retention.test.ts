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
import { TemporalWorkflowPort } from "../../src/loop/temporal-workflow-port";
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

/** A ledger in a database of its own: one deployment's durable state. */
const freshLedger =
  async (): Promise<PostgresSupervisorMessageV2DeliveryLedger> => {
    const name = `retention_${randomUUID().replaceAll("-", "")}`;
    await raw.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(postgres.databaseUrl());
    url.pathname = `/${name}`;
    const ledger = await PostgresSupervisorMessageV2DeliveryLedger.connect(
      url.toString()
    );
    opened.push(ledger);
    await ledger.migrate();
    return ledger;
  };

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

const workflowIdOf = (input: SupervisorMessageV2Input) =>
  deriveSupervisorMessageV2WorkflowId(SCOPE, input.dedupeKey);

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
    const workflowId = workflowIdOf(input);

    // The foreign deployment accepted the same dedupe key in the same scope
    // (the namespace collision the pending ID format change removes).
    const foreignLedger = await freshLedger();
    const foreignSide = coordinatorFor(
      foreign,
      foreignLedger,
      () => {
        throw new Error("a foreign execution must never be delivered");
      },
      FOREIGN_DISPATCH
    );
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
      expect(lines).toEqual([
        "V2 initial recovery deferred an intent held by another deployment",
      ]);
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
