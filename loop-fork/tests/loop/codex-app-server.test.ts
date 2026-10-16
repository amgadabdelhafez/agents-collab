import { afterEach, expect, mock, test } from "bun:test";
import { buildCodexBridgeConfigArgs } from "../../src/loop/bridge-config";
import { createCodexRenderer } from "../../src/loop/codex-render";
import { createRunReview } from "../../src/loop/review";
import type { Options } from "../../src/loop/types";
import { hasSignal } from "../../src/loop/utils";

interface RequestFrame {
  error?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
}

type AppServerModule = typeof import("../../src/loop/codex-app-server");

interface TestStream {
  close: () => void;
  enqueue: (line: string) => void;
  stream: ReadableStream<Uint8Array>;
}

interface TestProcess {
  close: () => void;
  killSignals: string[];
  pid: number;
  unrefCount: number;
  writes: string[];
}

interface TestSocket {
  acceptedByPid: number | undefined;
  client: import("../../src/loop/ws-client").WsClient;
  closeCount: number;
  terminateCount: number;
}

type ResponseWriter = (frame: Record<string, unknown>) => void;
type RequestHandler = (request: RequestFrame, write: ResponseWriter) => void;
const LOCAL_WS_URL_RE = /^ws:\/\/127\.0\.0\.1:\d+$/;

const noopRequestHandler: RequestHandler = () => {
  // noop
};

const createStream = (): TestStream => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    close: () => {
      controller?.close();
    },
    enqueue: (line) => {
      controller?.enqueue(new TextEncoder().encode(line));
    },
    stream,
  };
};

let modulePromise: Promise<AppServerModule> | undefined;
let moduleExports: AppServerModule | undefined;
let codexAppServerInternals: AppServerModule["codexAppServerInternals"];
let processes: TestProcess[] = [];
let currentHandler: RequestHandler = noopRequestHandler;
let lastSpawnCommand: string[] = [];
let wsWrites: string[] = [];
let sockets: TestSocket[] = [];
let killClosesProcess = true;

const makeStreamResponse = (
  request: RequestFrame,
  write: ResponseWriter
): void => {
  currentHandler(request, write);
};

const installSpawn = (appServerModule: AppServerModule): void => {
  appServerModule.codexAppServerInternals.setSpawnFn(
    (_command: unknown, _options: unknown): unknown => {
      lastSpawnCommand = Array.isArray(_command)
        ? _command.map((part) => String(part))
        : [];
      const writes: string[] = [];
      const killSignals: string[] = [];
      const pid = 10_000 + processes.length + 1;
      const stdout = createStream();
      const stderr = createStream();
      let exitedResolve = () => undefined;
      const exited = new Promise<number>((resolve) => {
        exitedResolve = resolve;
      });
      let closed = false;

      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        stdout.close();
        stderr.close();
        exitedResolve(0);
      };

      const emit = (frame: Record<string, unknown>): void => {
        stdout.enqueue(`${JSON.stringify(frame)}\n`);
      };

      const processState: TestProcess = {
        close,
        killSignals,
        pid,
        unrefCount: 0,
        writes,
      };

      const child = {
        exited,
        kill: (signal?: string) => {
          killSignals.push(signal ?? "SIGTERM");
          if (killClosesProcess) {
            close();
          }
        },
        pid,
        unref: () => {
          processState.unrefCount += 1;
        },
        stdin: {
          write: (chunk: string): void => {
            const lines = chunk.split("\n");
            for (const raw of lines) {
              if (!raw.trim()) {
                continue;
              }
              writes.push(raw);
              const request = JSON.parse(raw) as RequestFrame;
              makeStreamResponse(request, emit);
            }
          },
        },
        stderr: stderr.stream,
        stdout: stdout.stream,
      };
      processes.push(processState);
      return child;
    }
  );
};

const createTestSocket = (
  acceptedByPid = latestProcess()?.pid
): import("../../src/loop/ws-client").WsClient => {
  const nativeSocketFd = 200 + sockets.length;
  const socket: TestSocket = {
    acceptedByPid,
    client: undefined as never,
    closeCount: 0,
    terminateCount: 0,
  };
  const client: import("../../src/loop/ws-client").WsClient = {
    acceptedByPid: (pid) => socket.acceptedByPid === pid,
    nativeSocketFd,
    onmessage: undefined,
    onclose: undefined,
    send: (data: string) => {
      for (const raw of data.split("\n")) {
        if (!raw.trim()) {
          continue;
        }
        wsWrites.push(raw);
        const proc = processes.at(-1);
        if (proc) {
          proc.writes.push(raw);
        }
        const request = JSON.parse(raw) as RequestFrame;
        makeStreamResponse(request, (frame) => {
          queueMicrotask(() => {
            client.onmessage?.(JSON.stringify(frame));
          });
        });
      }
    },
    close: () => {
      socket.closeCount += 1;
    },
    terminate: () => {
      socket.terminateCount += 1;
    },
  };
  socket.client = client;
  sockets.push(socket);
  return client;
};

const installConnectWs = (appServerModule: AppServerModule): void => {
  appServerModule.codexAppServerInternals.setListenerOwnerPidFn(
    () => processes.at(-1)?.pid
  );
  appServerModule.codexAppServerInternals.setConnectWsFn(() =>
    Promise.resolve(createTestSocket())
  );
};

const getModule = async (): Promise<AppServerModule> => {
  if (!modulePromise) {
    modulePromise = import(
      `../../src/loop/codex-app-server?test=${Date.now()}-${Math.random()}`
    );
  }
  moduleExports = await modulePromise;
  codexAppServerInternals = moduleExports.codexAppServerInternals;
  installSpawn(moduleExports);
  installConnectWs(moduleExports);
  return moduleExports;
};

const makeOptions = (): Options => ({
  agent: "codex",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  codexModel: "test-model",
  proof: "proof",
});

const latestWrites = (): string[] => {
  return processes.at(-1)?.writes ?? [];
};

const latestFrames = (): RequestFrame[] =>
  latestWrites().map((line) => JSON.parse(line) as RequestFrame);

const latestProcess = (): TestProcess | undefined => processes.at(-1);

const resetState = async (): Promise<void> => {
  const appServer = await getModule();
  await appServer.closeAppServer();
  for (const process of processes) {
    process.close();
  }
  moduleExports = undefined;
  modulePromise = undefined;
  processes = [];
  currentHandler = noopRequestHandler;
  lastSpawnCommand = [];
  wsWrites = [];
  sockets = [];
  killClosesProcess = true;
  appServer.codexAppServerInternals.restoreSpawnFn();
  appServer.codexAppServerInternals.restoreConnectWsFn();
  appServer.codexAppServerInternals.restoreListenerOwnerPidFn();
};

afterEach(async () => {
  await resetState();
  mock.restore();
});

test("parseLine returns strict JSON frames only", async () => {
  await getModule();
  expect(codexAppServerInternals.parseLine('{"ok":true}')).toEqual({
    ok: true,
  });
  expect(codexAppServerInternals.parseLine("not-json")).toBeUndefined();
  expect(codexAppServerInternals.parseLine('  {"ok":1}\n')).toEqual({ ok: 1 });
});

test("parseText flattens nested text payloads", async () => {
  await getModule();
  expect(
    codexAppServerInternals.parseText({
      content: [{ text: "  one " }, { content: [{ text: "two" }, ""] }],
    })
  ).toBe("one\ntwo");
});

test("startAppServer fails fast when initialize returns an error", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, error: { message: "unsupported transport" } });
    }
  };

  await expect(appServer.startAppServer()).rejects.toBeInstanceOf(
    appServer.CodexAppServerFallbackError
  );
  expect(latestWrites().length).toBeGreaterThan(0);
  expect(appServer.getCodexAppServerPid()).toBeUndefined();
  expect(appServer.getCodexAppServerUrl()).toBe("");
  expect(latestProcess()?.killSignals).toEqual(["SIGTERM"]);
  expect(sockets.at(-1)?.terminateCount).toBe(1);
});

test("startAppServer forwards config overrides into the app-server command", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  await appServer.startAppServer({
    configValues: ['mcp_servers.bridge.command="/bin/echo"'],
    persistentThread: true,
  });

  expect(lastSpawnCommand.slice(0, 5)).toEqual([
    "codex",
    "-c",
    'mcp_servers.bridge.command="/bin/echo"',
    "app-server",
    "--listen",
  ]);
  expect(lastSpawnCommand[5]).toContain("ws://127.0.0.1:");
});

test("startAppServer exposes the app-server websocket URL", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  await appServer.startAppServer();
  expect(appServer.getCodexAppServerUrl()).toMatch(LOCAL_WS_URL_RE);
  const ownedProcess = latestProcess();
  const ownedSocket = sockets.at(-1);

  await appServer.closeAppServer();
  expect(appServer.getCodexAppServerUrl()).toBe("");
  expect(ownedProcess?.killSignals).toEqual(["SIGTERM"]);
  expect(ownedSocket?.closeCount).toBe(1);
});

test("startAppServer refuses a foreign listener before connecting", async () => {
  const appServer = await getModule();
  appServer.codexAppServerInternals.setListenerOwnerPidFn(() => 99_999);

  await expect(appServer.startAppServer()).rejects.toThrow(
    "listener is not owned by the spawned process"
  );

  expect(appServer.getCodexAppServerPid()).toBeUndefined();
  expect(appServer.getCodexAppServerUrl()).toBe("");
  expect(latestProcess()?.killSignals).toEqual(["SIGTERM"]);
  expect(sockets).toHaveLength(0);
});

test("process exit cleanup retains the exact child during listener wait", async () => {
  const appServer = await getModule();
  let cleanupCalled = false;
  appServer.codexAppServerInternals.setListenerOwnerPidFn(() => {
    if (!cleanupCalled) {
      cleanupCalled = true;
      expect(appServer.getCodexAppServerPid()).toBeUndefined();
      appServer.codexAppServerInternals.cleanupOnProcessExit();
    }
    return undefined;
  });

  await expect(appServer.startAppServer()).rejects.toBeInstanceOf(
    appServer.CodexAppServerFallbackError
  );

  expect(cleanupCalled).toBe(true);
  expect(latestProcess()?.killSignals[0]).toBe("SIGKILL");
  expect(sockets).toHaveLength(0);
});

test("process exit cleanup retains exact child and socket during connect", async () => {
  const appServer = await getModule();
  let attemptedSocket: TestSocket | undefined;
  appServer.codexAppServerInternals.setConnectWsFn(() => {
    expect(appServer.getCodexAppServerPid()).toBeUndefined();
    appServer.codexAppServerInternals.cleanupOnProcessExit();
    const client = createTestSocket();
    attemptedSocket = sockets.at(-1);
    return Promise.resolve(client);
  });

  await expect(appServer.startAppServer()).rejects.toBeInstanceOf(
    appServer.CodexAppServerFallbackError
  );

  expect(latestProcess()?.killSignals[0]).toBe("SIGKILL");
  expect(attemptedSocket?.closeCount).toBeGreaterThanOrEqual(1);
});

test("a rejected WebSocket handshake cleans the exact startup child", async () => {
  const appServer = await getModule();
  let listenerPid: number | undefined;
  appServer.codexAppServerInternals.setListenerOwnerPidFn(
    () => listenerPid ?? latestProcess()?.pid
  );
  appServer.codexAppServerInternals.setConnectWsFn(() => {
    listenerPid = 99_999;
    return Promise.reject(new Error("WebSocket upgrade failed: HTTP 403"));
  });

  await expect(appServer.startAppServer()).rejects.toBeInstanceOf(
    appServer.CodexAppServerFallbackError
  );

  expect(latestProcess()?.killSignals).toContain("SIGTERM");
  expect(appServer.getCodexAppServerPid()).toBeUndefined();
  expect(appServer.getCodexAppServerUrl()).toBe("");
});

test("startAppServer rejects a listener replacement during connection", async () => {
  const appServer = await getModule();
  let attemptedChild: TestProcess | undefined;
  let listenerPid: number | undefined;
  appServer.codexAppServerInternals.setListenerOwnerPidFn(
    () => listenerPid ?? latestProcess()?.pid
  );
  appServer.codexAppServerInternals.setConnectWsFn(() => {
    attemptedChild = latestProcess();
    listenerPid = 99_999;
    return Promise.resolve(createTestSocket());
  });

  await expect(appServer.startAppServer()).rejects.toThrow(
    "listener is not owned by the spawned process"
  );

  expect(attemptedChild?.killSignals).toEqual(["SIGTERM"]);
  expect(sockets.at(-1)?.terminateCount).toBe(1);
  expect(sockets.at(-1)?.closeCount).toBe(0);
  expect(latestWrites()).toEqual([]);
});

test("startAppServer rejects an owner change immediately after connect", async () => {
  const appServer = await getModule();
  let ownershipChecks = 0;
  appServer.codexAppServerInternals.setListenerOwnerPidFn(() => {
    ownershipChecks += 1;
    return ownershipChecks <= 2 ? latestProcess()?.pid : 99_999;
  });

  await expect(appServer.startAppServer()).rejects.toThrow(
    "listener is not owned by the spawned process"
  );

  expect(ownershipChecks).toBe(3);
  expect(latestProcess()?.killSignals).toEqual(["SIGTERM"]);
  expect(sockets.at(-1)?.terminateCount).toBe(1);
  expect(sockets.at(-1)?.closeCount).toBe(0);
  expect(latestWrites()).toEqual([]);
});

test("startAppServer rejects child-to-foreign-to-child connection ABA", async () => {
  const appServer = await getModule();
  let listenerChecks = 0;
  appServer.codexAppServerInternals.setListenerOwnerPidFn(() => {
    listenerChecks += 1;
    return latestProcess()?.pid;
  });
  appServer.codexAppServerInternals.setConnectWsFn(() =>
    Promise.resolve(createTestSocket(99_999))
  );

  await expect(appServer.startAppServer()).rejects.toThrow(
    "connection was not accepted by the spawned process"
  );

  expect(listenerChecks).toBe(3);
  expect(latestProcess()?.killSignals).toEqual(["SIGTERM"]);
  expect(sockets.at(-1)?.acceptedByPid).toBe(99_999);
  expect(sockets.at(-1)?.terminateCount).toBe(1);
  expect(sockets.at(-1)?.closeCount).toBe(0);
  expect(latestWrites()).toEqual([]);
});

test("startAppServer accepts an unchanged exact-child listener", async () => {
  const appServer = await getModule();
  const observedOwners: Array<number | undefined> = [];
  appServer.codexAppServerInternals.setListenerOwnerPidFn(() => {
    const pid = latestProcess()?.pid;
    observedOwners.push(pid);
    return pid;
  });
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  await appServer.startAppServer();

  expect(observedOwners).toEqual([
    latestProcess()?.pid,
    latestProcess()?.pid,
    latestProcess()?.pid,
  ]);
  expect(appServer.getCodexAppServerPid()).toBe(latestProcess()?.pid);
  expect(sockets.at(-1)?.closeCount).toBe(0);
});

test("process exit cleanup retains exact child and socket during initialize", async () => {
  const appServer = await getModule();
  currentHandler = (request) => {
    if (request.method === "initialize") {
      expect(appServer.getCodexAppServerPid()).toBeUndefined();
      appServer.codexAppServerInternals.cleanupOnProcessExit();
    }
  };

  await expect(appServer.startAppServer()).rejects.toBeInstanceOf(
    appServer.CodexAppServerFallbackError
  );

  expect(latestProcess()?.killSignals[0]).toBe("SIGKILL");
  expect(sockets.at(-1)?.closeCount).toBeGreaterThanOrEqual(1);
});

test("cancelled connecting launch cannot clear a later replacement", async () => {
  const appServer = await getModule();
  let markConnectStarted = () => undefined;
  const connectStarted = new Promise<void>((resolve) => {
    markConnectStarted = resolve;
  });
  appServer.codexAppServerInternals.setConnectWsFn(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        const cancelledSocket = createTestSocket(latestProcess()?.pid);
        const rejectCancelled = () => {
          cancelledSocket.close();
          reject(new Error("WebSocket upgrade cancelled"));
        };
        if (options?.signal?.aborted) {
          rejectCancelled();
          return;
        }
        options?.signal?.addEventListener("abort", rejectCancelled, {
          once: true,
        });
        markConnectStarted();
      })
  );

  const cancelledStart = appServer.startAppServer();
  await connectStarted;
  const cancelledChild = latestProcess();
  const cancelledSocket = sockets.at(-1);
  const cancelledClose = appServer.closeAppServer();

  await expect(cancelledStart).rejects.toBeInstanceOf(
    appServer.CodexAppServerFallbackError
  );
  await cancelledClose;
  expect(cancelledChild?.killSignals).toContain("SIGTERM");
  expect(cancelledSocket?.closeCount).toBe(1);

  installConnectWs(appServer);
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };
  await appServer.startAppServer();
  const replacement = latestProcess();
  expect(appServer.getCodexAppServerPid()).toBe(replacement?.pid);
  expect(replacement?.killSignals).toEqual([]);
});

test("stale child EOF cannot clear a replacement launch generation", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };
  killClosesProcess = false;
  await appServer.startAppServer();
  const oldProcess = latestProcess();
  const oldSocket = sockets.at(-1);
  oldSocket?.client.onclose?.();
  expect(oldProcess?.killSignals).toEqual(["SIGTERM"]);

  await appServer.startAppServer();
  const replacement = latestProcess();
  const replacementSocket = sockets.at(-1);
  oldProcess?.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(appServer.getCodexAppServerPid()).toBe(replacement?.pid);
  expect(replacementSocket?.closeCount).toBe(0);
  killClosesProcess = true;
  await appServer.closeAppServer();
  expect(replacement?.killSignals).toEqual(["SIGTERM"]);
});

test("stale socket messages cannot enter a replacement turn", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };
  await appServer.startAppServer();
  const oldSocket = sockets.at(-1);
  oldSocket?.client.onclose?.();

  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        oldSocket?.client.onmessage?.(
          `${JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-1",
              delta: "<promise>DONE</promise>",
            },
          })}\n`
        );
        write({
          method: "item/agentMessage/delta",
          params: { turnId: "turn-1", delta: "replacement output" },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };
  await appServer.startAppServer();

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("replacement output");
  expect(result.combined).not.toContain("<promise>DONE</promise>");
  expect(rawLines.join("\n")).not.toContain("<promise>DONE</promise>");
});

test("a deferred old close cannot clear a replacement singleton", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };
  killClosesProcess = false;
  await appServer.startAppServer();
  const oldProcess = latestProcess();
  const oldSocket = sockets.at(-1);

  const oldClose = appServer.closeAppServer();
  expect(oldProcess?.killSignals).toEqual(["SIGTERM"]);
  expect(oldSocket?.closeCount).toBe(1);

  await appServer.startAppServer();
  const replacement = latestProcess();
  const replacementSocket = sockets.at(-1);
  oldProcess?.close();
  await oldClose;

  expect(appServer.getCodexAppServerPid()).toBe(replacement?.pid);
  expect(replacementSocket?.closeCount).toBe(0);
  expect(replacement?.killSignals).toEqual([]);
  killClosesProcess = true;
  await appServer.closeAppServer();
  expect(replacement?.killSignals).toEqual(["SIGTERM"]);
});

test("startAppServer sends initialized after initialize", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  await appServer.startAppServer();

  expect(latestFrames().map((frame) => frame.method)).toEqual([
    "initialize",
    "initialized",
  ]);
});

test("releaseAppServer drops local handles without killing the detached child", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
    }
  };

  await appServer.startAppServer({
    orphanOnExit: true,
    persistentThread: true,
    threadModel: "test-model",
  });

  expect(appServer.getCodexAppServerUrl()).toMatch(LOCAL_WS_URL_RE);
  expect(latestProcess()?.unrefCount).toBe(1);
  appServer.releaseAppServer();
  appServer.codexAppServerInternals.cleanupOnProcessExit();
  expect(latestProcess()?.killSignals).toEqual([]);
  expect(sockets.at(-1)?.closeCount).toBe(1);
  expect(appServer.getCodexAppServerUrl()).toBe("");
});

test("startAppServer normalizes codex bridge config args before spawning", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  const secretToken = "recipient-token-must-not-reach-argv";
  const previousToken = process.env.LOOP_RECIPIENT_API_TOKEN;
  process.env.LOOP_RECIPIENT_API_TOKEN = secretToken;
  try {
    await appServer.startAppServer({
      configValues: buildCodexBridgeConfigArgs("/tmp/loop-run", "codex"),
    });
  } finally {
    if (previousToken === undefined) {
      Reflect.deleteProperty(process.env, "LOOP_RECIPIENT_API_TOKEN");
    } else {
      process.env.LOOP_RECIPIENT_API_TOKEN = previousToken;
    }
  }

  expect(lastSpawnCommand.join("\n")).not.toContain(secretToken);
  expect(lastSpawnCommand.filter((value) => value === "-c")).toHaveLength(13);
  expect(lastSpawnCommand).toContain("app-server");
  expect(lastSpawnCommand).not.toContain("-c,-c");
  const bridgeArgs = lastSpawnCommand.slice(
    lastSpawnCommand.indexOf("-c"),
    lastSpawnCommand.indexOf("app-server")
  );
  expect(bridgeArgs).toEqual([
    "-c",
    expect.stringContaining("mcp_servers.loop-bridge.command="),
    "-c",
    expect.stringContaining("mcp_servers.loop-bridge.args="),
    "-c",
    'mcp_servers.loop-bridge.env_vars=["LOOP_RECIPIENT_RUN_DIR","LOOP_RECIPIENT_SEAT","LOOP_RECIPIENT_API_URL","LOOP_RECIPIENT_API_TOKEN"]',
    "-c",
    'mcp_servers.loop-bridge.tools.send_message.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.route_task.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.task_status.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.get_task_result.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.import_reviewed_patch.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.apply_task_patch.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.request_native_fallback.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.native_fallback_status.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.bridge_status.approval_mode="approve"',
    "-c",
    'mcp_servers.loop-bridge.tools.receive_messages.approval_mode="approve"',
  ]);
});

test("injectCodexMessage sends the bridge handshake and notification opt-outs", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      write({ id: request.id, result: { thread: { turns: [] } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
    }
  };

  await appServer.startAppServer();
  latestProcess()?.writes.splice(0);

  const delivered = await appServer.injectCodexMessage(
    appServer.getCodexAppServerUrl(),
    "thread-1",
    "Please review the latest diff."
  );

  expect(delivered).toBe(true);
  const frames = latestFrames();
  expect(frames.map((frame) => frame.method)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "turn/start",
  ]);
  expect(frames[0]?.params).toMatchObject({
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: ["item/completed", "item/agentMessage/delta"],
    },
    clientInfo: {
      name: "loop-bridge",
      title: "loop-bridge",
    },
  });
  expect(frames[2]?.params).toMatchObject({
    includeTurns: true,
    threadId: "thread-1",
  });
  expect(frames[3]?.params).toMatchObject({
    input: [
      {
        text: "Please review the latest diff.",
        text_elements: [],
        type: "text",
      },
    ],
    threadId: "thread-1",
  });
});

test("injectCodexMessage steers an active turn instead of starting a new turn", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      write({
        id: request.id,
        result: {
          thread: {
            turns: [{ id: "turn-active", status: "inProgress" }],
          },
        },
      });
      return;
    }
    if (request.method === "turn/steer") {
      write({ id: request.id, result: { turnId: "turn-active" } });
    }
  };

  await expect(
    appServer.injectCodexMessage(
      "ws://127.0.0.1:4500",
      "thread-1",
      "Please review the final diff."
    )
  ).resolves.toBe(true);
  const frames = wsWrites.map((line) => JSON.parse(line) as RequestFrame);
  expect(frames.map((frame) => frame.method)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "turn/steer",
  ]);
  expect(frames[3]?.params).toMatchObject({
    expectedTurnId: "turn-active",
    threadId: "thread-1",
  });
});

test("injectCodexMessage resumes an evicted persisted thread before delivery", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      write({ id: request.id, error: { message: "thread not loaded" } });
      return;
    }
    if (request.method === "thread/resume") {
      write({ id: request.id, result: { thread: { turns: [] } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-resumed" } } });
    }
  };

  await expect(
    appServer.injectCodexMessage(
      "ws://127.0.0.1:4500",
      "thread-evicted",
      "Drain the durable bridge inbox."
    )
  ).resolves.toBe(true);
  const frames = wsWrites.map((line) => JSON.parse(line) as RequestFrame);
  expect(frames.map((frame) => frame.method)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "thread/resume",
    "turn/start",
  ]);
  expect(frames[3]?.params).toEqual({
    excludeTurns: false,
    threadId: "thread-evicted",
  });
});

test("injectCodexMessage resumes without turns when list_turns is unsupported", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      write({ id: request.id, error: { message: "thread not loaded" } });
      return;
    }
    if (request.method === "thread/resume") {
      const params = request.params as { excludeTurns?: boolean };
      if (!params.excludeTurns) {
        write({
          id: request.id,
          error: { message: "list_turns is not supported yet" },
        });
        return;
      }
      write({ id: request.id, result: { thread: {} } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-fallback" } } });
    }
  };

  await expect(
    appServer.injectCodexMessage(
      "ws://127.0.0.1:4500",
      "thread-legacy",
      "Drain the durable bridge inbox."
    )
  ).resolves.toBe(true);
  const frames = wsWrites.map((line) => JSON.parse(line) as RequestFrame);
  expect(frames.map((frame) => frame.method)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "thread/resume",
    "thread/resume",
    "turn/start",
  ]);
  expect(frames[4]?.params).toEqual({
    excludeTurns: true,
    threadId: "thread-legacy",
  });
});

test("injectCodexMessage fails closed when an evicted thread cannot resume", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      write({ id: request.id, error: { message: "thread not loaded" } });
      return;
    }
    if (request.method === "thread/resume") {
      write({ id: request.id, error: { message: "rollout missing" } });
    }
  };

  await expect(
    appServer.injectCodexMessage(
      "ws://127.0.0.1:4500",
      "thread-evicted",
      "Do not lose this message."
    )
  ).rejects.toThrow(
    "codex bridge could not read or resume thread thread-evicted: rollout missing"
  );
  const frames = wsWrites.map((line) => JSON.parse(line) as RequestFrame);
  expect(frames.map((frame) => frame.method)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "thread/resume",
  ]);
});

const probeHandler =
  (readError: string | undefined): RequestHandler =>
  (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      if (readError) {
        write({ id: request.id, error: { message: readError } });
        return;
      }
      write({ id: request.id, result: { thread: {} } });
      return;
    }
    if (request.method === "thread/resume") {
      write({ id: request.id, result: { thread: {} } });
    }
  };

const probeMethods = (): unknown[] =>
  wsWrites.map((line) => (JSON.parse(line) as RequestFrame).method);

test("probeCodexThread reads a loaded thread without resuming it", async () => {
  const appServer = await getModule();
  currentHandler = probeHandler(undefined);
  await expect(
    appServer.probeCodexThread("ws://127.0.0.1:4500", "thread-live")
  ).resolves.toBe(true);
  expect(probeMethods()).toEqual(["initialize", "initialized", "thread/read"]);
});

test("probeCodexThread resumes only a thread that is not loaded or has no rollout yet", async () => {
  for (const readError of [
    "thread not loaded: thread-evicted",
    "no rollout found for thread id thread-evicted",
  ]) {
    const appServer = await getModule();
    currentHandler = probeHandler(readError);
    await expect(
      appServer.probeCodexThread("ws://127.0.0.1:4500", "thread-evicted")
    ).resolves.toBe(true);
    expect(probeMethods()).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/resume",
    ]);
    await resetState();
  }
});

test("probeCodexThread treats auth and transport read errors as not ready without resuming", async () => {
  for (const readError of [
    "unauthorized: invalid bearer token",
    'codex app-server request "thread/read" timed out',
    "thread not found: thread-gone",
  ]) {
    const appServer = await getModule();
    currentHandler = probeHandler(readError);
    await expect(
      appServer.probeCodexThread("ws://127.0.0.1:4500", "thread-idle")
    ).resolves.toBe(false);
    expect(probeMethods()).toEqual([
      "initialize",
      "initialized",
      "thread/read",
    ]);
    await resetState();
  }
});

test("injectCodexMessage returns once turn/start is accepted", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      write({ id: request.id, result: { thread: { turns: [] } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
    }
  };

  let resolved = false;
  const pending = appServer
    .injectCodexMessage(
      "ws://127.0.0.1:4500",
      "thread-1",
      "Please review the final diff."
    )
    .then((value) => {
      resolved = true;
      return value;
    });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(resolved).toBe(true);
  await expect(pending).resolves.toBe(true);
});

test("injectCodexMessage retries a busy turn/start with turn/steer", async () => {
  const appServer = await getModule();
  let threadReadCount = 0;
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      threadReadCount += 1;
      write({
        id: request.id,
        result: {
          thread: {
            turns:
              threadReadCount === 1
                ? []
                : [{ id: "turn-active", status: "inProgress" }],
          },
        },
      });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, error: { message: "turn still active" } });
      return;
    }
    if (request.method === "turn/steer") {
      write({ id: request.id, result: { turnId: "turn-active" } });
    }
  };

  await expect(
    appServer.injectCodexMessage(
      "ws://127.0.0.1:4500",
      "thread-1",
      "Please review the final diff."
    )
  ).resolves.toBe(true);
  const frames = wsWrites.map((line) => JSON.parse(line) as RequestFrame);
  expect(frames.map((frame) => frame.method)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "turn/start",
    "thread/read",
    "turn/steer",
  ]);
});

test("injectCodexMessage rejects failed turn/start requests", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      write({ id: request.id, result: { thread: { turns: [] } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, error: { message: "policy blocked" } });
    }
  };

  await expect(
    appServer.injectCodexMessage(
      "ws://127.0.0.1:4500",
      "thread-1",
      "Please review the final diff."
    )
  ).rejects.toThrow("policy blocked");
});

test("runCodexTurn promotes thread/start unsupported errors to fallback errors", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, error: { message: "method not found" } });
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);
});

test("runCodexTurn promotes turn/start unsupported errors to fallback errors", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, error: { message: "unknown method" } });
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);
});

test("persistent codex threads are reused across turns", async () => {
  const appServer = await getModule();
  let threadStarts = 0;
  let turnStarts = 0;
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      threadStarts += 1;
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      turnStarts += 1;
      const turnId = `turn-${turnStarts}`;
      write({ id: request.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: { turnId, turn: { id: turnId, status: "completed" } },
        });
      }, 0);
    }
  };

  await appServer.startAppServer({ persistentThread: true });
  await appServer.runCodexTurn("first", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });
  await appServer.runCodexTurn("second", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(threadStarts).toBe(1);
  expect(turnStarts).toBe(2);
});

test("startAppServer eagerly creates a persistent thread when given a model", async () => {
  const appServer = await getModule();
  let threadStarts = 0;
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      threadStarts += 1;
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
    }
  };

  await appServer.startAppServer({
    persistentThread: true,
    threadModel: "test-model",
  });

  expect(threadStarts).toBe(1);
  expect(appServer.getLastCodexThreadId()).toBe("thread-1");
});

test("bridge-configured planning keeps the paired Codex thread alive for startup", async () => {
  const appServer = await getModule();
  let threadStarts = 0;
  let turnStarts = 0;
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      threadStarts += 1;
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      turnStarts += 1;
      const turnId = `turn-${turnStarts}`;
      write({ id: request.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: { turnId, turn: { id: turnId, status: "completed" } },
        });
      }, 0);
    }
  };

  const bridgeArgs = buildCodexBridgeConfigArgs("/tmp/loop-run", "codex");
  const opts: Options = {
    ...makeOptions(),
    codexMcpConfigArgs: bridgeArgs,
    pairedMode: true,
  };

  await appServer.startAppServer({
    configValues: bridgeArgs,
    persistentThread: true,
  });
  const result = await appServer.runCodexTurn(
    "Plan mode:\nTask:\nship feature",
    opts,
    {
      onParsed: () => undefined,
      onRaw: () => undefined,
    }
  );

  expect(result.exitCode).toBe(0);
  expect(processes).toHaveLength(1);
  expect(lastSpawnCommand.slice(0, bridgeArgs.length + 2)).toEqual([
    "codex",
    ...bridgeArgs,
    "app-server",
  ]);

  await appServer.startAppServer({
    configValues: bridgeArgs,
    persistentThread: true,
    threadModel: "test-model",
  });

  expect(processes).toHaveLength(1);
  expect(threadStarts).toBe(1);
  expect(turnStarts).toBe(1);
  expect(appServer.getLastCodexThreadId()).toBe("thread-1");
});

test("runCodexTurn recovers after unexpected exit", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      processes.at(-1)?.close();
      return;
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);

  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-2" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-2" } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-2",
            turn: { id: "turn-2", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  const frames = latestWrites().map((line) => JSON.parse(line));
  expect(result.exitCode).toBe(0);
  expect(frames.some((frame) => frame.method === "initialize")).toBe(true);
  expect(frames.some((frame) => frame.method === "thread/start")).toBe(true);
});

test("runCodexTurn parses successful deltas and completion", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: {
            turnId: "turn-1",
            delta: "hello",
          },
        });
        write({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", content: [{ text: " there" }] },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const parsedLines: string[] = [];
  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: (text) => parsedLines.push(text),
    onRaw: (text) => rawLines.push(text),
  });

  expect(result.exitCode).toBe(0);
  const turnStart = latestWrites()
    .map((line) => JSON.parse(line))
    .find((frame) => frame.method === "turn/start");
  expect(turnStart?.params).toMatchObject({
    effort: "medium",
    model: "test-model",
  });
  expect(result.parsed).toContain("hello");
  expect(result.parsed).toContain("there");
  expect(parsedLines).toContain("hello");
  expect(parsedLines.some((line) => line.includes("there"))).toBe(true);
  expect(result.combined).toContain("item/agentMessage/delta");
  expect(rawLines.length).toBeGreaterThan(0);
  expect(rawLines.join(" ")).toContain("item/agentMessage/delta");
  expect(rawLines.join(" ")).not.toContain("turn/completed");
});

test("runCodexTurn ignores foreign subagent turn notifications", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "sub-turn-1",
            delta:
              "<promise>DONE</promise> <review>PASS</review> <review>FAIL</review>",
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: { delta: "identity-less foreign output" },
        });
        write({
          method: "error",
          params: { error: { message: "identity-less foreign failure" } },
        });
        write({
          method: "turn/completed",
          params: { status: "completed" },
        });
        write({
          method: "error",
          params: {
            turnId: "sub-turn-1",
            error: { message: "subagent failed" },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "sub-turn-1",
            turn: {
              id: "sub-turn-1",
              status: "failed",
              error: { message: "subagent turn failed" },
            },
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: {
            turnId: "turn-1",
            delta: "parent turn finished",
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toContain("parent turn finished");
  expect(result.parsed).not.toContain("subagent failed");
  expect(result.combined).not.toContain("sub-turn-1");
  expect(result.combined).not.toContain("identity-less foreign output");
  expect(rawLines.join("\n")).not.toContain("<promise>DONE</promise>");
  expect(rawLines.join("\n")).not.toContain("identity-less foreign output");
});

test("runCodexTurn rejects contradictory identity aliases at every sink", async () => {
  const appServer = await getModule();
  const rejectedMarkers = [
    "conflicting turn alias output",
    "conflicting nested turn output",
    "conflicting thread alias output",
    "conflicting completed output",
    "conflicting error",
  ];
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: {
            turnId: "turn-1",
            turn_id: "foreign-turn",
            delta: rejectedMarkers[0],
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: {
            turnId: "turn-1",
            turn: { id: "foreign-turn" },
            delta: rejectedMarkers[1],
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            thread_id: "foreign-thread",
            turnId: "turn-1",
            delta: rejectedMarkers[2],
          },
        });
        write({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            turn_id: "foreign-turn",
            item: {
              type: "agentMessage",
              content: [{ text: rejectedMarkers[3] }],
            },
          },
        });
        write({
          method: "error",
          params: {
            turnId: "turn-1",
            turn: { id: "foreign-turn" },
            error: { message: rejectedMarkers[4] },
          },
        });
        write({
          id: 101,
          method: "item/commandExecution/requestApproval",
          params: {
            command: "foreign command",
            threadId: "thread-1",
            thread_id: "foreign-thread",
            turnId: "turn-1",
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: { turnId: "turn-1", delta: "parent output" },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("parent output");
  for (const marker of rejectedMarkers) {
    expect(result.parsed).not.toContain(marker);
    expect(result.combined).not.toContain(marker);
    expect(rawLines.join("\n")).not.toContain(marker);
  }
  const approvalResponse = latestFrames().find(
    (frame) => String(frame.id) === "101"
  );
  expect(approvalResponse?.result).toBeUndefined();
  expect(approvalResponse?.error).toMatchObject({
    code: -32_601,
    message: "request is not attributed to an active loop turn",
  });
});

test("runCodexTurn rejects nested object deltas from authoritative sinks", async () => {
  const appServer = await getModule();
  const doneSignal = "<promise>DONE</promise>";
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            delta: {
              payload: {
                threadId: "child-thread",
                turnId: "child-turn",
                text: doneSignal,
              },
            },
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: { turnId: "turn-1", delta: "parent output" },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("parent output");
  expect(result.combined).not.toContain(doneSignal);
  expect(rawLines.join("\n")).not.toContain(doneSignal);
  expect(hasSignal(result.parsed, doneSignal)).toBe(false);
  expect(hasSignal(result.combined, doneSignal)).toBe(false);
});

test("app-server projection preserves delta spacing and item identity", async () => {
  const appServer = await getModule();
  const writes: string[] = [];
  const renderer = createCodexRenderer({
    format: "pretty",
    write: (text) => writes.push(text),
  });
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "hello ",
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item_id: "message-1",
            delta: "world",
          },
        });
        write({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "message-1",
              type: "agentMessage",
              content: [{ text: "hello world" }],
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => {
      rawLines.push(line);
      renderer.onRawLine(line);
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("hello world");
  expect(rawLines.map((line) => JSON.parse(line))).toEqual([
    {
      method: "item/agentMessage/delta",
      params: { delta: "hello ", itemId: "message-1" },
    },
    {
      method: "item/agentMessage/delta",
      params: { delta: "world", itemId: "message-1" },
    },
  ]);
  expect(renderer.getParsed()).toBe("hello world");
  expect(writes.join("")).toBe("hello world");
});

test("app-server preserves whitespace-only and repeated scalar deltas", async () => {
  const appServer = await getModule();
  const writes: string[] = [];
  const renderer = createCodexRenderer({
    format: "pretty",
    write: (text) => writes.push(text),
  });
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        for (const delta of ["hello", " ", "world"]) {
          write({
            method: "item/agentMessage/delta",
            params: {
              turnId: "turn-1",
              itemId: "message-1",
              delta,
            },
          });
        }
        write({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              id: "message-1",
              type: "agentMessage",
              content: [{ text: "hello world" }],
            },
          },
        });
        for (const delta of ["ha", "ha"]) {
          write({
            method: "item/agentMessage/delta",
            params: {
              turnId: "turn-1",
              itemId: "message-2",
              delta,
            },
          });
        }
        write({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              id: "message-2",
              type: "agentMessage",
              content: [{ text: "haha" }],
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => {
      rawLines.push(line);
      renderer.onRawLine(line);
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("hello world\nhaha");
  expect(renderer.getParsed()).toBe("hello world\nhaha");
  expect(writes.join("")).toBe("hello world\n\nhaha");
  expect(
    rawLines.map(
      (line) => (JSON.parse(line).params as Record<string, unknown>).delta
    )
  ).toEqual(["hello", " ", "world", "ha", "ha"]);
});

test("app-server suppresses exact completed-item replay by item identity", async () => {
  const appServer = await getModule();
  const writes: string[] = [];
  const renderer = createCodexRenderer({
    format: "pretty",
    write: (text) => writes.push(text),
  });
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        const completed = (id: string) => ({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              id,
              type: "agentMessage",
              text: "hello",
            },
          },
        });
        write(completed("message-1"));
        write(completed("message-1"));
        write(completed("message-2"));
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => {
      rawLines.push(line);
      renderer.onRawLine(line);
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("hello\nhello");
  expect(result.combined.match(/item\/completed/g)).toHaveLength(2);
  expect(rawLines).toHaveLength(2);
  expect(renderer.getParsed()).toBe("hello\nhello");
  expect(writes.join("")).toBe("hello\n\nhello");
});

test("runCodexTurn excludes nested collab completion from authoritative output", async () => {
  const appServer = await getModule();
  const doneSignal = "<promise>DONE</promise>";
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "collabAgentToolCall",
              agentsStates: {
                child: { message: doneSignal, status: "completed" },
              },
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("");
  expect(result.combined).toBe("");
  expect(rawLines).toEqual([]);
  expect(hasSignal(result.combined, doneSignal)).toBe(false);
});

test("completed parent messages exclude nested payload signals", async () => {
  const appServer = await getModule();
  const doneSignal = "<promise>DONE</promise>";
  const reviewPass = "<review>PASS</review>";
  const reviewFail = "<review>FAIL</review>";
  const writes: string[] = [];
  const renderer = createCodexRenderer({
    format: "pretty",
    write: (text) => writes.push(text),
  });
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              id: "message-1",
              type: "agentMessage",
              text: "parent completion",
              content: [
                {
                  text: doneSignal,
                  threadId: "thread-1",
                },
                {
                  text: reviewPass,
                  turnId: "turn-1",
                },
                {
                  text: reviewFail,
                  type: "agentMessage",
                },
              ],
              payload: {
                text: doneSignal,
                item: {
                  content: [{ text: reviewPass }, { text: reviewFail }],
                },
              },
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => {
      rawLines.push(line);
      renderer.onRawLine(line);
    },
  });
  const raw = rawLines.join("\n");
  const rendered = renderer.getParsed();

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toContain("parent completion");
  expect(rendered).toContain("parent completion");
  expect(writes.join("")).toContain("parent completion");
  for (const output of [result.parsed, result.combined, raw, rendered]) {
    expect(output).not.toContain(doneSignal);
    expect(output).not.toContain(reviewPass);
    expect(output).not.toContain(reviewFail);
  }
  expect(hasSignal(result.parsed, doneSignal)).toBe(false);
  expect(hasSignal(result.combined, doneSignal)).toBe(false);
  const review = await createRunReview(() => Promise.resolve(result))(
    ["codex"],
    "review",
    { ...makeOptions(), review: "codex" }
  );
  expect(review.approved).toBe(false);
  expect(review.failureCount).toBe(1);
});

test("completed parent messages preserve authentic review signals", async () => {
  const appServer = await getModule();
  const reviewPass = "<review>PASS</review>";
  const reviewFail = "<review>FAIL</review>";
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              id: "message-1",
              type: "agentMessage",
              text: `${reviewPass}\n${reviewFail}`,
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("review", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });
  const raw = rawLines.join("\n");

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe(`${reviewPass}\n${reviewFail}`);
  expect(result.combined).toContain(reviewPass);
  expect(result.combined).toContain(reviewFail);
  expect(raw).toContain(reviewPass);
  expect(raw).toContain(reviewFail);
});

const runItemIdentityControl = async (
  items: Record<string, unknown>[],
  outer: Record<string, unknown> = { threadId: "thread-1", turnId: "turn-1" }
) => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        for (const item of items) {
          write({
            method: "item/completed",
            params: { ...outer, item: { type: "agentMessage", ...item } },
          });
        }
        write({
          method: "item/agentMessage/delta",
          params: { ...outer, delta: "owner output" },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };
  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });
  return { raw: rawLines.join("\n"), result };
};

const FOREIGN_ITEM_SIGNALS = [
  "<promise>DONE</promise>",
  "<review>PASS</review>",
  "<review>FAIL</review>",
];

const expectForeignItemRejected = async (identity: Record<string, unknown>) => {
  const { raw, result } = await runItemIdentityControl(
    FOREIGN_ITEM_SIGNALS.map((text, index) => ({
      ...identity,
      id: `foreign-item-${index}`,
      text,
    }))
  );
  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("owner output");
  for (const signal of FOREIGN_ITEM_SIGNALS) {
    expect(result.parsed).not.toContain(signal);
    expect(result.combined).not.toContain(signal);
    expect(raw).not.toContain(signal);
  }
  expect(hasSignal(result.combined, FOREIGN_ITEM_SIGNALS[0])).toBe(false);
  const review = await createRunReview(() => Promise.resolve(result))(
    ["codex"],
    "review",
    { ...makeOptions(), review: "codex" }
  );
  expect(review.approved).toBe(false);
  expect(review.failureCount).toBe(1);
};

test("item-level foreign thread identity cannot reach authoritative sinks", async () => {
  await expectForeignItemRejected({ threadId: "foreign-thread" });
  await expectForeignItemRejected({ thread_id: "foreign-thread" });
});

test("item-level foreign turn identity cannot reach authoritative sinks", async () => {
  await expectForeignItemRejected({ turnId: "foreign-turn" });
  await expectForeignItemRejected({ turn_id: "foreign-turn" });
});

test("conflicting item aliases stay rejected when outer params match", async () => {
  await expectForeignItemRejected({
    threadId: "thread-1",
    thread_id: "foreign-thread",
  });
  await expectForeignItemRejected({
    turnId: "turn-1",
    turn_id: "foreign-turn",
  });
  await expectForeignItemRejected({ threadId: 7 });
});

test("nested item identity aliases cannot reach authoritative sinks", async () => {
  await expectForeignItemRejected({ turn: { id: "foreign-turn" } });
  await expectForeignItemRejected({ thread: { id: "foreign-thread" } });
  await expectForeignItemRejected({
    metadata: { source: { thread_id: "foreign-thread" } },
  });
  await expectForeignItemRejected({
    content: [{ text: "parent", turnId: "foreign-turn" }],
  });
});

test("foreign item identity is rejected from error and failure sinks", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            error: { message: "foreign failure", threadId: "foreign-thread" },
          },
        });
        write({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", delta: "owner" },
        });
        write({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            error: { message: "owner failure" },
          },
        });
      }, 0);
    }
  };
  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toThrow("owner failure");
});

test("outer foreign thread identity cannot make DONE authoritative", async () => {
  const doneSignal = "<promise>DONE</promise>";
  for (const outer of [
    { threadId: "foreign-thread", turnId: "turn-1" },
    { threadId: "foreign-thread" },
    { thread_id: "foreign-thread", turn: { id: "turn-1" } },
  ]) {
    const appServer = await getModule();
    currentHandler = (request, write) => {
      if (request.method === "initialize") {
        write({ id: request.id, result: {} });
        return;
      }
      if (request.method === "thread/start") {
        write({ id: request.id, result: { thread: { id: "thread-1" } } });
        return;
      }
      if (request.method === "turn/start") {
        write({ id: request.id, result: { turn: { id: "turn-1" } } });
        setTimeout(() => {
          write({
            method: "item/agentMessage/delta",
            params: { ...outer, delta: doneSignal },
          });
          write({
            method: "item/completed",
            params: {
              ...outer,
              item: {
                id: "foreign-item",
                type: "agentMessage",
                text: doneSignal,
              },
            },
          });
          write({
            method: "turn/completed",
            params: {
              turnId: "turn-1",
              turn: { id: "turn-1", status: "completed" },
            },
          });
        }, 0);
      }
    };
    const rawLines: string[] = [];
    const result = await appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: (line) => rawLines.push(line),
    });
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toBe("");
    expect(rawLines.join("\n")).not.toContain(doneSignal);
    expect(hasSignal(result.parsed, doneSignal)).toBe(false);
    expect(hasSignal(result.combined, doneSignal)).toBe(false);
  }
});

test("foreign nested identity cannot fail, deepen or approve the owner turn", async () => {
  const appServer = await getModule();
  let deep: Record<string, unknown> = { threadId: "thread-1" };
  for (let level = 0; level < 40; level += 1) {
    deep = { nested: deep };
  }
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              text: "<promise>DONE</promise>",
              metadata: deep,
            },
          },
        });
        write({
          id: 202,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { command: "foreign command", threadId: "foreign-thread" },
          },
        });
        write({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "foreign failure", turnId: "foreign-turn" },
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "owner failure" },
            },
          },
        });
      }, 0);
    }
  };
  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });
  expect(result.exitCode).toBe(1);
  expect(result.parsed).toBe("owner failure");
  expect(result.parsed).not.toContain("foreign failure");
  expect(hasSignal(result.combined, "<promise>DONE</promise>")).toBe(false);
  expect(rawLines.join("\n")).not.toContain("<promise>DONE</promise>");
  const approvalResponse = latestFrames().find(
    (frame) => String(frame.id) === "202"
  );
  expect(approvalResponse?.result).toBeUndefined();
  expect(approvalResponse?.error).toMatchObject({
    code: -32_601,
    message: "request is not attributed to an active loop turn",
  });
});

test("correctly attributed item identity remains authoritative", async () => {
  const doneSignal = "<promise>DONE</promise>";
  const { raw, result } = await runItemIdentityControl([
    {
      id: "owner-item",
      text: doneSignal,
      threadId: "thread-1",
      thread_id: "thread-1",
      turnId: "turn-1",
      turn: { id: "turn-1" },
    },
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe(`${doneSignal}\nowner output`);
  expect(raw).toContain(doneSignal);
  expect(hasSignal(result.combined, doneSignal)).toBe(true);
});

test("runCodexTurn keeps genuine parent completion authoritative", async () => {
  const appServer = await getModule();
  const doneSignal = "<promise>DONE</promise>";
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              content: [{ text: doneSignal }],
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const rawLines: string[] = [];
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: (line) => rawLines.push(line),
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe(doneSignal);
  expect(rawLines.join("\n")).toContain(doneSignal);
  expect(hasSignal(result.combined, doneSignal)).toBe(true);
});

test("runCodexTurn maps failed turns to non-zero exit", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "failed",
              error: { message: "policy blocked" },
            },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(result.exitCode).toBe(1);
  expect(result.parsed).toContain("policy blocked");
});

test("runCodexTurn maps root-level failed status to non-zero exit", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            status: "failed",
            error: { message: "root error" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(result.exitCode).toBe(1);
  expect(result.parsed).toContain("root error");
});

test("runCodexTurn accepts snake_case agent message item type", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agent_message",
              content: [{ text: "works with snake_case" }],
            },
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  expect(result.exitCode).toBe(0);
  expect(result.parsed).toContain("works with snake_case");
});

test("runCodexTurn responds to approval requests", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        write({
          id: 101,
          method: "item/commandExecution/requestApproval",
          params: {
            command: "rm -rf /",
            threadId: "thread-1",
            turnId: "turn-1",
          },
        });
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }, 0);
    }
  };

  const result = await appServer.runCodexTurn(
    "dangerous command",
    makeOptions(),
    {
      onParsed: () => undefined,
      onRaw: () => undefined,
    }
  );

  const responses = latestWrites().map(
    (line) => JSON.parse(line) as RequestFrame
  );
  const accepted = responses.some(
    (entry) =>
      (typeof entry.id === "number" || typeof entry.id === "string") &&
      String(entry.id) === "101" &&
      (entry.result as Record<string, unknown>)?.decision === "accept"
  );
  expect(accepted).toBe(true);
  expect(result.exitCode).toBe(0);
});

test("runCodexTurn falls back to exec mode when thread/start is unsupported", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({
        id: request.id,
        error: { message: "method not found: thread/start" },
      });
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);
});

test("runCodexTurn falls back to exec mode when turn/start is unsupported", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      write({
        id: request.id,
        error: { message: "unsupported: turn/start" },
      });
    }
  };

  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerFallbackError);
});

test("interruptAppServer kills detached process group when pid is available", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
    }
  };

  const originalKill = process.kill;
  const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  const killSpy = ((
    pid: number,
    signal: NodeJS.Signals | number = "SIGTERM"
  ): boolean => {
    killCalls.push({ pid, signal });
    return true;
  }) as typeof process.kill;
  (process as { kill: typeof process.kill }).kill = killSpy;

  try {
    await appServer.startAppServer();
    const proc = latestProcess();
    expect(proc).toBeDefined();
    appServer.interruptAppServer("SIGTERM");
    expect(killCalls).toContainEqual({
      pid: -(proc?.pid ?? 0),
      signal: "SIGTERM",
    });
    expect(proc?.killSignals.length).toBe(0);
  } finally {
    process.kill = originalKill;
  }
});

test("persistent codex thread survives an unexpected app-server restart", async () => {
  const appServer = await getModule();
  let threadStarts = 0;
  const turnThreadIds: string[] = [];
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      threadStarts += 1;
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (request.method === "turn/start") {
      turnThreadIds.push(
        String(
          (request.params as { threadId?: unknown } | undefined)?.threadId ?? ""
        )
      );
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => {
        const latest = processes.at(-1);
        latest?.close();
      }, 0);
    }
  };

  await appServer.startAppServer({ persistentThread: true });
  await expect(
    appServer.runCodexTurn("say hi", makeOptions(), {
      onParsed: () => undefined,
      onRaw: () => undefined,
    })
  ).rejects.toBeInstanceOf(appServer.CodexAppServerUnexpectedExitError);

  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/start") {
      throw new Error(
        "expected restart to reuse the existing persistent thread"
      );
    }
    if (request.method === "turn/start") {
      turnThreadIds.push(
        String(
          (request.params as { threadId?: unknown } | undefined)?.threadId ?? ""
        )
      );
      write({ id: request.id, result: { turn: { id: "turn-2" } } });
      setTimeout(() => {
        write({
          method: "turn/completed",
          params: {
            turnId: "turn-2",
            turn: { id: "turn-2", status: "completed" },
          },
        });
      }, 0);
    }
  };

  await appServer.startAppServer({ persistentThread: true });
  const result = await appServer.runCodexTurn("say hi", makeOptions(), {
    onParsed: () => undefined,
    onRaw: () => undefined,
  });
  expect(result.exitCode).toBe(0);
  expect(threadStarts).toBe(1);
  expect(turnThreadIds).toEqual(["thread-1", "thread-1"]);
  expect(appServer.getLastCodexThreadId()).toBe("thread-1");
});

test("injectCodexMessage sends initialized and bridge notification opt-outs", async () => {
  const appServer = await getModule();
  currentHandler = (request, write) => {
    if (request.method === "initialize") {
      write({ id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/read") {
      write({ id: request.id, result: { thread: { turns: [] } } });
      return;
    }
    if (request.method === "turn/start") {
      write({ id: request.id, result: { turn: { id: "turn-1" } } });
    }
  };

  const delivered = await appServer.injectCodexMessage(
    "ws://127.0.0.1:4500",
    "thread-1",
    "Please review the final diff."
  );

  const frames = wsWrites.map((line) => JSON.parse(line) as RequestFrame);
  expect(delivered).toBe(true);
  expect(frames[0]).toMatchObject({
    method: "initialize",
    params: {
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/completed",
          "item/agentMessage/delta",
        ],
      },
    },
  });
  expect(frames[1]).toMatchObject({
    jsonrpc: "2.0",
    method: "initialized",
  });
  expect(frames[2]).toMatchObject({
    method: "thread/read",
    params: {
      includeTurns: true,
      threadId: "thread-1",
    },
  });
  expect(frames[3]).toMatchObject({
    method: "turn/start",
    params: {
      threadId: "thread-1",
    },
  });
});
