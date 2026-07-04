import { appendFileSync, mkdirSync } from "node:fs";
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
  const cwd = firstString(obj, ["cwd", "working_directory", "workingDirectory"]);
  return {
    agent,
    ...(cwd ? { cwd } : {}),
    ...(detail ? { detail } : {}),
    event,
    ...(tool ? { tool } : {}),
    ts: nowIso,
  };
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
  now?: () => string;
  stdin?: AsyncIterable<Uint8Array>;
  append?: (path: string, line: string) => void;
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
    const event = normalizeHookPayload(agent, payload, now());
    append(hookFile, `${JSON.stringify(event)}\n`);
  } catch {
    // Best-effort: never propagate a hook failure to the agent.
  }
};
