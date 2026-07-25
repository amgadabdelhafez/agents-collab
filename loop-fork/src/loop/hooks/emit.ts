import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Agent, HookEvent } from "../types";

export const HOOK_EMIT_SUBCOMMAND = "__hook-emit";

// Claude and Codex hook payloads share the same shape (hook_event_name + tool
// fields). Codex exposes only coarse turn-level events; Claude adds per-tool
// events. We register the events each agent actually supports.
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
] as const;

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
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
  now?: () => string;
  stdin?: AsyncIterable<Uint8Array>;
}

// Runs as `loop __hook-emit <agent> <hookFile>`. Reads one hook payload on
// stdin, appends a normalized JSONL line, and NEVER fails the calling agent:
// any error is swallowed so a hook problem cannot block Claude/Codex.
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
    const event = {
      ...normalizeHookPayload(agent, payload, now()),
      eventId: randomUUID(),
      sequence: nextHookSequence(hookFile),
      source: "agent-hook" as const,
    };
    append(hookFile, `${JSON.stringify(event)}\n`);
  } catch {
    // Best-effort: never propagate a hook failure to the agent.
  }
};
