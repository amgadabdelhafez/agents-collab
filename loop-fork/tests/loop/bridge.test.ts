import { afterEach, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDelegationEvents } from "../../src/loop/delegation-policy";
import { readRunManifest } from "../../src/loop/run-state";

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const loadBridge = (
  overrides: {
    injectCodexMessage?: (...args: string[]) => Promise<boolean>;
  } = {}
) => {
  mock.restore();
  mock.module("../../src/loop/launch", () => ({
    buildLaunchArgv: mock(() => ["/opt/bun", "src/loop/main.ts"]),
  }));
  if (overrides.injectCodexMessage) {
    mock.module("../../src/loop/codex-app-server", () => ({
      injectCodexMessage: overrides.injectCodexMessage,
    }));
  }
  const nonce = Date.now();
  return Promise.all([
    import(`../../src/loop/bridge?test=${nonce}`),
    import(`../../src/loop/bridge-claude-registration?test=${nonce}`),
    import(`../../src/loop/bridge-dispatch?test=${nonce}`),
    import(`../../src/loop/bridge-config?test=${nonce}`),
    import(`../../src/loop/bridge-constants?test=${nonce}`),
    import(`../../src/loop/bridge-runtime?test=${nonce}`),
    import(`../../src/loop/bridge-store?test=${nonce}`),
  ]).then(
    ([bridge, registration, dispatch, config, constants, runtime, store]) => ({
      ...bridge,
      ...registration,
      ...dispatch,
      ...config,
      ...constants,
      ...runtime,
      ...store,
    })
  );
};

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-bridge-"));
const encodeFrame = (payload: unknown): string => {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
};
const encodeLine = (payload: unknown): string => `${JSON.stringify(payload)}\n`;
const parseJsonLines = (text: string): Record<string, unknown>[] =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const listedTools = (stdout: string): Record<string, unknown>[] => {
  const toolsResponse = parseJsonLines(stdout).find(
    (response) => response.id === 6
  );
  return (
    (toolsResponse?.result as { tools?: Record<string, unknown>[] } | undefined)
      ?.tools ?? []
  );
};
const toolText = (stdout: string, id: number): string => {
  const response = parseJsonLines(stdout).find((entry) => entry.id === id);
  const content = (
    response?.result as { content?: Array<{ text?: string }> } | undefined
  )?.content;
  return content?.[0]?.text ?? "";
};

const runBridgeProcess = async (
  runDir: string,
  source: "claude" | "codex" | "supervisor",
  frames: string,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number | null; stderr: string; stdout: string }> => {
  const cli = join(process.cwd(), "src", "cli.ts");
  const child = spawn(process.execPath, [cli, "__bridge-mcp", runDir, source], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(frames);
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  return { code, stderr, stdout };
};

const startLiveBridgeProcess = (
  runDir: string,
  source: "claude" | "codex",
  env?: NodeJS.ProcessEnv
): {
  close: () => Promise<{ code: number | null; stderr: string; stdout: string }>;
  write: (frame: string) => void;
  waitForStdout: (pattern: string, timeoutMs?: number) => Promise<void>;
} => {
  const cli = join(process.cwd(), "src", "cli.ts");
  const child = spawn(process.execPath, [cli, "__bridge-mcp", runDir, source], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    close: async () => {
      child.stdin.end();
      const code = await new Promise<number | null>((resolve) => {
        child.on("close", resolve);
      });
      return { code, stderr, stdout };
    },
    write: (frame) => {
      child.stdin.write(frame);
    },
    waitForStdout: async (pattern, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stdout.includes(pattern)) {
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      throw new Error(`timed out waiting for stdout to contain: ${pattern}`);
    },
  };
};

afterEach(() => {
  mock.restore();
});

test("bridge MCP detects reparented and missing parents", async () => {
  const bridge = await loadBridge();
  const alive = mock(() => true);
  const missing = mock(() => {
    const error = new Error("missing") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  });
  const forbidden = mock(() => {
    const error = new Error("forbidden") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  });

  expect(bridge.bridgeInternals.bridgeParentIsGone(42, 1, alive)).toBe(true);
  expect(bridge.bridgeInternals.bridgeParentIsGone(42, 42, alive)).toBe(false);
  expect(bridge.bridgeInternals.bridgeParentIsGone(42, 42, missing)).toBe(true);
  expect(bridge.bridgeInternals.bridgeParentIsGone(42, 42, forbidden)).toBe(
    false
  );
});

test("bridge message parsing ignores malformed lines and acked entries", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  const bridgeFile = bridge.bridgeInternals.bridgePath(runDir);
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridgeFile,
    [
      "not-json",
      JSON.stringify({
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "hello codex",
        source: "claude",
        target: "codex",
      }),
      JSON.stringify({
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-2",
        kind: "message",
        message: "hello claude",
        source: "codex",
        target: "claude",
      }),
      JSON.stringify({
        at: "2026-03-22T10:02:00.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      }),
      JSON.stringify({
        at: "2026-03-22T10:03:00.000Z",
        id: "msg-2",
        kind: "blocked",
        reason: "busy",
        source: "codex",
        target: "claude",
      }),
    ].join("\n"),
    "utf8"
  );

  expect(bridge.bridgeInternals.readBridgeEvents(runDir)).toHaveLength(4);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("bridge preserves utility results without treating utility as a full agent", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  bridge.appendBridgeMessage(
    runDir,
    "utility",
    "claude",
    "small task completed",
    {
      artifactRefs: ["lower/jobs/job-1/result.json"],
      taskId: "job-1",
      type: "ack",
    }
  );

  expect(bridge.readBridgeInbox(runDir, "claude")).toEqual([
    expect.objectContaining({
      artifactRefs: ["lower/jobs/job-1/result.json"],
      message: "small task completed",
      source: "utility",
      target: "claude",
      taskId: "job-1",
    }),
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("markBridgeMessage records acknowledgements and clears pending entries", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const bridgeFile = bridge.bridgeInternals.bridgePath(runDir);
  const message = {
    at: "2026-03-22T10:00:00.000Z",
    id: "msg-1",
    kind: "message" as const,
    message: "ship it",
    source: "claude" as const,
    target: "codex" as const,
  };

  writeFileSync(bridgeFile, `${JSON.stringify(message)}\n`, "utf8");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining(message),
  ]);

  bridge.markBridgeMessage(runDir, message, "delivered", "sent");

  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(bridge.bridgeInternals.readBridgeEvents(runDir)).toEqual([
    expect.objectContaining(message),
    expect.objectContaining({
      id: "msg-1",
      kind: "delivered",
      reason: "sent",
      source: "claude",
      target: "codex",
    }),
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("readBridgeStatus derives bridge naming and transport fields", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-27T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      state: "submitted",
      status: "running",
      updatedAt: "2026-03-27T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.readBridgeStatus(runDir)).toMatchObject({
    bridgeServer: bridge.BRIDGE_SERVER,
    claudeBridgeMode: "mcp-config",
    claudeChannelServer: bridge.claudeChannelServerName("7", "repo-123"),
    claudeSessionId: "claude-session-1",
    codexRemoteUrl: "ws://127.0.0.1:4500",
    codexThreadId: "codex-thread-1",
    hasCodexRemote: true,
    hasTmuxSession: false,
    pending: { claude: 0, codex: 0 },
    qos: {
      deadLetters: 0,
      expired: 0,
      pending: 0,
      superseded: 0,
    },
    runId: "7",
    state: "submitted",
    status: "running",
    tmuxSession: "",
  });

  rmSync(root, { recursive: true, force: true });
});

test("readBridgeRuntimeStatus distinguishes live and stale tmux delivery", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      const session = args[3];
      return {
        exitCode: session === "repo-loop-live" ? 0 : 1,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const liveRunDir = join(root, "live");
  const staleRunDir = join(root, "stale");
  mkdirSync(liveRunDir, { recursive: true });
  mkdirSync(staleRunDir, { recursive: true });

  writeFileSync(
    join(liveRunDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-live",
      createdAt: "2026-03-27T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "running",
      status: "running",
      tmuxSession: "repo-loop-live",
      updatedAt: "2026-03-27T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  writeFileSync(
    join(staleRunDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-stale",
      createdAt: "2026-03-27T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "9",
      state: "running",
      status: "running",
      tmuxSession: "repo-loop-stale",
      updatedAt: "2026-03-27T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.readBridgeRuntimeStatus(liveRunDir)).toMatchObject({
    claudeBridgeMode: "mcp-config",
    claudeChannelServer: bridge.claudeChannelServerName("8", "repo-123"),
    codexDeliveryMode: "tmux-proxy",
    hasCodexRemote: true,
    hasLiveTmuxSession: true,
    hasTmuxSession: true,
  });
  expect(bridge.readBridgeRuntimeStatus(staleRunDir)).toMatchObject({
    claudeBridgeMode: "mcp-config",
    claudeChannelServer: bridge.claudeChannelServerName("9", "repo-123"),
    codexDeliveryMode: "app-server",
    hasCodexRemote: true,
    hasLiveTmuxSession: false,
    hasTmuxSession: true,
  });

  rmSync(root, { recursive: true, force: true });
});

test("readPendingBridgeMessages keeps repeated messages until each is acknowledged", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const bridgeFile = bridge.bridgeInternals.bridgePath(runDir);

  writeFileSync(
    bridgeFile,
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "same",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-2",
        kind: "message",
        message: "same",
        source: "claude",
        target: "codex",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  expect(bridge.readPendingBridgeMessages(runDir)).toHaveLength(2);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({ id: "msg-1", message: "same" }),
    expect.objectContaining({ id: "msg-2", message: "same" }),
  ]);

  bridge.markBridgeMessage(
    runDir,
    {
      at: "2026-03-22T10:00:00.000Z",
      id: "msg-1",
      kind: "message",
      message: "same",
      source: "claude",
      target: "codex",
    },
    "delivered",
    "sent"
  );

  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({ id: "msg-2", message: "same" }),
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge normalization treats short and legacy Claude prefixes as equivalent", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const bridgeFile = bridge.bridgeInternals.bridgePath(runDir);

  writeFileSync(
    bridgeFile,
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message:
          "Message from Claude via the loop bridge:\n\nPlease verify the final diff.",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  expect(
    bridge.blocksBridgeBounce(
      runDir,
      "codex",
      "claude",
      "Claude: Please verify the final diff."
    )
  ).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_message queues a direct message through the CLI path", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "codex",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("queued");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({
      message: "ship it",
      source: "claude",
      target: "codex",
    }),
  ]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "message")
  ).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_message normalizes target case and whitespace", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "  CLAUDE  ",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("queued");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({
      message: "ship it",
      source: "codex",
      target: "claude",
    }),
  ]);
  rmSync(root, { recursive: true, force: true });
});

test.each([
  "claude",
  "codex",
] as const)("bridge MCP route_task queues a bounded request from %s", async (source) => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    source,
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          acceptance_criteria: ["find the defining file"],
          context_refs: ["./docs/guide.md", "README.md"],
          idempotency_key: "API_KEY=super-secret-idempotency-value",
          kind: "inspect",
          objective: "Locate the bridge server definition",
          read_scope: ["src/loop"],
        },
        name: "route_task",
      },
    })
  );

  expect(result.code).toBe(0);
  const routed = JSON.parse(toolText(result.stdout, 1)) as {
    state: string;
    taskId: string;
  };
  expect(routed.state).toBe("pending-route");
  const delegationEvents = readDelegationEvents(runDir);
  expect(delegationEvents).toEqual([
    expect.objectContaining({
      agent: source,
      disposition: "explicit-routed",
      operation: "inspect",
      source: "bridge",
      taskId: routed.taskId,
    }),
  ]);
  expect(delegationEvents[0]?.fingerprint).toMatch(SHA256_HEX_RE);
  expect(JSON.stringify(delegationEvents)).not.toContain(
    "super-secret-idempotency-value"
  );
  expect(
    readFileSync(join(runDir, "utility", "jobs.jsonl"), "utf8")
  ).not.toContain("super-secret-idempotency-value");
  expect(readFileSync(join(runDir, "utility", "jobs.jsonl"), "utf8")).toContain(
    '"contextRefs":["docs/guide.md","README.md"]'
  );
  const status = await runBridgeProcess(
    runDir,
    source,
    encodeFrame({
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { task_id: routed.taskId },
        name: "task_status",
      },
    })
  );
  expect(JSON.parse(toolText(status.stdout, 2))).toMatchObject({
    state: "pending-route",
    taskId: routed.taskId,
  });
  rmSync(root, { recursive: true, force: true });
});

test("route_task gives edit-specific recovery guidance", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          acceptance_criteria: ["propose one exact patch"],
          execution_profile: "search",
          kind: "edit",
          objective: "Add one parser branch",
          read_scope: ["src/parser.ts"],
          write_scope: ["src/parser.ts"],
        },
        name: "route_task",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "use one to four exact read files, one or two exact write files repeated in read_scope"
  );
  expect(result.stdout).toContain("no execution_profile, execution_plan");
  expect(existsSync(join(runDir, "utility", "jobs.jsonl"))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("route_task rejects narrative context refs before creating a doomed job", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          acceptance_criteria: ["cite every occurrence"],
          context_refs: [
            "Supervisor ruling: accepted shut",
            "/private/tmp/repo/docs/result.md",
          ],
          kind: "inspect",
          objective: "Audit three carrying documents",
          read_scope: ["STATUS.md", "docs/result.md", "docs/comment.md"],
        },
        name: "route_task",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "context_refs accepts only unique repo-relative README.md"
  );
  expect(result.stdout).toContain(
    "put narrative facts, SHAs, source files, and absolute paths in objective or acceptance_criteria"
  );
  expect(existsSync(join(runDir, "utility", "jobs.jsonl"))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("route_task rejects traversal-form context refs before normalization", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          acceptance_criteria: ["return bounded evidence"],
          context_refs: ["docs/topic/../result.md"],
          kind: "inspect",
          objective: "Read one project context document",
          read_scope: ["docs/result.md"],
        },
        name: "route_task",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "context_refs accepts only unique repo-relative README.md"
  );
  expect(existsSync(join(runDir, "utility", "jobs.jsonl"))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("route_task persists a structured bounded read plan", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          acceptance_criteria: ["return bounded evidence"],
          context_refs: ["docs/guide.md"],
          execution_plan: [
            {
              execution_profile: "git-status",
              objective: "Inspect worktree state",
              read_scope: ["."],
            },
            {
              execution_profile: "file-read",
              execution_read: {
                end_line: 5,
                path: "README.md",
                start_line: 1,
              },
              objective: "Read the exact introduction",
              read_scope: ["README.md"],
            },
            {
              execution_output: { line_limit: 20, position: "head" },
              execution_profile: "search",
              objective: "Search the declared docs scope",
              read_scope: ["docs"],
            },
          ],
          execution_profile: "read-plan",
          kind: "inspect",
          objective: "Run one structured bounded inspection plan",
          read_scope: [".", "README.md", "docs"],
        },
        name: "route_task",
      },
    })
  );

  const routed = JSON.parse(toolText(result.stdout, 1)) as {
    state: string;
    taskId: string;
  };
  expect(routed.state).toBe("pending-route");
  const records = readFileSync(join(runDir, "utility", "jobs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const request = records[0]?.request as Record<string, unknown>;
  expect(request.executionProfile).toBe("read-plan");
  expect(request.executionPlan).toEqual([
    {
      executionProfile: "git-status",
      objective: "Inspect worktree state",
      readScope: ["."],
    },
    {
      executionProfile: "file-read",
      executionRead: {
        endLine: 5,
        path: "README.md",
        startLine: 1,
      },
      objective: "Read the exact introduction",
      readScope: ["README.md"],
    },
    {
      executionOutput: { lineLimit: 20, position: "head" },
      executionProfile: "search",
      objective: "Search the declared docs scope",
      readScope: ["docs"],
    },
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("route_task drains only older unclaimed helper results for its caller", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const bridge = await loadBridge();
  const helper = bridge.appendBridgeMessage(
    runDir,
    "utility",
    "codex",
    "completed old helper result",
    { taskId: "old-helper" }
  );
  bridge.appendBridgeMessage(runDir, "claude", "codex", "peer message");
  bridge.appendBridgeMessage(
    runDir,
    "utility",
    "claude",
    "other requester result",
    { taskId: "other-helper" }
  );
  const claimed = bridge.appendBridgeMessage(
    runDir,
    "utility",
    "codex",
    "claimed helper result",
    { taskId: "claimed-helper" }
  );
  const claimDir = join(runDir, "bridge-delivery-claims");
  mkdirSync(claimDir, { recursive: true });
  writeFileSync(
    join(
      claimDir,
      `${createHash("sha256").update(claimed.id).digest("hex")}.lock`
    ),
    "claimed\n"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          acceptance_criteria: ["locate it"],
          kind: "inspect",
          objective: "Locate another bounded definition",
          read_scope: ["src/loop"],
        },
        name: "route_task",
      },
    })
  );
  const routed = JSON.parse(toolText(result.stdout, 1)) as {
    priorHelperResults?: Array<{ id: string; message: string }>;
  };
  expect(routed.priorHelperResults).toEqual([
    expect.objectContaining({
      id: helper.id,
      message: "completed old helper result",
    }),
  ]);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: "peer message" }),
      expect.objectContaining({ message: "other requester result" }),
      expect.objectContaining({ message: "claimed helper result" }),
    ])
  );
  expect(bridge.readPendingBridgeMessages(runDir)).toHaveLength(3);
  rmSync(root, { recursive: true, force: true });
});

test("external supervisor can submit a task with an explicit result target", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const bridge = await loadBridge();
  bridge.appendBridgeMessage(
    runDir,
    "utility",
    "codex",
    "supervisor must not consume this",
    { taskId: "supervisor-helper" }
  );
  const result = await runBridgeProcess(
    runDir,
    "supervisor",
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          acceptance_criteria: ["locate it"],
          kind: "inspect",
          objective: "Locate a bounded definition",
          read_scope: ["src/loop"],
          requester: "codex",
        },
        name: "route_task",
      },
    })
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(toolText(result.stdout, 1))).toMatchObject({
    state: "pending-route",
  });
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({ message: "supervisor must not consume this" }),
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("external supervisor cannot apply a utility patch", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const result = await runBridgeProcess(
    runDir,
    "supervisor",
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          expected_patch_sha256: "a".repeat(64),
          task_id: "not-applicable",
        },
        name: "apply_task_patch",
      },
    })
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "apply_task_patch is restricted to a full in-loop agent"
  );
  rmSync(root, { recursive: true, force: true });
});

test("Codex-to-Claude dispatch attempts immediate visible pane delivery", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("❯\n\nOpus 5 · bypass permissions on", "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  let transcriptReads = 0;
  const transcriptVersion = mock(() =>
    transcriptReads++ === 0 ? "before" : "after"
  );
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion =
    transcriptVersion;
  bridge.bridgeInternals.commandDeps.readClaudeTranscriptVersion =
    transcriptVersion;
  bridge.bridgeInternals.commandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const result = await bridge.dispatchBridgeMessage(
    runDir,
    "codex",
    "claude",
    "Review the new verdict.",
    bridge.immediateBridgeDelivery(runDir, "claude")
  );

  expect(result.status).toBe("delivered");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(spawnSync.mock.calls).toContainEqual([
    ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "Enter"],
    { stderr: "ignore" },
  ]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
      .map((event) => event.reason)
  ).toEqual(["sent to claude tmux pane"]);

  rmSync(root, { recursive: true, force: true });
});

test("Claude delivery retries a stranded composer with space then Enter", async () => {
  let captureCalls = 0;
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      captureCalls += 1;
      const pane =
        captureCalls <= 2 || captureCalls >= 4
          ? "❯\n\nOpus 5 · bypass permissions on"
          : "❯ [bridge:msg-claude-r] Message from Codex via the loop bridge:\n\nOpus 5";
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(pane, "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  let transcriptReads = 0;
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion = mock(() => {
    transcriptReads += 1;
    return transcriptReads < 10 ? "before" : "after";
  });
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-claude-retry",
    kind: "message" as const,
    message: "Retry this submission.",
    source: "codex" as const,
    target: "claude" as const,
  };
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);

  expect(await bridge.deliverTmuxBridgeMessage(runDir, message)).toBe(true);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) => args[0] === "tmux" && args.at(-1) === "Enter"
    )
  ).toHaveLength(2);
  expect(spawnSync.mock.calls).toContainEqual([
    ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "-l", "--", " "],
    { stderr: "ignore" },
  ]);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("Claude delivery does not inject into an active turn with an empty composer", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("Working…\n\n❯\n\nOpus 5", "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(join(runDir, "hooks"), { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  writeFileSync(
    join(runDir, "hooks", "claude.jsonl"),
    `${JSON.stringify({
      agent: "claude",
      event: "PostToolUse",
      state: "working",
      ts: "2026-03-23T10:01:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:01.000Z",
    id: "msg-claude-busy",
    kind: "message" as const,
    message: "Wait until this turn finishes.",
    source: "utility" as const,
    target: "claude" as const,
  };
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);

  expect(await bridge.deliverTmuxBridgeMessage(runDir, message)).toBe(false);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) => args[0] === "tmux" && args[1] === "send-keys"
    )
  ).toHaveLength(0);
  expect(bridge.readPendingBridgeMessages(runDir)).toHaveLength(1);
  expect(bridge.readPendingBridgeMessages(runDir)[0]).toMatchObject(message);

  rmSync(root, { recursive: true, force: true });
});

const IDLE_CLAUDE_MANIFEST = {
  createdAt: "2026-03-23T10:00:00.000Z",
  cwd: "/repo",
  mode: "paired",
  pid: 1234,
  repoId: "repo-123",
  runId: "8",
  state: "working",
  status: "running",
  tmuxPaneLeftAgent: "claude",
  tmuxPaneRightAgent: "codex",
  tmuxSession: "repo-loop-8",
  updatedAt: "2026-03-23T10:00:00.000Z",
};

const writeIdleClaudeRun = (runDir: string): void => {
  mkdirSync(join(runDir, "hooks"), { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify(IDLE_CLAUDE_MANIFEST)}\n`,
    "utf8"
  );
  writeFileSync(
    join(runDir, "hooks", "claude.jsonl"),
    `${JSON.stringify({
      agent: "claude",
      event: "Stop",
      state: "input-required",
      ts: "2026-03-23T10:00:30.000Z",
    })}\n`,
    "utf8"
  );
};

test("Claude delivery injects over a dim type-ahead suggestion", async () => {
  const ghostPane =
    "\u001B[39m❯ \u001B[2mwait for codex's verdict\u001B[0m\n\nOpus 5 | ctx: 59%";
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(ghostPane, "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  let transcriptReads = 0;
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion = mock(() => {
    transcriptReads += 1;
    return transcriptReads === 1 ? "before" : "after";
  });
  const root = makeTempDir();
  const runDir = join(root, "run");
  writeIdleClaudeRun(runDir);
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-claude-ghost",
    kind: "message" as const,
    message: "The ledger verdict is ready.",
    source: "codex" as const,
    target: "claude" as const,
  };
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);

  expect(await bridge.deliverTmuxBridgeMessage(runDir, message)).toBe(true);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) => args[0] === "tmux" && args.at(-1) === "Enter"
    )
  ).toHaveLength(1);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("Claude delivery holds no claim while the pane is not ready", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  writeIdleClaudeRun(runDir);
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-claude-draft-blocked",
    kind: "message" as const,
    message: "Wait for the composer to clear.",
    source: "codex" as const,
    target: "claude" as const,
  };
  const claimPath = join(
    runDir,
    "bridge-delivery-claims",
    `${createHash("sha256").update(message.id).digest("hex")}.lock`
  );
  const claimSeenDuringWait: boolean[] = [];
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      claimSeenDuringWait.push(existsSync(claimPath));
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("❯ human draft\n\nOpus 5 | ctx: 59%", "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);

  expect(await bridge.deliverTmuxBridgeMessage(runDir, message)).toBe(false);
  expect(claimSeenDuringWait.length).toBeGreaterThan(0);
  expect(claimSeenDuringWait.every((seen) => !seen)).toBe(true);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) => args[0] === "tmux" && args[1] === "send-keys"
    )
  ).toHaveLength(0);
  expect(bridge.readPendingBridgeMessages(runDir)).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("Claude delivery aborts without typing when the message is consumed mid-wait", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  writeIdleClaudeRun(runDir);
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-claude-consumed",
    kind: "message" as const,
    message: "Polled while delivery was waiting.",
    source: "codex" as const,
    target: "claude" as const,
  };
  let consumed = false;
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      if (!consumed) {
        consumed = true;
        bridge.consumeBridgeInbox(runDir, "claude", "polled during wait");
      }
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("❯\n\nOpus 5 | ctx: 59%", "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);

  expect(await bridge.deliverTmuxBridgeMessage(runDir, message)).toBe(false);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) => args[0] === "tmux" && args[1] === "send-keys"
    )
  ).toHaveLength(0);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("Claude submission evidence advances when the hook journal advances", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  const hooksDir = join(runDir, "hooks");
  const projectsDir = join(root, "projects");
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(hooksDir, "claude.jsonl"), '{"event":"Stop"}\n');

  const before = bridge.readClaudeSubmissionVersion(runDir, projectsDir);
  writeFileSync(
    join(hooksDir, "claude.jsonl"),
    '{"event":"Stop"}\n{"event":"UserPromptSubmit"}\n'
  );
  const after = bridge.readClaudeSubmissionVersion(runDir, projectsDir);

  expect(before).toBeDefined();
  expect(after).toBeDefined();
  expect(after).not.toBe(before);
  rmSync(root, { recursive: true, force: true });
});

test("Claude delivery confirms when submission evidence advances into an active pane", async () => {
  let captureCalls = 0;
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      captureCalls += 1;
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          captureCalls <= 2
            ? "❯\n\nOpus 5 · bypass permissions on"
            : "⏺ Working… (1s · esc to interrupt)\n\nOpus 5",
          "utf8"
        ),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  let evidenceReads = 0;
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion = mock(() =>
    evidenceReads++ === 0 ? "before" : "after"
  );
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-claude-active-confirm",
    kind: "message" as const,
    message: "Confirm this active submission once.",
    source: "codex" as const,
    target: "claude" as const,
  };
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);

  expect(await bridge.deliverTmuxBridgeMessage(runDir, message)).toBe(true);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) => args[0] === "tmux" && args.at(-1) === "Enter"
    )
  ).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});

test("unconfirmed Claude delivery remains pending after one retry", async () => {
  let captureCalls = 0;
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      captureCalls += 1;
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          captureCalls === 1
            ? "❯\n\nOpus 5 · bypass permissions on"
            : "❯ [bridge:msg-claude-u] Message from Codex via the loop bridge:\n\nOpus 5",
          "utf8"
        ),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion = mock(
    () => "unchanged"
  );
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-claude-unconfirmed",
    kind: "message" as const,
    message: "Do not acknowledge without proof.",
    source: "codex" as const,
    target: "claude" as const,
  };
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);

  expect(await bridge.deliverTmuxBridgeMessage(runDir, message)).toBe(false);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({ id: message.id }),
  ]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("a post-injection human draft is never submitted by fallback", async () => {
  let captureCalls = 0;
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      captureCalls += 1;
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          captureCalls <= 2
            ? "❯\n\nOpus 5 · bypass permissions on"
            : "❯ human draft started after injection\n\nOpus 5",
          "utf8"
        ),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion = mock(
    () => "unchanged"
  );
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-claude-human-draft",
    kind: "message" as const,
    message: "Do not submit the human draft.",
    source: "codex" as const,
    target: "claude" as const,
  };
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);

  expect(await bridge.deliverTmuxBridgeMessage(runDir, message)).toBe(false);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) => args[0] === "tmux" && args.at(-1) === "Enter"
    )
  ).toHaveLength(1);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) =>
        args[0] === "tmux" && args[1] === "send-keys" && args.at(-1) === " "
    )
  ).toHaveLength(0);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({ id: message.id }),
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("immediate Claude delivery and worker drain submit a message once", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("❯\n\nOpus 5 · bypass permissions on", "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  let transcriptReads = 0;
  const transcriptVersion = mock(() =>
    transcriptReads++ === 0 ? "before" : "after"
  );
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion =
    transcriptVersion;
  bridge.bridgeInternals.commandDeps.readClaudeTranscriptVersion =
    transcriptVersion;
  bridge.bridgeInternals.commandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const immediate = bridge.dispatchBridgeMessage(
    runDir,
    "codex",
    "claude",
    "Deliver this only once.",
    bridge.immediateBridgeDelivery(runDir, "claude")
  );
  const worker = bridge.drainTmuxBridgeMessages(runDir);
  const [result, workerDelivered] = await Promise.all([immediate, worker]);

  expect(result.status).toBe("delivered");
  expect(workerDelivered).toBe(false);
  expect(
    spawnSync.mock.calls.filter(
      ([args]) =>
        args[0] === "tmux" && args[1] === "send-keys" && args.at(-1) === "Enter"
    )
  ).toHaveLength(1);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_message rejects an empty target after trimming", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "   ",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message: "send_message requires a non-empty target",
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_message rejects an unknown normalized target", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "  FOO  ",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message:
        'Unknown target "foo" - expected one of "claude", "codex", "gemini", "cursor", or "copilot"',
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_message rejects targeting the current agent", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "claude",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message: "send_message cannot target the current agent",
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP rejects the old send_to_agent name with rename guidance", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "codex",
          },
          name: "send_to_agent",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: {
      code: -32_602,
      message: 'Unknown tool: send_to_agent. Use "send_message" instead.',
    },
    id: 1,
    jsonrpc: "2.0",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP handles standard empty-list and ping requests through the Claude CLI path", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeLine({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
        },
      }),
      encodeLine({
        id: 2,
        jsonrpc: "2.0",
        method: "ping",
        params: {},
      }),
      encodeLine({
        id: 3,
        jsonrpc: "2.0",
        method: "prompts/list",
        params: {},
      }),
      encodeLine({
        id: 4,
        jsonrpc: "2.0",
        method: "resources/list",
        params: {},
      }),
      encodeLine({
        id: 5,
        jsonrpc: "2.0",
        method: "resources/templates/list",
        params: {},
      }),
      encodeLine({
        id: 6,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('"claude/channel":{}');
  expect(result.stdout).toContain(
    '\\"send_message\\" with target: \\"codex\\" for Codex-facing messages'
  );
  expect(result.stdout).toContain(
    "Never answer the human when the inbound message came from Codex"
  );
  expect(result.stdout).toContain("Delegation is mandatory");
  expect(result.stdout).toContain('call \\"route_task\\" before using');
  expect(result.stdout).toContain("one to three independent bounded packets");
  expect(result.stdout).toContain("Use Nanny");
  expect(result.stdout).toContain("Use Au Pair");
  expect(result.stdout).toContain("Governess chooses the tier");
  expect(result.stdout).toContain('"id":2');
  expect(result.stdout).toContain('"result":{}');
  expect(result.stdout).toContain('"id":3');
  expect(result.stdout).toContain('"prompts":[]');
  expect(result.stdout).toContain('"id":4');
  expect(result.stdout).toContain('"resources":[]');
  expect(result.stdout).toContain('"id":5');
  expect(result.stdout).toContain('"resourceTemplates":[]');
  expect(result.stdout).toContain('"id":6');
  const tools = listedTools(result.stdout);
  expect(tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: false,
        },
        name: "send_message",
      }),
      expect.objectContaining({
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: true,
        },
        name: "bridge_status",
      }),
      expect.objectContaining({
        annotations: {
          destructiveHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        name: "receive_messages",
      }),
    ])
  );
  expect(tools).toHaveLength(7);
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      "route_task",
      "task_status",
      "get_task_result",
      "apply_task_patch",
    ])
  );
  expect(tools.some((tool) => tool.name === "reply")).toBe(false);
  expect(
    tools.find((tool) => tool.name === "route_task")?.description
  ).toContain("one to three packets early");
  expect(
    tools.find((tool) => tool.name === "route_task")?.description
  ).toContain("narrowest common ancestor");
  expect(
    tools.find((tool) => tool.name === "route_task")?.description
  ).toContain("Every terminal outcome returns to this requester");
  const routeTask = tools.find((tool) => tool.name === "route_task") as {
    inputSchema?: {
      properties?: Record<string, { description?: string }>;
    };
  };
  expect(routeTask.inputSchema?.properties).toHaveProperty("execution_plan");
  expect(routeTask.inputSchema?.properties).toHaveProperty("execution_read");
  expect(
    routeTask.inputSchema?.properties?.context_refs?.description
  ).toContain("Never put prose, SHAs, source files, or absolute paths here");
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP advertises only the Codex-visible bridge tools", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "codex",
    [
      encodeLine({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
        },
      }),
      encodeLine({
        id: 6,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain('"claude/channel":{}');
  const tools = listedTools(result.stdout);
  expect(tools).toHaveLength(7);
  expect(tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: false,
        },
        name: "send_message",
      }),
      expect.objectContaining({
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
          readOnlyHint: true,
        },
        name: "bridge_status",
      }),
      expect.objectContaining({
        annotations: {
          destructiveHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        name: "receive_messages",
      }),
    ])
  );
  expect(tools.some((tool) => tool.name === "reply")).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP accepts typed work metadata and TTL", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    encodeFrame({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          artifact_refs: ["src/loop/bridge-store.ts"],
          dedupe_key: "review:p0",
          message: "Review the queue policy.",
          priority: "urgent",
          subject: "Queue policy",
          target: "codex",
          thread_id: "p0-thread",
          ttl_ms: 60_000,
          type: "review_request",
        },
        name: "send_message",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(bridge.readPendingBridgeMessages(runDir)[0]).toMatchObject({
    artifactRefs: ["src/loop/bridge-store.ts"],
    dedupeKey: "review:p0",
    priority: "urgent",
    subject: "Queue policy",
    threadId: "p0-thread",
    type: "review_request",
  });
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP writes line-delimited JSON responses", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const line = result.stdout.trim();
  expect(line.startsWith("{")).toBe(true);
  expect(JSON.parse(line)).toMatchObject({
    id: 1,
    jsonrpc: "2.0",
    result: expect.objectContaining({
      capabilities: expect.any(Object),
      protocolVersion: "2024-11-05",
    }),
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge runtime status reports app-server-backed config-file delivery", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      state: "submitted",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.readBridgeRuntimeStatus(runDir)).toMatchObject({
    claudeBridgeMode: "mcp-config",
    claudeChannelServer: bridge.claudeChannelServerName("7", "repo-123"),
    codexDeliveryMode: "app-server",
    hasCodexRemote: true,
    hasLiveTmuxSession: false,
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge runtime status reports live tmux delivery with a run-scoped Claude server", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 1, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "submitted",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.readBridgeRuntimeStatus(runDir)).toMatchObject({
    claudeBridgeMode: "mcp-config",
    claudeChannelServer: "loop-bridge-repo-123-8",
    codexDeliveryMode: "tmux",
    hasCodexRemote: false,
    hasLiveTmuxSession: true,
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP bridge_status includes runtime delivery fields", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      state: "submitted",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: "bridge_status",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const status = toolText(result.stdout, 1);
  expect(status).toContain('"claudeBridgeMode": "mcp-config"');
  expect(status).toContain('"claudeChannelServer": "loop-bridge-repo-123-7"');
  expect(status).toContain('"codexDeliveryMode": "app-server"');
  expect(status).toContain('"hasCodexRemote": true');
  expect(status).toContain('"hasLiveTmuxSession": false');

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP bridge_status tolerates a missing tmux binary", async () => {
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "claude-session-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      state: "submitted",
      status: "running",
      tmuxSession: "repo-loop-7",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: "bridge_status",
      },
    }),
    { ...process.env, PATH: "/definitely-missing" }
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const status = toolText(result.stdout, 1);
  expect(status).toContain('"claudeChannelServer": "loop-bridge-repo-123-7"');
  expect(status).toContain('"codexDeliveryMode": "app-server"');
  expect(status).toContain('"hasLiveTmuxSession": false');
  expect(status).toContain('"hasTmuxSession": true');

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP receive_messages returns and clears queued inbox items", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${JSON.stringify({
      at: "2026-03-23T10:00:00.000Z",
      id: "msg-1",
      kind: "message",
      message: "Please review the final result.",
      source: "claude",
      target: "codex",
    })}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: "receive_messages",
      },
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Please review the final result.");
  expect(result.stdout).toContain('\\"from\\": \\"claude\\"');
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP receive_messages leaves an automatically claimed item alone", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  const claimDir = join(runDir, "bridge-delivery-claims");
  mkdirSync(claimDir, { recursive: true });
  const message = {
    at: "2026-03-23T10:00:00.000Z",
    id: "claimed-msg-1",
    kind: "message" as const,
    message: "Deliver me exactly once.",
    source: "utility" as const,
    target: "claude" as const,
  };
  bridge.bridgeInternals.appendBridgeEvent(runDir, message);
  const claimName = `${createHash("sha256").update(message.id).digest("hex")}.lock`;
  writeFileSync(join(claimDir, claimName), "", "utf8");

  const claimed = await runBridgeProcess(
    runDir,
    "claude",
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "receive_messages" },
    })
  );

  expect(toolText(claimed.stdout, 1)).toBe("[]");
  expect(bridge.readPendingBridgeMessages(runDir)).toHaveLength(1);
  expect(bridge.readPendingBridgeMessages(runDir)[0]).toMatchObject(message);

  rmSync(join(claimDir, claimName));
  const released = await runBridgeProcess(
    runDir,
    "claude",
    encodeLine({
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "receive_messages" },
    })
  );
  expect(toolText(released.stdout, 2)).toContain("Deliver me exactly once.");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge delivers Claude replies directly to Codex when app-server state is available", async () => {
  const injectCodexMessage = mock(async () => true);
  const bridge = await loadBridge({ injectCodexMessage });
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-1",
    kind: "message" as const,
    message: "The files look good to me.",
    source: "claude" as const,
    target: "codex" as const,
  };

  bridge.bridgeInternals.appendBridgeEvent(runDir, message);
  const delivered = await bridge.deliverCodexBridgeMessage(runDir, message);

  expect(delivered).toBe(true);
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "Claude: The files look good to me."
  );
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("bridge leaves live Codex tmux messages queued for the tmux proxy", async () => {
  const injectCodexMessage = mock(async () => true);
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0 };
    }
    return { exitCode: 1 };
  });
  const bridge = await loadBridge({ injectCodexMessage });
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      status: "running",
      tmuxSession: "repo-loop-7",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-live",
    kind: "message" as const,
    message: "Please steer this into the active turn.",
    source: "claude" as const,
    target: "codex" as const,
  };

  bridge.bridgeInternals.appendBridgeEvent(runDir, message);
  const delivered = await bridge.deliverCodexBridgeMessage(runDir, message);

  expect(delivered).toBe(false);
  expect(injectCodexMessage).not.toHaveBeenCalled();
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining(message),
  ]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(0);

  rmSync(root, { recursive: true, force: true });
});

test("bridge falls back to direct Codex delivery when the stored tmux session is stale", async () => {
  const injectCodexMessage = mock(async () => true);
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 1 };
    }
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  });
  const bridge = await loadBridge({ injectCodexMessage });
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  const message = {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-2",
    kind: "message" as const,
    message: "Please review the final state.",
    source: "claude" as const,
    target: "codex" as const,
  };

  bridge.bridgeInternals.appendBridgeEvent(runDir, message);
  const delivered = await bridge.deliverCodexBridgeMessage(runDir, message);

  expect(delivered).toBe(true);
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "Claude: Please review the final state."
  );
  expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
    undefined
  );
  const removeCall = spawnSync.mock.calls.find(
    (call) => call[0]?.[0] === "claude" && call[0]?.[2] === "remove"
  );
  expect(removeCall).toBeDefined();
  expect(removeCall?.[0]).toEqual([
    "claude",
    "mcp",
    "remove",
    "--scope",
    "local",
    bridge.claudeChannelServerName("8", "repo-123"),
  ]);
  expect(removeCall?.[1]).toMatchObject({
    stderr: "pipe",
    stdout: "ignore",
  });
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge drains codex messages through the persisted stable pane target", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          "› Use /skills to list available skills\n\n  gpt-5.6-sol xhigh · ~/repo\n",
          "utf8"
        ),
      };
    }
    if (args[0] === "tmux" && args[1] === "send-keys") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxPaneRight: "%41",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-3",
    kind: "message",
    message: "Please check the tmux path.",
    source: "claude",
    target: "codex",
  });

  const delivered = await bridge.drainCodexTmuxMessages(runDir);

  expect(delivered).toBe(true);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(spawnSync.mock.calls).toEqual([
    [
      ["tmux", "has-session", "-t", "repo-loop-8"],
      { stderr: "ignore", stdout: "ignore" },
    ],
    [
      ["tmux", "capture-pane", "-p", "-t", "%41"],
      { stderr: "ignore", stdout: "pipe" },
    ],
    [
      ["tmux", "capture-pane", "-p", "-t", "%41"],
      { stderr: "ignore", stdout: "pipe" },
    ],
    [
      [
        "tmux",
        "send-keys",
        "-t",
        "%41",
        "-l",
        "--",
        "Claude: Please check the tmux path.",
      ],
      { stderr: "ignore" },
    ],
    [["tmux", "send-keys", "-t", "%41", "Enter"], { stderr: "ignore" }],
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge drains pending cursor tmux messages through the stored pane routing", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("standing by for Codex review request", "utf8"),
      };
    }
    if (args[0] === "tmux" && args[1] === "send-keys") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxPaneLeftAgent: "cursor",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-cursor-1",
    kind: "message",
    message:
      "Please review the current diff and send notes back through the bridge.",
    source: "codex",
    target: "cursor",
  });

  const delivered = await bridge.drainTmuxBridgeMessages(runDir);

  expect(delivered).toBe(true);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(spawnSync.mock.calls).toEqual([
    [
      ["tmux", "has-session", "-t", "repo-loop-8"],
      { stderr: "ignore", stdout: "ignore" },
    ],
    [
      ["tmux", "has-session", "-t", "repo-loop-8"],
      { stderr: "ignore", stdout: "ignore" },
    ],
    [
      ["tmux", "capture-pane", "-p", "-t", "repo-loop-8:0.0"],
      { stderr: "ignore", stdout: "pipe" },
    ],
    [
      ["tmux", "capture-pane", "-p", "-t", "repo-loop-8:0.0"],
      { stderr: "ignore", stdout: "pipe" },
    ],
    [
      [
        "tmux",
        "send-keys",
        "-t",
        "repo-loop-8:0.0",
        "-l",
        "--",
        "[bridge:msg-cursor-1] Message from Codex via the loop bridge:",
      ],
      { stderr: "ignore" },
    ],
    [
      ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "C-j"],
      { stderr: "ignore" },
    ],
    [
      ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "-l", "--", ""],
      { stderr: "ignore" },
    ],
    [
      ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "C-j"],
      { stderr: "ignore" },
    ],
    [
      [
        "tmux",
        "send-keys",
        "-t",
        "repo-loop-8:0.0",
        "-l",
        "--",
        "Please review the current diff and send notes back through the bridge.",
      ],
      { stderr: "ignore" },
    ],
    [
      ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "C-j"],
      { stderr: "ignore" },
    ],
    [
      ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "-l", "--", ""],
      { stderr: "ignore" },
    ],
    [
      ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "C-j"],
      { stderr: "ignore" },
    ],
    [
      [
        "tmux",
        "send-keys",
        "-t",
        "repo-loop-8:0.0",
        "-l",
        "--",
        "Treat this as direct agent-to-agent coordination. Do not reply to the human.",
      ],
      { stderr: "ignore" },
    ],
    [
      ["tmux", "send-keys", "-t", "repo-loop-8:0.0", "Enter"],
      { stderr: "ignore" },
    ],
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge drains pending Claude messages through the visible tmux pane", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("❯\n\nOpus 5 · bypass permissions on", "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  let transcriptReads = 0;
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion = mock(() =>
    transcriptReads++ === 0 ? "before" : "after"
  );
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-claude-tmux-1",
    kind: "message",
    message: "Stop and review the supervisor ruling.",
    source: "gemini",
    target: "claude",
  });

  const delivered = await bridge.drainTmuxBridgeMessages(runDir);

  expect(delivered).toBe(true);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(spawnSync.mock.calls).toContainEqual([
    [
      "tmux",
      "send-keys",
      "-t",
      "repo-loop-8:0.0",
      "-l",
      "--",
      "[bridge:msg-claude-t] Message from Gemini via the loop bridge:",
    ],
    { stderr: "ignore" },
  ]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("Claude pane delivery preserves a non-empty user draft", async () => {
  const bridge = await loadBridge();

  expect(
    bridge.isClaudePaneReady(
      "❯\n\nOpus 5 | ctx: 59% | effort: high · bypass permissions on"
    )
  ).toBe(true);
  expect(
    bridge.isClaudePaneReady(
      "❯ check codex bridge message\n\nOpus 5 | ctx: 59% | effort: high"
    )
  ).toBe(false);
  expect(
    bridge.isClaudePaneReady(
      "❯\nshort prior output\n❯ human draft\n\nOpus 5 | ctx: 59%"
    )
  ).toBe(false);
});

test("Claude pane readiness treats a dim type-ahead suggestion as empty", async () => {
  const bridge = await loadBridge();

  expect(
    bridge.isClaudePaneReady(
      "\u001B[39m❯ \u001B[2mwait for codex's verdict\u001B[0m\n\nOpus 5 | ctx: 59%"
    )
  ).toBe(true);
  expect(
    bridge.isClaudePaneReady(
      "\u001B[39m❯ real draft\u001B[0m\n\nOpus 5 | ctx: 59%"
    )
  ).toBe(false);
  expect(
    bridge.isClaudePaneReady(
      "\u001B[39m❯ typed\u001B[2m ghost tail\u001B[0m\n\nOpus 5 | ctx: 59%"
    )
  ).toBe(false);
});

test("Claude transcript lookup rejects traversal and external symlink proof", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "-repo");
  const outside = join(root, "outside.jsonl");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(outside, '{"type":"user"}\n');
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "../../outside",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`
  );
  expect(
    bridge.readClaudeTranscriptVersionFromProjects(runDir, projectsDir)
  ).toBeUndefined();

  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeSessionId: "safe-session",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`
  );
  symlinkSync(outside, join(projectDir, "safe-session.jsonl"));
  expect(
    bridge.readClaudeTranscriptVersionFromProjects(runDir, projectsDir)
  ).toBeUndefined();
  rmSync(root, { recursive: true, force: true });
});

test("bridge stale tmux cleanup is a no-op when the manifest has no tmux session", async () => {
  const spawnSync = mock(() => ({ exitCode: 0 }));
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.clearStaleTmuxBridgeState(runDir)).toBe(false);
  expect(spawnSync).not.toHaveBeenCalled();
  expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
    undefined
  );

  rmSync(root, { recursive: true, force: true });
});

test("bridge stale tmux cleanup logs non-zero Claude MCP remove exits", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return {
        exitCode: 1,
        stderr: Buffer.from("command failed", "utf8"),
      };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const errorSpy = mock(() => undefined);
  const originalError = console.error;
  console.error = errorSpy;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  try {
    expect(bridge.clearStaleTmuxBridgeState(runDir)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      '[loop] failed to remove Claude channel server "loop-bridge-repo-123-8": command failed'
    );
    expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
      undefined
    );
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge stale tmux cleanup logs thrown Claude MCP remove errors", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      throw new Error("spawn failed");
    }
    return { exitCode: 0, stderr: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const errorSpy = mock(() => undefined);
  const originalError = console.error;
  console.error = errorSpy;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  try {
    expect(bridge.clearStaleTmuxBridgeState(runDir)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      '[loop] failed to remove Claude channel server "loop-bridge-repo-123-8": spawn failed'
    );
    expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
      undefined
    );
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge stale tmux cleanup removes a persisted Claude server name", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      claudeChannelServer: "loop-bridge-custom-8",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.clearStaleTmuxBridgeState(runDir)).toBe(true);
  expect(
    spawnSync.mock.calls.filter(
      (call) => call[0]?.[0] === "claude" && call[0]?.[2] === "remove"
    )
  ).toEqual(
    expect.arrayContaining([
      [
        ["claude", "mcp", "remove", "--scope", "local", "loop-bridge-custom-8"],
        expect.objectContaining({ stderr: "pipe", stdout: "ignore" }),
      ],
    ])
  );

  rmSync(root, { recursive: true, force: true });
});

test("runBridgeWorker clears stale tmux routing and exits", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 1, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  await bridge.runBridgeWorker(runDir);

  expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
    undefined
  );
  expect(spawnSync.mock.calls).toEqual(
    expect.arrayContaining([
      [
        ["tmux", "has-session", "-t", "repo-loop-8"],
        expect.objectContaining({ stderr: "ignore", stdout: "ignore" }),
      ],
      [
        [
          "claude",
          "mcp",
          "remove",
          "--scope",
          "local",
          bridge.claudeChannelServerName("8", "repo-123"),
        ],
        expect.objectContaining({ stderr: "pipe", stdout: "ignore" }),
      ],
    ])
  );

  rmSync(root, { recursive: true, force: true });
});

test("runBridgeWorker falls back to app-server delivery after stale tmux cleanup", async () => {
  let runDir = "";
  const injectCodexMessage = mock(() => {
    const manifestPath = join(runDir, "manifest.json");
    const manifest = readRunManifest(manifestPath);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        state: "completed",
        status: "completed",
      })}\n`,
      "utf8"
    );
    return true;
  });
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 1, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "claude" && args[1] === "mcp" && args[2] === "remove") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge({ injectCodexMessage });
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-stale-fallback",
    kind: "message",
    message: "Please deliver this after tmux cleanup.",
    source: "claude",
    target: "codex",
  });

  await bridge.runBridgeWorker(runDir);

  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    "Claude: Please deliver this after tmux cleanup."
  );
  expect(readRunManifest(join(runDir, "manifest.json"))?.tmuxSession).toBe(
    undefined
  );
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("ensureBridgeWorker launches one app-server worker per active run", async () => {
  const bridge = await loadBridge();
  const spawn = mock(() => ({
    pid: process.pid,
    unref: mock(() => undefined),
  }));
  bridge.bridgeRuntimeCommandDeps.spawn = spawn;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  expect(bridge.ensureBridgeWorker(runDir)).toBe(true);
  expect(bridge.ensureBridgeWorker(runDir)).toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]?.[0]).toEqual([
    "/opt/bun",
    "src/loop/main.ts",
    bridge.BRIDGE_WORKER_SUBCOMMAND,
    runDir,
  ]);
  expect(spawn.mock.calls[0]?.[1]).toMatchObject({
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });

  rmSync(root, { recursive: true, force: true });
});

test("runBridgeWorker retries queued codex app-server messages", async () => {
  let runDir = "";
  const injectCodexMessage = mock(() => {
    if (injectCodexMessage.mock.calls.length === 1) {
      throw new Error("turn still active");
    }
    const manifestPath = join(runDir, "manifest.json");
    const manifest = readRunManifest(manifestPath);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        state: "completed",
        status: "completed",
      })}\n`,
      "utf8"
    );
    return true;
  });
  const bridge = await loadBridge({ injectCodexMessage });
  const root = makeTempDir();
  runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-4",
    kind: "message",
    message: "Please review the final diff.",
    source: "claude",
    target: "codex",
  });

  await bridge.runBridgeWorker(runDir);

  expect(injectCodexMessage).toHaveBeenCalledTimes(2);
  expect(injectCodexMessage.mock.calls).toEqual([
    [
      "ws://127.0.0.1:4500",
      "codex-thread-1",
      "Claude: Please review the final diff.",
    ],
    [
      "ws://127.0.0.1:4500",
      "codex-thread-1",
      "Claude: Please review the final diff.",
    ],
  ]);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("runBridgeWorker drains Claude while the Codex tmux proxy owns Codex", async () => {
  let runDir = "";
  const injectCodexMessage = mock(() => true);
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("❯\n\nOpus 5 · bypass permissions on", "utf8"),
      };
    }
    if (
      args[0] === "tmux" &&
      args[1] === "send-keys" &&
      args[2] === "-t" &&
      args[3] === "repo-loop-8:0.0" &&
      args.at(-1) === "Enter"
    ) {
      const manifestPath = join(runDir, "manifest.json");
      const manifest = readRunManifest(manifestPath);
      writeFileSync(
        manifestPath,
        `${JSON.stringify({
          ...manifest,
          state: "completed",
          status: "completed",
        })}\n`,
        "utf8"
      );
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge({ injectCodexMessage });
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  let transcriptReads = 0;
  bridge.bridgeRuntimeCommandDeps.readClaudeTranscriptVersion = mock(() =>
    transcriptReads++ === 0 ? "before" : "after"
  );
  const root = makeTempDir();
  runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-codex-proxy-owned",
    kind: "message",
    message: "Codex proxy should keep this message.",
    source: "claude",
    target: "codex",
  });
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:01.000Z",
    id: "msg-claude-worker-visible",
    kind: "message",
    message: "Claude should visibly receive this message.",
    source: "codex",
    target: "claude",
  });

  await bridge.runBridgeWorker(runDir);

  expect(injectCodexMessage).not.toHaveBeenCalled();
  expect(
    bridge.readPendingBridgeMessages(runDir).map((message) => message.id)
  ).toEqual(["msg-codex-proxy-owned"]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
      .map((event) => event.id)
  ).toEqual(["msg-claude-worker-visible"]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP delivers pending codex messages to Claude as channel notifications", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${JSON.stringify({
      at: "2026-03-23T10:00:00.000Z",
      id: "msg-1",
      kind: "message",
      message: "Please review the latest Codex output.",
      source: "codex",
      target: "claude",
    })}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeLine({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
        },
      }),
      encodeLine({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('"method":"notifications/claude/channel"');
  expect(result.stdout).toContain("Please review the latest Codex output.");
  expect(result.stdout).toContain('"user":"Codex"');
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("Claude channel flush leaves live tmux messages pending for visible delivery", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "claude",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:00:00.000Z",
    id: "msg-live-claude-1",
    kind: "message",
    message: "This must be visible in Claude.",
    source: "codex",
    target: "claude",
  });
  const payloads: unknown[] = [];

  bridge.flushClaudeChannelMessages(runDir, (payload) => {
    payloads.push(payload);
  });

  expect(payloads).toEqual([]);
  expect(bridge.readPendingBridgeMessages(runDir)).toHaveLength(1);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(0);

  rmSync(root, { recursive: true, force: true });
});

test("Claude channel stays active when the live tmux pair has no Claude pane", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      state: "working",
      status: "running",
      tmuxPaneLeftAgent: "gemini",
      tmuxPaneRightAgent: "codex",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:00:00.000Z",
    id: "msg-headless-claude-live-tmux",
    kind: "message",
    message: "Claude is not a member of this tmux pair.",
    source: "codex",
    target: "claude",
  });
  const payloads: unknown[] = [];

  bridge.flushClaudeChannelMessages(runDir, (payload) => {
    payloads.push(payload);
  });

  expect(payloads).toHaveLength(1);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP flushes new Claude channel messages after bridge file changes", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const process = startLiveBridgeProcess(runDir, "claude");

  process.write(
    encodeLine({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
      },
    })
  );
  process.write(
    encodeLine({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })
  );
  await process.waitForStdout('"id":1');

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${JSON.stringify({
      at: "2026-03-23T10:00:00.000Z",
      id: "msg-watch-1",
      kind: "message",
      message: "Please review the follow-up change.",
      source: "codex",
      target: "claude",
    })}\n`,
    "utf8"
  );

  await process.waitForStdout("Please review the follow-up change.");
  const result = await process.close();

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('"method":"notifications/claude/channel"');
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP blocks an immediate bounce from the paired agent", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "ship it",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:00:01.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "claude",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("suppressed duplicate bridge message");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "message")
  ).toHaveLength(1);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "delivered")
  ).toHaveLength(1);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "blocked")
  ).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP allows the same message later after unrelated traffic", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "ship it",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:00:01.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:01:00.000Z",
        id: "msg-2",
        kind: "message",
        message: "other traffic",
        source: "codex",
        target: "claude",
      },
      {
        at: "2026-03-22T10:01:01.000Z",
        id: "msg-2",
        kind: "delivered",
        source: "codex",
        target: "claude",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "codex",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "claude",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("queued");
  expect(result.stdout).not.toContain("suppressed duplicate bridge message");
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "blocked")
  ).toHaveLength(0);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "message")
  ).toHaveLength(3);
  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP allows repeating the same message in the original direction", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    bridge.bridgeInternals.bridgePath(runDir),
    `${[
      {
        at: "2026-03-22T10:00:00.000Z",
        id: "msg-1",
        kind: "message",
        message: "ship it",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-03-22T10:00:01.000Z",
        id: "msg-1",
        kind: "delivered",
        source: "claude",
        target: "codex",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8"
  );

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "ship it",
            target: "codex",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("queued");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({
      message: "ship it",
      source: "claude",
      target: "codex",
    }),
  ]);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "message")
  ).toHaveLength(2);
  expect(
    bridge.bridgeInternals
      .readBridgeEvents(runDir)
      .filter((event) => event.kind === "blocked")
  ).toHaveLength(0);
  rmSync(root, { recursive: true, force: true });
});

test("bridge config helper builds the bridge MCP entry point for Codex", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");

  const codexArgs = bridge.buildCodexBridgeConfigArgs(runDir, "codex");
  expect(codexArgs).toEqual([
    "-c",
    'mcp_servers.loop-bridge.command="/opt/bun"',
    "-c",
    `mcp_servers.loop-bridge.args=${JSON.stringify([
      "src/loop/main.ts",
      bridge.BRIDGE_SUBCOMMAND,
      runDir,
      "codex",
    ])}`,
    "-c",
    'mcp_servers.loop-bridge.tools.send_message.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.route_task.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.task_status.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.get_task_result.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.apply_task_patch.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.bridge_status.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.receive_messages.approval_mode="approve"',
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("bridge config helper writes the Claude MCP config file", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");

  const path = bridge.ensureClaudeBridgeConfig(runDir, "claude");
  expect(path).toBe(join(runDir, "claude-mcp.json"));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    mcpServers: {
      [bridge.BRIDGE_SERVER]: {
        args: ["src/loop/main.ts", bridge.BRIDGE_SUBCOMMAND, runDir, "claude"],
        command: "/opt/bun",
        type: "stdio",
      },
    },
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge config helper writes the Claude MCP config file for a custom server", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  const serverName = bridge.claudeChannelServerName("1", "repo-123");

  const path = bridge.ensureClaudeBridgeConfig(runDir, "claude", serverName);
  expect(path).toBe(join(runDir, "claude-mcp.json"));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    mcpServers: {
      [serverName]: {
        args: ["src/loop/main.ts", bridge.BRIDGE_SUBCOMMAND, runDir, "claude"],
        command: "/opt/bun",
        type: "stdio",
      },
    },
  });

  rmSync(root, { recursive: true, force: true });
});

test("bridge registration helper throws on unexpected Claude MCP add-json failures", async () => {
  const bridge = await loadBridge();

  expect(() =>
    bridge.registerClaudeChannelServer(
      ["/opt/bun", "src/loop/main.ts"],
      bridge.claudeChannelServerName("7", "repo-123"),
      "/tmp/run",
      () => ({ exitCode: 1, stderr: "command failed" })
    )
  ).toThrow("[loop] failed to register Claude channel server: command failed");
});

test("dispatchBridgeMessage reports delivered when direct codex delivery succeeds", async () => {
  const injectCodexMessage = mock(async () => true);
  const bridge = await loadBridge({ injectCodexMessage });
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-1",
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      status: "running",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const result = await bridge.dispatchBridgeMessage(
    runDir,
    "claude",
    "codex",
    "Please review the final diff.",
    (entry) => bridge.deliverCodexBridgeMessage(runDir, entry)
  );

  expect(result.status).toBe("delivered");
  expect(bridge.formatDispatchResult(result)).toContain("delivered");
  expect(injectCodexMessage).toHaveBeenCalledWith(
    "ws://127.0.0.1:4500",
    "codex-thread-1",
    expect.stringContaining("Claude: Please review the final diff.")
  );
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});

test("dispatchBridgeMessage stays queued when tmux metadata is stale", async () => {
  const bridge = await loadBridge();
  const liveTmuxCheck = mock(() => false);
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxSession: "repo-loop-stale",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );

  const result = await bridge.dispatchBridgeMessage(
    runDir,
    "claude",
    "codex",
    "Please review the final diff.",
    undefined,
    liveTmuxCheck
  );

  expect(result.status).toBe("queued");
  expect(liveTmuxCheck).toHaveBeenCalledTimes(1);
  expect(bridge.formatDispatchResult(result)).toContain("queued");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({
      message: "Please review the final diff.",
      source: "claude",
      target: "codex",
    }),
  ]);

  rmSync(root, { recursive: true, force: true });
});

test("dispatchBridgeMessage formats accepted status with the target name", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await bridge.dispatchBridgeMessage(
    runDir,
    "codex",
    "claude",
    "Please review the diff.",
    undefined,
    () => true
  );

  expect(result.status).toBe("accepted");
  expect(bridge.formatDispatchResult(result)).toBe(
    `accepted ${result.entry.id} for claude delivery`
  );

  rmSync(root, { recursive: true, force: true });
});

test("bridge MCP send_message normalizes copilot as a valid target", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const result = await runBridgeProcess(
    runDir,
    "claude",
    [
      encodeFrame({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            message: "please review",
            target: "  COPILOT  ",
          },
          name: "send_message",
        },
      }),
      "\n",
    ].join("")
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("queued");
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([
    expect.objectContaining({
      message: "please review",
      source: "claude",
      target: "copilot",
    }),
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("bridge queues cross-agent messages for all non-Claude/Codex pairs", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const pairs: Array<{ source: "claude" | "codex"; target: string }> = [
    { source: "claude", target: "copilot" },
    { source: "claude", target: "gemini" },
    { source: "claude", target: "cursor" },
    { source: "codex", target: "copilot" },
    { source: "codex", target: "gemini" },
    { source: "codex", target: "cursor" },
  ];

  for (const { source, target } of pairs) {
    const pairRunDir = join(root, `run-${source}-${target}`);
    mkdirSync(pairRunDir, { recursive: true });

    const result = await runBridgeProcess(
      pairRunDir,
      source,
      [
        encodeFrame({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              message: `hello from ${source}`,
              target,
            },
            name: "send_message",
          },
        }),
        "\n",
      ].join("")
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("queued");
    const pending = bridge.readPendingBridgeMessages(pairRunDir);
    expect(pending).toEqual([
      expect.objectContaining({
        message: `hello from ${source}`,
        source,
        target,
      }),
    ]);
    rmSync(pairRunDir, { recursive: true, force: true });
  }

  rmSync(root, { recursive: true, force: true });
});

test("bridge config injection writes copilot config to .github/copilot/mcp.json", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  const projectDir = join(root, "project");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  bridge.injectProjectBridgeConfig(projectDir, runDir, "copilot");

  const configPath = join(projectDir, ".github", "copilot", "mcp.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  expect(config.mcpServers).toBeDefined();
  expect(config.mcpServers[bridge.BRIDGE_SERVER]).toBeDefined();
  expect(config.mcpServers[bridge.BRIDGE_SERVER].type).toBe("stdio");
  expect(config.mcpServers[bridge.BRIDGE_SERVER].args).toContain("copilot");

  rmSync(root, { recursive: true, force: true });
});

test("bridge pending count includes copilot messages", async () => {
  const bridge = await loadBridge();
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const bridgeFile = bridge.bridgeInternals.bridgePath(runDir);

  writeFileSync(
    bridgeFile,
    `${JSON.stringify({
      at: "2026-03-22T10:00:00.000Z",
      id: "msg-copilot-1",
      kind: "message",
      message: "review this",
      source: "claude",
      target: "copilot",
    })}\n`,
    "utf8"
  );

  const status = bridge.readBridgeStatus(runDir);
  expect(status.pending.copilot).toBe(1);
  expect(status.pending.claude).toBe(0);

  rmSync(root, { recursive: true, force: true });
});

test("bridge drains pending copilot tmux messages through stored pane routing", async () => {
  const spawnSync = mock((args: string[]) => {
    if (args[0] === "tmux" && args[1] === "has-session") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    if (args[0] === "tmux" && args[1] === "capture-pane") {
      return {
        exitCode: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("waiting for input", "utf8"),
      };
    }
    if (args[0] === "tmux" && args[1] === "send-keys") {
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  });
  const bridge = await loadBridge();
  bridge.bridgeRuntimeCommandDeps.spawnSync = spawnSync;
  const root = makeTempDir();
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      createdAt: "2026-03-23T10:00:00.000Z",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "8",
      status: "running",
      tmuxPaneLeftAgent: "copilot",
      tmuxPaneRightAgent: "claude",
      tmuxSession: "repo-loop-8",
      updatedAt: "2026-03-23T10:00:00.000Z",
    })}\n`,
    "utf8"
  );
  bridge.bridgeInternals.appendBridgeEvent(runDir, {
    at: "2026-03-23T10:01:00.000Z",
    id: "msg-copilot-tmux-1",
    kind: "message",
    message: "Please review the latest changes.",
    source: "claude",
    target: "copilot",
  });

  const delivered = await bridge.drainTmuxBridgeMessages(runDir);

  expect(delivered).toBe(true);
  expect(bridge.readPendingBridgeMessages(runDir)).toEqual([]);

  rmSync(root, { recursive: true, force: true });
});
