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

/**
 * Recovery reads the ledger once per sweep. `failFrom` is the first sweep
 * whose read fails; earlier sweeps find nothing to recover.
 */
const failingOptions = (
  failFrom: number,
  failure: () => Error = () => new Error("ledger offline")
): SupervisorA2AV2IngressOptions => {
  let sweeps = 0;
  const ledger = {
    recoverableStarts: () => {
      sweeps += 1;
      return sweeps < failFrom
        ? Promise.resolve([])
        : Promise.reject(failure());
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

test("ingress refuses to start when its initial recovery sweep fails, whatever the error", async () => {
  for (const name of ["QueryFailedError", "ServiceError", "Error"]) {
    const lines: string[] = [];
    const ingress = new SupervisorA2AV2Ingress({
      ...failingOptions(1, () =>
        Object.assign(new Error("query not ready"), { name })
      ),
      log: (line) => lines.push(line),
    });
    try {
      const refused = await ingress.start().then(
        () => undefined,
        (error: unknown) => error as Error
      );
      expect([refused?.name, refused?.message]).toEqual([
        name,
        "query not ready",
      ]);
      expect(lines).toEqual([]);
    } finally {
      await ingress.close();
    }
  }
});

test("ingress periodic recovery failures reach the supplied logger", async () => {
  const lines: string[] = [];
  const ingress = new SupervisorA2AV2Ingress({
    ...failingOptions(2),
    log: (line) => lines.push(line),
  });
  try {
    await ingress.start();
    expect(lines).toEqual([]);
    await waitFor(() => lines.length > 0, 2500);
    expect(lines[0]).toBe("V2 delivery recovery sweep failed: ledger offline");
  } finally {
    await ingress.close();
  }
});

test("ingress recovery failures default to the runner's stderr logger", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  const ingress = new SupervisorA2AV2Ingress(failingOptions(2));
  const logged = () => errors.mock.calls.map((call) => call[0]);
  try {
    await ingress.start();
    await waitFor(() => logged().length > 0, 2500);
    expect(logged()).toContain(
      "V2 delivery recovery sweep failed: ledger offline"
    );
  } finally {
    await ingress.close();
    errors.mockRestore();
  }
});
