import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  SUPERVISOR_MESSAGE_REPLAY_AGGREGATE_DIGEST,
  supervisorMessageReplayFixtures,
} from "../../src/loop/supervisor-message-replay-fixtures";
import { TemporalSupervisorMessageReplayRuntime } from "../../src/loop/temporal-replay-runtime";
import { runSupervisorMessageReplayCorpus } from "../../src/loop/workflow-replay-corpus";

const runFreshTemporalCorpus = async (suffix: string) => {
  const runtime = await TemporalSupervisorMessageReplayRuntime.create(
    `orch-temporal-replay-${process.pid}-${suffix}`
  );
  try {
    const result = await runSupervisorMessageReplayCorpus(
      supervisorMessageReplayFixtures,
      () => runtime
    );
    return { identity: runtime.workerIdentity(), result };
  } finally {
    await runtime.close();
  }
};

describe("Temporal WorkflowPort conformance", () => {
  test("runs the unchanged frozen corpus twice on fresh Temporal servers", async () => {
    const first = await runFreshTemporalCorpus("first");
    const second = await runFreshTemporalCorpus("second");
    expect(first.result).toEqual(second.result);
    expect(first.result.aggregateDigest).toBe(
      SUPERVISOR_MESSAGE_REPLAY_AGGREGATE_DIGEST
    );
    expect(first.result.cases).toHaveLength(
      supervisorMessageReplayFixtures.length
    );
    expect(first.identity).toMatchObject({
      version: "supervisor-message.v2-worker",
    });
    expect(first.identity.generation).toBeGreaterThan(1);
  }, 180_000);

  test("keeps Temporal types out of canonical workflow and fixture modules", async () => {
    const canonicalPaths = [
      "src/loop/workflow-port.ts",
      "src/loop/in-memory-workflow-port.ts",
      "src/loop/supervisor-message-workflow.ts",
      "src/loop/supervisor-message-coordinator.ts",
      "src/loop/workflow-replay-corpus.ts",
      "src/loop/supervisor-message-replay-fixtures.ts",
    ];
    for (const path of canonicalPaths) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("@temporalio/");
      expect(source).not.toContain("@dbos-inc/");
    }
  });

  test("pins one exact Temporal SDK version across direct dependencies", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toMatchObject({
      "@temporalio/client": "1.23.0",
      "@temporalio/testing": "1.23.0",
      "@temporalio/worker": "1.23.0",
      "@temporalio/workflow": "1.23.0",
    });
  });
});
