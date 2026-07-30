import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  appendNativeFallbackRequest,
  CLAUDE_NATIVE_FALLBACK_PROFILE,
  CODEX_NATIVE_FALLBACK_PROFILE,
  CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON,
  createNativeFallbackRequest,
  processPendingNativeFallbackRequests,
  readNativeFallbackRequests,
} from "../../src/loop/native-subagent";
import { createUtilityRouteRequest } from "../../src/loop/task-router";
import {
  activateUtilityEpoch,
  appendUtilityRouteRequest,
  transitionUtilityJob,
} from "../../src/loop/utility-store";

const NOW = "2026-07-04T12:00:00.000Z";
const readyUtilityReadiness = () => ({
  ready: true,
  reason: "ready" as const,
});

const stdinPayload = (payload: unknown): AsyncIterable<Uint8Array> =>
  (async function* encodedPayload() {
    await Promise.resolve();
    yield new TextEncoder().encode(JSON.stringify(payload));
  })();

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
      readUtilityReadiness: readyUtilityReadiness,
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

  test("enforce mode routes the current Codex shell_command tool", async () => {
    const delegationEvents: unknown[] = [];
    const routeRequests: unknown[] = [];
    const stdout: string[] = [];
    await runHookEmit("codex", "/run/hooks/codex.jsonl", {
      append: () => undefined,
      appendDelegation: (_runDir, event) => delegationEvents.push(event),
      appendRoute: (_runDir, request) => {
        routeRequests.push(request);
        return { jobId: "codex-job-1" };
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "enforce",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      readUtilityReadiness: readyUtilityReadiness,
      resolveWorkspaceRoot: () => "/repo",
      stdin: stdinPayload({
        cwd: "/repo",
        hook_event_name: "PreToolUse",
        tool_input: { command: "git status --short", workdir: "/repo" },
        tool_name: "shell_command",
        tool_use_id: "codex-tool-1",
      }),
      writeStdout: (value) => stdout.push(value),
    });
    expect(routeRequests).toEqual([
      expect.objectContaining({
        idempotencyKey: "auto:codex:codex-tool-1",
        kind: "inspect",
        requester: "codex",
      }),
    ]);
    expect(delegationEvents).toEqual([
      expect.objectContaining({
        disposition: "auto-routed",
        operation: "git-status",
        taskId: "codex-job-1",
      }),
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
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
      readUtilityReadiness: readyUtilityReadiness,
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
      readUtilityReadiness: readyUtilityReadiness,
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

  test.each([
    "dispatcher-stale",
    "inference-failed",
  ] as const)("%s readiness preserves the original tool call", async (reason) => {
    const delegationEvents: unknown[] = [];
    const routeRequests: unknown[] = [];
    const stdout: string[] = [];
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: () => undefined,
      appendDelegation: (_runDir, event) => delegationEvents.push(event),
      appendRoute: (_runDir, request) => {
        routeRequests.push(request);
        return { jobId: "must-not-route" };
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "enforce",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      readUtilityReadiness: () => ({ ready: false, reason }),
      resolveWorkspaceRoot: () => "/repo",
      stdin: stdinPayload({
        cwd: "/repo",
        hook_event_name: "PreToolUse",
        tool_input: { command: "git status --short" },
        tool_name: "Bash",
        tool_use_id: `readiness-${reason}`,
      }),
      writeStdout: (value) => stdout.push(value),
    });

    expect(stdout).toEqual([]);
    expect(routeRequests).toEqual([]);
    expect(delegationEvents).toEqual([
      expect.objectContaining({
        disposition: "observed-candidate",
        reason: `utility-unavailable:${reason}`,
      }),
    ]);
  });

  test("routes an eligible command from a verified linked worktree", async () => {
    const delegationEvents: unknown[] = [];
    const routeRequests: Array<{ readScope?: string[] }> = [];
    const stdout: string[] = [];
    async function* stdin() {
      yield await Promise.resolve(
        new TextEncoder().encode(
          JSON.stringify({
            cwd: "/linked/packages/api",
            hook_event_name: "PreToolUse",
            tool_input: { command: "rg needle tests/router.test.ts" },
            tool_name: "Bash",
            tool_use_id: "linked-tool",
          })
        )
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
      readUtilityReadiness: readyUtilityReadiness,
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

  test("adopts a verified linked worktree named by a leading cd", async () => {
    const resolvedPaths: string[] = [];
    const routeRequests: Array<{
      executionProfile?: string;
      readScope?: string[];
    }> = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({
          cwd: "/repo",
          hook_event_name: "PreToolUse",
          tool_input: {
            command:
              "cd /linked/packages/api && rg needle tests/router.test.ts && ls src",
          },
          tool_name: "Bash",
          tool_use_id: "linked-cd-plan",
        })
      );
    }
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: () => undefined,
      appendDelegation: () => undefined,
      appendRoute: (_runDir, request) => {
        routeRequests.push(request);
        return { jobId: "linked-cd-job" };
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "enforce",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      readUtilityReadiness: readyUtilityReadiness,
      resolveWorkspaceRoot: (_runRoot, path) => {
        resolvedPaths.push(path);
        return path.startsWith("/linked") ? "/linked" : "/repo";
      },
      stdin: stdin(),
      writeStdout: () => undefined,
    });
    expect(resolvedPaths).toEqual(["/repo", "/linked/packages/api"]);
    expect(routeRequests).toEqual([
      expect.objectContaining({
        executionProfile: "read-plan",
        executionPlan: [
          expect.objectContaining({
            executionProfile: "search",
            readScope: ["/linked/packages/api/tests/router.test.ts"],
          }),
          expect.objectContaining({
            executionProfile: "file-list",
            readScope: ["/linked/packages/api/src"],
          }),
        ],
        readScope: [
          "/linked/packages/api/tests/router.test.ts",
          "/linked/packages/api/src",
        ],
      }),
    ]);
  });

  test("recovers a registered-worktree prefix before classifying the remainder", async () => {
    const delegationEvents: Array<{ reason?: string }> = [];
    const resolvedPaths: string[] = [];
    const routeRequests: Array<{
      executionProfile?: string;
      readScope?: string[];
    }> = [];
    const run = async (command: string, toolUseId: string) => {
      async function* stdin() {
        await Promise.resolve();
        yield new TextEncoder().encode(
          JSON.stringify({
            cwd: "/external/scratch",
            hook_event_name: "PreToolUse",
            tool_input: { command },
            tool_name: "Bash",
            tool_use_id: toolUseId,
          })
        );
      }
      await runHookEmit("claude", "/run/hooks/claude.jsonl", {
        append: () => undefined,
        appendDelegation: (_runDir, event) => delegationEvents.push(event),
        appendRoute: (_runDir, request) => {
          routeRequests.push(request);
          return { jobId: `${toolUseId}-job` };
        },
        env: {
          LOOP_UTILITY_DELEGATION_MODE: "enforce",
          LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
        },
        now: () => NOW,
        readManifest: () => ({ cwd: "/repo" }),
        readUtilityReadiness: readyUtilityReadiness,
        resolveWorkspaceRoot: (_runRoot, path) => {
          resolvedPaths.push(path);
          return path.startsWith("/linked") ? "/linked" : undefined;
        },
        stdin: stdin(),
        writeStdout: () => undefined,
      });
    };

    await run(
      "cd /linked/packages/api && sed -n '1,20p' src/router.ts; echo 'matches'; rg -n route tests | head -5",
      "safe-linked-prefix"
    );
    await run(
      'cd /linked/packages/api && echo "BRANCH: $(git branch --show-current)" && git add .',
      "unsafe-linked-prefix"
    );
    await run(
      `cd /linked/packages/api && ${"unsupported".repeat(600)}`,
      "long-unsafe-linked-prefix"
    );

    expect(resolvedPaths).toEqual([
      "/external/scratch",
      "/linked/packages/api",
      "/external/scratch",
      "/linked/packages/api",
      "/external/scratch",
      "/linked/packages/api",
    ]);
    expect(routeRequests).toEqual([
      expect.objectContaining({
        executionProfile: "read-plan",
        readScope: [
          "/linked/packages/api/src/router.ts",
          "/linked/packages/api/tests",
        ],
      }),
    ]);
    expect(delegationEvents).toEqual([
      expect.objectContaining({ disposition: "auto-routed" }),
      expect.objectContaining({
        disposition: "skipped-candidate",
        reason: "compound-or-unsafe-command",
      }),
      expect.objectContaining({
        disposition: "skipped-candidate",
        reason: "compound-or-unsafe-command",
      }),
    ]);
  });

  test("does not recover substituted or unrelated worktree prefixes", async () => {
    const delegationEvents: Array<{ reason?: string }> = [];
    const run = async (command: string) => {
      async function* stdin() {
        await Promise.resolve();
        yield new TextEncoder().encode(
          JSON.stringify({
            cwd: "/external/scratch",
            hook_event_name: "PreToolUse",
            tool_input: { command },
            tool_name: "Bash",
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
        resolveWorkspaceRoot: (_runRoot, path) =>
          path.startsWith("/linked") ? "/linked" : undefined,
        stdin: stdin(),
      });
    };

    await run("cd $WORKTREE && rg -n route src");
    await run("cd /unrelated/repo && rg -n route src");

    expect(delegationEvents).toEqual([
      expect.objectContaining({ reason: "workspace-unverified" }),
      expect.objectContaining({ reason: "workspace-unverified" }),
    ]);
  });

  test("roots a focused-check cwd and paths in a verified linked worktree", async () => {
    const routeRequests: Array<{
      executionArgv?: string[];
      executionCwd?: string;
      readScope?: string[];
    }> = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({
          cwd: "/linked/packages/api",
          hook_event_name: "PreToolUse",
          tool_input: {
            command: "npx vitest run tests/router.test.ts 2>&1 | tail -20",
          },
          tool_name: "Bash",
          tool_use_id: "linked-check",
        })
      );
    }
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: () => undefined,
      appendDelegation: () => undefined,
      appendRoute: (_runDir, request) => {
        routeRequests.push(request);
        return { jobId: "linked-check-job" };
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "enforce",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      readUtilityReadiness: readyUtilityReadiness,
      resolveWorkspaceRoot: () => "/linked",
      stdin: stdin(),
      writeStdout: () => undefined,
    });
    expect(routeRequests).toEqual([
      expect.objectContaining({
        executionArgv: [
          "npx",
          "vitest",
          "run",
          "packages/api/tests/router.test.ts",
        ],
        executionCwd: "/linked/packages/api",
        executionOutput: {
          lineLimit: 20,
          position: "tail",
          stderr: "merge",
        },
        readScope: [
          "/linked/packages/api",
          "/linked/packages/api/tests/router.test.ts",
        ],
      }),
    ]);
  });

  test("roots an exact source-slice boundary in a verified linked worktree", async () => {
    const routeRequests: Array<{
      executionRead?: {
        endLine?: number;
        lastLines?: number;
        path: string;
        startLine?: number;
      };
      readScope?: string[];
    }> = [];
    async function* stdin() {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({
          cwd: "/linked/packages/api",
          hook_event_name: "PreToolUse",
          tool_input: { command: "awk 'NR>=10 && NR<=20' src/router.ts" },
          tool_name: "Bash",
          tool_use_id: "linked-read",
        })
      );
    }
    await runHookEmit("claude", "/run/hooks/claude.jsonl", {
      append: () => undefined,
      appendDelegation: () => undefined,
      appendRoute: (_runDir, request) => {
        routeRequests.push(request);
        return { jobId: "linked-read-job" };
      },
      env: {
        LOOP_UTILITY_DELEGATION_MODE: "enforce",
        LOOP_UTILITY_URL: "http://127.0.0.1:8080/v1/chat/completions",
      },
      now: () => NOW,
      readManifest: () => ({ cwd: "/repo" }),
      readUtilityReadiness: readyUtilityReadiness,
      resolveWorkspaceRoot: () => "/linked",
      stdin: stdin(),
      writeStdout: () => undefined,
    });
    expect(routeRequests).toEqual([
      expect.objectContaining({
        executionRead: {
          endLine: 20,
          path: "/linked/packages/api/src/router.ts",
          startLine: 10,
        },
        readScope: ["/linked/packages/api/src/router.ts"],
      }),
    ]);
  });

  test("journals unsupported and unverified automatic candidates", async () => {
    const delegationEvents: unknown[] = [];
    const run = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      workspaceRoot: string | undefined
    ) => {
      async function* stdin() {
        yield await Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify({
              cwd: "/linked",
              hook_event_name: "PreToolUse",
              tool_input: toolInput,
              tool_name: toolName,
            })
          )
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
        category: "intentional-retain",
        disposition: "skipped-candidate",
        reason: "tool-not-enforceable",
      }),
      expect.objectContaining({
        category: "unsafe-reject",
        disposition: "skipped-candidate",
        reason: "compound-or-unsafe-command",
      }),
      expect.objectContaining({
        category: "unsafe-reject",
        disposition: "skipped-candidate",
        reason: "workspace-unverified",
      }),
    ]);
  });

  test("consumes one lease, binds the read-only child, and blocks mutation", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "loop-native-hook-"));
    const repo = join(runDir, "repo");
    const hookFile = join(runDir, "hooks", "claude.jsonl");
    try {
      mkdirSync(join(repo, "src", "parser"), { recursive: true });
      writeFileSync(join(repo, "src", "parser", "index.ts"), "export {};\n");
      mkdirSync(join(runDir, "outside"), { recursive: true });
      writeFileSync(join(runDir, "outside", "secret.txt"), "secret\n");
      symlinkSync(
        join(runDir, "outside"),
        join(repo, "src", "parser", "escape")
      );
      const utility = createUtilityRouteRequest({
        acceptanceCriteria: ["return evidence"],
        authority: {},
        id: "utility-hook-evidence",
        kind: "inspect",
        objective: "Inspect one source file",
        readScope: ["src/parser/index.ts"],
        requester: "claude",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      });
      appendUtilityRouteRequest(runDir, utility);
      transitionUtilityJob(runDir, utility.id, "routed-driver", {
        decision: { reason: "request-not-bounded", target: "driver" },
      });
      activateUtilityEpoch(runDir, 41);
      appendNativeFallbackRequest(
        runDir,
        createNativeFallbackRequest({
          acceptanceCriteria: ["return exact parser evidence"],
          evidenceTaskIds: [utility.id],
          fallbackReason: "utility-ineligible",
          id: "native-hook-request",
          kind: "explore",
          objective: "Trace the parser implementation",
          readScope: ["src/parser"],
          requester: "claude",
        })
      );
      processPendingNativeFallbackRequests({
        epoch: 41,
        mode: "utility-first",
        runDir,
      });

      const invoke = async (
        payload: unknown
      ): Promise<Record<string, unknown>> => {
        let output = "";
        await runHookEmit("claude", hookFile, {
          env: { LOOP_NATIVE_SUBAGENT_MODE: "utility-first" },
          readManifest: () => ({ cwd: repo }),
          stdin: stdinPayload(payload),
          writeStdout: (value) => {
            output += value;
          },
        });
        return output.trim()
          ? (JSON.parse(output) as Record<string, unknown>)
          : {};
      };

      const spawn = await invoke({
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_input: { subagent_type: CLAUDE_NATIVE_FALLBACK_PROFILE },
        tool_name: "Agent",
        tool_use_id: "spawn-1",
      });
      expect(spawn).toEqual({});

      const start = await invoke({
        agent_id: "child-hook-1",
        agent_type: CLAUDE_NATIVE_FALLBACK_PROFILE,
        cwd: repo,
        hook_event_name: "SubagentStart",
      });
      expect(JSON.stringify(start)).toContain(
        "Allowed read scopes: src/parser"
      );

      const read = await invoke({
        agent_id: "child-hook-1",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_input: { file_path: join(repo, "src/parser/index.ts") },
        tool_name: "Read",
      });
      expect(read).toEqual({});

      const recursive = await invoke({
        agent_id: "child-hook-1",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_input: { path: join(repo, "src/parser"), pattern: "export" },
        tool_name: "Grep",
      });
      expect(recursive).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });

      const symlinkEscape = await invoke({
        agent_id: "child-hook-1",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_input: {
          file_path: join(repo, "src/parser/escape/secret.txt"),
        },
        tool_name: "Read",
      });
      expect(symlinkEscape).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });

      const write = await invoke({
        agent_id: "child-hook-1",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_input: { file_path: join(repo, "src/parser/index.ts") },
        tool_name: "Write",
      });
      expect(write).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });

      const shell = await invoke({
        agent_id: "child-hook-1",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_input: {
          command: "sed -n '1,20p' src/parser/index.ts",
        },
        tool_name: "Bash",
      });
      expect(shell).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });

      // PARENT-level fleet surface. TeamCreate ships in Claude Code 2.1.220 and
      // does NOT route through Agent, so gating Agent alone left a bypass: the
      // main agent could raise a whole team with no lease. Asserted without an
      // `agent_id` on purpose — a child-scoped assertion proves nothing here,
      // because the leased child's Read/Grep allowlist already denies every
      // other tool whether or not the spawn gate knows about TeamCreate.
      const parentTeam = await invoke({
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_input: { description: "spin up reviewers" },
        tool_name: "TeamCreate",
        tool_use_id: "team-1",
      });
      expect(parentTeam).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });

      await invoke({
        agent_id: "child-hook-1",
        agent_type: CLAUDE_NATIVE_FALLBACK_PROFILE,
        cwd: repo,
        hook_event_name: "SubagentStop",
      });
      expect(readNativeFallbackRequests(runDir)[0]?.state).toBe("completed");
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });

  test("Codex utility-first hooks deny native spawn and every child tool", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "loop-native-codex-hook-"));
    const repo = join(runDir, "repo");
    const hookFile = join(runDir, "hooks", "codex.jsonl");
    try {
      mkdirSync(join(repo, "src", "parser"), { recursive: true });
      writeFileSync(join(repo, "src", "parser", "index.ts"), "export {};\n");
      writeFileSync(join(repo, "src", "parser", "second-command"), "noop\n");
      writeFileSync(
        join(repo, "src", "parser", "oversized.ts"),
        Buffer.alloc(1024 * 1024 + 1)
      );
      writeFileSync(join(repo, "outside.ts"), "export {};\n");
      const utility = createUtilityRouteRequest({
        acceptanceCriteria: ["return evidence"],
        authority: {},
        id: "utility-codex-evidence",
        kind: "inspect",
        objective: "Inspect one source file",
        readScope: ["src/parser/index.ts"],
        requester: "codex",
        requiredCapabilities: ["inspect"],
        risk: "low",
        writeScope: [],
      });
      appendUtilityRouteRequest(runDir, utility);
      transitionUtilityJob(runDir, utility.id, "routed-driver", {
        decision: { reason: "request-not-bounded", target: "driver" },
      });
      activateUtilityEpoch(runDir, 42);
      appendNativeFallbackRequest(
        runDir,
        createNativeFallbackRequest({
          acceptanceCriteria: ["return exact parser evidence"],
          evidenceTaskIds: [utility.id],
          fallbackReason: "utility-ineligible",
          id: "native-codex-hook-request",
          kind: "explore",
          objective: "Trace the parser implementation",
          readScope: ["src/parser"],
          requester: "codex",
        })
      );
      processPendingNativeFallbackRequests({
        epoch: 42,
        mode: "utility-first",
        runDir,
      });
      expect(readNativeFallbackRequests(runDir)[0]).toMatchObject({
        reason: CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON,
        state: "denied",
      });

      const invoke = async (
        payload: unknown,
        nativeChildContext = false
      ): Promise<Record<string, unknown>> => {
        let output = "";
        await runHookEmit("codex", hookFile, {
          env: { LOOP_NATIVE_SUBAGENT_MODE: "utility-first" },
          nativeChildContext,
          readManifest: () => ({ cwd: repo }),
          stdin: stdinPayload(payload),
          writeStdout: (value) => {
            output += value;
          },
        });
        return output.trim()
          ? (JSON.parse(output) as Record<string, unknown>)
          : {};
      };

      expect(
        await invoke({
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: { agent_type: CODEX_NATIVE_FALLBACK_PROFILE },
          tool_name: "spawn_agent",
          tool_use_id: "codex-spawn-1",
        })
      ).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining(
            CODEX_NATIVE_FALLBACK_UNAVAILABLE_REASON
          ),
        },
      });
      await invoke({
        agent_id: "codex-child-1",
        agent_type: CODEX_NATIVE_FALLBACK_PROFILE,
        cwd: repo,
        hook_event_name: "SubagentStart",
      });

      const canonicalRepo = realpathSync(repo);
      const canonicalFile = join(canonicalRepo, "src/parser/index.ts");
      const canonicalOversized = join(canonicalRepo, "src/parser/oversized.ts");
      const systemSed = realpathSync("/usr/bin/sed");
      const systemHead = realpathSync("/usr/bin/head");

      const boundedSed = await invoke({
        agent_id: "codex-child-1",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_input: {
          command: `${systemSed} -n '1,20p' ${canonicalFile}`,
          login: false,
          workdir: canonicalRepo,
        },
        tool_name: "Bash",
      });
      expect(boundedSed).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      const documentedChildPayload = await invoke(
        {
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `${systemSed} -n '1,20p' ${canonicalFile}`,
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "Bash",
        },
        true
      );
      expect(documentedChildPayload).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke(
          {
            cwd: repo,
            hook_event_name: "PreToolUse",
            tool_input: {
              command: `${systemSed} -n '1,20p' ${join(canonicalRepo, "outside.ts")}`,
              login: false,
              workdir: canonicalRepo,
            },
            tool_name: "Bash",
          },
          true
        )
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: "rg --no-config 'export' -- src/parser/index.ts",
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `${systemHead} -n 20 -- ${canonicalOversized}`,
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "Bash",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `${systemHead} -n 501 -- ${canonicalFile}`,
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "Bash",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: "rg --no-config '' AGENTS.md -- src/parser/index.ts",
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "Bash",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: "rg 'export' -- src/parser/index.ts",
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: "rg --no-config 'export' -- src/parser",
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `${systemSed} -n '1,20p' ${join(canonicalRepo, "outside.ts")}`,
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `${systemSed} -n '1,20p' ${canonicalFile}; uname -a`,
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `${systemSed} -n '1,20p' ${canonicalFile}\n${join(canonicalRepo, "src/parser/second-command")}`,
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `sed -n '1,20p' ${canonicalFile}`,
            login: false,
            workdir: canonicalRepo,
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `${systemSed} -n '1,20p' ${canonicalFile}`,
            login: true,
            workdir: canonicalRepo,
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      expect(
        await invoke({
          agent_id: "codex-child-1",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_input: {
            command: `${systemSed} -n '1,20p' ${canonicalFile}`,
            login: false,
            workdir: join(canonicalRepo, "src"),
          },
          tool_name: "shell_command",
        })
      ).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });

  test("off mode leaves native root, lifecycle, and child hooks untouched", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "loop-native-hook-off-"));
    try {
      const invoke = async (payload: unknown): Promise<string> => {
        let output = "";
        await runHookEmit("codex", join(runDir, "hooks", "codex.jsonl"), {
          env: { LOOP_NATIVE_SUBAGENT_MODE: "off" },
          stdin: stdinPayload(payload),
          writeStdout: (value) => {
            output += value;
          },
        });
        return output;
      };
      expect(
        await invoke({
          hook_event_name: "PreToolUse",
          tool_name: "spawn_agent",
        })
      ).toBe("");
      expect(
        await invoke({
          agent_id: "ordinary-child",
          hook_event_name: "SubagentStart",
        })
      ).toBe("");
      expect(
        await invoke({
          agent_id: "ordinary-child",
          hook_event_name: "PreToolUse",
          tool_input: { command: "git status" },
          tool_name: "shell_command",
        })
      ).toBe("");
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });

  test("strict mode blocks Codex native spawn without a lease", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "loop-native-hook-strict-"));
    let output = "";
    try {
      await runHookEmit("codex", join(runDir, "hooks", "codex.jsonl"), {
        env: { LOOP_NATIVE_SUBAGENT_MODE: "strict" },
        stdin: stdinPayload({
          cwd: join(runDir, "repo"),
          hook_event_name: "PreToolUse",
          tool_input: { agent_type: "loop_readonly_fallback" },
          tool_name: "spawn_agent",
        }),
        writeStdout: (value) => {
          output += value;
        },
      });
      expect(JSON.parse(output)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("strict-mode"),
        },
      });
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
  });

  test("native spawn still fails closed when hook telemetry cannot append", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "loop-native-hook-append-"));
    let output = "";
    try {
      await runHookEmit("codex", join(runDir, "hooks", "codex.jsonl"), {
        append: () => {
          throw new Error("telemetry unavailable");
        },
        env: { LOOP_NATIVE_SUBAGENT_MODE: "strict" },
        stdin: stdinPayload({
          hook_event_name: "PreToolUse",
          tool_input: { agent_type: "loop_readonly_fallback" },
          tool_name: "spawn_agent",
        }),
        writeStdout: (value) => {
          output += value;
        },
      });
      expect(JSON.parse(output)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("strict-mode"),
        },
      });
    } finally {
      rmSync(runDir, { force: true, recursive: true });
    }
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

  test("builds an explicit profile-specific native child command", () => {
    expect(
      buildHookCommand(
        ["bun", "src/cli.ts"],
        "codex",
        "/run/hooks/codex-native-child.jsonl",
        "native-child"
      )
    ).toContain("'native-child'");
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

  test("Codex hooks.json registers tool and subagent lifecycle events", () => {
    const hooks = buildCodexHooksJson(command);
    expect(Object.keys(hooks.hooks).sort()).toEqual(
      [...CODEX_HOOK_EVENTS].sort()
    );
    expect(hooks.hooks.PreToolUse?.[0]?.hooks[0]).toEqual({
      command,
      type: "command",
    });
    expect(hooks.hooks.SubagentStart?.[0]?.hooks[0]).toEqual({
      command,
      type: "command",
    });
  });
});
