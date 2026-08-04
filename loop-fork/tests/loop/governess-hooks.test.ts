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

  test("enforce mode queues and denies an exact mechanical Claude tool", async () => {
    const hookLines: string[] = [];
    const delegationEvents: unknown[] = [];
    const routeRequests: unknown[] = [];
    const stdout: string[] = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({
          cwd: "/repo",
          hook_event_name: "PreToolUse",
          tool_input: { command: "git status --short" },
          tool_name: "Bash",
          tool_use_id: "tool-1",
        })
      );
    }
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: (_path, line) => hookLines.push(line),
      appendDelegation: (_runDir, event) => delegationEvents.push(event),
      appendRoute: (_runDir, request) => {
        routeRequests.push(request);
        return { jobId: "job-1" };
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "enforce",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      resolveWorkspaceRoot: () => "/repo",
      stdin: stdin(),
      writeStdout: (value) => stdout.push(value),
    });
    expect(hookLines).toHaveLength(1);
    expect(routeRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "auto:claude:tool-1",
        kind: "inspect",
        requester: "claude",
        workShape: "separable",
      }),
    ]);
    expect(delegationEvents).toEqual([
      expect.objectContaining({
        disposition: "auto-routed",
        operation: "git-status",
        taskId: "job-1",
      }),
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(stdout.join("")).toContain("task_status");
    expect(stdout.join("")).toContain("get_task_result");
  });

  test.each([
    ["observe", "http://127.0.0.1:8080/v1/chat/completions"],
    ["enforce", "https://openrouter.ai/api/v1/chat/completions"],
  ])("%s or unavailable utility observes without blocking", async (mode, url) => {
    const delegationEvents: unknown[] = [];
    const stdout: string[] = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({
          cwd: "/repo",
          hook_event_name: "PreToolUse",
          tool_input: { command: "git status --short" },
          tool_name: "Bash",
        })
      );
    }
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: () => undefined,
      appendDelegation: (_runDir, event) => delegationEvents.push(event),
      env: {
        LOOP_UTILITY_API_KEY_FILE: "",
        LOOP_UTILITY_DELEGATION_MODE: mode,
        LOOP_UTILITY_URL: url,
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      resolveWorkspaceRoot: () => "/repo",
      stdin: stdin(),
      writeStdout: (value) => stdout.push(value),
    });
    expect(stdout).toEqual([]);
    expect(delegationEvents).toEqual([
      expect.objectContaining({ disposition: "observed-candidate" }),
    ]);
  });

  test("off mode leaves eligible native tools untouched and unmeasured", async () => {
    const delegationEvents: unknown[] = [];
    const routeRequests: unknown[] = [];
    const stdout: string[] = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({
          cwd: "/repo",
          hook_event_name: "PreToolUse",
          tool_input: { command: "git status --short" },
          tool_name: "Bash",
        })
      );
    }
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: () => undefined,
      appendDelegation: (_runDir, event) => delegationEvents.push(event),
      appendRoute: (_runDir, request) => {
        routeRequests.push(request);
        return { jobId: "unexpected" };
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "off",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      resolveWorkspaceRoot: () => "/repo",
      stdin: stdin(),
      writeStdout: (value) => stdout.push(value),
    });
    expect(routeRequests).toEqual([]);
    expect(delegationEvents).toEqual([]);
    expect(stdout).toEqual([]);
  });

  test("automatic route failure is measured and fails open", async () => {
    const delegationEvents: unknown[] = [];
    const stdout: string[] = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({
          cwd: "/repo",
          hook_event_name: "PreToolUse",
          tool_input: { command: "git status --short" },
          tool_name: "Bash",
        })
      );
    }
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: () => undefined,
      appendDelegation: (_runDir, event) => delegationEvents.push(event),
      appendRoute: () => {
        throw new Error("store unavailable");
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "enforce",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      resolveWorkspaceRoot: () => "/repo",
      stdin: stdin(),
      writeStdout: (value) => stdout.push(value),
    });
    expect(stdout).toEqual([]);
    expect(delegationEvents).toEqual([
      expect.objectContaining({
        disposition: "route-failed",
        reason: "automatic-route-failed-open",
      }),
    ]);
  });

  test("routes an eligible command from a verified linked worktree", async () => {
    const delegationEvents: unknown[] = [];
    const routeRequests: Array<{ readScope?: string[] }> = [];
    const stdout: string[] = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({
          cwd: "/linked/packages/api",
          hook_event_name: "PreToolUse",
          tool_input: { command: "rg needle tests/router.test.ts" },
          tool_name: "Bash",
          tool_use_id: "linked-tool",
        })
      );
    }
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: () => undefined,
      appendDelegation: (_runDir, event) => delegationEvents.push(event),
      appendRoute: (_runDir, request) => {
        routeRequests.push(request);
        return { jobId: "linked-job" };
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "enforce",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      resolveWorkspaceRoot: () => "/linked",
      stdin: stdin(),
      writeStdout: (value) => stdout.push(value),
    });
    expect(routeRequests).toEqual([
      expect.objectContaining({
        readScope: ["/linked/packages/api/tests/router.test.ts"],
      }),
    ]);
    expect(delegationEvents).toEqual([
      expect.objectContaining({
        disposition: "auto-routed",
        taskId: "linked-job",
      }),
    ]);
    expect(stdout.join("")).toContain('"permissionDecision":"deny"');
  });

  test("journals unsupported and unverified automatic candidates", async () => {
    const delegationEvents: unknown[] = [];
    const run = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      workspaceRoot: string | undefined
    ) => {
      async function* stdin() {
        await Promise.resolve();
        yield new TextEncoder().encode(
          JSON.stringify({
            cwd: "/linked",
            hook_event_name: "PreToolUse",
            tool_input: toolInput,
            tool_name: toolName,
          })
        );
      }
      await runHookEmit("claude", "/run/hooks/claude.jsonl", {
        append: () => undefined,
        appendDelegation: (_runDir, event) => delegationEvents.push(event),
        env: {
          LOOP_UTILITY_DELEGATION_MODE: "enforce",
          LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
        },
        now: () => NOW,
        readManifest: () => ({ cwd: "/repo" }),
        resolveWorkspaceRoot: () => workspaceRoot,
        stdin: stdin(),
      });
    };
    await run("Edit", { file_path: "/linked/src/a.ts" }, "/linked");
    await run("Bash", { command: "rg x src && npm test" }, "/linked");
    await run("Read", { file_path: "/other/a.ts", limit: 300 }, undefined);
    expect(delegationEvents).toEqual([
      expect.objectContaining({
        disposition: "skipped-candidate",
        reason: "tool-not-enforceable",
      }),
      expect.objectContaining({
        disposition: "skipped-candidate",
        reason: "compound-or-unsafe-command",
      }),
      expect.objectContaining({
        disposition: "skipped-candidate",
        reason: "workspace-unverified",
      }),
    ]);
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
