import { alg, Graph } from "@dagrejs/graphlib";
import {
  type JsonObject,
  type JsonValue,
  type WorkflowDefinition,
  WorkflowError,
  type WorkflowExecutionStatus,
} from "./workflow-port";

export const TASK_GRAPH_WORKFLOW_TYPE = "task-graph.v1";

const MAX_NODES = 128;
const MAX_PER_NODE = 32;
const STABLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const REPOSITORY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/;
const ARTIFACT_REF_RE = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const SAFE_SCOPE_RE =
  /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*$/;
const ACCEPTANCE_KINDS = new Set([
  "artifact",
  "authority",
  "review",
  "runtime-proof",
  "test",
]);

type TaskPhase =
  | "pending"
  | "ready"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled";

interface AcceptanceCheck extends JsonObject {
  checkId: string;
  kind: string;
}

interface AcceptanceReceipt extends JsonObject {
  artifactRef: string;
  checkId: string;
}

interface TaskNodeSpec extends JsonObject {
  acceptanceChecks: AcceptanceCheck[];
  authorityGates: string[];
  dependencies: string[];
  ownerRepository: string;
  readScopes: string[];
  specArtifactRef: string;
  taskId: string;
  writeScopes: string[];
}

interface TaskNodeState extends JsonObject {
  acceptanceReceipts: AcceptanceReceipt[];
  authorityReceipts: Record<string, string>;
  blockedBy: string[];
  claimedAt: null | string;
  completedAt: null | string;
  failureCode: null | string;
  phase: TaskPhase;
  spec: TaskNodeSpec;
  startedAt: null | string;
  workerId: null | string;
}

interface TaskGraphState extends JsonObject {
  canceledAt: null | string;
  graphId: string;
  nodes: Record<string, TaskNodeState>;
  schema: "task-graph-state.v1";
}

interface ParsedGraph {
  graph: Graph;
  graphId: string;
  nodes: TaskNodeSpec[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void => {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new WorkflowError("invalid-command", `${label} has invalid fields`);
  }
};

const requireString = (
  record: Record<string, unknown>,
  field: string,
  pattern: RegExp,
  label: string
): string => {
  const value = record[field];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new WorkflowError("invalid-command", `${label} ${field} is invalid`);
  }
  return value;
};

const requireSortedStrings = (
  value: unknown,
  label: string,
  pattern: RegExp,
  allowEmpty = true
): string[] => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PER_NODE ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new WorkflowError("invalid-command", `${label} has invalid bounds`);
  }
  const items = value.map((item) => {
    if (typeof item !== "string" || !pattern.test(item)) {
      throw new WorkflowError(
        "invalid-command",
        `${label} contains an invalid value`
      );
    }
    return item;
  });
  if (
    items.some((item, index) => index > 0 && (items[index - 1] ?? "") >= item)
  ) {
    throw new WorkflowError(
      "invalid-command",
      `${label} must be sorted and unique`
    );
  }
  return items;
};

const requireScopes = (value: unknown, label: string): string[] => {
  const scopes = requireSortedStrings(value, label, SAFE_SCOPE_RE);
  if (
    scopes.some((scope) =>
      scope.split("/").some((part) => part === "." || part === "..")
    )
  ) {
    throw new WorkflowError(
      "invalid-command",
      `${label} contains an unsafe path`
    );
  }
  return scopes;
};

const requireChecks = (value: unknown, taskId: string): AcceptanceCheck[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PER_NODE
  ) {
    throw new WorkflowError(
      "invalid-command",
      `task ${taskId} acceptanceChecks has invalid bounds`
    );
  }
  const checks = value.map((entry) => {
    if (!isRecord(entry)) {
      throw new WorkflowError(
        "invalid-command",
        `task ${taskId} acceptance check is invalid`
      );
    }
    exactKeys(entry, ["checkId", "kind"], `task ${taskId} acceptance check`);
    const checkId = requireString(
      entry,
      "checkId",
      STABLE_ID_RE,
      `task ${taskId}`
    );
    const kind = requireString(entry, "kind", STABLE_ID_RE, `task ${taskId}`);
    if (!ACCEPTANCE_KINDS.has(kind)) {
      throw new WorkflowError(
        "invalid-command",
        `task ${taskId} acceptance kind is invalid`
      );
    }
    return { checkId, kind };
  });
  if (
    checks.some(
      (check, index) =>
        index > 0 && (checks[index - 1]?.checkId ?? "") >= check.checkId
    )
  ) {
    throw new WorkflowError(
      "invalid-command",
      `task ${taskId} acceptanceChecks must be sorted and unique`
    );
  }
  return checks;
};

const requireNode = (value: unknown): TaskNodeSpec => {
  if (!isRecord(value)) {
    throw new WorkflowError("invalid-command", "task graph node is invalid");
  }
  exactKeys(
    value,
    [
      "acceptanceChecks",
      "authorityGates",
      "dependencies",
      "ownerRepository",
      "readScopes",
      "specArtifactRef",
      "taskId",
      "writeScopes",
    ],
    "task graph node"
  );
  const taskId = requireString(
    value,
    "taskId",
    STABLE_ID_RE,
    "task graph node"
  );
  return {
    acceptanceChecks: requireChecks(value.acceptanceChecks, taskId),
    authorityGates: requireSortedStrings(
      value.authorityGates,
      `task ${taskId} authorityGates`,
      STABLE_ID_RE
    ),
    dependencies: requireSortedStrings(
      value.dependencies,
      `task ${taskId} dependencies`,
      STABLE_ID_RE
    ),
    ownerRepository: requireString(
      value,
      "ownerRepository",
      REPOSITORY_RE,
      `task ${taskId}`
    ),
    readScopes: requireScopes(value.readScopes, `task ${taskId} readScopes`),
    specArtifactRef: requireString(
      value,
      "specArtifactRef",
      ARTIFACT_REF_RE,
      `task ${taskId}`
    ),
    taskId,
    writeScopes: requireScopes(value.writeScopes, `task ${taskId} writeScopes`),
  };
};

const scopeOverlaps = (left: string, right: string): boolean =>
  left === right ||
  left.startsWith(`${right}/`) ||
  right.startsWith(`${left}/`);

const hasPath = (graph: Graph, from: string, to: string): boolean =>
  Number.isFinite(alg.dijkstra(graph, from)[to]?.distance);

const buildGraph = (nodes: readonly TaskNodeSpec[]): Graph => {
  const graph = new Graph({ directed: true });
  for (const node of nodes) {
    graph.setNode(node.taskId);
  }
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (dependency === node.taskId || !graph.hasNode(dependency)) {
        throw new WorkflowError(
          "invalid-command",
          `task ${node.taskId} has an invalid dependency`
        );
      }
      graph.setEdge(dependency, node.taskId);
    }
  }
  if (!alg.isAcyclic(graph)) {
    throw new WorkflowError(
      "invalid-command",
      "task graph contains a dependency cycle"
    );
  }
  return graph;
};

const requireGraph = (input: JsonObject): ParsedGraph => {
  exactKeys(input, ["graphId", "nodes", "schema"], "task graph");
  if (input.schema !== TASK_GRAPH_WORKFLOW_TYPE) {
    throw new WorkflowError("invalid-command", "task graph schema is invalid");
  }
  const graphId = requireString(input, "graphId", STABLE_ID_RE, "task graph");
  if (
    !Array.isArray(input.nodes) ||
    input.nodes.length === 0 ||
    input.nodes.length > MAX_NODES
  ) {
    throw new WorkflowError(
      "invalid-command",
      "task graph nodes has invalid bounds"
    );
  }
  const nodes = input.nodes.map(requireNode);
  if (
    nodes.some(
      (node, index) =>
        index > 0 && (nodes[index - 1]?.taskId ?? "") >= node.taskId
    )
  ) {
    throw new WorkflowError(
      "invalid-command",
      "task graph nodes must be sorted and unique"
    );
  }
  const graph = buildGraph(nodes);
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (!left) {
      continue;
    }
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < nodes.length;
      rightIndex += 1
    ) {
      const right = nodes[rightIndex];
      if (!right) {
        continue;
      }
      const overlaps =
        left.ownerRepository === right.ownerRepository &&
        left.writeScopes.some((leftScope) =>
          right.writeScopes.some((rightScope) =>
            scopeOverlaps(leftScope, rightScope)
          )
        );
      if (
        overlaps &&
        !hasPath(graph, left.taskId, right.taskId) &&
        !hasPath(graph, right.taskId, left.taskId)
      ) {
        throw new WorkflowError(
          "invalid-command",
          `tasks ${left.taskId} and ${right.taskId} have unordered overlapping write scopes`
        );
      }
    }
  }
  return { graph, graphId, nodes };
};

const asState = (value: JsonObject): TaskGraphState => value as TaskGraphState;

const isTerminal = (phase: TaskPhase): boolean =>
  phase === "blocked" ||
  phase === "canceled" ||
  phase === "failed" ||
  phase === "succeeded";

const blockersFor = (state: TaskGraphState, node: TaskNodeState): string[] =>
  [
    ...node.spec.dependencies
      .filter((taskId) => state.nodes[taskId]?.phase !== "succeeded")
      .map(
        (taskId) =>
          `dependency:${taskId}:${state.nodes[taskId]?.phase ?? "unknown"}`
      ),
    ...node.spec.authorityGates
      .filter((gateId) => !(gateId in node.authorityReceipts))
      .map((gateId) => `authority:${gateId}`),
  ].sort();

const refreshReadiness = (state: TaskGraphState): TaskGraphState => {
  const nodes = { ...state.nodes };
  const next = { ...state, nodes };
  for (const taskId of Object.keys(nodes).sort()) {
    const node = nodes[taskId];
    if (!node || (node.phase !== "pending" && node.phase !== "ready")) {
      continue;
    }
    const blockedBy = blockersFor(next, node);
    nodes[taskId] = {
      ...node,
      blockedBy,
      phase: blockedBy.length === 0 ? "ready" : "pending",
    };
  }
  return next;
};

const projectionOf = (state: TaskGraphState): JsonObject => ({
  graphId: state.graphId,
  nodes: Object.keys(state.nodes)
    .sort()
    .map((taskId) => {
      const node = state.nodes[taskId];
      if (!node) {
        throw new WorkflowError("invalid-state", `task ${taskId} is missing`);
      }
      return {
        acceptanceReceipts: node.acceptanceReceipts,
        authorityReceipts: node.authorityReceipts,
        blockedBy: node.blockedBy,
        failureCode: node.failureCode,
        phase: node.phase,
        taskId,
        workerId: node.workerId,
      };
    }),
  readyTaskIds: Object.keys(state.nodes)
    .filter((taskId) => state.nodes[taskId]?.phase === "ready")
    .sort(),
  schema: "task-graph-projection.v1",
});

const requireTask = (
  state: TaskGraphState,
  payload: JsonObject
): TaskNodeState => {
  const taskId = requireString(payload, "taskId", STABLE_ID_RE, "task command");
  const node = state.nodes[taskId];
  if (!node) {
    throw new WorkflowError("invalid-command", `unknown task ${taskId}`);
  }
  return node;
};

const graphStatus = (state: TaskGraphState): WorkflowExecutionStatus => {
  const phases = Object.values(state.nodes).map((node) => node.phase);
  if (phases.some((phase) => !isTerminal(phase))) {
    return "running";
  }
  return phases.every((phase) => phase === "succeeded")
    ? "completed"
    : "failed";
};

const graphFromState = (state: TaskGraphState): Graph =>
  buildGraph(Object.values(state.nodes).map((node) => node.spec));

const blockDescendants = (
  state: TaskGraphState,
  failedTaskId: string
): TaskGraphState => {
  const graph = graphFromState(state);
  const reachable = alg.dijkstra(graph, failedTaskId);
  const nodes = { ...state.nodes };
  for (const taskId of Object.keys(nodes)) {
    const node = nodes[taskId];
    if (
      node &&
      taskId !== failedTaskId &&
      Number.isFinite(reachable[taskId]?.distance) &&
      !isTerminal(node.phase)
    ) {
      nodes[taskId] = {
        ...node,
        blockedBy: [`failed:${failedTaskId}`],
        phase: "blocked",
      };
    }
  }
  return refreshReadiness({ ...state, nodes });
};

export const taskGraphWorkflowDefinition: WorkflowDefinition = {
  cancel(stateValue, _reason, context) {
    const state = asState(stateValue);
    const nodes = Object.fromEntries(
      Object.entries(state.nodes).map(([taskId, node]) => [
        taskId,
        isTerminal(node.phase) ? node : { ...node, phase: "canceled" },
      ])
    ) as Record<string, TaskNodeState>;
    const next: TaskGraphState = {
      ...state,
      canceledAt: context.at,
      nodes,
    };
    return {
      result: projectionOf(next),
      state: next,
      status: "canceled",
    };
  },

  query(stateValue, name): JsonValue {
    const state = asState(stateValue);
    if (name === "status") {
      return projectionOf(state);
    }
    if (name === "ready") {
      return Object.keys(state.nodes)
        .filter((taskId) => state.nodes[taskId]?.phase === "ready")
        .sort();
    }
    throw new WorkflowError(
      "unknown-query",
      `unknown task graph query ${name}`
    );
  },

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch is one closed task lifecycle transition
  signal(stateValue, name, payload, context) {
    const state = asState(stateValue);
    const node = requireTask(state, payload);
    const taskId = node.spec.taskId;
    if (name === "satisfy_gate") {
      exactKeys(payload, ["artifactRef", "gateId", "taskId"], name);
      if (node.phase !== "pending" && node.phase !== "ready") {
        throw new WorkflowError(
          "invalid-state",
          `task ${taskId} cannot accept a gate receipt`
        );
      }
      const gateId = requireString(payload, "gateId", STABLE_ID_RE, name);
      const artifactRef = requireString(
        payload,
        "artifactRef",
        ARTIFACT_REF_RE,
        name
      );
      if (!node.spec.authorityGates.includes(gateId)) {
        throw new WorkflowError(
          "invalid-command",
          `task ${taskId} does not declare gate ${gateId}`
        );
      }
      const existing = node.authorityReceipts[gateId];
      if (existing && existing !== artifactRef) {
        throw new WorkflowError(
          "conflict",
          `gate ${gateId} already has a different receipt`
        );
      }
      if (existing) {
        return {
          changed: false,
          result: projectionOf(state),
          state,
        };
      }
      const next = refreshReadiness({
        ...state,
        nodes: {
          ...state.nodes,
          [taskId]: {
            ...node,
            authorityReceipts: {
              ...node.authorityReceipts,
              [gateId]: artifactRef,
            },
          },
        },
      });
      return { result: projectionOf(next), state: next };
    }
    if (name === "claim") {
      exactKeys(payload, ["taskId", "workerId"], name);
      if (node.phase !== "ready") {
        throw new WorkflowError("invalid-state", `task ${taskId} is not ready`);
      }
      const workerId = requireString(payload, "workerId", STABLE_ID_RE, name);
      const next: TaskGraphState = {
        ...state,
        nodes: {
          ...state.nodes,
          [taskId]: {
            ...node,
            claimedAt: context.at,
            phase: "claimed",
            workerId,
          },
        },
      };
      return { result: projectionOf(next), state: next };
    }
    if (name === "start") {
      exactKeys(payload, ["taskId", "workerId"], name);
      const workerId = requireString(payload, "workerId", STABLE_ID_RE, name);
      if (node.phase !== "claimed" || node.workerId !== workerId) {
        throw new WorkflowError(
          "invalid-state",
          `task ${taskId} is not claimed by this worker`
        );
      }
      const next: TaskGraphState = {
        ...state,
        nodes: {
          ...state.nodes,
          [taskId]: {
            ...node,
            phase: "running",
            startedAt: context.at,
          },
        },
      };
      return { result: projectionOf(next), state: next };
    }
    if (name === "complete") {
      exactKeys(payload, ["receipts", "taskId", "workerId"], name);
      const workerId = requireString(payload, "workerId", STABLE_ID_RE, name);
      if (node.phase !== "running" || node.workerId !== workerId) {
        throw new WorkflowError(
          "invalid-state",
          `task ${taskId} is not running for this worker`
        );
      }
      if (
        !Array.isArray(payload.receipts) ||
        payload.receipts.length !== node.spec.acceptanceChecks.length
      ) {
        throw new WorkflowError(
          "invalid-command",
          `task ${taskId} requires the exact acceptance receipt set`
        );
      }
      const receipts = payload.receipts.map((entry) => {
        if (!isRecord(entry)) {
          throw new WorkflowError(
            "invalid-command",
            "acceptance receipt is invalid"
          );
        }
        exactKeys(entry, ["artifactRef", "checkId"], "acceptance receipt");
        return {
          artifactRef: requireString(
            entry,
            "artifactRef",
            ARTIFACT_REF_RE,
            "acceptance receipt"
          ),
          checkId: requireString(
            entry,
            "checkId",
            STABLE_ID_RE,
            "acceptance receipt"
          ),
        };
      });
      const expected = node.spec.acceptanceChecks.map((check) => check.checkId);
      if (
        receipts.some((receipt, index) => receipt.checkId !== expected[index])
      ) {
        throw new WorkflowError(
          "invalid-command",
          `task ${taskId} requires sorted exact acceptance receipts`
        );
      }
      const next = refreshReadiness({
        ...state,
        nodes: {
          ...state.nodes,
          [taskId]: {
            ...node,
            acceptanceReceipts: receipts,
            completedAt: context.at,
            phase: "succeeded",
          },
        },
      });
      return {
        result: projectionOf(next),
        state: next,
        status: graphStatus(next),
      };
    }
    if (name === "fail") {
      exactKeys(payload, ["failureCode", "taskId", "workerId"], name);
      const workerId = requireString(payload, "workerId", STABLE_ID_RE, name);
      const failureCode = requireString(
        payload,
        "failureCode",
        STABLE_ID_RE,
        name
      );
      if (
        (node.phase !== "claimed" && node.phase !== "running") ||
        node.workerId !== workerId
      ) {
        throw new WorkflowError(
          "invalid-state",
          `task ${taskId} is not owned by this worker`
        );
      }
      const next = blockDescendants(
        {
          ...state,
          nodes: {
            ...state.nodes,
            [taskId]: {
              ...node,
              completedAt: context.at,
              failureCode,
              phase: "failed",
            },
          },
        },
        taskId
      );
      return {
        result: projectionOf(next),
        state: next,
        status: graphStatus(next),
      };
    }
    throw new WorkflowError(
      "unknown-signal",
      `unknown task graph signal ${name}`
    );
  },

  start(input) {
    const parsed = requireGraph(input);
    const state = refreshReadiness({
      canceledAt: null,
      graphId: parsed.graphId,
      nodes: Object.fromEntries(
        parsed.nodes.map((spec) => [
          spec.taskId,
          {
            acceptanceReceipts: [],
            authorityReceipts: {},
            blockedBy: [],
            claimedAt: null,
            completedAt: null,
            failureCode: null,
            phase: "pending",
            spec,
            startedAt: null,
            workerId: null,
          },
        ])
      ) as Record<string, TaskNodeState>,
      schema: "task-graph-state.v1",
    });
    return { result: projectionOf(state), state };
  },

  type: TASK_GRAPH_WORKFLOW_TYPE,
};
