import { describe, expect, test } from "bun:test";
import {
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2DeliveryEnvelope,
  type TrustedSupervisorMessageV2Scope,
} from "../../src/loop/supervisor-message-v2-contract";
import { supervisorMessageV2ReplayFixtures } from "../../src/loop/supervisor-message-v2-replay-fixtures";
import {
  SupervisorMessageV2Coordinator,
  type SupervisorMessageV2DeliveryLedger,
  type SupervisorMessageV2RecoveryPort,
  type SupervisorMessageV2RecoveryQuarantine,
  SupervisorMessageV2RecoveryRecordError,
  SupervisorMessageV2RecoveryRunner,
  SupervisorMessageV2RecoveryStartupError,
  type SupervisorMessageV2TerminalOutcome,
} from "../../src/loop/supervisor-message-v2-runtime";
import {
  WorkflowError,
  WorkflowForeignExecutionError,
  type WorkflowPort,
  type WorkflowPresence,
  type WorkflowQueryCommand,
  type WorkflowSignalCommand,
  type WorkflowStartCommand,
} from "../../src/loop/workflow-port";

const fixture = supervisorMessageV2ReplayFixtures[0];
if (!fixture) {
  throw new Error("missing V2 fixture");
}
const SCOPE = fixture.expectedScope;
const DEPLOYMENT = "recovery-test-queue";
const WORKFLOW_ID = deriveSupervisorMessageV2WorkflowId(
  SCOPE,
  fixture.input.dedupeKey,
  DEPLOYMENT
);
const OTHER_INPUT = { ...fixture.input, dedupeKey: "v2-recovery-other" };
const OTHER_WORKFLOW_ID = deriveSupervisorMessageV2WorkflowId(
  SCOPE,
  OTHER_INPUT.dedupeKey,
  DEPLOYMENT
);

const unused = (name: string) => () => {
  throw new Error(`${name} is not used by recovery`);
};

/**
 * Mirrors the Temporal port at the recovery boundary: `isClosed` is false
 * both for a running execution and for one Temporal no longer knows about,
 * while `presence` distinguishes the two.
 */
const workflowsWith = (
  presence: WorkflowPresence,
  options: {
    foreign?: string;
    /** Overrides `presence` per call; may throw, as the Temporal port does. */
    presenceOf?: (workflowId: string, call: number) => WorkflowPresence;
    /** An error `start` throws for this ID instead of starting it. */
    startError?: (workflowId: string) => Error | undefined;
    status?: (workflowId: string) => Record<string, unknown>;
    withoutPresence?: boolean;
  } = {}
) => {
  const starts: WorkflowStartCommand[] = [];
  const signals: WorkflowSignalCommand[] = [];
  const presenceChecks: string[] = [];
  const port: WorkflowPort = {
    cancel: unused("cancel"),
    inspect: unused("inspect"),
    isClosed: () => presence === "closed",
    ...(options.withoutPresence
      ? {}
      : {
          presence: (workflowId: string) => {
            presenceChecks.push(workflowId);
            return options.presenceOf
              ? options.presenceOf(
                  workflowId,
                  presenceChecks.filter((id) => id === workflowId).length
                )
              : presence;
          },
        }),
    query: (command: WorkflowQueryCommand) => ({
      revision: 1,
      status: "running",
      value:
        command.name === "delivery_pending"
          ? false
          : ((options.status?.(command.workflowId) ?? {
              deliveredAt: null,
              deliveryAttempts: 0,
              nextRetryAt: null,
              phase: "routed",
            }) as never),
      workflowId: command.workflowId,
    }),
    signal: (command) => {
      signals.push(command);
      return {
        replayed: false,
        revision: 2,
        status: "running",
        workflowId: command.workflowId,
      };
    },
    start: (command) => {
      const failure = options.startError?.(command.workflowId);
      if (failure) {
        throw failure;
      }
      if (command.workflowId === options.foreign) {
        throw new WorkflowForeignExecutionError(
          `workflow ${command.workflowId} belongs to another task queue`
        );
      }
      starts.push(command);
      return {
        created: true,
        replayed: false,
        revision: 1,
        status: "running",
        workflowId: command.workflowId,
        workflowType: command.workflowType,
      };
    },
  };
  return { port, presenceChecks, signals, starts };
};

const ledgerWith = (
  completed: boolean,
  records: {
    input: typeof fixture.input;
    trustedScope: TrustedSupervisorMessageV2Scope;
    workflowId: string;
  }[] = [
    {
      input: structuredClone(fixture.input),
      trustedScope: SCOPE,
      workflowId: WORKFLOW_ID,
    },
  ]
) => {
  const completionChecks: string[] = [];
  const terminal = new Map<string, SupervisorMessageV2TerminalOutcome>();
  const ledger: SupervisorMessageV2DeliveryLedger = {
    assertStartIntent: () => Promise.resolve(),
    claim: unused("claim"),
    complete: unused("complete"),
    completeClaim: unused("completeClaim"),
    hasCompletedDelivery: (
      workflowId: string,
      _scope: TrustedSupervisorMessageV2Scope
    ) => {
      completionChecks.push(workflowId);
      return Promise.resolve(completed);
    },
    prepare: unused("prepare"),
    recordStartIntent: (_workflowId, _scope, input) => Promise.resolve(input),
    recoverableStarts: () => Promise.resolve(records),
    startIntent: (workflowId) => {
      const record = records.find((entry) => entry.workflowId === workflowId);
      return record
        ? Promise.resolve(record.input)
        : Promise.reject(new Error("start intent is absent"));
    },
    recordTerminalOutcome: (workflowId, _scope, outcome) => {
      if (!terminal.has(workflowId)) {
        terminal.set(workflowId, outcome);
      }
      return Promise.resolve();
    },
    terminalOutcome: (workflowId) => Promise.resolve(terminal.get(workflowId)),
    deployment: DEPLOYMENT,
    workflowIdFor: (scope, dedupeKey) =>
      Promise.resolve(
        deriveSupervisorMessageV2WorkflowId(scope, dedupeKey, DEPLOYMENT)
      ),
  };
  return { completionChecks, ledger, terminal };
};

const coordinator = (
  port: WorkflowPort,
  ledger: SupervisorMessageV2DeliveryLedger
) =>
  new SupervisorMessageV2Coordinator(
    port,
    {
      deliver: (_envelope: SupervisorMessageV2DeliveryEnvelope) => {
        throw new Error("recovery must not reach the delivery boundary");
      },
    },
    ledger,
    "v2-dispatcher:recovery-test",
    () => new Date("2026-10-05T00:00:00.000Z")
  );

describe("SupervisorMessage V2 recovery against workflow retention", () => {
  test("does not restart a workflow purged after its delivery completed", async () => {
    const workflows = workflowsWith("missing");
    const { completionChecks, ledger } = ledgerWith(true);

    await expect(
      coordinator(workflows.port, ledger).recoverPending()
    ).resolves.toBe(0);

    expect(workflows.starts).toEqual([]);
    expect(workflows.signals).toEqual([]);
    expect(completionChecks).toEqual([WORKFLOW_ID]);
  });

  test("still starts a missing workflow whose start intent never reached Temporal", async () => {
    const workflows = workflowsWith("missing");
    const { ledger } = ledgerWith(false);

    await coordinator(workflows.port, ledger).recoverPending();

    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      WORKFLOW_ID,
    ]);
    expect(workflows.starts[0]?.requestId).toBe(
      `recovery-start:${WORKFLOW_ID}`
    );
  });

  test("keeps post-effect recovery for a running workflow with a completed delivery", async () => {
    const workflows = workflowsWith("running");
    const { completionChecks, ledger, terminal } = ledgerWith(true);

    await coordinator(workflows.port, ledger).recoverPending();

    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      WORKFLOW_ID,
    ]);
    expect(completionChecks).toEqual([]);
    // An open message on a running execution is not an outcome.
    expect([...terminal]).toEqual([]);
  });

  test("records a message phase that ended while its execution still runs", async () => {
    // The generic Temporal workflow stays RUNNING after the message ends, so
    // a cancel issued outside the coordinator is visible only here.
    const workflows = workflowsWith("running", {
      status: () => ({
        deliveredAt: "2026-10-05T00:00:00.000Z",
        deliveryAttempts: 1,
        nextRetryAt: null,
        phase: "canceled",
      }),
    });
    const { ledger, terminal } = ledgerWith(false);

    await expect(
      coordinator(workflows.port, ledger).recoverPending()
    ).resolves.toBe(0);

    expect([...terminal]).toEqual([[WORKFLOW_ID, "canceled"]]);
    expect(workflows.signals).toEqual([]);
  });

  test("defers an ID another deployment holds at the presence check, recording nothing", async () => {
    const workflows = workflowsWith("closed", {
      presenceOf: (workflowId) => {
        if (workflowId === WORKFLOW_ID) {
          throw new WorkflowForeignExecutionError(
            `workflow ${workflowId} belongs to another task queue`
          );
        }
        return "closed";
      },
      status: () => ({
        deliveredAt: null,
        deliveryAttempts: 0,
        nextRetryAt: null,
        phase: "canceled",
      }),
    });
    const { ledger, terminal } = ledgerWith(false, [
      {
        input: structuredClone(fixture.input),
        trustedScope: SCOPE,
        workflowId: WORKFLOW_ID,
      },
      {
        input: structuredClone(OTHER_INPUT),
        trustedScope: SCOPE,
        workflowId: OTHER_WORKFLOW_ID,
      },
    ]);

    await expect(
      coordinator(workflows.port, ledger).recoverPending()
    ).rejects.toMatchObject({ code: "conflict", name: "WorkflowError" });
    expect([...terminal]).toEqual([[OTHER_WORKFLOW_ID, "canceled"]]);
    expect(workflows.starts).toEqual([]);
  });

  test("records no outcome when the ID changes owner between the presence check and the status read", async () => {
    const workflows = workflowsWith("closed", {
      presenceOf: (workflowId, call) => {
        if (call > 1) {
          throw new WorkflowForeignExecutionError(
            `workflow ${workflowId} belongs to another task queue`
          );
        }
        return "closed";
      },
      status: () => ({
        deliveredAt: null,
        deliveryAttempts: 0,
        nextRetryAt: null,
        phase: "canceled",
      }),
    });
    const { ledger, terminal } = ledgerWith(false);

    await expect(
      coordinator(workflows.port, ledger).recoverPending()
    ).rejects.toMatchObject({ code: "conflict", name: "WorkflowError" });
    expect([...terminal]).toEqual([]);
    expect(workflows.starts).toEqual([]);
  });

  test("records a closed workflow's outcome instead of starting it", async () => {
    const workflows = workflowsWith("closed", {
      status: () => ({
        deliveredAt: null,
        deliveryAttempts: 3,
        nextRetryAt: null,
        phase: "dead-lettered",
      }),
    });
    const { completionChecks, ledger, terminal } = ledgerWith(false);

    await coordinator(workflows.port, ledger).recoverPending();

    expect(workflows.starts).toEqual([]);
    expect(completionChecks).toEqual([]);
    expect([...terminal]).toEqual([[WORKFLOW_ID, "exhausted"]]);
  });

  test("maps each closed phase to its terminal outcome", async () => {
    const cases = [
      [
        { deliveredAt: null, deliveryAttempts: 1, phase: "dead-lettered" },
        "dead-lettered",
      ],
      [
        {
          deliveredAt: "2026-10-05T00:00:00.000Z",
          deliveryAttempts: 3,
          phase: "dead-lettered",
        },
        "dead-lettered",
      ],
      [
        { deliveredAt: null, deliveryAttempts: 0, phase: "canceled" },
        "canceled",
      ],
      [
        {
          deliveredAt: "2026-10-05T00:00:00.000Z",
          deliveryAttempts: 1,
          phase: "acknowledged",
        },
        "acknowledged",
      ],
      [
        { deliveredAt: null, deliveryAttempts: 0, phase: "routed" },
        "terminated",
      ],
    ] as const;
    for (const [status, outcome] of cases) {
      const workflows = workflowsWith("closed", {
        status: () => ({ ...status, nextRetryAt: null }),
      });
      const { ledger, terminal } = ledgerWith(false);

      await coordinator(workflows.port, ledger).recoverPending();

      expect([...terminal]).toEqual([[WORKFLOW_ID, outcome]]);
    }
  });

  test("never starts a workflow whose terminal outcome is recorded", async () => {
    const workflows = workflowsWith("missing");
    const { completionChecks, ledger } = ledgerWith(false);
    await ledger.recordTerminalOutcome(WORKFLOW_ID, SCOPE, "canceled");

    await coordinator(workflows.port, ledger).recoverPending();

    expect(workflows.starts).toEqual([]);
    expect(workflows.presenceChecks).toEqual([]);
    expect(completionChecks).toEqual([]);
  });

  test("defers a failed outcome lookup, recovers later intents and still fails the sweep", async () => {
    const workflows = workflowsWith("closed", {
      status: (workflowId) => {
        if (workflowId === WORKFLOW_ID) {
          throw new Error("query of a closed execution failed");
        }
        return {
          deliveredAt: null,
          deliveryAttempts: 0,
          nextRetryAt: null,
          phase: "canceled",
        };
      },
    });
    const { ledger, terminal } = ledgerWith(false, [
      {
        input: structuredClone(fixture.input),
        trustedScope: SCOPE,
        workflowId: WORKFLOW_ID,
      },
      {
        input: structuredClone(OTHER_INPUT),
        trustedScope: SCOPE,
        workflowId: OTHER_WORKFLOW_ID,
      },
    ]);

    await expect(
      coordinator(workflows.port, ledger).recoverPending()
    ).rejects.toThrow("query of a closed execution failed");
    expect([...terminal]).toEqual([[OTHER_WORKFLOW_ID, "canceled"]]);
    expect(workflows.starts).toEqual([]);
  });

  test("keeps the start-and-converge behavior for a port without presence", async () => {
    const workflows = workflowsWith("missing", { withoutPresence: true });
    const { completionChecks, ledger } = ledgerWith(true);

    await coordinator(workflows.port, ledger).recoverPending();

    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      WORKFLOW_ID,
    ]);
    expect(completionChecks).toEqual([]);
  });

  test("recovers later intents past a foreign execution and still fails the sweep", async () => {
    const workflows = workflowsWith("missing", { foreign: WORKFLOW_ID });
    const { ledger } = ledgerWith(false, [
      {
        input: structuredClone(fixture.input),
        trustedScope: SCOPE,
        workflowId: WORKFLOW_ID,
      },
      {
        input: structuredClone(OTHER_INPUT),
        trustedScope: SCOPE,
        workflowId: OTHER_WORKFLOW_ID,
      },
    ]);

    await expect(
      coordinator(workflows.port, ledger).recoverPending()
    ).rejects.toMatchObject({ code: "conflict", name: "WorkflowError" });
    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      OTHER_WORKFLOW_ID,
    ]);
  });
});

describe("SupervisorMessage V2 receive against workflow retention", () => {
  test("refuses a sender retry for a workflow purged after its delivery completed", async () => {
    const workflows = workflowsWith("missing");
    const { completionChecks, ledger } = ledgerWith(true);

    await expect(
      coordinator(workflows.port, ledger).receive(
        SCOPE,
        structuredClone(fixture.input),
        "receive-after-retention"
      )
    ).rejects.toMatchObject({ code: "conflict", name: "WorkflowError" });
    expect(workflows.starts).toEqual([]);
    expect(workflows.signals).toEqual([]);
    expect(completionChecks).toEqual([WORKFLOW_ID]);
  });

  test("refuses a sender retry for a purged workflow closed without a delivery", async () => {
    const workflows = workflowsWith("missing");
    const { completionChecks, ledger } = ledgerWith(false);
    await ledger.recordTerminalOutcome(WORKFLOW_ID, SCOPE, "exhausted");

    await expect(
      coordinator(workflows.port, ledger).receive(
        SCOPE,
        structuredClone(fixture.input),
        "receive-after-exhaustion"
      )
    ).rejects.toMatchObject({ code: "conflict", name: "WorkflowError" });
    expect(workflows.starts).toEqual([]);
    expect(completionChecks).toEqual([]);
  });

  test("still starts a first receive whose workflow Temporal has not seen", async () => {
    const workflows = workflowsWith("missing");
    const { ledger } = ledgerWith(false);

    await coordinator(workflows.port, ledger).receive(
      SCOPE,
      structuredClone(fixture.input),
      "receive-first"
    );

    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      WORKFLOW_ID,
    ]);
  });
});

describe("SupervisorMessage V2 recovery failure classification", () => {
  const twoRecords = () =>
    ledgerWith(false, [
      {
        input: structuredClone(fixture.input),
        trustedScope: SCOPE,
        workflowId: WORKFLOW_ID,
      },
      {
        input: structuredClone(OTHER_INPUT),
        trustedScope: SCOPE,
        workflowId: OTHER_WORKFLOW_ID,
      },
    ]);
  const reportedBy = async (port: WorkflowPort) => {
    const { ledger } = twoRecords();
    const reports: { kind: string; message: string; workflowId: string }[] = [];
    await coordinator(port, ledger).recoverPending((failure) => {
      reports.push({
        kind: failure.kind,
        message: (failure.error as Error).message,
        workflowId: failure.workflowId,
      });
    });
    return reports;
  };
  const heldBy = (workflowId: string) =>
    new WorkflowForeignExecutionError(
      `workflow ${workflowId} belongs to another task queue`
    );

  test("reports an ID another deployment holds at start as a foreign execution", async () => {
    const workflows = workflowsWith("missing", { foreign: WORKFLOW_ID });
    expect(await reportedBy(workflows.port)).toEqual([
      {
        kind: "foreign-execution",
        message: `workflow ${WORKFLOW_ID} belongs to another task queue`,
        workflowId: WORKFLOW_ID,
      },
    ]);
    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      OTHER_WORKFLOW_ID,
    ]);
  });

  test("reports an ID another deployment holds at the presence check as a foreign execution", async () => {
    const workflows = workflowsWith("missing", {
      presenceOf: (workflowId) => {
        if (workflowId === WORKFLOW_ID) {
          throw heldBy(workflowId);
        }
        return "missing";
      },
    });
    expect(await reportedBy(workflows.port)).toEqual([
      {
        kind: "foreign-execution",
        message: `workflow ${WORKFLOW_ID} belongs to another task queue`,
        workflowId: WORKFLOW_ID,
      },
    ]);
  });

  test("reports an owner change between the presence check and the status read as a foreign execution", async () => {
    const workflows = workflowsWith("closed", {
      presenceOf: (workflowId, call) => {
        if (workflowId === WORKFLOW_ID && call > 1) {
          throw heldBy(workflowId);
        }
        return "closed";
      },
      status: () => ({
        deliveredAt: null,
        deliveryAttempts: 0,
        nextRetryAt: null,
        phase: "canceled",
      }),
    });
    expect(await reportedBy(workflows.port)).toEqual([
      {
        kind: "foreign-execution",
        message: `workflow ${WORKFLOW_ID} belongs to another task queue`,
        workflowId: WORKFLOW_ID,
      },
    ]);
  });

  test("reports a non-conflict start failure as failed, never as a foreign execution", async () => {
    const workflows = workflowsWith("missing", {
      startError: (workflowId) =>
        workflowId === WORKFLOW_ID
          ? new Error("Temporal frontend unavailable")
          : undefined,
    });
    expect(await reportedBy(workflows.port)).toEqual([
      {
        kind: "failed",
        message: "Temporal frontend unavailable",
        workflowId: WORKFLOW_ID,
      },
    ]);
    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      OTHER_WORKFLOW_ID,
    ]);
  });

  test("reports a non-conflict presence failure as failed, never as a foreign execution", async () => {
    const workflows = workflowsWith("missing", {
      presenceOf: (workflowId) => {
        if (workflowId === WORKFLOW_ID) {
          throw new WorkflowError("invalid-state", "describe failed");
        }
        return "missing";
      },
    });
    expect(await reportedBy(workflows.port)).toEqual([
      { kind: "failed", message: "describe failed", workflowId: WORKFLOW_ID },
    ]);
  });

  test("reports a non-conflict presence failure after the status read as failed", async () => {
    const workflows = workflowsWith("closed", {
      presenceOf: (workflowId, call) => {
        if (workflowId === WORKFLOW_ID && call > 1) {
          throw new WorkflowError("invalid-state", "describe failed");
        }
        return "closed";
      },
      status: () => ({
        deliveredAt: null,
        deliveryAttempts: 0,
        nextRetryAt: null,
        phase: "canceled",
      }),
    });
    expect(await reportedBy(workflows.port)).toEqual([
      { kind: "failed", message: "describe failed", workflowId: WORKFLOW_ID },
    ]);
  });

  test("reports a failed outcome lookup on a closed execution as failed", async () => {
    const workflows = workflowsWith("closed", {
      status: (workflowId) => {
        if (workflowId === WORKFLOW_ID) {
          throw new Error("query of a closed execution failed");
        }
        return {
          deliveredAt: null,
          deliveryAttempts: 0,
          nextRetryAt: null,
          phase: "canceled",
        };
      },
    });
    expect(await reportedBy(workflows.port)).toEqual([
      {
        kind: "failed",
        message: "query of a closed execution failed",
        workflowId: WORKFLOW_ID,
      },
    ]);
  });

  test("a conflict raised past the ownership checks is failed, not foreign", async () => {
    // Only start and presence address the ID's owner. A conflict from a
    // later step (here the status read) says nothing about ownership.
    const workflows = workflowsWith("running", {
      status: (workflowId) => {
        if (workflowId === WORKFLOW_ID) {
          throw new WorkflowError("conflict", "status read conflicted");
        }
        return {
          deliveredAt: null,
          deliveryAttempts: 0,
          nextRetryAt: null,
          phase: "routed",
        };
      },
    });
    expect(await reportedBy(workflows.port)).toEqual([
      {
        kind: "failed",
        message: "status read conflicted",
        workflowId: WORKFLOW_ID,
      },
    ]);
  });

  test("another workflow type under the ID on this deployment's own queue is failed, not foreign", async () => {
    // The port adopted the ID on its own task queue and found another
    // workflow type there: no other deployment holds it, so skipping it
    // would silently leave this deployment's own message unrecovered.
    const workflows = workflowsWith("running", {
      startError: (workflowId) =>
        workflowId === WORKFLOW_ID
          ? new WorkflowError(
              "conflict",
              `workflow ${workflowId} already exists as task-graph.v1`
            )
          : undefined,
    });
    expect(await reportedBy(workflows.port)).toEqual([
      {
        kind: "failed",
        message: `workflow ${WORKFLOW_ID} already exists as task-graph.v1`,
        workflowId: WORKFLOW_ID,
      },
    ]);
  });

  test("a conflict at the presence check that names no other task queue is failed, not foreign", async () => {
    const workflows = workflowsWith("missing", {
      presenceOf: (workflowId) => {
        if (workflowId === WORKFLOW_ID) {
          throw new WorkflowError("conflict", "presence conflicted");
        }
        return "missing";
      },
    });
    expect(await reportedBy(workflows.port)).toEqual([
      {
        kind: "failed",
        message: "presence conflicted",
        workflowId: WORKFLOW_ID,
      },
    ]);
  });
});

describe("SupervisorMessage V2 recovery quarantine", () => {
  const QUARANTINE: SupervisorMessageV2RecoveryQuarantine = {
    at: "2026-10-05T01:02:03.000Z",
    by: "operator-a",
    reason: "start snapshot unreadable; investigating",
  };
  const quarantinedRecords = () => {
    const made = ledgerWith(false);
    // A quarantined row carries no parsed input: recovery never reads it.
    made.ledger.recoverableStarts = () =>
      Promise.resolve([
        {
          quarantine: QUARANTINE,
          recipient: fixture.input.to,
          workflowId: WORKFLOW_ID,
        },
        {
          input: structuredClone(OTHER_INPUT),
          trustedScope: SCOPE,
          workflowId: OTHER_WORKFLOW_ID,
        },
      ]);
    return made;
  };

  test("leaves a quarantined record untouched, reports who, when and why, and recovers the others", async () => {
    const workflows = workflowsWith("missing", {
      startError: (workflowId) =>
        workflowId === WORKFLOW_ID
          ? new Error("this record would refuse startup")
          : undefined,
    });
    const { completionChecks, ledger } = quarantinedRecords();
    const reports: unknown[] = [];
    const asked: string[] = [];
    const recovered = await coordinator(workflows.port, ledger).recoverPending(
      (failure) => {
        reports.push({
          kind: failure.kind,
          quarantine: failure.quarantine,
          recipient: failure.recipient,
          workflowId: failure.workflowId,
        });
      },
      (workflowId) => {
        asked.push(workflowId);
        return true;
      }
    );
    expect(reports).toEqual([
      {
        kind: "quarantined",
        quarantine: QUARANTINE,
        recipient: fixture.input.to,
        workflowId: WORKFLOW_ID,
      },
    ]);
    // Started, with no delivery pending: nothing counted as delivered.
    expect(recovered).toBe(0);
    // Neither the engine nor the ledger is asked anything about it.
    expect(workflows.presenceChecks).toEqual([OTHER_WORKFLOW_ID]);
    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      OTHER_WORKFLOW_ID,
    ]);
    expect(completionChecks).toEqual([OTHER_WORKFLOW_ID]);
    expect(asked).toEqual([OTHER_WORKFLOW_ID]);
  });

  test("without a reporter, a quarantined record is skipped, not thrown", async () => {
    const workflows = workflowsWith("missing", {
      startError: (workflowId) =>
        workflowId === WORKFLOW_ID ? new Error("would fail") : undefined,
    });
    const { ledger } = quarantinedRecords();
    expect(await coordinator(workflows.port, ledger).recoverPending()).toBe(0);
    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      OTHER_WORKFLOW_ID,
    ]);
  });
});

describe("SupervisorMessage V2 recovery runner", () => {
  const T0 = Date.parse("2026-10-05T00:00:00.000Z");

  /** The quarantine command a refusal names when the host gave no config path. */
  const hint = (workflowId: string) =>
    ` [to start without it: loop orchestration v2-quarantine <config-path> ${workflowId} --reason '<why>']`;

  const runnerOver = (
    recoveryPort: SupervisorMessageV2RecoveryPort,
    options: { maxBackoffMs?: number; operatorConfigPath?: string } = {}
  ) => {
    let clock = T0;
    const lines: string[] = [];
    const intervals: (() => void)[] = [];
    const runner = new SupervisorMessageV2RecoveryRunner({
      coordinator: recoveryPort,
      intervalMs: 1000,
      log: (line) => lines.push(line),
      ...options,
      now: () => clock,
      timer: {
        clearInterval: () => undefined,
        setInterval: (callback) => {
          intervals.push(callback);
          return intervals.length;
        },
      },
    });
    return {
      advance: (ms: number) => {
        clock += ms;
      },
      intervals,
      lines,
      runner,
    };
  };

  const twoRecordsWith = (
    startError: (workflowId: string) => Error | undefined
  ) => {
    const workflows = workflowsWith("running", { startError });
    const { ledger } = ledgerWith(false, [
      {
        input: structuredClone(fixture.input),
        trustedScope: SCOPE,
        workflowId: WORKFLOW_ID,
      },
      {
        input: structuredClone(OTHER_INPUT),
        trustedScope: SCOPE,
        workflowId: OTHER_WORKFLOW_ID,
      },
    ]);
    return { recovery: coordinator(workflows.port, ledger), workflows };
  };

  const refusalOf = (runner: SupervisorMessageV2RecoveryRunner) =>
    runner.start().then(
      () => undefined,
      (error: unknown) => error
    );

  test("starts past an ID another deployment holds, logs which ID and recipient, and keeps sweeping", async () => {
    const { recovery, workflows } = twoRecordsWith((workflowId) =>
      workflowId === WORKFLOW_ID
        ? new WorkflowForeignExecutionError(
            `workflow ${workflowId} belongs to another task queue`
          )
        : undefined
    );
    const { intervals, lines, runner } = runnerOver(recovery);
    try {
      expect(await refusalOf(runner)).toBeUndefined();
      expect(lines).toEqual([
        `V2 recovery skipped workflow ${WORKFLOW_ID} for ${fixture.input.to}: WorkflowError (conflict): workflow ${WORKFLOW_ID} belongs to another task queue`,
      ]);
      expect(intervals).toHaveLength(1);
      expect(workflows.starts.map((start) => start.workflowId)).toEqual([
        OTHER_WORKFLOW_ID,
      ]);
    } finally {
      await runner.close();
    }
  });

  test("refuses startup when any recorded start fails for another reason, after trying every record", async () => {
    const { recovery, workflows } = twoRecordsWith((workflowId) =>
      workflowId === WORKFLOW_ID
        ? new Error("Temporal frontend unavailable")
        : undefined
    );
    const { intervals, lines, runner } = runnerOver(recovery);
    try {
      const refused = await refusalOf(runner);
      expect(refused).toBeInstanceOf(SupervisorMessageV2RecoveryStartupError);
      expect((refused as Error).name).toBe(
        "SupervisorMessageV2RecoveryStartupError"
      );
      expect((refused as Error).message).toBe(
        `V2 initial recovery failed for 1 recorded start: workflow ${WORKFLOW_ID} for ${fixture.input.to}: Error: Temporal frontend unavailable${hint(WORKFLOW_ID)}`
      );
      expect(
        (refused as SupervisorMessageV2RecoveryStartupError).failures.map(
          (failure) => [failure.workflowId, failure.kind]
        )
      ).toEqual([[WORKFLOW_ID, "failed"]]);
      expect(intervals).toEqual([]);
      // Logged as well: a host that wraps the error still shows the operator
      // which record refused startup and how to quarantine it.
      expect(lines).toEqual([(refused as Error).message]);
      // The healthy record was still recovered before startup was refused.
      expect(workflows.starts.map((start) => start.workflowId)).toEqual([
        OTHER_WORKFLOW_ID,
      ]);
    } finally {
      await runner.close();
    }
  });

  test("refuses startup on a non-conflict failure even when another record is foreign-held", async () => {
    const { recovery } = twoRecordsWith((workflowId) =>
      workflowId === WORKFLOW_ID
        ? new WorkflowForeignExecutionError(
            `workflow ${workflowId} belongs to another task queue`
          )
        : new WorkflowError("invalid-state", "start snapshot unreadable")
    );
    const { intervals, lines, runner } = runnerOver(recovery);
    try {
      const refused = await refusalOf(runner);
      expect((refused as Error).message).toBe(
        `V2 initial recovery failed for 1 recorded start: workflow ${OTHER_WORKFLOW_ID} for ${OTHER_INPUT.to}: WorkflowError (invalid-state): start snapshot unreadable${hint(OTHER_WORKFLOW_ID)}`
      );
      expect(lines).toEqual([
        `V2 recovery skipped workflow ${WORKFLOW_ID} for ${fixture.input.to}: WorkflowError (conflict): workflow ${WORKFLOW_ID} belongs to another task queue`,
        (refused as Error).message,
      ]);
      expect(intervals).toEqual([]);
    } finally {
      await runner.close();
    }
  });

  test("names every failing record when it refuses startup", async () => {
    const { recovery } = twoRecordsWith(
      (workflowId) => new Error(`start of ${workflowId} failed`)
    );
    const { runner } = runnerOver(recovery);
    try {
      expect(((await refusalOf(runner)) as Error).message).toBe(
        `V2 initial recovery failed for 2 recorded starts: workflow ${WORKFLOW_ID} for ${fixture.input.to}: Error: start of ${WORKFLOW_ID} failed${hint(WORKFLOW_ID)}; workflow ${OTHER_WORKFLOW_ID} for ${OTHER_INPUT.to}: Error: start of ${OTHER_WORKFLOW_ID} failed${hint(OTHER_WORKFLOW_ID)}`
      );
    } finally {
      await runner.close();
    }
  });

  test("names the exact quarantine command for the host's config path, quoted for a shell", async () => {
    const { recovery } = twoRecordsWith((workflowId) =>
      workflowId === WORKFLOW_ID ? new Error("start failed") : undefined
    );
    const { lines, runner } = runnerOver(recovery, {
      operatorConfigPath: "/srv/loop/it's orchestration.json",
    });
    try {
      const refused = (await refusalOf(runner)) as Error;
      expect(refused.message).toBe(
        `V2 initial recovery failed for 1 recorded start: workflow ${WORKFLOW_ID} for ${fixture.input.to}: Error: start failed [to start without it: loop orchestration v2-quarantine '/srv/loop/it'\\''s orchestration.json' ${WORKFLOW_ID} --reason '<why>']`
      );
      expect(lines).toEqual([refused.message]);
    } finally {
      await runner.close();
    }
  });

  test("a ledger row that fails the whole initial sweep refuses startup naming its workflow and quarantine command", async () => {
    const rowError = new SupervisorMessageV2RecoveryRecordError(
      WORKFLOW_ID,
      `V2 recovery ledger row ${WORKFLOW_ID} has an invalid workflow binding`
    );
    const { intervals, lines, runner } = runnerOver({
      recoverPending: () => Promise.reject(rowError),
    });
    try {
      const refused = await refusalOf(runner);
      expect(refused).toBeInstanceOf(SupervisorMessageV2RecoveryStartupError);
      expect((refused as Error).message).toBe(
        `V2 initial recovery failed for 1 recorded start: workflow ${WORKFLOW_ID} for an unreadable recipient: SupervisorMessageV2RecoveryRecordError: V2 recovery ledger row ${WORKFLOW_ID} has an invalid workflow binding${hint(WORKFLOW_ID)}`
      );
      expect(
        (refused as SupervisorMessageV2RecoveryStartupError).failures
      ).toEqual([
        {
          error: rowError,
          kind: "failed",
          recipient: "an unreadable recipient",
          workflowId: WORKFLOW_ID,
        },
      ]);
      expect(lines).toEqual([(refused as Error).message]);
      expect(intervals).toEqual([]);
    } finally {
      await runner.close();
    }
  });

  const QUARANTINE: SupervisorMessageV2RecoveryQuarantine = {
    at: "2026-10-05T01:02:03.000Z",
    by: "operator-a",
    reason: "start snapshot unreadable; investigating",
  };
  const quarantinedLine = (config = "<config-path>") =>
    `V2 recovery QUARANTINED workflow ${WORKFLOW_ID} for ${fixture.input.to}: skipped until released (quarantined by ${QUARANTINE.by} at ${QUARANTINE.at}: ${QUARANTINE.reason}); release it with: loop orchestration v2-quarantine-release ${config} ${WORKFLOW_ID} --reason '<why>'`;

  /** Two records; the first fails to start unless the operator quarantined it. */
  const quarantinable = () => {
    let quarantine: SupervisorMessageV2RecoveryQuarantine | undefined;
    let failing = true;
    let attempts = 0;
    const workflows = workflowsWith("running", {
      startError: (workflowId) => {
        if (workflowId !== WORKFLOW_ID) {
          return undefined;
        }
        attempts += 1;
        return failing ? new Error("Temporal frontend unavailable") : undefined;
      },
    });
    const records = () => [
      quarantine
        ? { quarantine, recipient: fixture.input.to, workflowId: WORKFLOW_ID }
        : {
            input: structuredClone(fixture.input),
            trustedScope: SCOPE,
            workflowId: WORKFLOW_ID,
          },
      {
        input: structuredClone(OTHER_INPUT),
        trustedScope: SCOPE,
        workflowId: OTHER_WORKFLOW_ID,
      },
    ];
    const { ledger } = ledgerWith(false, []);
    ledger.recoverableStarts = () => Promise.resolve(records());
    return {
      /** Start attempts of the first record, failed or not. */
      attempts: () => attempts,
      fail: () => {
        failing = true;
      },
      heal: () => {
        failing = false;
      },
      quarantine: (
        value: SupervisorMessageV2RecoveryQuarantine | undefined
      ) => {
        quarantine = value;
      },
      recovery: coordinator(workflows.port, ledger),
      workflows,
    };
  };

  test("starts past a quarantined record and logs it loudly on every start", async () => {
    const q = quarantinable();
    q.quarantine(QUARANTINE);
    for (const restart of [1, 2]) {
      const { intervals, lines, runner } = runnerOver(q.recovery, {
        operatorConfigPath: "/srv/loop/orchestration.json",
      });
      try {
        expect(await refusalOf(runner)).toBeUndefined();
        expect(intervals).toHaveLength(1);
        expect(lines).toEqual([
          quarantinedLine("/srv/loop/orchestration.json"),
        ]);
        // A periodic sweep does not repeat an unchanged quarantine.
        await runner.sweep();
        expect(lines).toHaveLength(1);
      } finally {
        await runner.close();
      }
      expect(restart).toBeOneOf([1, 2]);
    }
    expect(q.workflows.starts.map((start) => start.workflowId)).toEqual([
      OTHER_WORKFLOW_ID,
      OTHER_WORKFLOW_ID,
      OTHER_WORKFLOW_ID,
      OTHER_WORKFLOW_ID,
    ]);
  });

  test("a periodic sweep logs a new quarantine once, stops retrying the record, and logs its release", async () => {
    const q = quarantinable();
    q.heal();
    const { advance, lines, runner } = runnerOver(q.recovery);
    try {
      await runner.start();
      expect(lines).toEqual([]);
      // The record starts failing: retried with backoff.
      q.fail();
      await runner.sweep();
      expect(lines).toEqual([
        `V2 recovery of workflow ${WORKFLOW_ID} for ${fixture.input.to} failed (attempt 1); retrying in 1000 ms: Error: Temporal frontend unavailable`,
      ]);
      // The operator quarantines it: one line, no more attempts.
      q.quarantine(QUARANTINE);
      advance(60_000);
      const attemptsBefore = q.attempts();
      await runner.sweep();
      await runner.sweep();
      expect(lines.slice(1)).toEqual([quarantinedLine()]);
      expect(q.attempts()).toBe(attemptsBefore);
      // Released: logged once, and recovered from a fresh attempt count.
      q.quarantine(undefined);
      await runner.sweep();
      expect(lines.slice(2)).toEqual([
        `V2 recovery quarantine of workflow ${WORKFLOW_ID} for ${fixture.input.to} was released; recovering it again`,
        `V2 recovery of workflow ${WORKFLOW_ID} for ${fixture.input.to} failed (attempt 1); retrying in 1000 ms: Error: Temporal frontend unavailable`,
      ]);
      // The release is said once; the record is in backoff, not yet due.
      await runner.sweep();
      expect(lines).toHaveLength(4);
    } finally {
      await runner.close();
    }
  });

  test("refuses startup whenever the whole initial sweep fails, whatever the error", async () => {
    const failures = [
      new WorkflowError("conflict", "a held ID rejected the whole sweep"),
      Object.assign(new Error("Temporal query failed"), {
        name: "QueryFailedError",
      }),
      Object.assign(new Error("Temporal unavailable"), {
        name: "ServiceError",
      }),
      new Error("ledger offline"),
    ];
    for (const failure of failures) {
      const { intervals, lines, runner } = runnerOver({
        recoverPending: () => Promise.reject(failure),
      });
      try {
        expect(await refusalOf(runner)).toBe(failure);
        expect(intervals).toEqual([]);
        expect(lines).toEqual([]);
      } finally {
        await runner.close();
      }
    }
  });

  test("a periodic sweep retries a failing record with bounded backoff and logs every failure transition", async () => {
    let failing = false;
    const { recovery, workflows } = twoRecordsWith((workflowId) =>
      failing && workflowId === WORKFLOW_ID
        ? new Error("Temporal frontend unavailable")
        : undefined
    );
    const { advance, lines, runner } = runnerOver(recovery, {
      maxBackoffMs: 4000,
    });
    const startsOf = (workflowId: string) =>
      workflows.starts.filter((start) => start.workflowId === workflowId)
        .length;
    const failed = (attempt: number, delayMs: number) =>
      `V2 recovery of workflow ${WORKFLOW_ID} for ${fixture.input.to} failed (attempt ${attempt}); retrying in ${delayMs} ms: Error: Temporal frontend unavailable`;
    try {
      await runner.start();
      expect(lines).toEqual([]);
      failing = true;

      // Attempt n waits min(interval * 2^(n-1), maxBackoffMs) before n+1.
      const expected: string[] = [];
      for (const [attempt, delayMs] of [
        [1, 1000],
        [2, 2000],
        [3, 4000],
        [4, 4000],
      ] as const) {
        expect(await runner.sweep()).toBe(0);
        expected.push(failed(attempt, delayMs));
        expect(lines).toEqual(expected);

        // Not yet due: the record is left alone and nothing is logged,
        // while the healthy record is still swept.
        advance(delayMs - 1);
        const others = startsOf(OTHER_WORKFLOW_ID);
        await runner.sweep();
        expect(startsOf(OTHER_WORKFLOW_ID)).toBe(others + 1);
        expect(lines).toEqual(expected);
        advance(1);
      }

      failing = false;
      await runner.sweep();
      expected.push(
        `V2 recovery of workflow ${WORKFLOW_ID} for ${fixture.input.to} resumed after 4 failed attempts`
      );
      expect(lines).toEqual(expected);
      // Healthy again: every sweep attempts it, with no further lines.
      const before = startsOf(WORKFLOW_ID);
      await runner.sweep();
      await runner.sweep();
      expect(startsOf(WORKFLOW_ID)).toBe(before + 2);
      expect(lines).toEqual(expected);

      // A new failure starts again from the first backoff step.
      failing = true;
      await runner.sweep();
      expect(lines.at(-1)).toBe(failed(1, 1000));
    } finally {
      await runner.close();
    }
  });

  test("a record in backoff is not attempted before it is due", async () => {
    let attempts = 0;
    const { recovery } = twoRecordsWith((workflowId) => {
      if (workflowId !== WORKFLOW_ID) {
        return undefined;
      }
      attempts += 1;
      return attempts > 1
        ? new Error("Temporal frontend unavailable")
        : undefined;
    });
    const { advance, runner } = runnerOver(recovery);
    try {
      await runner.start();
      await runner.sweep();
      expect(attempts).toBe(2);
      advance(999);
      await runner.sweep();
      await runner.sweep();
      expect(attempts).toBe(2);
      advance(1);
      await runner.sweep();
      expect(attempts).toBe(3);
    } finally {
      await runner.close();
    }
  });

  test("a failing record that leaves the ledger stops being retried, and says so", async () => {
    const workflows = workflowsWith("running", {
      startError: () => new Error("Temporal frontend unavailable"),
    });
    const records: {
      input: typeof fixture.input;
      trustedScope: TrustedSupervisorMessageV2Scope;
      workflowId: string;
    }[] = [];
    const { ledger } = ledgerWith(false, records);
    const { lines, runner } = runnerOver(coordinator(workflows.port, ledger));
    const record = {
      input: structuredClone(fixture.input),
      trustedScope: SCOPE,
      workflowId: WORKFLOW_ID,
    };
    const firstFailure = `V2 recovery of workflow ${WORKFLOW_ID} for ${fixture.input.to} failed (attempt 1); retrying in 1000 ms: Error: Temporal frontend unavailable`;
    try {
      await runner.start();
      records.push(record);
      await runner.sweep();
      expect(lines).toEqual([firstFailure]);
      records.splice(0);
      await runner.sweep();
      expect(lines).toEqual([
        firstFailure,
        `V2 recovery of workflow ${WORKFLOW_ID} for ${fixture.input.to} stopped: its start intent is no longer recorded after 1 failed attempt`,
      ]);
      // Recorded again, it is a fresh failure, not a later backoff step.
      records.push(record);
      await runner.sweep();
      expect(lines.at(-1)).toBe(firstFailure);
    } finally {
      await runner.close();
    }
  });

  test("a periodic whole-sweep failure is logged on every tick, never thrown", async () => {
    let sweeps = 0;
    const { intervals, lines, runner } = runnerOver({
      recoverPending: () => {
        sweeps += 1;
        return sweeps === 1
          ? Promise.resolve(0)
          : Promise.reject(new Error("ledger offline"));
      },
    });
    try {
      await runner.start();
      intervals[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      intervals[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(lines).toEqual([
        "V2 delivery recovery sweep failed: ledger offline",
        "V2 delivery recovery sweep failed: ledger offline",
      ]);
    } finally {
      await runner.close();
    }
  });

  test("rejects a backoff bound below the interval, above an hour, or fractional", () => {
    for (const maxBackoffMs of [999, 3_600_001, 1500.5]) {
      expect(
        () =>
          new SupervisorMessageV2RecoveryRunner({
            coordinator: { recoverPending: () => Promise.resolve(0) },
            intervalMs: 1000,
            maxBackoffMs,
          })
      ).toThrow("V2 recovery backoff bound is invalid");
    }
    // The bound may equal either end of its range.
    for (const maxBackoffMs of [1000, 3_600_000]) {
      expect(
        () =>
          new SupervisorMessageV2RecoveryRunner({
            coordinator: { recoverPending: () => Promise.resolve(0) },
            intervalMs: 1000,
            maxBackoffMs,
          })
      ).not.toThrow();
    }
  });

  test("defaults the backoff bound to ten minutes, or to the interval when that is longer", async () => {
    // An hour-long interval is accepted without an explicit bound.
    expect(
      () =>
        new SupervisorMessageV2RecoveryRunner({
          coordinator: { recoverPending: () => Promise.resolve(0) },
          intervalMs: 3_600_000,
        })
    ).not.toThrow();

    const { recovery } = twoRecordsWith((workflowId) =>
      workflowId === WORKFLOW_ID
        ? new Error("Temporal frontend unavailable")
        : undefined
    );
    let started = false;
    const { advance, lines, runner } = runnerOver({
      recoverPending: (report, due) =>
        started ? recovery.recoverPending(report, due) : Promise.resolve(0),
    });
    try {
      await runner.start();
      started = true;
      const delays: string[] = [];
      for (let attempt = 1; attempt <= 11; attempt += 1) {
        await runner.sweep();
        const delay = /retrying in (\d+) ms/.exec(lines.at(-1) ?? "")?.[1];
        delays.push(delay ?? "none");
        advance(Number(delay));
      }
      // 1s doubling per attempt: 2^9 s = 512000 ms, then capped at 600000.
      expect(delays.slice(-3)).toEqual(["256000", "512000", "600000"]);
    } finally {
      await runner.close();
    }
  });
});
