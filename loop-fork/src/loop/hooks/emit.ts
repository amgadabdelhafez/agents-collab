import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  appendDelegationEvent,
  classifyDelegationIntent,
  type DelegationTelemetryEvent,
  delegationWorkspaceHint,
  hashDelegationFingerprint,
  makeDelegationEvent,
  resolveUtilityDelegationMode,
} from "../delegation-policy";
import {
  bindNativeFallbackStart,
  completeNativeFallback,
  consumeNativeFallbackLease,
  type NativeFallbackSnapshot,
  nativeFallbackForChild,
  nativeFallbackProfile,
  nativeFallbackScopeAllows,
  recordNativeFallbackDenial,
  resolveNativeSubagentMode,
} from "../native-subagent";
import { readRunManifest } from "../run-state";
import {
  createUtilityRouteRequest,
  type UtilityRouteRequestInput,
} from "../task-router";
import type { Agent, HookEvent } from "../types";
import {
  buildUtilityWorkerEnvironment,
  resolveUtilityRuntimeConfig,
} from "../utility-runtime";
import { appendUtilityRouteRequest } from "../utility-store";
import { resolveVerifiedUtilityWorkspaceRoot } from "../utility-workspace";

export const HOOK_EMIT_SUBCOMMAND = "__hook-emit";

// Claude and current Codex hook payloads share the same hook_event_name + tool
// field convention. Register tool and native-subagent lifecycle events for
// both providers so the same Governess adapters can observe them.
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const firstString = (
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
};

// Pull a short human-readable detail out of the tool input, if present.
const toolDetail = (obj: Record<string, unknown>): string | undefined => {
  const input = asRecord(obj.tool_input ?? obj.toolInput);
  return firstString(input, [
    "file_path",
    "filePath",
    "path",
    "command",
    "pattern",
    "url",
  ]);
};

// Detect whether a tool-call payload indicates failure.
const isErrorPayload = (obj: Record<string, unknown>): boolean => {
  if (obj.is_error === true || obj.success === false) {
    return true;
  }
  const response = asRecord(
    obj.tool_response ?? obj.tool_result ?? obj.toolResult
  );
  if (response.is_error === true) {
    return true;
  }
  if (typeof response.error === "string" && response.error.length > 0) {
    return true;
  }
  const code = obj.exit_code ?? response.exit_code;
  return typeof code === "number" && code !== 0;
};

const lifecycleState = (
  event: string,
  error: boolean,
  raw: Record<string, unknown>
): HookEvent["state"] => {
  const explicit = firstString(raw, ["lifecycle_state", "lifecycleState"]);
  if (
    explicit === "starting" ||
    explicit === "working" ||
    explicit === "input-required" ||
    explicit === "waiting-peer" ||
    explicit === "blocked" ||
    explicit === "draining" ||
    explicit === "handover-ready" ||
    explicit === "exited" ||
    explicit === "failed" ||
    explicit === "canceled"
  ) {
    return explicit;
  }
  if (error) {
    return "failed";
  }
  if (event === "SessionStart") {
    return "starting";
  }
  if (
    event === "UserPromptSubmit" ||
    event === "PreToolUse" ||
    event === "PostToolUse"
  ) {
    return "working";
  }
  if (event === "Notification" || event === "Stop") {
    return "input-required";
  }
  return undefined;
};

// Normalize a raw agent hook payload into our shared HookEvent shape. Tolerant:
// unknown shapes become a "raw" event rather than throwing.
export const normalizeHookPayload = (
  agent: Agent,
  raw: unknown,
  nowIso: string
): HookEvent => {
  const obj = asRecord(raw);
  const event =
    firstString(obj, ["hook_event_name", "hookEventName", "event", "type"]) ??
    "raw";
  const tool = firstString(obj, ["tool_name", "toolName", "tool"]);
  const detail =
    toolDetail(obj) ?? firstString(obj, ["message", "notification", "reason"]);
  const cwd = firstString(obj, [
    "cwd",
    "working_directory",
    "workingDirectory",
  ]);
  const error = isErrorPayload(obj);
  const state = lifecycleState(event, error, obj);
  return {
    agent,
    ...(cwd ? { cwd } : {}),
    ...(detail ? { detail } : {}),
    ...(error ? { error: true } : {}),
    event,
    ...(state ? { state } : {}),
    ...(tool ? { tool } : {}),
    ts: nowIso,
  };
};

const nextHookSequence = (hookFile: string): number => {
  try {
    return (
      readFileSync(hookFile, "utf8").split("\n").filter(Boolean).length + 1
    );
  } catch {
    return 1;
  }
};

const readAllStdin = async (
  stream: AsyncIterable<Uint8Array> | NodeJS.ReadStream
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

interface HookEmitDeps {
  append?: (path: string, line: string) => void;
  appendDelegation?: (runDir: string, event: DelegationTelemetryEvent) => void;
  appendRoute?: (
    runDir: string,
    request: ReturnType<typeof createUtilityRouteRequest>
  ) => { jobId: string };
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  readManifest?: (path: string) => { cwd: string } | undefined;
  resolveWorkspaceRoot?: (runRoot: string, path: string) => string | undefined;
  stdin?: AsyncIterable<Uint8Array>;
  writeStdout?: (text: string) => void;
}

const preToolDelegationOutput = (taskId: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `This bounded mechanical operation was delegated automatically through Governess to Direct, Nanny, or Au Pair as task ${taskId}. Do not retry the native tool. Use task_status, then get_task_result when complete; if Governess returns it to the driver, continue directly from that route result.`,
    },
  });

const preToolDecisionOutput = (
  decision: "allow" | "deny",
  reason: string,
  additionalContext?: string
): string =>
  JSON.stringify({
    hookSpecificOutput: {
      ...(additionalContext ? { additionalContext } : {}),
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });

const subagentStartOutput = (additionalContext: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      additionalContext,
      hookEventName: "SubagentStart",
    },
  });

const hookEventName = (raw: Record<string, unknown>): string | undefined =>
  firstString(raw, ["hook_event_name", "hookEventName", "event", "type"]);

const hookAgentId = (raw: Record<string, unknown>): string | undefined =>
  firstString(raw, ["agent_id", "agentId"]);

const hookAgentType = (
  raw: Record<string, unknown>,
  input: Record<string, unknown> = asRecord(raw.tool_input ?? raw.toolInput)
): string | undefined =>
  firstString(raw, ["agent_type", "agentType"]) ??
  firstString(input, [
    "subagent_type",
    "subagentType",
    "agent_type",
    "agentType",
    "profile",
    "role",
  ]);

const isNativeSpawnTool = (toolName: string): boolean =>
  toolName === "Agent" ||
  toolName === "Task" ||
  toolName === "spawn_agent" ||
  toolName.endsWith("__spawn_agent");

const nativeChildContext = (snapshot: NativeFallbackSnapshot): string =>
  [
    `You are the single Governess-leased read-only native fallback for ${snapshot.request.requester}.`,
    `Objective: ${snapshot.request.objective}`,
    `Allowed read scopes: ${snapshot.request.readScope.join(", ")}`,
    `Acceptance: ${snapshot.request.acceptanceCriteria.join("; ")}`,
    "Use only bounded inspection tools inside those scopes. Do not write, edit, run mutating commands, use MCP or web tools, ask the human, create descendants, or make product/architecture/release decisions. Return concise evidence to the parent and stop.",
  ].join("\n");

const nativeToolPath = (
  toolInput: Record<string, unknown>
): string | undefined =>
  firstString(toolInput, [
    "file_path",
    "filePath",
    "path",
    "directory",
    "root",
  ]);

const repoRelativeHookPath = (
  repoRoot: string,
  cwd: string,
  candidate: string
): string | undefined => {
  const absolute = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(cwd, candidate);
  const rel = relative(resolve(repoRoot), absolute).replaceAll("\\", "/");
  return rel && !rel.startsWith("../") && rel !== ".." ? rel : undefined;
};

const nativeChildInspectionAllowed = (
  snapshot: NativeFallbackSnapshot,
  raw: Record<string, unknown>,
  manifestRoot: string,
  toolName: string
): boolean => {
  const toolInput = asRecord(raw.tool_input ?? raw.toolInput);
  const cwd =
    firstString(raw, ["cwd", "working_directory", "workingDirectory"]) ??
    manifestRoot;
  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") {
    const path = nativeToolPath(toolInput);
    const relativePath = path
      ? repoRelativeHookPath(manifestRoot, cwd, path)
      : undefined;
    return Boolean(
      relativePath && nativeFallbackScopeAllows(snapshot, relativePath)
    );
  }
  return false;
};

const handleNativeSubagentHook = (
  agent: Agent,
  hookFile: string,
  payload: unknown,
  deps: HookEmitDeps
): string | undefined => {
  const raw = asRecord(payload);
  const event = hookEventName(raw);
  if (
    !(
      event === "PreToolUse" ||
      event === "SubagentStart" ||
      event === "SubagentStop"
    )
  ) {
    return undefined;
  }
  const runDir = dirname(dirname(hookFile));
  const mode = resolveNativeSubagentMode(
    (deps.env ?? process.env).LOOP_NATIVE_SUBAGENT_MODE
  );
  const agentId = hookAgentId(raw);
  const agentType = hookAgentType(raw);
  if (event === "SubagentStart") {
    if (!agentId) {
      return subagentStartOutput(
        "Governess could not bind this native child because the provider omitted its agent id. Do not call tools; return immediately."
      );
    }
    try {
      const decision = bindNativeFallbackStart({
        agentId,
        agentType,
        provider: agent,
        runDir,
      });
      return subagentStartOutput(
        decision.allowed && decision.lease
          ? nativeChildContext(decision.lease)
          : `Governess denied this unleased native child (${decision.reason}). Do not call tools; return immediately.`
      );
    } catch {
      return subagentStartOutput(
        "Governess native lease state is unavailable. Fail closed: do not call tools; return immediately."
      );
    }
  }
  if (event === "SubagentStop") {
    if (agentId) {
      try {
        completeNativeFallback({ agentId, provider: agent, runDir });
      } catch {
        // Stop telemetry is best-effort; expiry still releases the slot.
      }
    }
    return undefined;
  }
  const toolName = firstString(raw, ["tool_name", "toolName", "tool"]);
  const toolUseId = firstString(raw, ["tool_use_id", "toolUseId"]);
  if (!toolName) {
    return undefined;
  }
  if (agentId) {
    try {
      const snapshot = nativeFallbackForChild(runDir, agent, agentId);
      const manifest = (deps.readManifest ?? readRunManifest)(
        join(runDir, "manifest.json")
      );
      if (
        snapshot &&
        manifest?.cwd &&
        nativeChildInspectionAllowed(snapshot, raw, manifest.cwd, toolName)
      ) {
        return preToolDecisionOutput(
          "allow",
          "Governess read-only native fallback scope permits this inspection."
        );
      }
      const reason = snapshot
        ? `native-child-tool-denied:${toolName}`
        : "unleased-native-child-tool-denied";
      recordNativeFallbackDenial(runDir, {
        agentId,
        agentType,
        provider: agent,
        reason,
        requestId: snapshot?.request.id,
        toolName,
        toolUseId,
        type: "child-tool-denied",
      });
      return preToolDecisionOutput(
        "deny",
        `${reason}. Native fallback children are read-only, scope-bound, and cannot use shell mutations, MCP, web, human-input, or descendant-agent tools.`
      );
    } catch {
      return preToolDecisionOutput(
        "deny",
        "Governess native child policy is unavailable; the tool failed closed."
      );
    }
  }
  if (!isNativeSpawnTool(toolName)) {
    return undefined;
  }
  try {
    const decision = consumeNativeFallbackLease({
      agentType,
      mode,
      provider: agent,
      runDir,
      toolName,
      toolUseId,
    });
    if (!decision.allowed) {
      return preToolDecisionOutput(
        "deny",
        `${decision.reason}. Use Direct, Nanny, or Au Pair first; then request_native_fallback, wait for a Governess grant, and spawn only ${nativeFallbackProfile(agent) ?? "the loop read-only profile"}.`
      );
    }
    if (!decision.lease) {
      return undefined;
    }
    return preToolDecisionOutput(
      "allow",
      "Governess consumed the one native fallback lease.",
      nativeChildContext(decision.lease)
    );
  } catch {
    return preToolDecisionOutput(
      "deny",
      "Governess native lease state is unavailable; native spawning failed closed."
    );
  }
};

const rootDelegationRequest = (
  request: UtilityRouteRequestInput,
  workspaceRoot: string,
  adoptedWorkspace: boolean
): UtilityRouteRequestInput => {
  const rootScope = (scope: string): string =>
    adoptedWorkspace && !isAbsolute(scope)
      ? resolve(workspaceRoot, scope)
      : scope;
  return {
    ...request,
    ...(request.executionCwd
      ? { executionCwd: rootScope(request.executionCwd) }
      : {}),
    ...(request.executionRead
      ? {
          executionRead: {
            ...request.executionRead,
            path: rootScope(request.executionRead.path),
          },
        }
      : {}),
    ...(request.executionPlan
      ? {
          executionPlan: request.executionPlan.map((step) => ({
            ...step,
            ...(step.executionCwd
              ? { executionCwd: rootScope(step.executionCwd) }
              : {}),
            ...(step.executionRead
              ? {
                  executionRead: {
                    ...step.executionRead,
                    path: rootScope(step.executionRead.path),
                  },
                }
              : {}),
            readScope: step.readScope.map(rootScope),
          })),
        }
      : {}),
    readScope: request.readScope.map(rootScope),
    writeScope: request.writeScope.map(rootScope),
  };
};

const resolveDelegationWorkspace = (
  runRoot: string,
  cwd: string,
  toolName: string,
  toolInput: unknown,
  resolveWorkspace: NonNullable<HookEmitDeps["resolveWorkspaceRoot"]>
): string | undefined => {
  const currentWorkspaceRoot = resolveWorkspace(runRoot, cwd);
  const workspaceHint = delegationWorkspaceHint(cwd, toolName, toolInput);
  const hintedWorkspaceRoot = workspaceHint
    ? resolveWorkspace(runRoot, workspaceHint)
    : undefined;
  return hintedWorkspaceRoot ?? currentWorkspaceRoot;
};

const handlePreToolDelegation = (
  agent: Agent,
  hookFile: string,
  payload: unknown,
  at: string,
  deps: HookEmitDeps
): string | undefined => {
  const raw = asRecord(payload);
  if (
    firstString(raw, ["hook_event_name", "hookEventName", "event", "type"]) !==
    "PreToolUse"
  ) {
    return undefined;
  }
  const mode = resolveUtilityDelegationMode(
    (deps.env ?? process.env).LOOP_UTILITY_DELEGATION_MODE
  );
  if (mode === "off") {
    return undefined;
  }
  const toolName = firstString(raw, ["tool_name", "toolName", "tool"]);
  const toolInput = raw.tool_input ?? raw.toolInput;
  const cwd = firstString(raw, [
    "cwd",
    "working_directory",
    "workingDirectory",
  ]);
  if (!(toolName && cwd)) {
    return undefined;
  }
  const toolUseId = firstString(raw, ["tool_use_id", "toolUseId"]);
  const runDir = dirname(dirname(hookFile));
  const manifest = (deps.readManifest ?? readRunManifest)(
    join(runDir, "manifest.json")
  );
  if (!manifest?.cwd) {
    return undefined;
  }
  const appendTelemetry = deps.appendDelegation ?? appendDelegationEvent;
  const candidateFingerprint = hashDelegationFingerprint(
    JSON.stringify({ agent, cwd, input: toolInput, tool: toolName, toolUseId })
  );
  const resolveWorkspace =
    deps.resolveWorkspaceRoot ?? resolveVerifiedUtilityWorkspaceRoot;
  const workspaceRoot = resolveDelegationWorkspace(
    manifest.cwd,
    cwd,
    toolName,
    toolInput,
    resolveWorkspace
  );
  if (!workspaceRoot) {
    appendTelemetry(
      runDir,
      makeDelegationEvent(
        {
          agent,
          disposition: "skipped-candidate",
          fingerprint: candidateFingerprint,
          operation: "tool-use",
          reason: "workspace-unverified",
          source: agent === "claude" ? "claude-hook" : "codex-hook",
        },
        at
      )
    );
    return undefined;
  }
  const classification = classifyDelegationIntent({
    agent,
    cwd,
    repoRoot: workspaceRoot,
    toolInput,
    toolName,
    ...(toolUseId ? { toolUseId } : {}),
  });
  if (!classification.eligible) {
    appendTelemetry(
      runDir,
      makeDelegationEvent(
        {
          agent,
          disposition: "skipped-candidate",
          fingerprint: classification.fingerprint,
          operation: "tool-use",
          reason: classification.reason,
          source: agent === "claude" ? "claude-hook" : "codex-hook",
        },
        at
      )
    );
    return undefined;
  }
  const config = resolveUtilityRuntimeConfig(
    buildUtilityWorkerEnvironment(deps.env ?? process.env)
  );
  const utilityReady =
    config.enabled && config.availability.code.startsWith("ready-");
  if (mode === "observe" || !utilityReady) {
    appendTelemetry(
      runDir,
      makeDelegationEvent(
        {
          agent,
          disposition: "observed-candidate",
          fingerprint: classification.fingerprint,
          operation: classification.operation,
          reason:
            mode === "observe"
              ? "delegation-mode-observe"
              : `utility-unavailable:${config.availability.code}`,
          source: agent === "claude" ? "claude-hook" : "codex-hook",
        },
        at
      )
    );
    return undefined;
  }
  try {
    const adoptedWorkspace = workspaceRoot !== resolve(manifest.cwd);
    const routeRequest = createUtilityRouteRequest({
      ...rootDelegationRequest(
        classification.request,
        workspaceRoot,
        adoptedWorkspace
      ),
      createdAt: at,
    });
    const job = (deps.appendRoute ?? appendUtilityRouteRequest)(
      runDir,
      routeRequest
    );
    appendTelemetry(
      runDir,
      makeDelegationEvent(
        {
          agent,
          disposition: "auto-routed",
          fingerprint: classification.fingerprint,
          operation: classification.operation,
          reason: classification.reason,
          source: agent === "claude" ? "claude-hook" : "codex-hook",
          taskId: job.jobId,
        },
        at
      )
    );
    return preToolDelegationOutput(job.jobId);
  } catch {
    appendTelemetry(
      runDir,
      makeDelegationEvent(
        {
          agent,
          disposition: "route-failed",
          fingerprint: classification.fingerprint,
          operation: classification.operation,
          reason: "automatic-route-failed-open",
          source: agent === "claude" ? "claude-hook" : "codex-hook",
        },
        at
      )
    );
    return undefined;
  }
};

// Runs as `loop __hook-emit <agent> <hookFile>`. Reads one hook payload on
// stdin and appends a normalized JSONL line. Ordinary telemetry remains
// best-effort; native spawn/child policy is evaluated before that telemetry so
// a hook-journal write failure cannot bypass the lease gate.
export const runHookEmit = async (
  agent: Agent,
  hookFile: string,
  deps: HookEmitDeps = {}
): Promise<void> => {
  const now = deps.now ?? (() => new Date().toISOString());
  const append =
    deps.append ??
    ((path: string, line: string) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line, "utf8");
    });
  try {
    const stdin = deps.stdin ?? (process.stdin as AsyncIterable<Uint8Array>);
    const text = await readAllStdin(stdin);
    let payload: unknown;
    try {
      payload = text.trim() ? JSON.parse(text) : {};
    } catch {
      payload = { hook_event_name: "raw", detail: text.trim().slice(0, 200) };
    }
    const at = now();
    let nativeDecision: string | undefined;
    try {
      nativeDecision = handleNativeSubagentHook(agent, hookFile, payload, deps);
    } catch {
      const raw = asRecord(payload);
      const hookEvent = hookEventName(raw);
      const toolName = firstString(raw, ["tool_name", "toolName", "tool"]);
      if (
        hookEvent === "PreToolUse" &&
        (Boolean(hookAgentId(raw)) ||
          Boolean(toolName && isNativeSpawnTool(toolName)))
      ) {
        nativeDecision = preToolDecisionOutput(
          "deny",
          "Governess native policy failed closed after an internal hook error."
        );
      } else if (hookEvent === "SubagentStart") {
        nativeDecision = subagentStartOutput(
          "Governess native policy failed closed after an internal hook error. Do not call tools; return immediately."
        );
      }
    }
    try {
      const event = {
        ...normalizeHookPayload(agent, payload, at),
        eventId: randomUUID(),
        sequence: nextHookSequence(hookFile),
        source: "agent-hook" as const,
      };
      append(hookFile, `${JSON.stringify(event)}\n`);
    } catch {
      // The native decision above remains authoritative if telemetry is down.
    }
    if (nativeDecision) {
      (deps.writeStdout ?? ((value) => process.stdout.write(value)))(
        `${nativeDecision}\n`
      );
      return;
    }
    const decision = handlePreToolDelegation(
      agent,
      hookFile,
      payload,
      at,
      deps
    );
    if (decision) {
      (deps.writeStdout ?? ((value) => process.stdout.write(value)))(
        `${decision}\n`
      );
    }
  } catch {
    // Best-effort: never propagate a hook failure to the agent.
  }
};
