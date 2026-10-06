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
  type SupervisorMessageV2TerminalOutcome,
} from "../../src/loop/supervisor-message-v2-runtime";
import {
  WorkflowError,
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
const WORKFLOW_ID = deriveSupervisorMessageV2WorkflowId(
  SCOPE,
  fixture.input.dedupeKey
);
const OTHER_INPUT = { ...fixture.input, dedupeKey: "v2-recovery-other" };
const OTHER_WORKFLOW_ID = deriveSupervisorMessageV2WorkflowId(
  SCOPE,
  OTHER_INPUT.dedupeKey
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
            return presence;
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
      if (command.workflowId === options.foreign) {
        throw new WorkflowError(
          "conflict",
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
    recordTerminalOutcome: (workflowId, _scope, outcome) => {
      if (!terminal.has(workflowId)) {
        terminal.set(workflowId, outcome);
      }
      return Promise.resolve();
    },
    terminalOutcome: (workflowId) => Promise.resolve(terminal.get(workflowId)),
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
    const { completionChecks, ledger } = ledgerWith(true);

    await coordinator(workflows.port, ledger).recoverPending();

    expect(workflows.starts.map((start) => start.workflowId)).toEqual([
      WORKFLOW_ID,
    ]);
    expect(completionChecks).toEqual([]);
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
        "completed",
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
