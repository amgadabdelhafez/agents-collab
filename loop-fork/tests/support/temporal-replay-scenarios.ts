/**
 * The in-flight executions the Temporal replay tests record and replay: the
 * supervisor-message V2 workflow and the task-graph workflow, each stopped in
 * a state a host can be in when its bundle is replaced (waiting for delivery,
 * in retry backoff, waiting for a claim, waiting for a result).
 *
 * One scenario is a start command, the commands sent before the upgrade
 * (`before`) and the commands that finish it after the upgrade (`after`).
 * Commands carry the exact names and payloads the V2 coordinator and the task
 * graph runtime send (supervisor-message-v2-runtime.ts `#deliver`, `claim`,
 * `acknowledge`, recovery's `retry_due`; task-graph-workflow.ts signals). A
 * command whose `expectError` is set is one the workflow refuses; its stored
 * error outcome is part of the replayed state too.
 *
 * The driver is version neutral: it addresses the workflow only through a
 * workflow port and raw Temporal queries by name, so the recorder can drive
 * an old build's own port and the tests can drive the current one.
 */
import type {
  JsonObject,
  JsonValue,
  WorkflowInspection,
} from "../../src/loop/workflow-port";

export const REPLAY_SCOPE = {
  principal: "principal:replay-sender",
  tenantId: "tenant:replay",
} as const;

export const REPLAY_RECIPIENT = "supervisor:replay-target";

/** The clock every recorded command carries. */
export const REPLAY_T0 = Date.parse("2026-10-05T12:00:00.000Z");
const RETRY_DELAY_MS = 60_000;

export const replayAt = (offsetMs: number): string =>
  new Date(REPLAY_T0 + offsetMs).toISOString();

const artifact = (digit: string): string =>
  `artifact://sha256/${digit.repeat(64)}`;

export interface ReplayCommand {
  at: string;
  /** The WorkflowError code the workflow answers with, when it refuses. */
  expectError?: string;
  kind: "cancel" | "signal";
  name: string;
  payload: JsonObject;
  requestId: string;
}

export interface ReplayScenario {
  after: readonly ReplayCommand[];
  before: readonly ReplayCommand[];
  /** What the execution is waiting for when the bundle is replaced. */
  description: string;
  /** Workflow-level status and, for V2, message phase after `after`. */
  final: { phase?: string; status: string };
  /** Workflow-level status and, for V2, message phase after `before`. */
  inFlight: { phase?: string; status: string };
  name: string;
  startAt: string;
  startInput: JsonObject;
  startRequestId: string;
  workflowId: string;
  workflowType: "supervisor-message.v2" | "task-graph.v1";
}

/**
 * The derivations a build applies to name its executions. They differ by
 * build (40097564 has the legacy message id and the unkeyed graph id;
 * ef570282 the deployment message id and the keyed graph id), and ids never
 * reach workflow logic, so the recorder uses each build's own.
 */
export interface ReplayIdentity {
  /** Distinguishes one set of executions from another on one server. */
  label: string;
  messageWorkflowId(dedupeKey: string): string;
  parseMessageInput(input: JsonObject): JsonObject;
  resultGraphWorkflowId(messageWorkflowId: string): string;
}

interface ReplayContract {
  deriveSupervisorMessageV2LegacyWorkflowId?: (
    scope: typeof REPLAY_SCOPE,
    dedupeKey: string
  ) => string;
  deriveSupervisorMessageV2ResultGraphWorkflowId: (
    ...args: unknown[]
  ) => string;
  deriveSupervisorMessageV2WorkflowId: (...args: unknown[]) => string;
  parseSupervisorMessageV2Input: (
    input: unknown,
    scope: typeof REPLAY_SCOPE
  ) => unknown;
  SupervisorResultGraphKey?: { fromSecret(secret: string): unknown };
}

/** A fixed, public test key: result graph ids only need to be well formed. */
const REPLAY_RESULT_GRAPH_KEY = "replay-fixture-result-graph-key-not-a-secret";

/**
 * Names executions the way the build whose supervisor-message-v2-contract
 * module this is would: the message id format it mints (legacy at 40097564
 * and on this line in its default legacy-write mode; deployment at ef570282,
 * which always writes it), and that build's own result graph id (unkeyed v2
 * at 40097564, keyed v3 after it).
 */
export const replayIdentityOf = (
  contract: ReplayContract,
  label: string,
  messageIdFormat: "deployment" | "legacy",
  deployment: string
): ReplayIdentity => {
  const messageWorkflowId = (dedupeKey: string): string => {
    if (messageIdFormat === "deployment") {
      return contract.deriveSupervisorMessageV2WorkflowId(
        REPLAY_SCOPE,
        dedupeKey,
        deployment
      );
    }
    // Before the discriminator the legacy derivation was the only one.
    return contract.deriveSupervisorMessageV2LegacyWorkflowId
      ? contract.deriveSupervisorMessageV2LegacyWorkflowId(
          REPLAY_SCOPE,
          dedupeKey
        )
      : contract.deriveSupervisorMessageV2WorkflowId(REPLAY_SCOPE, dedupeKey);
  };
  const resultGraphWorkflowId = (messageId: string): string =>
    contract.SupervisorResultGraphKey
      ? contract.deriveSupervisorMessageV2ResultGraphWorkflowId(
          contract.SupervisorResultGraphKey.fromSecret(REPLAY_RESULT_GRAPH_KEY),
          REPLAY_SCOPE,
          messageId
        )
      : contract.deriveSupervisorMessageV2ResultGraphWorkflowId(
          REPLAY_SCOPE,
          messageId
        );
  return {
    label,
    messageWorkflowId,
    parseMessageInput: (input) =>
      contract.parseSupervisorMessageV2Input(input, REPLAY_SCOPE) as JsonObject,
    resultGraphWorkflowId,
  };
};

const v2Input = (dedupeKey: string): JsonObject => ({
  artifactRefs: [artifact("a")],
  body: `Replay fixture message ${dedupeKey}.`,
  dedupeKey,
  from: "supervisor:replay-sender",
  messageId: `message-${dedupeKey}`,
  policy: {
    claimTimeoutMs: 3_600_000,
    escalationTimeoutMs: 3_600_000,
    maxDeliveryAttempts: 3,
    retryDelayMs: RETRY_DELAY_MS,
  },
  principal: REPLAY_SCOPE.principal,
  receivedAt: replayAt(0),
  schema: "supervisor-message.v2",
  tenantId: REPLAY_SCOPE.tenantId,
  threadId: `thread-${dedupeKey}`,
  to: REPLAY_RECIPIENT,
});

const signal = (
  name: string,
  payload: JsonObject,
  requestId: string,
  offsetMs: number,
  expectError?: string
): ReplayCommand => ({
  at: replayAt(offsetMs),
  ...(expectError ? { expectError } : {}),
  kind: "signal",
  name,
  payload,
  requestId,
});

const deliveryFailed = (requestId: string, offsetMs: number) =>
  signal(
    "delivery_failed",
    { permanent: false, reason: "recipient session is not enrolled" },
    requestId,
    offsetMs
  );

const claim = (requestId: string, offsetMs: number, expectError?: string) =>
  signal(
    "claim",
    { claimant: REPLAY_RECIPIENT },
    requestId,
    offsetMs,
    expectError
  );

const acknowledge = (requestId: string, offsetMs: number) =>
  signal("acknowledge", { claimant: REPLAY_RECIPIENT }, requestId, offsetMs);

const node = (
  taskId: string,
  dependencies: string[],
  authorityGates: string[] = []
): JsonObject => ({
  acceptanceChecks: [{ checkId: "result-artifact", kind: "artifact" }],
  authorityGates,
  dependencies,
  ownerRepository: "replay/target",
  readScopes: ["src"],
  specArtifactRef: artifact("b"),
  taskId,
  writeScopes: [`out/${taskId}`],
});

const graph = (graphId: string, nodes: JsonObject[]): JsonObject => ({
  graphId,
  nodes,
  schema: "task-graph.v1",
});

const WORKER = "replay-worker";
const task = (name: string, taskId: string, requestId: string, at: number) =>
  signal(name, { taskId, workerId: WORKER }, requestId, at);
const complete = (taskId: string, requestId: string, at: number) =>
  signal(
    "complete",
    {
      receipts: [{ artifactRef: artifact("c"), checkId: "result-artifact" }],
      taskId,
      workerId: WORKER,
    },
    requestId,
    at
  );

const v2 = (
  identity: ReplayIdentity,
  name: string,
  description: string,
  commands: Omit<
    ReplayScenario,
    | "description"
    | "name"
    | "startAt"
    | "startInput"
    | "startRequestId"
    | "workflowId"
    | "workflowType"
  >
): ReplayScenario => {
  const dedupeKey = `${identity.label}.${name}`;
  const workflowId = identity.messageWorkflowId(dedupeKey);
  return {
    ...commands,
    description,
    name,
    startAt: replayAt(0),
    startInput: {
      input: identity.parseMessageInput(v2Input(dedupeKey)),
      trustedScope: { ...REPLAY_SCOPE },
    },
    startRequestId: `receive:${dedupeKey}`,
    workflowId,
    workflowType: "supervisor-message.v2",
  };
};

/** Every scenario, named for one build's identity derivations. */
export const replayScenarios = (identity: ReplayIdentity): ReplayScenario[] => {
  const resultGraphMessage = identity.messageWorkflowId(
    `${identity.label}.result-graph-owner`
  );
  const graphId = (name: string): string =>
    `task-graph:${identity.label}:${name}`;
  return [
    v2(
      identity,
      "v2-delivery-pending",
      "started; delivery deferred (recipient not enrolled), a premature claim refused",
      {
        after: [
          signal("delivery_succeeded", {}, "recovery:pending:1", 120_000),
          claim("claim:pending:2", 130_000),
          acknowledge("ack:pending", 140_000),
        ],
        before: [claim("claim:pending:1", 1000, "invalid-state")],
        final: { phase: "acknowledged", status: "completed" },
        inFlight: { phase: "routed", status: "running" },
      }
    ),
    v2(
      identity,
      "v2-retry-backoff",
      "first delivery failed transiently; waiting out the retry delay",
      {
        after: [
          signal(
            "retry_due",
            {},
            `recovery-retry:backoff:${replayAt(1000 + RETRY_DELAY_MS)}`,
            1000 + RETRY_DELAY_MS
          ),
          signal("delivery_succeeded", {}, "recovery:backoff:2", 62_000),
          claim("claim:backoff", 63_000),
          acknowledge("ack:backoff", 64_000),
        ],
        before: [deliveryFailed("receive:backoff:delivery:1", 1000)],
        final: { phase: "acknowledged", status: "completed" },
        inFlight: { phase: "retry-scheduled", status: "running" },
      }
    ),
    v2(
      identity,
      "v2-awaiting-claim",
      "delivered after one retry; waiting for the recipient's claim",
      {
        after: [
          claim("claim:awaiting", 70_000),
          acknowledge("ack:awaiting", 71_000),
        ],
        before: [
          deliveryFailed("receive:awaiting:delivery:1", 1000),
          signal(
            "retry_due",
            {},
            `recovery-retry:awaiting:${replayAt(1000 + RETRY_DELAY_MS)}`,
            1000 + RETRY_DELAY_MS
          ),
          signal("delivery_succeeded", {}, "recovery:awaiting:2", 62_000),
        ],
        final: { phase: "acknowledged", status: "completed" },
        inFlight: { phase: "routed", status: "running" },
      }
    ),
    v2(
      identity,
      "v2-claimed-awaiting-ack",
      "claimed; waiting for the recipient's result and acknowledgement",
      {
        after: [acknowledge("ack:claimed", 30_000)],
        before: [
          signal("delivery_succeeded", {}, "receive:claimed:delivery:1", 1000),
          claim("claim:claimed", 2000),
        ],
        final: { phase: "acknowledged", status: "completed" },
        inFlight: { phase: "claimed", status: "running" },
      }
    ),
    v2(
      identity,
      "v2-acknowledged-open",
      "acknowledged: ended for the message, still a running Temporal execution",
      {
        after: [
          {
            ...acknowledge("ack:open:again", 10_000),
            expectError: "invalid-state",
          },
        ],
        before: [
          signal("delivery_succeeded", {}, "receive:open:delivery:1", 1000),
          claim("claim:open", 2000),
          acknowledge("ack:open", 3000),
        ],
        final: { phase: "acknowledged", status: "completed" },
        inFlight: { phase: "acknowledged", status: "completed" },
      }
    ),
    v2(
      identity,
      "v2-dead-lettered-open",
      "permanently failed: dead-lettered, still a running Temporal execution",
      {
        after: [claim("claim:dead:after", 10_000, "invalid-state")],
        before: [
          signal(
            "delivery_failed",
            { permanent: true, reason: "recipient rejected the message" },
            "receive:dead:delivery:1",
            1000
          ),
        ],
        final: { phase: "dead-lettered", status: "failed" },
        inFlight: { phase: "dead-lettered", status: "failed" },
      }
    ),
    {
      after: [
        signal(
          "satisfy_gate",
          {
            artifactRef: artifact("d"),
            gateId: "owner-approval",
            taskId: "deliver-result",
          },
          "gate:deliver-result",
          5000
        ),
        task("claim", "deliver-result", "claim:gated", 6000),
        task("start", "deliver-result", "start:gated", 7000),
        complete("deliver-result", "complete:gated", 8000),
      ],
      before: [],
      description: "a gated task waiting for its authority receipt",
      final: { status: "completed" },
      inFlight: { status: "running" },
      name: "graph-awaiting-gate",
      startAt: replayAt(0),
      startInput: graph("replay-graph-gated", [
        node("deliver-result", [], ["owner-approval"]),
      ]),
      startRequestId: "graph:gated",
      workflowId: graphId("graph-awaiting-gate"),
      workflowType: "task-graph.v1",
    },
    {
      after: [
        task("claim", "a-build", "claim:a", 5000),
        task("start", "a-build", "start:a", 6000),
        complete("a-build", "complete:a", 7000),
        task("claim", "b-publish", "claim:b", 8000),
        task("start", "b-publish", "start:b", 9000),
        complete("b-publish", "complete:b", 10_000),
      ],
      before: [],
      description:
        "a ready task waiting for a worker's claim, its dependent pending",
      final: { status: "completed" },
      inFlight: { status: "running" },
      name: "graph-awaiting-claim",
      startAt: replayAt(0),
      startInput: graph("replay-graph-claim", [
        node("a-build", []),
        node("b-publish", ["a-build"]),
      ]),
      startRequestId: "graph:claim",
      workflowId: graphId("graph-awaiting-claim"),
      workflowType: "task-graph.v1",
    },
    {
      after: [complete("deliver-result", "complete:result", 9000)],
      before: [
        task("claim", "deliver-result", "claim:result", 1000),
        task("start", "deliver-result", "start:result", 2000),
        {
          ...task("claim", "deliver-result", "claim:result:again", 3000),
          expectError: "invalid-state",
        },
      ],
      description:
        "a message's result graph: its task running, waiting for the result",
      final: { status: "completed" },
      inFlight: { status: "running" },
      name: "graph-awaiting-result",
      startAt: replayAt(0),
      startInput: graph("replay-result-graph", [node("deliver-result", [])]),
      startRequestId: "graph:result",
      workflowId: identity.resultGraphWorkflowId(resultGraphMessage),
      workflowType: "task-graph.v1",
    },
    {
      after: [
        task("start", "b-publish", "start:partial:b", 6000),
        complete("b-publish", "complete:partial:b", 7000),
      ],
      before: [
        task("claim", "a-build", "claim:partial:a", 1000),
        task("start", "a-build", "start:partial:a", 2000),
        complete("a-build", "complete:partial:a", 3000),
        task("claim", "b-publish", "claim:partial:b", 4000),
      ],
      description: "first task done; the dependent claimed, not started",
      final: { status: "completed" },
      inFlight: { status: "running" },
      name: "graph-partially-complete",
      startAt: replayAt(0),
      startInput: graph("replay-graph-partial", [
        node("a-build", []),
        node("b-publish", ["a-build"]),
      ]),
      startRequestId: "graph:partial",
      workflowId: graphId("graph-partially-complete"),
      workflowType: "task-graph.v1",
    },
    {
      after: [
        {
          ...task("claim", "b-publish", "claim:failed:b", 9000),
          expectError: "invalid-state",
        },
      ],
      before: [
        task("claim", "a-build", "claim:failed:a", 1000),
        signal(
          "fail",
          { failureCode: "build-broke", taskId: "a-build", workerId: WORKER },
          "fail:failed:a",
          2000
        ),
      ],
      description:
        "first task failed and its dependent blocked: ended, still running",
      final: { status: "failed" },
      inFlight: { status: "failed" },
      name: "graph-failed-blocked",
      startAt: replayAt(0),
      startInput: graph("replay-graph-failed", [
        node("a-build", []),
        node("b-publish", ["a-build"]),
      ]),
      startRequestId: "graph:failed",
      workflowId: graphId("graph-failed-blocked"),
      workflowType: "task-graph.v1",
    },
  ];
};

/** The workflow port surface the driver uses (any build's port has it). */
export interface ReplayPort {
  inspect(workflowId: string): Promise<WorkflowInspection>;
  query(command: {
    args?: JsonObject;
    name: string;
    workflowId: string;
  }): Promise<{ status: string; value: JsonValue }>;
  signal(command: {
    name: string;
    payload: JsonObject;
    requestId: string;
    workflowId: string;
  }): Promise<unknown>;
  start(command: {
    input: JsonObject;
    requestId: string;
    workflowId: string;
    workflowType: string;
  }): Promise<unknown>;
}

/** A raw query by name, for the command outcomes the port does not expose. */
export type ReplayOutcomeQuery = (
  workflowId: string,
  key: string
) => Promise<unknown>;

/** The port's clock, set before each command so every `at` is recorded. */
export interface ReplayClock {
  at: string;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

export const runReplayCommands = async (
  port: ReplayPort,
  clock: ReplayClock,
  scenario: ReplayScenario,
  commands: readonly ReplayCommand[]
): Promise<void> => {
  for (const command of commands) {
    clock.at = command.at;
    let refused: string | undefined;
    try {
      await port.signal({
        name: command.name,
        payload: command.payload,
        requestId: command.requestId,
        workflowId: scenario.workflowId,
      });
    } catch (error) {
      refused = errorCode(error) ?? String(error);
    }
    if (refused !== command.expectError) {
      throw new Error(
        `${scenario.name}: ${command.name} ${command.requestId} answered ${
          refused ?? "ok"
        }, expected ${command.expectError ?? "ok"}`
      );
    }
  }
};

export const startReplayScenario = async (
  port: ReplayPort,
  clock: ReplayClock,
  scenario: ReplayScenario
): Promise<void> => {
  clock.at = scenario.startAt;
  await port.start({
    input: scenario.startInput,
    requestId: scenario.startRequestId,
    workflowId: scenario.workflowId,
    workflowType: scenario.workflowType,
  });
  await runReplayCommands(port, clock, scenario, scenario.before);
};

export interface ReplaySnapshot {
  inspection: WorkflowInspection;
  outcomes: Record<string, unknown>;
  status: JsonValue;
}

/**
 * Everything the workflow answers about one execution: its inspection, its
 * status query, and the stored outcome of every command sent so far.
 */
export const snapshotReplayScenario = async (
  port: ReplayPort,
  outcome: ReplayOutcomeQuery,
  scenario: ReplayScenario,
  commands: readonly ReplayCommand[]
): Promise<ReplaySnapshot> => {
  const inspection = await port.inspect(scenario.workflowId);
  const status = await port.query({
    ...(scenario.workflowType === "supervisor-message.v2"
      ? { args: { trustedScope: { ...REPLAY_SCOPE } } }
      : {}),
    name: "status",
    workflowId: scenario.workflowId,
  });
  const outcomes: Record<string, unknown> = {};
  for (const command of commands) {
    const key = `${command.kind}:${command.requestId}`;
    outcomes[key] = await outcome(scenario.workflowId, key);
  }
  return { inspection, outcomes, status: status.value };
};

/** The phase a V2 status projection reports, if it is one. */
export const phaseOf = (status: JsonValue): string | undefined =>
  typeof status === "object" &&
  status !== null &&
  !Array.isArray(status) &&
  typeof status.phase === "string"
    ? status.phase
    : undefined;

/**
 * A snapshot with this run's names taken out (the execution's workflow id,
 * and the run label in dedupe keys, message ids and thread ids), so two
 * executions of one scenario under different names compare equal.
 */
export const normalizeReplaySnapshot = (
  snapshot: ReplaySnapshot,
  scenario: ReplayScenario,
  identity: ReplayIdentity
): unknown =>
  JSON.parse(
    JSON.stringify(snapshot)
      .replaceAll(scenario.workflowId, "<workflow-id>")
      .replaceAll(identity.label, "<label>")
  );
