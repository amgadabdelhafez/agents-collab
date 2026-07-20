import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "bun";
import { readPriorSummaries, readProjectContext } from "./babysitter-context";
import { initLivenessState, updateLiveness } from "./babysitter-detect";
import {
  assessRoleBalance,
  assessWaiting,
  judgeAgent,
  LOCAL_LLM_JUDGE_MAX_TOKENS,
  LOCAL_LLM_SUMMARY_MAX_TOKENS,
  LOCAL_LLM_TEMPERATURE,
  LOCAL_LLM_WAITING_MAX_TOKENS,
  labelPanes,
  summarizeSession,
} from "./babysitter-llm";
import { type EscalationEvent, sendNtfy } from "./babysitter-notify";
import { decideRecovery, executeRecovery } from "./babysitter-recover";
import { readAgentUsage, readHumanMessages } from "./babysitter-usage";
import {
  readUsageTrackerLimits,
  type UsageLimitSnapshot,
} from "./babysitter-usage-limits";
import { dispatchBridgeMessage } from "./bridge-dispatch";
import {
  deliverCodexBridgeMessage,
  deliverTmuxBridgeMessage,
  ensureBridgeWorker,
  hasBridgeDeliveryRoute,
  readBridgeRuntimeStatus,
} from "./bridge-runtime";
import { type BridgeMessage, readBridgeEvents } from "./bridge-store";
import {
  DEFAULT_BABYSIT_CONFIDENCE,
  DEFAULT_BABYSIT_COOLDOWN_SECONDS,
  DEFAULT_BABYSIT_ESCALATE_IDLE_SECONDS,
  DEFAULT_BABYSIT_IDLE_SECONDS,
  DEFAULT_BABYSIT_MAX_RECOVERIES,
  DEFAULT_BABYSIT_MODEL,
  DEFAULT_BABYSIT_TICK_SECONDS,
  DEFAULT_BABYSIT_URL,
  DEFAULT_USAGE_TRACKER_TIMEOUT_MS,
  DEFAULT_USAGE_TRACKER_URL,
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
  LocalLlmUsage,
  PaneLabelRequest,
  PaneLabelResult,
  RecoveryDecision,
  RecoveryHistoryEntry,
  RoleBalanceRequest,
  RoleBalanceResult,
  SummaryAgentContext,
  SummaryRequest,
  SummaryResult,
  WaitingRequest,
  WaitingResult,
} from "./types";

export const BABYSIT_SUBCOMMAND = "__babysit";

const HOOK_TAIL_LIMIT = 20;
const NUDGE_TEXT = "babysitter: you look idle — status? are you blocked?";
const PANE_HASH_LENGTH = 12;
const LIMIT_HANDOFF_PCT = 95;
const PROACTIVE_BALANCE_PCT = 80;
const PROACTIVE_BALANCE_ADVANTAGE_PCT = 15;
const PROACTIVE_BALANCE_MIN_CONFIDENCE = 0.6;

export interface BabysitAgentInfo {
  agent: Agent;
  // Per-run CODEX_HOME, so Codex usage transcripts under it can be located.
  codexHome?: string;
  hookFile: string;
  pane: string;
  // Session id / thread id used to locate the agent's usage transcript.
  sessionRef?: string;
}

export interface LocalLlmJudgeConfig {
  id: string;
  logFile?: string;
  model: string;
  modelSizeGb?: number;
  url: string;
}

export type LocalLlmJudgeMode = "consensus" | "round-robin";

export interface BabysitConfig {
  agents: BabysitAgentInfo[];
  // Session cost ceiling (USD) for the budget line + escalation; 0 disables.
  budgetUsd: number;
  confidence: number;
  cooldownMs: number;
  // Run manifest creation time, for session uptime.
  createdAt?: string;
  // Working directory of the run, for reading project docs into the summary.
  cwd?: string;
  dryRun: boolean;
  // How long an agent may sit waiting-for-human before we escalate.
  escalateIdleMs: number;
  idleMs: number;
  initialDriver?: Agent;
  judgeMode: LocalLlmJudgeMode;
  judges?: LocalLlmJudgeConfig[];
  llmDecodeConcurrency: number;
  llmLogFile?: string;
  llmPrefillStepSize: number;
  llmPromptCacheSlots: number;
  llmPromptConcurrency: number;
  llmTraceFile?: string;
  logFile: string;
  maxRecoveries: number;
  model: string;
  // On-disk size (GB) of the local LLM, shown in the footer.
  modelSizeGb?: number;
  // ntfy topic URL for remote escalation; escalation is off when unset.
  ntfyUrl?: string;
  roleBalanceEnabled: boolean;
  // Run directory, for reading prior-session summaries into the summary.
  runDir?: string;
  runId: string;
  session: string;
  // Persisted run-state file, so stats survive babysitter restarts.
  stateFile?: string;
  tickMs: number;
  // Path to the run transcript (bridge messages between agents).
  transcriptPath?: string;
  url: string;
  usageTrackerSecret?: string;
  usageTrackerTimeoutMs: number;
  usageTrackerUrl?: string;
}

// Per-agent bridge message counts, keyed by sender then recipient.
export type BridgeCounts = Record<string, Record<string, number>>;
export type BridgeLatest = Record<string, Record<string, BridgeMessage>>;
export type BridgeSendStatus = "accepted" | "delivered" | "queued";
export type LocalLlmUsageByJudge = Record<string, LocalLlmUsage>;

export interface BabysitDeps {
  appendLog: (file: string, record: unknown) => void;
  assessRoleBalance: (req: RoleBalanceRequest) => Promise<RoleBalanceResult>;
  assessWaiting: (req: WaitingRequest) => Promise<WaitingResult>;
  capturePane: (pane: string) => string;
  // Turn on the pane-border title strip for the whole session (idempotent).
  initPaneBorders: (session: string) => void;
  judge: (req: JudgeRequest) => Promise<JudgeOutcome>;
  labelPanes: (req: PaneLabelRequest) => Promise<PaneLabelResult>;
  loadState: (stateFile?: string) => BabysitRunState | undefined;
  notify: (ntfyUrl: string | undefined, event: EscalationEvent) => void;
  now: () => number;
  readBridge: (transcriptPath?: string) => BridgeCounts;
  readBridgeLatest: (runDir?: string) => BridgeLatest;
  readHooks: (file: string) => HookEvent[];
  readHumanMessages: (
    agent: Agent,
    sessionRef?: string,
    codexHome?: string
  ) => string[];
  readLocalLlmRuntime: (input: LocalLlmRuntimeInput) => LocalLlmRuntime;
  readUsage: (
    agent: Agent,
    sessionRef?: string,
    codexHome?: string
  ) => AgentUsage;
  readUsageLimits: (
    config: BabysitConfig
  ) => Promise<UsageLimitSnapshot | undefined>;
  render: (text: string) => void;
  respawnPane: (pane: string) => void;
  saveState: (stateFile: string | undefined, state: BabysitRunState) => void;
  sendBridge: (
    runDir: string,
    source: Agent,
    target: Agent,
    message: string
  ) => Promise<BridgeSendStatus>;
  sendKeys: (pane: string, keys: string[]) => void;
  sendText: (pane: string, text: string) => void;
  // Set one pane's border title via a per-pane tmux user option (@loop_label).
  setPaneLabel: (pane: string, label: string) => void;
  sleep: (ms: number) => Promise<void>;
  summarize: (req: SummaryRequest) => Promise<SummaryResult>;
}

// Cumulative, observed-since-start time budget per agent + both-idle time.
export interface SessionStats {
  activeMs: Record<string, number>;
  humanIdleMs: number;
  idleMs: Record<string, number>;
}

// Which escalations have already been sent, so we alert once per episode
// rather than every tick (persisted, so a restart does not re-spam).
export interface NotifiedState {
  budget80: boolean;
  budget100: boolean;
  ladder: Record<string, boolean>;
  limitHandoff: Record<string, string>;
  waitingForYou: boolean;
}

export interface RoleState {
  balanceAt?: string;
  balanceCheckKey?: string;
  balanceKey?: string;
  balanceReason?: string;
  currentDriver?: Agent;
  handoffAt?: string;
  initialDriver?: Agent;
  lastAction?: "balance" | "handoff" | "restore";
  pausedAgent?: Agent;
  pressureKey?: string;
  pressureMissingAt?: string;
  reset?: string;
  resetKind?: "session" | "weekly";
  restoredAt?: string;
  temporaryDriver?: Agent;
}

// State the babysitter carries across ticks.
export interface BabysitRunState {
  babysitterMessages: Record<string, number>;
  // Epoch ms both agents became idle together (0 = not both idle right now).
  bothIdleSince: number;
  history: RecoveryHistoryEntry[];
  // Backward-compatible persisted total; `llmUsage` is the canonical shape.
  llmTokens: number;
  llmUsage: LocalLlmUsage;
  llmUsageByJudge: LocalLlmUsageByJudge;
  notified: NotifiedState;
  // Last LLM-derived task label per agent, for the pane border (survives resume).
  paneLabels: Partial<Record<Agent, string>>;
  // Tick the pane labels were last refreshed (-1 = never).
  paneLabelTick: number;
  // Last `/rename` command sent to each agent, to skip re-sending an unchanged one.
  paneRenames: Partial<Record<Agent, string>>;
  // Last border title actually pushed to tmux, keyed by pane, to skip redundant sets.
  paneTitles: Record<string, string>;
  recoveries: number;
  roles: RoleState;
  stats: SessionStats;
  summary: string;
  summaryTick: number;
  tick: number;
  // The local LLM's read of the current both-idle episode.
  waitingAsk: string;
  waitingConfirmed: boolean;
}

const freshNotified = (): NotifiedState => ({
  budget100: false,
  budget80: false,
  ladder: {},
  limitHandoff: {},
  waitingForYou: false,
});

const readCountMap = (value: unknown): Record<string, number> => {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      out[key] = count;
    }
  }
  return out;
};

const readStringMap = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text === "string" && text.length > 0) {
      out[key] = text;
    }
  }
  return out;
};

const incrementCount = (
  counts: Record<string, number>,
  agent: Agent,
  amount = 1
): void => {
  counts[agent] = (counts[agent] ?? 0) + amount;
};

const emptyLocalLlmUsage = (): LocalLlmUsage => ({
  cachedInputTokens: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const localLlmUsageFromTokens = (tokens: number): LocalLlmUsage => ({
  ...emptyLocalLlmUsage(),
  totalTokens: Math.max(0, tokens),
});

const readLocalLlmUsage = (value: unknown, legacyTokens = 0): LocalLlmUsage => {
  if (typeof value !== "object" || value === null) {
    return localLlmUsageFromTokens(legacyTokens);
  }
  const record = value as Partial<LocalLlmUsage>;
  return {
    cachedInputTokens:
      typeof record.cachedInputTokens === "number"
        ? record.cachedInputTokens
        : 0,
    calls: typeof record.calls === "number" ? record.calls : 0,
    inputTokens:
      typeof record.inputTokens === "number" ? record.inputTokens : 0,
    outputTokens:
      typeof record.outputTokens === "number" ? record.outputTokens : 0,
    totalTokens:
      typeof record.totalTokens === "number"
        ? record.totalTokens
        : Math.max(0, legacyTokens),
  };
};

const addLocalLlmUsage = (
  a: LocalLlmUsage,
  b: LocalLlmUsage
): LocalLlmUsage => ({
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  calls: a.calls + b.calls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
});

const emptyLocalLlmUsageByJudge = (): LocalLlmUsageByJudge => ({});

const addLocalLlmUsageByJudge = (
  a: LocalLlmUsageByJudge,
  b: LocalLlmUsageByJudge
): LocalLlmUsageByJudge => {
  const next: LocalLlmUsageByJudge = { ...a };
  for (const [id, usage] of Object.entries(b)) {
    next[id] = addLocalLlmUsage(next[id] ?? emptyLocalLlmUsage(), usage);
  }
  return next;
};

const sumLocalLlmUsageByJudge = (
  usageByJudge: LocalLlmUsageByJudge
): LocalLlmUsage =>
  Object.values(usageByJudge).reduce(
    (sum, usage) => addLocalLlmUsage(sum, usage),
    emptyLocalLlmUsage()
  );

const readLocalLlmUsageByJudge = (
  value: unknown,
  primaryId: string,
  aggregate: LocalLlmUsage
): LocalLlmUsageByJudge => {
  if (typeof value !== "object" || value === null) {
    return aggregate.totalTokens > 0 || aggregate.calls > 0
      ? { [primaryId]: aggregate }
      : {};
  }
  const out: LocalLlmUsageByJudge = {};
  for (const [id, usage] of Object.entries(value)) {
    out[id] = readLocalLlmUsage(usage);
  }
  if (
    Object.keys(out).length === 0 &&
    (aggregate.totalTokens > 0 || aggregate.calls > 0)
  ) {
    out[primaryId] = aggregate;
  }
  return out;
};

const AGENT_VALUES: readonly Agent[] = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
];

const readAgentValue = (value: unknown): Agent | undefined =>
  typeof value === "string" && AGENT_VALUES.includes(value as Agent)
    ? (value as Agent)
    : undefined;

const readResetKind = (value: unknown): "session" | "weekly" | undefined =>
  value === "session" || value === "weekly" ? value : undefined;

const readRoleAction = (
  value: unknown
): "balance" | "handoff" | "restore" | undefined =>
  value === "balance" || value === "handoff" || value === "restore"
    ? value
    : undefined;

const readStringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const readRoleState = (value: unknown): RoleState => {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    balanceAt: readStringValue(record.balanceAt),
    balanceCheckKey: readStringValue(record.balanceCheckKey),
    balanceKey: readStringValue(record.balanceKey),
    balanceReason: readStringValue(record.balanceReason),
    currentDriver: readAgentValue(record.currentDriver),
    handoffAt: readStringValue(record.handoffAt),
    initialDriver: readAgentValue(record.initialDriver),
    lastAction: readRoleAction(record.lastAction),
    pausedAgent: readAgentValue(record.pausedAgent),
    pressureMissingAt: readStringValue(record.pressureMissingAt),
    pressureKey: readStringValue(record.pressureKey),
    reset: readStringValue(record.reset),
    resetKind: readResetKind(record.resetKind),
    restoredAt: readStringValue(record.restoredAt),
    temporaryDriver: readAgentValue(record.temporaryDriver),
  };
};

export const freshRunState = (): BabysitRunState => ({
  babysitterMessages: {},
  bothIdleSince: 0,
  history: [],
  llmUsage: emptyLocalLlmUsage(),
  llmUsageByJudge: emptyLocalLlmUsageByJudge(),
  llmTokens: 0,
  notified: freshNotified(),
  paneLabels: {},
  paneLabelTick: -1,
  paneRenames: {},
  paneTitles: {},
  recoveries: 0,
  roles: {},
  stats: { activeMs: {}, humanIdleMs: 0, idleMs: {} },
  summary: "",
  summaryTick: -1,
  tick: 0,
  waitingAsk: "",
  waitingConfirmed: false,
});

export interface BabysitTickResult {
  // Per-agent display state this tick (working/thinking/idle/limited/...), so a
  // background rename can skip agents that are mid-turn.
  agentStates: Partial<Record<Agent, string>>;
  board: string;
  llmOffline: boolean;
  runState: BabysitRunState;
  states: Map<Agent, AgentLivenessState>;
  // Per-agent contexts a background summary refresh consumes (see runBabysitter).
  summaryCtxs: SummaryAgentContext[];
}

const hashPane = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, PANE_HASH_LENGTH);

const lastEventTs = (events: HookEvent[]): string | undefined =>
  events.length > 0 ? events.at(-1)?.ts : undefined;

// Agents render their own live context remaining in the pane statusline
// (e.g. "ctx: 91%"). Convert it to used context for this board's CTX cell.
const PANE_CTX_RE = /ctx:?\s*(\d+)\s*%/i;
const PANE_EFFORT_RE = /effort:?\s*([a-z0-9_-]+)/i;
const SESSION_LIMIT_RE =
  /\b(hit|reached)\s+(your\s+)?(session|usage|rate)\s+limit\b|\b(rate|usage|session)\s+limit\b/i;
const CONTEXT_COMPACT_RE =
  /\b(context|ctx)\b.*\b(compact|window|full|limit)\b|\b(compact|compress)\b.*\b(context|ctx)\b/i;
const BABYSITTER_PROMPT_RE = /\bbabysitter:/i;
const parsePaneCtxRemainingPct = (paneText: string): number | undefined => {
  const match = paneText.match(PANE_CTX_RE);
  if (!match) {
    return undefined;
  }
  const pct = Number.parseInt(match[1], 10);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : undefined;
};

const parsePaneEffort = (paneText: string): string | undefined =>
  paneText.match(PANE_EFFORT_RE)?.[1]?.toLowerCase();

// Only the TAIL of the pane counts as "current state": an idle agent produces
// no new output, so a pre-reset limit banner higher up would otherwise match
// forever — invisible to manual limit resets (the loop-23 stale-limit bug).
// Any newer output (model change, ack, turn) pushes the banner above the
// window and clears the verdict.
const SESSION_LIMIT_TAIL_LINES = 20;

const isSessionLimited = (paneText: string): boolean =>
  paneText
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-SESSION_LIMIT_TAIL_LINES)
    .some(
      (line) =>
        !BABYSITTER_PROMPT_RE.test(line) &&
        SESSION_LIMIT_RE.test(line) &&
        !CONTEXT_COMPACT_RE.test(line)
    );

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

const fmtTokenLimit = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

const fmtGb = (n: number): string =>
  `${n.toFixed(n >= 10 ? 1 : 2).replace(/\.0+$/, "")}GB`;

const ANSI = {
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
};
const CONTEXT_ALERT_PCT = 80;
const JUDGE_SUMMARY_MAX = 140;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const BUDGET_WARN_FRACTION = 0.8;
const DEFAULT_LOCAL_LLM_DECODE_CONCURRENCY = 32;
const DEFAULT_LOCAL_LLM_PREFILL_STEP_SIZE = 2048;
const DEFAULT_LOCAL_LLM_PROMPT_CACHE_SLOTS = 10;
const DEFAULT_LOCAL_LLM_PROMPT_CONCURRENCY = 8;
// Only ask the local LLM whether the pair needs us once they have been idle
// together this long, to skip the brief both-idle gaps between hand-offs.
const BOTH_IDLE_ASSESS_MS = 45_000;

const paint = (code: string, text: string): string =>
  `${code}${text}${ANSI.reset}`;
const cell = (text: string, width: number): string => text.padEnd(width);
const capitalize = (value: string): string =>
  value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
const fitCell = (text: string, width: number): string =>
  cell(truncate(text, width), width);
const colorCell = (code: string, text: string, width: number): string =>
  paint(code, fitCell(text, width));
const pad2 = (n: number): string => String(n).padStart(2, "0");
// Local wall-clock time from epoch ms.
const fmtClock = (nowMs: number): string => {
  const d = new Date(nowMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const CLAUDE_PREFIX_RE = /^claude-/;
const shortModel = (model?: string): string =>
  model ? model.replace(CLAUDE_PREFIX_RE, "").slice(0, 10) : "—";
const LOCAL_MODEL_PREFIX_RE = /^[^/]+\//;
const shortLocalModel = (model: string): string =>
  model.replace(LOCAL_MODEL_PREFIX_RE, "");
const judgeIdFromModel = (model: string): string => {
  const name = shortLocalModel(model).toLowerCase();
  if (name.includes("qwen")) {
    return "qwen";
  }
  if (name.includes("gemma")) {
    return "gemma";
  }
  return name.split(/[-_]/)[0] || "llm";
};

const primaryJudge = (config: BabysitConfig): LocalLlmJudgeConfig =>
  config.judges?.[0] ?? {
    id: judgeIdFromModel(config.model),
    logFile: config.llmLogFile,
    model: config.model,
    modelSizeGb: config.modelSizeGb,
    url: config.url,
  };

const localJudges = (config: BabysitConfig): LocalLlmJudgeConfig[] =>
  config.judges?.length ? config.judges : [primaryJudge(config)];

const localJudgesForTick = (
  config: BabysitConfig,
  tick: number
): LocalLlmJudgeConfig[] => {
  const judges = localJudges(config);
  if (config.judgeMode !== "round-robin" || judges.length <= 1) {
    return judges;
  }
  return [judges[Math.max(0, tick - 1) % judges.length] as LocalLlmJudgeConfig];
};

const contextPct = (u: AgentUsage): number =>
  u.contextTokens > 0
    ? Math.round((u.contextTokens / u.contextWindow) * 100)
    : 0;

const contextCell = (u: AgentUsage): string =>
  u.contextTokens > 0
    ? `${fmtTokens(u.contextTokens)}/${fmtTokens(u.contextWindow)} ${contextPct(u)}%`
    : "—";

const totalContextTokens = (u: AgentUsage): number =>
  u.contextTokens + u.compactedContextTokens;

const tokenCell = (tokens: number): string =>
  tokens > 0 ? fmtTokens(tokens) : "—";

const costBurnCell = (u: AgentUsage, activeMs: number): string => {
  const perHr =
    u.costUsd > 0 && activeMs >= MS_PER_MINUTE
      ? u.costUsd / (activeMs / MS_PER_HOUR)
      : u.costRateUsdPerHour;
  return perHr > 0 ? `$${perHr.toFixed(0)}` : "—";
};

const rateLimitCell = (u: AgentUsage): string => {
  if (
    u.rateLimitPrimaryPct === undefined &&
    u.rateLimitSecondaryPct === undefined
  ) {
    return "—";
  }
  const primary = u.rateLimitPrimaryPct ?? 0;
  const secondary = u.rateLimitSecondaryPct ?? 0;
  return `${primary}s/${secondary}w`;
};

const RESET_DATE_RE = /\b\d{4}\b/;
const RESET_MONTH_DAY_RE = /^([A-Za-z]{3})\s+(\d{1,2})\b/;

const parseResetTime = (
  reset: string | undefined,
  nowMs: number
): { raw: string; date: Date; time: string } | undefined => {
  const raw = reset?.trim();
  if (!raw) {
    return undefined;
  }
  const now = new Date(nowMs);
  const parsed = Date.parse(
    RESET_DATE_RE.test(raw) ? raw : `${raw} ${now.getFullYear()}`
  );
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const date = new Date(parsed);
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hours12 = date.getHours() % 12 || 12;
  const suffix = date.getHours() >= 12 ? "p" : "a";
  return { date, raw, time: `${hours12}:${minutes}${suffix}` };
};

const resetRemainingCell = (date: Date, nowMs: number): string => {
  const remainingMs = Math.max(0, date.getTime() - nowMs);
  const totalMinutes = Math.floor(remainingMs / MS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
};

const sessionResetCell = (reset: string | undefined, nowMs: number): string => {
  const parsed = parseResetTime(reset, nowMs);
  return parsed
    ? resetRemainingCell(parsed.date, nowMs)
    : (reset?.trim() ?? "—");
};

const weeklyResetCell = (reset: string | undefined, nowMs: number): string => {
  const parsed = parseResetTime(reset, nowMs);
  if (!parsed) {
    return reset?.trim() || "—";
  }
  const { date, raw, time } = parsed;
  const now = new Date(nowMs);
  const sameLocalDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameLocalDay) {
    return time;
  }
  const monthDay = raw.match(RESET_MONTH_DAY_RE);
  return monthDay ? `${monthDay[1]} ${monthDay[2]} ${time}` : time;
};

const rateLimitColor = (u: AgentUsage): string | undefined => {
  const high = Math.max(
    u.rateLimitPrimaryPct ?? 0,
    u.rateLimitSecondaryPct ?? 0
  );
  if (high >= 80) {
    return ANSI.red;
  }
  if (high >= 60) {
    return ANSI.yellow;
  }
  return undefined;
};

const effortCell = (u: AgentUsage): string => {
  const effort = u.reasoningEffort?.toLowerCase();
  if (!effort) {
    return "—";
  }
  if (effort === "medium") {
    return "med";
  }
  if (effort === "xhigh") {
    return "xhi";
  }
  return effort;
};

const multiplierLabel = (value: number): string =>
  Number.isInteger(value) ? `${value}x` : `${value.toFixed(1)}x`;

const modeCell = (u: AgentUsage): string => {
  const raw = (u.speed ?? u.serviceTier)?.toLowerCase();
  if (!raw) {
    return "—";
  }
  const mode = raw === "standard" ? "std" : raw === "priority" ? "fast" : raw;
  return u.creditCostMultiplier
    ? `${mode}/${multiplierLabel(u.creditCostMultiplier)}`
    : mode;
};

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

const stateLabel = (state: string): string => {
  if (state === "limited") {
    return "limit";
  }
  return state;
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

// The pair is idle; the local LLM confirms whether it needs you and what for.
interface WaitingForYou {
  ask: string;
  confirmed: boolean;
  ms: number;
}

interface LocalLlmRuntime {
  cachedPromptTokens?: number;
  decodeConcurrency?: number;
  kvCacheGb?: number;
  kvCacheSequences?: number;
  modelInfo?: LocalLlmModelInfo;
  prefillStepSize?: number;
  promptCacheGb?: number;
  promptCacheMaxSequences?: number;
  promptCacheRoles?: Record<string, number>;
  promptCacheSequences?: number;
  promptConcurrency?: number;
  promptTokens?: number;
}

interface LocalLlmModelInfo {
  attentionHeads?: number;
  contextTokens?: number;
  dtype?: string;
  fullAttentionInterval?: number;
  headDim?: number;
  hiddenSize?: number;
  kvHeads?: number;
  layers?: number;
  modelType?: string;
  moeActiveExperts?: number;
  moeExperts?: number;
  quantBits?: number;
  quantGroupSize?: number;
  quantMode?: string;
}

interface LocalLlmRuntimeInput {
  decodeConcurrency?: number;
  home?: string;
  logFile?: string;
  model: string;
  prefillStepSize?: number;
  promptCacheMaxSequences?: number;
  promptConcurrency?: number;
  traceFile?: string;
}

interface BoardMeta {
  babysitterMessages: Record<string, number>;
  bridge: BridgeCounts;
  bridgeLatest: BridgeLatest;
  budgetUsd: number;
  initialDriver?: Agent;
  judgeMode: LocalLlmJudgeMode;
  llmJudges: LocalLlmJudgeConfig[];
  llmOfflineByJudge: Record<string, boolean>;
  llmRuntimeByJudge: Record<string, LocalLlmRuntime>;
  llmUsageByJudge: LocalLlmUsageByJudge;
  nowMs: number;
  recoveries: number;
  roles: RoleState;
  stats: SessionStats;
  summary: string;
  tickMs: number;
  uptimeMs: number;
  waitingForYou: WaitingForYou;
}

const COL = {
  activity: 6,
  agent: 7,
  bridge: 18,
  cache: 7,
  code: 7,
  compact: 4,
  context: 16,
  contextTotal: 7,
  cost: 8,
  costRate: 7,
  effort: 5,
  exec: 7,
  inspect: 9,
  input: 7,
  mode: 9,
  model: 10,
  now: 6,
  other: 7,
  output: 7,
  plan: 7,
  rateLimit: 9,
  resetSession: 13,
  resetWeekly: 13,
  state: 12,
  text: 5,
  thinking: 5,
  tokens: 7,
  tools: 6,
} as const;

const COLUMNS: [string, number][] = [
  ["AGENT", COL.agent],
  ["STATE", COL.state],
  ["NOW", COL.now],
  ["MODEL", COL.model],
  ["EFF", COL.effort],
  ["MODE", COL.mode],
  ["CTX", COL.context],
  ["CTX+", COL.contextTotal],
  ["CMP", COL.compact],
  ["LIMIT S/W", COL.rateLimit],
  ["S RESET", COL.resetSession],
  ["W RESET", COL.resetWeekly],
  ["COST", COL.cost],
  ["$/H", COL.costRate],
  ["TOK", COL.tokens],
  ["IN", COL.input],
  ["CACHE", COL.cache],
  ["OUT", COL.output],
  ["ACT", COL.activity],
  ["TXT", COL.text],
  ["THK", COL.thinking],
  ["TOOL", COL.tools],
  ["EXEC", COL.exec],
  ["CODE", COL.code],
  ["READ/VIEW", COL.inspect],
  ["PLAN", COL.plan],
  ["MISC", COL.other],
  ["BRIDGE", COL.bridge],
];

const headerRow = paint(
  ANSI.dim,
  ` ${COLUMNS.map(([label, width]) => cell(label, width)).join(" ")}`
);

const rowState = (row: AgentRow): string =>
  row.verdict?.state ?? (row.thinking ? "thinking" : "idle");

// Single-glyph state marker for the pane border title.
const STATE_GLYPHS: Record<string, string> = {
  working: "▶",
  thinking: "…",
  "waiting-human": "⏸",
  "waiting-peer": "⧗",
  stuck: "⚠",
  limited: "⛔",
  crashed: "✖",
  idle: "·",
};

const stateGlyph = (state: string): string => STATE_GLYPHS[state] ?? "·";

const BABYSITTER_PANE_LABEL = "● babysitter";

// The babysitter's own pane: its live tmux pane id when running inside tmux,
// else the conventional bottom pane of the paired session.
const babysitterPane = (config: BabysitConfig): string =>
  process.env.TMUX_PANE ?? `${config.session}:0.2`;

// Compose a pane-border title: "<glyph> <agent> · <task>", dropping the task
// tail when no confident label exists yet.
export const composePaneTitle = (
  agent: Agent,
  state: string,
  label?: string
): string => {
  const head = `${stateGlyph(state)} ${agent}`;
  const task = label?.trim();
  return task ? `${head} · ${task}` : head;
};

// Push each agent pane's border title, skipping panes whose title is unchanged.
const applyPaneLabels = (
  config: BabysitConfig,
  deps: BabysitDeps,
  rows: AgentRow[],
  runState: BabysitRunState
): void => {
  config.agents.forEach((info, index) => {
    const row = rows[index];
    if (!row) {
      return;
    }
    const title = composePaneTitle(
      info.agent,
      rowState(row),
      runState.paneLabels[info.agent]
    );
    if (runState.paneTitles[info.pane] === title) {
      return;
    }
    runState.paneTitles[info.pane] = title;
    deps.setPaneLabel(info.pane, title);
  });
};

// The `/rename` value names the agent's session by project+session and the
// current task, e.g. "/rename harvto-loop-17 · yaw-decoupling analysis".
const renameCommand = (session: string, label: string): string =>
  `/rename ${session} · ${label}`;

// Agents actively producing output — injecting keystrokes would corrupt their
// input line (or the human's draft) and submit a turn at a bad moment, so we
// only rename when the agent is idle, mirroring the nudge gate. Limited,
// crashed, and stuck agents are also blocked: their input box does not submit,
// so injected renames pile up as queued lines (the loop-19 Codex wedge).
const RENAME_BUSY_STATES = new Set([
  "working",
  "thinking",
  "limited",
  "crashed",
  "stuck",
]);

// How many previously-sent rename commands to remember per agent. The label
// judge oscillates between near-synonym phrasings ("taper script editing" ↔
// "mesh taper script"); remembering only the last command lets an A↔B
// ping-pong re-inject forever, so we dedupe against a short history.
const RENAME_HISTORY_LIMIT = 4;

// The judge also mints NOVEL synonyms each refresh ("work queue routing" →
// "work queue staging" → "work queue documentation"), which exact-match
// history can't catch. Treat a label sharing at least this fraction of its
// tokens with a remembered label as the same task and skip the rename.
const RENAME_SIMILARITY_THRESHOLD = 0.5;

const renameLabelTokens = (command: string): Set<string> => {
  const label = command.split(" · ").slice(1).join(" · ");
  return new Set(label.toLowerCase().split(SPACE_RE).filter(Boolean));
};

const renameLabelsSimilar = (a: string, b: string): boolean => {
  const ta = renameLabelTokens(a);
  const tb = renameLabelTokens(b);
  if (ta.size === 0 || tb.size === 0) {
    return false;
  }
  let shared = 0;
  for (const token of ta) {
    if (tb.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.min(ta.size, tb.size) >= RENAME_SIMILARITY_THRESHOLD;
};

// Send the built-in `/rename` slash command into each idle agent whose task
// label changed since we last renamed it. `lastRenames` (the last command sent
// per agent) is read and updated in place so an unchanged label — e.g. a
// limited agent stuck on "session initialization" — is not re-injected every
// refresh. A busy agent is skipped WITHOUT recording, so the rename retries
// once it goes idle. Skipped in dry-run so we never inject during a rehearsal.
export const sendRenameCommands = (
  config: BabysitConfig,
  deps: BabysitDeps,
  labels: Partial<Record<Agent, string>>,
  lastRenames: Partial<Record<Agent, string>>,
  states: Partial<Record<Agent, string>> = {}
): void => {
  if (config.dryRun) {
    return;
  }
  for (const info of config.agents) {
    const label = labels[info.agent];
    if (!label) {
      continue;
    }
    if (RENAME_BUSY_STATES.has(states[info.agent] ?? "")) {
      continue;
    }
    const command = renameCommand(config.session, label);
    // The map value holds the last few sent commands newline-joined (it stays
    // a plain string so babysitter-state.json persistence is unchanged).
    const history = (lastRenames[info.agent] ?? "").split("\n").filter(Boolean);
    if (
      history.includes(command) ||
      history.some((prev) => renameLabelsSimilar(prev, command))
    ) {
      continue;
    }
    lastRenames[info.agent] = [
      ...history.slice(-(RENAME_HISTORY_LIMIT - 1)),
      command,
    ].join("\n");
    deps.sendText(info.pane, command);
    deps.sendKeys(info.pane, ["Enter"]);
  }
};

interface LimitPressure {
  key: string;
  pct: number;
  reset?: string;
  resetKind: "session" | "weekly";
}

const limitPressure = (row: AgentRow): LimitPressure | undefined => {
  const sessionPct =
    row.verdict?.state === "limited"
      ? 100
      : (row.usage.rateLimitPrimaryPct ?? 0);
  const weeklyPct = row.usage.rateLimitSecondaryPct ?? 0;
  const sessionPressure =
    sessionPct >= LIMIT_HANDOFF_PCT
      ? {
          key: `session:${row.usage.rateLimitPrimaryReset ?? "unknown"}`,
          pct: sessionPct,
          reset: row.usage.rateLimitPrimaryReset,
          resetKind: "session" as const,
        }
      : undefined;
  const weeklyPressure =
    weeklyPct >= LIMIT_HANDOFF_PCT
      ? {
          key: `weekly:${row.usage.rateLimitSecondaryReset ?? "unknown"}`,
          pct: weeklyPct,
          reset: row.usage.rateLimitSecondaryReset,
          resetKind: "weekly" as const,
        }
      : undefined;
  if (!(sessionPressure && weeklyPressure)) {
    return sessionPressure ?? weeklyPressure;
  }
  return sessionPressure.pct >= weeklyPressure.pct
    ? sessionPressure
    : weeklyPressure;
};

const isLimitPaused = (row: AgentRow): boolean =>
  limitPressure(row) !== undefined;

interface RoleBalanceCandidate {
  candidate: AgentRow;
  current: AgentRow;
  key: string;
  reasonHint: string;
}

const quotaUsedPct = (row: AgentRow): number =>
  Math.max(
    row.usage.rateLimitPrimaryPct ?? 0,
    row.usage.rateLimitSecondaryPct ?? 0
  );

const roundedQuotaBucket = (pct: number): number =>
  Math.floor(Math.max(0, pct) / 5) * 5;

const canDriveProactively = (row: AgentRow): boolean => {
  if (isLimitPaused(row)) {
    return false;
  }
  const state = rowState(row);
  return !["crashed", "limited", "stuck", "waiting-human"].includes(state);
};

const pctLabel = (value: number | undefined): string =>
  value === undefined ? "?" : `${Math.round(value)}%`;

const quotaSummary = (row: AgentRow): string =>
  `${row.liveness.agent} session ${pctLabel(row.usage.rateLimitPrimaryPct)}, weekly ${pctLabel(row.usage.rateLimitSecondaryPct)}`;

const roleBalanceCandidate = (
  rows: AgentRow[],
  currentDriver: Agent | undefined
): RoleBalanceCandidate | undefined => {
  if (!currentDriver) {
    return undefined;
  }
  const current = rows.find((row) => row.liveness.agent === currentDriver);
  if (!(current && canDriveProactively(current))) {
    return undefined;
  }
  const currentQuota = quotaUsedPct(current);
  if (currentQuota < PROACTIVE_BALANCE_PCT) {
    return undefined;
  }
  const candidates = rows
    .filter(
      (row) => row.liveness.agent !== currentDriver && canDriveProactively(row)
    )
    .map((row) => ({ row, quota: quotaUsedPct(row) }))
    .filter(
      ({ quota }) => currentQuota - quota >= PROACTIVE_BALANCE_ADVANTAGE_PCT
    )
    .sort((a, b) => a.quota - b.quota);
  const best = candidates[0];
  if (!best) {
    return undefined;
  }
  const currentBucket = roundedQuotaBucket(currentQuota);
  const candidateBucket = roundedQuotaBucket(best.quota);
  return {
    candidate: best.row,
    current,
    key: `balance:${currentDriver}->${best.row.liveness.agent}:${currentBucket}:${candidateBucket}`,
    reasonHint: `${quotaSummary(current)}; ${quotaSummary(best.row)}`,
  };
};

const roleBalanceAgentContext = (
  row: AgentRow,
  currentDriver: Agent | undefined
): RoleBalanceRequest["agents"][number] => ({
  agent: row.liveness.agent,
  contextPct: contextPct(row.usage),
  currentDriver: row.liveness.agent === currentDriver,
  recentAction: lastActionDetail(row) || undefined,
  sessionPct: row.usage.rateLimitPrimaryPct,
  sessionReset: row.usage.rateLimitPrimaryReset,
  state: rowState(row),
  weeklyPct: row.usage.rateLimitSecondaryPct,
  weeklyReset: row.usage.rateLimitSecondaryReset,
});

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

// The STATE cell: a bright "waits you" badge for waiting-human, else the
// colored state. Waiting-human is the highest-signal state — it means the
// agent is blocked on the human, not merely idle — so it stands out.
const stateCell = (state: string): string =>
  state === "waiting-human"
    ? colorCell(ANSI.yellow, "⏳ waits you", COL.state)
    : colorCell(stateColor(state), `● ${stateLabel(state)}`, COL.state);

const countCell = (count: number): string =>
  count > 0 ? fmtTokens(count) : "—";

const activityTotal = (usage: AgentUsage): number =>
  usage.textMessages + usage.thinkingMessages + usage.toolCalls;

const lastActionDetail = (row: AgentRow): string =>
  [
    row.lastAction,
    row.errors > 0 ? `(err ${row.errors})` : "",
    row.action ? `· ${row.action.level}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(SPACE_GLOBAL_RE, " ")
    .trim();

const renderRow = (row: AgentRow, meta: BoardMeta): string => {
  const agent = row.liveness.agent;
  const state = rowState(row);
  const forMs = row.thinking
    ? row.liveness.lastEventAgeMs
    : row.liveness.paneIdleMs;
  const ctxText = contextCell(row.usage);
  const ctxWarn = contextPct(row.usage) > CONTEXT_ALERT_PCT;
  const ctx = ctxWarn
    ? colorCell(ANSI.red, `${ctxText} ⚠`, COL.context)
    : fitCell(ctxText, COL.context);
  const contextTotal = tokenCell(totalContextTokens(row.usage));
  const effort = effortCell(row.usage);
  const mode = modeCell(row.usage);
  const tok = tokenCell(row.usage.totalTokens);
  const inputTok = tokenCell(row.usage.inputTokens);
  const cachedTok = tokenCell(
    row.usage.cacheReadTokens + row.usage.cacheCreateTokens
  );
  const outputTok = tokenCell(row.usage.outputTokens);
  const cost = row.usage.costUsd > 0 ? `$${row.usage.costUsd.toFixed(2)}` : "—";
  const burn = costBurnCell(row.usage, meta.stats.activeMs[agent] ?? 0);
  const rateLimit = rateLimitCell(row.usage);
  const rateLimitRendered = rateLimitColor(row.usage)
    ? colorCell(rateLimitColor(row.usage) as string, rateLimit, COL.rateLimit)
    : fitCell(rateLimit, COL.rateLimit);
  const sessionReset = sessionResetCell(
    row.usage.rateLimitPrimaryReset,
    meta.nowMs
  );
  const weeklyReset = weeklyResetCell(
    row.usage.rateLimitSecondaryReset,
    meta.nowMs
  );
  const groups = groupedToolCounts(row.usage);
  const bridgeActivity = bridgeActivityText(row, groups, meta);
  return ` ${[
    fitCell(agent, COL.agent),
    stateCell(state),
    fitCell(fmtDuration(forMs), COL.now),
    fitCell(shortModel(row.usage.model), COL.model),
    fitCell(effort, COL.effort),
    fitCell(mode, COL.mode),
    ctx,
    fitCell(contextTotal, COL.contextTotal),
    fitCell(String(row.usage.compactions), COL.compact),
    rateLimitRendered,
    fitCell(sessionReset, COL.resetSession),
    fitCell(weeklyReset, COL.resetWeekly),
    fitCell(cost, COL.cost),
    fitCell(burn, COL.costRate),
    fitCell(tok, COL.tokens),
    fitCell(inputTok, COL.input),
    fitCell(cachedTok, COL.cache),
    fitCell(outputTok, COL.output),
    renderToolCountCell(countCell(activityTotal(row.usage)), COL.activity),
    renderToolCountCell(countCell(row.usage.textMessages), COL.text),
    renderToolCountCell(countCell(row.usage.thinkingMessages), COL.thinking),
    renderToolCountCell(countCell(row.usage.toolCalls), COL.tools),
    renderToolCountCell(toolCountText(groups.exec), COL.exec),
    renderToolCountCell(toolCountText(groups.code), COL.code),
    renderToolCountCell(toolCountText(groups.inspect), COL.inspect),
    renderToolCountCell(toolCountText(groups.plan), COL.plan),
    renderToolCountCell(toolCountText(groups.other), COL.other),
    renderToolCountCell(bridgeActivity, COL.bridge),
  ].join(" ")}`;
};

const localLlmUsageCells = (usage: LocalLlmUsage): string[] => {
  const calls =
    usage.calls > 0
      ? `${usage.calls} calls`
      : usage.totalTokens > 0
        ? "? calls"
        : "0 calls";
  const tokenText = `${fmtTokens(usage.totalTokens)} tok`;
  if (usage.inputTokens === 0 && usage.outputTokens === 0) {
    return [`llm ${calls}`, tokenText];
  }
  const splitTokens = usage.inputTokens + usage.outputTokens;
  const unsplitTokens = Math.max(0, usage.totalTokens - splitTokens);
  const splitParts = [
    `${fmtTokens(usage.inputTokens)} in`,
    `${fmtTokens(usage.outputTokens)} out`,
    ...(unsplitTokens > 0 ? [`${fmtTokens(unsplitTokens)} unsplit`] : []),
  ];
  return [`llm ${calls}`, `${tokenText} (${splitParts.join(" / ")})`];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readBabysitterMessageCountsFromLog = (
  logFile: string
): Record<string, number> => {
  const counts: Record<string, number> = {};
  try {
    for (const line of readFileSync(logFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const kind = parsed.kind;
      if (kind === "limit-handoff") {
        const driver = readAgentValue(parsed.driver);
        if (driver) {
          incrementCount(counts, driver);
        }
        continue;
      }
      if (kind === "limit-restore") {
        const restored = readAgentValue(parsed.restored);
        const previous = readAgentValue(parsed.previousDriver);
        if (restored) {
          incrementCount(counts, restored);
        }
        if (previous && previous !== restored) {
          incrementCount(counts, previous);
        }
        continue;
      }
      if (
        kind === "action" &&
        parsed.dryRun !== true &&
        parsed.level === "nudge"
      ) {
        const agent = readAgentValue(parsed.agent);
        if (agent) {
          incrementCount(counts, agent);
        }
      }
    }
  } catch {
    return {};
  }
  return counts;
};

const recordAt = (
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

const numberAt = (
  record: Record<string, unknown>,
  key: string
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const stringAt = (
  record: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const PROMPT_CACHE_RE = /Prompt Cache:\s+(\d+)\s+sequences?,\s+([\d.]+)\s+GB/i;
const PROMPT_CACHE_ROLE_RE =
  /-\s+([a-z]+):\s+\d+\s+sequences?,\s+([\d.]+)\s+GB/i;
const KV_CACHE_RE = /KV Caches?:\s+(\d+)\s+seq(?:uences?)?,\s+([\d.]+)\s+GB/i;

const readLocalLlmTraceUsage = (
  traceFile: string | undefined,
  model?: string
): Pick<LocalLlmRuntime, "cachedPromptTokens" | "promptTokens"> => {
  if (!traceFile) {
    return {};
  }
  let text = "";
  try {
    text = readFileSync(traceFile, "utf8");
  } catch {
    return {};
  }
  let cachedPromptTokens = 0;
  let promptTokens = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.direction !== "from-mlx") {
      continue;
    }
    if (model && parsed.model !== model) {
      continue;
    }
    const response = recordAt(parsed, "response");
    const usage = response ? recordAt(response, "usage") : undefined;
    if (!usage) {
      continue;
    }
    promptTokens += numberAt(usage, "prompt_tokens") ?? 0;
    const details = recordAt(usage, "prompt_tokens_details");
    cachedPromptTokens += details
      ? (numberAt(details, "cached_tokens") ?? 0)
      : 0;
  }
  return {
    cachedPromptTokens,
    promptTokens,
  };
};

const modelCacheDirName = (model: string): string =>
  `models--${model.replaceAll("/", "--")}`;

const readLocalLlmModelInfo = (
  model: string,
  home: string | undefined
): LocalLlmModelInfo | undefined => {
  const modelDir = join(
    home ?? homedir(),
    ".cache",
    "huggingface",
    "hub",
    modelCacheDirName(model)
  );
  const refFile = join(modelDir, "refs", "main");
  let snapshot = "";
  try {
    snapshot = readFileSync(refFile, "utf8").trim();
  } catch {
    return undefined;
  }
  const configFile = join(modelDir, "snapshots", snapshot, "config.json");
  if (!existsSync(configFile)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const textConfig = recordAt(parsed, "text_config") ?? parsed;
  const quant = recordAt(parsed, "quantization");
  return {
    attentionHeads: numberAt(textConfig, "num_attention_heads"),
    contextTokens: numberAt(textConfig, "max_position_embeddings"),
    dtype: stringAt(textConfig, "dtype") ?? stringAt(textConfig, "torch_dtype"),
    fullAttentionInterval: numberAt(textConfig, "full_attention_interval"),
    headDim: numberAt(textConfig, "head_dim"),
    hiddenSize: numberAt(textConfig, "hidden_size"),
    kvHeads: numberAt(textConfig, "num_key_value_heads"),
    layers: numberAt(textConfig, "num_hidden_layers"),
    modelType:
      stringAt(textConfig, "model_type") ?? stringAt(parsed, "model_type"),
    moeActiveExperts: numberAt(textConfig, "num_experts_per_tok"),
    moeExperts: numberAt(textConfig, "num_experts"),
    quantBits: quant ? numberAt(quant, "bits") : undefined,
    quantGroupSize: quant ? numberAt(quant, "group_size") : undefined,
    quantMode: quant ? stringAt(quant, "mode") : undefined,
  };
};

const readLocalLlmRuntime = (input: LocalLlmRuntimeInput): LocalLlmRuntime => {
  const traceUsage = readLocalLlmTraceUsage(input.traceFile, input.model);
  const base: LocalLlmRuntime = {
    decodeConcurrency: input.decodeConcurrency,
    modelInfo: readLocalLlmModelInfo(input.model, input.home),
    prefillStepSize: input.prefillStepSize,
    promptCacheMaxSequences: input.promptCacheMaxSequences,
    promptConcurrency: input.promptConcurrency,
    ...traceUsage,
  };
  const { logFile } = input;
  if (!logFile) {
    return base;
  }
  let text = "";
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return base;
  }
  let runtime = base;
  for (const line of text.split("\n")) {
    const promptCache = line.match(PROMPT_CACHE_RE);
    if (promptCache) {
      runtime = {
        ...runtime,
        promptCacheGb: Number.parseFloat(promptCache[2] ?? ""),
        promptCacheRoles: {},
        promptCacheSequences: Number.parseInt(promptCache[1] ?? "", 10),
      };
      continue;
    }
    const role = line.match(PROMPT_CACHE_ROLE_RE);
    if (role && runtime.promptCacheRoles) {
      runtime.promptCacheRoles[role[1] ?? ""] = Number.parseFloat(
        role[2] ?? ""
      );
      continue;
    }
    const kvCache = line.match(KV_CACHE_RE);
    if (kvCache) {
      runtime = {
        ...runtime,
        kvCacheGb: Number.parseFloat(kvCache[2] ?? ""),
        kvCacheSequences: Number.parseInt(kvCache[1] ?? "", 10),
      };
    }
  }
  return runtime;
};

const pct = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;

const localLlmRuntimeCell = (
  runtime: LocalLlmRuntime | undefined,
  usage: LocalLlmUsage
): string[] => {
  const parts: string[] = [];
  const promptTokens = runtime?.promptTokens ?? usage.inputTokens;
  const cachedPromptTokens =
    runtime?.cachedPromptTokens ?? usage.cachedInputTokens;
  if (promptTokens > 0) {
    parts.push(
      `cache hit ${pct(cachedPromptTokens, promptTokens)}% (${fmtTokens(
        cachedPromptTokens
      )}/${fmtTokens(promptTokens)})`
    );
  } else {
    parts.push("cache hit —");
  }
  if (
    runtime?.promptCacheGb !== undefined &&
    runtime.promptCacheSequences !== undefined
  ) {
    const maxSequences = runtime.promptCacheMaxSequences;
    const slotText =
      maxSequences && maxSequences > 0
        ? `slots ${runtime.promptCacheSequences}/${maxSequences} ${pct(
            runtime.promptCacheSequences,
            maxSequences
          )}%`
        : `slots ${runtime.promptCacheSequences}`;
    parts.push(slotText);
  } else {
    parts.push("slots —");
  }
  const promptCacheGb = runtime?.promptCacheGb;
  const kvCacheGb = runtime?.kvCacheGb;
  if (promptCacheGb !== undefined || kvCacheGb !== undefined) {
    const memoryParts = [
      promptCacheGb === undefined ? "" : `${fmtGb(promptCacheGb)} prompt`,
      kvCacheGb === undefined ? "" : `${fmtGb(kvCacheGb)} kv`,
    ].filter(Boolean);
    const totalGb = (promptCacheGb ?? 0) + (kvCacheGb ?? 0);
    const sequences =
      runtime?.promptCacheSequences ?? runtime?.kvCacheSequences;
    const perSeq =
      sequences && sequences > 0 ? ` (${fmtGb(totalGb / sequences)}/seq)` : "";
    parts.push(
      `cache mem ${memoryParts.join(" + ")} = ${fmtGb(totalGb)}${perSeq}`
    );
  } else {
    parts.push("cache mem —");
  }
  return parts;
};

const localLlmModelCell = (runtime: LocalLlmRuntime | undefined): string[] => {
  const info = runtime?.modelInfo;
  if (!info) {
    return [];
  }
  const kv =
    info.kvHeads !== undefined && info.headDim !== undefined
      ? `kv ${info.kvHeads}x${info.headDim}`
      : undefined;
  const archParts = [
    info.layers === undefined ? "" : `${info.layers}L`,
    info.hiddenSize === undefined ? "" : `h${info.hiddenSize}`,
    info.attentionHeads === undefined ? "" : `attn ${info.attentionHeads}`,
    kv ?? "",
    info.contextTokens === undefined
      ? ""
      : `ctx ${fmtTokens(info.contextTokens)}`,
    info.fullAttentionInterval === undefined
      ? ""
      : `full attn/${info.fullAttentionInterval}`,
  ].filter(Boolean);
  const implParts = [
    info.dtype ? `dtype ${info.dtype.replace("bfloat16", "bf16")}` : "",
    info.quantBits === undefined
      ? ""
      : `weights q${info.quantBits}${
          info.quantGroupSize === undefined ? "" : `/g${info.quantGroupSize}`
        }${info.quantMode ? ` ${info.quantMode}` : ""}`,
    info.moeExperts === undefined
      ? ""
      : `moe ${info.moeExperts}e${
          info.moeActiveExperts === undefined
            ? ""
            : `/${info.moeActiveExperts} active`
        }`,
  ].filter(Boolean);
  const batchParts = [
    runtime?.promptConcurrency === undefined
      ? ""
      : `prefill ${runtime.promptConcurrency}`,
    runtime?.decodeConcurrency === undefined
      ? ""
      : `decode ${runtime.decodeConcurrency}`,
    runtime?.prefillStepSize === undefined
      ? ""
      : `step ${runtime.prefillStepSize}`,
  ].filter(Boolean);
  return [
    ...(archParts.length > 0 ? [`model ${archParts.join(" ")}`] : []),
    ...(implParts.length > 0 ? [implParts.join(" · ")] : []),
    ...(batchParts.length > 0 ? [`batch ${batchParts.join(" · ")}`] : []),
  ];
};

const localLlmParamsCell = (judgeMode: LocalLlmJudgeMode): string[] => [
  `judge ${judgeMode}`,
  `temp ${LOCAL_LLM_TEMPERATURE}`,
  LOCAL_LLM_JUDGE_MAX_TOKENS === LOCAL_LLM_WAITING_MAX_TOKENS
    ? `max out ${fmtTokenLimit(
        LOCAL_LLM_JUDGE_MAX_TOKENS
      )} judge+wait / ${fmtTokenLimit(LOCAL_LLM_SUMMARY_MAX_TOKENS)} summary`
    : `max out ${fmtTokenLimit(LOCAL_LLM_JUDGE_MAX_TOKENS)} judge / ${fmtTokenLimit(
        LOCAL_LLM_WAITING_MAX_TOKENS
      )} wait / ${fmtTokenLimit(LOCAL_LLM_SUMMARY_MAX_TOKENS)} summary`,
];

// The cost cell, with a budget fraction when a budget is set (colored as it
// crosses the 80% warn line and the 100% ceiling).
const costCell = (
  totalCost: number,
  perHr: number,
  budgetUsd: number
): string => {
  const spend = `$${totalCost.toFixed(2)}`;
  const rate = perHr > 0 ? ` ($${perHr.toFixed(0)}/hr)` : "";
  if (budgetUsd <= 0) {
    return `Σ ${spend}${rate}`;
  }
  const fraction = totalCost / budgetUsd;
  const pct = Math.round(fraction * 100);
  const text = `Σ ${spend}/$${budgetUsd.toFixed(0)} ${pct}%${rate}`;
  if (fraction >= 1) {
    return paint(ANSI.red, `${text} ⛔`);
  }
  if (fraction >= BUDGET_WARN_FRACTION) {
    return paint(ANSI.yellow, `${text} ⚠`);
  }
  return text;
};

// Loud top-line alert once the local LLM confirms the idle pair needs you,
// quoting what it says they need.
const waitingForYouAlert = (waiting: WaitingForYou): string[] => {
  if (!waiting.confirmed) {
    return [];
  }
  const asked = waiting.ask ? ` — ${waiting.ask}` : "";
  return [
    paint(ANSI.yellow, `❗ waiting for you ${fmtDuration(waiting.ms)}${asked}`),
  ];
};

const renderBabysitterMessageCounts = (
  rows: AgentRow[],
  counts: Record<string, number>
): string | undefined => {
  if (rows.length === 0) {
    return undefined;
  }
  const parts = rows.map(
    (row) => `${row.liveness.agent} ${counts[row.liveness.agent] ?? 0}`
  );
  return paint(ANSI.dim, `msgs ${parts.join(" ")}`);
};

const renderSummaryLine = (rows: AgentRow[], meta: BoardMeta): string => {
  const totalCost = rows.reduce((sum, r) => sum + r.usage.costUsd, 0);
  const perHr =
    meta.uptimeMs > 0 ? totalCost / (meta.uptimeMs / MS_PER_HOUR) : 0;
  const errorTotal = rows.reduce((sum, r) => sum + r.errors, 0);
  const messageCounts = renderBabysitterMessageCounts(
    rows,
    meta.babysitterMessages
  );
  const parts = [
    paint(ANSI.cyan, "babysitter"),
    fmtClock(meta.nowMs),
    ...(Number.isFinite(meta.uptimeMs)
      ? [`wall ${fmtDuration(meta.uptimeMs)}`]
      : []),
    costCell(totalCost, perHr, meta.budgetUsd),
    `both idle total ${fmtDuration(meta.stats.humanIdleMs)}`,
    ...(messageCounts ? [messageCounts] : []),
    ...roleSummaryParts(meta),
    ...(errorTotal > 0 ? [paint(ANSI.red, `errors ${errorTotal}`)] : []),
    ...waitingForYouAlert(meta.waitingForYou),
  ];
  return ` ${parts.join(" · ")}`;
};

const SUMMARY_LINE_WIDTH = 180;
const SUMMARY_PROJECT_WIDTH = Math.floor(SUMMARY_LINE_WIDTH / 2);
const SUMMARY_TOTAL_LINES = 8;
const SUMMARY_LABEL_RE = /^(project|objective|progress|next)\s*:\s*/i;
const SPACE_RE = /\s+/;
const SPACE_GLOBAL_RE = /\s+/g;
const BRIDGE_LATEST_WIDTH = 76;

const bridgeLatestFor = (
  latest: BridgeLatest,
  source: Agent,
  target: Agent
): BridgeMessage | undefined => latest[source]?.[target];

const bridgeAgentColor = (agent: string): string =>
  agent === "claude"
    ? ANSI.magenta
    : agent === "codex"
      ? ANSI.cyan
      : ANSI.green;

const renderBridgeDirection = (source: string, target: string): string =>
  [
    paint(bridgeAgentColor(source), source),
    paint(ANSI.dim, "→"),
    paint(bridgeAgentColor(target), target),
  ].join("");

const agentLatestSegment = (
  row: AgentRow | undefined,
  prefix: string
): string | undefined => {
  if (!row) {
    return undefined;
  }
  const text = truncate(lastActionDetail(row), BRIDGE_LATEST_WIDTH);
  if (!text || text === "—") {
    return undefined;
  }
  const ageMs = row.thinking
    ? row.liveness.lastEventAgeMs
    : row.liveness.paneIdleMs;
  return [
    paint(ANSI.dim, prefix),
    paint(bridgeAgentColor(row.liveness.agent), row.liveness.agent),
    " ",
    paint(ANSI.yellow, fmtDuration(ageMs)),
    paint(ANSI.dim, `: ${text}`),
  ].join("");
};

const renderBridgeMessage = (
  message: BridgeMessage | undefined,
  meta: BoardMeta,
  row?: AgentRow
): string | undefined => {
  const action = agentLatestSegment(row, " · ");
  if (!message) {
    const standaloneAction = agentLatestSegment(row, "");
    return standaloneAction
      ? [paint(ANSI.dim, " bridge latest · "), standaloneAction].join("")
      : undefined;
  }
  const ageMs = meta.nowMs - Date.parse(message.at);
  const age = Number.isFinite(ageMs) ? `${fmtDuration(ageMs)} ago` : "latest";
  const text = truncate(
    message.message.replace(SPACE_GLOBAL_RE, " ").trim(),
    BRIDGE_LATEST_WIDTH
  );
  return [
    paint(ANSI.dim, " bridge latest · "),
    renderBridgeDirection(message.source, message.target),
    " ",
    paint(ANSI.yellow, age),
    paint(ANSI.dim, `: ${text}`),
    action ?? "",
  ].join("");
};

const renderBridgeLatestLine = (
  rows: AgentRow[],
  meta: BoardMeta
): string[] => {
  const [left, right] = rows.map((row) => row.liveness.agent);
  const rowFor = (agent: Agent | undefined): AgentRow | undefined =>
    agent ? rows.find((row) => row.liveness.agent === agent) : undefined;
  if (!(left && right)) {
    return rows
      .map((row) => renderBridgeMessage(undefined, meta, row))
      .filter((part): part is string => Boolean(part));
  }
  const parts = [
    renderBridgeMessage(
      bridgeLatestFor(meta.bridgeLatest, left, right),
      meta,
      rowFor(left)
    ),
    renderBridgeMessage(
      bridgeLatestFor(meta.bridgeLatest, right, left),
      meta,
      rowFor(right)
    ),
  ].filter((part): part is string => Boolean(part));
  return parts;
};

const roleActionAge = (
  actionAt: string | undefined,
  nowMs: number
): string | undefined => {
  if (!actionAt) {
    return undefined;
  }
  const parsed = Date.parse(actionAt);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return fmtDuration(nowMs - parsed);
};

const roleSummaryParts = (meta: BoardMeta): string[] => {
  const initial = meta.roles.initialDriver ?? meta.initialDriver;
  const current = meta.roles.currentDriver ?? initial;
  const balanceAge = roleActionAge(meta.roles.balanceAt, meta.nowMs);
  const handoffAge = roleActionAge(meta.roles.handoffAt, meta.nowMs);
  const restoredAge = roleActionAge(meta.roles.restoredAt, meta.nowMs);
  if (!(initial || current || meta.roles.pausedAgent)) {
    return [];
  }
  const parts = [
    "roles",
    initial ? `initial ${initial}` : "",
    current ? `current ${current}` : "",
    meta.roles.pausedAgent ? `paused ${meta.roles.pausedAgent}` : "",
    meta.roles.pausedAgent && meta.roles.reset
      ? `reset ${sessionResetCell(meta.roles.reset, meta.nowMs)}`
      : "",
    meta.roles.lastAction === "handoff" && handoffAge
      ? `handoff ${handoffAge} ago`
      : "",
    meta.roles.lastAction === "balance" && balanceAge
      ? `balance ${balanceAge} ago`
      : "",
    meta.roles.lastAction === "restore" && restoredAge
      ? `restored ${restoredAge} ago`
      : "",
  ].filter(Boolean);
  return [paint(ANSI.dim, parts.join(" · "))];
};

interface ToolGroups {
  bridgeRecv: number;
  bridgeSend: number;
  bridgeStatus: number;
  code: number;
  exec: number;
  inspect: number;
  other: number;
  plan: number;
}

const emptyToolGroups = (): ToolGroups => ({
  bridgeRecv: 0,
  bridgeSend: 0,
  bridgeStatus: 0,
  code: 0,
  exec: 0,
  inspect: 0,
  other: 0,
  plan: 0,
});

const isBridgeSendTool = (name: string): boolean =>
  name === "send_message" || /^mcp__loop-bridge-.+__send_message$/.test(name);

const isBridgeRecvTool = (name: string): boolean =>
  name === "receive_messages" ||
  /^mcp__loop-bridge-.+__receive_messages$/.test(name);

const addToolGroup = (
  groups: ToolGroups,
  name: string,
  count: number
): void => {
  if (name === "exec_command" || name === "Bash" || name === "write_stdin") {
    groups.exec += count;
  } else if (name === "apply_patch" || name === "Edit") {
    groups.code += count;
  } else if (
    name === "Read" ||
    name === "SendUserFile" ||
    name === "view_image"
  ) {
    groups.inspect += count;
  } else if (
    name === "AskUserQuestion" ||
    name === "Skill" ||
    name === "tool_search" ||
    name === "update_plan" ||
    name === "_create_pull_request" ||
    name === "create_pull_request"
  ) {
    groups.plan += count;
  } else if (isBridgeSendTool(name)) {
    groups.bridgeSend += count;
  } else if (isBridgeRecvTool(name)) {
    groups.bridgeRecv += count;
  } else if (name === "bridge_status") {
    groups.bridgeStatus += count;
  } else {
    groups.other += count;
  }
};

const groupedToolCounts = (usage: AgentUsage): ToolGroups => {
  const groups = emptyToolGroups();
  let counted = 0;
  for (const [name, count] of Object.entries(usage.toolCallCounts ?? {})) {
    if (count <= 0) {
      continue;
    }
    counted += count;
    addToolGroup(groups, name, count);
  }
  if (usage.toolCalls > counted) {
    groups.other += usage.toolCalls - counted;
  }
  return groups;
};

const toolCountText = (count: number): string =>
  count > 0 ? fmtTokens(count) : "—";

const renderToolCountCell = (text: string, width: number): string =>
  text === "—"
    ? paint(ANSI.dim, fitCell(text, width))
    : paint(ANSI.yellow, fitCell(text, width));

const bridgeToolText = (groups: ToolGroups): string => {
  const parts = [];
  if (groups.bridgeSend > 0) {
    parts.push(`→${fmtTokens(groups.bridgeSend)}`);
  }
  if (groups.bridgeRecv > 0) {
    parts.push(`←${fmtTokens(groups.bridgeRecv)}`);
  }
  if (groups.bridgeStatus > 0) {
    parts.push(`+${fmtTokens(groups.bridgeStatus)}`);
  }
  return parts.join(" ") || "—";
};

const bridgeActivityText = (
  row: AgentRow,
  groups: ToolGroups,
  meta: BoardMeta
): string => {
  const bridge = bridgeFor(row.liveness.agent, meta.bridge);
  const parts = [];
  const humanPrompts = row.usage.humanMessages;
  if (humanPrompts > 0) {
    parts.push(`human ${fmtTokens(humanPrompts)}`);
  }
  if (bridge.sent > 0 || bridge.recv > 0) {
    parts.push(`→${fmtTokens(bridge.sent)}`, `←${fmtTokens(bridge.recv)}`);
  }
  const bridgeTools = bridgeToolText(groups);
  if (bridgeTools !== "—") {
    parts.push(`T${bridgeTools}`);
  }
  return parts.join(" ") || "—";
};

interface LocalFooterPart {
  color: string;
  text: string;
}

const renderLocalFooterLine = (parts: LocalFooterPart[]): string =>
  ` ${parts
    .map((part) => paint(part.color, part.text))
    .join(paint(ANSI.dim, " · "))}`;

const localFooterKnownColor = (text: string, color: string): string =>
  text.includes("—") ? ANSI.dim : color;

const LLM_COL = {
  arch: 34,
  batch: 18,
  cached: 7,
  calls: 5,
  dtype: 5,
  hit: 7,
  id: 7,
  input: 7,
  memory: 8,
  model: 34,
  moe: 9,
  output: 7,
  quant: 13,
  slots: 8,
  status: 5,
  tokens: 7,
} as const;

const LLM_COLUMNS: [string, number][] = [
  ["LLM", LLM_COL.id],
  ["MODEL", LLM_COL.model],
  ["STAT", LLM_COL.status],
  ["CALLS", LLM_COL.calls],
  ["TOK", LLM_COL.tokens],
  ["IN", LLM_COL.input],
  ["CACHE", LLM_COL.cached],
  ["OUT", LLM_COL.output],
  ["HIT", LLM_COL.hit],
  ["SLOTS", LLM_COL.slots],
  ["MEM", LLM_COL.memory],
  ["ARCH", LLM_COL.arch],
  ["DT", LLM_COL.dtype],
  ["QNT", LLM_COL.quant],
  ["MOE", LLM_COL.moe],
  ["BATCH", LLM_COL.batch],
];

const localLlmTableHeader = (): string =>
  paint(
    ANSI.dim,
    ` ${LLM_COLUMNS.map(([label, width]) => cell(label, width)).join(" ")}`
  );

const localLlmModelLabel = (judge: LocalLlmJudgeConfig): string => {
  const size = judge.modelSizeGb ? ` (${judge.modelSizeGb.toFixed(0)}GB)` : "";
  return `${shortLocalModel(judge.model)}${size}`;
};

const localLlmCacheHit = (
  runtime: LocalLlmRuntime | undefined,
  usage: LocalLlmUsage
): string => {
  const promptTokens = runtime?.promptTokens ?? usage.inputTokens;
  const cachedPromptTokens =
    runtime?.cachedPromptTokens ?? usage.cachedInputTokens;
  return promptTokens > 0 ? `${pct(cachedPromptTokens, promptTokens)}%` : "—";
};

const localLlmSlots = (runtime: LocalLlmRuntime | undefined): string => {
  const sequences = runtime?.promptCacheSequences;
  if (sequences === undefined) {
    return "—";
  }
  const maxSequences = runtime?.promptCacheMaxSequences;
  return maxSequences && maxSequences > 0
    ? `${sequences}/${maxSequences}`
    : String(sequences);
};

const localLlmMemory = (runtime: LocalLlmRuntime | undefined): string => {
  const promptCacheGb = runtime?.promptCacheGb;
  const kvCacheGb = runtime?.kvCacheGb;
  if (promptCacheGb === undefined && kvCacheGb === undefined) {
    return "—";
  }
  return fmtGb((promptCacheGb ?? 0) + (kvCacheGb ?? 0));
};

const localLlmArch = (runtime: LocalLlmRuntime | undefined): string => {
  const info = runtime?.modelInfo;
  if (!info) {
    return "—";
  }
  const parts = [
    info.layers === undefined ? "" : `${info.layers}L`,
    info.hiddenSize === undefined ? "" : `h${info.hiddenSize}`,
    info.attentionHeads === undefined ? "" : `a${info.attentionHeads}`,
    info.kvHeads !== undefined && info.headDim !== undefined
      ? `kv${info.kvHeads}x${info.headDim}`
      : "",
    info.contextTokens === undefined
      ? ""
      : `ctx${fmtTokens(info.contextTokens)}`,
    info.fullAttentionInterval === undefined
      ? ""
      : `f/${info.fullAttentionInterval}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "—";
};

const localLlmDtype = (runtime: LocalLlmRuntime | undefined): string =>
  runtime?.modelInfo?.dtype?.replace("bfloat16", "bf16") ?? "—";

const localLlmQuant = (runtime: LocalLlmRuntime | undefined): string => {
  const info = runtime?.modelInfo;
  if (!info || info.quantBits === undefined) {
    return "—";
  }
  return `q${info.quantBits}${
    info.quantGroupSize === undefined ? "" : `/g${info.quantGroupSize}`
  }${info.quantMode ? ` ${info.quantMode}` : ""}`;
};

const localLlmMoe = (runtime: LocalLlmRuntime | undefined): string => {
  const info = runtime?.modelInfo;
  if (!info || info.moeExperts === undefined) {
    return "—";
  }
  return `${info.moeExperts}e${
    info.moeActiveExperts === undefined ? "" : `/${info.moeActiveExperts}`
  }`;
};

const localLlmBatch = (runtime: LocalLlmRuntime | undefined): string => {
  const parts = [
    runtime?.promptConcurrency === undefined
      ? ""
      : `pre${runtime.promptConcurrency}`,
    runtime?.decodeConcurrency === undefined
      ? ""
      : `dec${runtime.decodeConcurrency}`,
    runtime?.prefillStepSize === undefined
      ? ""
      : `st${runtime.prefillStepSize}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "—";
};

const renderLocalLlmUsageRow = (
  judge: LocalLlmJudgeConfig,
  meta: BoardMeta
): string => {
  const usage = meta.llmUsageByJudge[judge.id] ?? emptyLocalLlmUsage();
  const runtime = meta.llmRuntimeByJudge[judge.id];
  const offline = meta.llmOfflineByJudge[judge.id] === true;
  return ` ${[
    colorCell(offline ? ANSI.red : ANSI.cyan, judge.id, LLM_COL.id),
    colorCell(ANSI.cyan, localLlmModelLabel(judge), LLM_COL.model),
    colorCell(
      offline ? ANSI.red : ANSI.green,
      offline ? "off" : "ok",
      LLM_COL.status
    ),
    colorCell(
      ANSI.green,
      usage.calls > 0 ? String(usage.calls) : "0",
      LLM_COL.calls
    ),
    colorCell(ANSI.yellow, tokenCell(usage.totalTokens), LLM_COL.tokens),
    colorCell(ANSI.yellow, tokenCell(usage.inputTokens), LLM_COL.input),
    colorCell(ANSI.yellow, tokenCell(usage.cachedInputTokens), LLM_COL.cached),
    colorCell(ANSI.yellow, tokenCell(usage.outputTokens), LLM_COL.output),
    colorCell(
      localFooterKnownColor(localLlmCacheHit(runtime, usage), ANSI.green),
      localLlmCacheHit(runtime, usage),
      LLM_COL.hit
    ),
    colorCell(
      localFooterKnownColor(localLlmSlots(runtime), ANSI.cyan),
      localLlmSlots(runtime),
      LLM_COL.slots
    ),
    colorCell(
      localFooterKnownColor(localLlmMemory(runtime), ANSI.magenta),
      localLlmMemory(runtime),
      LLM_COL.memory
    ),
    colorCell(
      localFooterKnownColor(localLlmArch(runtime), ANSI.cyan),
      localLlmArch(runtime),
      LLM_COL.arch
    ),
    colorCell(
      localFooterKnownColor(localLlmDtype(runtime), ANSI.magenta),
      localLlmDtype(runtime),
      LLM_COL.dtype
    ),
    colorCell(
      localFooterKnownColor(localLlmQuant(runtime), ANSI.magenta),
      localLlmQuant(runtime),
      LLM_COL.quant
    ),
    colorCell(
      localFooterKnownColor(localLlmMoe(runtime), ANSI.magenta),
      localLlmMoe(runtime),
      LLM_COL.moe
    ),
    colorCell(
      localFooterKnownColor(localLlmBatch(runtime), ANSI.blue),
      localLlmBatch(runtime),
      LLM_COL.batch
    ),
  ].join(" ")}`;
};

const markTruncated = (line: string, width: number): string => {
  if (width <= 3) {
    return ".".repeat(Math.max(0, width));
  }
  if (line.length + 3 <= width) {
    return `${line}...`;
  }
  return `${line.slice(0, width - 3)}...`;
};

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
        lines[lines.length - 1] = markTruncated(lines[lines.length - 1], width);
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
  const paramCells = localLlmParamsCell(meta.judgeMode);
  const paramParts: LocalFooterPart[] = [
    { color: ANSI.blue, text: "llm params" },
    ...paramCells.map((text) => ({ color: ANSI.blue, text })),
  ];
  const lines = [
    localLlmTableHeader(),
    ...meta.llmJudges.map((judge) => renderLocalLlmUsageRow(judge, meta)),
    renderLocalFooterLine(paramParts),
  ];
  const summaryLines = renderSummaryBody(meta.summary);
  if (summaryLines.length > 0) {
    lines.push(paint(ANSI.dim, " ── summary ──"));
    lines.push(...summaryLines);
  }
  return lines;
};

// Render the structured summary, preserving its section lines (Project /
// Objective / Progress / Next), wrapping long ones and capping total height.
const summaryLineBudget = (
  line: string
): { maxLines: number; width: number } => {
  const label = line.match(SUMMARY_LABEL_RE)?.[1]?.toLowerCase();
  if (label === "project") {
    return { maxLines: 1, width: SUMMARY_PROJECT_WIDTH };
  }
  if (label === "objective") {
    return { maxLines: 2, width: SUMMARY_LINE_WIDTH };
  }
  if (label === "progress") {
    return { maxLines: 3, width: SUMMARY_LINE_WIDTH };
  }
  if (label === "next") {
    return { maxLines: 2, width: SUMMARY_LINE_WIDTH };
  }
  return { maxLines: 1, width: SUMMARY_LINE_WIDTH };
};

const renderSummaryBody = (summary: string): string[] => {
  const source = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const line of source) {
    const isLabel = SUMMARY_LABEL_RE.test(line);
    const budget = summaryLineBudget(line);
    const wrapped = wrapText(line, budget.width, budget.maxLines);
    for (const [i, text] of wrapped.entries()) {
      if (out.length >= SUMMARY_TOTAL_LINES) {
        return out;
      }
      // Keep the body subdued and only color the structured label.
      const rendered =
        isLabel && i === 0
          ? renderSummaryLabelLine(text)
          : paint(ANSI.dim, `     ${text}`);
      out.push(rendered);
    }
  }
  return out;
};

const renderSummaryLabelLine = (text: string): string => {
  const match = text.match(SUMMARY_LABEL_RE);
  if (!match) {
    return paint(ANSI.dim, `   ${text}`);
  }
  const label = match[0].trimEnd();
  const rest = text.slice(match[0].length);
  return `   ${paint(ANSI.cyan, label)}${rest ? paint(ANSI.dim, ` ${rest}`) : ""}`;
};

const renderBoard = (rows: AgentRow[], meta: BoardMeta): string => {
  return [
    renderSummaryLine(rows, meta),
    headerRow,
    ...rows.map((row) => renderRow(row, meta)),
    ...renderBridgeLatestLine(rows, meta),
    ...renderFooter(meta),
  ].join("\n");
};

interface AgentTickContext {
  history: RecoveryHistoryEntry[];
  nowIso: string;
  nowMs: number;
  recoveries: number;
  tick: number;
  usageLimits?: UsageLimitSnapshot;
}

const SUMMARY_ACTIONS = 24;

interface AgentTickResult {
  history: RecoveryHistoryEntry[];
  llmOffline: boolean;
  llmOfflineByJudge: Record<string, boolean>;
  llmUsage: LocalLlmUsage;
  llmUsageByJudge: LocalLlmUsageByJudge;
  recoveries: number;
  row: AgentRow;
  summaryCtx: SummaryAgentContext;
}

interface LocalJudgeResult {
  judge: LocalLlmJudgeConfig;
  outcome: JudgeOutcome;
}

interface ConsensusJudgeResult {
  llmOffline: boolean;
  llmOfflineByJudge: Record<string, boolean>;
  outcome: JudgeOutcome;
  usage: LocalLlmUsage;
  usageByJudge: LocalLlmUsageByJudge;
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

const conservativeVerdict = (summary: string): BabysitterVerdict => ({
  confidence: 0,
  state: "working",
  summary: truncate(summary, JUDGE_SUMMARY_MAX),
});

const outcomeUsage = (outcome: JudgeOutcome): LocalLlmUsage =>
  outcome.usage ?? localLlmUsageFromTokens(outcome.tokens ?? 0);

const judgeStateSummary = (result: LocalJudgeResult): string =>
  result.outcome.ok
    ? `${result.judge.id}:${result.outcome.verdict.state}`
    : `${result.judge.id}:${result.outcome.reason}`;

const consensusJudgeResult = (
  results: LocalJudgeResult[]
): ConsensusJudgeResult => {
  const usageByJudge: LocalLlmUsageByJudge = {};
  const llmOfflineByJudge: Record<string, boolean> = {};
  for (const result of results) {
    usageByJudge[result.judge.id] = outcomeUsage(result.outcome);
    llmOfflineByJudge[result.judge.id] =
      !result.outcome.ok && result.outcome.reason === "unreachable";
  }
  const usage = sumLocalLlmUsageByJudge(usageByJudge);
  const llmOffline = Object.values(llmOfflineByJudge).some(Boolean);
  if (results.length === 1) {
    return {
      llmOffline,
      llmOfflineByJudge,
      outcome: results[0]?.outcome ?? {
        fallback: conservativeVerdict("no judge result"),
        ok: false,
        reason: "malformed",
      },
      usage,
      usageByJudge,
    };
  }
  if (results.length === 0) {
    return {
      llmOffline: true,
      llmOfflineByJudge,
      outcome: {
        fallback: conservativeVerdict("no judge configured"),
        ok: false,
        reason: "malformed",
      },
      usage,
      usageByJudge,
    };
  }
  const failed = results.filter((result) => !result.outcome.ok);
  if (failed.length > 0) {
    return {
      llmOffline,
      llmOfflineByJudge,
      outcome: {
        ok: true,
        tokens: usage.totalTokens,
        usage,
        verdict: conservativeVerdict(
          `judge incomplete: ${results.map(judgeStateSummary).join(" ")}`
        ),
      },
      usage,
      usageByJudge,
    };
  }
  const verdicts = results.map((result) =>
    result.outcome.ok ? result.outcome.verdict : conservativeVerdict("failed")
  );
  const state = verdicts[0]?.state;
  if (!state || verdicts.some((verdict) => verdict.state !== state)) {
    return {
      llmOffline,
      llmOfflineByJudge,
      outcome: {
        ok: true,
        tokens: usage.totalTokens,
        usage,
        verdict: conservativeVerdict(
          `judge disagree: ${results.map(judgeStateSummary).join(" ")}`
        ),
      },
      usage,
      usageByJudge,
    };
  }
  const primary = verdicts[0];
  return {
    llmOffline,
    llmOfflineByJudge,
    outcome: {
      ok: true,
      tokens: usage.totalTokens,
      usage,
      verdict: {
        confidence: Math.min(...verdicts.map((verdict) => verdict.confidence)),
        state,
        suggestedAction: primary?.suggestedAction,
        summary:
          primary?.summary ??
          `judge agree: ${results.map(judgeStateSummary).join(" ")}`,
      },
    },
    usage,
    usageByJudge,
  };
};

const judgeWithLocalJudges = async (
  info: BabysitAgentInfo,
  events: HookEvent[],
  paneText: string,
  config: BabysitConfig,
  deps: BabysitDeps,
  tick: number
): Promise<ConsensusJudgeResult> => {
  const results = await Promise.all(
    localJudgesForTick(config, tick).map(async (judge) => ({
      judge,
      outcome: await deps.judge({
        agent: info.agent,
        hookTail: events.slice(-HOOK_TAIL_LIMIT),
        model: judge.model,
        paneText,
        traceFile: config.llmTraceFile,
        url: judge.url,
      }),
    }))
  );
  return consensusJudgeResult(results);
};

const applyUsageLimits = (
  usage: AgentUsage,
  agent: Agent,
  snapshot?: UsageLimitSnapshot
): void => {
  const limits = snapshot?.[agent];
  if (!limits) {
    return;
  }
  if (limits.primaryPct !== undefined) {
    usage.rateLimitPrimaryPct = limits.primaryPct;
  }
  if (limits.primaryReset !== undefined) {
    usage.rateLimitPrimaryReset = limits.primaryReset;
  }
  if (limits.secondaryPct !== undefined) {
    usage.rateLimitSecondaryPct = limits.secondaryPct;
  }
  if (limits.secondaryReset !== undefined) {
    usage.rateLimitSecondaryReset = limits.secondaryReset;
  }
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
  applyUsageLimits(usage, info.agent, ctx.usageLimits);
  // Prefer the agent's own live remaining-context %, shown in its pane statusline.
  const paneCtxRemainingPct = parsePaneCtxRemainingPct(paneText);
  if (paneCtxRemainingPct !== undefined && usage.contextWindow > 0) {
    usage.contextTokens = Math.round(
      ((100 - paneCtxRemainingPct) / 100) * usage.contextWindow
    );
  }
  const paneEffort = parsePaneEffort(paneText);
  if (paneEffort) {
    usage.reasoningEffort = paneEffort;
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
  // A limit banner only counts while it is plausibly current. An idle agent
  // never prints new output, so a stale banner would otherwise pin "limited"
  // forever — including straight through the limit reset (the loop-23
  // overnight stall: Codex sat "limited" 12h past its reset). No session
  // window exceeds ~5h, so a banner that has sat on an unchanged pane longer
  // than that is guaranteed stale; clear it and let the restore path re-brief.
  // If the agent is somehow still limited, its next reply re-prints the
  // banner, the pane changes, and the verdict re-arms — self-correcting.
  const LIMIT_BANNER_MAX_IDLE_MS = 5.5 * 60 * 60 * 1000;
  if (
    isSessionLimited(paneText) &&
    liveness.paneIdleMs < LIMIT_BANNER_MAX_IDLE_MS
  ) {
    row.verdict = {
      confidence: 1,
      state: "limited",
      summary: "Agent session limit reached",
    };
  }
  const summaryCtx: SummaryAgentContext = {
    agent: info.agent,
    lastActions: events.slice(-SUMMARY_ACTIONS).map(eventLabel),
    paneText,
  };
  const base = {
    llmOfflineByJudge: {},
    llmOffline: false,
    llmUsage: emptyLocalLlmUsage(),
    llmUsageByJudge: emptyLocalLlmUsageByJudge(),
    recoveries: ctx.recoveries,
    row,
    summaryCtx,
  };

  // A cleanly-ended turn (last hook event is Stop/Notification) means the agent
  // finished and is idle — not stuck. Skip the LLM judge so we don't mislabel an
  // idle agent as working/waiting-human, and don't run recovery on it. The judge
  // only runs for a suspect whose turn never ended (frozen mid-work).
  if (row.verdict?.state === "limited" || !liveness.suspect || turnEnded) {
    return {
      ...base,
      history: ctx.history.filter((entry) => entry.agent !== info.agent),
    };
  }

  const judged = await judgeWithLocalJudges(
    info,
    events,
    paneText,
    config,
    deps,
    ctx.tick
  );
  const { outcome } = judged;
  const llmUsage = judged.usage;
  row.verdict = outcome.ok ? outcome.verdict : outcome.fallback;
  if (!outcome.ok && outcome.reason === "unreachable") {
    return {
      ...base,
      history: ctx.history,
      llmOffline: true,
      llmOfflineByJudge: judged.llmOfflineByJudge,
      llmUsage,
      llmUsageByJudge: judged.usageByJudge,
    };
  }

  const action = recoverAgent(info, row.verdict, config, deps, ctx);
  row.action = action;
  const recovered = Boolean(action) && !config.dryRun;
  return {
    ...base,
    history: recovered
      ? [...ctx.history, action as RecoveryHistoryEntry]
      : ctx.history,
    llmUsage,
    llmOffline: judged.llmOffline,
    llmOfflineByJudge: judged.llmOfflineByJudge,
    llmUsageByJudge: judged.usageByJudge,
    recoveries: ctx.recoveries + (recovered ? 1 : 0),
  };
};

const SUMMARY_REFRESH_TICKS = 20;

// A summary refresh is due when we have none yet (first run / after a restart /
// after an attempt returned empty) or the current one has aged out.
const summaryDue = (
  summaryText: string,
  summaryTick: number,
  tick: number
): boolean =>
  summaryTick < 0 ||
  summaryText.length === 0 ||
  tick - summaryTick >= SUMMARY_REFRESH_TICKS;

interface WaitingConsensusResult {
  ask: string;
  usage: LocalLlmUsage;
  usageByJudge: LocalLlmUsageByJudge;
  waiting: boolean;
}

interface RoleBalanceConsensusResult {
  recommendation: RoleBalanceResult | undefined;
  usageByJudge: LocalLlmUsageByJudge;
}

interface SummaryConsensusResult {
  text: string;
  usageByJudge: LocalLlmUsageByJudge;
}

const summarizeWithLocalJudges = async (
  config: BabysitConfig,
  deps: BabysitDeps,
  agents: SummaryAgentContext[],
  tick: number
): Promise<SummaryConsensusResult> => {
  const summaryContext = gatherSummaryContext(config, deps);
  const results = await Promise.all(
    localJudgesForTick(config, tick).map(async (judge) => ({
      judge,
      summary: await deps.summarize({
        agents,
        model: judge.model,
        traceFile: config.llmTraceFile,
        url: judge.url,
        ...summaryContext,
      }),
    }))
  );
  const usageByJudge: LocalLlmUsageByJudge = {};
  for (const result of results) {
    usageByJudge[result.judge.id] =
      result.summary.usage ?? localLlmUsageFromTokens(result.summary.tokens);
  }
  return {
    text: results.find((result) => result.summary.text)?.summary.text ?? "",
    usageByJudge,
  };
};

// Pane labels refresh on the same slow cadence as the summary — a task label
// should be stable, so per-tick naming would waste the single-request LLM.
const PANE_LABEL_REFRESH_TICKS = SUMMARY_REFRESH_TICKS;

const paneLabelsDue = (paneLabelTick: number, tick: number): boolean =>
  paneLabelTick < 0 || tick - paneLabelTick >= PANE_LABEL_REFRESH_TICKS;

interface PaneLabelConsensusResult {
  labels: Partial<Record<Agent, string>>;
  usageByJudge: LocalLlmUsageByJudge;
}

const labelPanesWithLocalJudges = async (
  config: BabysitConfig,
  deps: BabysitDeps,
  agents: SummaryAgentContext[],
  tick: number
): Promise<PaneLabelConsensusResult> => {
  const results = await Promise.all(
    localJudgesForTick(config, tick).map(async (judge) => ({
      judge,
      result: await deps.labelPanes({
        agents,
        model: judge.model,
        traceFile: config.llmTraceFile,
        url: judge.url,
      }),
    }))
  );
  const usageByJudge: LocalLlmUsageByJudge = {};
  for (const { judge, result } of results) {
    usageByJudge[judge.id] =
      result.usage ?? localLlmUsageFromTokens(result.tokens);
  }
  const labels =
    results.find(({ result }) => Object.keys(result.labels).length > 0)?.result
      .labels ?? {};
  return { labels, usageByJudge };
};

const assessWaitingWithLocalJudges = async (
  config: BabysitConfig,
  deps: BabysitDeps,
  agents: SummaryAgentContext[],
  tick: number
): Promise<WaitingConsensusResult> => {
  const results = await Promise.all(
    localJudgesForTick(config, tick).map(async (judge) => ({
      assessment: await deps.assessWaiting({
        agents,
        model: judge.model,
        traceFile: config.llmTraceFile,
        url: judge.url,
      }),
      judge,
    }))
  );
  const usageByJudge: LocalLlmUsageByJudge = {};
  for (const result of results) {
    usageByJudge[result.judge.id] =
      result.assessment.usage ??
      localLlmUsageFromTokens(result.assessment.tokens);
  }
  return {
    ask: results.find((result) => result.assessment.ask)?.assessment.ask ?? "",
    usage: sumLocalLlmUsageByJudge(usageByJudge),
    usageByJudge,
    waiting:
      results.length > 0 &&
      results.every((result) => result.assessment.waiting),
  };
};

const assessRoleBalanceWithLocalJudges = async (
  config: BabysitConfig,
  deps: BabysitDeps,
  request: Omit<RoleBalanceRequest, "model" | "url">,
  tick: number
): Promise<RoleBalanceConsensusResult> => {
  const results = await Promise.all(
    localJudgesForTick(config, tick).map(async (judge) => ({
      judge,
      recommendation: await deps.assessRoleBalance({
        ...request,
        model: judge.model,
        traceFile: config.llmTraceFile,
        url: judge.url,
      }),
    }))
  );
  const usageByJudge: LocalLlmUsageByJudge = {};
  for (const result of results) {
    usageByJudge[result.judge.id] =
      result.recommendation.usage ??
      localLlmUsageFromTokens(result.recommendation.tokens);
  }
  const candidate = request.candidateDriver;
  const approvals = results.filter(
    (result) =>
      result.recommendation.switchDriver &&
      result.recommendation.driver === candidate &&
      result.recommendation.confidence >= PROACTIVE_BALANCE_MIN_CONFIDENCE
  );
  return {
    recommendation:
      results.length > 0 && approvals.length === results.length
        ? approvals[0]?.recommendation
        : results[0]?.recommendation,
    usageByJudge,
  };
};

const missingJudgeUsage = (
  config: BabysitConfig,
  usageByJudge: LocalLlmUsageByJudge
): boolean =>
  localJudges(config).some((judge) => {
    const usage = usageByJudge[judge.id];
    return usage === undefined || usage.calls <= 0;
  });

// Gather the richer context the summary reads: the human's verbatim
// instructions this session (deduped across agents, order preserved), the
// project docs, and prior-session summaries.
const gatherSummaryContext = (
  config: BabysitConfig,
  deps: BabysitDeps
): Pick<
  SummaryRequest,
  "humanMessages" | "priorSummaries" | "projectContext"
> => {
  const seen = new Set<string>();
  const humanMessages: string[] = [];
  for (const info of config.agents) {
    for (const message of deps.readHumanMessages(
      info.agent,
      info.sessionRef,
      info.codexHome
    )) {
      if (!seen.has(message)) {
        seen.add(message);
        humanMessages.push(message);
      }
    }
  }
  return {
    humanMessages,
    priorSummaries: readPriorSummaries(config.runDir),
    projectContext: readProjectContext(config.cwd),
  };
};

// An agent counts as active when its TUI is animating (thinking) or the judge
// says it is working; anything else (finished turn, frozen, stuck) is idle.
const isRowActive = (row: AgentRow): boolean =>
  row.thinking || row.verdict?.state === "working";

const rowsForDisplay = (rows: AgentRow[]): AgentRow[] =>
  [...rows].sort((a, b) => Number(isLimitPaused(a)) - Number(isLimitPaused(b)));

// Add tickMs to each agent's active/idle budget; both idle => human-idle time.
const accumulateStats = (
  stats: SessionStats,
  rows: AgentRow[],
  tickMs: number
): void => {
  for (const row of rows) {
    const agent = row.liveness.agent;
    if (isRowActive(row)) {
      stats.activeMs[agent] = (stats.activeMs[agent] ?? 0) + tickMs;
    } else {
      stats.idleMs[agent] = (stats.idleMs[agent] ?? 0) + tickMs;
    }
  }
  const availableRows = rows.filter((row) => !isLimitPaused(row));
  if (availableRows.length >= 2 && !availableRows.some(isRowActive)) {
    stats.humanIdleMs += tickMs;
  }
};

const cloneStats = (stats: SessionStats): SessionStats => ({
  activeMs: { ...stats.activeMs },
  humanIdleMs: stats.humanIdleMs,
  idleMs: { ...stats.idleMs },
});

// A lone idle agent is usually just waiting on its peer via the bridge; the pair
// needs the human when BOTH are idle together. Track how long that has held,
// resetting (and forgetting the LLM's read) the moment either agent goes active.
const updateBothIdle = (
  runState: BabysitRunState,
  rows: AgentRow[],
  nowMs: number
): WaitingForYou => {
  const availableRows = rows.filter((row) => !isLimitPaused(row));
  if (availableRows.length < 2 || availableRows.some(isRowActive)) {
    runState.bothIdleSince = 0;
    runState.waitingConfirmed = false;
    runState.waitingAsk = "";
    runState.notified.waitingForYou = false;
    return { ask: "", confirmed: false, ms: 0 };
  }
  if (runState.bothIdleSince === 0) {
    runState.bothIdleSince = nowMs;
  }
  return {
    ask: runState.waitingAsk,
    confirmed: runState.waitingConfirmed,
    ms: nowMs - runState.bothIdleSince,
  };
};

const agentInfoByAgent = (
  config: BabysitConfig
): Partial<Record<Agent, BabysitAgentInfo>> =>
  Object.fromEntries(
    config.agents.map((info) => [info.agent, info])
  ) as Partial<Record<Agent, BabysitAgentInfo>>;

const limitHandoffMessage = (
  paused: Agent,
  driver: Agent,
  pressure: LimitPressure
): string => {
  const pausedName = capitalize(paused);
  const driverName = capitalize(driver);
  const reset = pressure.reset
    ? ` until the ${pressure.resetKind} limit resets at ${pressure.reset}`
    : " until its limit resets";
  return [
    `babysitter: ${pausedName} is at/near ${pressure.resetKind} limit (${pressure.pct}% used)${reset}.`,
    `${driverName} is now the driver. Continue the task from the current repo state and do not wait for ${pausedName}'s next turn before making progress.`,
    `Ask ${pausedName} for review or context only after that limit reset, or if the human explicitly redirects the pairing.`,
  ].join(" ");
};

// Belt-and-braces throttle for restore briefings: even a genuine handoff
// briefing repeats at most once per window per agent (in-memory; resets on
// babysitter respawn, which is fine — the cost of a rare duplicate briefing is
// one message, the cost of a flapping restore loop is constant interruption).
const RESTORE_MESSAGE_COOLDOWN_MS = 15 * 60 * 1000;
const restoreMessageSentAtMs = new Map<Agent, number>();

const restoreContextMessage = (
  restored: Agent,
  temporary: Agent | undefined,
  state: BabysitRunState
): string => {
  const restoredName = capitalize(restored);
  const temporaryName = temporary ? capitalize(temporary) : "The other agent";
  const summary = state.summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  const context = summary
    ? truncate(summary, 700)
    : "Use the current repo state, recent terminal output, PLAN.md/status.md if present, and the peer's latest handoff.";
  return `babysitter: ${restoredName}'s limit reset and ${restoredName} is the driver again. While you were paused, ${temporaryName} drove the task. Current context: ${context} Pick up from the current repo state; ask ${temporaryName} for only a concise missing detail if needed.`;
};

const restoreTemporaryDriverMessage = (
  restored: Agent,
  temporary: Agent
): string =>
  [
    `babysitter: ${capitalize(restored)}'s limit reset.`,
    `Hand the driver role back to ${capitalize(restored)} now.`,
    "Send a concise handoff if useful, then stop driving unless the human redirects.",
  ].join(" ");

const balanceDriverMessage = (
  previous: Agent,
  next: Agent,
  reason: string
): string =>
  [
    "babysitter: proactive quota balance.",
    `${capitalize(next)} is now the driver; ${capitalize(previous)} should preserve quota and stay available for review/context.`,
    reason ? `Reason: ${truncate(reason, 180)}.` : "",
    "Continue from the current repo state and do not wait for an actual quota limit.",
  ]
    .filter(Boolean)
    .join(" ");

const balancePreviousDriverMessage = (
  previous: Agent,
  next: Agent,
  reason: string
): string =>
  [
    "babysitter: proactive quota balance.",
    `${capitalize(next)} is now the driver to preserve available quota.`,
    reason ? `Reason: ${truncate(reason, 180)}.` : "",
    `${capitalize(previous)} should stay available for review/context and only resume driving if asked or after roles change again.`,
  ]
    .filter(Boolean)
    .join(" ");

const bridgeSourceFor = (
  target: Agent,
  preferred: Agent | undefined,
  config: BabysitConfig
): Agent | undefined =>
  preferred && preferred !== target
    ? preferred
    : config.agents.find((info) => info.agent !== target)?.agent;

const sendDirectRoleMessage = (
  deps: BabysitDeps,
  info: BabysitAgentInfo,
  message: string
): "tmux" => {
  deps.sendText(info.pane, message);
  deps.sendKeys(info.pane, ["Enter"]);
  return "tmux";
};

const sendRoleMessage = async (
  config: BabysitConfig,
  deps: BabysitDeps,
  targetInfo: BabysitAgentInfo,
  target: Agent,
  source: Agent | undefined,
  message: string
): Promise<BridgeSendStatus | "tmux"> => {
  // Claude has no external push route from the babysitter process today; keep
  // that path direct. Codex/non-Claude bridge delivery avoids fragile pane
  // text+Enter injection and lets the bridge worker/app-server steer safely.
  if (config.runDir && source && source !== target && target !== "claude") {
    return deps.sendBridge(config.runDir, source, target, message);
  }
  return sendDirectRoleMessage(deps, targetInfo, message);
};

const availableDriverRow = (
  rows: AgentRow[],
  preferred: Agent | undefined
): AgentRow | undefined =>
  (preferred
    ? rows.find(
        (row) => row.liveness.agent === preferred && !isLimitPaused(row)
      )
    : undefined) ?? rows.find((row) => !isLimitPaused(row));

const setActiveRoleHandoff = (
  runState: BabysitRunState,
  initialDriver: Agent,
  paused: Agent,
  driver: Agent,
  pressure: LimitPressure,
  nowIso: string | undefined
): void => {
  runState.roles = {
    currentDriver: driver,
    handoffAt: nowIso ?? runState.roles.handoffAt,
    initialDriver,
    lastAction: "handoff",
    pausedAgent: paused,
    pressureKey: pressure.key,
    reset: pressure.reset,
    resetKind: pressure.resetKind,
    temporaryDriver: driver,
  };
};

const setActiveRoleBalance = (
  runState: BabysitRunState,
  initialDriver: Agent,
  previous: Agent,
  next: Agent,
  candidateKey: string,
  reason: string,
  nowIso: string
): void => {
  runState.roles = {
    balanceAt: nowIso,
    balanceCheckKey: candidateKey,
    balanceKey: candidateKey,
    balanceReason: reason,
    currentDriver: next,
    initialDriver,
    lastAction: "balance",
    temporaryDriver:
      previous === initialDriver ? next : runState.roles.temporaryDriver,
  };
};

interface RoleTransitionResult {
  llmUsageByJudge: LocalLlmUsageByJudge;
}

const handleRoleTransitions = async (
  rows: AgentRow[],
  config: BabysitConfig,
  deps: BabysitDeps,
  runState: BabysitRunState,
  nowIso: string
): Promise<RoleTransitionResult> => {
  const transitionUsageByJudge = emptyLocalLlmUsageByJudge();
  const infos = agentInfoByAgent(config);
  const pressures = new Map<Agent, LimitPressure>();
  for (const row of rows) {
    const pressure = limitPressure(row);
    if (pressure) {
      pressures.set(row.liveness.agent, pressure);
    }
  }
  let activePaused = runState.roles.pausedAgent;
  let restoredThisTick = false;

  // A pressure observation for an agent that was not driving does not create a
  // role handoff. Older babysitters did create one, which made a missing usage
  // snapshot "restore" the already-active driver and repeatedly compact it.
  if (
    activePaused &&
    runState.roles.initialDriver &&
    activePaused !== runState.roles.initialDriver
  ) {
    delete runState.notified.limitHandoff[activePaused];
    runState.roles = {
      currentDriver:
        runState.roles.currentDriver ?? runState.roles.initialDriver,
      initialDriver: runState.roles.initialDriver,
      lastAction: runState.roles.lastAction,
    };
    activePaused = undefined;
  }

  if (activePaused && !pressures.has(activePaused)) {
    const resetAt = parseResetTime(runState.roles.reset, Date.parse(nowIso));
    const resetStillPending =
      resetAt && resetAt.date.getTime() > Date.parse(nowIso);
    if (resetStillPending) {
      runState.roles.pressureMissingAt = undefined;
    } else if (!runState.roles.pressureMissingAt) {
      // One absent usage read is not a reset. Persist the start of the missing
      // episode and require a full cooldown before changing roles.
      runState.roles.pressureMissingAt = nowIso;
    } else if (
      Date.parse(nowIso) - Date.parse(runState.roles.pressureMissingAt) >=
      config.cooldownMs
    ) {
      const restored =
        runState.roles.initialDriver ?? config.initialDriver ?? activePaused;
      const restoredRow = rows.find((row) => row.liveness.agent === restored);
      // Keep the restore pending while the agent is mid-turn. Injecting even a
      // normal briefing into an active TUI can interrupt its work.
      if (restoredRow && isRowActive(restoredRow)) {
        return { llmUsageByJudge: transitionUsageByJudge };
      }
      const restoredInfo = infos[restored];
      const temporary = runState.roles.temporaryDriver;
      const temporaryInfo =
        temporary && temporary !== restored ? infos[temporary] : undefined;
      const restoredSource = bridgeSourceFor(restored, temporary, config);
      let restoredDelivery: BridgeSendStatus | "tmux" | undefined;
      let temporaryDelivery: BridgeSendStatus | "tmux" | undefined;
      // A self-restore (nobody else ever drove — restored agent IS the paused
      // agent and there is no distinct temporary driver) carries zero new
      // information for the agent, and injecting it interrupts real work. The
      // loop-24 pathology was six such restores in 19 minutes, each one
      // stealing the composer mid-turn. Restore the ROLE silently; message
      // only genuine handoffs, and never more than once per cooldown window.
      const genuineHandoff = Boolean(temporary && temporary !== restored);
      const lastMsgAt = restoreMessageSentAtMs.get(restored) ?? 0;
      const messageAllowed =
        genuineHandoff &&
        Date.parse(nowIso) - lastMsgAt >= RESTORE_MESSAGE_COOLDOWN_MS;
      if (restoredInfo && messageAllowed) {
        restoredDelivery = await sendRoleMessage(
          config,
          deps,
          restoredInfo,
          restored,
          restoredSource,
          restoreContextMessage(restored, temporary, runState)
        );
        restoreMessageSentAtMs.set(restored, Date.parse(nowIso));
        incrementCount(runState.babysitterMessages, restored);
      }
      if (temporaryInfo) {
        temporaryDelivery = await sendRoleMessage(
          config,
          deps,
          temporaryInfo,
          temporary,
          restored,
          restoreTemporaryDriverMessage(restored, temporary)
        );
        incrementCount(runState.babysitterMessages, temporary);
      }
      deps.appendLog(config.logFile, {
        driver: restored,
        kind: "limit-restore",
        previousDriver: temporary,
        restored,
        restoredDelivery,
        ts: nowIso,
        temporaryDelivery,
      });
      delete runState.notified.limitHandoff[activePaused];
      runState.roles = {
        currentDriver: restored,
        initialDriver: restored,
        lastAction: "restore",
        restoredAt: nowIso,
      };
      restoredThisTick = true;
    }
  }

  for (const agent of Object.keys(runState.notified.limitHandoff)) {
    if (!pressures.has(agent as Agent) && agent !== activePaused) {
      delete runState.notified.limitHandoff[agent];
    }
  }
  for (const [paused, pressure] of pressures) {
    const initialDriver =
      runState.roles.initialDriver ?? config.initialDriver ?? paused;
    const currentDriver = runState.roles.currentDriver ?? initialDriver;
    const available = availableDriverRow(rows, currentDriver);
    if (!available) {
      continue;
    }
    const driver = available.liveness.agent;
    const driverInfo = infos[driver];
    if (!driverInfo) {
      continue;
    }
    if (runState.notified.limitHandoff[paused]) {
      runState.notified.limitHandoff[paused] = pressure.key;
      if (
        runState.roles.pausedAgent === paused ||
        (!runState.roles.pausedAgent && paused === currentDriver)
      ) {
        setActiveRoleHandoff(
          runState,
          initialDriver,
          paused,
          driver,
          pressure,
          undefined
        );
        runState.roles.pressureMissingAt = undefined;
      }
      continue;
    }
    if (paused !== currentDriver) {
      // Track the observation for dedupe, but do not interrupt the current
      // driver when no role change is required.
      runState.notified.limitHandoff[paused] = pressure.key;
      continue;
    }
    const message = limitHandoffMessage(paused, driver, pressure);
    const delivery = await sendRoleMessage(
      config,
      deps,
      driverInfo,
      driver,
      paused,
      message
    );
    incrementCount(runState.babysitterMessages, driver);
    deps.appendLog(config.logFile, {
      delivery,
      driver,
      kind: "limit-handoff",
      paused,
      pressure,
      ts: nowIso,
    });
    runState.notified.limitHandoff[paused] = pressure.key;
    setActiveRoleHandoff(
      runState,
      initialDriver,
      paused,
      driver,
      pressure,
      nowIso
    );
  }
  if (pressures.size > 0 || restoredThisTick || runState.roles.pausedAgent) {
    return { llmUsageByJudge: transitionUsageByJudge };
  }
  if (!config.roleBalanceEnabled) {
    return { llmUsageByJudge: transitionUsageByJudge };
  }

  const initialDriver =
    runState.roles.initialDriver ??
    config.initialDriver ??
    rows[0]?.liveness.agent;
  const currentDriver = runState.roles.currentDriver ?? initialDriver;
  const candidate = roleBalanceCandidate(rows, currentDriver);
  if (!(candidate && initialDriver && currentDriver)) {
    return { llmUsageByJudge: transitionUsageByJudge };
  }
  if (runState.roles.balanceCheckKey === candidate.key) {
    return { llmUsageByJudge: transitionUsageByJudge };
  }

  const next = candidate.candidate.liveness.agent;
  const previous = candidate.current.liveness.agent;
  const decision = await assessRoleBalanceWithLocalJudges(
    config,
    deps,
    {
      agents: rows.map((row) => roleBalanceAgentContext(row, currentDriver)),
      candidateDriver: next,
      currentDriver,
      initialDriver,
      reasonHint: candidate.reasonHint,
      summary: runState.summary,
    },
    runState.tick
  );
  Object.assign(
    transitionUsageByJudge,
    addLocalLlmUsageByJudge(transitionUsageByJudge, decision.usageByJudge)
  );
  runState.roles.balanceCheckKey = candidate.key;
  const recommendation = decision.recommendation;
  if (
    !recommendation?.switchDriver ||
    recommendation.driver !== next ||
    recommendation.confidence < PROACTIVE_BALANCE_MIN_CONFIDENCE
  ) {
    deps.appendLog(config.logFile, {
      candidate: next,
      currentDriver,
      decision: recommendation,
      kind: "role-balance-veto",
      reasonHint: candidate.reasonHint,
      ts: nowIso,
    });
    return { llmUsageByJudge: transitionUsageByJudge };
  }

  const nextInfo = infos[next];
  const previousInfo = infos[previous];
  if (!nextInfo) {
    return { llmUsageByJudge: transitionUsageByJudge };
  }
  const reason = recommendation.reason || candidate.reasonHint;
  const nextDelivery = await sendRoleMessage(
    config,
    deps,
    nextInfo,
    next,
    previous,
    balanceDriverMessage(previous, next, reason)
  );
  incrementCount(runState.babysitterMessages, next);
  let previousDelivery: BridgeSendStatus | "tmux" | undefined;
  if (previousInfo) {
    previousDelivery = await sendRoleMessage(
      config,
      deps,
      previousInfo,
      previous,
      next,
      balancePreviousDriverMessage(previous, next, reason)
    );
    incrementCount(runState.babysitterMessages, previous);
  }
  deps.appendLog(config.logFile, {
    candidate: next,
    currentDriver,
    decision: recommendation,
    kind: "role-balance",
    nextDelivery,
    previousDelivery,
    reason,
    reasonHint: candidate.reasonHint,
    ts: nowIso,
  });
  setActiveRoleBalance(
    runState,
    initialDriver,
    previous,
    next,
    candidate.key,
    reason,
    nowIso
  );
  return { llmUsageByJudge: transitionUsageByJudge };
};

// Decide what (if anything) to escalate this tick, deduped via runState.notified
// so each condition alerts once per episode rather than every tick.
const collectEscalations = (
  runState: BabysitRunState,
  waiting: WaitingForYou,
  totalCost: number,
  config: BabysitConfig
): EscalationEvent[] => {
  const events: EscalationEvent[] = [];
  const { notified } = runState;
  if (
    waiting.confirmed &&
    waiting.ms >= config.escalateIdleMs &&
    !notified.waitingForYou
  ) {
    notified.waitingForYou = true;
    const asked = waiting.ask ? ` They need: ${waiting.ask}` : "";
    events.push({
      kind: "waiting-human",
      message: `Both agents idle ${fmtDuration(waiting.ms)} and waiting on you (run ${config.runId}).${asked}`,
      priority: "high",
      title: "The session is waiting for you",
    });
  }
  for (const info of config.agents) {
    const used = runState.history.filter(
      (entry) => entry.agent === info.agent
    ).length;
    if (used >= config.maxRecoveries && !notified.ladder[info.agent]) {
      notified.ladder[info.agent] = true;
      events.push({
        agent: info.agent,
        kind: "recovery-exhausted",
        message: `Exhausted ${config.maxRecoveries} recovery attempts for ${info.agent} (run ${config.runId}). It needs you.`,
        priority: "urgent",
        title: `${info.agent} can't auto-recover`,
      });
    } else if (used < config.maxRecoveries) {
      notified.ladder[info.agent] = false;
    }
  }
  if (config.budgetUsd > 0) {
    const fraction = totalCost / config.budgetUsd;
    const spend = `$${totalCost.toFixed(2)} / $${config.budgetUsd.toFixed(0)}`;
    if (fraction >= 1 && !notified.budget100) {
      notified.budget100 = true;
      events.push({
        kind: "budget",
        message: `Run ${config.runId} is over budget: ${spend}.`,
        priority: "urgent",
        title: "Budget exceeded",
      });
    } else if (
      fraction >= BUDGET_WARN_FRACTION &&
      !(notified.budget80 || notified.budget100)
    ) {
      notified.budget80 = true;
      events.push({
        kind: "budget",
        message: `Run ${config.runId} at ${Math.round(fraction * 100)}% of budget: ${spend}.`,
        priority: "high",
        title: "Budget 80% reached",
      });
    }
  }
  return events;
};

// One control-loop tick: detect → (judge suspects) → recover → summarize → render.
export const babysitTick = async (
  states: Map<Agent, AgentLivenessState>,
  config: BabysitConfig,
  deps: BabysitDeps,
  runStateIn: BabysitRunState = freshRunState()
): Promise<BabysitTickResult> => {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const babysitterMessages = readCountMap(runStateIn.babysitterMessages);
  const runState: BabysitRunState = {
    ...runStateIn,
    babysitterMessages:
      Object.keys(babysitterMessages).length > 0
        ? babysitterMessages
        : readBabysitterMessageCountsFromLog(config.logFile),
    notified: {
      ...runStateIn.notified,
      ladder: { ...runStateIn.notified.ladder },
      limitHandoff: { ...runStateIn.notified.limitHandoff },
    },
    paneLabels: { ...runStateIn.paneLabels },
    paneTitles: { ...runStateIn.paneTitles },
    roles: { ...runStateIn.roles },
    stats: cloneStats(runStateIn.stats),
    tick: runStateIn.tick + 1,
  };
  let { history, recoveries, llmUsage } = runState;
  let llmUsageByJudge =
    Object.keys(runState.llmUsageByJudge).length > 0
      ? runState.llmUsageByJudge
      : runState.llmUsage.totalTokens > 0 || runState.llmUsage.calls > 0
        ? { [primaryJudge(config).id]: runState.llmUsage }
        : runState.llmUsageByJudge;
  let llmOffline = false;
  const llmOfflineByJudge: Record<string, boolean> = {};
  const rows: AgentRow[] = [];
  const summaryCtxs: SummaryAgentContext[] = [];
  const usageLimits = await deps.readUsageLimits(config).catch(() => undefined);

  for (const info of config.agents) {
    const result = await processAgent(info, states, config, deps, {
      history,
      nowIso,
      nowMs,
      recoveries,
      tick: runState.tick,
      usageLimits,
    });
    history = result.history;
    recoveries = result.recoveries;
    llmUsage = addLocalLlmUsage(llmUsage, result.llmUsage);
    llmUsageByJudge = addLocalLlmUsageByJudge(
      llmUsageByJudge,
      result.llmUsageByJudge
    );
    llmOffline = llmOffline || result.llmOffline;
    for (const [id, offline] of Object.entries(result.llmOfflineByJudge)) {
      llmOfflineByJudge[id] = (llmOfflineByJudge[id] ?? false) || offline;
    }
    rows.push(result.row);
    summaryCtxs.push(result.summaryCtx);
    if (result.row.action?.level === "nudge" && !config.dryRun) {
      incrementCount(runState.babysitterMessages, info.agent);
    }
  }

  const roleTransitions = await handleRoleTransitions(
    rows,
    config,
    deps,
    runState,
    nowIso
  );
  llmUsageByJudge = addLocalLlmUsageByJudge(
    llmUsageByJudge,
    roleTransitions.llmUsageByJudge
  );
  llmUsage = addLocalLlmUsage(
    llmUsage,
    sumLocalLlmUsageByJudge(roleTransitions.llmUsageByJudge)
  );
  accumulateStats(runState.stats, rows, config.tickMs);
  applyPaneLabels(config, deps, rows, runState);

  // The session summary is generated off the tick (see runBabysitter) so a slow
  // local-LLM call never freezes the board; here we just render runState.summary
  // as carried in, and hand back the contexts a background refresh needs.
  runState.history = history;
  runState.recoveries = recoveries;
  runState.llmUsage = llmUsage;
  runState.llmUsageByJudge = llmUsageByJudge;
  runState.llmTokens = llmUsage.totalTokens;

  const totalCost = rows.reduce((sum, row) => sum + row.usage.costUsd, 0);
  const waitingForYou = updateBothIdle(runState, rows, nowMs);
  for (const event of collectEscalations(
    runState,
    waitingForYou,
    totalCost,
    config
  )) {
    deps.notify(config.ntfyUrl, event);
  }

  const uptimeMs = config.createdAt
    ? nowMs - Date.parse(config.createdAt)
    : Number.NaN;
  const judges = localJudges(config);
  const llmRuntimeByJudge = Object.fromEntries(
    judges.map((judge) => [
      judge.id,
      deps.readLocalLlmRuntime({
        decodeConcurrency: config.llmDecodeConcurrency,
        logFile: judge.logFile ?? config.llmLogFile,
        model: judge.model,
        prefillStepSize: config.llmPrefillStepSize,
        promptCacheMaxSequences: config.llmPromptCacheSlots,
        promptConcurrency: config.llmPromptConcurrency,
        traceFile: config.llmTraceFile,
      }),
    ])
  );
  const board = renderBoard(rowsForDisplay(rows), {
    babysitterMessages: runState.babysitterMessages,
    bridge: deps.readBridge(config.transcriptPath),
    bridgeLatest: deps.readBridgeLatest(config.runDir),
    budgetUsd: config.budgetUsd,
    initialDriver: config.initialDriver,
    judgeMode: config.judgeMode,
    llmJudges: judges,
    llmOfflineByJudge,
    llmRuntimeByJudge,
    llmUsageByJudge,
    nowMs,
    recoveries,
    roles: runState.roles,
    stats: runState.stats,
    summary: runState.summary,
    tickMs: config.tickMs,
    uptimeMs,
    waitingForYou,
  });
  deps.render(board);
  const agentStates: Partial<Record<Agent, string>> = {};
  config.agents.forEach((info, index) => {
    const row = rows[index];
    if (row) {
      agentStates[info.agent] = rowState(row);
    }
  });
  return { agentStates, board, llmOffline, runState, states, summaryCtxs };
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

export const readBridgeLatest = (runDir?: string): BridgeLatest => {
  const latest: BridgeLatest = {};
  if (!runDir) {
    return latest;
  }
  try {
    for (const event of readBridgeEvents(runDir)) {
      if (event.kind !== "message") {
        continue;
      }
      const current = latest[event.source]?.[event.target];
      if (current && current.at.localeCompare(event.at) >= 0) {
        continue;
      }
      latest[event.source] ??= {};
      latest[event.source][event.target] = event;
    }
  } catch {
    // No bridge log yet.
  }
  return latest;
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
    const llmUsage = readLocalLlmUsage(parsed.llmUsage, parsed.llmTokens);
    return {
      babysitterMessages: readCountMap(parsed.babysitterMessages),
      bothIdleSince:
        typeof parsed.bothIdleSince === "number" ? parsed.bothIdleSince : 0,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      llmUsage,
      llmUsageByJudge: readLocalLlmUsageByJudge(
        parsed.llmUsageByJudge,
        judgeIdFromModel(DEFAULT_BABYSIT_MODEL),
        llmUsage
      ),
      llmTokens: typeof parsed.llmTokens === "number" ? parsed.llmTokens : 0,
      notified: {
        ...freshNotified(),
        ...parsed.notified,
        ladder: { ...(parsed.notified?.ladder ?? {}) },
        limitHandoff: { ...(parsed.notified?.limitHandoff ?? {}) },
      },
      paneLabels: readStringMap(parsed.paneLabels),
      paneLabelTick:
        typeof parsed.paneLabelTick === "number" ? parsed.paneLabelTick : -1,
      paneRenames: readStringMap(parsed.paneRenames),
      paneTitles: readStringMap(parsed.paneTitles),
      recoveries: typeof parsed.recoveries === "number" ? parsed.recoveries : 0,
      roles: readRoleState(parsed.roles),
      stats: {
        activeMs: stats.activeMs ?? {},
        humanIdleMs: stats.humanIdleMs ?? 0,
        idleMs: stats.idleMs ?? {},
      },
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      summaryTick:
        typeof parsed.summaryTick === "number" ? parsed.summaryTick : -1,
      tick: typeof parsed.tick === "number" ? parsed.tick : 0,
      waitingAsk:
        typeof parsed.waitingAsk === "string" ? parsed.waitingAsk : "",
      waitingConfirmed: parsed.waitingConfirmed === true,
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

const sendBabysitterBridgeMessage = async (
  runDir: string,
  source: Agent,
  target: Agent,
  message: string
): Promise<BridgeSendStatus> => {
  const result = await dispatchBridgeMessage(
    runDir,
    source,
    target,
    message,
    target === "codex"
      ? async (entry) => {
          if (
            readBridgeRuntimeStatus(runDir).codexDeliveryMode === "tmux-proxy"
          ) {
            return false;
          }
          return (
            (await deliverCodexBridgeMessage(runDir, entry)) ||
            (await deliverTmuxBridgeMessage(runDir, entry))
          );
        }
      : target === "cursor" || target === "gemini" || target === "copilot"
        ? (entry) => deliverTmuxBridgeMessage(runDir, entry)
        : undefined
  );
  if (
    result.status !== "delivered" &&
    hasBridgeDeliveryRoute(runDir, target) &&
    ensureBridgeWorker(runDir)
  ) {
    result.status = "accepted";
  }
  return result.status;
};

export const defaultBabysitDeps = (): BabysitDeps => ({
  assessRoleBalance: (req) => assessRoleBalance(req),
  assessWaiting: (req) => assessWaiting(req),
  appendLog: (file, record) => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  },
  capturePane: (pane) => tmux(["capture-pane", "-p", "-t", pane]),
  initPaneBorders: (session) => {
    tmux(["set-option", "-t", session, "pane-border-status", "top"]);
    tmux(["set-option", "-t", session, "pane-border-format", "#{@loop_label}"]);
  },
  judge: (req) => judgeAgent(req),
  labelPanes: (req) => labelPanes(req),
  loadState: (stateFile) => loadBabysitState(stateFile),
  notify: (ntfyUrl, event) => sendNtfy(ntfyUrl, event),
  now: () => Date.now(),
  readBridge: (transcriptPath) => readBridgeCounts(transcriptPath),
  readBridgeLatest: (runDir) => readBridgeLatest(runDir),
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
  readHumanMessages: (agent, sessionRef, codexHome) =>
    readHumanMessages(agent, sessionRef, codexHome),
  readLocalLlmRuntime: (input) => readLocalLlmRuntime(input),
  readUsage: (agent, sessionRef, codexHome) =>
    readAgentUsage(agent, sessionRef, codexHome),
  readUsageLimits: (config) =>
    readUsageTrackerLimits({
      secret: config.usageTrackerSecret,
      timeoutMs: config.usageTrackerTimeoutMs,
      url: config.usageTrackerUrl,
    }),
  render: (text) => {
    // Clear the pane and print the fresh board.
    process.stdout.write(`\x1b[2J\x1b[H${text}\n`);
  },
  respawnPane: (pane) => {
    spawnSync(["tmux", "respawn-pane", "-k", "-t", pane], { stderr: "ignore" });
  },
  saveState: (stateFile, state) => saveBabysitState(stateFile, state),
  sendBridge: (runDir, source, target, message) =>
    sendBabysitterBridgeMessage(runDir, source, target, message),
  setPaneLabel: (pane, label) => {
    tmux(["set-option", "-p", "-t", pane, "@loop_label", label]);
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

const envPositiveInt = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number
): number => {
  const raw = env[key];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const envConfidence = (env: NodeJS.ProcessEnv): number => {
  const parsed = Number.parseFloat(env.LOOP_BABYSIT_CONFIDENCE ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_BABYSIT_CONFIDENCE;
};

const envJudgeMode = (env: NodeJS.ProcessEnv): LocalLlmJudgeMode =>
  env.LOOP_BABYSIT_JUDGE_MODE === "round-robin" ? "round-robin" : "consensus";

const envDisabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
};

const envEnabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const llmTraceFileFromEnv = (
  env: NodeJS.ProcessEnv,
  runDir: string
): string | undefined => {
  const raw = env.LOOP_BABYSIT_LLM_TRACE?.trim();
  const normalized = raw?.toLowerCase();
  if (
    !raw ||
    normalized === "0" ||
    normalized === "false" ||
    normalized === "off"
  ) {
    return undefined;
  }
  if (normalized === "1" || normalized === "true" || normalized === "on") {
    return join(runDir, "llm-trace.jsonl");
  }
  return isAbsolute(raw) ? raw : join(runDir, raw);
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

const parseLocalJudgeSpec = (
  spec: string,
  fallbackLogFile?: string
): LocalLlmJudgeConfig | undefined => {
  const trimmed = spec.trim();
  if (!trimmed) {
    return undefined;
  }
  const eqIndex = trimmed.indexOf("=");
  const explicitId = eqIndex >= 0 ? trimmed.slice(0, eqIndex).trim() : "";
  const body = eqIndex >= 0 ? trimmed.slice(eqIndex + 1) : trimmed;
  const [url, model, logFile] = body.split(",").map((part) => part.trim());
  if (!(url && model)) {
    return undefined;
  }
  return {
    id: explicitId || judgeIdFromModel(model),
    logFile: logFile || fallbackLogFile,
    model,
    modelSizeGb: modelSizeGb(model),
    url,
  };
};

const localJudgesFromEnv = (
  env: NodeJS.ProcessEnv,
  primary: LocalLlmJudgeConfig
): LocalLlmJudgeConfig[] => {
  const raw = env.LOOP_BABYSIT_JUDGES;
  if (!raw?.trim()) {
    return [primary];
  }
  const judges = raw
    .split(";")
    .map((spec) => parseLocalJudgeSpec(spec, primary.logFile))
    .filter((judge): judge is LocalLlmJudgeConfig => judge !== undefined);
  const seen = new Set<string>();
  return judges
    .map((judge) => {
      let id = judge.id;
      let suffix = 2;
      while (seen.has(id)) {
        id = `${judge.id}${suffix++}`;
      }
      seen.add(id);
      return { ...judge, id };
    })
    .slice(0, 4);
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
  const url = env.LOOP_BABYSIT_URL || DEFAULT_BABYSIT_URL;
  const llmLogFile =
    env.LOOP_BABYSIT_LLM_LOG || join(home ?? homedir(), "models", "mlx-lm.log");
  const usageTrackerDisabled = envDisabled(env.LOOP_USAGE_TRACKER_LIMITS);
  const usageTrackerSecret = usageTrackerDisabled
    ? undefined
    : env.LOOP_USAGE_TRACKER_SECRET || env.USAGE_TRACKER_SECRET || undefined;
  const usageTrackerUrl = usageTrackerDisabled
    ? undefined
    : env.LOOP_USAGE_TRACKER_URL ||
      env.USAGE_TRACKER_URL ||
      DEFAULT_USAGE_TRACKER_URL;
  const primaryLocalJudge: LocalLlmJudgeConfig = {
    id: judgeIdFromModel(model),
    logFile: llmLogFile,
    model,
    modelSizeGb: modelSizeGb(model),
    url,
  };
  const budget = Number.parseFloat(env.LOOP_BABYSIT_BUDGET ?? "");
  return {
    agents,
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
    confidence: envConfidence(env),
    cooldownMs: envSeconds(
      env,
      "LOOP_BABYSIT_COOLDOWN",
      DEFAULT_BABYSIT_COOLDOWN_SECONDS
    ),
    createdAt: manifest?.createdAt,
    cwd: manifest?.cwd,
    dryRun: env.LOOP_BABYSIT_DRY_RUN === "1",
    escalateIdleMs: envSeconds(
      env,
      "LOOP_BABYSIT_ESCALATE_IDLE",
      DEFAULT_BABYSIT_ESCALATE_IDLE_SECONDS
    ),
    idleMs: envSeconds(env, "LOOP_BABYSIT_IDLE", DEFAULT_BABYSIT_IDLE_SECONDS),
    initialDriver: manifest?.primaryAgent,
    logFile: join(storage.runDir, "babysitter.jsonl"),
    llmDecodeConcurrency: envPositiveInt(
      env,
      "LOOP_BABYSIT_LLM_DECODE_CONCURRENCY",
      DEFAULT_LOCAL_LLM_DECODE_CONCURRENCY
    ),
    llmLogFile,
    llmPrefillStepSize: envPositiveInt(
      env,
      "LOOP_BABYSIT_LLM_PREFILL_STEP",
      DEFAULT_LOCAL_LLM_PREFILL_STEP_SIZE
    ),
    llmPromptCacheSlots: envPositiveInt(
      env,
      "LOOP_BABYSIT_LLM_CACHE_SLOTS",
      DEFAULT_LOCAL_LLM_PROMPT_CACHE_SLOTS
    ),
    llmPromptConcurrency: envPositiveInt(
      env,
      "LOOP_BABYSIT_LLM_PROMPT_CONCURRENCY",
      DEFAULT_LOCAL_LLM_PROMPT_CONCURRENCY
    ),
    llmTraceFile: llmTraceFileFromEnv(env, storage.runDir),
    judgeMode: envJudgeMode(env),
    judges: localJudgesFromEnv(env, primaryLocalJudge),
    maxRecoveries:
      Number.isInteger(maxRaw) && maxRaw > 0
        ? maxRaw
        : DEFAULT_BABYSIT_MAX_RECOVERIES,
    model,
    modelSizeGb: primaryLocalJudge.modelSizeGb,
    ntfyUrl: env.LOOP_BABYSIT_NTFY || undefined,
    roleBalanceEnabled: envEnabled(env.LOOP_BABYSIT_ROLE_BALANCE),
    runId,
    runDir: storage.runDir,
    session,
    stateFile: join(storage.runDir, "babysitter-state.json"),
    tickMs: envSeconds(env, "LOOP_BABYSIT_TICK", DEFAULT_BABYSIT_TICK_SECONDS),
    transcriptPath: join(storage.runDir, "transcript.jsonl"),
    url,
    usageTrackerSecret,
    usageTrackerTimeoutMs: envPositiveInt(
      env,
      "LOOP_USAGE_TRACKER_TIMEOUT_MS",
      DEFAULT_USAGE_TRACKER_TIMEOUT_MS
    ),
    usageTrackerUrl,
  };
};

// Long-running loop; runs in the babysitter pane until the session ends.
// The board renders every tick; the (slow) local-LLM summary and the both-idle
// "does the pair need you?" judgment run in the background so they never block a
// tick, and are folded in when they complete.
export const runBabysitter = async (
  config: BabysitConfig,
  deps: BabysitDeps = defaultBabysitDeps()
): Promise<void> => {
  const states = new Map<Agent, AgentLivenessState>();
  let runState = deps.loadState(config.stateFile) ?? freshRunState();
  // Light up the pane-border title strip and name the babysitter's own pane.
  // Done on every startup (including a replaced pane) so borders self-heal.
  deps.initPaneBorders(config.session);
  deps.setPaneLabel(babysitterPane(config), BABYSITTER_PANE_LABEL);
  let summaryText = runState.summary;
  let summaryTick = runState.summaryTick;
  let summaryInFlight = false;
  let pendingSummaryUsageByJudge = emptyLocalLlmUsageByJudge();
  let paneLabels = runState.paneLabels;
  let paneLabelTick = runState.paneLabelTick;
  const paneRenames = runState.paneRenames;
  let paneLabelInFlight = false;
  let pendingPaneLabelUsageByJudge = emptyLocalLlmUsageByJudge();
  let waitingAsk = runState.waitingAsk;
  let waitingConfirmed = runState.waitingConfirmed;
  let waitingAssessInFlight = false;
  let assessedForIdleSince = 0;
  let pendingWaitUsageByJudge = emptyLocalLlmUsageByJudge();
  for (;;) {
    // Fold any completed background work in before rendering this tick.
    const pendingLlmUsageByJudge = addLocalLlmUsageByJudge(
      addLocalLlmUsageByJudge(
        pendingSummaryUsageByJudge,
        pendingPaneLabelUsageByJudge
      ),
      pendingWaitUsageByJudge
    );
    const pendingLlmUsage = sumLocalLlmUsageByJudge(pendingLlmUsageByJudge);
    const nextLlmUsage = addLocalLlmUsage(runState.llmUsage, pendingLlmUsage);
    const nextLlmUsageByJudge = addLocalLlmUsageByJudge(
      runState.llmUsageByJudge,
      pendingLlmUsageByJudge
    );
    runState = {
      ...runState,
      llmUsage: nextLlmUsage,
      llmUsageByJudge: nextLlmUsageByJudge,
      llmTokens: nextLlmUsage.totalTokens,
      paneLabels,
      paneLabelTick,
      paneRenames,
      summary: summaryText,
      summaryTick,
      waitingAsk,
      waitingConfirmed,
    };
    pendingSummaryUsageByJudge = emptyLocalLlmUsageByJudge();
    pendingPaneLabelUsageByJudge = emptyLocalLlmUsageByJudge();
    pendingWaitUsageByJudge = emptyLocalLlmUsageByJudge();

    const result = await babysitTick(states, config, deps, runState);
    runState = result.runState;
    // updateBothIdle may have cleared the waiting read (agents went active).
    waitingConfirmed = runState.waitingConfirmed;
    waitingAsk = runState.waitingAsk;

    if (
      !summaryInFlight &&
      (summaryDue(summaryText, summaryTick, runState.tick) ||
        missingJudgeUsage(config, runState.llmUsageByJudge))
    ) {
      summaryInFlight = true;
      const firedAtTick = runState.tick;
      summarizeWithLocalJudges(config, deps, result.summaryCtxs, runState.tick)
        .then((summary) => {
          if (summary.text) {
            summaryText = summary.text;
          }
          summaryTick = firedAtTick;
          pendingSummaryUsageByJudge = addLocalLlmUsageByJudge(
            pendingSummaryUsageByJudge,
            summary.usageByJudge
          );
        })
        .catch(() => {
          // Best-effort; the next due tick retries.
        })
        .finally(() => {
          summaryInFlight = false;
        });
    }

    // Refresh the per-agent pane-border task labels off the tick, on the same
    // slow cadence as the summary. The composed title (glyph + agent + label)
    // is applied every tick inside babysitTick; only the label lags.
    if (!paneLabelInFlight && paneLabelsDue(paneLabelTick, runState.tick)) {
      paneLabelInFlight = true;
      const firedAtTick = runState.tick;
      labelPanesWithLocalJudges(config, deps, result.summaryCtxs, runState.tick)
        .then((res) => {
          if (Object.keys(res.labels).length > 0) {
            paneLabels = { ...paneLabels, ...res.labels };
            // Name each agent's session via /rename, but only when the value
            // changed and the agent is idle — don't re-send an unchanged
            // rename or inject keystrokes into an agent that is mid-turn.
            sendRenameCommands(
              config,
              deps,
              res.labels,
              paneRenames,
              result.agentStates
            );
          }
          paneLabelTick = firedAtTick;
          pendingPaneLabelUsageByJudge = addLocalLlmUsageByJudge(
            pendingPaneLabelUsageByJudge,
            res.usageByJudge
          );
        })
        .catch(() => {
          // Best-effort; the next due tick retries.
        })
        .finally(() => {
          paneLabelInFlight = false;
        });
    }

    // Once the pair has been idle together a while, ask the local LLM (once per
    // idle episode) whether they are actually blocked on the human.
    const idleSince = runState.bothIdleSince;
    if (idleSince === 0) {
      assessedForIdleSince = 0;
    } else if (
      !waitingAssessInFlight &&
      assessedForIdleSince !== idleSince &&
      deps.now() - idleSince >= BOTH_IDLE_ASSESS_MS
    ) {
      waitingAssessInFlight = true;
      const episode = idleSince;
      assessWaitingWithLocalJudges(
        config,
        deps,
        result.summaryCtxs,
        runState.tick
      )
        .then((assessment) => {
          waitingConfirmed = assessment.waiting;
          waitingAsk = assessment.ask;
          assessedForIdleSince = episode;
          pendingWaitUsageByJudge = addLocalLlmUsageByJudge(
            pendingWaitUsageByJudge,
            assessment.usageByJudge
          );
        })
        .catch(() => {
          // Best-effort; retried on the next tick.
        })
        .finally(() => {
          waitingAssessInFlight = false;
        });
    }

    deps.saveState(config.stateFile, runState);
    await deps.sleep(config.tickMs);
  }
};
