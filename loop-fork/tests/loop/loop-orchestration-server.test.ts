import { expect, test } from "bun:test";
import { parseLoopOrchestrationConfig } from "../../src/loop/loop-orchestration-server";

const config = () => ({
  address: "127.0.0.1:7233",
  buildId: "loop-orchestration.v1",
  grants: [
    {
      from: "supervisor:harvto",
      operations: ["receive"],
      principal: "principal:harvto",
      to: "supervisor:harness",
    },
  ],
  hostname: "127.0.0.1",
  identity: "loop-orchestration@local",
  namespace: "default",
  port: 7321,
  schema: "loop-orchestration-server.v1",
  stateDir: "/private/tmp/loop-orchestration-state",
  supervisors: [
    {
      manifestPath: "/Users/example/.loop/runs/harness/1/manifest.json",
      principal: "principal:harness",
      supervisorId: "supervisor:harness",
      tokenEnv: "LOOP_HARNESS_ORCHESTRATION_TOKEN",
    },
  ],
  taskQueue: "loop-orchestration",
});

test("orchestration config binds loopback routes, grants, and secret environment names", () => {
  expect(parseLoopOrchestrationConfig(config())).toMatchObject({
    hostname: "127.0.0.1",
    supervisors: [
      {
        supervisorId: "supervisor:harness",
        tokenEnv: "LOOP_HARNESS_ORCHESTRATION_TOKEN",
      },
    ],
  });
});

test("orchestration config rejects inline secrets, remote listeners, and unknown grants", () => {
  expect(() =>
    parseLoopOrchestrationConfig({ ...config(), secret: "must-not-persist" })
  ).toThrow("invalid fields");
  expect(() =>
    parseLoopOrchestrationConfig({ ...config(), hostname: "0.0.0.0" })
  ).toThrow("hostname is invalid");
  const invalid = config();
  const [grant] = invalid.grants;
  if (!grant) {
    throw new Error("test fixture grant is missing");
  }
  grant.operations = ["delete"];
  expect(() => parseLoopOrchestrationConfig(invalid)).toThrow(
    "grant operations are invalid"
  );
});

const a2aV2 = (resultArtifacts: unknown[]) => ({
  ...config(),
  a2aV2: {
    databaseUrlEnv: "LOOP_A2A_V2_DATABASE_URL",
    endpointRef: "endpoint:local-a2a",
    policy: {
      claimTimeoutMs: 60_000,
      escalationTimeoutMs: 120_000,
      maxDeliveryAttempts: 3,
      retryDelayMs: 1000,
    },
    principal: "principal:harness",
    recipient: "supervisor:harness",
    resultArtifacts,
    routePath: "/a2a",
    sessionTtlMs: 3_600_000,
    tenant: "tenant:local",
  },
});
const artifact = {
  artifactRef: `artifact://sha256/${"a".repeat(64)}`,
  commit: "b".repeat(40),
  path: "results/accepted.md",
  repositoryRoot: "/Users/example/repo",
};

test("orchestration config refuses a result artifact in the retired shape with the exact migration", () => {
  expect(() => parseLoopOrchestrationConfig(a2aV2([artifact]))).toThrow(
    "orchestration a2aV2 resultArtifacts[0] uses the retired shape {artifactRef, commit, path, repositoryRoot}: add graphWorkflowId and graphTaskId"
  );
});

test("orchestration config refuses a result artifact for a graph no message result can bind to", () => {
  expect(() =>
    parseLoopOrchestrationConfig(
      a2aV2([
        {
          ...artifact,
          graphTaskId: "result-node",
          graphWorkflowId: "task-graph:chosen-by-operator",
        },
      ])
    )
  ).toThrow(
    "orchestration a2aV2 resultArtifacts[0] graphWorkflowId is not a message-derived result graph"
  );
});

test("orchestration config accepts a result artifact bound to a message-derived graph task", () => {
  const graphWorkflowId = `supervisor-result-graph:v2:${"c".repeat(64)}`;
  expect(
    parseLoopOrchestrationConfig(
      a2aV2([{ ...artifact, graphTaskId: "result-node", graphWorkflowId }])
    ).a2aV2?.resultArtifacts
  ).toEqual([{ ...artifact, graphTaskId: "result-node", graphWorkflowId }]);
});
