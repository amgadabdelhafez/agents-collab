import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import type { JsonObject } from "./workflow-port";

const GRAPH_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const TASK_ID_RE = GRAPH_ID_RE;
const REPOSITORY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/;
const SCOPE_RE =
  /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*$/;
const ARTIFACT_RE = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const CHECK_KINDS = new Set([
  "artifact",
  "authority",
  "review",
  "runtime-proof",
  "test",
]);
const MAX_TASKS = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has invalid fields`);
  }
};

const string = (value: unknown, pattern: RegExp, label: string): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const strings = (value: unknown, pattern: RegExp, label: string): string[] => {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${label} has invalid bounds`);
  }
  const result = value.map((entry) => string(entry, pattern, label));
  if (
    result.some(
      (entry, index) => index > 0 && (result[index - 1] ?? "") >= entry
    )
  ) {
    throw new Error(`${label} must be sorted and unique`);
  }
  return result;
};

const node = (value: unknown): JsonObject => {
  if (!isRecord(value)) {
    throw new Error("Harness task graph node is invalid");
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
    "Harness task graph node"
  );
  const taskId = string(value.taskId, TASK_ID_RE, "taskId");
  if (!Array.isArray(value.acceptanceChecks)) {
    throw new Error(`task ${taskId} acceptanceChecks is invalid`);
  }
  const acceptanceChecks = value.acceptanceChecks.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error(`task ${taskId} acceptance check is invalid`);
    }
    exactKeys(entry, ["checkId", "kind"], "acceptance check");
    const kind = string(entry.kind, TASK_ID_RE, "acceptance kind");
    if (!CHECK_KINDS.has(kind)) {
      throw new Error(`task ${taskId} acceptance kind is invalid`);
    }
    return {
      checkId: string(entry.checkId, TASK_ID_RE, "acceptance checkId"),
      kind,
    };
  });
  acceptanceChecks.sort((left, right) =>
    left.checkId.localeCompare(right.checkId)
  );
  if (
    acceptanceChecks.length === 0 ||
    new Set(acceptanceChecks.map(({ checkId }) => checkId)).size !==
      acceptanceChecks.length
  ) {
    throw new Error(`task ${taskId} acceptance checks are invalid`);
  }
  return {
    acceptanceChecks,
    authorityGates: strings(
      value.authorityGates,
      TASK_ID_RE,
      `task ${taskId} authorityGates`
    ),
    dependencies: strings(
      value.dependencies,
      TASK_ID_RE,
      `task ${taskId} dependencies`
    ),
    ownerRepository: string(
      value.ownerRepository,
      REPOSITORY_RE,
      `task ${taskId} ownerRepository`
    ),
    readScopes: strings(
      value.readScopes,
      SCOPE_RE,
      `task ${taskId} readScopes`
    ),
    specArtifactRef: string(
      value.specArtifactRef,
      ARTIFACT_RE,
      `task ${taskId} specArtifactRef`
    ),
    taskId,
    writeScopes: strings(
      value.writeScopes,
      SCOPE_RE,
      `task ${taskId} writeScopes`
    ),
  };
};

export const parseHarnessTaskGraph = (value: unknown): JsonObject => {
  if (!isRecord(value)) {
    throw new Error("Harness task graph must be an object");
  }
  exactKeys(value, ["graphId", "nodes", "schema"], "Harness task graph");
  if (value.schema !== "harness-task-graph.v1") {
    throw new Error("Harness task graph schema is invalid");
  }
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length === 0 ||
    value.nodes.length > MAX_TASKS
  ) {
    throw new Error("Harness task graph nodes have invalid bounds");
  }
  const nodes = value.nodes
    .map(node)
    .sort((left, right) =>
      String(left.taskId).localeCompare(String(right.taskId))
    );
  if (new Set(nodes.map(({ taskId }) => taskId)).size !== nodes.length) {
    throw new Error("Harness task graph task IDs must be unique");
  }
  return {
    graphId: string(value.graphId, GRAPH_ID_RE, "graphId"),
    nodes,
    schema: "task-graph.v1",
  };
};

export const readHarnessTaskGraph = (path: string): JsonObject => {
  let descriptor: number | undefined;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("Harness task graph path is not a file");
    }
    return parseHarnessTaskGraph(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};
