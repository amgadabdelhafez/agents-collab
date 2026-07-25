import { describe, expect, test } from "bun:test";
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  normalizeHookPayload,
  runHookEmit,
} from "../../src/loop/hooks/emit";
import {
  buildClaudeHookSettings,
  buildCodexHooksJson,
  buildHookCommand,
} from "../../src/loop/hooks/settings";

const NOW = "2026-07-04T12:00:00.000Z";

describe("normalizeHookPayload", () => {
  test("maps a Claude PostToolUse payload to a normalized event", () => {
    const event = normalizeHookPayload(
      "claude",
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "src/auth.ts" },
        cwd: "/repo",
      },
      NOW
    );
    expect(event).toEqual({
      agent: "claude",
      cwd: "/repo",
      detail: "src/auth.ts",
      event: "PostToolUse",
      state: "working",
      tool: "Edit",
      ts: NOW,
    });
  });

  test("falls back to a raw event for unknown shapes", () => {
    const event = normalizeHookPayload("codex", { something: "else" }, NOW);
    expect(event.event).toBe("raw");
    expect(event.agent).toBe("codex");
    expect(event.ts).toBe(NOW);
  });

  test("captures a message detail for notification-style payloads", () => {
    const event = normalizeHookPayload(
      "claude",
      { hook_event_name: "Notification", message: "waiting for input" },
      NOW
    );
    expect(event.event).toBe("Notification");
    expect(event.detail).toBe("waiting for input");
  });
});

describe("runHookEmit", () => {
  test("appends one normalized JSONL line and never throws", async () => {
    const lines: string[] = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({ hook_event_name: "Stop", cwd: "/repo" })
      );
    }
    await runHookEmit("codex", "/tmp/does-not-matter.jsonl", {
      now: () => NOW,
      stdin: stdin(),
      append: (_path, line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      agent: "codex",
      event: "Stop",
      sequence: 1,
      source: "agent-hook",
      state: "input-required",
      ts: NOW,
    });
    expect(parsed.eventId).toBeString();
    expect(lines[0].endsWith("\n")).toBe(true);
  });

  test("swallows malformed stdin without throwing", async () => {
    const lines: string[] = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode("not json{{{");
    }
    await runHookEmit("claude", "/tmp/x.jsonl", {
      now: () => NOW,
      stdin: stdin(),
      append: (_path, line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("raw");
  });
});

describe("hook settings generators", () => {
  const command = buildHookCommand(
    ["bun", "src/cli.ts"],
    "claude",
    "/run/hooks/claude.jsonl"
  );

  test("builds a shell command that invokes the emitter", () => {
    expect(command).toContain("__hook-emit");
    expect(command).toContain("claude");
    expect(command).toContain("/run/hooks/claude.jsonl");
  });

  test("Claude settings register every Claude hook event", () => {
    const settings = buildClaudeHookSettings(command);
    expect(Object.keys(settings.hooks).sort()).toEqual(
      [...CLAUDE_HOOK_EVENTS].sort()
    );
    expect(settings.hooks.PostToolUse[0].hooks[0]).toEqual({
      command,
      type: "command",
    });
  });

  test("Codex hooks.json registers only coarse turn events", () => {
    const hooks = buildCodexHooksJson(command);
    expect(Object.keys(hooks.hooks).sort()).toEqual(
      [...CODEX_HOOK_EVENTS].sort()
    );
    expect(hooks.hooks.PostToolUse).toBeUndefined();
  });
});
