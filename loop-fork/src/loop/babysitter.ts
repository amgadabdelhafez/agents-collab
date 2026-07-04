import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "bun";
import { initLivenessState, updateLiveness } from "./babysitter-detect";
import { judgeAgent } from "./babysitter-llm";
import { decideRecovery, executeRecovery } from "./babysitter-recover";
import {
  DEFAULT_BABYSIT_CONFIDENCE,
  DEFAULT_BABYSIT_COOLDOWN_SECONDS,
  DEFAULT_BABYSIT_IDLE_SECONDS,
  DEFAULT_BABYSIT_MAX_RECOVERIES,
  DEFAULT_BABYSIT_MODEL,
  DEFAULT_BABYSIT_TICK_SECONDS,
  DEFAULT_BABYSIT_URL,
} from "./constants";
import { readAgentUsage } from "./babysitter-usage";
import { decode } from "./git";
import { loadRunState } from "./run-state";
import type {
  Agent,
  AgentLiveness,
  AgentLivenessState,
  AgentUsage,
  BabysitterVerdict,
  HookEvent,
  JudgeOutcome,
  JudgeRequest,
  RecoveryDecision,
  RecoveryHistoryEntry,
} from "./types";

export const BABYSIT_SUBCOMMAND = "__babysit";

const HOOK_TAIL_LIMIT = 20;
const NUDGE_TEXT = "babysitter: you look idle — status? are you blocked?";
const PANE_HASH_LENGTH = 12;

export interface BabysitAgentInfo {
  agent: Agent;
  // Per-run CODEX_HOME, so Codex usage transcripts under it can be located.
  codexHome?: string;
  hookFile: string;
  pane: string;
  // Session id / thread id used to locate the agent's usage transcript.
  sessionRef?: string;
}

export interface BabysitConfig {
  agents: BabysitAgentInfo[];
  confidence: number;
  cooldownMs: number;
  // Run manifest creation time, for session uptime.
  createdAt?: string;
  dryRun: boolean;
  idleMs: number;
  logFile: string;
  maxRecoveries: number;
  model: string;
  runId: string;
  session: string;
  tickMs: number;
  url: string;
}

export interface BabysitDeps {
  appendLog: (file: string, record: unknown) => void;
  capturePane: (pane: string) => string;
  judge: (req: JudgeRequest) => Promise<JudgeOutcome>;
  now: () => number;
  readHooks: (file: string) => HookEvent[];
  readUsage: (
    agent: Agent,
    sessionRef?: string,
    codexHome?: string
  ) => AgentUsage;
  render: (text: string) => void;
  respawnPane: (pane: string) => void;
  sendKeys: (pane: string, keys: string[]) => void;
  sendText: (pane: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export interface BabysitTickResult {
  board: string;
  history: RecoveryHistoryEntry[];
  llmOffline: boolean;
  recoveries: number;
  states: Map<Agent, AgentLivenessState>;
}

const hashPane = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, PANE_HASH_LENGTH);

const lastEventTs = (events: HookEvent[]): string | undefined =>
  events.length > 0 ? events.at(-1)?.ts : undefined;

// Agents render their own live context usage in the pane statusline
// (e.g. "ctx: 61%"). That is authoritative and current, whereas the
// transcript-derived figure lags by a turn — so prefer the pane value.
const PANE_CTX_RE = /ctx:?\s*(\d+)\s*%/i;
const parsePaneCtxPct = (paneText: string): number | undefined => {
  const match = paneText.match(PANE_CTX_RE);
  if (!match) {
    return undefined;
  }
  const pct = Number.parseInt(match[1], 10);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : undefined;
};

// Build the per-agent recovery executors on top of the injected tmux deps.
const buildRecoveryDeps = (
  info: BabysitAgentInfo,
  deps: BabysitDeps,
  logFile: string
) => ({
  answerPrompt: (_agent: Agent) => {
    deps.sendKeys(info.pane, ["Enter"]);
  },
  nudge: (_agent: Agent) => {
    deps.sendText(info.pane, NUDGE_TEXT);
    deps.sendKeys(info.pane, ["Enter"]);
  },
  restart: (_agent: Agent) => {
    deps.respawnPane(info.pane);
  },
  log: (entry: RecoveryHistoryEntry, dryRun: boolean) => {
    deps.appendLog(logFile, { dryRun, kind: "action", ...entry });
  },
});

const fmtDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};

const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`;
  }
  return String(n);
};

const activeMs = (usage: AgentUsage): number => {
  if (!(usage.firstTs && usage.lastTs)) {
    return Number.NaN;
  }
  return Date.parse(usage.lastTs) - Date.parse(usage.firstTs);
};

const ANSI = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};
const CONTEXT_ALERT_PCT = 80;
const LAST_ACTION_WIDTH = 46;
const MS_PER_HOUR = 3_600_000;

const paint = (code: string, text: string): string =>
  `${code}${text}${ANSI.reset}`;
const cell = (text: string, width: number): string => text.padEnd(width);
const fmtClock = (iso: string): string => iso.slice(11, 19);

const CLAUDE_PREFIX_RE = /^claude-/;
const shortModel = (model?: string): string =>
  model ? model.replace(CLAUDE_PREFIX_RE, "").slice(0, 10) : "—";

const contextPct = (u: AgentUsage): number =>
  u.contextTokens > 0
    ? Math.round((u.contextTokens / u.contextWindow) * 100)
    : 0;

const contextCell = (u: AgentUsage): string =>
  u.contextTokens > 0
    ? `${fmtTokens(u.contextTokens)}/${fmtTokens(u.contextWindow)} ${contextPct(u)}%`
    : "—";

// Most recent hook event as a short "what is it doing" string.
const lastActionOf = (events: HookEvent[]): string => {
  const event = events.at(-1);
  if (!event) {
    return "—";
  }
  const label = event.tool ?? event.event;
  return event.detail ? `${label} ${event.detail}` : label;
};

const stateColor = (state: string): string => {
  if (state === "stuck" || state === "crashed") {
    return ANSI.red;
  }
  if (state === "thinking" || state === "working") {
    return ANSI.green;
  }
  return ANSI.yellow;
};

const truncate = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text;

// Hook events that mean the agent finished its turn / is waiting — so a pane
// that keeps repainting (blinking cursor at the prompt) is idle, not thinking.
const TURN_END_EVENTS = new Set(["Stop", "Notification"]);

interface AgentRow {
  action: RecoveryHistoryEntry | null;
  errors: number;
  lastAction: string;
  liveness: AgentLiveness;
  turnEnded: boolean;
  usage: AgentUsage;
  verdict?: BabysitterVerdict;
}

interface BoardMeta {
  llmOffline: boolean;
  nowIso: string;
  recoveries: number;
  tickMs: number;
  uptimeMs: number;
}

const COLUMNS: [string, number][] = [
  ["AGENT", 7],
  ["MODEL", 10],
  ["STATE", 12],
  ["FOR", 6],
  ["ACTIVE", 7],
  ["CTX", 13],
  ["TOK", 7],
  ["COST", 8],
  ["MSGS", 5],
];

const headerRow = paint(
  ANSI.dim,
  ` ${COLUMNS.map(([label, width]) => cell(label, width)).join(" ")} LAST`
);

const renderRow = (row: AgentRow, tickMs: number): string => {
  // Pane changed within the last tick => the TUI is animating (thinking);
  // frozen past a tick, or the turn has ended, => genuinely idle.
  const thinking =
    !row.turnEnded &&
    row.liveness.paneIdleMs < tickMs &&
    !row.liveness.suspect;
  const state = row.verdict?.state ?? (thinking ? "thinking" : "idle");
  const forMs = thinking
    ? row.liveness.lastEventAgeMs
    : row.liveness.paneIdleMs;
  const ctxText = contextCell(row.usage);
  const ctx =
    contextPct(row.usage) > CONTEXT_ALERT_PCT
      ? paint(ANSI.red, cell(`${ctxText} ⚠`, 13))
      : cell(ctxText, 13);
  const tok = row.usage.totalTokens > 0 ? fmtTokens(row.usage.totalTokens) : "—";
  const cost = row.usage.costUsd > 0 ? `$${row.usage.costUsd.toFixed(2)}` : "—";
  const detail = truncate(
    row.lastAction +
      (row.errors > 0 ? ` (err ${row.errors})` : "") +
      (row.action ? ` · ${row.action.level}` : ""),
    LAST_ACTION_WIDTH
  );
  return ` ${[
    cell(row.liveness.agent, 7),
    cell(shortModel(row.usage.model), 10),
    paint(stateColor(state), cell(`● ${state}`, 12)),
    cell(fmtDuration(forMs), 6),
    cell(fmtDuration(activeMs(row.usage)), 7),
    ctx,
    cell(tok, 7),
    cell(cost, 8),
    cell(String(row.usage.messages), 5),
    detail,
  ].join(" ")}`;
};

const renderSummaryLine = (rows: AgentRow[], meta: BoardMeta): string => {
  const totalCost = rows.reduce((sum, r) => sum + r.usage.costUsd, 0);
  // A genuine human prompt is relayed to every agent; agent-to-agent bridge
  // messages inflate the peer's "user" count, so the min is the truest total.
  const found = rows.filter(
    (r) => r.usage.messages > 0 || r.usage.humanMessages > 0
  );
  const human = found.length
    ? Math.min(...found.map((r) => r.usage.humanMessages))
    : 0;
  const activeSpans = rows
    .map((r) => activeMs(r.usage))
    .filter((ms) => Number.isFinite(ms));
  const maxActive = activeSpans.length > 0 ? Math.max(...activeSpans) : 0;
  const perHr = maxActive > 0 ? totalCost / (maxActive / MS_PER_HOUR) : 0;
  const errorTotal = rows.reduce((sum, r) => sum + r.errors, 0);
  const parts = [
    paint(ANSI.cyan, "babysitter"),
    fmtClock(meta.nowIso),
    ...(Number.isFinite(meta.uptimeMs)
      ? [`up ${fmtDuration(meta.uptimeMs)}`]
      : []),
    `Σ $${totalCost.toFixed(2)}${perHr > 0 ? ` ($${perHr.toFixed(0)}/hr)` : ""}`,
    `human ${human}`,
    `recoveries ${meta.recoveries}`,
    ...(errorTotal > 0 ? [paint(ANSI.red, `errors ${errorTotal}`)] : []),
    meta.llmOffline ? paint(ANSI.red, "qwen ✗") : paint(ANSI.green, "qwen ✓"),
  ];
  return ` ${parts.join(" · ")}`;
};

const renderBoard = (rows: AgentRow[], meta: BoardMeta): string =>
  [
    renderSummaryLine(rows, meta),
    headerRow,
    ...rows.map((row) => renderRow(row, meta.tickMs)),
  ].join("\n");

interface AgentTickContext {
  history: RecoveryHistoryEntry[];
  nowIso: string;
  nowMs: number;
  recoveries: number;
}

interface AgentTickResult {
  history: RecoveryHistoryEntry[];
  llmOffline: boolean;
  recoveries: number;
  row: AgentRow;
}

// Run the recovery ladder for a suspect agent; returns the taken action (if any).
const recoverAgent = (
  info: BabysitAgentInfo,
  verdict: BabysitterVerdict,
  config: BabysitConfig,
  deps: BabysitDeps,
  ctx: AgentTickContext
): RecoveryHistoryEntry | null => {
  const decision: RecoveryDecision = decideRecovery(verdict, ctx.history, info.agent, {
    confidence: config.confidence,
    cooldownMs: config.cooldownMs,
    maxRecoveries: config.maxRecoveries,
    nowMs: ctx.nowMs,
  });
  const action = executeRecovery(
    decision,
    buildRecoveryDeps(info, deps, config.logFile),
    { dryRun: config.dryRun, nowIso: ctx.nowIso }
  );
  deps.appendLog(config.logFile, {
    agent: info.agent,
    decision,
    dryRun: config.dryRun,
    kind: "decision",
    ts: ctx.nowIso,
    verdict,
  });
  return action;
};

// Detect, judge, and (if suspect+recoverable) recover one agent; build its row.
const processAgent = async (
  info: BabysitAgentInfo,
  states: Map<Agent, AgentLivenessState>,
  config: BabysitConfig,
  deps: BabysitDeps,
  ctx: AgentTickContext
): Promise<AgentTickResult> => {
  const paneText = deps.capturePane(info.pane);
  const events = deps.readHooks(info.hookFile);
  const usage = deps.readUsage(info.agent, info.sessionRef, info.codexHome);
  // Prefer the agent's own live context %, shown in its pane statusline.
  const paneCtxPct = parsePaneCtxPct(paneText);
  if (paneCtxPct !== undefined && usage.contextWindow > 0) {
    usage.contextTokens = Math.round((paneCtxPct / 100) * usage.contextWindow);
  }
  const paneHash = hashPane(paneText);
  const prev =
    states.get(info.agent) ?? initLivenessState(info.agent, ctx.nowMs, paneHash);
  const { state, liveness } = updateLiveness(
    prev,
    { agent: info.agent, lastEventTs: lastEventTs(events), paneHash },
    ctx.nowMs,
    config.idleMs
  );
  states.set(info.agent, state);

  const errors = events.filter((event) => event.error === true).length;
  const turnEnded = TURN_END_EVENTS.has(events.at(-1)?.event ?? "");
  const row: AgentRow = {
    action: null,
    errors,
    lastAction: lastActionOf(events),
    liveness,
    turnEnded,
    usage,
  };

  if (!liveness.suspect) {
    return {
      history: ctx.history.filter((entry) => entry.agent !== info.agent),
      llmOffline: false,
      recoveries: ctx.recoveries,
      row,
    };
  }

  const outcome = await deps.judge({
    agent: info.agent,
    hookTail: events.slice(-HOOK_TAIL_LIMIT),
    model: config.model,
    paneText,
    url: config.url,
  });
  row.verdict = outcome.ok ? outcome.verdict : outcome.fallback;
  if (!outcome.ok && outcome.reason === "unreachable") {
    return { history: ctx.history, llmOffline: true, recoveries: ctx.recoveries, row };
  }

  const action = recoverAgent(info, row.verdict, config, deps, ctx);
  row.action = action;
  if (action && !config.dryRun) {
    return {
      history: [...ctx.history, action],
      llmOffline: false,
      recoveries: ctx.recoveries + 1,
      row,
    };
  }
  return { history: ctx.history, llmOffline: false, recoveries: ctx.recoveries, row };
};

// One control-loop tick: detect → (judge suspects) → recover → render + log.
export const babysitTick = async (
  states: Map<Agent, AgentLivenessState>,
  historyIn: RecoveryHistoryEntry[],
  config: BabysitConfig,
  deps: BabysitDeps,
  recoveriesIn = 0
): Promise<BabysitTickResult> => {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  let history = historyIn;
  let recoveries = recoveriesIn;
  const rows: AgentRow[] = [];
  let llmOffline = false;

  for (const info of config.agents) {
    const result = await processAgent(info, states, config, deps, {
      history,
      nowIso,
      nowMs,
      recoveries,
    });
    history = result.history;
    recoveries = result.recoveries;
    llmOffline = llmOffline || result.llmOffline;
    rows.push(result.row);
  }

  const uptimeMs = config.createdAt
    ? nowMs - Date.parse(config.createdAt)
    : Number.NaN;
  const board = renderBoard(rows, {
    llmOffline,
    nowIso,
    recoveries,
    tickMs: config.tickMs,
    uptimeMs,
  });
  deps.render(board);
  return { board, history, llmOffline, recoveries, states };
};

const tmux = (args: string[]): string => {
  const result = spawnSync(["tmux", ...args], { stderr: "ignore", stdout: "pipe" });
  return decode(result.stdout);
};

export const defaultBabysitDeps = (): BabysitDeps => ({
  appendLog: (file, record) => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  },
  capturePane: (pane) => tmux(["capture-pane", "-p", "-t", pane]),
  judge: (req) => judgeAgent(req),
  now: () => Date.now(),
  readHooks: (file) => {
    try {
      return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as HookEvent;
          } catch {
            return undefined;
          }
        })
        .filter((event): event is HookEvent => event !== undefined);
    } catch {
      return [];
    }
  },
  readUsage: (agent, sessionRef, codexHome) =>
    readAgentUsage(agent, sessionRef, codexHome),
  render: (text) => {
    // Clear the pane and print the fresh board.
    process.stdout.write(`\x1b[2J\x1b[H${text}\n`);
  },
  respawnPane: (pane) => {
    spawnSync(["tmux", "respawn-pane", "-k", "-t", pane], { stderr: "ignore" });
  },
  sendKeys: (pane, keys) => {
    spawnSync(["tmux", "send-keys", "-t", pane, ...keys], { stderr: "ignore" });
  },
  sendText: (pane, text) => {
    spawnSync(["tmux", "send-keys", "-t", pane, "-l", "--", text], {
      stderr: "ignore",
    });
  },
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
});

const MS_PER_SECOND = 1000;

const envSeconds = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallbackSeconds: number
): number => {
  const raw = env[key];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const seconds = Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackSeconds;
  return seconds * MS_PER_SECOND;
};

const envConfidence = (env: NodeJS.ProcessEnv): number => {
  const parsed = Number.parseFloat(env.LOOP_BABYSIT_CONFIDENCE ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_BABYSIT_CONFIDENCE;
};

// Resolve the babysitter config from the run manifest (session + pane agents)
// and LOOP_BABYSIT_* environment overrides set at pane launch.
export const resolveBabysitConfig = (
  runId: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
  home?: string
): BabysitConfig => {
  const { manifest, storage } = loadRunState(runId, cwd, home);
  const session = manifest?.tmuxSession;
  if (!session) {
    throw new Error(`[loop] babysitter: no tmux session for run ${runId}`);
  }
  const sessionRefFor = (agent: Agent): string | undefined => {
    if (agent === "claude") {
      return manifest?.claudeSessionId || undefined;
    }
    if (agent === "codex") {
      return manifest?.codexThreadId || undefined;
    }
    return undefined;
  };
  const codexHome = join(storage.runDir, "codex-home");
  const agents: BabysitAgentInfo[] = [];
  const addAgent = (agent: Agent | undefined, paneIndex: number): void => {
    if (agent) {
      agents.push({
        agent,
        codexHome: agent === "codex" ? codexHome : undefined,
        hookFile: join(storage.runDir, "hooks", `${agent}.jsonl`),
        pane: `${session}:0.${paneIndex}`,
        sessionRef: sessionRefFor(agent),
      });
    }
  };
  addAgent(manifest?.tmuxPaneLeftAgent, 0);
  addAgent(manifest?.tmuxPaneRightAgent, 1);
  const maxRaw = Number.parseInt(env.LOOP_BABYSIT_MAX ?? "", 10);
  return {
    agents,
    confidence: envConfidence(env),
    cooldownMs: envSeconds(env, "LOOP_BABYSIT_COOLDOWN", DEFAULT_BABYSIT_COOLDOWN_SECONDS),
    createdAt: manifest?.createdAt,
    dryRun: env.LOOP_BABYSIT_DRY_RUN === "1",
    idleMs: envSeconds(env, "LOOP_BABYSIT_IDLE", DEFAULT_BABYSIT_IDLE_SECONDS),
    logFile: join(storage.runDir, "babysitter.jsonl"),
    maxRecoveries:
      Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : DEFAULT_BABYSIT_MAX_RECOVERIES,
    model: env.LOOP_BABYSIT_MODEL || DEFAULT_BABYSIT_MODEL,
    runId,
    session,
    tickMs: envSeconds(env, "LOOP_BABYSIT_TICK", DEFAULT_BABYSIT_TICK_SECONDS),
    url: env.LOOP_BABYSIT_URL || DEFAULT_BABYSIT_URL,
  };
};

// Long-running loop; runs in the babysitter pane until the session ends.
export const runBabysitter = async (
  config: BabysitConfig,
  deps: BabysitDeps = defaultBabysitDeps()
): Promise<void> => {
  const states = new Map<Agent, AgentLivenessState>();
  let history: RecoveryHistoryEntry[] = [];
  let recoveries = 0;
  for (;;) {
    const result = await babysitTick(states, history, config, deps, recoveries);
    history = result.history;
    recoveries = result.recoveries;
    await deps.sleep(config.tickMs);
  }
};
