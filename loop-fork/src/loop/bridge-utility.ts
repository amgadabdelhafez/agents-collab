import {
  appendDelegationEvent,
  hashDelegationFingerprint,
  makeDelegationEvent,
} from "./delegation-policy";
import {
  createUtilityRouteRequest,
  type UtilityAuthorityFlags,
  type UtilityCapability,
  type UtilityRequestKind,
  type UtilityRisk,
} from "./task-router";
import type { Agent } from "./types";
import { applyUtilityJobPatch } from "./utility-runtime";

type UtilityBridgeSource = Agent | "supervisor";

import { appendUtilityRouteRequest, readUtilityJob } from "./utility-store";

export const UTILITY_BRIDGE_TOOL_NAMES = [
  "route_task",
  "task_status",
  "get_task_result",
  "apply_task_patch",
] as const;
export type UtilityBridgeToolName = (typeof UTILITY_BRIDGE_TOOL_NAMES)[number];

export class UtilityBridgeInputError extends Error {}

const ROUTE_TASK_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};
const READ_ONLY_ANNOTATIONS = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: true,
};

export const UTILITY_BRIDGE_TOOLS = [
  {
    annotations: ROUTE_TASK_ANNOTATIONS,
    description:
      "Submit a small bounded task for Governess routing to Direct, Nanny, Au Pair, a peer, the driver, or human escalation.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        acceptance_criteria: { items: { type: "string" }, type: "array" },
        authority: {
          additionalProperties: false,
          properties: {
            credential_access: { type: "boolean" },
            dependency_change: { type: "boolean" },
            destructive: { type: "boolean" },
            migration: { type: "boolean" },
            product_decision: { type: "boolean" },
            release: { type: "boolean" },
            remote_mutation: { type: "boolean" },
          },
          type: "object",
        },
        context_refs: {
          items: { maxLength: 500, type: "string" },
          maxItems: 6,
          type: "array",
        },
        estimated_cost_usd: { minimum: 0, type: "number" },
        idempotency_key: { type: "string" },
        kind: {
          enum: ["inspect", "edit", "command", "review", "design", "authority"],
          type: "string",
        },
        objective: { minLength: 1, type: "string" },
        requester: {
          enum: ["claude", "codex", "gemini", "cursor", "copilot"],
          type: "string",
        },
        read_scope: { items: { type: "string" }, type: "array" },
        required_capabilities: {
          items: {
            enum: [
              "inspect",
              "bounded-command",
              "scoped-edit",
              "focused-verify",
            ],
            type: "string",
          },
          type: "array",
        },
        risk: { enum: ["low", "medium", "high", "unknown"], type: "string" },
        write_scope: { items: { type: "string" }, type: "array" },
      },
      required: ["objective", "kind", "acceptance_criteria"],
      type: "object",
    },
    name: "route_task",
  },
  {
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      "Read the Governess route and current state for a Nanny or Au Pair job.",
    inputSchema: {
      additionalProperties: false,
      properties: { task_id: { minLength: 1, type: "string" } },
      required: ["task_id"],
      type: "object",
    },
    name: "task_status",
  },
  {
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      "Read the compact result and artifact references for a completed Nanny or Au Pair job.",
    inputSchema: {
      additionalProperties: false,
      properties: { task_id: { minLength: 1, type: "string" } },
      required: ["task_id"],
      type: "object",
    },
    name: "get_task_result",
  },
  {
    annotations: ROUTE_TASK_ANNOTATIONS,
    description:
      "Apply one completed Au Pair edit after revalidating its patch hash, scope, and byte preimages; full agents only.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        expected_patch_sha256: {
          minLength: 64,
          maxLength: 64,
          pattern: "^[0-9a-fA-F]{64}$",
          type: "string",
        },
        task_id: { minLength: 1, type: "string" },
      },
      required: ["task_id", "expected_patch_sha256"],
      type: "object",
    },
    name: "apply_task_patch",
  },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new UtilityBridgeInputError(`${key} must be a non-empty string`);
  }
  return value.trim();
};

const stringArray = (args: Record<string, unknown>, key: string): string[] => {
  const value = args[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UtilityBridgeInputError(`${key} must be a string array`);
  }
  return value as string[];
};

const requestKind = (value: unknown): UtilityRequestKind => {
  if (
    value === "inspect" ||
    value === "edit" ||
    value === "command" ||
    value === "review" ||
    value === "design" ||
    value === "authority"
  ) {
    return value;
  }
  throw new UtilityBridgeInputError("kind is invalid");
};

const requestRisk = (value: unknown): UtilityRisk => {
  if (value === undefined) {
    return "low";
  }
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new UtilityBridgeInputError("risk is invalid");
};

const defaultCapabilities = (kind: UtilityRequestKind): UtilityCapability[] => {
  if (kind === "inspect") {
    return ["inspect"];
  }
  if (kind === "edit") {
    return ["inspect", "scoped-edit"];
  }
  if (kind === "command") {
    return ["bounded-command"];
  }
  return [];
};

const capabilities = (
  args: Record<string, unknown>,
  kind: UtilityRequestKind
): UtilityCapability[] => {
  const values = stringArray(args, "required_capabilities");
  const valid = new Set<UtilityCapability>([
    "inspect",
    "bounded-command",
    "scoped-edit",
    "focused-verify",
  ]);
  if (values.some((value) => !valid.has(value as UtilityCapability))) {
    throw new UtilityBridgeInputError(
      "required_capabilities contains an invalid capability"
    );
  }
  return values.length > 0
    ? (values as UtilityCapability[])
    : defaultCapabilities(kind);
};

const authorityFlags = (value: unknown): UtilityAuthorityFlags => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new UtilityBridgeInputError("authority must be an object");
  }
  const boolean = (key: string): boolean | undefined => {
    const item = value[key];
    if (item === undefined) {
      return undefined;
    }
    if (typeof item !== "boolean") {
      throw new UtilityBridgeInputError(`authority.${key} must be boolean`);
    }
    return item;
  };
  return {
    credentialAccess: boolean("credential_access"),
    dependencyChange: boolean("dependency_change"),
    destructive: boolean("destructive"),
    migration: boolean("migration"),
    productDecision: boolean("product_decision"),
    release: boolean("release"),
    remoteMutation: boolean("remote_mutation"),
  };
};

const taskId = (args: Record<string, unknown>): string =>
  requiredString(args, "task_id");

const routeTask = (
  runDir: string,
  source: UtilityBridgeSource,
  args: Record<string, unknown>
): { state: string; taskId: string } => {
  const kind = requestKind(args.kind);
  const estimatedCostUsd = args.estimated_cost_usd;
  if (
    estimatedCostUsd !== undefined &&
    (typeof estimatedCostUsd !== "number" ||
      !Number.isFinite(estimatedCostUsd) ||
      estimatedCostUsd < 0)
  ) {
    throw new UtilityBridgeInputError(
      "estimated_cost_usd must be non-negative"
    );
  }
  const delegatedRequester = args.requester;
  const requester =
    source === "supervisor" &&
    (delegatedRequester === "claude" ||
      delegatedRequester === "codex" ||
      delegatedRequester === "gemini" ||
      delegatedRequester === "cursor" ||
      delegatedRequester === "copilot")
      ? delegatedRequester
      : source;
  if (requester === "supervisor") {
    throw new UtilityBridgeInputError(
      "supervisor route_task requires a requester result target"
    );
  }
  if (
    source !== "supervisor" &&
    delegatedRequester !== undefined &&
    delegatedRequester !== source
  ) {
    throw new UtilityBridgeInputError(
      "main agents cannot override the route_task requester"
    );
  }
  const request = createUtilityRouteRequest({
    acceptanceCriteria: stringArray(args, "acceptance_criteria"),
    authority: authorityFlags(args.authority),
    contextRefs: stringArray(args, "context_refs"),
    ...(typeof estimatedCostUsd === "number" ? { estimatedCostUsd } : {}),
    ...(typeof args.idempotency_key === "string"
      ? { idempotencyKey: hashDelegationFingerprint(args.idempotency_key) }
      : {}),
    kind,
    objective: requiredString(args, "objective"),
    readScope: stringArray(args, "read_scope"),
    requester,
    requiredCapabilities: capabilities(args, kind),
    risk: requestRisk(args.risk),
    writeScope: stringArray(args, "write_scope"),
  });
  const job = appendUtilityRouteRequest(runDir, request);
  appendDelegationEvent(
    runDir,
    makeDelegationEvent({
      agent: requester,
      disposition: "explicit-routed",
      fingerprint: hashDelegationFingerprint(request.idempotencyKey),
      operation: request.kind,
      reason: source === "supervisor" ? "supervisor-route-task" : "route-task",
      source: "bridge",
      taskId: job.jobId,
    })
  );
  return { state: job.state, taskId: job.jobId };
};

export const callUtilityBridgeTool = async (
  name: UtilityBridgeToolName,
  runDir: string,
  source: UtilityBridgeSource,
  args: Record<string, unknown>
): Promise<unknown> => {
  if (name === "route_task") {
    return routeTask(runDir, source, args);
  }
  if (name === "apply_task_patch") {
    if (source === "supervisor") {
      throw new UtilityBridgeInputError(
        "apply_task_patch is restricted to a full in-loop agent"
      );
    }
    try {
      return await applyUtilityJobPatch(
        runDir,
        taskId(args),
        requiredString(args, "expected_patch_sha256"),
        source
      );
    } catch (error) {
      throw new UtilityBridgeInputError(
        error instanceof Error ? error.message : "guarded patch apply failed"
      );
    }
  }
  const job = readUtilityJob(runDir, taskId(args));
  if (!job) {
    throw new UtilityBridgeInputError("unknown Nanny or Au Pair task_id");
  }
  if (name === "task_status") {
    return {
      decision: job.decision,
      application: job.application,
      state: job.state,
      taskId: job.jobId,
      updatedAt: job.updatedAt,
    };
  }
  return {
    application: job.application,
    result: job.result,
    state: job.state,
    taskId: job.jobId,
  };
};

export const isUtilityBridgeToolName = (
  value: unknown
): value is UtilityBridgeToolName =>
  typeof value === "string" &&
  UTILITY_BRIDGE_TOOL_NAMES.includes(value as UtilityBridgeToolName);
