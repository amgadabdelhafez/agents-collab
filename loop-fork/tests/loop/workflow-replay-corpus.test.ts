import { describe, expect, test } from "bun:test";
import { InMemorySupervisorMessageReplayRuntime } from "../../src/loop/in-memory-replay-runtime";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  SUPERVISOR_MESSAGE_REPLAY_AGGREGATE_DIGEST,
  supervisorMessageReplayFixtures,
} from "../../src/loop/supervisor-message-replay-fixtures";
import { supervisorMessageWorkflowDefinition } from "../../src/loop/supervisor-message-workflow";
import type { WorkflowPort } from "../../src/loop/workflow-port";
import {
  runSupervisorMessageReplayCorpus,
  runSupervisorMessageReplayFixture,
  type SupervisorMessageReplayFixture,
  type SupervisorMessageReplayRuntime,
  WorkflowReplayMismatchError,
} from "../../src/loop/workflow-replay-corpus";

const BODY_SENTINEL = "fixture body must never enter replay observations";
const PATH_SENTINEL = "/Users/private.txt";

const runtime = (): InMemorySupervisorMessageReplayRuntime =>
  new InMemorySupervisorMessageReplayRuntime();

const fixture = (id: string): SupervisorMessageReplayFixture => {
  const selected = supervisorMessageReplayFixtures.find(
    (candidate) => candidate.id === id
  );
  if (!selected) {
    throw new Error(`missing replay fixture ${id}`);
  }
  return structuredClone(selected);
};

class RuntimeDecorator implements SupervisorMessageReplayRuntime {
  readonly #base: SupervisorMessageReplayRuntime;
  readonly delivery;

  constructor(base: SupervisorMessageReplayRuntime) {
    this.#base = base;
    this.delivery = base.delivery;
  }

  deliveries() {
    return this.#base.deliveries();
  }

  restartWorker() {
    return this.#base.restartWorker();
  }

  setClock(at: string) {
    return this.#base.setClock(at);
  }

  setDeliveryOutcomes(
    outcomes: Parameters<
      SupervisorMessageReplayRuntime["setDeliveryOutcomes"]
    >[0]
  ) {
    return this.#base.setDeliveryOutcomes(outcomes);
  }

  upgradeWorker(version: string) {
    return this.#base.upgradeWorker(version);
  }

  workflowPort(): WorkflowPort {
    return this.#base.workflowPort();
  }
}

class StateLosingRuntime extends RuntimeDecorator {
  #replacement: WorkflowPort | undefined;

  override restartWorker(): void {
    this.#replacement = new InMemoryWorkflowPort({
      definitions: [supervisorMessageWorkflowDefinition],
    });
  }

  override workflowPort(): WorkflowPort {
    return this.#replacement ?? super.workflowPort();
  }
}

class DuplicateDeliveryRuntime extends RuntimeDecorator {
  override deliveries() {
    const deliveries = super.deliveries();
    const last = deliveries.at(-1);
    return last ? [...deliveries, structuredClone(last)] : deliveries;
  }
}

class TerminalStatusCorruptingRuntime extends RuntimeDecorator {
  override workflowPort(): WorkflowPort {
    const port = super.workflowPort();
    return {
      cancel: (command) => port.cancel(command),
      inspect: async (workflowId) => ({
        ...(await port.inspect(workflowId)),
        status: "running",
      }),
      query: (command) => port.query(command),
      signal: (command) => port.signal(command),
      start: (command) => port.start(command),
    };
  }
}

describe("SupervisorMessage deterministic replay corpus", () => {
  test("is inert JSON-safe data covering every required interruption class", () => {
    const serialized = JSON.stringify(supervisorMessageReplayFixtures);
    expect(JSON.parse(serialized)).toEqual(supervisorMessageReplayFixtures);
    expect(supervisorMessageReplayFixtures.map(({ id }) => id)).toEqual([
      "duplicate-receive",
      "crash-retry",
      "delayed-claim",
      "cancellation-replay",
      "retry-exhaustion",
      "worker-upgrade",
    ]);
    const steps = supervisorMessageReplayFixtures.flatMap(({ steps }) =>
      steps.map(({ kind }) => kind)
    );
    expect(steps).toContain("restart-worker");
    expect(steps).toContain("upgrade-worker");
    expect(steps).toContain("cancel");
    expect(steps).toContain("tick");
  });

  test("replays every case twice with identical structural digests", async () => {
    const first = await runSupervisorMessageReplayCorpus(
      supervisorMessageReplayFixtures,
      runtime
    );
    const second = await runSupervisorMessageReplayCorpus(
      supervisorMessageReplayFixtures,
      runtime
    );
    expect(second).toEqual(first);
    expect(first.cases.map(({ digest }) => digest)).toHaveLength(
      supervisorMessageReplayFixtures.length
    );
    expect(new Set(first.cases.map(({ digest }) => digest)).size).toBe(
      supervisorMessageReplayFixtures.length
    );
    expect(first.aggregateDigest).toHaveLength(64);
    expect(first.aggregateDigest).toBe(
      SUPERVISOR_MESSAGE_REPLAY_AGGREGATE_DIGEST
    );
  });

  test("observations redact bodies and local paths", async () => {
    const result = await runSupervisorMessageReplayCorpus(
      supervisorMessageReplayFixtures,
      runtime
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(BODY_SENTINEL);
    expect(serialized).not.toContain(PATH_SENTINEL);
  });

  test("fails closed when a restarted worker loses durable state", async () => {
    await expect(
      runSupervisorMessageReplayFixture(
        fixture("crash-retry"),
        new StateLosingRuntime(runtime())
      )
    ).rejects.toMatchObject({ code: "not-found" });
  });

  test("fails closed when a runtime duplicates a delivery observation", async () => {
    await expect(
      runSupervisorMessageReplayFixture(
        fixture("duplicate-receive"),
        new DuplicateDeliveryRuntime(runtime())
      )
    ).rejects.toBeInstanceOf(WorkflowReplayMismatchError);
  });

  test("fails closed when a runtime changes a terminal execution status", async () => {
    await expect(
      runSupervisorMessageReplayFixture(
        fixture("cancellation-replay"),
        new TerminalStatusCorruptingRuntime(runtime())
      )
    ).rejects.toThrow("execution status mismatch");
  });

  test("fails closed when expected observations do not match", async () => {
    const mismatched = fixture("worker-upgrade");
    mismatched.expected.revision += 1;
    await expect(
      runSupervisorMessageReplayFixture(mismatched, runtime())
    ).rejects.toThrow("revision mismatch");
  });
});
