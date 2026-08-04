import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerWebSocket, serve } from "bun";
import {
  appendBridgeMessage,
  readPendingBridgeMessages,
} from "../../src/loop/bridge-store";
import {
  CODEX_TMUX_PROXY_LIFECYCLE_FILE,
  codexTmuxProxyInternals,
  type ProxyRuntimeOptions,
  runCodexTmuxProxy,
  stopCodexTmuxProxy,
  waitForCodexTmuxProxy,
} from "../../src/loop/codex-tmux-proxy";
import { readDelegationEvents } from "../../src/loop/delegation-policy";
import { findFreePort } from "../../src/loop/ports";
import {
  createRunManifest,
  readRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "../../src/loop/run-state";

const bridgeMessage = {
  at: "2026-03-29T00:00:00.000Z",
  id: "msg-1",
  kind: "message" as const,
  message: "Please review the latest diff.",
  source: "claude" as const,
  target: "codex" as const,
};

const TEST_PORT_RANGE = 200;
const TEST_PORT_RETRY_LIMIT = 5;
const TEST_PORT_START = 20_000;
const TEST_PORT_WINDOW = 20_000;

interface JsonFrame {
  error?: unknown;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "loop-proxy-"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const isBridgeRequestId = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith("proxy-bridge-");

const isAddressInUseError = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }
  const code = asString(error.code);
  if (code === "EADDRINUSE") {
    return true;
  }
  const message = asString(error.message)?.toLowerCase() ?? "";
  return message.includes("eaddrinuse");
};

const randomTestPortBase = (): number =>
  TEST_PORT_START + Math.floor(Math.random() * TEST_PORT_WINDOW);

const findTestPort = (): Promise<number> =>
  findFreePort(randomTestPortBase(), TEST_PORT_RANGE);

const startServerWithRetries = async (
  createServer: (port: number) => ReturnType<typeof serve>
): Promise<{ port: number; server: ReturnType<typeof serve> }> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEST_PORT_RETRY_LIMIT; attempt += 1) {
    const port = await findTestPort();
    try {
      return {
        port,
        server: createServer(port),
      };
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("failed to start test server");
};

const startProxyWithRetries = async (
  runDir: string,
  remoteUrl: string,
  threadId: string,
  options: ProxyRuntimeOptions = {}
): Promise<{ proxyTask: Promise<void>; proxyUrl: string }> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEST_PORT_RETRY_LIMIT; attempt += 1) {
    const port = await findTestPort();
    const proxyTask = runCodexTmuxProxy(
      runDir,
      remoteUrl,
      threadId,
      port,
      options
    );
    try {
      const proxyUrl = await Promise.race([
        waitForCodexTmuxProxy(port),
        proxyTask.then(() => {
          throw new Error("codex tmux proxy stopped before becoming ready");
        }),
      ]);
      return { proxyTask, proxyUrl };
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
      await proxyTask.catch(() => undefined);
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("failed to start codex tmux proxy");
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
};

const readLifecycleEvents = (root: string): Record<string, unknown>[] => {
  try {
    return readFileSync(join(root, CODEX_TMUX_PROXY_LIFECYCLE_FILE), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
};

test("codex tmux proxy waits briefly for the tmux session to appear", () => {
  const now = Date.now();
  const result = codexTmuxProxyInternals.observeTmuxLiveness(
    "dead",
    { consecutiveDead: 0, sawSession: false },
    now + 1000,
    now
  );
  expect(result.shouldStop).toBe(false);
  expect(result.evidence).toEqual({ consecutiveDead: 0, sawSession: false });
});

test("codex tmux proxy requires confirmed dead duration after startup grace", () => {
  const now = Date.now();
  let evidence = { consecutiveDead: 0, sawSession: false };
  const first = codexTmuxProxyInternals.observeTmuxLiveness(
    "dead",
    evidence,
    now - 1,
    now
  );
  expect(first.shouldStop).toBe(false);
  evidence = first.evidence;
  const second = codexTmuxProxyInternals.observeTmuxLiveness(
    "dead",
    evidence,
    now - 1,
    now + 2500
  );
  expect(second.shouldStop).toBe(false);
  const third = codexTmuxProxyInternals.observeTmuxLiveness(
    "dead",
    second.evidence,
    now - 1,
    now + 5000
  );
  expect(third.shouldStop).toBe(true);
});

test("codex tmux proxy does not let unknown liveness complete dead evidence", () => {
  const now = Date.now();
  const live = codexTmuxProxyInternals.observeTmuxLiveness(
    "live",
    { consecutiveDead: 0, sawSession: false },
    now + 1000,
    now
  );
  const dead = codexTmuxProxyInternals.observeTmuxLiveness(
    "dead",
    live.evidence,
    now + 1000,
    now + 1000
  );
  const unknown = codexTmuxProxyInternals.observeTmuxLiveness(
    "unknown",
    dead.evidence,
    now + 1000,
    now + 6000
  );
  expect(dead.shouldStop).toBe(false);
  expect(unknown.shouldStop).toBe(false);
  expect(unknown.evidence).toEqual({ consecutiveDead: 0, sawSession: true });
});

test("codex tmux proxy preserves a session when liveness is unknown", () => {
  const now = Date.now();

  const result = codexTmuxProxyInternals.observeTmuxLiveness(
    "unknown",
    { consecutiveDead: 2, deadSinceMs: now - 6000, sawSession: true },
    now - 1000,
    now
  );
  expect(result.shouldStop).toBe(false);
  expect(result.evidence).toEqual({ consecutiveDead: 0, sawSession: true });
});

test("codex tmux proxy exposes no bridge-body delivery path", () => {
  expect(codexTmuxProxyInternals).not.toHaveProperty(
    "deliverVisibleBridgeMessage"
  );
});

test("codex tmux proxy persists newer live thread ids to the run manifest", () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: "ws://127.0.0.1:4500",
      codexThreadId: "codex-thread-startup",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "7",
      tmuxSession: "loop-loop-7",
    })
  );

  codexTmuxProxyInternals.persistCodexThreadId(root, "codex-thread-live");

  expect(readRunManifest(manifestPath)?.codexThreadId).toBe(
    "codex-thread-live"
  );

  rmSync(root, { recursive: true, force: true });
});

test("codex tmux proxy records a mechanical command candidate without command text", () => {
  const root = makeTempDir();
  try {
    expect(
      codexTmuxProxyInternals.recordCodexAppServerDelegationCandidate(
        root,
        "/repo",
        {
          item: {
            command: "git status --short",
            cwd: "/repo",
            id: "command-1",
            type: "commandExecution",
          },
        },
        "2026-07-26T20:00:00.000Z"
      )
    ).toBe(true);
    const events = readDelegationEvents(root);
    expect(events).toEqual([
      expect.objectContaining({
        disposition: "missed-candidate",
        operation: "git-status",
        source: "codex-app-server",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("git status --short");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed loop bridge MCP calls are identified narrowly", () => {
  expect(
    codexTmuxProxyInternals.isClosedLoopBridgeToolCall({
      item: {
        error: { message: "Transport closed" },
        server: "loop-bridge",
        status: "failed",
        tool: "route_task",
        type: "mcpToolCall",
      },
    })
  ).toBe(true);
  expect(
    codexTmuxProxyInternals.isClosedLoopBridgeToolCall({
      item: {
        error: { message: "permission denied" },
        server: "loop-bridge",
        type: "mcpToolCall",
      },
    })
  ).toBe(false);
  expect(
    codexTmuxProxyInternals.isClosedLoopBridgeToolCall({
      item: {
        error: { message: "Transport closed" },
        server: "unrelated-server",
        type: "mcpToolCall",
      },
    })
  ).toBe(false);
  expect(
    codexTmuxProxyInternals.isClosedLoopBridgeToolCall({
      item: {
        error: { message: "Transport closed" },
        server: "not-loop-bridge-cache",
        type: "mcpToolCall",
      },
    })
  ).toBe(false);
});

test("codex tmux proxy reloads MCP servers after a closed loop bridge call", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const upstreamFrames: JsonFrame[] = [];
  let upstreamSocket: ServerWebSocket<{ initialized: boolean }> | undefined;
  let proxyTask: Promise<void> | undefined;
  let proxyUrl = "";
  const upstreamStart = await startServerWithRetries((port) =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request, { data: { initialized: false } })) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        message: (ws, message) => {
          for (const raw of String(message).split("\n")) {
            if (!raw.trim()) {
              continue;
            }
            const frame = JSON.parse(raw) as JsonFrame;
            upstreamFrames.push(frame);
            if (frame.method === "initialize") {
              ws.data.initialized = true;
              ws.send(JSON.stringify({ id: frame.id, result: {} }));
            } else if (frame.method === "config/mcpServer/reload") {
              ws.send(JSON.stringify({ id: frame.id, result: {} }));
            }
          }
        },
        open: (ws) => {
          upstreamSocket = ws;
        },
      },
    })
  );
  const upstreamUrl = `ws://127.0.0.1:${upstreamStart.port}/`;
  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "10",
      state: "working",
      status: "running",
    })
  );
  let tui: WebSocket | undefined;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1"
    );
    proxyTask = proxyStart.proxyTask;
    proxyUrl = proxyStart.proxyUrl;
    tui = new WebSocket(proxyUrl);
    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () => reject(new Error("failed to open tui websocket"));
    });
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(() => Boolean(upstreamSocket));
    upstreamSocket?.send(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            error: { message: "Transport closed" },
            server: "loop-bridge",
            status: "failed",
            tool: "send_message",
            type: "mcpToolCall",
          },
        },
      })
    );
    await waitFor(() =>
      upstreamFrames.some((frame) => frame.method === "config/mcpServer/reload")
    );
  } finally {
    tui?.close();
    if (proxyUrl) {
      await stopCodexTmuxProxy(proxyUrl);
    }
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? { ...manifest, state: "completed", status: "completed" }
        : manifest
    );
    await Promise.race([
      proxyTask ?? Promise.resolve(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("proxy shutdown timed out")), 2000)
      ),
    ]);
    upstreamStart.server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex tmux proxy reconnects to a live upstream without dropping the tui socket", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const bridgeMethods: string[] = [];
  const tuiTurnIds: string[] = [];
  const upstreamSockets: ServerWebSocket<{ initialized: boolean }>[] = [];
  let upstreamInitializeCount = 0;
  let upstreamConnections = 0;
  let proxyTask: Promise<void> | undefined;
  let upstreamServer: ReturnType<typeof serve> | undefined;
  let upstreamPort = 0;
  let proxyUrl = "";
  const upstreamStart = await startServerWithRetries((port) =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request, { data: { initialized: false } })) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        close: (ws) => {
          const index = upstreamSockets.indexOf(ws);
          if (index !== -1) {
            upstreamSockets.splice(index, 1);
          }
        },
        message: (ws, message) => {
          const payload =
            typeof message === "string" ? message : message.toString();
          for (const raw of payload.split("\n")) {
            if (!raw.trim()) {
              continue;
            }
            const frame = JSON.parse(raw) as JsonFrame;
            if (frame.method === "initialize") {
              upstreamInitializeCount += 1;
              if (ws.data.initialized) {
                ws.send(
                  JSON.stringify({
                    error: { message: "already initialized" },
                    id: frame.id,
                  })
                );
              } else {
                ws.data.initialized = true;
                ws.send(JSON.stringify({ id: frame.id, result: {} }));
              }
              continue;
            }
            if (frame.method === "initialized") {
              continue;
            }
            if (frame.method === "thread/read") {
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: {
                    thread: {
                      turns: [],
                    },
                  },
                })
              );
              continue;
            }
            if (frame.method === "turn/start") {
              const turnId = isBridgeRequestId(frame.id)
                ? "bridge-turn-after-reconnect"
                : `tui-turn-${tuiTurnIds.length + 1}`;
              if (isBridgeRequestId(frame.id)) {
                bridgeMethods.push(frame.method);
              } else {
                tuiTurnIds.push(turnId);
              }
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: turnId } },
                })
              );
              continue;
            }
            if (isBridgeRequestId(frame.id) && frame.method) {
              bridgeMethods.push(frame.method);
            }
          }
        },
        open: (ws) => {
          upstreamConnections += 1;
          upstreamSockets.push(ws);
        },
      },
    })
  );
  upstreamPort = upstreamStart.port;
  upstreamServer = upstreamStart.server;
  const upstreamUrl = `ws://127.0.0.1:${upstreamPort}/`;
  const tuiMessages: JsonFrame[] = [];
  let tuiClosed = false;

  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "9",
      state: "working",
      status: "running",
    })
  );

  let tui: WebSocket | undefined;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1"
    );
    proxyTask = proxyStart.proxyTask;
    proxyUrl = proxyStart.proxyUrl;
    tui = new WebSocket(proxyUrl);
    tui.onclose = () => {
      tuiClosed = true;
    };
    tui.onmessage = (event) => {
      tuiMessages.push(JSON.parse(String(event.data)) as JsonFrame);
    };

    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () => reject(new Error("failed to open tui websocket"));
    });

    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(
      () => tuiMessages.some((frame) => frame.id === 1 && frame.result),
      5000
    );
    expect(upstreamInitializeCount).toBe(1);

    tui.send(
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello before reconnect",
              text_elements: [],
              type: "text",
            },
          ],
          threadId: "thread-1",
        },
      })
    );
    await waitFor(
      () =>
        tuiMessages.some(
          (frame) =>
            frame.id === 2 &&
            (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
        ),
      5000
    );

    upstreamSockets[0]?.close();
    await waitFor(() => upstreamConnections >= 2, 5000);
    expect(tuiClosed).toBe(false);
    expect(upstreamInitializeCount).toBe(2);

    appendBridgeMessage(
      root,
      bridgeMessage.source,
      bridgeMessage.target,
      bridgeMessage.message
    );
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(bridgeMethods).toEqual([]);
    expect(readPendingBridgeMessages(root)).toHaveLength(1);

    tui.send(
      JSON.stringify({
        id: 3,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello after reconnect",
              text_elements: [],
              type: "text",
            },
          ],
          threadId: "thread-1",
        },
      })
    );

    await waitFor(
      () =>
        tuiMessages.some(
          (frame) =>
            frame.id === 3 &&
            (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
        ),
      5000
    );
    expect(tuiClosed).toBe(false);
  } finally {
    tui?.close();
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            state: "completed",
            status: "completed",
          }
        : manifest
    );
    await Promise.race([
      proxyTask ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    upstreamServer?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex tmux proxy recovers after more than the former reconnect limit", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  let upstreamConnections = 0;
  let proxyTask: Promise<void> | undefined;
  let upstreamServer: ReturnType<typeof serve> | undefined;
  let replacementServer: ReturnType<typeof serve> | undefined;

  const makeUpstream = (port: number): ReturnType<typeof serve> =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request)) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        message: (ws, message) => {
          for (const raw of String(message).split("\n")) {
            if (!raw.trim()) {
              continue;
            }
            const frame = JSON.parse(raw) as JsonFrame;
            if (frame.method === "initialize") {
              ws.send(JSON.stringify({ id: frame.id, result: {} }));
            }
          }
        },
        open: () => {
          upstreamConnections += 1;
        },
      },
    });

  const upstreamStart = await startServerWithRetries((port) =>
    makeUpstream(port)
  );
  upstreamServer = upstreamStart.server;
  const upstreamUrl = `ws://127.0.0.1:${upstreamStart.port}/`;
  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "reconnect-limit",
      state: "working",
      status: "running",
      tmuxSession: "test-session",
    })
  );

  let tui: WebSocket | undefined;
  let tuiClosed = false;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1",
      {
        reconnectDelay: () => 1,
        tmuxLiveness: () => "live",
      }
    );
    proxyTask = proxyStart.proxyTask;
    tui = new WebSocket(proxyStart.proxyUrl);
    tui.onclose = () => {
      tuiClosed = true;
    };
    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () => reject(new Error("failed to open tui websocket"));
    });
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));

    upstreamServer.stop(true);
    upstreamServer = undefined;
    await waitFor(
      () =>
        readLifecycleEvents(root).filter(
          (event) => event.event === "reconnect-failed"
        ).length > 40,
      5000
    );
    expect(tuiClosed).toBe(false);

    replacementServer = makeUpstream(upstreamStart.port);
    await waitFor(() => upstreamConnections >= 2, 5000);
    await waitFor(
      () =>
        readLifecycleEvents(root).some(
          (event) => event.event === "upstream-reconnected"
        ),
      5000
    );
    expect(tuiClosed).toBe(false);
  } finally {
    tui?.close();
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? { ...manifest, state: "completed", status: "completed" }
        : manifest
    );
    await Promise.race([
      proxyTask ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    upstreamServer?.stop(true);
    replacementServer?.stop(true);
    const events = readLifecycleEvents(root);
    expect(
      statSync(join(root, CODEX_TMUX_PROXY_LIFECYCLE_FILE)).mode % 0o1000
    ).toBe(0o600);
    expect(events.some((event) => event.event === "started")).toBe(true);
    expect(
      events.some(
        (event) => event.event === "stopped" && event.reason === "inactive-run"
      )
    ).toBe(true);
    expect(
      JSON.stringify(events).includes("hello") ||
        JSON.stringify(events).includes("thread-1")
    ).toBe(false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex tmux proxy never injects a bridge request into app-server after reconnect", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const bridgeMethods: string[] = [];
  const upstreamSockets: ServerWebSocket<{ initialized: boolean }>[] = [];
  let activeTurnId = "";
  let proxyTask: Promise<void> | undefined;
  let upstreamConnections = 0;

  const upstreamStart = await startServerWithRetries((port) =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request, { data: { initialized: false } })) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        close: (ws) => {
          const index = upstreamSockets.indexOf(ws);
          if (index !== -1) {
            upstreamSockets.splice(index, 1);
          }
        },
        message: (ws, message) => {
          const payload =
            typeof message === "string" ? message : message.toString();
          for (const raw of payload.split("\n")) {
            if (!raw.trim()) {
              continue;
            }
            const frame = JSON.parse(raw) as JsonFrame;
            if (frame.method === "initialize") {
              if (ws.data.initialized) {
                ws.send(
                  JSON.stringify({
                    error: { message: "already initialized" },
                    id: frame.id,
                  })
                );
              } else {
                ws.data.initialized = true;
                ws.send(JSON.stringify({ id: frame.id, result: {} }));
              }
              continue;
            }
            if (frame.method === "initialized") {
              continue;
            }
            if (frame.method === "thread/read") {
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: {
                    thread: {
                      turns: activeTurnId
                        ? [{ id: activeTurnId, status: "inProgress" }]
                        : [],
                    },
                  },
                })
              );
              continue;
            }
            if (frame.method === "turn/start") {
              if (isBridgeRequestId(frame.id)) {
                bridgeMethods.push(frame.method);
                ws.send(
                  JSON.stringify({
                    error: { message: "turn still active" },
                    id: frame.id,
                  })
                );
                continue;
              }
              activeTurnId = "tui-turn-1";
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: activeTurnId } },
                })
              );
              continue;
            }
            if (frame.method === "turn/steer") {
              bridgeMethods.push(frame.method);
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: activeTurnId } },
                })
              );
            }
          }
        },
        open: (ws) => {
          upstreamConnections += 1;
          upstreamSockets.push(ws);
        },
      },
    })
  );
  const upstreamServer = upstreamStart.server;
  const upstreamUrl = `ws://127.0.0.1:${upstreamStart.port}/`;
  const tuiMessages: JsonFrame[] = [];

  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "10",
      state: "working",
      status: "running",
    })
  );

  let tui: WebSocket | undefined;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1"
    );
    proxyTask = proxyStart.proxyTask;
    tui = new WebSocket(proxyStart.proxyUrl);
    tui.onmessage = (event) => {
      tuiMessages.push(JSON.parse(String(event.data)) as JsonFrame);
    };

    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () => reject(new Error("failed to open tui websocket"));
    });

    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(
      () => tuiMessages.some((frame) => frame.id === 1 && frame.result),
      5000
    );

    tui.send(
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello before reconnect",
              text_elements: [],
              type: "text",
            },
          ],
          threadId: "thread-1",
        },
      })
    );
    await waitFor(
      () =>
        tuiMessages.some(
          (frame) =>
            frame.id === 2 &&
            (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
        ),
      5000
    );

    upstreamSockets[0]?.close();
    await waitFor(() => upstreamConnections >= 2, 5000);

    appendBridgeMessage(
      root,
      bridgeMessage.source,
      bridgeMessage.target,
      bridgeMessage.message
    );
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(bridgeMethods).toEqual([]);
    expect(readPendingBridgeMessages(root)).toHaveLength(1);
  } finally {
    tui?.close();
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            state: "completed",
            status: "completed",
          }
        : manifest
    );
    await Promise.race([
      proxyTask ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    upstreamServer.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex tmux proxy has no headless fallback when visible delivery is unavailable", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const bridgeMethods: string[] = [];
  const upstreamSockets: ServerWebSocket<{ initialized: boolean }>[] = [];
  let activeTurnId = "";
  let proxyTask: Promise<void> | undefined;
  let upstreamConnections = 0;
  let steerAttempts = 0;

  const upstreamStart = await startServerWithRetries((port) =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request, { data: { initialized: false } })) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        close: (ws) => {
          const index = upstreamSockets.indexOf(ws);
          if (index !== -1) {
            upstreamSockets.splice(index, 1);
          }
        },
        message: (ws, message) => {
          const payload =
            typeof message === "string" ? message : message.toString();
          for (const raw of payload.split("\n")) {
            if (!raw.trim()) {
              continue;
            }
            const frame = JSON.parse(raw) as JsonFrame;
            if (frame.method === "initialize") {
              if (ws.data.initialized) {
                ws.send(
                  JSON.stringify({
                    error: { message: "already initialized" },
                    id: frame.id,
                  })
                );
              } else {
                ws.data.initialized = true;
                ws.send(JSON.stringify({ id: frame.id, result: {} }));
              }
              continue;
            }
            if (frame.method === "initialized") {
              continue;
            }
            if (frame.method === "thread/read") {
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: {
                    thread: {
                      turns: activeTurnId
                        ? [{ id: activeTurnId, status: "inProgress" }]
                        : [],
                    },
                  },
                })
              );
              continue;
            }
            if (frame.method === "turn/start") {
              if (isBridgeRequestId(frame.id)) {
                bridgeMethods.push(frame.method);
                activeTurnId = "bridge-turn-after-reconnect";
                ws.send(
                  JSON.stringify({
                    id: frame.id,
                    result: { turn: { id: activeTurnId } },
                  })
                );
                continue;
              }
              activeTurnId = "tui-turn-1";
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: activeTurnId } },
                })
              );
              continue;
            }
            if (frame.method === "turn/steer") {
              bridgeMethods.push(frame.method);
              steerAttempts += 1;
              if (steerAttempts === 1) {
                ws.send(
                  JSON.stringify({
                    error: { message: "cannot steer resumed turn" },
                    id: frame.id,
                  })
                );
                continue;
              }
              ws.send(
                JSON.stringify({
                  id: frame.id,
                  result: { turn: { id: activeTurnId } },
                })
              );
            }
          }
        },
        open: (ws) => {
          upstreamConnections += 1;
          upstreamSockets.push(ws);
        },
      },
    })
  );
  const upstreamServer = upstreamStart.server;
  const upstreamUrl = `ws://127.0.0.1:${upstreamStart.port}/`;
  const tuiMessages: JsonFrame[] = [];

  writeRunManifest(
    manifestPath,
    createRunManifest({
      claudeSessionId: "claude-1",
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "11",
      state: "working",
      status: "running",
    })
  );

  let tui: WebSocket | undefined;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1"
    );
    proxyTask = proxyStart.proxyTask;
    tui = new WebSocket(proxyStart.proxyUrl);
    tui.onmessage = (event) => {
      tuiMessages.push(JSON.parse(String(event.data)) as JsonFrame);
    };

    await new Promise<void>((resolve, reject) => {
      if (!tui) {
        reject(new Error("missing tui websocket"));
        return;
      }
      tui.onopen = () => resolve();
      tui.onerror = () => reject(new Error("failed to open tui websocket"));
    });

    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(
      () => tuiMessages.some((frame) => frame.id === 1 && frame.result),
      5000
    );

    tui.send(
      JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          input: [
            {
              text: "hello before reconnect",
              text_elements: [],
              type: "text",
            },
          ],
          threadId: "thread-1",
        },
      })
    );
    await waitFor(
      () =>
        tuiMessages.some(
          (frame) =>
            frame.id === 2 &&
            (frame.result as { turn?: { id?: string } } | undefined)?.turn?.id
        ),
      5000
    );

    upstreamSockets[0]?.close();
    await waitFor(() => upstreamConnections >= 2, 5000);

    appendBridgeMessage(
      root,
      bridgeMessage.source,
      bridgeMessage.target,
      bridgeMessage.message
    );
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(bridgeMethods).toEqual([]);
    expect(readPendingBridgeMessages(root)).toHaveLength(1);
  } finally {
    tui?.close();
    updateRunManifest(manifestPath, (manifest) =>
      manifest
        ? {
            ...manifest,
            state: "completed",
            status: "completed",
          }
        : manifest
    );
    await Promise.race([
      proxyTask ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    upstreamServer.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex tmux proxy records shutdown producer and observed peer before stopping", async () => {
  const root = makeTempDir();
  const manifestPath = join(root, "manifest.json");
  const upstreamStart = await startServerWithRetries((port) =>
    serve({
      fetch: (request, server) => {
        if (server.upgrade(request, { data: { initialized: false } })) {
          return undefined;
        }
        return new Response("upstream");
      },
      hostname: "127.0.0.1",
      port,
      websocket: {
        message: (ws, message) => {
          const frame = JSON.parse(String(message)) as JsonFrame;
          if (frame.method === "initialize") {
            ws.send(JSON.stringify({ id: frame.id, result: {} }));
          }
        },
      },
    })
  );
  const upstreamUrl = `ws://127.0.0.1:${upstreamStart.port}/`;
  writeRunManifest(
    manifestPath,
    createRunManifest({
      codexRemoteUrl: upstreamUrl,
      codexThreadId: "thread-1",
      cwd: "/repo",
      mode: "paired",
      pid: 1234,
      repoId: "repo-123",
      runId: "10",
      state: "working",
      status: "running",
    })
  );
  let proxyTask: Promise<void> | undefined;
  try {
    const proxyStart = await startProxyWithRetries(
      root,
      upstreamUrl,
      "thread-1",
      { tmuxLiveness: () => "live" }
    );
    proxyTask = proxyStart.proxyTask;
    await stopCodexTmuxProxy(proxyStart.proxyUrl, {
      caller: "paired-start-cleanup",
      requesterPid: process.pid,
    });
    await proxyTask;
    const events = readLifecycleEvents(root);
    const requestedIndex = events.findIndex(
      (event) => event.event === "shutdown-requested"
    );
    const stoppedIndex = events.findIndex(
      (event) => event.event === "stopped" && event.reason === "requested"
    );
    expect(requestedIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedIndex).toBeGreaterThan(requestedIndex);
    expect(events[requestedIndex]).toMatchObject({
      declaredCaller: "paired-start-cleanup",
      declaredRequesterPid: process.pid,
      peerAddress: "127.0.0.1",
      peerFamily: "IPv4",
    });
    expect(events[requestedIndex]?.peerPort).toBeGreaterThan(0);
  } finally {
    upstreamStart.server.stop(true);
    await proxyTask?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
