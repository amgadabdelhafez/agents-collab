import { describe, expect, test } from "bun:test";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  type JsonObject,
  type WorkflowDefinition,
  WorkflowError,
} from "../../src/loop/workflow-port";

const counterDefinition: WorkflowDefinition = {
  cancel(state, reason) {
    return { result: { reason }, state, status: "canceled" };
  },
  query(state, name) {
    if (name !== "value") {
      throw new WorkflowError("unknown-query", `unknown query ${name}`);
    }
    return state.value ?? null;
  },
  signal(state, name, payload) {
    if (name !== "add") {
      throw new WorkflowError("unknown-signal", `unknown signal ${name}`);
    }
    const amount = payload.amount;
    if (typeof amount !== "number") {
      throw new WorkflowError("invalid-command", "amount must be numeric");
    }
    return {
      result: { value: Number(state.value) + amount },
      state: { value: Number(state.value) + amount },
    };
  },
  start(input) {
    if (typeof input.value !== "number") {
      throw new WorkflowError("invalid-command", "value must be numeric");
    }
    return { state: { value: input.value } };
  },
  type: "counter.v1",
};

const clock = () => {
  let sequence = 0;
  return () => `2026-08-30T03:40:0${sequence++}.000Z`;
};

describe("InMemoryWorkflowPort", () => {
  test("starts, signals, queries, inspects, and deduplicates commands", async () => {
    const port = new InMemoryWorkflowPort({
      definitions: [counterDefinition],
      now: clock(),
    });
    const started = await port.start({
      input: { value: 2 },
      requestId: "start-1",
      workflowId: "counter-1",
      workflowType: "counter.v1",
    });
    expect(started).toMatchObject({
      created: true,
      replayed: false,
      revision: 1,
      status: "running",
    });

    const duplicate = await port.start({
      input: { value: 999 },
      requestId: "start-duplicate",
      workflowId: "counter-1",
      workflowType: "counter.v1",
    });
    expect(duplicate.created).toBe(false);

    const signal = await port.signal({
      name: "add",
      payload: { amount: 3 },
      requestId: "add-1",
      workflowId: "counter-1",
    });
    expect(signal).toMatchObject({ replayed: false, revision: 2 });
    const replay = await port.signal({
      name: "add",
      payload: { amount: 300 },
      requestId: "add-1",
      workflowId: "counter-1",
    });
    expect(replay).toMatchObject({ replayed: true, revision: 2 });
    expect(
      await port.query({ name: "value", workflowId: "counter-1" })
    ).toMatchObject({ revision: 2, value: 5 });

    const inspection = await port.inspect("counter-1");
    expect(inspection.history.map((event) => event.kind)).toEqual([
      "started",
      "signaled",
    ]);
    const mutable = inspection.history as JsonObject[];
    mutable[0] = { compromised: true };
    expect((await port.inspect("counter-1")).history[0]?.kind).toBe("started");
  });

  test("cancellation is terminal and request-id idempotent", async () => {
    const port = new InMemoryWorkflowPort({
      definitions: [counterDefinition],
      now: clock(),
    });
    await port.start({
      input: { value: 1 },
      requestId: "start-1",
      workflowId: "counter-1",
      workflowType: "counter.v1",
    });
    const canceled = await port.cancel({
      reason: "operator request",
      requestId: "cancel-1",
      workflowId: "counter-1",
    });
    expect(canceled.status).toBe("canceled");
    expect(
      await port.cancel({
        reason: "different replay body",
        requestId: "cancel-1",
        workflowId: "counter-1",
      })
    ).toMatchObject({ replayed: true, revision: 2 });
    expect(() =>
      port.signal({
        name: "add",
        payload: { amount: 1 },
        requestId: "late",
        workflowId: "counter-1",
      })
    ).toThrow("cannot signal add");
  });

  test("fails closed for unknown workflow types and identity conflicts", async () => {
    const port = new InMemoryWorkflowPort({ definitions: [counterDefinition] });
    expect(() =>
      port.start({
        input: {},
        requestId: "start",
        workflowId: "unknown",
        workflowType: "missing.v1",
      })
    ).toThrow("unknown workflow type");
    await port.start({
      input: { value: 1 },
      requestId: "start",
      workflowId: "counter",
      workflowType: "counter.v1",
    });
    expect(() =>
      port.start({
        input: {},
        requestId: "conflict",
        workflowId: "counter",
        workflowType: "missing.v1",
      })
    ).toThrow("already exists");
  });
});
