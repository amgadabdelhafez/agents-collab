import { consumeBridgeInbox } from "./bridge-dispatch";
import { isBridgeDeliveryClaimed } from "./bridge-runtime";
import {
  appendDelegationEvent,
  hashDelegationFingerprint,
  makeDelegationEvent,
} from "./delegation-policy";
import {
  appendNativeFallbackRequest,
  createNativeFallbackRequest,
  type NativeFallbackKind,
  type NativeFallbackReason,
  type NativeFallbackSnapshot,
  readNativeFallbackRequests,
} from "./native-subagent";
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
  type UtilityReviewMode,
  type UtilityRisk,
  type UtilityRouteRequest,
  type UtilityWorkShape,
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
  "request_native_fallback",
  "native_fallback_status",
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
      "Submit an independent bounded, separable work packet before doing it natively. Set work_shape=separable only when it can finish without intermediate output from another lane; sequential, ambiguous, and cross-cutting work stays with the main agent. Start concrete work by submitting one to three packets early, then keep safe lower-tier work in flight while you continue the critical path. Before authoring any meaningful self-contained code block, use kind=edit with one or two exact write files, one through four exact read files, scoped-edit capability, decided behavior, and concrete acceptance; do not recast code writing as inspect and do not wait until after native Edit or Write. For a bounded evidence audit with no approval authority, use kind=review and review_mode=utility-audit; peer-verdict or omitted review_mode stays with Claude/Codex. For commit-bound utility audits, use execution_profile=git-diff without raw execution_argv/execution_cwd and put literal SHAs in the objective; Au Pair calls the SHA-validating broker. Patch and audit results are non-authoritative until a full agent reviews them. For patch proposals, low means low operational side-effect/authority risk, not easy reasoning; unresolved design or ambiguous scope is not low. Reserve active write_scope files, review returned artifacts, and use guarded apply only as a full agent. Nanny handles only small one- or two-scope inspection/extraction/synthesis; Au Pair handles bounded multi-step work, utility audits, small scoped patch proposals, and reasoning-backed focused checks; Direct handles exact work. Specify exact scopes, risk, capabilities, authority, and acceptance, never a provider: Governess chooses. context_refs is optional and accepts only repo-relative README.md, docs/**/*.md, or specs/<feature>/{spec,plan,tasks,verify}.md paths; put narrative facts and SHAs in objective or acceptance_criteria. Split independently answerable inspections into packets of at most two read scopes when practical, but keep cross-file judgment together and never falsify risk. Workers never widen scope: when locating a moved or differently nested path, read_scope must name the narrowest common ancestor that can contain every acceptable candidate. Use execution_profile/execution_plan for exact reads, searches, Git inspection, or focused checks. Every terminal outcome returns to this requester unless the route explicitly requires peer review. The response also drains older unclaimed helper results addressed to you; review those results before sending more work.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        acceptance_criteria: {
          description:
            "Concrete observable outcomes for the bounded packet. For edits, require a minimal patch within exact write files and name focused proof or invariants to preserve.",
          items: { type: "string" },
          minItems: 1,
          type: "array",
        },
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
          description:
            "Use edit when asking the helper to author or modify code. Use inspect only when no patch should be produced.",
          enum: ["inspect", "edit", "command", "review", "design", "authority"],
          type: "string",
        },
        objective: { minLength: 1, type: "string" },
        requester: {
          enum: ["claude", "codex", "oss"],
          type: "string",
        },
        review_mode: {
          description:
            "Only for kind=review. utility-audit requests a bounded non-authoritative Au Pair evidence audit; peer-verdict preserves Claude/Codex judgment. Omit for ordinary peer review.",
          enum: ["utility-audit", "peer-verdict"],
          type: "string",
        },
        read_scope: {
          description:
            "Exact readable paths. An edit uses one through four and repeats every write target here so Au Pair can inspect its preimage.",
          items: { type: "string" },
          type: "array",
        },
        required_capabilities: {
          description:
            "Use inspect plus scoped-edit for code-writing proposals; add focused-verify only when a declared focused check is required.",
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
        risk: {
          description:
            "Operational side-effect and authority risk, not reasoning difficulty. An exact-scope proposal with no authority can be low; ambiguous scope or unresolved design cannot.",
          enum: ["low", "medium", "high", "unknown"],
          type: "string",
        },
        write_scope: {
          description:
            "Exact files a patch may target. Small Au Pair edits use one or two; directory-broad scopes are not valid edit targets.",
          items: { type: "string" },
          type: "array",
        },
        work_shape: {
          description:
            "separable means the packet can finish without intermediate output from another lane; sequential or unknown work remains with the current driver.",
          enum: ["separable", "sequential", "unknown"],
          type: "string",
        },
      },
      required: ["objective", "kind", "acceptance_criteria", "work_shape"],
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
  {
    annotations: ROUTE_TASK_ANNOTATIONS,
    description:
      "Claude may request the one governed native fallback only after Direct, Nanny, or Au Pair has produced a settled route or terminal result that cannot finish the bounded read-only exploration/review. Supply those task IDs as evidence. Governess grants at most one short-lived run-wide lease; the next Agent call must use the loop-readonly-fallback profile. Codex native spawn is disabled because Codex 0.145 inherits the full-access parent sandbox. Main agents cannot self-assert a human exception.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        acceptance_criteria: {
          items: { minLength: 1, type: "string" },
          maxItems: 4,
          minItems: 1,
          type: "array",
        },
        evidence_task_ids: {
          description:
            "One through three settled route_task IDs owned by this requester. A supervisor-authorized human exception may omit them.",
          items: { minLength: 1, type: "string" },
          maxItems: 3,
          type: "array",
        },
        fallback_reason: {
          enum: [
            "utility-ineligible",
            "utility-failed",
            "utility-context-insufficient",
            "independent-review",
            "human-authorized",
          ],
          type: "string",
        },
        human_authorized: {
          description:
            "Supervisor-only assertion that the human explicitly requested a native fallback.",
          type: "boolean",
        },
        kind: { enum: ["explore", "review"], type: "string" },
        objective: { minLength: 1, type: "string" },
        read_scope: {
          description:
            "One through eight non-root repo-relative, non-protected scopes. The fallback may inspect only explicitly targeted existing regular files inside them; recursive directory reads are denied.",
          items: { minLength: 1, type: "string" },
          maxItems: 8,
          minItems: 1,
          type: "array",
        },
        requester: {
          description:
            "Required only for supervisor submissions; the current enforceable native fallback provider is Claude.",
          enum: ["claude"],
          type: "string",
        },
      },
      required: [
        "objective",
        "kind",
        "fallback_reason",
        "read_scope",
        "acceptance_criteria",
      ],
      type: "object",
    },
    name: "request_native_fallback",
  },
  {
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      "Read a governed native fallback request, lease, and lifecycle state. Spawn only after this returns granted.",
    inputSchema: {
      additionalProperties: false,
      properties: { request_id: { minLength: 1, type: "string" } },
      required: ["request_id"],
      type: "object",
    },
    name: "native_fallback_status",
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
  if (values.some((value) => !isUtilityContextRefPath(value))) {
    throw new UtilityBridgeInputError(
      "context_refs accepts only unique repo-relative README.md, docs/**/*.md, or specs/<feature>/{spec,plan,tasks,verify}.md paths; put narrative facts, SHAs, source files, and absolute paths in objective or acceptance_criteria"
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

const requestWorkShape = (value: unknown): UtilityWorkShape => {
  if (value === "separable" || value === "sequential" || value === "unknown") {
    return value;
  }
  throw new UtilityBridgeInputError("work_shape is invalid");
};

const requestReviewMode = (value: unknown): UtilityReviewMode | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === "utility-audit" || value === "peer-verdict") {
    return value;
  }
  throw new UtilityBridgeInputError("review_mode is invalid");
};

const defaultCapabilities = (kind: UtilityRequestKind): UtilityCapability[] => {
  if (kind === "inspect" || kind === "review") {
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

const nativeFallbackKind = (value: unknown): NativeFallbackKind => {
  if (value === "explore" || value === "review") {
    return value;
  }
  throw new UtilityBridgeInputError("kind must be explore or review");
};

const nativeFallbackReason = (value: unknown): NativeFallbackReason => {
  if (
    value === "utility-ineligible" ||
    value === "utility-failed" ||
    value === "utility-context-insufficient" ||
    value === "independent-review" ||
    value === "human-authorized"
  ) {
    return value;
  }
  throw new UtilityBridgeInputError("fallback_reason is invalid");
};

const requestNativeFallback = (
  runDir: string,
  source: UtilityBridgeSource,
  args: Record<string, unknown>
): { requestId: string; state: string } => {
  const delegatedRequester = args.requester;
  const requester =
    source === "supervisor" &&
    (delegatedRequester === "claude" || delegatedRequester === "codex")
      ? delegatedRequester
      : source;
  if (requester === "supervisor") {
    throw new UtilityBridgeInputError(
      "supervisor request_native_fallback requires requester=claude"
    );
  }
  if (requester === "codex") {
    throw new UtilityBridgeInputError(
      "Codex native spawn is disabled because the provider inherits the full-access parent sandbox; use Direct, Nanny, Au Pair, or targeted Claude peer review"
    );
  }
  if (requester !== "claude") {
    throw new UtilityBridgeInputError(
      "native fallback is currently available only to Claude"
    );
  }
  if (
    source !== "supervisor" &&
    delegatedRequester !== undefined &&
    delegatedRequester !== source
  ) {
    throw new UtilityBridgeInputError(
      "main agents cannot override the native fallback requester"
    );
  }
  const humanAuthorized = args.human_authorized === true;
  if (humanAuthorized && source !== "supervisor") {
    throw new UtilityBridgeInputError(
      "only the supervisor can assert a human-authorized native fallback"
    );
  }
  try {
    const request = createNativeFallbackRequest({
      acceptanceCriteria: stringArray(args, "acceptance_criteria"),
      evidenceTaskIds: stringArray(args, "evidence_task_ids"),
      fallbackReason: nativeFallbackReason(args.fallback_reason),
      humanAuthorized,
      kind: nativeFallbackKind(args.kind),
      objective: requiredString(args, "objective"),
      readScope: stringArray(args, "read_scope"),
      requester,
    });
    const snapshot = appendNativeFallbackRequest(runDir, request);
    return { requestId: request.id, state: snapshot.state };
  } catch (error) {
    throw new UtilityBridgeInputError(
      error instanceof Error
        ? error.message
        : "native fallback request failed closed"
    );
  }
};

const nativeFallbackStatus = (
  runDir: string,
  source: UtilityBridgeSource,
  args: Record<string, unknown>
): unknown => {
  const requestId = requiredString(args, "request_id");
  let snapshot: NativeFallbackSnapshot | undefined;
  try {
    snapshot = readNativeFallbackRequests(runDir).find(
      (candidate) => candidate.request.id === requestId
    );
  } catch (error) {
    throw new UtilityBridgeInputError(
      error instanceof Error
        ? error.message
        : "native fallback journal failed closed"
    );
  }
  if (!snapshot) {
    throw new UtilityBridgeInputError("unknown native fallback request_id");
  }
  if (source !== "supervisor" && snapshot.request.requester !== source) {
    throw new UtilityBridgeInputError(
      "native fallback status is restricted to its requester"
    );
  }
  return {
    agentId: snapshot.agentId,
    agentType: snapshot.agentType,
    epoch: snapshot.epoch,
    expiresAt: snapshot.expiresAt,
    reason: snapshot.reason,
    requestId,
    runtimeExpiresAt: snapshot.runtimeExpiresAt,
    state: snapshot.state,
    updatedAt: snapshot.updatedAt,
  };
};

const assertRouteTaskIsBounded = (request: UtilityRouteRequest): void => {
  const kind = request.kind;
  if (kind === "review" && request.reviewMode !== "utility-audit") {
    return;
  }
  if (
    (kind !== "inspect" &&
      kind !== "edit" &&
      kind !== "command" &&
      kind !== "review") ||
    utilityRequestIsBounded(request)
  ) {
    return;
  }
  if (kind === "edit") {
    throw new UtilityBridgeInputError(
      "route_task edit packet is not deterministically bounded; use one to four exact read files, one or two exact write files repeated in read_scope, scoped-edit capability, and no execution_profile, execution_plan, command, Git, output, or exact-read metadata"
    );
  }
  if (kind === "command") {
    throw new UtilityBridgeInputError(
      "route_task command packet is not deterministically executable; provide execution_profile and its exact fields. For a focused check use execution_profile=focused-check with exact execution_cwd and execution_argv path operands repeated in read_scope. To select a registered linked worktree, use absolute paths from that one worktree in read_scope, execution_cwd, and execution_argv; the harness verifies and normalizes them before execution"
    );
  }
  if (kind === "review") {
    throw new UtilityBridgeInputError(
      "route_task utility audit is not deterministically bounded; set review_mode=utility-audit, use one to six exact read scopes, no write scopes, inspect capability, no authority, and only bounded structured execution metadata"
    );
  }
  throw new UtilityBridgeInputError(
    "route_task utility packet is not deterministically bounded; use non-empty exact scopes and an execution_profile/execution_plan whose fields match the advertised contract"
  );
};

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
      delegatedRequester === "oss")
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
    reviewMode: requestReviewMode(args.review_mode),
    requiredCapabilities: capabilities(args, kind),
    risk: requestRisk(args.risk),
    workShape: requestWorkShape(args.work_shape),
    writeScope: stringArray(args, "write_scope"),
  });
  assertRouteTaskIsBounded(request);
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
  if (name === "request_native_fallback") {
    return requestNativeFallback(runDir, source, args);
  }
  if (name === "native_fallback_status") {
    return nativeFallbackStatus(runDir, source, args);
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
  if (source !== "supervisor") {
    if (job.request.requester !== source) {
      throw new UtilityBridgeInputError(
        "get_task_result is restricted to its requester"
      );
    }
    consumeBridgeInbox(
      runDir,
      job.request.requester,
      "read via get_task_result",
      (message) =>
        message.source === "utility" &&
        message.type === "handover" &&
        message.taskId === job.jobId &&
        !isBridgeDeliveryClaimed(runDir, message.id)
    );
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
