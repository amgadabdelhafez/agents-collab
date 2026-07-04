import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "bun";
import { initLivenessState, updateLiveness } from "./babysitter-detect";
import { judgeAgent, summarizeSession } from "./babysitter-llm";
import { decideRecovery, executeRecovery } from "./babysitter-recover";
import { readAgentUsage } from "./babysitter-usage";
import {
  DEFAULT_BABYSIT_CONFIDENCE,
  DEFAULT_BABYSIT_COOLDOWN_SECONDS,
  DEFAULT_BABYSIT_IDLE_SECONDS,
  DEFAULT_BABYSIT_MAX_RECOVERIES,
  DEFAULT_BABYSIT_MODEL,
  DEFAULT_BABYSIT_TICK_SECONDS,
  DEFAULT_BABYSIT_URL,
} from "./constants";
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
  SummaryAgentContext,
  SummaryRequest,
  SummaryResult,
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
  // On-disk size (GB) of the local LLM, shown in the footer.
  modelSizeGb?: number;
  runId: string;
  session: string;
  // Persisted run-state file, so stats survive babysitter restarts.
  stateFile?: string;
  tickMs: number;
  // Path to the run transcript (bridge messages between agents).
  transcriptPath?: string;
  url: string;
}

// Per-agent bridge message counts, keyed by sender then recipient.
export type BridgeCounts = Record<string, Record<string, number>>;

export interface BabysitDeps {
  appendLog: (file: string, record: unknown) => void;
  capturePane: (pane: string) => string;
  judge: (req: JudgeRequest) => Promise<JudgeOutcome>;
  loadState: (stateFile?: string) => BabysitRunState | undefined;
  now: () => number;
  readBridge: (transcriptPath?: string) => BridgeCounts;
  readHooks: (file: string) => HookEvent[];
  readUsage: (
    agent: Agent,
    sessionRef?: string,
    codexHome?: string
  ) => AgentUsage;
  render: (text: string) => void;
  respawnPane: (pane: string) => void;
  saveState: (stateFile: string | undefined, state: BabysitRunState) => void;
  sendKeys: (pane: string, keys: string[]) => void;
  sendText: (pane: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
  summarize: (req: SummaryRequest) => Promise<SummaryResult>;
}

// Cumulative, observed-since-start time budget per agent + both-idle time.
export interface SessionStats {
  activeMs: Record<string, number>;
  humanIdleMs: number;
  idleMs: Record<string, number>;
}

// State the babysitter carries across ticks.
export interface BabysitRunState {
  history: RecoveryHistoryEntry[];
  llmTokens: number;
  recoveries: number;
  stats: SessionStats;
  summary: string;
  summaryTick: number;
  tick: number;
}

export const freshRunState = (): BabysitRunState => ({
  history: [],
  llmTokens: 0,
  recoveries: 0,
  stats: { activeMs: {}, humanIdleMs: 0, idleMs: {} },
  summary: "",
  summaryTick: -1,
  tick: 0,
});

export interface BabysitTickResult {
  board: string;
  llmOffline: boolean;
  runState: BabysitRunState;
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
const pad2 = (n: number): string => String(n).padStart(2, "0");
// Local wall-clock time from epoch ms.
const fmtClock = (nowMs: number): string => {
  const d = new Date(nowMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

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

const eventLabel = (event: HookEvent): string => {
  const label = event.tool ?? event.event;
  return event.detail ? `${label} ${event.detail}` : label;
};

// Most recent hook event as a short "what is it doing" string.
const lastActionOf = (events: HookEvent[]): string => {
  const event = events.at(-1);
  return event ? eventLabel(event) : "—";
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
  thinking: boolean;
  usage: AgentUsage;
  verdict?: BabysitterVerdict;
}

interface BoardMeta {
  bridge: BridgeCounts;
  llmOffline: boolean;
  llmTokens: number;
  modelName: string;
  modelSizeGb?: number;
  nowMs: number;
  recoveries: number;
  stats: SessionStats;
  summary: string;
  tickMs: number;
  uptimeMs: number;
}

const COLUMNS: [string, number][] = [
  ["AGENT", 7],
  ["MODEL", 10],
  ["STATE", 12],
  ["FOR", 6],
  ["ACTIVE", 6],
  ["IDLE", 6],
  ["CTX", 13],
  ["TOK", 7],
  ["COST", 8],
  ["MSGS", 5],
  ["BRIDGE", 9],
];

const headerRow = paint(
  ANSI.dim,
  ` ${COLUMNS.map(([label, width]) => cell(label, width)).join(" ")} LAST`
);

const rowState = (row: AgentRow): string =>
  row.verdict?.state ?? (row.thinking ? "thinking" : "idle");

const bridgeFor = (
  agent: string,
  bridge: BridgeCounts
): { recv: number; sent: number } => {
  const sent = Object.values(bridge[agent] ?? {}).reduce((a, b) => a + b, 0);
  let recv = 0;
  for (const [from, tos] of Object.entries(bridge)) {
    if (from !== agent) {
      recv += tos[agent] ?? 0;
    }
  }
  return { recv, sent };
};

const renderRow = (row: AgentRow, meta: BoardMeta): string => {
  const agent = row.liveness.agent;
  const state = rowState(row);
  const forMs = row.thinking
    ? row.liveness.lastEventAgeMs
    : row.liveness.paneIdleMs;
  const ctxText = contextCell(row.usage);
  const ctx =
    contextPct(row.usage) > CONTEXT_ALERT_PCT
      ? paint(ANSI.red, cell(`${ctxText} ⚠`, 13))
      : cell(ctxText, 13);
  const tok =
    row.usage.totalTokens > 0 ? fmtTokens(row.usage.totalTokens) : "—";
  const cost = row.usage.costUsd > 0 ? `$${row.usage.costUsd.toFixed(2)}` : "—";
  const bridge = bridgeFor(agent, meta.bridge);
  const detail = truncate(
    row.lastAction +
      (row.errors > 0 ? ` (err ${row.errors})` : "") +
      (row.action ? ` · ${row.action.level}` : ""),
    LAST_ACTION_WIDTH
  );
  return ` ${[
    cell(agent, 7),
    cell(shortModel(row.usage.model), 10),
    paint(stateColor(state), cell(`● ${state}`, 12)),
    cell(fmtDuration(forMs), 6),
    cell(fmtDuration(meta.stats.activeMs[agent] ?? 0), 6),
    cell(fmtDuration(meta.stats.idleMs[agent] ?? 0), 6),
    ctx,
    cell(tok, 7),
    cell(cost, 8),
    cell(String(row.usage.messages), 5),
    cell(`→${bridge.sent} ←${bridge.recv}`, 9),
    detail,
  ].join(" ")}`;
};

const codexClaudeRatio = (stats: SessionStats): string => {
  const claude = stats.activeMs.claude ?? 0;
  const codex = stats.activeMs.codex ?? 0;
  if (claude === 0) {
    return "—";
  }
  return `${(codex / claude).toFixed(1)}×`;
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
  const perHr =
    meta.uptimeMs > 0 ? totalCost / (meta.uptimeMs / MS_PER_HOUR) : 0;
  const errorTotal = rows.reduce((sum, r) => sum + r.errors, 0);
  const parts = [
    paint(ANSI.cyan, "babysitter"),
    fmtClock(meta.nowMs),
    ...(Number.isFinite(meta.uptimeMs)
      ? [`wall ${fmtDuration(meta.uptimeMs)}`]
      : []),
    `Σ $${totalCost.toFixed(2)}${perHr > 0 ? ` ($${perHr.toFixed(0)}/hr)` : ""}`,
    `human ${human}`,
    `recov ${meta.recoveries}`,
    ...(errorTotal > 0 ? [paint(ANSI.red, `errors ${errorTotal}`)] : []),
    meta.llmOffline ? paint(ANSI.red, "qwen ✗") : paint(ANSI.green, "qwen ✓"),
  ];
  return ` ${parts.join(" · ")}`;
};

const SUMMARY_LINE_MAX = 4;
const SUMMARY_LINE_WIDTH = 180;
const SPACE_RE = /\s+/;

// Word-wrap a paragraph to `width`-char lines, capped at `maxLines`.
const wrapText = (text: string, width: number, maxLines: number): string[] => {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(SPACE_RE)) {
    if (!word) {
      continue;
    }
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) {
        return lines;
      }
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines;
};

const renderFooter = (meta: BoardMeta): string[] => {
  const size = meta.modelSizeGb ? ` (${meta.modelSizeGb.toFixed(0)}GB)` : "";
  const lines = [
    paint(
      ANSI.dim,
      ` idle-both ${fmtDuration(meta.stats.humanIdleMs)} · codex:claude ${codexClaudeRatio(meta.stats)} · local ${meta.modelName}${size} · llm ${fmtTokens(meta.llmTokens)} tok`
    ),
  ];
  const summaryText = meta.summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (summaryText) {
    lines.push(paint(ANSI.dim, " ── summary ──"));
    for (const line of wrapText(
      summaryText,
      SUMMARY_LINE_WIDTH,
      SUMMARY_LINE_MAX
    )) {
      lines.push(`   ${line}`);
    }
  }
  return lines;
};

const renderBoard = (rows: AgentRow[], meta: BoardMeta): string =>
  [
    renderSummaryLine(rows, meta),
    headerRow,
    ...rows.map((row) => renderRow(row, meta)),
    ...renderFooter(meta),
  ].join("\n");

interface AgentTickContext {
  history: RecoveryHistoryEntry[];
  nowIso: string;
  nowMs: number;
  recoveries: number;
}

const SUMMARY_ACTIONS = 8;

interface AgentTickResult {
  history: RecoveryHistoryEntry[];
  llmOffline: boolean;
  llmTokens: number;
  recoveries: number;
  row: AgentRow;
  summaryCtx: SummaryAgentContext;
}

// Run the recovery ladder for a suspect agent; returns the taken action (if any).
const recoverAgent = (
  info: BabysitAgentInfo,
  verdict: BabysitterVerdict,
  config: BabysitConfig,
  deps: BabysitDeps,
  ctx: AgentTickContext
): RecoveryHistoryEntry | null => {
  const decision: RecoveryDecision = decideRecovery(
    verdict,
    ctx.history,
    info.agent,
    {
      confidence: config.confidence,
      cooldownMs: config.cooldownMs,
      maxRecoveries: config.maxRecoveries,
      nowMs: ctx.nowMs,
    }
  );
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
    states.get(info.agent) ??
    initLivenessState(info.agent, ctx.nowMs, paneHash);
  const { state, liveness } = updateLiveness(
    prev,
    { agent: info.agent, lastEventTs: lastEventTs(events), paneHash },
    ctx.nowMs,
    config.idleMs
  );
  states.set(info.agent, state);

  const errors = events.filter((event) => event.error === true).length;
  const turnEnded = TURN_END_EVENTS.has(events.at(-1)?.event ?? "");
  // Pane changed within the last tick => the TUI is animating (thinking);
  // frozen past a tick, or the turn ended, => genuinely idle.
  const thinking =
    !turnEnded && liveness.paneIdleMs < config.tickMs && !liveness.suspect;
  const row: AgentRow = {
    action: null,
    errors,
    lastAction: lastActionOf(events),
    liveness,
    thinking,
    usage,
  };
  const summaryCtx: SummaryAgentContext = {
    agent: info.agent,
    lastActions: events.slice(-SUMMARY_ACTIONS).map(eventLabel),
    paneText,
  };
  const base = {
    llmOffline: false,
    llmTokens: 0,
    recoveries: ctx.recoveries,
    row,
    summaryCtx,
  };

  if (!liveness.suspect) {
    return {
      ...base,
      history: ctx.history.filter((entry) => entry.agent !== info.agent),
    };
  }

  const outcome = await deps.judge({
    agent: info.agent,
    hookTail: events.slice(-HOOK_TAIL_LIMIT),
    model: config.model,
    paneText,
    url: config.url,
  });
  const llmTokens = outcome.tokens ?? 0;
  row.verdict = outcome.ok ? outcome.verdict : outcome.fallback;
  if (!outcome.ok && outcome.reason === "unreachable") {
    return { ...base, history: ctx.history, llmOffline: true, llmTokens };
  }

  const action = recoverAgent(info, row.verdict, config, deps, ctx);
  row.action = action;
  const recovered = Boolean(action) && !config.dryRun;
  return {
    ...base,
    history: recovered
      ? [...ctx.history, action as RecoveryHistoryEntry]
      : ctx.history,
    llmTokens,
    recoveries: ctx.recoveries + (recovered ? 1 : 0),
  };
};

const SUMMARY_REFRESH_TICKS = 20;
const LOCAL_MODEL_PREFIX_RE = /^[^/]+\//;
const shortLocalModel = (model: string): string =>
  model.replace(LOCAL_MODEL_PREFIX_RE, "");

// Add tickMs to each agent's active/idle budget; both idle => human-idle time.
const accumulateStats = (
  stats: SessionStats,
  rows: AgentRow[],
  tickMs: number
): void => {
  let anyActive = false;
  for (const row of rows) {
    const agent = row.liveness.agent;
    const active = row.thinking || row.verdict?.state === "working";
    if (active) {
      stats.activeMs[agent] = (stats.activeMs[agent] ?? 0) + tickMs;
      anyActive = true;
    } else {
      stats.idleMs[agent] = (stats.idleMs[agent] ?? 0) + tickMs;
    }
  }
  if (!anyActive) {
    stats.humanIdleMs += tickMs;
  }
};

const cloneStats = (stats: SessionStats): SessionStats => ({
  activeMs: { ...stats.activeMs },
  humanIdleMs: stats.humanIdleMs,
  idleMs: { ...stats.idleMs },
});

// One control-loop tick: detect → (judge suspects) → recover → summarize → render.
export const babysitTick = async (
  states: Map<Agent, AgentLivenessState>,
  config: BabysitConfig,
  deps: BabysitDeps,
  runStateIn: BabysitRunState = freshRunState()
): Promise<BabysitTickResult> => {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const runState: BabysitRunState = {
    ...runStateIn,
    stats: cloneStats(runStateIn.stats),
    tick: runStateIn.tick + 1,
  };
  let { history, recoveries, llmTokens } = runState;
  let llmOffline = false;
  const rows: AgentRow[] = [];
  const summaryCtxs: SummaryAgentContext[] = [];

  for (const info of config.agents) {
    const result = await processAgent(info, states, config, deps, {
      history,
      nowIso,
      nowMs,
      recoveries,
    });
    history = result.history;
    recoveries = result.recoveries;
    llmTokens += result.llmTokens;
    llmOffline = llmOffline || result.llmOffline;
    rows.push(result.row);
    summaryCtxs.push(result.summaryCtx);
  }

  accumulateStats(runState.stats, rows, config.tickMs);

  if (
    runState.summaryTick < 0 ||
    runState.tick - runState.summaryTick >= SUMMARY_REFRESH_TICKS
  ) {
    const summary = await deps.summarize({
      agents: summaryCtxs,
      model: config.model,
      url: config.url,
    });
    if (summary.text) {
      runState.summary = summary.text;
    }
    llmTokens += summary.tokens;
    runState.summaryTick = runState.tick;
  }

  runState.history = history;
  runState.recoveries = recoveries;
  runState.llmTokens = llmTokens;

  const uptimeMs = config.createdAt
    ? nowMs - Date.parse(config.createdAt)
    : Number.NaN;
  const board = renderBoard(rows, {
    bridge: deps.readBridge(config.transcriptPath),
    llmOffline,
    llmTokens,
    modelName: shortLocalModel(config.model),
    modelSizeGb: config.modelSizeGb,
    nowMs,
    recoveries,
    stats: runState.stats,
    summary: runState.summary,
    tickMs: config.tickMs,
    uptimeMs,
  });
  deps.render(board);
  return { board, llmOffline, runState, states };
};

const tmux = (args: string[]): string => {
  const result = spawnSync(["tmux", ...args], {
    stderr: "ignore",
    stdout: "pipe",
  });
  return decode(result.stdout);
};

// Tally bridge messages from the run transcript, keyed by sender then recipient.
export const readBridgeCounts = (transcriptPath?: string): BridgeCounts => {
  const counts: BridgeCounts = {};
  if (!transcriptPath) {
    return counts;
  }
  try {
    for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const from = record.from;
      const to = record.to;
      if (typeof from === "string" && typeof to === "string") {
        counts[from] ??= {};
        counts[from][to] = (counts[from][to] ?? 0) + 1;
      }
    }
  } catch {
    // No transcript yet.
  }
  return counts;
};

// Persist run-state so cumulative stats survive a babysitter respawn.
export const loadBabysitState = (
  stateFile?: string
): BabysitRunState | undefined => {
  if (!stateFile) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(stateFile, "utf8")
    ) as Partial<BabysitRunState>;
    const stats = parsed.stats;
    if (!stats) {
      return undefined;
    }
    return {
      history: Array.isArray(parsed.history) ? parsed.history : [],
      llmTokens: typeof parsed.llmTokens === "number" ? parsed.llmTokens : 0,
      recoveries: typeof parsed.recoveries === "number" ? parsed.recoveries : 0,
      stats: {
        activeMs: stats.activeMs ?? {},
        humanIdleMs: stats.humanIdleMs ?? 0,
        idleMs: stats.idleMs ?? {},
      },
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      summaryTick:
        typeof parsed.summaryTick === "number" ? parsed.summaryTick : -1,
      tick: typeof parsed.tick === "number" ? parsed.tick : 0,
    };
  } catch {
    return undefined;
  }
};

export const saveBabysitState = (
  stateFile: string | undefined,
  state: BabysitRunState
): void => {
  if (!stateFile) {
    return;
  }
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
  } catch {
    // Best-effort persistence.
  }
};

export const defaultBabysitDeps = (): BabysitDeps => ({
  appendLog: (file, record) => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  },
  capturePane: (pane) => tmux(["capture-pane", "-p", "-t", pane]),
  judge: (req) => judgeAgent(req),
  loadState: (stateFile) => loadBabysitState(stateFile),
  now: () => Date.now(),
  readBridge: (transcriptPath) => readBridgeCounts(transcriptPath),
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
  saveState: (stateFile, state) => saveBabysitState(stateFile, state),
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
  summarize: (req) => summarizeSession(req),
});

const MS_PER_SECOND = 1000;

const envSeconds = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallbackSeconds: number
): number => {
  const raw = env[key];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const seconds =
    Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackSeconds;
  return seconds * MS_PER_SECOND;
};

const envConfidence = (env: NodeJS.ProcessEnv): number => {
  const parsed = Number.parseFloat(env.LOOP_BABYSIT_CONFIDENCE ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_BABYSIT_CONFIDENCE;
};

const MODEL_SLASH_RE = /\//g;
const WHITESPACE_RE = /\s+/;
const MB_PER_GB = 1024;

// Best-effort on-disk size (GB) of the local model from the HF cache.
const modelSizeGb = (model: string): number | undefined => {
  const dir = join(
    homedir(),
    ".cache",
    "huggingface",
    "hub",
    `models--${model.replace(MODEL_SLASH_RE, "--")}`
  );
  try {
    const out = decode(
      spawnSync(["du", "-sm", dir], { stderr: "ignore", stdout: "pipe" }).stdout
    );
    const mb = Number.parseInt(out.trim().split(WHITESPACE_RE)[0] ?? "", 10);
    return Number.isFinite(mb) && mb > 0
      ? Math.round(mb / MB_PER_GB)
      : undefined;
  } catch {
    return undefined;
  }
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
  const model = env.LOOP_BABYSIT_MODEL || DEFAULT_BABYSIT_MODEL;
  return {
    agents,
    confidence: envConfidence(env),
    cooldownMs: envSeconds(
      env,
      "LOOP_BABYSIT_COOLDOWN",
      DEFAULT_BABYSIT_COOLDOWN_SECONDS
    ),
    createdAt: manifest?.createdAt,
    dryRun: env.LOOP_BABYSIT_DRY_RUN === "1",
    idleMs: envSeconds(env, "LOOP_BABYSIT_IDLE", DEFAULT_BABYSIT_IDLE_SECONDS),
    logFile: join(storage.runDir, "babysitter.jsonl"),
    maxRecoveries:
      Number.isInteger(maxRaw) && maxRaw > 0
        ? maxRaw
        : DEFAULT_BABYSIT_MAX_RECOVERIES,
    model,
    modelSizeGb: modelSizeGb(model),
    runId,
    session,
    stateFile: join(storage.runDir, "babysitter-state.json"),
    tickMs: envSeconds(env, "LOOP_BABYSIT_TICK", DEFAULT_BABYSIT_TICK_SECONDS),
    transcriptPath: join(storage.runDir, "transcript.jsonl"),
    url: env.LOOP_BABYSIT_URL || DEFAULT_BABYSIT_URL,
  };
};

// Long-running loop; runs in the babysitter pane until the session ends.
export const runBabysitter = async (
  config: BabysitConfig,
  deps: BabysitDeps = defaultBabysitDeps()
): Promise<void> => {
  const states = new Map<Agent, AgentLivenessState>();
  let runState = deps.loadState(config.stateFile) ?? freshRunState();
  for (;;) {
    const result = await babysitTick(states, config, deps, runState);
    runState = result.runState;
    deps.saveState(config.stateFile, runState);
    await deps.sleep(config.tickMs);
  }
};
