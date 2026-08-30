import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DbosSupervisorMessageReplayRuntime } from "../../src/loop/dbos-replay-runtime";
import { supervisorMessageReplayFixtures } from "../../src/loop/supervisor-message-replay-fixtures";
import { WorkflowError } from "../../src/loop/workflow-port";
import { runSupervisorMessageReplayFixture } from "../../src/loop/workflow-replay-corpus";

let runtime: DbosSupervisorMessageReplayRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("DBOS WorkflowPort comparison", () => {
  test("matches five cases and proves DBOS refuses cross-version recovery", async () => {
    runtime = await DbosSupervisorMessageReplayRuntime.create();
    for (const fixture of supervisorMessageReplayFixtures.slice(0, -1)) {
      const result = await runSupervisorMessageReplayFixture(fixture, runtime);
      expect(result.digest).toBe(fixture.expectedDigest);
    }

    const upgradeFixture = supervisorMessageReplayFixtures.at(-1);
    if (!upgradeFixture) {
      throw new Error("frozen replay corpus has no worker-upgrade fixture");
    }
    let refusal: unknown;
    try {
      await runSupervisorMessageReplayFixture(upgradeFixture, runtime);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(WorkflowError);
    expect((refusal as Error).message).toBe(
      "DBOS did not durably observe signal-claim-1 within the bounded wait"
    );
    const workflowId = `supervisor-message:${createHash("sha256")
      .update(upgradeFixture.input.dedupeKey)
      .digest("hex")}`;
    const status = (await runtime.workflowStatus(workflowId)) as {
      applicationVersion?: string;
      errorMessage?: string;
      status?: string;
      workflowID?: string;
    } | null;
    expect(status).toMatchObject({
      applicationVersion: "supervisor-message.v1-worker",
      status: "PENDING",
      workflowID: workflowId,
    });
    expect(status?.errorMessage).toBeUndefined();
    expect(runtime.workerIdentity().version).toBe(
      "supervisor-message.v2-worker"
    );
    expect(runtime.workerIdentity().generation).toBeGreaterThan(1);
  }, 180_000);

  test("keeps DBOS types out of canonical workflow and fixture modules", async () => {
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
      expect(source).not.toContain("@dbos-inc/");
      expect(source).not.toContain("@temporalio/");
    }
  });

  test("pins one exact stable DBOS SDK version", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["@dbos-inc/dbos-sdk"]).toBe("4.27.6");
  });
});
