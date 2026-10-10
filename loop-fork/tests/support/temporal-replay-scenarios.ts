/**
 * The in-flight executions the Temporal replay tests record and replay, each
 * stopped in a state a host can be in when its bundle is replaced (waiting
 * for delivery, in retry backoff, waiting for a claim, waiting for a result).
 *
 * Two families, by what a build registers:
 *
 * - `v2-line` (40097564 onwards): the supervisor-message V2 workflow and the
 *   task-graph workflow, including a message's result graph.
 * - `deployed` (455ccc32, the live orchestration service): the
 *   supervisor-message V1 workflow, the governess beat workflow and the
 *   task-graph workflow. These builds have no V2 code.
 *
 * One scenario is a start command, the commands sent before the upgrade
 * (`before`) and the commands that finish it after the upgrade (`after`).
 * Commands carry the exact names and payloads the callers send: the V2
 * coordinator (supervisor-message-v2-runtime.ts `#deliver`, `claim`,
 * `acknowledge`, recovery's `retry_due`), the V1 coordinator and deadline
 * driver (supervisor-message-coordinator.ts, `clock_tick`), the governess
 * write-through (governess-temporal-journal.ts `append_record`) and the
 * gov-6 decision signals, and the task graph runtime. A command whose
 * `expectError` is set is one the workflow refuses; its stored error outcome
 * is part of the replayed state too.
 *
 * Each scenario also names the queries its callers read (`queries`): the V2
 * coordinator reads `delivery_request` before every delivery and
 * `delivery_pending` in recovery, the V1 coordinator `delivery_request`, the
 * task graph runtime `ready`, the governess `journal`, `pending_controls` and
 * `latest_by_idempotency`. A snapshot holds every answer, or the error the
 * query failed with, so a bundle that answers one of them differently is
 * caught even when the status projection is unchanged.
 *
 * The driver is version neutral: it addresses the workflow only through a
 * workflow port and raw Temporal queries by name, so the recorder can drive
 * an old build's own port and the tests can drive the current one. This
 * module is also bundled into a control workflow, so it imports no Node
 * module: derivations that hash live with the caller.
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
const CLAIM_TIMEOUT_MS = 3_600_000;
const ESCALATION_TIMEOUT_MS = 3_600_000;

export const replayAt = (offsetMs: number): string =>
  new Date(REPLAY_T0 + offsetMs).toISOString();

const artifact = (digit: string): string =>
  `artifact://sha256/${digit.repeat(64)}`;

/** Which workflow types a build registers; see the module comment. */
export type ReplayFamily = "deployed" | "v2-line";

export type ReplayWorkflowType =
  | "governess-beat.v1"
  | "supervisor-message.v1"
  | "supervisor-message.v2"
  | "task-graph.v1";

export interface ReplayCommand {
  at: string;
  /** The WorkflowError code the workflow answers with, when it refuses. */
  expectError?: string;
  kind: "cancel" | "signal";
  /** The signal name; "cancel" for a cancel. */
  name: string;
  /** The signal payload; `{ reason }` for a cancel. */
  payload: JsonObject;
  requestId: string;
}

/** One query a caller of this workflow type sends, by its snapshot label. */
export interface ReplayQuery {
  args?: JsonObject;
  label: string;
  name: string;
}

export interface ReplayScenario {
  after: readonly ReplayCommand[];
  before: readonly ReplayCommand[];
  /** What the execution is waiting for when the bundle is replaced. */
  description: string;
  /** Workflow-level status and, for a message, its phase after `after`. */
  final: { phase?: string; status: string };
  /** Workflow-level status and, for a message, its phase after `before`. */
  inFlight: { phase?: string; status: string };
  name: string;
  queries: readonly ReplayQuery[];
  startAt: string;
  startInput: JsonObject;
  startRequestId: string;
  workflowId: string;
  workflowType: ReplayWorkflowType;
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

/** The names a deployed (V1-era) build gives its executions. */
export interface DeployedReplayIdentity {
  label: string;
  /** supervisor-message-coordinator.ts `workflowIdFor`. */
  v1MessageWorkflowId(dedupeKey: string): string;
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

const v1Input = (dedupeKey: string): JsonObject => ({
  artifactRefs: [artifact("a")],
  body: `Replay fixture message ${dedupeKey}.`,
  dedupeKey,
  from: "supervisor:replay-sender",
  messageId: `message-${dedupeKey}`,
  policy: {
    claimTimeoutMs: CLAIM_TIMEOUT_MS,
    escalationTimeoutMs: ESCALATION_TIMEOUT_MS,
    maxDeliveryAttempts: 3,
    retryDelayMs: RETRY_DELAY_MS,
  },
  receivedAt: replayAt(0),
  threadId: `thread-${dedupeKey}`,
  to: REPLAY_RECIPIENT,
});

const v2Input = (dedupeKey: string): JsonObject => ({
  ...v1Input(dedupeKey),
  principal: REPLAY_SCOPE.principal,
  schema: "supervisor-message.v2",
  tenantId: REPLAY_SCOPE.tenantId,
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

const cancel = (
  reason: string,
  requestId: string,
  offsetMs: number,
  expectError?: string
): ReplayCommand => ({
  at: replayAt(offsetMs),
  ...(expectError ? { expectError } : {}),
  kind: "cancel",
  name: "cancel",
  payload: { reason },
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

/** The V2 coordinator's reads: status, recovery's pending check, delivery. */
const v2Queries = (workflowId: string): ReplayQuery[] => {
  const trustedScope = { ...REPLAY_SCOPE };
  return [
    { args: { trustedScope }, label: "status", name: "status" },
    {
      args: { trustedScope },
      label: "delivery_pending",
      name: "delivery_pending",
    },
    {
      args: { trustedScope, workflowId },
      label: "delivery_request",
      name: "delivery_request",
    },
  ];
};

/** The V1 coordinator's reads, and the replay corpus's event kinds. */
const v1Queries = (workflowId: string): ReplayQuery[] => [
  { label: "status", name: "status" },
  {
    args: { workflowId },
    label: "delivery_request",
    name: "delivery_request",
  },
  { label: "event_kinds", name: "event_kinds" },
];

/** The task graph runtime's reads (task-graph-runtime.ts). */
const GRAPH_QUERIES: readonly ReplayQuery[] = [
  { label: "status", name: "status" },
  { label: "ready", name: "ready" },
];

/** The governess's reads of its beat workflow. */
const beatQueries = (idempotencyKeys: readonly string[]): ReplayQuery[] => [
  { label: "journal", name: "journal" },
  { label: "pending_controls", name: "pending_controls" },
  ...idempotencyKeys.map((idempotencyKey) => ({
    args: { idempotencyKey },
    label: `latest_by_idempotency:${idempotencyKey}`,
    name: "latest_by_idempotency",
  })),
];

type MessageCommands = Pick<
  ReplayScenario,
  "after" | "before" | "final" | "inFlight"
>;

const v2 = (
  identity: ReplayIdentity,
  name: string,
  description: string,
  commands: MessageCommands
): ReplayScenario => {
  const dedupeKey = `${identity.label}.${name}`;
  const workflowId = identity.messageWorkflowId(dedupeKey);
  return {
    ...commands,
    description,
    name,
    queries: v2Queries(workflowId),
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

const v1 = (
  identity: DeployedReplayIdentity,
  name: string,
  description: string,
  commands: MessageCommands
): ReplayScenario => {
  const dedupeKey = `${identity.label}.${name}`;
  const workflowId = identity.v1MessageWorkflowId(dedupeKey);
  return {
    ...commands,
    description,
    name,
    queries: v1Queries(workflowId),
    startAt: replayAt(0),
    startInput: v1Input(dedupeKey),
    startRequestId: `v1:receive:${dedupeKey}`,
    workflowId,
    workflowType: "supervisor-message.v1",
  };
};

/**
 * The task graph scenarios, which every build here registers. The third one
 * is a message's result graph on the V2 line, named by `resultGraphId`.
 */
const graphScenarios = (
  graphId: (name: string) => string,
  resultGraphId: string
): ReplayScenario[] => [
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
    queries: GRAPH_QUERIES,
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
    queries: GRAPH_QUERIES,
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
    queries: GRAPH_QUERIES,
    startAt: replayAt(0),
    startInput: graph("replay-result-graph", [node("deliver-result", [])]),
    startRequestId: "graph:result",
    workflowId: resultGraphId,
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
    queries: GRAPH_QUERIES,
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
    queries: GRAPH_QUERIES,
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

const graphIdOf =
  (label: string) =>
  (name: string): string =>
    `task-graph:${label}:${name}`;

/** Every `v2-line` scenario, named for one build's identity derivations. */
export const replayScenarios = (identity: ReplayIdentity): ReplayScenario[] => {
  const resultGraphMessage = identity.messageWorkflowId(
    `${identity.label}.result-graph-owner`
  );
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
    ...graphScenarios(
      graphIdOf(identity.label),
      identity.resultGraphWorkflowId(resultGraphMessage)
    ),
  ];
};

const v1Signal = (
  name: string,
  payload: JsonObject,
  requestId: string,
  offsetMs: number,
  expectError?: string
) => signal(name, payload, `v1:${requestId}`, offsetMs, expectError);
const v1Claim = (requestId: string, offsetMs: number, expectError?: string) =>
  v1Signal(
    "claim",
    { claimant: REPLAY_RECIPIENT },
    requestId,
    offsetMs,
    expectError
  );
const v1Acknowledge = (
  requestId: string,
  offsetMs: number,
  expectError?: string
) =>
  v1Signal(
    "acknowledge",
    { claimant: REPLAY_RECIPIENT },
    requestId,
    offsetMs,
    expectError
  );
const v1Delivered = (requestId: string, offsetMs: number) =>
  v1Signal("delivery_succeeded", {}, requestId, offsetMs);
const v1Tick = (requestId: string, offsetMs: number) =>
  v1Signal("clock_tick", {}, requestId, offsetMs);

/** The V1 messages a deployed build's coordinator and deadline driver run. */
const v1Scenarios = (identity: DeployedReplayIdentity): ReplayScenario[] => [
  v1(
    identity,
    "v1-delivery-pending",
    "started; delivery not yet accepted, a premature claim refused",
    {
      after: [
        v1Delivered("pending:delivery:1", 120_000),
        v1Claim("claim:pending:2", 130_000),
        v1Acknowledge("ack:pending", 140_000),
      ],
      before: [v1Claim("claim:pending:1", 1000, "invalid-state")],
      final: { phase: "acknowledged", status: "completed" },
      inFlight: { phase: "routed", status: "running" },
    }
  ),
  v1(
    identity,
    "v1-retry-backoff",
    "first delivery failed transiently, a deadline tick before the retry is due changed nothing; waiting out the retry delay",
    {
      after: [
        // The deadline driver's tick past the retry instant: back to routed,
        // with `{ action: "deliver" }` for the coordinator.
        v1Tick("tick:backoff:2", 1000 + RETRY_DELAY_MS),
        v1Delivered("backoff:delivery:2", 62_000),
        v1Claim("claim:backoff", 63_000),
        v1Acknowledge("ack:backoff", 64_000),
      ],
      before: [
        v1Signal(
          "delivery_failed",
          { permanent: false, reason: "mailbox not writable" },
          "backoff:delivery:1",
          1000
        ),
        v1Tick("tick:backoff:1", 30_000),
      ],
      final: { phase: "acknowledged", status: "completed" },
      inFlight: { phase: "retry-scheduled", status: "running" },
    }
  ),
  v1(
    identity,
    "v1-awaiting-claim",
    "delivered after one retry (retry_due); waiting for the recipient's claim",
    {
      after: [
        v1Claim("claim:awaiting", 70_000),
        v1Acknowledge("ack:awaiting", 71_000),
      ],
      before: [
        v1Signal(
          "delivery_failed",
          { permanent: false, reason: "mailbox not writable" },
          "awaiting:delivery:1",
          1000
        ),
        v1Signal("retry_due", {}, "retry:awaiting", 1000 + RETRY_DELAY_MS),
        v1Delivered("awaiting:delivery:2", 62_000),
      ],
      final: { phase: "acknowledged", status: "completed" },
      inFlight: { phase: "routed", status: "running" },
    }
  ),
  v1(
    identity,
    "v1-escalated",
    "delivered, unclaimed past its claim deadline: escalated by clock_tick, waiting for a claim",
    {
      after: [
        v1Claim("claim:escalated", CLAIM_TIMEOUT_MS + 60_000),
        v1Acknowledge("ack:escalated", CLAIM_TIMEOUT_MS + 61_000),
      ],
      before: [
        v1Delivered("escalated:delivery:1", 1000),
        v1Tick("tick:escalated:1", CLAIM_TIMEOUT_MS),
      ],
      final: { phase: "acknowledged", status: "completed" },
      inFlight: { phase: "escalated", status: "running" },
    }
  ),
  v1(
    identity,
    "v1-unclaimed-dead-lettered",
    "escalated and still unclaimed past the escalation deadline: dead-lettered by clock_tick, still a running Temporal execution",
    {
      after: [v1Claim("claim:unclaimed:after", 8_000_000, "invalid-state")],
      before: [
        v1Delivered("unclaimed:delivery:1", 1000),
        v1Tick("tick:unclaimed:1", CLAIM_TIMEOUT_MS),
        v1Tick("tick:unclaimed:2", CLAIM_TIMEOUT_MS + ESCALATION_TIMEOUT_MS),
      ],
      final: { phase: "dead-lettered", status: "failed" },
      inFlight: { phase: "dead-lettered", status: "failed" },
    }
  ),
  v1(
    identity,
    "v1-claimed-awaiting-ack",
    "claimed; waiting for the recipient's acknowledgement",
    {
      after: [v1Acknowledge("ack:claimed", 30_000)],
      before: [
        v1Delivered("claimed:delivery:1", 1000),
        v1Claim("claim:claimed", 2000),
      ],
      final: { phase: "acknowledged", status: "completed" },
      inFlight: { phase: "claimed", status: "running" },
    }
  ),
  v1(
    identity,
    "v1-acknowledged-open",
    "acknowledged: ended for the message, still a running Temporal execution",
    {
      after: [v1Acknowledge("ack:open:again", 10_000, "invalid-state")],
      before: [
        v1Delivered("open:delivery:1", 1000),
        v1Claim("claim:open", 2000),
        v1Acknowledge("ack:open", 3000),
      ],
      final: { phase: "acknowledged", status: "completed" },
      inFlight: { phase: "acknowledged", status: "completed" },
    }
  ),
  v1(
    identity,
    "v1-dead-lettered-open",
    "permanently failed: dead-lettered, still a running Temporal execution",
    {
      after: [v1Claim("claim:dead:after", 10_000, "invalid-state")],
      before: [
        v1Signal(
          "delivery_failed",
          { permanent: true, reason: "recipient rejected the message" },
          "dead:delivery:1",
          1000
        ),
      ],
      final: { phase: "dead-lettered", status: "failed" },
      inFlight: { phase: "dead-lettered", status: "failed" },
    }
  ),
  v1(
    identity,
    "v1-canceled-open",
    "delivered, then canceled: ended, still a running Temporal execution",
    {
      after: [
        v1Claim("claim:canceled:after", 10_000, "invalid-state"),
        // Canceling a canceled execution is answered, not refused.
        cancel("sender withdrew the message", "v1:cancel:canceled:2", 11_000),
      ],
      before: [
        v1Delivered("canceled:delivery:1", 1000),
        cancel("sender withdrew the message", "v1:cancel:canceled:1", 2000),
      ],
      final: { phase: "canceled", status: "canceled" },
      inFlight: { phase: "canceled", status: "canceled" },
    }
  ),
];

/** A run id's beat workflow id (governess-beat-workflow.ts). */
const beatWorkflowId = (runId: string): string => `governess-beat:${runId}`;

const hashOf = (digit: string): string => digit.repeat(64);

const NUDGE_KEY = "nudge:claude:1";
const NUDGE_CONTROL = "00000000-0000-4000-8000-000000000002";
const OBSERVE_CONTROL = "00000000-0000-4000-8000-000000000001";

/** A record the governess decided locally and writes through, whole. */
const beatRecord = (
  sequence: number,
  offsetMs: number,
  fields: JsonObject
): JsonObject => ({
  action: "nudge",
  agent: "claude",
  at: replayAt(offsetMs),
  controlId: NUDGE_CONTROL,
  epoch: 1,
  idempotencyKey: NUDGE_KEY,
  payloadHash: hashOf("e"),
  phase: "prepared",
  policyClass: "safe-automatic",
  sequence,
  ...fields,
});

const appendRecord = (
  record: JsonObject,
  requestId: string,
  offsetMs: number,
  expectError?: string
) =>
  signal(
    "append_record",
    { record },
    `beat:${requestId}`,
    offsetMs,
    expectError
  );

const RESTART_KEY = "restart:codex:1";
const RESTART_CONTROL = "00000000-0000-4000-8000-000000000012";

/** The governess beat runs a deployed build's governess writes through. */
const beatScenarios = (label: string): ReplayScenario[] => {
  const observation = beatRecord(1, 1000, {
    action: "observe-runtime",
    agent: "claude",
    controlId: OBSERVE_CONTROL,
    idempotencyKey: "obs:claude:1",
    observationStream: "pane:claude",
    payload: "pane idle, no diff",
    payloadHash: hashOf("1"),
    phase: "completed",
    policyClass: "observe",
    semanticHash: hashOf("2"),
  });
  const dispatched = beatRecord(3, 3000, {
    phase: "dispatched",
    transport: "claude-channel",
  });
  const writeThroughRun = `${label}.beat-control-dispatched`;
  const decidedRun = `${label}.beat-decided-in-workflow`;
  return [
    {
      after: [
        appendRecord(
          beatRecord(4, 10_000, {
            evidence: "channel ack",
            phase: "accepted",
            transport: "claude-channel",
          }),
          "4",
          10_000
        ),
        appendRecord(
          beatRecord(5, 11_000, {
            evidence: "channel ack",
            phase: "completed",
            transport: "claude-channel",
          }),
          "5",
          11_000
        ),
      ],
      before: [
        appendRecord(observation, "1", 1000),
        appendRecord(beatRecord(2, 2000, {}), "2", 2000),
        appendRecord(dispatched, "3", 3000),
        // A resend of a held record is a no-op; a different record at a
        // held sequence, or one past the next, is refused.
        appendRecord(dispatched, "3:resend", 4000),
        appendRecord(
          { ...dispatched, transport: "tmux-fallback" },
          "3:conflict",
          5000,
          "conflict"
        ),
        appendRecord(beatRecord(9, 6000, {}), "9:gap", 6000, "conflict"),
      ],
      description:
        "write-through: an observation and a nudge dispatched, waiting for its acceptance; a resend, a conflict and a gap refused",
      final: { status: "running" },
      inFlight: { status: "running" },
      name: "beat-control-dispatched",
      queries: beatQueries([NUDGE_KEY]),
      startAt: replayAt(0),
      startInput: { runId: writeThroughRun },
      startRequestId: `start:${writeThroughRun}`,
      workflowId: beatWorkflowId(writeThroughRun),
      workflowType: "governess-beat.v1",
    },
    {
      after: [
        signal(
          "transition_control",
          {
            at: replayAt(10_000),
            controlId: RESTART_CONTROL,
            details: {},
            phase: "failed",
            reason: "pane gone",
          },
          "beat:decide:fail",
          10_000
        ),
        // Dispatched before it failed: the idempotency fence stays closed
        // and the earlier control is reused, not a new one prepared.
        signal(
          "prepare_control",
          {
            action: "restart-agent",
            agent: "codex",
            at: replayAt(11_000),
            controlId: "00000000-0000-4000-8000-000000000013",
            epoch: 1,
            idempotencyKey: RESTART_KEY,
            payloadHash: hashOf("f"),
            policyClass: "require-confirmation",
          },
          "beat:decide:prepare:again",
          11_000
        ),
        signal(
          "transition_control",
          {
            at: replayAt(12_000),
            controlId: RESTART_CONTROL,
            details: {},
            phase: "completed",
          },
          "beat:decide:complete",
          12_000,
          "invalid-state"
        ),
      ],
      before: [
        signal(
          "record_observation",
          {
            agent: "codex",
            at: replayAt(1000),
            controlId: "00000000-0000-4000-8000-000000000011",
            epoch: 1,
            idempotencyKey: "obs:codex:1",
            payload: "pane waiting for confirmation",
            payloadHash: hashOf("3"),
            policyClass: "observe",
            semanticHash: hashOf("4"),
            stream: "pane:codex",
          },
          "beat:decide:observe",
          1000
        ),
        // The audit fence: a prompt body is refused at the boundary.
        signal(
          "prepare_control",
          {
            action: "nudge",
            at: replayAt(1500),
            controlId: "00000000-0000-4000-8000-000000000019",
            epoch: 1,
            idempotencyKey: "nudge:codex:body",
            payload: "a prompt body",
            payloadHash: hashOf("5"),
            policyClass: "safe-automatic",
          },
          "beat:decide:body",
          1500,
          "invalid-command"
        ),
        signal(
          "prepare_control",
          {
            action: "restart-agent",
            agent: "codex",
            at: replayAt(2000),
            controlId: RESTART_CONTROL,
            epoch: 1,
            idempotencyKey: RESTART_KEY,
            payloadHash: hashOf("f"),
            policyClass: "require-confirmation",
          },
          "beat:decide:prepare",
          2000
        ),
        signal(
          "transition_control",
          {
            at: replayAt(3000),
            controlId: RESTART_CONTROL,
            details: { transport: "tmux-fallback" },
            phase: "dispatched",
          },
          "beat:decide:dispatch",
          3000
        ),
      ],
      description:
        "gov-6 decisions in the workflow: an observation and a restart dispatched, waiting for its outcome; a prompt body refused",
      final: { status: "running" },
      inFlight: { status: "running" },
      name: "beat-decided-in-workflow",
      queries: beatQueries([RESTART_KEY, "nudge:codex:body"]),
      startAt: replayAt(0),
      startInput: { runId: decidedRun },
      startRequestId: `start:${decidedRun}`,
      workflowId: beatWorkflowId(decidedRun),
      workflowType: "governess-beat.v1",
    },
  ];
};

/** Every `deployed` scenario, named for one build's identity derivations. */
export const deployedReplayScenarios = (
  identity: DeployedReplayIdentity
): ReplayScenario[] => {
  const graphId = graphIdOf(identity.label);
  return [
    ...v1Scenarios(identity),
    ...beatScenarios(identity.label),
    // No result graph before the V2 line: a plain graph in its place.
    ...graphScenarios(graphId, graphId("graph-awaiting-result")),
  ];
};

/** The workflow port surface the driver uses (any build's port has it). */
export interface ReplayPort {
  cancel(command: {
    reason: string;
    requestId: string;
    workflowId: string;
  }): Promise<unknown>;
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
      if (command.kind === "cancel") {
        await port.cancel({
          reason: String(command.payload.reason),
          requestId: command.requestId,
          workflowId: scenario.workflowId,
        });
      } else {
        await port.signal({
          name: command.name,
          payload: command.payload,
          requestId: command.requestId,
          workflowId: scenario.workflowId,
        });
      }
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

/** A query's answer, or the message it failed with. */
export type ReplayQueryAnswer = { error: string } | { value: JsonValue };

export interface ReplaySnapshot {
  inspection: WorkflowInspection;
  outcomes: Record<string, unknown>;
  /** Every query of the scenario, by label. */
  queries: Record<string, ReplayQueryAnswer>;
}

/** The key the workflow stores a command's outcome under. */
export const replayCommandKey = (command: ReplayCommand): string =>
  `${command.kind}:${command.requestId}`;

/**
 * Everything the workflow answers about one execution: its inspection, every
 * query its callers send, and the stored outcome of every command sent so far.
 */
export const snapshotReplayScenario = (
  port: ReplayPort,
  outcome: ReplayOutcomeQuery,
  scenario: Pick<ReplayScenario, "queries" | "workflowId">,
  commands: readonly ReplayCommand[]
): Promise<ReplaySnapshot> =>
  snapshotReplayExecution(
    port,
    outcome,
    scenario,
    commands.map(replayCommandKey)
  );

/** The same snapshot, given the outcome keys (`kind:requestId`) to read. */
export const snapshotReplayExecution = async (
  port: ReplayPort,
  outcome: ReplayOutcomeQuery,
  scenario: Pick<ReplayScenario, "queries" | "workflowId">,
  commandKeys: readonly string[]
): Promise<ReplaySnapshot> => {
  const inspection = await port.inspect(scenario.workflowId);
  const queries: Record<string, ReplayQueryAnswer> = {};
  for (const query of scenario.queries) {
    try {
      const answer = await port.query({
        ...(query.args ? { args: query.args } : {}),
        name: query.name,
        workflowId: scenario.workflowId,
      });
      queries[query.label] = { value: answer.value };
    } catch (error) {
      queries[query.label] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const outcomes: Record<string, unknown> = {};
  for (const key of commandKeys) {
    outcomes[key] = await outcome(scenario.workflowId, key);
  }
  return { inspection, outcomes, queries };
};

/** The phase a message status projection reports, if it is one. */
export const phaseOf = (status: JsonValue | undefined): string | undefined =>
  typeof status === "object" &&
  status !== null &&
  !Array.isArray(status) &&
  typeof status.phase === "string"
    ? status.phase
    : undefined;

/** The phase in a snapshot's status answer, if the type has one. */
export const snapshotPhaseOf = (
  snapshot: ReplaySnapshot
): string | undefined => {
  const status = snapshot.queries.status;
  return status && "value" in status ? phaseOf(status.value) : undefined;
};

/** The V2 delivery ids a snapshot's delivery request names. */
const deliveryIdsOf = (snapshot: ReplaySnapshot): string[] => {
  const answer = snapshot.queries.delivery_request;
  const value = answer && "value" in answer ? answer.value : undefined;
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.deliveryId === "string"
    ? [value.deliveryId]
    : [];
};

/**
 * A snapshot with this run's names taken out (the execution's workflow id,
 * the V2 delivery id derived from it, and the run label in dedupe keys,
 * message ids and thread ids), so two executions of one scenario under
 * different names compare equal. A comparison of one execution with itself
 * needs none of this, and is exact.
 */
export const normalizeReplaySnapshot = (
  snapshot: ReplaySnapshot,
  scenario: Pick<ReplayScenario, "workflowId">,
  label: string
): unknown => {
  let text = JSON.stringify(snapshot);
  for (const deliveryId of deliveryIdsOf(snapshot)) {
    text = text.replaceAll(deliveryId, "<delivery-id>");
  }
  return JSON.parse(
    text
      .replaceAll(scenario.workflowId, "<workflow-id>")
      .replaceAll(label, "<label>")
  );
};
