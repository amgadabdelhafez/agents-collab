import { expect, spyOn, test } from "bun:test";
import { InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
  SupervisorA2AV2Ingress,
  type SupervisorA2AV2IngressOptions,
} from "../../src/loop/a2a-supervisor-v2-ingress";
import type { SupervisorMessageV2DeliveryLedger } from "../../src/loop/supervisor-message-v2-runtime";
import type { WorkflowPort } from "../../src/loop/workflow-port";

const unused = () => {
  throw new Error("not used by recovery");
};

/** Recovery fails first as a Temporal query, then as an ordinary failure. */
const failingOptions = (): SupervisorA2AV2IngressOptions => {
  let sweeps = 0;
  const ledger = {
    recoverableStarts: () => {
      sweeps += 1;
      const error = new Error(
        sweeps === 1 ? "query not ready" : "ledger offline"
      );
      if (sweeps === 1) {
        error.name = "QueryFailedError";
      }
      return Promise.reject(error);
    },
  } as unknown as SupervisorMessageV2DeliveryLedger;
  return {
    card: {
      description: "ingress recovery logging fixture",
      supervisorId: "supervisor:ingress-test",
      url: "http://127.0.0.1/a2a",
    },
    delivery: { deliver: unused } as never,
    dispatchOwner: "v2-dispatcher:ingress-test",
    ledger,
    now: () => "2026-10-05T12:00:00.000Z",
    policy: {
      claimTimeoutMs: 60_000,
      escalationTimeoutMs: 120_000,
      maxDeliveryAttempts: 3,
      retryDelayMs: 1000,
    },
    recoveryIntervalMs: 1000,
    sessionReadiness: { assertReady: () => Promise.resolve() } as never,
    supervisorId: "supervisor:ingress-test",
    taskStore: new InMemoryTaskStore(),
    workflows: {} as WorkflowPort,
  };
};

const waitFor = async (condition: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("ingress recovery failures reach the supplied logger", async () => {
  const lines: string[] = [];
  const ingress = new SupervisorA2AV2Ingress({
    ...failingOptions(),
    log: (line) => lines.push(line),
  });
  try {
    await ingress.start();
    expect(lines).toEqual([
      "V2 initial recovery awaiting Temporal query retry",
    ]);
    await waitFor(() => lines.length > 1, 2500);
    expect(lines[1]).toBe("V2 delivery recovery sweep failed: ledger offline");
  } finally {
    await ingress.close();
  }
});

test("ingress recovery failures default to the runner's stderr logger", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  const ingress = new SupervisorA2AV2Ingress(failingOptions());
  try {
    await ingress.start();
    expect(errors.mock.calls.map((call) => call[0])).toContain(
      "V2 initial recovery awaiting Temporal query retry"
    );
  } finally {
    await ingress.close();
    errors.mockRestore();
  }
});
