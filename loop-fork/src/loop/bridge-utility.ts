import { consumeBridgeInbox } from "./bridge-dispatch";
import { isBridgeDeliveryClaimed } from "./bridge-runtime";
import {
  appendDelegationEvent,
  hashDelegationFingerprint,
  makeDelegationEvent,
} from "./delegation-policy";
import {
  createUtilityRouteRequest,
  MAX_UTILITY_CONTEXT_REFS,
  type UtilityAuthorityFlags,
  type UtilityCapability,
  type UtilityExecutionProfile,
  type UtilityGitInspectionRequest,
  type UtilityOutputRequest,
  type UtilityReadPlanStep,
  type UtilityReadRequest,
  type UtilityRequestKind,
  type UtilityRisk,
  type UtilityRouteRequest,
  utilityRequestIsBounded,
} from "./task-router";
import type { Agent } from "./types";
import {
  isUtilityContextRefPath,
  normalizeUtilityPolicyPath,
} from "./utility-path-policy";
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

const EXECUTION_PROFILE_VALUES = [
  "file-list",
  "file-read",
  "focused-check",
  "git-diff",
  "git-inspect",
  "git-status",
  "read-plan",
  "search",
] as const;
const READ_PLAN_PROFILE_VALUES = EXECUTION_PROFILE_VALUES.filter(
  (profile) => profile !== "read-plan"
);
const STRING_ARRAY_SCHEMA = {
  items: { minLength: 1, type: "string" },
  type: "array",
} as const;
const EXECUTION_READ_SCHEMA = {
  additionalProperties: false,
  properties: {
    end_line: { minimum: 1, type: "integer" },
    last_lines: { maximum: 500, minimum: 1, type: "integer" },
    path: { minLength: 1, type: "string" },
    start_line: { minimum: 1, type: "integer" },
  },
  required: ["path"],
  type: "object",
} as const;
const EXECUTION_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    exclude_lines: { ...STRING_ARRAY_SCHEMA, maxItems: 16 },
    include_lines: { ...STRING_ARRAY_SCHEMA, maxItems: 16 },
    line_limit: { maximum: 500, minimum: 1, type: "integer" },
    position: { enum: ["head", "tail"], type: "string" },
    stderr: { enum: ["merge", "omit"], type: "string" },
    strip_ansi: { type: "boolean" },
  },
  type: "object",
} as const;
const EXECUTION_GIT_SCHEMA = {
  additionalProperties: false,
  properties: {
    action: {
      enum: [
        "branch-list",
        "current-branch",
        "log",
        "object-type",
        "resolve-ref",
        "show-stat",
        "worktree-list",
      ],
      type: "string",
    },
    include_metadata: { type: "boolean" },
    limit: { maximum: 50, minimum: 1, type: "integer" },
    pattern: { minLength: 1, type: "string" },
    ref: { minLength: 1, type: "string" },
  },
  required: ["action"],
  type: "object",
} as const;
const READ_PLAN_STEP_SCHEMA = {
  additionalProperties: false,
  properties: {
    execution_argv: STRING_ARRAY_SCHEMA,
    execution_cwd: { minLength: 1, type: "string" },
    execution_git: EXECUTION_GIT_SCHEMA,
    execution_output: EXECUTION_OUTPUT_SCHEMA,
    execution_profile: {
      enum: READ_PLAN_PROFILE_VALUES,
      type: "string",
    },
    execution_read: EXECUTION_READ_SCHEMA,
    objective: { minLength: 1, type: "string" },
    read_scope: { ...STRING_ARRAY_SCHEMA, maxItems: 4, minItems: 1 },
  },
  required: ["execution_profile", "objective", "read_scope"],
  type: "object",
} as const;

export const UTILITY_BRIDGE_TOOLS = [
  {
    annotations: ROUTE_TASK_ANNOTATIONS,
    description:
      "Submit an independent bounded work packet. Start concrete work by submitting one to three packets early, then keep safe lower-tier work in flight while you continue the critical path. Nanny handles small inspection/extraction/synthesis; Au Pair handles bounded multi-step work, small scoped edits, and focused checks; Direct handles exact work. Specify exact scopes, risk, capabilities, authority, and acceptance, never a tier: Governess chooses. context_refs is optional and accepts only repo-relative README.md, docs/**/*.md, or specs/<feature>/{spec,plan,tasks,verify}.md paths; put narrative facts and SHAs in objective or acceptance_criteria. Split independently answerable inspections into packets of at most two read scopes when practical, but keep cross-file judgment together and never falsify risk. Workers never widen scope: when locating a moved path, read_scope must name the narrowest common ancestor that can contain every acceptable candidate. Use execution_profile/execution_plan for exact reads, searches, Git inspection, or focused checks. Every terminal outcome returns to this requester unless the route explicitly requires peer review. The response also drains older unclaimed helper results addressed to you; review those results before sending more work.",
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
          description:
            "Optional project-context document paths only: repo-relative README.md, docs/**/*.md, or specs/<feature>/{spec,plan,tasks,verify}.md. Never put prose, SHAs, source files, or absolute paths here; use objective/acceptance_criteria instead.",
          items: { maxLength: 500, type: "string" },
          maxItems: MAX_UTILITY_CONTEXT_REFS,
          type: "array",
        },
        estimated_cost_usd: { minimum: 0, type: "number" },
        execution_argv: STRING_ARRAY_SCHEMA,
        execution_cwd: { minLength: 1, type: "string" },
        execution_git: EXECUTION_GIT_SCHEMA,
        execution_output: EXECUTION_OUTPUT_SCHEMA,
        execution_plan: {
          items: READ_PLAN_STEP_SCHEMA,
          maxItems: 12,
          minItems: 1,
          type: "array",
        },
        execution_profile: {
          enum: EXECUTION_PROFILE_VALUES,
          type: "string",
        },
        execution_read: EXECUTION_READ_SCHEMA,
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

const optionalString = (
  args: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new UtilityBridgeInputError(`${key} must be a non-empty string`);
  }
  return value;
};

const optionalRecord = (
  args: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new UtilityBridgeInputError(`${key} must be an object`);
  }
  return value;
};

const rejectUnknownKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new UtilityBridgeInputError(
      `${label} contains unsupported key: ${unknown}`
    );
  }
};

const optionalPositiveInteger = (
  args: Record<string, unknown>,
  key: string
): number | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!(Number.isSafeInteger(value) && (value as number) > 0)) {
    throw new UtilityBridgeInputError(`${key} must be a positive integer`);
  }
  return value as number;
};

const optionalBoolean = (
  args: Record<string, unknown>,
  key: string
): boolean | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new UtilityBridgeInputError(`${key} must be boolean`);
  }
  return value;
};

const optionalEnum = <T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[]
): T | undefined => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new UtilityBridgeInputError(`${key} is invalid`);
  }
  return value as T;
};

const contextReferences = (args: Record<string, unknown>): string[] => {
  const values = stringArray(args, "context_refs");
  if (values.length > MAX_UTILITY_CONTEXT_REFS) {
    throw new UtilityBridgeInputError(
      `context_refs accepts at most ${MAX_UTILITY_CONTEXT_REFS} paths`
    );
  }
  const normalized = values.map(normalizeUtilityPolicyPath);
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((value) => !isUtilityContextRefPath(value))
  ) {
    throw new UtilityBridgeInputError(
      "context_refs accepts only unique repo-relative README.md, docs/**/*.md, or specs/<feature>/{spec,plan,tasks,verify}.md paths; put narrative facts, SHAs, source files, and absolute paths in objective or acceptance_criteria"
    );
  }
  return normalized;
};

const executionProfile = (
  args: Record<string, unknown>,
  key = "execution_profile",
  values: readonly UtilityExecutionProfile[] = EXECUTION_PROFILE_VALUES
): UtilityExecutionProfile | undefined => optionalEnum(args, key, values);

const executionRead = (
  args: Record<string, unknown>,
  key = "execution_read"
): UtilityReadRequest | undefined => {
  const value = optionalRecord(args, key);
  if (!value) {
    return undefined;
  }
  rejectUnknownKeys(
    value,
    ["end_line", "last_lines", "path", "start_line"],
    key
  );
  const endLine = optionalPositiveInteger(value, "end_line");
  const lastLines = optionalPositiveInteger(value, "last_lines");
  const startLine = optionalPositiveInteger(value, "start_line");
  return {
    ...(endLine === undefined ? {} : { endLine }),
    ...(lastLines === undefined ? {} : { lastLines }),
    path: requiredString(value, "path"),
    ...(startLine === undefined ? {} : { startLine }),
  };
};

const executionOutput = (
  args: Record<string, unknown>,
  key = "execution_output"
): UtilityOutputRequest | undefined => {
  const value = optionalRecord(args, key);
  if (!value) {
    return undefined;
  }
  rejectUnknownKeys(
    value,
    [
      "exclude_lines",
      "include_lines",
      "line_limit",
      "position",
      "stderr",
      "strip_ansi",
    ],
    key
  );
  const excludeLines =
    value.exclude_lines === undefined
      ? undefined
      : stringArray(value, "exclude_lines");
  const includeLines =
    value.include_lines === undefined
      ? undefined
      : stringArray(value, "include_lines");
  const lineLimit = optionalPositiveInteger(value, "line_limit");
  const position = optionalEnum(value, "position", ["head", "tail"] as const);
  const stderr = optionalEnum(value, "stderr", ["merge", "omit"] as const);
  const stripAnsi = optionalBoolean(value, "strip_ansi");
  return {
    ...(excludeLines ? { excludeLines } : {}),
    ...(includeLines ? { includeLines } : {}),
    ...(lineLimit === undefined ? {} : { lineLimit }),
    ...(position ? { position } : {}),
    ...(stderr ? { stderr } : {}),
    ...(stripAnsi === undefined ? {} : { stripAnsi }),
  };
};

const executionGit = (
  args: Record<string, unknown>,
  key = "execution_git"
): UtilityGitInspectionRequest | undefined => {
  const value = optionalRecord(args, key);
  if (!value) {
    return undefined;
  }
  rejectUnknownKeys(
    value,
    ["action", "include_metadata", "limit", "pattern", "ref"],
    key
  );
  const action = optionalEnum(value, "action", [
    "branch-list",
    "current-branch",
    "log",
    "object-type",
    "resolve-ref",
    "show-stat",
    "worktree-list",
  ] as const);
  if (!action) {
    throw new UtilityBridgeInputError(`${key}.action is required`);
  }
  const includeMetadata = optionalBoolean(value, "include_metadata");
  const limit = optionalPositiveInteger(value, "limit");
  const pattern = optionalString(value, "pattern");
  const ref = optionalString(value, "ref");
  return {
    action,
    ...(includeMetadata === undefined ? {} : { includeMetadata }),
    ...(limit === undefined ? {} : { limit }),
    ...(pattern ? { pattern } : {}),
    ...(ref ? { ref } : {}),
  };
};

const executionPlan = (
  args: Record<string, unknown>
): UtilityReadPlanStep[] | undefined => {
  const value = args.execution_plan;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new UtilityBridgeInputError("execution_plan must be an array");
  }
  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new UtilityBridgeInputError(
        `execution_plan[${index}] must be an object`
      );
    }
    rejectUnknownKeys(
      raw,
      [
        "execution_argv",
        "execution_cwd",
        "execution_git",
        "execution_output",
        "execution_profile",
        "execution_read",
        "objective",
        "read_scope",
      ],
      `execution_plan[${index}]`
    );
    const profile = executionProfile(
      raw,
      "execution_profile",
      READ_PLAN_PROFILE_VALUES
    );
    if (!profile || profile === "read-plan") {
      throw new UtilityBridgeInputError(
        `execution_plan[${index}].execution_profile is invalid`
      );
    }
    const executionArgv =
      raw.execution_argv === undefined
        ? undefined
        : stringArray(raw, "execution_argv");
    const executionCwd = optionalString(raw, "execution_cwd");
    const parsedExecutionGit = executionGit(raw);
    const parsedExecutionOutput = executionOutput(raw);
    const parsedExecutionRead = executionRead(raw);
    return {
      ...(executionArgv ? { executionArgv } : {}),
      ...(executionCwd ? { executionCwd } : {}),
      ...(parsedExecutionGit ? { executionGit: parsedExecutionGit } : {}),
      ...(parsedExecutionOutput
        ? { executionOutput: parsedExecutionOutput }
        : {}),
      executionProfile: profile,
      ...(parsedExecutionRead ? { executionRead: parsedExecutionRead } : {}),
      objective: requiredString(raw, "objective"),
      readScope: stringArray(raw, "read_scope"),
    } as UtilityReadPlanStep;
  });
};

type UtilityExecutionMetadata = Partial<
  Pick<
    UtilityRouteRequest,
    | "executionArgv"
    | "executionCwd"
    | "executionGit"
    | "executionOutput"
    | "executionPlan"
    | "executionProfile"
    | "executionRead"
  >
>;

const executionMetadata = (
  args: Record<string, unknown>
): UtilityExecutionMetadata => {
  const parsedExecutionProfile = executionProfile(args);
  const parsedExecutionRead = executionRead(args);
  const parsedExecutionOutput = executionOutput(args);
  const parsedExecutionGit = executionGit(args);
  const parsedExecutionPlan = executionPlan(args);
  const parsedExecutionArgv =
    args.execution_argv === undefined
      ? undefined
      : stringArray(args, "execution_argv");
  const parsedExecutionCwd = optionalString(args, "execution_cwd");
  return {
    ...(parsedExecutionArgv ? { executionArgv: parsedExecutionArgv } : {}),
    ...(parsedExecutionCwd ? { executionCwd: parsedExecutionCwd } : {}),
    ...(parsedExecutionGit ? { executionGit: parsedExecutionGit } : {}),
    ...(parsedExecutionOutput
      ? { executionOutput: parsedExecutionOutput }
      : {}),
    ...(parsedExecutionPlan ? { executionPlan: parsedExecutionPlan } : {}),
    ...(parsedExecutionProfile
      ? { executionProfile: parsedExecutionProfile }
      : {}),
    ...(parsedExecutionRead ? { executionRead: parsedExecutionRead } : {}),
  };
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
    contextRefs: contextReferences(args),
    ...(typeof estimatedCostUsd === "number" ? { estimatedCostUsd } : {}),
    ...executionMetadata(args),
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
  if (
    (kind === "inspect" || kind === "edit" || kind === "command") &&
    !utilityRequestIsBounded(request)
  ) {
    throw new UtilityBridgeInputError(
      "route_task utility packet is not deterministically bounded; use non-empty exact scopes and an execution_profile/execution_plan whose fields match the advertised contract"
    );
  }
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
  const priorHelperResults =
    source === "supervisor"
      ? []
      : consumeBridgeInbox(
          runDir,
          source,
          "bundled into route_task response",
          (message) =>
            message.source === "utility" &&
            !isBridgeDeliveryClaimed(runDir, message.id)
        );
  return {
    ...(priorHelperResults.length > 0 ? { priorHelperResults } : {}),
    state: job.state,
    taskId: job.jobId,
  };
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
