import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { serve } from "bun";
import {
  acknowledgeBridgeDelivery,
  readNextPendingBridgeMessageForTarget,
} from "./bridge-dispatch";
import {
  clearStaleTmuxBridgeState,
  submitTmuxBridgeMessage,
} from "./bridge-runtime";
import type { BridgeMessage } from "./bridge-store";
import { LOOP_VERSION } from "./constants";
import { recordCodexAppServerDelegationCandidate } from "./delegation-policy";
import { findFreePort } from "./ports";
import {
  isActiveRunState,
  readRunManifest,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";
import { type TmuxLiveness, tmuxSessionLiveness } from "./tmux-control";
import { connectWs, type WsClient } from "./ws-client";

const CODEX_PROXY_BASE_PORT = 4600;
const CODEX_PROXY_PORT_RANGE = 100;
const DRAIN_DELAY_MS = 250;
const LIFETIME_POLL_DELAY_MS = 1000;
const HEALTH_POLL_DELAY_MS = 150;
const HEALTH_POLL_RETRIES = 40;
const PROXY_STARTUP_GRACE_MS = 10_000;
const PROXY_TMUX_DEAD_CONFIRMATIONS = 3;
const PROXY_TMUX_DEAD_CONFIRMATION_MS = 5000;
const PROXY_UPSTREAM_INIT_TIMEOUT_MS = 5000;
const PROXY_UPSTREAM_RECONNECT_BASE_DELAY_MS = 250;
const PROXY_UPSTREAM_RECONNECT_BACKOFF_PLATEAU = 40;
const PROXY_UPSTREAM_RECONNECT_MAX_DELAY_MS = 2000;
const INITIALIZE_METHOD = "initialize";
const INITIALIZED_METHOD = "initialized";
const THREAD_RESUME_METHOD = "thread/resume";
const THREAD_START_METHOD = "thread/start";
const TURN_START_METHOD = "turn/start";
const ITEM_STARTED_METHOD = "item/started";
const ITEM_COMPLETED_METHOD = "item/completed";
const MCP_RELOAD_METHOD = "config/mcpServer/reload";
const MCP_RELOAD_ID_PREFIX = "proxy-mcp-reload-";
const MCP_RELOAD_TIMEOUT_MS = 5000;
const DEBUG_PROXY = process.env.LOOP_DEBUG_PROXY === "1";

export const CODEX_TMUX_PROXY_SUBCOMMAND = "__codex-tmux-proxy";
export const CODEX_TMUX_PROXY_LIFECYCLE_FILE =
  "codex-tmux-proxy-lifecycle.jsonl";

interface ProxySocketData {
  connId: number;
}

interface JsonFrame {
  error?: unknown;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface ProxyRoute {
  clientId: number | string;
  connId: number;
  method?: string;
  threadId?: string;
}

type StopReason = "dead-tmux" | "inactive-run";
type ProxyStopReason = StopReason | "requested" | "signal";

interface TmuxDeathEvidence {
  consecutiveDead: number;
  deadSinceMs?: number;
  sawSession: boolean;
}

export interface ProxyRuntimeOptions {
  now?: () => number;
  reconnectDelay?: (attempt: number) => number;
  tmuxLiveness?: (session: string) => TmuxLiveness;
}

interface ProxyLifecycleEvent {
  at: string;
  attempt?: number;
  delayMs?: number;
  event: string;
  failure?: string;
  port?: number;
  reason?: ProxyStopReason;
  signal?: "SIGINT" | "SIGTERM";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const isClosedLoopBridgeToolCall = (params: unknown): boolean => {
  if (!isRecord(params)) {
    return false;
  }
  const item = isRecord(params.item) ? params.item : undefined;
  const error = item && isRecord(item.error) ? item.error : undefined;
  return Boolean(
    item?.type === "mcpToolCall" &&
      asString(item.server) === "loop-bridge" &&
      asString(error?.message)?.toLowerCase().includes("transport closed")
  );
};

const asJsonFrame = (value: string): JsonFrame | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return parsed as JsonFrame;
  } catch {
    return undefined;
  }
};

const buildProxyUrl = (port: number): string => `ws://127.0.0.1:${port}/`;

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const debugProxy = (message: string): void => {
  if (DEBUG_PROXY) {
    console.error(`[loop-proxy] ${message}`);
  }
};

const failureKind = (error: unknown): string => {
  if (isRecord(error) && typeof error.code === "string") {
    return error.code;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("initialize timed out")) {
    return "initialize-timeout";
  }
  if (message.includes("closed during initialize")) {
    return "initialize-closed";
  }
  if (message.includes("initialize failed")) {
    return "initialize-rejected";
  }
  if (message.includes("before handshake")) {
    return "handshake-closed";
  }
  if (message.includes("upgrade failed")) {
    return "upgrade-rejected";
  }
  return error instanceof Error ? error.name : "unknown";
};

const appendProxyLifecycle = (
  runDir: string,
  event: Omit<ProxyLifecycleEvent, "at">
): void => {
  try {
    appendFileSync(
      join(runDir, CODEX_TMUX_PROXY_LIFECYCLE_FILE),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  } catch {
    // Lifecycle evidence must not become a new proxy failure mode.
  }
};

const extractThreadId = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const thread = isRecord(value.thread) ? value.thread : undefined;
  return asString(thread?.id) ?? asString(value.threadId);
};

const persistCodexThreadId = (runDir: string, threadId: string): void => {
  if (!threadId) {
    return;
  }
  updateRunManifest(join(runDir, "manifest.json"), (manifest) => {
    if (!manifest || manifest.codexThreadId === threadId) {
      return manifest;
    }
    return touchRunManifest(
      {
        ...manifest,
        codexThreadId: threadId,
      },
      new Date().toISOString()
    );
  });
};

type VisibleBridgeSubmit = (
  runDir: string,
  message: BridgeMessage
) => Promise<boolean>;

const deliverVisibleBridgeMessage = async (
  runDir: string,
  message: BridgeMessage,
  submit: VisibleBridgeSubmit = submitTmuxBridgeMessage
): Promise<boolean> => {
  const delivered = await submit(runDir, message);
  if (!delivered) {
    return false;
  }
  acknowledgeBridgeDelivery(
    runDir,
    message,
    "submitted through visible codex tmux pane"
  );
  return true;
};

const observeTmuxLiveness = (
  liveness: TmuxLiveness,
  evidence: TmuxDeathEvidence,
  startupDeadlineMs: number,
  nowMs: number
): { evidence: TmuxDeathEvidence; shouldStop: boolean } => {
  if (liveness === "live") {
    return {
      evidence: { consecutiveDead: 0, sawSession: true },
      shouldStop: false,
    };
  }
  if (liveness === "unknown") {
    return {
      evidence: {
        consecutiveDead: 0,
        sawSession: evidence.sawSession,
      },
      shouldStop: false,
    };
  }
  if (!evidence.sawSession && nowMs < startupDeadlineMs) {
    return { evidence, shouldStop: false };
  }
  const nextEvidence: TmuxDeathEvidence = {
    consecutiveDead: evidence.consecutiveDead + 1,
    deadSinceMs: evidence.deadSinceMs ?? nowMs,
    sawSession: evidence.sawSession,
  };
  return {
    evidence: nextEvidence,
    shouldStop: Boolean(
      nextEvidence.consecutiveDead >= PROXY_TMUX_DEAD_CONFIRMATIONS &&
        nowMs - (nextEvidence.deadSinceMs ?? nowMs) >=
          PROXY_TMUX_DEAD_CONFIRMATION_MS
    ),
  };
};

const proxyInitializeResponse = (
  id: number | string | undefined
): JsonFrame => {
  return {
    id,
    result: {
      platformFamily: "unix",
      platformOs: process.platform === "darwin" ? "macos" : process.platform,
      userAgent: "loop-tmux-proxy/1.0.0",
    },
  };
};

const proxyErrorFrame = (
  id: number | string,
  message: string
): Record<string, unknown> => ({
  error: { message },
  id,
});

const proxyHealth = (
  upstreamConnected: boolean,
  reconnecting: boolean
): { body: string; status?: number } => {
  if (upstreamConnected) {
    return { body: "ok" };
  }
  return reconnecting
    ? { body: "reconnecting", status: 503 }
    : { body: "not ready", status: 503 };
};

const reconnectDelayMs = (attempt: number): number =>
  Math.min(
    PROXY_UPSTREAM_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    PROXY_UPSTREAM_RECONNECT_MAX_DELAY_MS
  );

class CodexTmuxProxy {
  private readonly port: number;
  private remoteUrl: string;
  private readonly routes = new Map<number, ProxyRoute>();
  private readonly runDir: string;
  private currentConnId = 0;
  private drainTimer: ReturnType<typeof setInterval> | undefined;
  private initialized = false;
  private nextProxyId = 100_000;
  private proxyServer: ReturnType<typeof serve> | undefined;
  private reconnectAttemptCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnecting = false;
  private mcpReloadInFlight = false;
  private mcpReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveStopped = () => undefined;
  private lifetimeTimer: ReturnType<typeof setInterval> | undefined;
  private tmuxDeathEvidence: TmuxDeathEvidence = {
    consecutiveDead: 0,
    sawSession: false,
  };
  private stopped = false;
  private readonly startupDeadlineMs: number;
  private threadId: string;
  private tuiSocket: ServerWebSocket<ProxySocketData> | undefined;
  private upstream: WsClient | undefined;
  private visibleDeliveryInFlight = false;
  private readonly stoppedPromise: Promise<void>;
  private readonly now: () => number;
  private readonly reconnectDelay: (attempt: number) => number;
  private readonly readTmuxLiveness: (session: string) => TmuxLiveness;

  constructor(
    runDir: string,
    remoteUrl: string,
    threadId: string,
    port: number,
    options: ProxyRuntimeOptions = {}
  ) {
    this.port = port;
    this.remoteUrl = remoteUrl;
    this.runDir = runDir;
    this.threadId = threadId;
    this.now = options.now ?? Date.now;
    this.reconnectDelay = options.reconnectDelay ?? reconnectDelayMs;
    this.readTmuxLiveness = options.tmuxLiveness ?? tmuxSessionLiveness;
    this.startupDeadlineMs = this.now() + PROXY_STARTUP_GRACE_MS;
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  async start(): Promise<void> {
    appendProxyLifecycle(this.runDir, {
      event: "starting",
      port: this.port,
    });
    await this.connectUpstream();
    if (this.stopped) {
      this.upstream?.close();
      this.upstream = undefined;
      return;
    }
    this.proxyServer = serve({
      fetch: (request, server) => {
        const path = new URL(request.url).pathname;
        if (path === "/healthz" || path === "/readyz") {
          const health = proxyHealth(Boolean(this.upstream), this.reconnecting);
          return new Response(
            health.body,
            health.status ? { status: health.status } : undefined
          );
        }
        if (server.upgrade(request, { data: { connId: 0 } })) {
          return undefined;
        }
        return new Response("loop Codex tmux proxy");
      },
      hostname: "127.0.0.1",
      port: this.port,
      websocket: {
        close: (ws) => {
          if (this.tuiSocket === ws) {
            this.tuiSocket = undefined;
          }
        },
        message: (ws, message) => {
          const payload =
            typeof message === "string" ? message : message.toString();
          if (ws.data.connId !== this.currentConnId) {
            return;
          }
          for (const raw of payload.split("\n")) {
            if (raw.trim()) {
              this.handleTuiFrame(raw);
            }
          }
        },
        open: (ws) => {
          this.currentConnId += 1;
          this.initialized = false;
          ws.data.connId = this.currentConnId;
          this.tuiSocket = ws;
        },
      },
    });
    this.drainTimer = setInterval(() => {
      this.drainBridgeMessages().catch((error: unknown) => {
        appendProxyLifecycle(this.runDir, {
          event: "visible-delivery-failed",
          failure: failureKind(error),
        });
        debugProxy(
          `visible bridge delivery failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, DRAIN_DELAY_MS);
    this.drainTimer.unref?.();
    this.lifetimeTimer = setInterval(() => {
      const stopReason = this.stopReason();
      if (!stopReason) {
        return;
      }
      if (stopReason === "dead-tmux") {
        clearStaleTmuxBridgeState(this.runDir);
      }
      this.stop(stopReason);
    }, LIFETIME_POLL_DELAY_MS);
    this.lifetimeTimer.unref?.();
    appendProxyLifecycle(this.runDir, {
      event: "started",
      port: this.port,
    });
  }

  async wait(): Promise<void> {
    await this.stoppedPromise;
  }

  stop(reason: ProxyStopReason = "requested"): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = undefined;
    }
    if (this.lifetimeTimer) {
      clearInterval(this.lifetimeTimer);
      this.lifetimeTimer = undefined;
    }
    this.clearMcpReloadState();
    this.proxyServer?.stop(true);
    this.proxyServer = undefined;
    this.tuiSocket = undefined;
    this.upstream?.close();
    this.upstream = undefined;
    appendProxyLifecycle(this.runDir, { event: "stopped", reason });
    this.resolveStopped();
  }

  private forwardToTui(raw: string): void {
    this.tuiSocket?.send(raw);
  }

  private resolveRemoteUrl(): string {
    const manifest = readRunManifest(join(this.runDir, "manifest.json"));
    const nextUrl = manifest?.codexRemoteUrl || this.remoteUrl;
    if (nextUrl) {
      this.remoteUrl = nextUrl;
    }
    return this.remoteUrl;
  }

  private resolveThreadId(): string {
    const manifest = readRunManifest(join(this.runDir, "manifest.json"));
    const nextThreadId = manifest?.codexThreadId || this.threadId;
    if (nextThreadId) {
      this.threadId = nextThreadId;
    }
    return this.threadId;
  }

  private attachUpstream(ws: WsClient): void {
    const recoveredAfterAttempts = this.reconnectAttemptCount;
    this.upstream = ws;
    this.reconnecting = false;
    this.reconnectAttemptCount = 0;
    if (recoveredAfterAttempts > 0) {
      appendProxyLifecycle(this.runDir, {
        attempt: recoveredAfterAttempts,
        event: "upstream-reconnected",
      });
    }
    ws.onmessage = (data) => {
      for (const raw of data.split("\n")) {
        if (raw.trim()) {
          this.handleUpstreamFrame(raw);
        }
      }
    };
    ws.onclose = () => {
      if (this.upstream !== ws) {
        return;
      }
      this.handleUpstreamDisconnect();
    };
  }

  private async initializeUpstream(ws: WsClient): Promise<void> {
    const requestId = `proxy-initialize-${Date.now()}-${this.nextProxyId++}`;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("codex tmux proxy upstream initialize timed out"));
      }, PROXY_UPSTREAM_INIT_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        ws.onclose = undefined;
        ws.onmessage = undefined;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      ws.onclose = () => {
        finish(new Error("codex tmux proxy upstream closed during initialize"));
      };
      ws.onmessage = (data) => {
        for (const raw of data.split("\n")) {
          if (!raw.trim()) {
            continue;
          }
          const frame = asJsonFrame(raw);
          if (!frame || String(frame.id) !== requestId) {
            continue;
          }
          if (frame.error) {
            finish(new Error("codex tmux proxy upstream initialize failed"));
            return;
          }
          ws.send(
            `${JSON.stringify({
              jsonrpc: "2.0",
              method: INITIALIZED_METHOD,
            })}\n`
          );
          finish();
          return;
        }
      };
      ws.send(
        `${JSON.stringify({
          id: requestId,
          method: INITIALIZE_METHOD,
          params: {
            capabilities: { experimentalApi: true },
            clientInfo: {
              name: "loop-tmux-proxy",
              title: "loop-tmux-proxy",
              version: LOOP_VERSION,
            },
          },
        })}\n`
      );
    });
  }

  private async connectUpstream(): Promise<void> {
    const ws = await connectWs(this.resolveRemoteUrl());
    try {
      await this.initializeUpstream(ws);
    } catch (error) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
      throw error;
    }
    this.attachUpstream(ws);
  }

  private failPendingRoutes(message: string): void {
    for (const route of this.routes.values()) {
      if (route.connId !== this.currentConnId) {
        continue;
      }
      this.forwardToTui(
        JSON.stringify(proxyErrorFrame(route.clientId, message))
      );
    }
    this.routes.clear();
  }

  private clearUpstreamState(): void {
    this.failPendingRoutes("codex app-server upstream disconnected");
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.upstream || this.reconnectTimer) {
      return;
    }
    this.reconnecting = true;
    this.reconnectAttemptCount = Math.min(
      this.reconnectAttemptCount + 1,
      PROXY_UPSTREAM_RECONNECT_BACKOFF_PLATEAU
    );
    const delayMs = this.reconnectDelay(this.reconnectAttemptCount);
    appendProxyLifecycle(this.runDir, {
      attempt: this.reconnectAttemptCount,
      delayMs,
      event: "reconnect-scheduled",
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.tryReconnect().catch(() => undefined);
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async tryReconnect(): Promise<void> {
    if (this.stopped || this.upstream) {
      return;
    }
    const stopReason = this.stopReason();
    if (stopReason) {
      if (stopReason === "dead-tmux") {
        clearStaleTmuxBridgeState(this.runDir);
      }
      this.stop(stopReason);
      return;
    }
    try {
      await this.connectUpstream();
    } catch (error) {
      appendProxyLifecycle(this.runDir, {
        attempt: this.reconnectAttemptCount,
        event: "reconnect-failed",
        failure: failureKind(error),
      });
      this.scheduleReconnect();
    }
  }

  private handleUpstreamDisconnect(): void {
    if (this.stopped) {
      return;
    }
    this.upstream = undefined;
    appendProxyLifecycle(this.runDir, { event: "upstream-disconnected" });
    this.clearMcpReloadState();
    this.clearUpstreamState();
    const stopReason = this.stopReason();
    if (stopReason) {
      if (stopReason === "dead-tmux") {
        clearStaleTmuxBridgeState(this.runDir);
      }
      this.stop(stopReason);
      return;
    }
    this.scheduleReconnect();
  }

  private rememberThreadId(threadId: string | undefined): void {
    if (!threadId || threadId === this.threadId) {
      return;
    }
    this.threadId = threadId;
    persistCodexThreadId(this.runDir, threadId);
  }

  private handleTuiFrame(raw: string): void {
    const frame = asJsonFrame(raw);
    if (!(frame?.method && frame.id !== undefined)) {
      this.upstream?.send(raw);
      return;
    }
    if (frame.method === INITIALIZE_METHOD) {
      this.initialized = true;
      this.forwardToTui(JSON.stringify(proxyInitializeResponse(frame.id)));
      return;
    }
    if (!this.upstream) {
      this.forwardToTui(
        JSON.stringify(
          proxyErrorFrame(frame.id, "codex app-server is reconnecting")
        )
      );
      return;
    }

    const proxyId = this.nextProxyId++;
    this.routes.set(proxyId, {
      clientId: frame.id,
      connId: this.currentConnId,
      method: frame.method,
      threadId: this.resolveThreadForMethod(frame.method, frame.params),
    });
    frame.id = proxyId;
    this.upstream?.send(`${JSON.stringify(frame)}\n`);
  }

  private resolveThreadForMethod(
    method: string,
    params: unknown
  ): string | undefined {
    if (!isRecord(params)) {
      return undefined;
    }
    if (method === TURN_START_METHOD) {
      return asString(params.threadId);
    }
    if (method === THREAD_RESUME_METHOD) {
      return asString(params.threadId);
    }
    return undefined;
  }

  private handleUpstreamFrame(raw: string): void {
    const frame = asJsonFrame(raw);
    if (!frame) {
      this.forwardToTui(raw);
      return;
    }

    if (typeof frame.method === "string") {
      if (frame.method === ITEM_STARTED_METHOD) {
        const manifest = readRunManifest(join(this.runDir, "manifest.json"));
        if (manifest?.cwd) {
          try {
            recordCodexAppServerDelegationCandidate(
              this.runDir,
              manifest.cwd,
              frame.params
            );
          } catch {
            // Telemetry must never alter or delay app-server forwarding.
          }
        }
      }
      if (
        frame.method === ITEM_COMPLETED_METHOD &&
        isClosedLoopBridgeToolCall(frame.params)
      ) {
        this.reloadMcpServers();
      }
      this.forwardToTui(raw);
      return;
    }

    if (
      typeof frame.id === "string" &&
      frame.id.startsWith(MCP_RELOAD_ID_PREFIX)
    ) {
      this.clearMcpReloadState();
      return;
    }

    const proxyId = asNumber(frame.id);
    if (proxyId === undefined) {
      this.forwardToTui(raw);
      return;
    }

    const route = this.routes.get(proxyId);
    if (!route) {
      return;
    }
    this.routes.delete(proxyId);

    if (route.connId !== this.currentConnId) {
      return;
    }

    this.handleTrackedResponse(route, frame);
    frame.id = route.clientId;
    this.forwardToTui(JSON.stringify(frame));
  }

  private reloadMcpServers(): void {
    if (this.mcpReloadInFlight || !this.upstream) {
      return;
    }
    this.mcpReloadInFlight = true;
    this.mcpReloadTimer = setTimeout(() => {
      this.clearMcpReloadState();
    }, MCP_RELOAD_TIMEOUT_MS);
    this.mcpReloadTimer.unref?.();
    const id = `${MCP_RELOAD_ID_PREFIX}${Date.now()}-${this.nextProxyId++}`;
    try {
      this.upstream.send(
        `${JSON.stringify({ id, method: MCP_RELOAD_METHOD, params: null })}\n`
      );
    } catch {
      this.clearMcpReloadState();
    }
  }

  private clearMcpReloadState(): void {
    if (this.mcpReloadTimer) {
      clearTimeout(this.mcpReloadTimer);
      this.mcpReloadTimer = undefined;
    }
    this.mcpReloadInFlight = false;
  }

  private handleTrackedResponse(route: ProxyRoute, frame: JsonFrame): void {
    if (
      !frame.error &&
      (route.method === THREAD_START_METHOD ||
        route.method === THREAD_RESUME_METHOD)
    ) {
      this.rememberThreadId(
        extractThreadId(frame.result) ?? route.threadId ?? this.threadId
      );
      return;
    }

    if (!frame.error && route.method === TURN_START_METHOD) {
      this.rememberThreadId(route.threadId ?? this.threadId);
    }
  }

  private stopReason(): StopReason | undefined {
    const manifest = readRunManifest(join(this.runDir, "manifest.json"));
    if (!(manifest && isActiveRunState(manifest.state))) {
      return "inactive-run";
    }
    const liveness = manifest.tmuxSession
      ? this.readTmuxLiveness(manifest.tmuxSession)
      : "dead";
    const observation = observeTmuxLiveness(
      liveness,
      this.tmuxDeathEvidence,
      this.startupDeadlineMs,
      this.now()
    );
    this.tmuxDeathEvidence = observation.evidence;
    return observation.shouldStop ? "dead-tmux" : undefined;
  }

  private async drainBridgeMessages(): Promise<void> {
    if (this.stopped || this.visibleDeliveryInFlight) {
      return;
    }
    if (
      !(
        this.initialized &&
        this.resolveThreadId() &&
        this.tuiSocket &&
        this.upstream
      )
    ) {
      return;
    }
    const message = readNextPendingBridgeMessageForTarget(this.runDir, "codex");
    if (!message) {
      return;
    }

    this.visibleDeliveryInFlight = true;
    try {
      await deliverVisibleBridgeMessage(this.runDir, message);
    } finally {
      this.visibleDeliveryInFlight = false;
    }
  }
}

export const findCodexTmuxProxyPort = (): Promise<number> =>
  findFreePort(CODEX_PROXY_BASE_PORT, CODEX_PROXY_PORT_RANGE);

export const waitForCodexTmuxProxy = async (port: number): Promise<string> => {
  const url = `http://127.0.0.1:${port}/readyz`;
  for (let attempt = 0; attempt < HEALTH_POLL_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return buildProxyUrl(port);
      }
    } catch {
      // keep polling
    }
    await wait(HEALTH_POLL_DELAY_MS);
  }
  throw new Error("[loop] Codex tmux proxy failed to start");
};

export const runCodexTmuxProxy = async (
  runDir: string,
  remoteUrl: string,
  threadId: string,
  port: number,
  options: ProxyRuntimeOptions = {}
): Promise<void> => {
  const proxy = new CodexTmuxProxy(runDir, remoteUrl, threadId, port, options);
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    appendProxyLifecycle(runDir, { event: "signal", signal });
    proxy.stop("signal");
  };
  const onSigint = (): void => shutdown("SIGINT");
  const onSigterm = (): void => shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    await proxy.start();
    await proxy.wait();
  } catch (error) {
    appendProxyLifecycle(runDir, {
      event: "fatal-start",
      failure: failureKind(error),
    });
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
};

export const codexTmuxProxyInternals = {
  deliverVisibleBridgeMessage,
  isClosedLoopBridgeToolCall,
  reconnectDelayMs,
  proxyHealth,
  buildProxyUrl,
  proxyInitializeResponse,
  observeTmuxLiveness,
  persistCodexThreadId,
  recordCodexAppServerDelegationCandidate,
};
