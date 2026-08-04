import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "bun";
import {
  dispatchBridgeMessage,
  type ImmediateBridgeDelivery,
} from "./bridge-dispatch";
import {
  deliverCodexBridgeMessage,
  deliverTmuxBridgeMessage,
  ensureBridgeWorker,
  hasBridgeDeliveryRoute,
  readBridgeRuntimeStatus,
} from "./bridge-runtime";
import {
  type BridgeEnqueueOptions,
  type BridgeMessage,
  readBridgeEvents,
} from "./bridge-store";
import { CAVEMAN_UPSTREAM_SHORT_SHA } from "./caveman";
import {
  DEFAULT_GOVERNESS_CONFIDENCE,
  DEFAULT_GOVERNESS_COOLDOWN_SECONDS,
  DEFAULT_GOVERNESS_ESCALATE_IDLE_SECONDS,
  DEFAULT_GOVERNESS_IDLE_SECONDS,
  DEFAULT_GOVERNESS_MAX_RECOVERIES,
  DEFAULT_GOVERNESS_MODEL,
  DEFAULT_GOVERNESS_TICK_SECONDS,
  DEFAULT_GOVERNESS_URL,
  DEFAULT_USAGE_TRACKER_TIMEOUT_MS,
  DEFAULT_USAGE_TRACKER_URL,
} from "./constants";
import { decode } from "./git";
import { readPriorSummaries, readProjectContext } from "./governess-context";
import {
  compactGovernessCycleSnapshot,
  decideGovernessCycle,
  executeGovernessCycle,
  type GovernessObservationSnapshot,
} from "./governess-cycle";
import { initLivenessState, updateLiveness } from "./governess-detect";
import {
  agentHasExited,
  type ExitControlState,
  exitKeyAction,
  freshExitControl,
  handoverContinuationFile,
  handoverContinuationText,
  handoverRequest,
  type KeyInput,
  openRawKeyInput,
  paneProbeFromTmuxResult,
  type ReplacementLaunchResult,
  readExitControl,
  replacementLoopArgs,
} from "./governess-exit";
import {
  acceptGovernessHandoff,
  ensureGovernessHandoffDir,
  governessHandoffFile,
  readGovernessHandoffAcceptance,
  readGovernessHandoffBundle,
  writeGovernessHandoffManifest,
} from "./governess-handoff";
import {
  recordGovernessObservation as appendGovernessObservation,
  ensureGovernessJournal,
  latestGovernessControlByKey,
  maintainGovernessJournal,
  prepareGovernessControl,
  readGovernessJournal,
  readPendingGovernessControlHistory,
  transitionGovernessControl,
} from "./governess-journal";
import {
  assessRoleBalance,
  assessWaiting,
  judgeAgent,
  LOCAL_LLM_JUDGE_MAX_TOKENS,
  LOCAL_LLM_SUMMARY_MAX_TOKENS,
  LOCAL_LLM_TEMPERATURE,
  labelPanes,
  summarizeSession,
} from "./governess-llm";
import { type EscalationEvent, sendNtfy } from "./governess-notify";
import { GOVERNESS_DEAD_PANE_BORDER_FORMAT } from "./governess-pane-liveness";
import {
  decideGovernessPolicy,
  type GovernessAction,
} from "./governess-policy";
import { decideRecovery, executeRecovery } from "./governess-recover";
import {
  driverLeaseIsCurrent,
  explicitAgentState,
  type GovernessLifecycleEvent,
  type GovernessRuntimeAdapter,
  lifecycleEventFromEvidence,
} from "./governess-runtime";
import { readAgentUsage, readHumanMessages } from "./governess-usage";
import {
  applyUsageTrackerPricing,
  createStableUsageLimitReader,
  type UsageLimitSnapshot,
} from "./governess-usage-limits";
import { buildLaunchArgv } from "./launch";
import {
  migrateLegacyGovernessState,
  withLegacyGovernessEnv,
} from "./legacy-governess-compat";
import {
  type NativeFallbackObservability,
  type NativeSubagentMode,
  processPendingNativeFallbackRequests,
  readNativeFallbackObservability,
  resolveNativeSubagentMode,
} from "./native-subagent";
import {
  cleanupRunOwnedProcesses,
  type RunProcessCleanupResult,
} from "./run-process-cleanup";
import {
  loadRunState,
  type RunManifest,
  readRunManifest,
  setRunManifestState,
  updateRunManifest,
} from "./run-state";
import {
  evaluateSessionPressure,
  highestSessionPressure,
  pressureAtOrAboveHandoff,
  readSessionPressureByAgent,
  type SessionPressureByAgent,
  type SessionPressureDecision,
  type SessionPressureMode,
  sessionPressureModeFromEnv,
} from "./session-pressure";
import {
  boundedTmuxOptions,
  isTmuxControlUnavailableError,
  TmuxControlUnavailableError,
  tmuxCommandTimedOut,
  tmuxSessionLiveness,
} from "./tmux-control";
import type {
  Agent,
  AgentLiveness,
  AgentLivenessState,
  AgentUsage,
  CavemanMode,
  GovernessVerdict,
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
  UsageLimitWindow,
  WaitingRequest,
  WaitingResult,
} from "./types";
import {
  UTILITY_AU_PAIR_TIER,
  UTILITY_DIRECT_TIER,
  UTILITY_NANNY_TIER,
} from "./utility-execution-tier";
import {
  readUtilityObservability,
  type UtilityObservabilitySnapshot,
} from "./utility-observability";
import { processPendingUtilityRoutes } from "./utility-runtime";
import { activateUtilityEpoch } from "./utility-store";

export const GOVERNESS_SUBCOMMAND = "__governess";

const HOOK_TAIL_LIMIT = 20;
const NUDGE_TEXT = "governess: you look idle — status? are you blocked?";
const PANE_HASH_LENGTH = 12;
const LIMIT_HANDOFF_PCT = 95;
const PROACTIVE_BALANCE_PCT = 80;
const PROACTIVE_BALANCE_ADVANTAGE_PCT = 15;
const PROACTIVE_BALANCE_MIN_CONFIDENCE = 0.6;

export interface GovernessAgentInfo {
  agent: Agent;
  // Per-run CODEX_HOME, so Codex usage transcripts under it can be located.
  codexHome?: string;
  hookFile: string;
  pane: string;
  // Session id / thread id used to locate the agent's usage transcript.
  sessionRef?: string;
}

export interface AgentSessionBindingChange {
  agent: Agent;
  current: string;
  previous?: string;
}

export interface LocalLlmJudgeConfig {
  id: string;
  logFile?: string;
  model: string;
  modelSizeGb?: number;
  url: string;
}

export type LocalLlmJudgeMode = "consensus" | "round-robin";

export interface GovernessConfig {
  // Sending slash commands into agent TUIs is unsafe around composer drafts, so
  // session rename is opt-in; pane-border labels remain enabled independently.
  agentRenameEnabled: boolean;
  agents: GovernessAgentInfo[];
  // Session cost ceiling (USD) for the budget line + escalation; 0 disables.
  budgetUsd: number;
  cavemanMode?: CavemanMode;
  confidence: number;
  cooldownMs: number;
  // Run manifest creation time, for session uptime.
  createdAt?: string;
  // Working directory of the run, for reading project docs into the summary.
  cwd?: string;
  dryRun: boolean;
  // Fencing epoch acquired by the currently running governess process.
  epoch?: number;
  // How long an agent may sit waiting-for-human before we escalate.
  escalateIdleMs: number;
  helperCavemanMode?: CavemanMode;
  idleMs: number;
  initialDriver?: Agent;
  journalFile?: string;
  judgeMode: LocalLlmJudgeMode;
  judges?: LocalLlmJudgeConfig[];
  // Explicit compatibility switch; quota observations never change drivers
  // unless this is enabled at process configuration time.
  limitHandoffEnabled?: boolean;
  llmDecodeConcurrency: number;
  llmLogFile?: string;
  llmPrefillStepSize: number;
  llmPromptCacheSlots: number;
  llmPromptConcurrency: number;
  llmTraceFile?: string;
  logFile: string;
  // Manifest updated when an explicit exit path stops this run.
  manifestPath?: string;
  maxRecoveries: number;
  model: string;
  // On-disk size (GB) of the local LLM, shown in the footer.
  modelSizeGb?: number;
  nativeSubagentMode?: NativeSubagentMode;
  // ntfy topic URL for remote escalation; escalation is off when unset.
  ntfyUrl?: string;
  roleBalanceEnabled: boolean;
  // Run directory, for reading prior-session summaries into the summary.
  runDir?: string;
  runId: string;
  session: string;
  // Context-first loop freshness policy. Programmatic/test configs that omit
  // it remain off; resolved live configs explicitly default to enforce.
  sessionPressureMode?: SessionPressureMode;
  // Persisted run-state file, so stats survive governess restarts.
  stateFile?: string;
  tickMs: number;
  // Path to the run transcript (bridge messages between agents).
  transcriptPath?: string;
  url: string;
  usageTrackerSecret?: string;
  usageTrackerTimeoutMs: number;
  usageTrackerUrl?: string;
  // Optional deterministic render budget for tests/non-TTY callers. A live
  // pane uses the current stdout height when this is absent.
  viewportColumns?: number;
  viewportRows?: number;
}

const manifestSessionRef = (
  manifest: RunManifest,
  agent: Agent
): string | undefined => {
  if (agent === "claude") {
    return manifest.claudeSessionId || undefined;
  }
  if (agent === "codex") {
    return manifest.codexThreadId || undefined;
  }
  return undefined;
};

// Session identifiers can be filled or corrected after the governess process
// has already resolved its startup config. Refresh from the canonical manifest
// before each usage read, but never erase a known-good binding when a manifest
// is transiently absent, malformed, or contains an empty identifier.
export const refreshGovernessAgentBindings = (
  config: Pick<GovernessConfig, "agents" | "manifestPath">,
  readManifest: (path: string) => RunManifest | undefined = readRunManifest
): AgentSessionBindingChange[] => {
  if (!config.manifestPath) {
    return [];
  }
  const manifest = readManifest(config.manifestPath);
  if (!manifest) {
    return [];
  }
  const changes: AgentSessionBindingChange[] = [];
  for (const info of config.agents) {
    const current = manifestSessionRef(manifest, info.agent);
    if (!current || current === info.sessionRef) {
      continue;
    }
    changes.push({
      agent: info.agent,
      current,
      ...(info.sessionRef ? { previous: info.sessionRef } : {}),
    });
    info.sessionRef = current;
  }
  return changes;
};

// Per-agent bridge message counts, keyed by sender then recipient.
export type BridgeCounts = Record<string, Record<string, number>>;
export type BridgeLatest = Record<string, Record<string, BridgeMessage>>;
export type BridgeSendStatus = "accepted" | "delivered" | "queued";
export type LocalLlmUsageByJudge = Record<string, LocalLlmUsage>;

export interface GovernessDeps {
  appendLog: (file: string, record: unknown) => void;
  assessRoleBalance: (req: RoleBalanceRequest) => Promise<RoleBalanceResult>;
  assessWaiting: (req: WaitingRequest) => Promise<WaitingResult>;
  capturePane: (pane: string) => string;
  cleanupRunProcesses?: (
    config: GovernessConfig
  ) => RunProcessCleanupResult | undefined;
  fenceCurrent?: (config: GovernessConfig) => boolean;
  // Turn on the pane-border title strip for the whole session (idempotent).
  initPaneBorders: (session: string) => void;
  judge: (req: JudgeRequest) => Promise<JudgeOutcome>;
  killSession?: (session: string) => void;
  labelPanes: (req: PaneLabelRequest) => Promise<PaneLabelResult>;
  launchReplacementLoop?: (config: GovernessConfig) => ReplacementLaunchResult;
  loadState: (stateFile?: string) => GovernessRunState | undefined;
  markRunStopped?: (config: GovernessConfig, reason: string) => void;
  notify: (ntfyUrl: string | undefined, event: EscalationEvent) => void;
  now: () => number;
  openKeyInput?: () => KeyInput | undefined;
  paneCommand?: (pane: string) => string | undefined;
  readBridge: (transcriptPath?: string) => BridgeCounts;
  readBridgeLatest: (runDir?: string) => BridgeLatest;
  readHooks: (file: string) => HookEvent[];
  readHumanMessages: (
    agent: Agent,
    sessionRef?: string,
    codexHome?: string
  ) => string[];
  readLocalLlmRuntime: (input: LocalLlmRuntimeInput) => LocalLlmRuntime;
  readPaneCommands?: (
    panes: GovernessAgentInfo[]
  ) => Partial<Record<Agent, string>>;
  readUsage: (
    agent: Agent,
    sessionRef?: string,
    codexHome?: string
  ) => AgentUsage;
  readUsageLimits: (
    config: GovernessConfig
  ) => Promise<UsageLimitSnapshot | undefined>;
  render: (text: string) => void;
  replacementSessionAlive?: (session: string) => boolean | "unknown";
  replacementSessionReady: (session: string) => boolean | "unknown";
  respawnPane: (pane: string) => void;
  saveState: (stateFile: string | undefined, state: GovernessRunState) => void;
  sendBridge: (
    runDir: string,
    source: Agent,
    target: Agent,
    message: string,
    options?: BridgeEnqueueOptions
  ) => Promise<BridgeSendStatus>;
  sendKeys: (pane: string, keys: string[]) => void;
  sendText: (pane: string, text: string) => void;
  // Pin both the visible border label and tmux's native title for the
  // governess pane. Agent panes intentionally use setPaneLabel only.
  setGovernessPaneIdentity: (pane: string, label: string) => void;
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

export interface DriverLease {
  epoch: number;
  expiresAt: string;
  holder: Agent;
}

export interface GovernessTmuxControlState {
  lastFailureAtMs: number;
  reason: string;
  unavailableSinceMs: number;
}

// State the governess carries across ticks.
export interface GovernessRunState {
  // Epoch ms both agents became idle together (0 = not both idle right now).
  bothIdleSince: number;
  driverLease?: DriverLease;
  exitControl: ExitControlState;
  governessEpoch: number;
  governessMessages: Record<string, number>;
  handoverBundles: Partial<Record<Agent, string>>;
  history: RecoveryHistoryEntry[];
  lifecycleEvents: Partial<Record<Agent, GovernessLifecycleEvent>>;
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
  sessionPressure: SessionPressureByAgent;
  sessionPressurePrepared: Partial<Record<Agent, boolean>>;
  stats: SessionStats;
  summary: string;
  summaryTick: number;
  tick: number;
  tmuxControl?: GovernessTmuxControlState;
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

const readAgentBooleanMap = (
  value: unknown
): Partial<Record<Agent, boolean>> => {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const result: Partial<Record<Agent, boolean>> = {};
  for (const agent of AGENT_VALUES) {
    if ((value as Record<string, unknown>)[agent] === true) {
      result[agent] = true;
    }
  }
  return result;
};

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

const readTmuxControlState = (
  value: unknown
): GovernessTmuxControlState | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Partial<GovernessTmuxControlState>;
  if (
    typeof record.lastFailureAtMs !== "number" ||
    !Number.isFinite(record.lastFailureAtMs) ||
    typeof record.unavailableSinceMs !== "number" ||
    !Number.isFinite(record.unavailableSinceMs) ||
    typeof record.reason !== "string" ||
    !record.reason.trim()
  ) {
    return undefined;
  }
  return {
    lastFailureAtMs: record.lastFailureAtMs,
    reason: record.reason,
    unavailableSinceMs: record.unavailableSinceMs,
  };
};

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

export const freshRunState = (): GovernessRunState => ({
  governessMessages: {},
  bothIdleSince: 0,
  exitControl: freshExitControl(),
  governessEpoch: 0,
  handoverBundles: {},
  history: [],
  lifecycleEvents: {},
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
  sessionPressure: {},
  sessionPressurePrepared: {},
  stats: { activeMs: {}, humanIdleMs: 0, idleMs: {} },
  summary: "",
  summaryTick: -1,
  tick: 0,
  waitingAsk: "",
  waitingConfirmed: false,
});

export interface GovernessTickResult {
  // Per-agent display state this tick (working/thinking/idle/limited/...), so a
  // background rename can skip agents that are mid-turn.
  agentStates: Partial<Record<Agent, string>>;
  board: string;
  llmOffline: boolean;
  paneCommands: Partial<Record<Agent, string>>;
  runState: GovernessRunState;
  sessionPressure: SessionPressureByAgent;
  states: Map<Agent, AgentLivenessState>;
  // Per-agent contexts a background summary refresh consumes (see runGoverness).
  summaryCtxs: SummaryAgentContext[];
  tmuxControlAvailable: boolean;
}

const hashPane = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, PANE_HASH_LENGTH);

const lastEventTs = (events: HookEvent[]): string | undefined =>
  events.length > 0 ? events.at(-1)?.ts : undefined;

// Agents render their own live context remaining in the pane statusline
// (e.g. "ctx: 91%"). Convert it to used context for this board's CTX cell.
const PANE_CTX_RE = /ctx:?\s*(\d+)\s*%/i;
const PANE_EFFORT_RE = /effort:?\s*(low|medium|high|max|xhigh|ultra)\b/giu;
const SESSION_LIMIT_RE =
  /\b(hit|reached)\s+(your\s+)?(session|usage|rate)\s+limit\b|\b(rate|usage|session)\s+limit\b/i;
const CONTEXT_COMPACT_RE =
  /\b(context|ctx)\b.*\b(compact|window|full|limit)\b|\b(compact|compress)\b.*\b(context|ctx)\b/i;
const GOVERNESS_PROMPT_RE = /\bgoverness:/i;
const AVAILABLE_LIMIT_RESET_RE =
  /\byou have\s+\d+\s+usage limit resets?\s+available\b/gi;
const LINE_SPLIT_RE = /\r?\n/;
const TRAILING_DECIMAL_ZERO_RE = /\.0$/;
const TRAILING_DECIMAL_ZEROES_RE = /\.0+$/;
const MODEL_FAMILY_SEPARATOR_RE = /[-_]/;
const BRIDGE_SEND_TOOL_RE = /^mcp__loop-bridge-.+__send_message$/;
const BRIDGE_RECEIVE_TOOL_RE = /^mcp__loop-bridge-.+__receive_messages$/;
const NONEMPTY_COMPOSER_RE = /^\s*[›❯>]\s+\S/;
const STARTED_TMUX_SESSION_RE = /started tmux session "([^"]+)"/;
const parsePaneCtxRemainingPct = (paneText: string): number | undefined => {
  const match = paneText.match(PANE_CTX_RE);
  if (!match) {
    return undefined;
  }
  const pct = Number.parseInt(match[1], 10);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : undefined;
};

const parsePaneEffort = (paneText: string): string | undefined => {
  const matches = [...paneText.matchAll(PANE_EFFORT_RE)];
  return matches.at(-1)?.[1]?.toLowerCase();
};

// Only the TAIL of the pane counts as "current state": an idle agent produces
// no new output, so a pre-reset limit banner higher up would otherwise match
// forever — invisible to manual limit resets (the loop-23 stale-limit bug).
// Any newer output (model change, ack, turn) pushes the banner above the
// window and clears the verdict.
const SESSION_LIMIT_TAIL_LINES = 20;

const isSessionLimited = (paneText: string): boolean =>
  paneText
    .split(LINE_SPLIT_RE)
    .filter((line) => line.trim().length > 0)
    .slice(-SESSION_LIMIT_TAIL_LINES)
    .join("\n")
    .replace(AVAILABLE_LIMIT_RESET_RE, "")
    .split("\n")
    .some(
      (line) =>
        !GOVERNESS_PROMPT_RE.test(line) &&
        SESSION_LIMIT_RE.test(line) &&
        !CONTEXT_COMPACT_RE.test(line)
    );

const governessFenceCurrent = (
  config: GovernessConfig,
  deps: GovernessDeps
): boolean =>
  typeof config.epoch === "number" && deps.fenceCurrent?.(config) === true;

const controlKey = (
  config: GovernessConfig,
  action: GovernessAction,
  agent: Agent | undefined,
  payload: string
): string =>
  `${config.epoch ?? 0}:${action}:${agent ?? "loop"}:${createHash("sha256")
    .update(payload)
    .digest("hex")}`;

const runJournaledControl = (
  config: GovernessConfig,
  deps: GovernessDeps,
  input: {
    action: GovernessAction;
    agent?: Agent;
    confirmed?: boolean;
    deterministicReason?: boolean;
    payload: string;
    targetSafe?: boolean;
  },
  effect: () => void
): boolean => {
  const policy = decideGovernessPolicy(input.action, {
    confirmed: input.confirmed,
    deterministicReason: input.deterministicReason,
    fenceCurrent: governessFenceCurrent(config, deps),
    targetSafe: input.targetSafe,
  });
  const policyContext = {
    confirmed: input.confirmed,
    deterministicReason: input.deterministicReason,
    fenceCurrent: governessFenceCurrent(config, deps),
    targetSafe: input.targetSafe,
  };
  if (!policy.allowed) {
    deps.appendLog(config.logFile, {
      action: input.action,
      at: new Date(deps.now()).toISOString(),
      event: "control-denied",
      reason: policy.reason,
    });
    return false;
  }
  if (!config.journalFile) {
    effect();
    return true;
  }
  const now = new Date(deps.now()).toISOString();
  const record = prepareGovernessControl(config.journalFile, {
    action: input.action,
    agent: input.agent,
    at: now,
    epoch: config.epoch ?? 0,
    idempotencyKey: controlKey(
      config,
      input.action,
      input.agent,
      input.payload
    ),
    payload: input.payload,
    policyClass: policy.class,
    policyContext,
  });
  if (record.phase !== "prepared") {
    return false;
  }
  transitionGovernessControl(
    config.journalFile,
    record.controlId,
    "dispatched",
    now
  );
  try {
    effect();
    transitionGovernessControl(
      config.journalFile,
      record.controlId,
      input.agent ? "accepted" : "completed",
      new Date(deps.now()).toISOString(),
      undefined,
      { transport: input.agent ? "tmux-fallback" : "internal" }
    );
    return true;
  } catch (error) {
    transitionGovernessControl(
      config.journalFile,
      record.controlId,
      "failed",
      new Date(deps.now()).toISOString(),
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
};

const recordGovernessObservation = (
  config: GovernessConfig,
  deps: GovernessDeps,
  input: {
    agent?: Agent;
    idempotencyKey: string;
    payload: string;
    semanticPayload?: string;
    stream: string;
  }
): void => {
  if (!config.journalFile) {
    return;
  }
  const policy = decideGovernessPolicy("observe-runtime", {
    fenceCurrent: governessFenceCurrent(config, deps),
  });
  const result = appendGovernessObservation(config.journalFile, {
    agent: input.agent,
    at: new Date(deps.now()).toISOString(),
    epoch: config.epoch ?? 0,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    policyClass: policy.class,
    policyContext: { fenceCurrent: governessFenceCurrent(config, deps) },
    semanticPayload: input.semanticPayload,
    stream: input.stream,
  });
  if (result.written && input.stream === "governess-cycle") {
    maintainGovernessJournal(config.journalFile);
  }
};

// Build the per-agent recovery executors on top of the injected tmux deps.
const buildRecoveryDeps = (
  info: GovernessAgentInfo,
  deps: GovernessDeps,
  config: GovernessConfig
) => ({
  answerPrompt: (_agent: Agent) => {
    runJournaledControl(
      config,
      deps,
      {
        action: "answer-prompt",
        agent: info.agent,
        payload: "Enter",
        targetSafe: true,
      },
      () => deps.sendKeys(info.pane, ["Enter"])
    );
  },
  nudge: (_agent: Agent) => {
    runJournaledControl(
      config,
      deps,
      {
        action: "nudge",
        agent: info.agent,
        payload: NUDGE_TEXT,
        targetSafe: true,
      },
      () => {
        deps.sendText(info.pane, NUDGE_TEXT);
        deps.sendKeys(info.pane, ["Enter"]);
      }
    );
  },
  restart: (_agent: Agent) => {
    // Automatic restarts are deliberately denied by policy. A future explicit
    // UI confirmation can call this with confirmed=true.
    runJournaledControl(
      config,
      deps,
      {
        action: "restart-agent",
        agent: info.agent,
        confirmed: false,
        payload: info.pane,
      },
      () => deps.respawnPane(info.pane)
    );
  },
  log: (entry: RecoveryHistoryEntry, dryRun: boolean) => {
    deps.appendLog(config.logFile, { dryRun, kind: "action", ...entry });
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
  n >= 1000
    ? `${(n / 1000).toFixed(1).replace(TRAILING_DECIMAL_ZERO_RE, "")}k`
    : String(n);

const fmtGb = (n: number): string =>
  `${n.toFixed(n >= 10 ? 1 : 2).replace(TRAILING_DECIMAL_ZEROES_RE, "")}GB`;

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
const ANSI_COLOR_SEQUENCE_RE = /^\x1b\[[0-9;]*m/;
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

const fitAnsiLine = (value: string, width: number): string => {
  const visible = value.replaceAll(/\x1b\[[0-9;]*m/g, "");
  if (visible.length <= width) {
    return value;
  }
  const limit = Math.max(0, width - 1);
  let rendered = "";
  let visibleCount = 0;
  for (let index = 0; index < value.length && visibleCount < limit; ) {
    const tail = value.slice(index);
    const ansi = tail.match(ANSI_COLOR_SEQUENCE_RE)?.[0];
    if (ansi) {
      rendered += ansi;
      index += ansi.length;
      continue;
    }
    const glyph = String.fromCodePoint(value.codePointAt(index) ?? 0);
    rendered += glyph;
    visibleCount += glyph.length;
    index += glyph.length;
  }
  return `${rendered}…${ANSI.reset}`;
};
const cell = (text: string, width: number): string => text.padEnd(width);
const capitalize = (value: string): string =>
  value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
const fitCell = (text: string, width: number): string =>
  cell(truncate(text, width), width);
const subcells = (
  values: readonly string[],
  widths: readonly number[],
  alignment: "left" | "right" = "right"
): string =>
  values
    .map((value, index) => {
      const width = widths[index] ?? 0;
      const fitted = truncate(value, width);
      return alignment === "left"
        ? fitted.padEnd(width)
        : fitted.padStart(width);
    })
    .join(" ");
const colorCell = (code: string, text: string, width: number): string =>
  paint(code, fitCell(text, width));
const pad2 = (n: number): string => String(n).padStart(2, "0");
// Local wall-clock time from epoch ms.
const fmtClock = (nowMs: number): string => {
  const d = new Date(nowMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const CLAUDE_PREFIX_RE = /^claude-/;
const SHORT_MODEL_WIDTH = 12;
const shortModel = (model?: string): string =>
  model ? model.replace(CLAUDE_PREFIX_RE, "").slice(0, SHORT_MODEL_WIDTH) : "—";
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
  return name.split(MODEL_FAMILY_SEPARATOR_RE)[0] || "llm";
};

const primaryJudge = (config: GovernessConfig): LocalLlmJudgeConfig =>
  config.judges?.[0] ?? {
    id: judgeIdFromModel(config.model),
    logFile: config.llmLogFile,
    model: config.model,
    modelSizeGb: config.modelSizeGb,
    url: config.url,
  };

const localJudges = (config: GovernessConfig): LocalLlmJudgeConfig[] =>
  config.judges?.length ? config.judges : [primaryJudge(config)];

const localJudgesForTick = (
  config: GovernessConfig,
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

const tokenCell = (tokens: number): string =>
  tokens > 0 ? fmtTokens(tokens) : "—";

const costBurnCell = (u: AgentUsage, activeMs: number): string => {
  const perHr =
    u.costUsd > 0 && activeMs >= MS_PER_MINUTE
      ? u.costUsd / (activeMs / MS_PER_HOUR)
      : u.costRateUsdPerHour;
  return perHr > 0 ? `$${perHr.toFixed(0)}` : "—";
};

const usageLimitWindows = (u: AgentUsage): UsageLimitWindow[] => {
  if (u.rateLimitWindows?.length) {
    return u.rateLimitWindows;
  }
  return [
    ...(u.rateLimitPrimaryPct === undefined
      ? []
      : [
          {
            kind: "session" as const,
            label: "Session",
            reset: u.rateLimitPrimaryReset,
            usedPct: u.rateLimitPrimaryPct,
          },
        ]),
    ...(u.rateLimitSecondaryPct === undefined
      ? []
      : [
          {
            kind: "weekly" as const,
            label: "Weekly",
            reset: u.rateLimitSecondaryReset,
            usedPct: u.rateLimitSecondaryPct,
          },
        ]),
  ];
};

const limitKindCell = (kind: UsageLimitWindow["kind"]): string => {
  if (kind === "session") {
    return "S";
  }
  return kind === "weekly" ? "W" : "A";
};

const pctCell = (pct: number): string =>
  Number.isInteger(pct) ? String(pct) : pct.toFixed(1);

const rateLimitCell = (u: AgentUsage): string => {
  const windows = usageLimitWindows(u);
  return windows.length > 0
    ? windows
        .map(
          (window) => `${limitKindCell(window.kind)}${pctCell(window.usedPct)}`
        )
        .join("/")
    : "—";
};

const RESET_DATE_RE = /\b\d{4}\b/;
const RESET_TEXT_RE =
  /^(?:(?<month>[a-z]{3,9})\s+(?<day>\d{1,2})(?:\s+(?<year>\d{4}))?(?:\s+at)?\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)$/i;
const RESET_MONTHS: Record<string, number> = {
  apr: 3,
  aug: 7,
  dec: 11,
  feb: 1,
  jan: 0,
  jul: 6,
  jun: 5,
  mar: 2,
  may: 4,
  nov: 10,
  oct: 9,
  sep: 8,
};

const parseResetTime = (
  reset: string | undefined,
  nowMs: number
): { date: Date } | undefined => {
  const raw = reset?.trim();
  if (!raw) {
    return undefined;
  }
  const now = new Date(nowMs);
  const parsed = Date.parse(
    RESET_DATE_RE.test(raw) ? raw : `${raw} ${now.getFullYear()}`
  );
  if (Number.isFinite(parsed)) {
    return { date: new Date(parsed) };
  }
  const match = raw.match(RESET_TEXT_RE);
  if (!match?.groups) {
    return undefined;
  }
  const monthText = match.groups.month?.slice(0, 3).toLowerCase();
  const month = monthText ? RESET_MONTHS[monthText] : now.getMonth();
  const day = match.groups.day ? Number(match.groups.day) : now.getDate();
  const explicitYear = match.groups.year
    ? Number(match.groups.year)
    : undefined;
  const hour12 = Number(match.groups.hour);
  const minute = Number(match.groups.minute ?? 0);
  if (
    month === undefined ||
    day < 1 ||
    day > 31 ||
    hour12 < 1 ||
    hour12 > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return undefined;
  }
  const hour =
    (hour12 % 12) + (match.groups.meridiem.toLowerCase() === "pm" ? 12 : 0);
  const date = new Date(
    explicitYear ?? now.getFullYear(),
    month,
    day,
    hour,
    minute
  );
  if (!explicitYear && date.getTime() <= nowMs) {
    if (match.groups.month) {
      date.setFullYear(date.getFullYear() + 1);
    } else {
      date.setDate(date.getDate() + 1);
    }
  }
  return { date };
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

const rateLimitColor = (u: AgentUsage): string | undefined => {
  const high = Math.max(
    0,
    ...usageLimitWindows(u).map((window) => window.usedPct)
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

const modeParts = (u: AgentUsage): [string, string] => {
  const raw = (u.speed ?? u.serviceTier)?.toLowerCase();
  if (!raw) {
    return ["—", "—"];
  }
  let mode = raw;
  if (raw === "standard") {
    mode = "std";
  } else if (raw === "priority") {
    mode = "fast";
  }
  return [
    mode,
    u.creditCostMultiplier ? multiplierLabel(u.creditCostMultiplier) : "—",
  ];
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
  paneFresh: boolean;
  thinking: boolean;
  usage: AgentUsage;
  verdict?: GovernessVerdict;
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
  auPair?: UtilityObservabilitySnapshot;
  bridge: BridgeCounts;
  bridgeLatest: BridgeLatest;
  budgetUsd: number;
  cavemanMode?: CavemanMode;
  direct?: UtilityObservabilitySnapshot;
  governessMessages: Record<string, number>;
  helperCavemanMode?: CavemanMode;
  identity: string;
  initialDriver?: Agent;
  judgeMode: LocalLlmJudgeMode;
  llmJudges: LocalLlmJudgeConfig[];
  llmOfflineByJudge: Record<string, boolean>;
  llmRuntimeByJudge: Record<string, LocalLlmRuntime>;
  llmUsageByJudge: LocalLlmUsageByJudge;
  maxColumns?: number;
  maxRows?: number;
  nanny?: UtilityObservabilitySnapshot;
  nativeFallback?: NativeFallbackObservability;
  nowMs: number;
  recoveries: number;
  roles: RoleState;
  stats: SessionStats;
  summary: string;
  tickMs: number;
  tmuxControl?: GovernessTmuxControlState;
  uptimeMs: number;
  utility?: UtilityObservabilitySnapshot;
  waitingForYou: WaitingForYou;
}

const AGENT_COL = {
  agent: 7,
  state: 12,
  age: 5,
  model: 12,
  run: 14,
  context: 18,
  limits: 25,
  spend: 12,
  tokens: 24,
  activity: 16,
  bridge: 18,
} as const;

const AGENT_COLUMNS: [string, number][] = [
  ["AGENT", AGENT_COL.agent],
  ["STATE", AGENT_COL.state],
  ["AGE", AGENT_COL.age],
  ["MODEL", AGENT_COL.model],
  [subcells(["EFF", "MODE", "X"], [4, 4, 4]), AGENT_COL.run],
  [subcells(["USED/MAX", "PCT", "CMP"], [9, 4, 3]), AGENT_COL.context],
  [subcells(["LIMITS", "RESET"], [9, 15], "left"), AGENT_COL.limits],
  [subcells(["COST", "RATE"], [7, 4]), AGENT_COL.spend],
  [
    subcells(["TOTAL", "INPUT", "CACHE", "OUTPUT"], [5, 5, 5, 6]),
    AGENT_COL.tokens,
  ],
  [subcells(["TEXT", "THINK", "TOOL"], [5, 5, 4]), AGENT_COL.activity],
  ["HUMAN/BRIDGE", AGENT_COL.bridge],
];

const agentHeaderRow = paint(
  ANSI.dim,
  ` ${AGENT_COLUMNS.map(([label, width]) => cell(label, width)).join(" ")}`
);

const HELPER_COL = {
  agent: AGENT_COL.agent,
  state: AGENT_COL.state,
  age: AGENT_COL.age,
  model: AGENT_COL.model,
  run: AGENT_COL.run,
  context: AGENT_COL.context,
  limits: AGENT_COL.limits,
  spend: AGENT_COL.spend,
  tokens: AGENT_COL.tokens,
  activity: AGENT_COL.activity,
} as const;

const HELPER_COLUMNS: [string, number][] = [
  ["HELPER", HELPER_COL.agent],
  ["STATE", HELPER_COL.state],
  ["AGE", HELPER_COL.age],
  ["MODEL", HELPER_COL.model],
  [subcells(["OK", "FAIL"], [6, 7]), HELPER_COL.run],
  [subcells(["ACTIVE", "QUEUE"], [8, 9]), HELPER_COL.context],
  ["CTX MISS", HELPER_COL.limits],
  [subcells(["COST", ""], [7, 4]), HELPER_COL.spend],
  [
    subcells(["TOTAL", "INPUT", "CACHE", "OUTPUT"], [5, 5, 5, 6]),
    HELPER_COL.tokens,
  ],
  [subcells(["CALLS", "TOOLS"], [5, 10]), HELPER_COL.activity],
];

const helperHeaderRow = paint(
  ANSI.dim,
  ` ${HELPER_COLUMNS.map(([label, width]) => cell(label, width)).join(" ")}`
);

const headedHelperRows = (rows: string[]): string[] =>
  rows.length > 0 ? [helperHeaderRow, ...rows] : [];

const rowState = (row: AgentRow): string =>
  row.paneFresh
    ? (row.verdict?.state ?? (row.thinking ? "thinking" : "idle"))
    : "unknown";

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

// The governess's own pane: its live tmux pane id when running inside tmux,
// else the conventional bottom pane of the paired session.
const governessPane = (config: GovernessConfig): string =>
  process.env.TMUX_PANE ?? `${config.session}:0.2`;

export const composeGovernessPaneTitle = (
  config: Pick<GovernessConfig, "session">
): string => `governess.${config.session}`;

export const composeGovernessRunIdentity = (
  config: Pick<GovernessConfig, "cwd" | "session">
): string => `${config.session} · ${resolve(config.cwd ?? process.cwd())}`;

export const applyGovernessPaneIdentity = (
  config: GovernessConfig,
  deps: Pick<GovernessDeps, "setGovernessPaneIdentity">,
  pane = governessPane(config)
): void => {
  deps.setGovernessPaneIdentity(pane, composeGovernessPaneTitle(config));
};

export const governessPaneIdentityTmuxCommands = (
  pane: string,
  label: string
): string[][] => [
  ["set-option", "-p", "-t", pane, "@loop_label", label],
  ["select-pane", "-t", pane, "-T", label],
];

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
  config: GovernessConfig,
  deps: GovernessDeps,
  rows: AgentRow[],
  runState: GovernessRunState
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
const RENAME_SAFE_STATES = new Set(["idle", "waiting-human"]);

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
  config: GovernessConfig,
  deps: GovernessDeps,
  labels: Partial<Record<Agent, string>>,
  lastRenames: Partial<Record<Agent, string>>,
  states: Partial<Record<Agent, string>> = {}
): void => {
  if (!config.agentRenameEnabled || config.dryRun) {
    return;
  }
  for (const info of config.agents) {
    const label = labels[info.agent];
    if (!label) {
      continue;
    }
    const state = states[info.agent];
    if (
      !state ||
      RENAME_BUSY_STATES.has(state) ||
      !RENAME_SAFE_STATES.has(state) ||
      !directInputIsSafe(deps, info)
    ) {
      continue;
    }
    const command = renameCommand(config.session, label);
    // The map value holds the last few sent commands newline-joined (it stays
    // a plain string so governess-state.json persistence is unchanged).
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
    const sent = runJournaledControl(
      config,
      deps,
      {
        action: "send-control",
        agent: info.agent,
        payload: command,
        targetSafe: true,
      },
      () => {
        deps.sendText(info.pane, command);
        deps.sendKeys(info.pane, ["Enter"]);
      }
    );
    if (!sent) {
      if (history.length > 0) {
        lastRenames[info.agent] = history.join("\n");
      } else {
        delete lastRenames[info.agent];
      }
    }
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
    ? colorCell(ANSI.yellow, "⏳ waits you", AGENT_COL.state)
    : colorCell(stateColor(state), `● ${stateLabel(state)}`, AGENT_COL.state);

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

const resetEtaCell = (
  reset: string | undefined,
  nowMs: number,
  resetAtMs?: number
): string => {
  const parsedMs =
    resetAtMs !== undefined && Number.isFinite(resetAtMs)
      ? resetAtMs
      : parseResetTime(reset, nowMs)?.date.getTime();
  if (parsedMs === undefined) {
    return reset?.trim() || "—";
  }
  const totalMinutes = Math.max(
    0,
    Math.floor((parsedMs - nowMs) / MS_PER_MINUTE)
  );
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 48) {
    return `${totalHours}h${minutes > 0 ? `${String(minutes).padStart(2, "0")}m` : ""}`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d${hours > 0 ? `${hours}h` : ""}`;
};

const renderAgentRow = (
  row: AgentRow,
  meta: BoardMeta,
  weeklyLimitIndent: number
): string => {
  const agent = row.liveness.agent;
  const state = rowState(row);
  let forMs = Number.NaN;
  if (row.paneFresh) {
    forMs = row.thinking
      ? row.liveness.lastEventAgeMs
      : row.liveness.paneIdleMs;
  }
  const [mode, multiplier] = modeParts(row.usage);
  const run = subcells([effortCell(row.usage), mode, multiplier], [4, 4, 4]);
  const ctxText = subcells(
    [
      row.usage.contextTokens > 0
        ? `${fmtTokens(row.usage.contextTokens)}/${fmtTokens(row.usage.contextWindow)}`
        : "—",
      row.usage.contextTokens > 0 ? `${contextPct(row.usage)}%` : "—",
      `c${row.usage.compactions}`,
    ],
    [9, 4, 3]
  );
  const ctxWarn = contextPct(row.usage) > CONTEXT_ALERT_PCT;
  const ctx = ctxWarn
    ? colorCell(ANSI.red, ctxText, AGENT_COL.context)
    : fitCell(ctxText, AGENT_COL.context);
  const tok = tokenCell(row.usage.totalTokens);
  const inputTok = tokenCell(row.usage.inputTokens);
  const cachedTok = tokenCell(
    row.usage.cacheReadTokens + row.usage.cacheCreateTokens
  );
  const outputTok = tokenCell(row.usage.outputTokens);
  let cost = "—";
  if (row.usage.costEstimateCoveragePct === 0) {
    cost = "unpriced";
  } else if (row.usage.costUsd > 0) {
    cost = `$${row.usage.costUsd.toFixed(2)}`;
  }
  const burn = costBurnCell(row.usage, meta.stats.activeMs[agent] ?? 0);
  const windows = usageLimitWindows(row.usage);
  const limits = rateLimitCell(row.usage);
  const alignedLimits =
    windows.length === 1 && windows[0]?.kind === "weekly"
      ? `${" ".repeat(weeklyLimitIndent)}${limits}`
      : limits;
  const resets = windows
    .map((window) => resetEtaCell(window.reset, meta.nowMs, window.resetAtMs))
    .join("/");
  const rateLimit =
    windows.length > 0
      ? subcells([alignedLimits, resets], [9, 15], "left")
      : subcells(["—", "—"], [9, 15], "left");
  const rateLimitRendered = rateLimitColor(row.usage)
    ? colorCell(
        rateLimitColor(row.usage) as string,
        rateLimit,
        AGENT_COL.limits
      )
    : fitCell(rateLimit, AGENT_COL.limits);
  const tokenSummary = subcells(
    [tok, inputTok, cachedTok, outputTok],
    [5, 5, 5, 6]
  );
  const activity = subcells(
    [
      countCell(row.usage.textMessages),
      countCell(row.usage.thinkingMessages),
      countCell(row.usage.toolCalls),
    ],
    [5, 5, 4]
  );
  const groups = groupedToolCounts(row.usage);
  const bridgeActivity = bridgeActivityText(row, groups, meta);
  return ` ${[
    fitCell(agent, AGENT_COL.agent),
    stateCell(state),
    fitCell(fmtDuration(forMs), AGENT_COL.age),
    fitCell(shortModel(row.usage.model), AGENT_COL.model),
    fitCell(run, AGENT_COL.run),
    ctx,
    rateLimitRendered,
    fitCell(subcells([cost, burn], [7, 4]), AGENT_COL.spend),
    fitCell(tokenSummary, AGENT_COL.tokens),
    activityTotal(row.usage) > 0
      ? colorCell(ANSI.yellow, activity, AGENT_COL.activity)
      : colorCell(ANSI.dim, activity, AGENT_COL.activity),
    renderToolCountCell(bridgeActivity, AGENT_COL.bridge),
  ].join(" ")}`;
};

const utilityState = (snapshot: UtilityObservabilitySnapshot): string => {
  if (snapshot.active > 0) {
    return "active";
  }
  if (snapshot.queued > 0) {
    return "queued";
  }
  if (
    snapshot.contextInsufficient > 0 &&
    snapshot.failed === 0 &&
    snapshot.completed === 0
  ) {
    return "needs-ctx";
  }
  if (snapshot.failed > 0 && snapshot.completed === 0) {
    return "failed";
  }
  return "idle";
};

const utilityStateColor = (state: string): string => {
  if (state === "active") {
    return ANSI.green;
  }
  if (state === "failed") {
    return ANSI.red;
  }
  if (state === "idle") {
    return ANSI.dim;
  }
  return ANSI.yellow;
};

const utilityCostCell = (cost: number): string =>
  cost > 0 ? `$${cost.toFixed(cost < 0.1 ? 4 : 2)}` : "—";

const utilityAge = (
  snapshot: UtilityObservabilitySnapshot,
  nowMs: number
): string => {
  const latestMs = snapshot.latestAt
    ? Date.parse(snapshot.latestAt)
    : Number.NaN;
  return Number.isFinite(latestMs) ? fmtDuration(nowMs - latestMs) : "—";
};

const utilityModelCell = (
  snapshot: UtilityObservabilitySnapshot,
  role: "au pair" | "direct" | "nanny"
): string => {
  if (role === "direct") {
    // Direct-tier jobs run deterministic tool calls without a model.
    return "tools";
  }
  if (snapshot.model) {
    return role === "nanny"
      ? judgeIdFromModel(snapshot.model)
      : shortLocalModel(snapshot.model);
  }
  return role === "nanny" ? "qwen" : "glm-5.2";
};

const renderUtilityAgentRow = (
  snapshot: UtilityObservabilitySnapshot,
  meta: BoardMeta,
  role: "au pair" | "direct" | "nanny"
): string => {
  const state = utilityState(snapshot);
  const usage = snapshot.usage;
  const nannyUsage =
    role === "nanny"
      ? sumLocalLlmUsageByJudge(meta.llmUsageByJudge)
      : emptyLocalLlmUsage();
  const run = subcells(
    [String(snapshot.completed), String(snapshot.failed)],
    [6, 7]
  );
  const tokens = subcells(
    [
      tokenCell(usage.totalTokens + nannyUsage.totalTokens),
      tokenCell(usage.inputTokens + nannyUsage.inputTokens),
      tokenCell(usage.cachedInputTokens + nannyUsage.cachedInputTokens),
      tokenCell(usage.outputTokens + nannyUsage.outputTokens),
    ],
    [5, 5, 5, 6]
  );
  const activity = subcells(
    [String(usage.modelCalls + nannyUsage.calls), String(usage.toolCalls)],
    [5, 10]
  );
  return ` ${[
    colorCell(ANSI.green, role, HELPER_COL.agent),
    colorCell(utilityStateColor(state), `● ${state}`, HELPER_COL.state),
    fitCell(utilityAge(snapshot, meta.nowMs), HELPER_COL.age),
    colorCell(ANSI.green, utilityModelCell(snapshot, role), HELPER_COL.model),
    fitCell(run, HELPER_COL.run),
    fitCell(
      subcells([String(snapshot.active), String(snapshot.queued)], [8, 9]),
      HELPER_COL.context
    ),
    fitCell(String(snapshot.contextInsufficient), HELPER_COL.limits),
    colorCell(
      ANSI.yellow,
      subcells([utilityCostCell(usage.costUsd), ""], [7, 4]),
      HELPER_COL.spend
    ),
    colorCell(ANSI.yellow, tokens, HELPER_COL.tokens),
    colorCell(ANSI.yellow, activity, HELPER_COL.activity),
  ].join(" ")}`;
};

const renderWorkerRoutingRows = (
  snapshot: UtilityObservabilitySnapshot,
  meta: BoardMeta
): string[] => {
  const width = Math.max(1, meta.maxColumns ?? 176);
  const routing = snapshot.routing;
  const decisions = ` routing · ${routing.routed}/${routing.considered} helpers ${workerPercentage(routing.routed, routing.considered)} · active ${snapshot.active} queued ${snapshot.queued} · actionable ${routing.actionable} · kept ${routing.retained} · unsafe ${routing.unsafe} · auto ${routing.autoRouted} explicit ${routing.explicitRouted} · packets ${routing.promptPackets} plans ${routing.structuredPlans}`;
  const reasonEntries = Object.entries(routing.reasons).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  );
  const reasonLabels: Record<string, string> = {
    "command-not-bounded": "command broad",
    "compound-or-unsafe-command": "compound/unsafe",
    "protected-scope": "protected",
    "request-not-bounded": "too broad",
    "review-stays-with-requester": "review kept",
    "small-context-read": "small read",
    "tool-not-enforceable": "tool blocked",
  };
  const reasons = reasonEntries
    .slice(0, 4)
    .map(
      ([reason, count]) =>
        `${reasonLabels[reason] ?? reason.replace(/-/g, " ")} ${count}`
    )
    .join(" · ");
  const remainingReasons = Math.max(0, reasonEntries.length - 4);
  const latestDetail = snapshot.latestRouteDetail?.includes("chmod 600")
    ? "key file permissions too open; chmod 600"
    : snapshot.latestRouteDetail;
  return [
    paint(ANSI.cyan, truncate(decisions, width)),
    paint(
      routing.skipped > 0 ? ANSI.yellow : ANSI.dim,
      truncate(
        ` why · ${reasons || "none"}${remainingReasons > 0 ? ` · +${remainingReasons} more` : ""}${latestDetail ? ` · latest ${latestDetail}` : ""}`,
        width
      )
    ),
  ];
};

const workerPercentage = (part: number, total: number): string =>
  total > 0 ? `${Math.round((part / total) * 100)}%` : "—";

const renderWorkerDetailRows = (
  snapshot: UtilityObservabilitySnapshot,
  meta: BoardMeta
): string[] => {
  const width = Math.max(1, meta.maxColumns ?? 176);
  const performance = snapshot.performance;
  const contexts = snapshot.contexts;
  const failures = snapshot.failures;
  const measured = performance.measuredJobs > 0;
  // Terminal jobs the untiered snapshot counts but no rendered helper row
  // claims. Nonzero means the board is hiding executed work (spec T-07);
  // surface it instead of letting the rows and the summary disagree.
  const tierTerminal = (tier?: UtilityObservabilitySnapshot): number =>
    tier ? tier.completed + tier.failed : 0;
  const unattributedTerminal = Math.max(
    0,
    snapshot.completed +
      snapshot.failed -
      tierTerminal(meta.direct) -
      tierTerminal(meta.nanny) -
      tierTerminal(meta.auPair)
  );
  const performanceLine = ` helpers · ${performance.successfulJobs}/${performance.finishedJobs} success ${performance.finishedJobs > 0 ? workerPercentage(performance.successRate, 1) : "—"} · ${measured ? fmtDuration(performance.averageDurationMs) : "—"} avg · ${measured ? utilityCostCell(performance.averageCostUsd) : "—"}/job · ${measured ? tokenCell(performance.averageTokens) : "—"} tok/job · ${measured ? performance.averageToolCalls.toFixed(1) : "—"} tools/job · cache ${measured ? workerPercentage(performance.cacheHitRate, 1) : "—"} · bridge ${snapshot.messages.inbound}→${snapshot.messages.outbound} pending ${snapshot.messages.pending}${unattributedTerminal > 0 ? ` · unattrib ${unattributedTerminal}` : ""}`;
  const latestContext = contexts.latestHash
    ? `v${contexts.latestVersion ?? "?"} ${contexts.latestHash}`
    : "none";
  const topFailure = failures.topToolError
    ? `${failures.topToolError} ${failures.topToolErrorCount}`
    : "none";
  const contextLine = ` context · ${contexts.capsules}/${snapshot.jobsTotal} capsules ${snapshot.jobsTotal > 0 ? workerPercentage(contexts.coverage, 1) : "—"} · refs ${contexts.references} · latest ${latestContext} · misses ${snapshot.contextInsufficient} · tool failures ${failures.toolFailures} · top ${topFailure.replace(/_/g, " ")}`;
  return [
    paint(ANSI.green, truncate(performanceLine, width)),
    paint(
      failures.toolFailures > 0 || snapshot.contextInsufficient > 0
        ? ANSI.yellow
        : ANSI.dim,
      truncate(contextLine, width)
    ),
  ];
};

const renderNativeFallbackRow = (
  snapshot: NativeFallbackObservability,
  meta: BoardMeta
): string => {
  const width = Math.max(1, meta.maxColumns ?? 176);
  const line = ` native · mode ${snapshot.mode} · slot ${snapshot.slot} ${snapshot.active}/1 · requests ${snapshot.requests} grants ${snapshot.grants} done ${snapshot.completed} · denied ${snapshot.denied} expired ${snapshot.expired} blocked ${snapshot.blockedAttempts}${snapshot.latestReason ? ` · latest ${snapshot.latestReason.replaceAll("-", " ")}` : ""}`;
  return paint(
    snapshot.blockedAttempts > 0 || snapshot.denied > 0
      ? ANSI.yellow
      : ANSI.dim,
    truncate(line, width)
  );
};

const readNativeFallbackBoard = (
  runDir: string,
  mode: NativeSubagentMode
): NativeFallbackObservability => {
  try {
    return readNativeFallbackObservability(runDir, mode);
  } catch {
    return {
      active: 0,
      blockedAttempts: 0,
      completed: 0,
      denied: 0,
      expired: 0,
      grants: 0,
      latestReason: "journal-unavailable-fail-closed",
      mode: "strict",
      requests: 0,
      slot: "open",
    };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readGovernessMessageCountsFromLog = (
  logFile: string
): Record<string, number> => {
  const counts: Record<string, number> = {};
  try {
    for (const line of readFileSync(logFile, "utf8").split(LINE_SPLIT_RE)) {
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
    return `Σ est ${spend}${rate}`;
  }
  const fraction = totalCost / budgetUsd;
  const pct = Math.round(fraction * 100);
  const text = `Σ est ${spend}/$${budgetUsd.toFixed(0)} ${pct}%${rate}`;
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

const renderGovernessMessageCounts = (
  rows: AgentRow[],
  counts: Record<string, number>
): string | undefined => {
  if (rows.length === 0) {
    return undefined;
  }
  const entries = rows.map(
    (row) => [row.liveness.agent, counts[row.liveness.agent] ?? 0] as const
  );
  if (entries.every(([, count]) => count === 0)) {
    return undefined;
  }
  const parts = entries.map(([agent, count]) => `${agent} ${count}`);
  return paint(ANSI.dim, `msgs ${parts.join(" ")}`);
};

const renderSummaryLine = (rows: AgentRow[], meta: BoardMeta): string => {
  const totalCost = rows.reduce((sum, r) => sum + r.usage.costUsd, 0);
  const perHr =
    meta.uptimeMs > 0 ? totalCost / (meta.uptimeMs / MS_PER_HOUR) : 0;
  const errorTotal = rows.reduce((sum, r) => sum + r.errors, 0);
  const messageCounts = renderGovernessMessageCounts(
    rows,
    meta.governessMessages
  );
  const tmuxDegraded = meta.tmuxControl
    ? paint(
        ANSI.yellow,
        `tmux degraded ${fmtDuration(
          meta.nowMs - meta.tmuxControl.unavailableSinceMs
        )} (${truncate(meta.tmuxControl.reason, 32)})`
      )
    : undefined;
  const parts = [
    ...(tmuxDegraded ? [tmuxDegraded] : []),
    paint(ANSI.cyan, meta.identity),
    fmtClock(meta.nowMs),
    ...(Number.isFinite(meta.uptimeMs)
      ? [`wall ${fmtDuration(meta.uptimeMs)}`]
      : []),
    costCell(totalCost, perHr, meta.budgetUsd),
    `joint idle ${fmtDuration(meta.stats.humanIdleMs)}`,
    ...(messageCounts ? [messageCounts] : []),
    ...roleSummaryParts(meta),
    ...(errorTotal > 0 ? [paint(ANSI.red, `errors ${errorTotal}`)] : []),
    ...waitingForYouAlert(meta.waitingForYou),
    paint(ANSI.dim, "[x] exit"),
  ];
  return parts.join(" · ");
};

const SPACE_RE = /\s+/;
const SPACE_GLOBAL_RE = /\s+/g;
const MARKDOWN_HEADING_PREFIX_RE = /^#{1,6}\s+/;
const MARKDOWN_OBJECTIVE_LINE_RE = /^#{1,6}\s+\S/;
const TASK_OBJECTIVE_LINE_RE = /^Task:\s*\S/i;
const TASK_PREFIX_RE = /^Task:\s*/i;
const GENERATED_OBJECTIVE_MESSAGE_RE = /^\s*\[(?:bridge|channel)\b/i;
const BRIDGE_LATEST_WIDTH = 54;

const bridgeLatestFor = (
  latest: BridgeLatest,
  source: Agent,
  target: Agent
): BridgeMessage | undefined => latest[source]?.[target];

const bridgeAgentColor = (agent: string): string => {
  if (agent === "claude") {
    return ANSI.magenta;
  }
  return agent === "codex" ? ANSI.cyan : ANSI.green;
};

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
  row: AgentRow | undefined,
  showLabel: boolean
): string | undefined => {
  const action = agentLatestSegment(row, " · now ");
  const prefix = showLabel ? " bridge " : "        ";
  if (!message) {
    const standaloneAction = agentLatestSegment(row, "");
    return standaloneAction
      ? [paint(ANSI.dim, prefix), standaloneAction].join("")
      : undefined;
  }
  const ageMs = meta.nowMs - Date.parse(message.at);
  const age = Number.isFinite(ageMs) ? fmtDuration(ageMs) : "latest";
  const text = truncate(
    message.message
      .replaceAll("**", "")
      .replaceAll("`", "")
      .replace(SPACE_GLOBAL_RE, " ")
      .trim(),
    BRIDGE_LATEST_WIDTH
  );
  return [
    paint(ANSI.dim, prefix),
    renderBridgeDirection(message.source, message.target),
    paint(ANSI.dim, " · "),
    paint(ANSI.yellow, age),
    paint(ANSI.dim, ` · ${text}`),
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
      .map((row, index) =>
        renderBridgeMessage(undefined, meta, row, index === 0)
      )
      .filter((part): part is string => Boolean(part));
  }
  const parts = [
    renderBridgeMessage(
      bridgeLatestFor(meta.bridgeLatest, left, right),
      meta,
      rowFor(left),
      true
    ),
    renderBridgeMessage(
      bridgeLatestFor(meta.bridgeLatest, right, left),
      meta,
      rowFor(right),
      false
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
  const balanceAge = roleActionAge(meta.roles.balanceAt, meta.nowMs);
  const handoffAge = roleActionAge(meta.roles.handoffAt, meta.nowMs);
  const restoredAge = roleActionAge(meta.roles.restoredAt, meta.nowMs);
  const parts = [
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
  return parts.length > 0 ? [paint(ANSI.dim, parts.join(" · "))] : [];
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
  name === "send_message" || BRIDGE_SEND_TOOL_RE.test(name);

const isBridgeRecvTool = (name: string): boolean =>
  name === "receive_messages" || BRIDGE_RECEIVE_TOOL_RE.test(name);

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

const renderToolCountCell = (text: string, width: number): string =>
  text === "—"
    ? paint(ANSI.dim, fitCell(text, width))
    : paint(ANSI.yellow, fitCell(text, width));

const bridgeToolText = (groups: ToolGroups): string => {
  const parts: string[] = [];
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
  const parts: string[] = [];
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
    info.contextTokens === undefined
      ? ""
      : `ctx${fmtTokens(info.contextTokens)}`,
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
  }`;
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
  const concurrency =
    runtime?.promptConcurrency === undefined &&
    runtime?.decodeConcurrency === undefined
      ? ""
      : `batch ${runtime?.promptConcurrency ?? "?"}/${runtime?.decodeConcurrency ?? "?"}`;
  const step =
    runtime?.prefillStepSize === undefined
      ? ""
      : `step ${runtime.prefillStepSize}`;
  return [concurrency, step].filter(Boolean).join(" · ") || "—";
};

const renderLocalLlmUsageRow = (
  judge: LocalLlmJudgeConfig,
  meta: BoardMeta
): string => {
  const usage = meta.llmUsageByJudge[judge.id] ?? emptyLocalLlmUsage();
  const runtime = meta.llmRuntimeByJudge[judge.id];
  const offline = meta.llmOfflineByJudge[judge.id] === true;
  const modelLabel = localLlmModelLabel(judge);
  const identity = modelLabel.toLowerCase().startsWith(judge.id.toLowerCase())
    ? modelLabel
    : `${judge.id} ${modelLabel}`;
  return [
    paint(ANSI.dim, " nanny model · "),
    paint(ANSI.cyan, identity),
    paint(ANSI.dim, " · "),
    paint(offline ? ANSI.red : ANSI.green, offline ? "offline" : "ok"),
    paint(ANSI.dim, " · "),
    paint(ANSI.green, `${usage.calls} calls`),
    paint(ANSI.dim, " · "),
    paint(
      ANSI.yellow,
      `${tokenCell(usage.totalTokens)} tok (i${tokenCell(usage.inputTokens)} c${tokenCell(usage.cachedInputTokens)} o${tokenCell(usage.outputTokens)})`
    ),
    paint(ANSI.dim, " · "),
    paint(ANSI.green, `cache ${localLlmCacheHit(runtime, usage)}`),
    paint(ANSI.dim, " · "),
    paint(ANSI.cyan, `slots ${localLlmSlots(runtime)}`),
    paint(ANSI.dim, " · "),
    paint(ANSI.magenta, `mem ${localLlmMemory(runtime)}`),
  ].join("");
};

const renderLocalLlmRuntimeRow = (
  judge: LocalLlmJudgeConfig,
  meta: BoardMeta
): string => {
  const runtime = meta.llmRuntimeByJudge[judge.id];
  return [
    paint(ANSI.dim, " runtime · "),
    paint(
      ANSI.cyan,
      meta.cavemanMode === "off" && meta.helperCavemanMode === "off"
        ? `caveman off @${CAVEMAN_UPSTREAM_SHORT_SHA}`
        : `caveman main ${meta.cavemanMode ?? "lite"} / helpers ${meta.helperCavemanMode ?? "full"} @${CAVEMAN_UPSTREAM_SHORT_SHA}`
    ),
    paint(ANSI.dim, " · "),
    paint(ANSI.cyan, localLlmArch(runtime)),
    paint(ANSI.dim, " · "),
    paint(ANSI.magenta, `${localLlmDtype(runtime)} ${localLlmQuant(runtime)}`),
    paint(ANSI.dim, " · "),
    paint(ANSI.magenta, `MoE ${localLlmMoe(runtime)}`),
    paint(ANSI.dim, " · "),
    paint(ANSI.blue, localLlmBatch(runtime)),
    paint(ANSI.dim, " · "),
    paint(ANSI.blue, `temp ${LOCAL_LLM_TEMPERATURE}`),
    paint(ANSI.dim, " · "),
    paint(
      ANSI.blue,
      `max out ${fmtTokenLimit(LOCAL_LLM_JUDGE_MAX_TOKENS)} judge+wait / ${fmtTokenLimit(LOCAL_LLM_SUMMARY_MAX_TOKENS)} summary`
    ),
  ].join("");
};

const structuredSummaryValue = (
  summary: string,
  label: "Progress" | "Next"
): string | undefined => {
  const prefix = `${label}:`;
  const line = summary
    .split(LINE_SPLIT_RE)
    .find((candidate) => candidate.trimStart().startsWith(prefix));
  const value = line?.trimStart().slice(prefix.length).trim();
  return value || undefined;
};

const renderProgressNext = (meta: BoardMeta): string[] => {
  const entries = (["Progress", "Next"] as const)
    .map(
      (label) => [label, structuredSummaryValue(meta.summary, label)] as const
    )
    .filter((entry): entry is readonly ["Progress" | "Next", string] =>
      Boolean(entry[1])
    );
  const width = Math.max(1, meta.maxColumns ?? 176);
  return entries.map(([label, value]) => {
    const valueWidth = Math.max(1, width - label.length - 3);
    return ` ${paint(ANSI.blue, `${label}:`)} ${paint(
      ANSI.dim,
      truncate(value, valueWidth)
    )}`;
  });
};

const renderFooter = (meta: BoardMeta, maxRows?: number): string[] => {
  const summaryLines = renderProgressNext(meta);
  const judgeLines = meta.llmJudges.map((judge) =>
    renderLocalLlmUsageRow(judge, meta)
  );
  const runtimeLine = meta.llmJudges[0]
    ? renderLocalLlmRuntimeRow(meta.llmJudges[0], meta)
    : undefined;
  if (maxRows === undefined) {
    return [
      ...judgeLines,
      ...(runtimeLine ? [runtimeLine] : []),
      ...summaryLines,
    ];
  }
  if (maxRows <= 0) {
    return [];
  }
  const reservedSummary = Math.min(summaryLines.length, maxRows);
  const modelBudget = Math.max(0, maxRows - reservedSummary);
  const modelLines: string[] = [];
  if (modelBudget > 0) {
    const cappedJudgeCount = Math.min(2, judgeLines.length);
    const hasOverflow = judgeLines.length > cappedJudgeCount;
    if (hasOverflow && modelBudget === 1) {
      modelLines.push(judgeLines[0] as string);
    } else if (hasOverflow) {
      const visibleCount = Math.min(cappedJudgeCount, modelBudget - 1);
      modelLines.push(...judgeLines.slice(0, visibleCount));
      modelLines.push(
        paint(
          ANSI.dim,
          ` … ${judgeLines.length - visibleCount} more judges (see replay/trace)`
        )
      );
      if (runtimeLine && modelLines.length < modelBudget) {
        modelLines.push(runtimeLine);
      }
    } else if (judgeLines.length <= modelBudget) {
      modelLines.push(...judgeLines);
      if (runtimeLine && modelLines.length < modelBudget) {
        modelLines.push(runtimeLine);
      }
    } else {
      const visibleCount = Math.max(0, modelBudget - 1);
      modelLines.push(...judgeLines.slice(0, visibleCount));
      modelLines.push(
        paint(
          ANSI.dim,
          ` … ${judgeLines.length - visibleCount} more judges (see replay/trace)`
        )
      );
    }
  }
  return [...modelLines, ...summaryLines.slice(-reservedSummary)].slice(
    0,
    maxRows
  );
};

interface HelperRowEntry {
  row: string;
  snapshot: UtilityObservabilitySnapshot;
}

const utilityTierBusy = (snapshot: UtilityObservabilitySnapshot): boolean =>
  snapshot.completed + snapshot.failed + snapshot.active + snapshot.queued > 0;

// When helper rows must drop to fit the viewport, keep tiers with recorded
// work over idle ones (display order breaks ties, kept rows stay in display
// order). Tail-slicing alone always dropped the last-rendered tier (direct),
// hiding its real work at small viewports (T-07 review blocker).
const selectHelperRows = (
  entries: HelperRowEntry[],
  budget: number
): string[] => {
  const capped = Math.max(0, Math.min(entries.length, budget));
  if (capped === entries.length) {
    return entries.map((entry) => entry.row);
  }
  const ranked = entries
    .map((entry, index) => ({ busy: utilityTierBusy(entry.snapshot), index }))
    .sort(
      (left, right) =>
        Number(right.busy) - Number(left.busy) || left.index - right.index
    );
  const kept = new Set(ranked.slice(0, capped).map((entry) => entry.index));
  return entries.flatMap((entry, index) =>
    kept.has(index) ? [entry.row] : []
  );
};

const renderBoard = (rows: AgentRow[], meta: BoardMeta): string => {
  const weeklyLimitIndent = Math.max(
    0,
    ...rows.map((row) => rateLimitCell(row.usage).indexOf("W"))
  );
  const statusLine = renderSummaryLine(rows, meta);
  const primaryAgentRows = rows.map((row) =>
    renderAgentRow(row, meta, weeklyLimitIndent)
  );
  const helperEntries: HelperRowEntry[] = [
    ...(meta.nanny
      ? [
          {
            row: renderUtilityAgentRow(meta.nanny, meta, "nanny"),
            snapshot: meta.nanny,
          },
        ]
      : []),
    ...(meta.auPair
      ? [
          {
            row: renderUtilityAgentRow(meta.auPair, meta, "au pair"),
            snapshot: meta.auPair,
          },
        ]
      : []),
    ...(meta.direct
      ? [
          {
            row: renderUtilityAgentRow(meta.direct, meta, "direct"),
            snapshot: meta.direct,
          },
        ]
      : []),
  ];
  const helperRows = helperEntries.map((entry) => entry.row);
  const entityRows = [...primaryAgentRows, ...helperRows];
  const identityRows = [
    agentHeaderRow,
    ...primaryAgentRows,
    ...headedHelperRows(helperRows),
  ];
  const bridgeLines = renderBridgeLatestLine(rows, meta);
  const workerRoutingLines = meta.utility
    ? renderWorkerRoutingRows(meta.utility, meta)
    : [];
  const workerDetailLines = meta.utility
    ? renderWorkerDetailRows(meta.utility, meta)
    : [];
  const nativeFallbackLines = meta.nativeFallback
    ? [renderNativeFallbackRow(meta.nativeFallback, meta)]
    : [];
  const fullTop = [
    statusLine,
    ...identityRows,
    ...bridgeLines,
    ...workerRoutingLines,
    ...workerDetailLines,
    ...nativeFallbackLines,
  ];
  const maxRows = meta.maxRows;
  let top = fullTop;
  if (maxRows !== undefined && fullTop.length > maxRows) {
    const rowBudget = Math.max(0, maxRows - 1);
    const compactIdentityRows =
      maxRows <= entityRows.length + 1
        ? [
            ...primaryAgentRows,
            ...selectHelperRows(
              helperEntries,
              rowBudget - primaryAgentRows.length
            ),
          ]
        : [
            agentHeaderRow,
            ...primaryAgentRows,
            ...headedHelperRows(
              selectHelperRows(
                helperEntries,
                rowBudget - primaryAgentRows.length - 2
              )
            ),
          ];
    const visibleIdentityRows = compactIdentityRows.slice(0, rowBudget);
    let spare = Math.max(0, maxRows - 1 - visibleIdentityRows.length);
    const visibleBridgeLines = bridgeLines.slice(0, Math.max(0, spare));
    spare -= visibleBridgeLines.length;
    const visibleRoutingLines = workerRoutingLines.slice(0, Math.max(0, spare));
    spare -= visibleRoutingLines.length;
    const visibleWorkerDetailLines = workerDetailLines.slice(
      0,
      Math.max(0, spare)
    );
    spare -= visibleWorkerDetailLines.length;
    const visibleNativeFallbackLines = nativeFallbackLines.slice(
      0,
      Math.max(0, spare)
    );
    top = [
      statusLine,
      ...visibleIdentityRows,
      ...visibleBridgeLines,
      ...visibleRoutingLines,
      ...visibleWorkerDetailLines,
      ...visibleNativeFallbackLines,
    ].slice(0, maxRows);
  }
  const footerBudget =
    maxRows === undefined ? undefined : Math.max(0, maxRows - top.length);
  const lines = [...top, ...renderFooter(meta, footerBudget)];
  return (
    meta.maxColumns === undefined
      ? lines
      : lines.map((line) =>
          fitAnsiLine(line, Math.max(1, meta.maxColumns ?? 1))
        )
  ).join("\n");
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

const recoveryActionFor = (
  level: RecoveryDecision["level"]
): GovernessAction | undefined => {
  if (level === "answer-prompt" || level === "nudge") {
    return level;
  }
  return level === "restart" ? "restart-agent" : undefined;
};

// Run the recovery ladder for a suspect agent; returns the taken action (if any).
const recoverAgent = (
  info: GovernessAgentInfo,
  verdict: GovernessVerdict,
  config: GovernessConfig,
  deps: GovernessDeps,
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
  const recoveryAction = recoveryActionFor(decision.level);
  if (recoveryAction) {
    const policy = decideGovernessPolicy(recoveryAction, {
      confirmed: false,
      fenceCurrent: governessFenceCurrent(config, deps),
      targetSafe: true,
    });
    if (!policy.allowed) {
      deps.appendLog(config.logFile, {
        action: recoveryAction,
        agent: info.agent,
        decision,
        kind: "recovery-policy-denied",
        reason: policy.reason,
        ts: ctx.nowIso,
        verdict,
      });
      return null;
    }
  }
  const action = executeRecovery(
    decision,
    buildRecoveryDeps(info, deps, config),
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

const conservativeVerdict = (summary: string): GovernessVerdict => ({
  confidence: 0,
  state: "working",
  summary: truncate(summary, JUDGE_SUMMARY_MAX),
});

const outcomeUsage = (outcome: JudgeOutcome): LocalLlmUsage =>
  outcome.usage ?? localLlmUsageFromTokens(outcome.tokens ?? 0);

const judgeStateSummary = (result: LocalJudgeResult): string =>
  "verdict" in result.outcome
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
      "reason" in result.outcome && result.outcome.reason === "unreachable";
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
  info: GovernessAgentInfo,
  events: HookEvent[],
  paneText: string,
  config: GovernessConfig,
  deps: GovernessDeps,
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
  if (snapshot?.pricing) {
    applyUsageTrackerPricing(usage, agent, snapshot.pricing);
  }
  const limits = snapshot?.[agent];
  if (!limits) {
    return;
  }
  if (limits.windows?.length) {
    usage.rateLimitWindows = limits.windows.map((window) => ({ ...window }));
    usage.rateLimitPrimaryPct = undefined;
    usage.rateLimitPrimaryReset = undefined;
    usage.rateLimitSecondaryPct = undefined;
    usage.rateLimitSecondaryReset = undefined;
    const session = limits.windows.find((window) => window.kind === "session");
    const weekly = limits.windows.find((window) => window.kind === "weekly");
    if (session) {
      usage.rateLimitPrimaryPct = session.usedPct;
      usage.rateLimitPrimaryReset =
        session.reset ??
        (session.resetAtMs === undefined
          ? undefined
          : new Date(session.resetAtMs).toISOString());
    }
    if (weekly) {
      usage.rateLimitSecondaryPct = weekly.usedPct;
      usage.rateLimitSecondaryReset =
        weekly.reset ??
        (weekly.resetAtMs === undefined
          ? undefined
          : new Date(weekly.resetAtMs).toISOString());
    }
    return;
  }
  usage.rateLimitWindows = undefined;
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
  info: GovernessAgentInfo,
  states: Map<Agent, AgentLivenessState>,
  config: GovernessConfig,
  deps: GovernessDeps,
  ctx: AgentTickContext,
  paneText: string
): Promise<AgentTickResult> => {
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
    paneFresh: true,
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
  row.verdict = "verdict" in outcome ? outcome.verdict : outcome.fallback;
  if ("reason" in outcome && outcome.reason === "unreachable") {
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

const degradedEventAgeMs = (
  events: HookEvent[],
  previous: AgentLivenessState,
  nowMs: number
): number => {
  const timestamp = lastEventTs(events) ?? previous.lastEventTs;
  if (!timestamp) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed)
    ? Math.max(0, nowMs - parsed)
    : Number.POSITIVE_INFINITY;
};

// Build a display-only row from durable evidence while tmux control is down.
// The detector state is deliberately not advanced: elapsed time without a
// fresh pane must never turn into a stuck verdict or recovery action.
const processAgentWithoutPane = (
  info: GovernessAgentInfo,
  states: Map<Agent, AgentLivenessState>,
  deps: GovernessDeps,
  ctx: AgentTickContext
): AgentTickResult => {
  const events = deps.readHooks(info.hookFile);
  const usage = deps.readUsage(info.agent, info.sessionRef, info.codexHome);
  applyUsageLimits(usage, info.agent, ctx.usageLimits);
  const previous =
    states.get(info.agent) ?? initLivenessState(info.agent, ctx.nowMs);
  if (!states.has(info.agent)) {
    states.set(info.agent, previous);
  }
  const liveness: AgentLiveness = {
    agent: info.agent,
    lastEventAgeMs: degradedEventAgeMs(events, previous, ctx.nowMs),
    paneIdleMs: Math.max(0, ctx.nowMs - previous.paneStableSinceMs),
    paneStable: false,
    suspect: false,
  };
  return {
    history: ctx.history,
    llmOffline: false,
    llmOfflineByJudge: {},
    llmUsage: emptyLocalLlmUsage(),
    llmUsageByJudge: emptyLocalLlmUsageByJudge(),
    recoveries: ctx.recoveries,
    row: {
      action: null,
      errors: events.filter((event) => event.error === true).length,
      lastAction: lastActionOf(events),
      liveness,
      paneFresh: false,
      thinking: false,
      usage,
    },
    summaryCtx: {
      agent: info.agent,
      lastActions: events.slice(-SUMMARY_ACTIONS).map(eventLabel),
      paneText: "[tmux control unavailable; pane evidence is stale]",
    },
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
  config: GovernessConfig,
  deps: GovernessDeps,
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
  config: GovernessConfig,
  deps: GovernessDeps,
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
  config: GovernessConfig,
  deps: GovernessDeps,
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
  config: GovernessConfig,
  deps: GovernessDeps,
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
  config: GovernessConfig,
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
  config: GovernessConfig,
  deps: GovernessDeps
): Pick<
  SummaryRequest,
  | "authoritativeObjective"
  | "humanMessages"
  | "priorSummaries"
  | "projectContext"
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
  const authoritativeObjective = authoritativeSummaryObjective(humanMessages);
  return {
    ...(authoritativeObjective ? { authoritativeObjective } : {}),
    humanMessages,
    priorSummaries: readPriorSummaries(config.runDir),
    projectContext: readProjectContext(config.cwd),
  };
};

const cleanObjectiveLine = (line: string): string =>
  line
    .replace(MARKDOWN_HEADING_PREFIX_RE, "")
    .replace(TASK_PREFIX_RE, "")
    .replace(SPACE_GLOBAL_RE, " ")
    .trim()
    .slice(0, 240);

export const authoritativeSummaryObjective = (
  humanMessages: readonly string[]
): string | undefined => {
  const messages = humanMessages
    .filter((message) => !GENERATED_OBJECTIVE_MESSAGE_RE.test(message))
    .reverse();
  for (const message of messages) {
    const explicit = message
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          TASK_OBJECTIVE_LINE_RE.test(line) ||
          MARKDOWN_OBJECTIVE_LINE_RE.test(line)
      );
    if (explicit) {
      return cleanObjectiveLine(explicit);
    }
  }
  for (const message of messages) {
    const first = message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      return cleanObjectiveLine(first);
    }
  }
  return undefined;
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
  runState: GovernessRunState,
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
  config: GovernessConfig
): Partial<Record<Agent, GovernessAgentInfo>> =>
  Object.fromEntries(
    config.agents.map((info) => [info.agent, info])
  ) as Partial<Record<Agent, GovernessAgentInfo>>;

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
    `governess: ${pausedName} is at/near ${pressure.resetKind} limit (${pressure.pct}% used)${reset}.`,
    `${driverName} is now the driver. Continue the task from the current repo state and do not wait for ${pausedName}'s next turn before making progress.`,
    `Ask ${pausedName} for review or context only after that limit reset, or if the human explicitly redirects the pairing.`,
  ].join(" ");
};

// Belt-and-braces throttle for restore briefings: even a genuine handoff
// briefing repeats at most once per window per agent (in-memory; resets on
// governess respawn, which is fine — the cost of a rare duplicate briefing is
// one message, the cost of a flapping restore loop is constant interruption).
const RESTORE_MESSAGE_COOLDOWN_MS = 15 * 60 * 1000;
const restoreMessageSentAtMs = new Map<Agent, number>();

const restoreContextMessage = (
  restored: Agent,
  temporary: Agent | undefined,
  state: GovernessRunState
): string => {
  const restoredName = capitalize(restored);
  const temporaryName = temporary ? capitalize(temporary) : "The other agent";
  const summary = state.summary
    .split(LINE_SPLIT_RE)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  const context = summary
    ? truncate(summary, 700)
    : "Use the current repo state, recent terminal output, PLAN.md/status.md if present, and the peer's latest handoff.";
  return `governess: ${restoredName}'s limit reset and ${restoredName} is the driver again. While you were paused, ${temporaryName} drove the task. Current context: ${context} Pick up from the current repo state; ask ${temporaryName} for only a concise missing detail if needed.`;
};

const restoreTemporaryDriverMessage = (
  restored: Agent,
  _temporary: Agent
): string =>
  [
    `governess: ${capitalize(restored)}'s limit reset.`,
    `Hand the driver role back to ${capitalize(restored)} now.`,
    "Send a concise handoff if useful, then stop driving unless the human redirects.",
  ].join(" ");

const balanceDriverMessage = (
  previous: Agent,
  next: Agent,
  reason: string
): string =>
  [
    "governess: proactive quota balance.",
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
    "governess: proactive quota balance.",
    `${capitalize(next)} is now the driver to preserve available quota.`,
    reason ? `Reason: ${truncate(reason, 180)}.` : "",
    `${capitalize(previous)} should stay available for review/context and only resume driving if asked or after roles change again.`,
  ]
    .filter(Boolean)
    .join(" ");

const bridgeSourceFor = (
  target: Agent,
  preferred: Agent | undefined,
  config: GovernessConfig
): Agent | undefined =>
  preferred && preferred !== target
    ? preferred
    : config.agents.find((info) => info.agent !== target)?.agent;

const sendDirectRoleMessage = (
  deps: GovernessDeps,
  info: GovernessAgentInfo,
  message: string
): "tmux" => {
  deps.sendText(info.pane, message);
  deps.sendKeys(info.pane, ["Enter"]);
  return "tmux";
};

const controlTransport = (
  config: GovernessConfig,
  target: Agent
): "bridge" | "claude-channel" | "codex-app-server" | "tmux-fallback" => {
  if (!config.runDir) {
    return "tmux-fallback";
  }
  if (target === "claude") {
    return "claude-channel";
  }
  if (
    target === "codex" &&
    readBridgeRuntimeStatus(config.runDir).codexDeliveryMode === "app-server"
  ) {
    return "codex-app-server";
  }
  return "bridge";
};

const sendRoleMessage = async (
  config: GovernessConfig,
  deps: GovernessDeps,
  targetInfo: GovernessAgentInfo,
  target: Agent,
  source: Agent | undefined,
  message: string
): Promise<BridgeSendStatus | "tmux"> => {
  const policy = decideGovernessPolicy("send-control", {
    fenceCurrent: governessFenceCurrent(config, deps),
    targetSafe: true,
  });
  const policyContext = {
    fenceCurrent: governessFenceCurrent(config, deps),
    targetSafe: true,
  };
  if (!policy.allowed) {
    deps.appendLog(config.logFile, {
      action: "send-control",
      agent: target,
      at: new Date(deps.now()).toISOString(),
      event: "control-denied",
      reason: policy.reason,
    });
    return "accepted";
  }
  const now = new Date(deps.now()).toISOString();
  const record = config.journalFile
    ? prepareGovernessControl(config.journalFile, {
        action: "send-control",
        agent: target,
        at: now,
        epoch: config.epoch ?? 0,
        idempotencyKey: controlKey(config, "send-control", target, message),
        payload: message,
        policyClass: policy.class,
        policyContext,
      })
    : undefined;
  if (record && record.phase !== "prepared") {
    return "accepted";
  }
  if (record && config.journalFile) {
    transitionGovernessControl(
      config.journalFile,
      record.controlId,
      "dispatched",
      now,
      undefined,
      { transport: controlTransport(config, target) }
    );
  }
  // The bridge owns native Claude channel and Codex app-server delivery. It
  // durably queues when the runtime is reconnecting instead of typing into a
  // possibly occupied composer.
  if (config.runDir && source && source !== target) {
    const delivery = await deps.sendBridge(
      config.runDir,
      source,
      target,
      message,
      {
        dedupeKey: record?.idempotencyKey,
        priority: "high",
        subject: "governess role decision",
        type: "decision",
      }
    );
    if (record && config.journalFile) {
      transitionGovernessControl(
        config.journalFile,
        record.controlId,
        "accepted",
        new Date(deps.now()).toISOString(),
        `transport ${delivery}`
      );
    }
    return delivery;
  }
  const delivery = sendDirectRoleMessage(deps, targetInfo, message);
  if (record && config.journalFile) {
    transitionGovernessControl(
      config.journalFile,
      record.controlId,
      "accepted",
      new Date(deps.now()).toISOString(),
      "guarded terminal fallback accepted input",
      { transport: "tmux-fallback" }
    );
  }
  return delivery;
};

const sessionPressurePreparationMessage = (
  pressure: SessionPressureDecision
): string =>
  [
    "governess: prepare a fresh-loop handover now; do not start another broad slice.",
    `${capitalize(pressure.agent)} reached ${pressure.phase} on profile ${pressure.profile}: ${pressure.reason}.`,
    "Update PLAN.md and status.md with the current objective, exact changed scope, checks and results, blockers, risks, and the next bounded action.",
    "Finish only the current atomic step. Preserve uncommitted work and existing authority boundaries. Do not compact either session; Governess will start the governed handover only if a handoff threshold is reached.",
  ].join(" ");

const reconcileSessionPressure = async (
  rows: AgentRow[],
  config: GovernessConfig,
  deps: GovernessDeps,
  runState: GovernessRunState,
  nowIso: string
): Promise<SessionPressureByAgent> => {
  const mode = config.sessionPressureMode ?? "off";
  if (mode === "off") {
    runState.sessionPressure = {};
    return {};
  }
  const previous = runState.sessionPressure;
  const current: SessionPressureByAgent = {};
  config.agents.forEach((info, index) => {
    const row = rows[index];
    if (!row) {
      return;
    }
    const next = evaluateSessionPressure(info.agent, row.usage);
    current[info.agent] = next;
    const before = previous[info.agent];
    if (before?.phase === next.phase || (!before && next.phase === "healthy")) {
      return;
    }
    deps.appendLog(config.logFile, {
      ...next,
      at: nowIso,
      event: "session-pressure-transition",
      from: before?.phase ?? "unknown",
      mode,
      to: next.phase,
    });
  });
  runState.sessionPressure = current;

  const highest = highestSessionPressure(current);
  if (
    mode !== "enforce" ||
    config.dryRun ||
    runState.exitControl.mode !== "idle" ||
    highest?.phase !== "prepare"
  ) {
    return current;
  }
  const message = sessionPressurePreparationMessage(highest);
  for (const info of config.agents) {
    if (runState.sessionPressurePrepared[info.agent]) {
      continue;
    }
    const source = bridgeSourceFor(info.agent, undefined, config);
    try {
      const transport = await sendRoleMessage(
        config,
        deps,
        info,
        info.agent,
        source,
        message
      );
      runState.sessionPressurePrepared[info.agent] = true;
      incrementCount(runState.governessMessages, info.agent);
      deps.appendLog(config.logFile, {
        agent: info.agent,
        at: nowIso,
        event: "session-pressure-preparation-sent",
        reason: highest.reasonCode,
        source: highest.agent,
        transport,
      });
    } catch (error) {
      deps.appendLog(config.logFile, {
        agent: info.agent,
        at: nowIso,
        error: error instanceof Error ? error.message : String(error),
        event: "session-pressure-preparation-failed",
        source: highest.agent,
      });
    }
  }
  return current;
};

export const createGovernessRuntimeAdapter = (
  config: GovernessConfig,
  deps: GovernessDeps,
  info: GovernessAgentInfo,
  displayState?: string,
  observedPaneCommand?: string
): GovernessRuntimeAdapter => {
  const deliver = async (
    control: Parameters<GovernessRuntimeAdapter["sendControl"]>[0],
    direct = false
  ) => {
    if (
      !control.controlId ||
      control.target !== info.agent ||
      control.epoch !== config.epoch ||
      !governessFenceCurrent(config, deps)
    ) {
      throw new Error("stale or invalid governess control envelope");
    }
    const startedAt = deps.now();
    deps.appendLog(config.logFile, {
      action: control.action,
      agent: info.agent,
      at: new Date(deps.now()).toISOString(),
      controlId: control.controlId,
      epoch: control.epoch,
      event: "runtime-control",
    });
    const finish = (status: string, transport: string): string => {
      deps.appendLog(config.logFile, {
        agent: info.agent,
        at: new Date(deps.now()).toISOString(),
        controlId: control.controlId,
        durationMs: Math.max(0, deps.now() - startedAt),
        epoch: control.epoch,
        event: "runtime-control-span",
        status,
        traceId: control.controlId,
        transport,
      });
      return status;
    };
    const tmuxFallback = async (): Promise<string> => {
      if (!directInputIsSafe(deps, info)) {
        finish("refused", "tmux-fallback");
        throw new Error(
          "terminal fallback refused: target composer is not empty"
        );
      }
      // Long pasted prompts are staged asynchronously by Codex's TUI. Sending
      // Enter in the same tmux command burst can leave the control sitting in
      // the composer, where it would consume the next user/agent input. Give
      // the TUI one short settle window before submitting the turn.
      deps.sendText(info.pane, control.message);
      await deps.sleep(250);
      deps.sendKeys(info.pane, ["Enter"]);
      return finish("tmux", "tmux-fallback");
    };
    if (direct) {
      return tmuxFallback();
    }
    const source = bridgeSourceFor(info.agent, undefined, config);
    if (config.runDir && source) {
      const transport = controlTransport(config, info.agent);
      try {
        const status = await deps.sendBridge(
          config.runDir,
          source,
          info.agent,
          control.message,
          {
            dedupeKey: control.controlId,
            priority: control.action === "message" ? "normal" : "urgent",
            subject:
              control.action === "message"
                ? "governess work request"
                : "governess handover",
            type: control.action === "message" ? "work_request" : "handover",
          }
        );
        return finish(String(status), transport);
      } catch (error) {
        finish("failed", transport);
        throw error;
      }
    }
    return tmuxFallback();
  };
  return {
    agent: info.agent,
    checkpoint: () => {
      const event = deps.readHooks(info.hookFile).at(-1);
      return Promise.resolve(
        event
          ? {
              agent: info.agent,
              at: event.ts,
              reference: `${event.event}:${event.ts}`,
            }
          : undefined
      );
    },
    observe: () => {
      const evidence =
        observedPaneCommand ?? deps.paneCommand?.(info.pane) ?? "unknown";
      const alive = !agentHasExited(info.agent, evidence);
      return Promise.resolve({
        alive,
        evidence,
        state: explicitAgentState(displayState, alive),
      });
    },
    requestDrain: (control) => deliver(control),
    requestExit: (control) => deliver(control, true),
    sendControl: deliver,
  };
};

const exitBanner = (
  state: ExitControlState,
  menuOpen: boolean,
  agents: GovernessAgentInfo[],
  paneCommand: (pane: string) => string | undefined,
  handoverBundles: Partial<Record<Agent, string>> = {}
): string | undefined => {
  if (menuOpen) {
    return " exit · [e] tear down loop · [h] hand over to new loop · [c/Esc/x] cancel";
  }
  if (state.mode === "launch-error") {
    return ` handover launch failed · ${state.launchError ?? "unknown error"} · [h] retry · [e] tear down`;
  }
  if (state.mode === "launched") {
    return ` handover · ${state.replacementSession ?? "replacement"} ready · waiting for manifest acceptance · [e] tear down`;
  }
  if (state.mode !== "handover") {
    return undefined;
  }
  const status = agents.map((info) => {
    if (!state.notified[info.agent]) {
      return `${info.agent}:finishing`;
    }
    if (!handoverBundles[info.agent]) {
      return `${info.agent}:bundle`;
    }
    return agentHasExited(info.agent, paneCommand(info.pane))
      ? `${info.agent}:done`
      : `${info.agent}:exiting`;
  });
  return ` handover · ${status.join(" · ")} · [e] force teardown`;
};

export const renderExitControl = (
  board: string,
  state: ExitControlState,
  menuOpen: boolean,
  agents: GovernessAgentInfo[],
  paneCommand: (pane: string) => string | undefined,
  handoverBundles: Partial<Record<Agent, string>> = {}
): string => {
  const banner = exitBanner(
    state,
    menuOpen,
    agents,
    paneCommand,
    handoverBundles
  );
  if (!banner) {
    return board;
  }
  const lines = board.split("\n");
  lines[0] = banner;
  return lines.join("\n");
};

const agentSafeForHandover = (state: string | undefined): boolean =>
  !RENAME_BUSY_STATES.has(state ?? "");

const directInputIsSafe = (
  deps: GovernessDeps,
  info: GovernessAgentInfo
): boolean => {
  const events = deps.readHooks(info.hookFile);
  // A Notification can mean "permission/input required", not an empty
  // composer. Only a real Stop hook proves a completed turn is safe for
  // direct text injection.
  if (events.at(-1)?.event !== "Stop") {
    return false;
  }
  let paneText: string;
  try {
    paneText = deps.capturePane(info.pane);
  } catch (error) {
    if (isTmuxControlUnavailableError(error)) {
      return false;
    }
    throw error;
  }
  const tail = paneText.split(LINE_SPLIT_RE).slice(-10);
  // Both Codex and Claude prefix a non-empty composer with one of these prompt
  // glyphs. A Stop hook alone proves turn completion, not that the human has
  // not started typing since then.
  return !tail.some((line) => NONEMPTY_COMPOSER_RE.test(line));
};

const notifyHandoverAgents = async (
  config: GovernessConfig,
  deps: GovernessDeps,
  runState: GovernessRunState,
  agentStates: Partial<Record<Agent, string>>
): Promise<void> => {
  if (!config.runDir) {
    return;
  }
  ensureGovernessHandoffDir(config.runDir, runState.governessEpoch);
  for (const info of config.agents) {
    if (
      runState.exitControl.notified[info.agent] ||
      !agentSafeForHandover(agentStates[info.agent])
    ) {
      continue;
    }
    const bundleFile = governessHandoffFile(
      config.runDir,
      runState.governessEpoch,
      info.agent
    );
    const message = handoverRequest(bundleFile, runState.governessEpoch);
    const policy = decideGovernessPolicy("handover-loop", {
      confirmed: true,
      fenceCurrent: governessFenceCurrent(config, deps),
    });
    if (!policy.allowed) {
      continue;
    }
    const record = config.journalFile
      ? prepareGovernessControl(config.journalFile, {
          action: "handover-loop",
          agent: info.agent,
          at: new Date(deps.now()).toISOString(),
          epoch: config.epoch ?? runState.governessEpoch,
          idempotencyKey: `${runState.governessEpoch}:handover:${info.agent}`,
          payload: message,
          policyClass: policy.class,
          policyContext: {
            confirmed: true,
            fenceCurrent: governessFenceCurrent(config, deps),
          },
        })
      : undefined;
    if (record && record.phase !== "prepared") {
      runState.exitControl.notified[info.agent] = true;
      deps.saveState(config.stateFile, runState);
      continue;
    }
    if (!directInputIsSafe(deps, info)) {
      continue;
    }
    if (record && config.journalFile) {
      transitionGovernessControl(
        config.journalFile,
        record.controlId,
        "dispatched",
        new Date(deps.now()).toISOString()
      );
    }
    const adapter = createGovernessRuntimeAdapter(config, deps, info);
    let delivery: string;
    try {
      delivery = await adapter.requestDrain({
        action: "drain",
        controlId:
          record?.controlId ??
          controlKey(config, "handover-loop", info.agent, message),
        epoch: config.epoch ?? runState.governessEpoch,
        message,
        target: info.agent,
      });
    } catch (error) {
      if (record && config.journalFile) {
        transitionGovernessControl(
          config.journalFile,
          record.controlId,
          "failed",
          new Date(deps.now()).toISOString(),
          error instanceof Error ? error.message : String(error)
        );
      }
      deps.appendLog(config.logFile, {
        agent: info.agent,
        at: new Date(deps.now()).toISOString(),
        error: error instanceof Error ? error.message : String(error),
        event: "handover-request-failed",
      });
      continue;
    }
    if (record && config.journalFile) {
      transitionGovernessControl(
        config.journalFile,
        record.controlId,
        "accepted",
        new Date(deps.now()).toISOString(),
        `transport ${delivery}`,
        {
          transport:
            delivery === "tmux"
              ? "tmux-fallback"
              : controlTransport(config, info.agent),
        }
      );
    }
    // The journal is the at-most-once fence. Persist the display/progress bit
    // only after the adapter accepted the control, so a crash while merely
    // prepared can retry but a dispatched control is never re-injected.
    runState.exitControl.notified[info.agent] = true;
    deps.saveState(config.stateFile, runState);
    deps.appendLog(config.logFile, {
      agent: info.agent,
      at: new Date(deps.now()).toISOString(),
      delivery,
      event: "handover-requested",
    });
  }
};

const allHandoverAgentsExited = (
  config: GovernessConfig,
  deps: GovernessDeps,
  runState: GovernessRunState
): boolean => {
  let allExited = true;
  for (const info of config.agents) {
    const paneProbe = deps.paneCommand?.(info.pane);
    const probe = {
      bundle: runState.handoverBundles[info.agent],
      exited: agentHasExited(info.agent, paneProbe),
      exitRequested: runState.exitControl.exitRequested?.[info.agent] === true,
      notified: runState.exitControl.notified[info.agent] === true,
      paneProbe: paneProbe ?? "unknown",
    };
    recordGovernessObservation(config, deps, {
      agent: info.agent,
      idempotencyKey: `${config.epoch}:handoff-exit-probe:${info.agent}:${runState.tick}`,
      payload: JSON.stringify(probe),
      stream: `handoff-exit-probe:${info.agent}`,
    });
    if (probe.exited && config.journalFile) {
      const control = latestGovernessControlByKey(
        config.journalFile,
        `${runState.governessEpoch}:handover-exit:${info.agent}`
      );
      if (
        control &&
        control.phase !== "completed" &&
        control.phase !== "failed"
      ) {
        transitionGovernessControl(
          config.journalFile,
          control.controlId,
          "completed",
          new Date(deps.now()).toISOString(),
          "agent process exited",
          { evidence: probe.paneProbe }
        );
      }
    }
    if (!(probe.notified && probe.bundle && probe.exited)) {
      allExited = false;
    }
  }
  return allExited;
};

const beginHandover = (runState: GovernessRunState, now: number): void => {
  runState.handoverBundles = {};
  runState.exitControl = {
    exitRequested: {},
    mode: "handover",
    notified: {},
    requestedAt: new Date(now).toISOString(),
  };
};

export const maybeBeginSessionPressureHandover = (
  config: Pick<GovernessConfig, "dryRun" | "logFile" | "sessionPressureMode">,
  deps: Pick<GovernessDeps, "appendLog" | "now">,
  runState: GovernessRunState,
  decisions: SessionPressureByAgent,
  tmuxControlAvailable: boolean
): SessionPressureDecision | undefined => {
  if (
    config.sessionPressureMode !== "enforce" ||
    config.dryRun ||
    !tmuxControlAvailable ||
    runState.exitControl.mode !== "idle"
  ) {
    return undefined;
  }
  const highest = highestSessionPressure(decisions);
  if (!(highest && pressureAtOrAboveHandoff(highest))) {
    return undefined;
  }
  const now = deps.now();
  beginHandover(runState, now);
  deps.appendLog(config.logFile, {
    ...highest,
    at: new Date(now).toISOString(),
    event: "session-pressure-handover-started",
    mode: config.sessionPressureMode,
  });
  return highest;
};

const requestDrainedAgentExits = async (
  config: GovernessConfig,
  deps: GovernessDeps,
  runState: GovernessRunState,
  agentStates: Partial<Record<Agent, string>>
): Promise<void> => {
  const requested = runState.exitControl.exitRequested ?? {};
  runState.exitControl.exitRequested = requested;
  for (const info of config.agents) {
    const paneProbe = deps.paneCommand?.(info.pane);
    if (
      !(
        runState.exitControl.notified[info.agent] &&
        runState.handoverBundles[info.agent]
      ) ||
      requested[info.agent] ||
      agentHasExited(info.agent, paneProbe) ||
      !agentSafeForHandover(agentStates[info.agent]) ||
      !directInputIsSafe(deps, info)
    ) {
      continue;
    }
    const policy = decideGovernessPolicy("handover-loop", {
      confirmed: true,
      fenceCurrent: governessFenceCurrent(config, deps),
      targetSafe: true,
    });
    if (!policy.allowed) {
      continue;
    }
    const payload = "/exit";
    const record = config.journalFile
      ? prepareGovernessControl(config.journalFile, {
          action: "handover-loop",
          agent: info.agent,
          at: new Date(deps.now()).toISOString(),
          epoch: config.epoch ?? runState.governessEpoch,
          idempotencyKey: `${runState.governessEpoch}:handover-exit:${info.agent}`,
          payload,
          policyClass: policy.class,
          policyContext: {
            confirmed: true,
            fenceCurrent: governessFenceCurrent(config, deps),
            targetSafe: true,
          },
        })
      : undefined;
    if (record && record.phase !== "prepared") {
      requested[info.agent] = true;
      deps.saveState(config.stateFile, runState);
      continue;
    }
    if (record && config.journalFile) {
      transitionGovernessControl(
        config.journalFile,
        record.controlId,
        "dispatched",
        new Date(deps.now()).toISOString()
      );
    }
    const adapter = createGovernessRuntimeAdapter(config, deps, info);
    try {
      await adapter.requestExit({
        action: "exit",
        controlId:
          record?.controlId ??
          controlKey(config, "handover-loop", info.agent, payload),
        epoch: config.epoch ?? runState.governessEpoch,
        message: payload,
        target: info.agent,
      });
    } catch (error) {
      if (record && config.journalFile) {
        transitionGovernessControl(
          config.journalFile,
          record.controlId,
          "failed",
          new Date(deps.now()).toISOString(),
          error instanceof Error ? error.message : String(error)
        );
      }
      deps.appendLog(config.logFile, {
        agent: info.agent,
        at: new Date(deps.now()).toISOString(),
        error: error instanceof Error ? error.message : String(error),
        event: "handover-agent-exit-refused",
      });
      continue;
    }
    if (record && config.journalFile) {
      transitionGovernessControl(
        config.journalFile,
        record.controlId,
        "accepted",
        new Date(deps.now()).toISOString(),
        "guarded terminal exit accepted input",
        { transport: "tmux-fallback" }
      );
    }
    requested[info.agent] = true;
    deps.saveState(config.stateFile, runState);
    deps.appendLog(config.logFile, {
      agent: info.agent,
      at: new Date(deps.now()).toISOString(),
      event: "handover-agent-exit-requested",
    });
  }
};

export type HandoverAdvanceResult =
  | { status: "inactive" | "waiting" }
  | { error: string; status: "launch-error" }
  | { session?: string; status: "launched" };

export const advanceHandoverControl = async (
  config: GovernessConfig,
  deps: GovernessDeps,
  runState: GovernessRunState,
  agentStates: Partial<Record<Agent, string>>
): Promise<HandoverAdvanceResult> => {
  if (runState.exitControl.mode === "launched") {
    const replacementSession = runState.exitControl.replacementSession;
    const replacementAliveProbe = replacementSession
      ? (deps.replacementSessionAlive?.(replacementSession) ?? false)
      : false;
    const replacementReadyProbe = replacementSession
      ? deps.replacementSessionReady(replacementSession)
      : false;
    const replacementAlive = replacementAliveProbe === true;
    const replacementReady = replacementReadyProbe === true;
    const handoverAccepted = Boolean(
      replacementSession &&
        runState.exitControl.handoverManifest &&
        readGovernessHandoffAcceptance(
          runState.exitControl.handoverManifest,
          replacementSession
        )
    );
    recordGovernessObservation(config, deps, {
      idempotencyKey: `${config.epoch}:replacement:${replacementSession ?? "missing"}:${replacementAlive}:${replacementReady}:${runState.tick}`,
      payload: JSON.stringify({
        accepted: handoverAccepted,
        alive: replacementAliveProbe,
        ready: replacementReadyProbe,
        session: replacementSession,
      }),
      stream: `replacement:${replacementSession ?? "missing"}`,
    });
    if (
      replacementAliveProbe === "unknown" ||
      replacementReadyProbe === "unknown"
    ) {
      deps.appendLog(config.logFile, {
        at: new Date(deps.now()).toISOString(),
        event: "handover-replacement-tmux-unknown",
        replacementSession,
      });
      return { status: "waiting" };
    }
    if (!(replacementSession && replacementAlive)) {
      const error = replacementSession
        ? `replacement tmux session ${replacementSession} is not running`
        : "replacement session was not persisted";
      runState.exitControl = {
        ...runState.exitControl,
        launchError: error,
        mode: "launch-error",
      };
      deps.appendLog(config.logFile, {
        at: new Date(deps.now()).toISOString(),
        error,
        event: "handover-replacement-missing",
      });
      deps.saveState(config.stateFile, runState);
      return { error, status: "launch-error" };
    }
    if (!replacementReady) {
      deps.appendLog(config.logFile, {
        at: new Date(deps.now()).toISOString(),
        event: "handover-replacement-not-ready",
        replacementSession,
      });
      return { status: "waiting" };
    }
    if (!handoverAccepted) {
      return { status: "waiting" };
    }
    return {
      session: replacementSession,
      status: "launched",
    };
  }
  if (runState.exitControl.mode !== "handover") {
    return { status: "inactive" };
  }
  await notifyHandoverAgents(config, deps, runState, agentStates);
  if (config.runDir) {
    for (const info of config.agents) {
      const bundleFile = governessHandoffFile(
        config.runDir,
        runState.governessEpoch,
        info.agent
      );
      if (
        readGovernessHandoffBundle(
          bundleFile,
          info.agent,
          runState.governessEpoch
        )
      ) {
        runState.handoverBundles[info.agent] = bundleFile;
        if (config.journalFile) {
          const control = latestGovernessControlByKey(
            config.journalFile,
            `${runState.governessEpoch}:handover:${info.agent}`
          );
          if (
            control &&
            control.phase !== "completed" &&
            control.phase !== "failed"
          ) {
            transitionGovernessControl(
              config.journalFile,
              control.controlId,
              "completed",
              new Date(deps.now()).toISOString(),
              "agent published validated handover bundle",
              { evidence: bundleFile }
            );
          }
        }
      }
    }
  }
  await requestDrainedAgentExits(config, deps, runState, agentStates);
  if (!allHandoverAgentsExited(config, deps, runState)) {
    return { status: "waiting" };
  }
  const handoverManifest = config.runDir
    ? writeGovernessHandoffManifest(
        config.runDir,
        runState.governessEpoch,
        config.agents.map((info) => info.agent),
        new Date(deps.now()).toISOString()
      )
    : undefined;
  if (!handoverManifest) {
    const error = "could not create validated handover manifest";
    runState.exitControl = {
      ...runState.exitControl,
      launchError: error,
      mode: "launch-error",
    };
    return { error, status: "launch-error" };
  }
  const launched = deps.launchReplacementLoop?.(config) ?? {
    error: "replacement launcher unavailable",
    ok: false,
  };
  if (!launched.ok) {
    const error = launched.error ?? "unknown launch error";
    runState.exitControl = {
      ...runState.exitControl,
      launchError: error,
      mode: "launch-error",
    };
    deps.appendLog(config.logFile, {
      at: new Date(deps.now()).toISOString(),
      error,
      event: "handover-launch-failed",
    });
    return { error, status: "launch-error" };
  }
  const replacementAliveProbe = launched.session
    ? (deps.replacementSessionAlive?.(launched.session) ?? false)
    : false;
  const replacementReadyProbe = launched.session
    ? deps.replacementSessionReady(launched.session)
    : false;
  const replacementAlive = replacementAliveProbe === true;
  const replacementReady = replacementReadyProbe === true;
  recordGovernessObservation(config, deps, {
    idempotencyKey: `${config.epoch}:replacement-launch:${launched.session ?? "missing"}:${replacementReady}:${runState.tick}`,
    payload: JSON.stringify({
      alive: replacementAliveProbe,
      ready: replacementReadyProbe,
      session: launched.session,
    }),
    stream: `replacement-launch:${launched.session ?? "missing"}`,
  });
  if (
    launched.session &&
    (replacementAliveProbe === "unknown" ||
      replacementReadyProbe === "unknown" ||
      (replacementAlive && !replacementReady))
  ) {
    runState.exitControl = {
      ...runState.exitControl,
      handoverManifest,
      launchError: undefined,
      mode: "launched",
      replacementSession: launched.session,
    };
    deps.appendLog(config.logFile, {
      at: new Date(deps.now()).toISOString(),
      alive: replacementAliveProbe,
      event: "handover-replacement-pending",
      ready: replacementReadyProbe,
      replacementSession: launched.session,
    });
    deps.saveState(config.stateFile, runState);
    return { status: "waiting" };
  }
  if (!(launched.session && replacementAlive && replacementReady)) {
    const error = launched.session
      ? `replacement tmux session ${launched.session} is not running`
      : "replacement launcher did not return a session";
    runState.exitControl = {
      ...runState.exitControl,
      launchError: error,
      mode: "launch-error",
    };
    deps.appendLog(config.logFile, {
      at: new Date(deps.now()).toISOString(),
      error,
      event: "handover-replacement-not-ready",
    });
    deps.saveState(config.stateFile, runState);
    return { error, status: "launch-error" };
  }
  deps.appendLog(config.logFile, {
    at: new Date(deps.now()).toISOString(),
    event: "handover-launched",
    replacementSession: launched.session,
  });
  runState.exitControl = {
    ...runState.exitControl,
    handoverManifest,
    launchError: undefined,
    mode: "launched",
    replacementSession: launched.session,
  };
  // Persist the transaction result before the caller tears down this session.
  deps.saveState(config.stateFile, runState);
  return { status: "waiting" };
};

export const stopGovernessLoop = (
  config: GovernessConfig,
  deps: GovernessDeps,
  reason: string
): void => {
  const policy = decideGovernessPolicy("teardown-loop", {
    confirmed: true,
    fenceCurrent: governessFenceCurrent(config, deps),
  });
  deps.appendLog(config.logFile, {
    at: new Date(deps.now()).toISOString(),
    event: "exit",
    reason,
  });
  if (!policy.allowed) {
    deps.appendLog(config.logFile, {
      at: new Date(deps.now()).toISOString(),
      event: "exit-denied",
      reason: policy.reason,
    });
    return;
  }
  const now = new Date(deps.now()).toISOString();
  const payload = `${config.session}:${reason}`;
  const record = config.journalFile
    ? prepareGovernessControl(config.journalFile, {
        action: "teardown-loop",
        at: now,
        epoch: config.epoch ?? 0,
        idempotencyKey: controlKey(config, "teardown-loop", undefined, payload),
        payload,
        policyClass: policy.class,
        policyContext: {
          confirmed: true,
          fenceCurrent: governessFenceCurrent(config, deps),
        },
      })
    : undefined;
  if (record && record.phase !== "prepared") {
    return;
  }
  if (record && config.journalFile) {
    transitionGovernessControl(
      config.journalFile,
      record.controlId,
      "dispatched",
      now
    );
  }
  deps.markRunStopped?.(config, reason);
  try {
    const cleanup = deps.cleanupRunProcesses?.(config);
    if (cleanup && (cleanup.killed.length > 0 || cleanup.skipped.length > 0)) {
      deps.appendLog(config.logFile, {
        at: new Date(deps.now()).toISOString(),
        event: "run-process-cleanup",
        ...cleanup,
      });
    }
  } catch (error) {
    deps.appendLog(config.logFile, {
      at: new Date(deps.now()).toISOString(),
      error: error instanceof Error ? error.message : String(error),
      event: "run-process-cleanup-failed",
    });
  }
  try {
    deps.killSession?.(config.session);
    if (record && config.journalFile) {
      transitionGovernessControl(
        config.journalFile,
        record.controlId,
        "accepted",
        new Date(deps.now()).toISOString()
      );
    }
  } catch (error) {
    if (record && config.journalFile) {
      transitionGovernessControl(
        config.journalFile,
        record.controlId,
        "failed",
        new Date(deps.now()).toISOString(),
        error instanceof Error ? error.message : String(error)
      );
    }
    deps.appendLog(config.logFile, {
      at: new Date(deps.now()).toISOString(),
      error: error instanceof Error ? error.message : String(error),
      event: "tmux-session-kill-unconfirmed",
      session: config.session,
    });
  }
};

export const driveHandoverControl = async (
  config: GovernessConfig,
  deps: GovernessDeps,
  runState: GovernessRunState,
  agentStates: Partial<Record<Agent, string>>
): Promise<boolean> => {
  const handover = await advanceHandoverControl(
    config,
    deps,
    runState,
    agentStates
  );
  deps.saveState(config.stateFile, runState);
  if (handover.status !== "launched") {
    return false;
  }
  stopGovernessLoop(
    config,
    deps,
    handover.session
      ? `handed over to ${handover.session}`
      : "handed over to replacement loop"
  );
  return true;
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
  runState: GovernessRunState,
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
  runState: GovernessRunState,
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
  config: GovernessConfig,
  deps: GovernessDeps,
  runState: GovernessRunState,
  nowIso: string
): Promise<RoleTransitionResult> => {
  const transitionUsageByJudge = emptyLocalLlmUsageByJudge();
  const leaseValid = driverLeaseIsCurrent(
    runState.driverLease,
    config.epoch,
    Date.parse(nowIso)
  );
  const rolePolicy = decideGovernessPolicy("change-driver", {
    deterministicReason: true,
    fenceCurrent: governessFenceCurrent(config, deps) && leaseValid,
  });
  if (!rolePolicy.allowed) {
    deps.appendLog(config.logFile, {
      at: nowIso,
      event: "role-change-denied",
      reason: leaseValid ? rolePolicy.reason : "driver lease is stale",
    });
    return { llmUsageByJudge: transitionUsageByJudge };
  }
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
  // role handoff. Older governesses did create one, which made a missing usage
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
        incrementCount(runState.governessMessages, restored);
      }
      if (temporary && temporaryInfo) {
        temporaryDelivery = await sendRoleMessage(
          config,
          deps,
          temporaryInfo,
          temporary,
          restored,
          restoreTemporaryDriverMessage(restored, temporary)
        );
        incrementCount(runState.governessMessages, temporary);
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
  // Founder directive (2026-07-23): do NOT reassign the driver based on
  // quota/session-limit pressure. The initial driver stays the driver even when
  // limited; the governess still does idle recovery, rename, and notifications.
  // Re-enable quota-based driver handoff by setting LOOP_GOVERNESS_LIMIT_HANDOFF=1.
  const limitHandoffEnabled = config.limitHandoffEnabled === true;
  for (const [paused, pressure] of pressures) {
    if (!limitHandoffEnabled) {
      // Track the observation for dedupe so we don't re-evaluate every tick,
      // but never switch the driver or send a "you are now the driver" message.
      runState.notified.limitHandoff[paused] = pressure.key;
      continue;
    }
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
    incrementCount(runState.governessMessages, driver);
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
  incrementCount(runState.governessMessages, next);
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
    incrementCount(runState.governessMessages, previous);
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
  runState: GovernessRunState,
  waiting: WaitingForYou,
  totalCost: number,
  config: GovernessConfig
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
export const governessTick = async (
  states: Map<Agent, AgentLivenessState>,
  config: GovernessConfig,
  deps: GovernessDeps,
  runStateIn: GovernessRunState = freshRunState()
): Promise<GovernessTickResult> => {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const governessMessages = readCountMap(runStateIn.governessMessages);
  const runState: GovernessRunState = {
    ...runStateIn,
    governessMessages:
      Object.keys(governessMessages).length > 0
        ? governessMessages
        : readGovernessMessageCountsFromLog(config.logFile),
    notified: {
      ...runStateIn.notified,
      ladder: { ...runStateIn.notified.ladder },
      limitHandoff: { ...runStateIn.notified.limitHandoff },
    },
    paneLabels: { ...runStateIn.paneLabels },
    paneTitles: { ...runStateIn.paneTitles },
    roles: { ...runStateIn.roles },
    sessionPressure: { ...runStateIn.sessionPressure },
    sessionPressurePrepared: { ...runStateIn.sessionPressurePrepared },
    stats: cloneStats(runStateIn.stats),
    tick: runStateIn.tick + 1,
  };
  if (!runState.driverLease && governessFenceCurrent(config, deps)) {
    const holder =
      runState.roles.currentDriver ??
      runState.roles.initialDriver ??
      config.initialDriver ??
      config.agents[0]?.agent;
    if (holder && typeof config.epoch === "number") {
      runState.driverLease = {
        epoch: config.epoch,
        expiresAt: new Date(
          nowMs + Math.max(config.tickMs * 3, 60_000)
        ).toISOString(),
        holder,
      };
    }
  }
  let { history, recoveries, llmUsage } = runState;
  let llmUsageByJudge = runState.llmUsageByJudge;
  if (
    Object.keys(llmUsageByJudge).length === 0 &&
    (runState.llmUsage.totalTokens > 0 || runState.llmUsage.calls > 0)
  ) {
    llmUsageByJudge = { [primaryJudge(config).id]: runState.llmUsage };
  }
  let llmOffline = false;
  const llmOfflineByJudge: Record<string, boolean> = {};
  const rows: AgentRow[] = [];
  const summaryCtxs: SummaryAgentContext[] = [];
  const usageLimits = await deps.readUsageLimits(config).catch(() => undefined);

  const paneTexts = new Map<Agent, string>();
  let paneCommands: Partial<Record<Agent, string>> = {};
  let tmuxControlError: TmuxControlUnavailableError | undefined;
  for (const info of config.agents) {
    try {
      paneTexts.set(info.agent, deps.capturePane(info.pane));
    } catch (error) {
      if (!isTmuxControlUnavailableError(error)) {
        throw error;
      }
      tmuxControlError = error;
      break;
    }
  }
  if (!tmuxControlError && deps.readPaneCommands) {
    try {
      paneCommands = deps.readPaneCommands(config.agents);
      const missing = config.agents.find(
        (info) => paneCommands[info.agent] === undefined
      );
      if (missing) {
        throw new TmuxControlUnavailableError([
          "list-panes",
          "-t",
          config.session,
        ]);
      }
    } catch (error) {
      if (!isTmuxControlUnavailableError(error)) {
        throw error;
      }
      tmuxControlError = error;
    }
  }
  const tmuxControlAvailable = tmuxControlError === undefined;
  if (tmuxControlError) {
    const previous = runStateIn.tmuxControl;
    runState.tmuxControl = {
      lastFailureAtMs: nowMs,
      reason: tmuxControlError.args[0] ?? "control",
      unavailableSinceMs: previous?.unavailableSinceMs ?? nowMs,
    };
    if (!previous) {
      deps.appendLog(config.logFile, {
        at: nowIso,
        error: tmuxControlError.message,
        event: "tmux-control-unavailable",
      });
    }
  } else {
    const previous = runStateIn.tmuxControl;
    if (previous) {
      deps.appendLog(config.logFile, {
        at: nowIso,
        event: "tmux-control-restored",
        unavailableMs: Math.max(0, nowMs - previous.unavailableSinceMs),
      });
    }
    runState.tmuxControl = undefined;
  }

  for (const info of config.agents) {
    const context = {
      history,
      nowIso,
      nowMs,
      recoveries,
      tick: runState.tick,
      usageLimits,
    };
    const result = tmuxControlAvailable
      ? await processAgent(
          info,
          states,
          config,
          deps,
          context,
          paneTexts.get(info.agent) ?? ""
        )
      : processAgentWithoutPane(info, states, deps, context);
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
      incrementCount(runState.governessMessages, info.agent);
    }
  }

  const sessionPressure = tmuxControlAvailable
    ? await reconcileSessionPressure(rows, config, deps, runState, nowIso)
    : runState.sessionPressure;

  const roleTransitions =
    tmuxControlAvailable && runState.exitControl.mode === "idle"
      ? await handleRoleTransitions(rows, config, deps, runState, nowIso)
      : { llmUsageByJudge: emptyLocalLlmUsageByJudge() };
  llmUsageByJudge = addLocalLlmUsageByJudge(
    llmUsageByJudge,
    roleTransitions.llmUsageByJudge
  );
  llmUsage = addLocalLlmUsage(
    llmUsage,
    sumLocalLlmUsageByJudge(roleTransitions.llmUsageByJudge)
  );
  if (tmuxControlAvailable) {
    accumulateStats(runState.stats, rows, config.tickMs);
    applyPaneLabels(config, deps, rows, runState);
  }

  // The session summary is generated off the tick (see runGoverness) so a slow
  // local-LLM call never freezes the board; here we just render runState.summary
  // as carried in, and hand back the contexts a background refresh needs.
  runState.history = history;
  runState.recoveries = recoveries;
  runState.llmUsage = llmUsage;
  runState.llmUsageByJudge = llmUsageByJudge;
  runState.llmTokens = llmUsage.totalTokens;

  const totalCost = rows.reduce((sum, row) => sum + row.usage.costUsd, 0);
  const waitingForYou = tmuxControlAvailable
    ? updateBothIdle(runState, rows, nowMs)
    : { ask: "", confirmed: false, ms: 0 };
  if (tmuxControlAvailable) {
    for (const event of collectEscalations(
      runState,
      waitingForYou,
      totalCost,
      config
    )) {
      deps.notify(config.ntfyUrl, event);
    }
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
    governessMessages: runState.governessMessages,
    identity: composeGovernessRunIdentity(config),
    bridge: deps.readBridge(config.transcriptPath),
    bridgeLatest: deps.readBridgeLatest(config.runDir),
    budgetUsd: config.budgetUsd,
    cavemanMode: config.cavemanMode,
    helperCavemanMode: config.helperCavemanMode,
    initialDriver: config.initialDriver,
    judgeMode: config.judgeMode,
    llmJudges: judges,
    llmOfflineByJudge,
    llmRuntimeByJudge,
    llmUsageByJudge,
    maxColumns: config.viewportColumns ?? process.stdout.columns,
    maxRows: config.viewportRows ?? process.stdout.rows,
    nowMs,
    recoveries,
    roles: runState.roles,
    stats: runState.stats,
    summary: runState.summary,
    tickMs: config.tickMs,
    tmuxControl: runState.tmuxControl,
    uptimeMs,
    ...(config.runDir
      ? {
          auPair: readUtilityObservability(config.runDir, UTILITY_AU_PAIR_TIER),
          direct: readUtilityObservability(config.runDir, UTILITY_DIRECT_TIER),
          nanny: readUtilityObservability(config.runDir, UTILITY_NANNY_TIER),
          nativeFallback: readNativeFallbackBoard(
            config.runDir,
            config.nativeSubagentMode ??
              resolveNativeSubagentMode(process.env.LOOP_NATIVE_SUBAGENT_MODE)
          ),
          utility: readUtilityObservability(config.runDir),
        }
      : {}),
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
  return {
    agentStates,
    board,
    llmOffline,
    paneCommands,
    runState,
    sessionPressure,
    states,
    summaryCtxs,
    tmuxControlAvailable,
  };
};

const runBoundedTmux = (
  args: string[],
  options: { stderr?: "ignore" | "pipe"; stdout?: "ignore" | "pipe" } = {}
) => {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      ["tmux", ...args],
      boundedTmuxOptions({
        stderr: options.stderr ?? "ignore",
        stdout: options.stdout ?? "ignore",
      })
    );
  } catch (error) {
    throw new TmuxControlUnavailableError(args, error);
  }
  if (tmuxCommandTimedOut(result)) {
    throw new TmuxControlUnavailableError(args);
  }
  return result;
};

const tmux = (args: string[]): string =>
  decode(runBoundedTmux(args, { stdout: "pipe" }).stdout);

const runTmuxEffect = (args: string[]): void => {
  const result = runBoundedTmux(args);
  if (result.exitCode !== 0) {
    throw new Error(`tmux control failed: tmux ${args.join(" ")}`);
  }
};

const bestEffortTmux = (args: string[]): void => {
  try {
    runBoundedTmux(args);
  } catch (error) {
    if (!isTmuxControlUnavailableError(error)) {
      throw error;
    }
  }
};

const readPaneCommandsFromTmux = (
  panes: GovernessAgentInfo[]
): Partial<Record<Agent, string>> => {
  const result = runBoundedTmux(
    [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_dead}:#{pane_current_command}",
    ],
    { stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    return Object.fromEntries(panes.map((info) => [info.agent, "1:missing"]));
  }
  const probes = new Map<string, string>();
  for (const line of decode(result.stdout).split("\n")) {
    const [paneId, paneTarget, probe] = line.split("\t");
    if (!(paneId && paneTarget && probe)) {
      continue;
    }
    probes.set(paneId, probe);
    probes.set(paneTarget, probe);
  }
  return Object.fromEntries(
    panes.map((info) => [info.agent, probes.get(info.pane) ?? "1:missing"])
  );
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

// Persist run-state so cumulative stats survive a governess respawn.
export const loadGovernessState = (
  stateFile?: string
): GovernessRunState | undefined => {
  if (!stateFile) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(stateFile, "utf8")
    ) as Partial<GovernessRunState>;
    const stats = parsed.stats;
    if (!stats) {
      return undefined;
    }
    const llmUsage = readLocalLlmUsage(parsed.llmUsage, parsed.llmTokens);
    const lifecycleEvents =
      parsed.lifecycleEvents && typeof parsed.lifecycleEvents === "object"
        ? parsed.lifecycleEvents
        : {};
    const driverLease =
      parsed.driverLease &&
      typeof parsed.driverLease.epoch === "number" &&
      typeof parsed.driverLease.expiresAt === "string" &&
      typeof parsed.driverLease.holder === "string"
        ? parsed.driverLease
        : undefined;
    const tmuxControl = readTmuxControlState(parsed.tmuxControl);
    return {
      governessMessages: readCountMap(parsed.governessMessages),
      bothIdleSince:
        typeof parsed.bothIdleSince === "number" ? parsed.bothIdleSince : 0,
      ...(driverLease ? { driverLease } : {}),
      exitControl: readExitControl(parsed.exitControl),
      governessEpoch:
        typeof parsed.governessEpoch === "number" ? parsed.governessEpoch : 0,
      handoverBundles: readStringMap(parsed.handoverBundles),
      history: Array.isArray(parsed.history) ? parsed.history : [],
      lifecycleEvents,
      llmUsage,
      llmUsageByJudge: readLocalLlmUsageByJudge(
        parsed.llmUsageByJudge,
        judgeIdFromModel(DEFAULT_GOVERNESS_MODEL),
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
      sessionPressure: readSessionPressureByAgent(parsed.sessionPressure),
      sessionPressurePrepared: readAgentBooleanMap(
        parsed.sessionPressurePrepared
      ),
      stats: {
        activeMs: stats.activeMs ?? {},
        humanIdleMs: stats.humanIdleMs ?? 0,
        idleMs: stats.idleMs ?? {},
      },
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      summaryTick:
        typeof parsed.summaryTick === "number" ? parsed.summaryTick : -1,
      tick: typeof parsed.tick === "number" ? parsed.tick : 0,
      ...(tmuxControl ? { tmuxControl } : {}),
      waitingAsk:
        typeof parsed.waitingAsk === "string" ? parsed.waitingAsk : "",
      waitingConfirmed: parsed.waitingConfirmed === true,
    };
  } catch {
    return undefined;
  }
};

export const saveGovernessState = (
  stateFile: string | undefined,
  state: GovernessRunState
): void => {
  if (!stateFile) {
    return;
  }
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    const persisted = loadGovernessState(stateFile);
    if (persisted && persisted.governessEpoch > state.governessEpoch) {
      return;
    }
    const temporary = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), "utf8");
    renameSync(temporary, stateFile);
  } catch {
    // Best-effort persistence.
  }
};

const sendGovernessBridgeMessage = async (
  runDir: string,
  source: Agent,
  target: Agent,
  message: string,
  options: BridgeEnqueueOptions = {}
): Promise<BridgeSendStatus> => {
  let deliver: ImmediateBridgeDelivery | undefined;
  if (target === "codex") {
    deliver = async (entry) =>
      (await deliverCodexBridgeMessage(runDir, entry)) ||
      (await deliverTmuxBridgeMessage(runDir, entry));
  } else if (
    target === "cursor" ||
    target === "gemini" ||
    target === "copilot"
  ) {
    deliver = (entry) => deliverTmuxBridgeMessage(runDir, entry);
  }
  const result = await dispatchBridgeMessage(
    runDir,
    source,
    target,
    message,
    deliver,
    undefined,
    options
  );
  if (result.status === "dead-letter" || result.status === "expired") {
    throw new Error(result.reason ?? `bridge ${result.status}`);
  }
  if (result.status === "duplicate") {
    return "accepted";
  }
  if (
    result.status === "queued" &&
    hasBridgeDeliveryRoute(runDir, target) &&
    ensureBridgeWorker(runDir)
  ) {
    result.status = "accepted";
  }
  return result.status as BridgeSendStatus;
};

let governessAlternateScreenStarted = false;
let previousGovernessFrame = "";

export const governessFrameDelta = (previous: string, next: string): string => {
  if (previous === next) {
    return "";
  }
  const previousLines = previous.split("\n");
  const nextLines = next.split("\n");
  const lineCount = Math.max(previousLines.length, nextLines.length);
  const updates: string[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    const before = previousLines[index] ?? "";
    const after = nextLines[index] ?? "";
    if (before === after) {
      continue;
    }
    updates.push(`\x1b[${index + 1};1H\x1b[2K${after}`);
  }
  return `${updates.join("")}\x1b[H`;
};

const renderDefaultGovernessFrame = (text: string): void => {
  if (process.stdout.isTTY && !governessAlternateScreenStarted) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    process.once("exit", () => {
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    });
    governessAlternateScreenStarted = true;
  }
  if (text === previousGovernessFrame) {
    return;
  }
  process.stdout.write(
    previousGovernessFrame
      ? governessFrameDelta(previousGovernessFrame, text)
      : `\x1b[2J\x1b[H${text}`
  );
  previousGovernessFrame = text;
};

export const defaultGovernessDeps = (
  readUsageLimits = createStableUsageLimitReader()
): GovernessDeps => ({
  assessRoleBalance: (req) => assessRoleBalance(req),
  assessWaiting: (req) => assessWaiting(req),
  appendLog: (file, record) => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  },
  capturePane: (pane) => tmux(["capture-pane", "-p", "-t", pane]),
  cleanupRunProcesses: (config) => {
    if (!config.runDir) {
      return undefined;
    }
    const manifest = config.manifestPath
      ? readRunManifest(config.manifestPath)
      : undefined;
    return cleanupRunOwnedProcesses(config.runDir, manifest);
  },
  fenceCurrent: (config) => {
    if (!(config.stateFile && typeof config.epoch === "number")) {
      return false;
    }
    return (
      loadGovernessState(config.stateFile)?.governessEpoch === config.epoch
    );
  },
  initPaneBorders: (session) => {
    bestEffortTmux(["set-option", "-t", session, "pane-border-status", "top"]);
    bestEffortTmux([
      "set-option",
      "-t",
      session,
      "pane-border-format",
      GOVERNESS_DEAD_PANE_BORDER_FORMAT,
    ]);
  },
  judge: (req) => judgeAgent(req),
  labelPanes: (req) => labelPanes(req),
  loadState: (stateFile) => loadGovernessState(stateFile),
  launchReplacementLoop: (config) => {
    const primary = config.initialDriver ?? config.agents[0]?.agent;
    const peer = config.agents.find((info) => info.agent !== primary)?.agent;
    if (primary === undefined || peer === undefined) {
      return { error: "handover requires two agents", ok: false };
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "LOOP_RUN_ID")
    );
    const handoffDir = config.runDir
      ? ensureGovernessHandoffDir(config.runDir, config.epoch ?? 0)
      : undefined;
    if (handoffDir) {
      writeFileSync(
        handoverContinuationFile(handoffDir),
        `${handoverContinuationText(handoffDir)}\n`,
        "utf8"
      );
      const manifestFile = writeGovernessHandoffManifest(
        config.runDir as string,
        config.epoch ?? 0,
        config.agents.map((info) => info.agent),
        new Date().toISOString()
      );
      if (!manifestFile) {
        return {
          error: "handover bundles changed before manifest creation",
          ok: false,
        };
      }
      env.LOOP_GOVERNESS_HANDOFF_MANIFEST = manifestFile;
    }
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(
        [
          ...buildLaunchArgv(),
          ...replacementLoopArgs(primary, peer, handoffDir),
        ],
        {
          cwd: config.cwd,
          env,
          killSignal: "SIGKILL",
          stderr: "pipe",
          stdout: "pipe",
          timeout: 60_000,
        }
      );
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }
    const stdout = decode(result.stdout);
    const stderr = decode(result.stderr);
    if (result.signalCode) {
      return {
        error: "replacement launcher timed out after 60000ms",
        ok: false,
      };
    }
    if (result.exitCode !== 0) {
      return {
        error: (stderr || stdout || `exit ${result.exitCode}`).trim(),
        ok: false,
      };
    }
    const session = stdout.match(STARTED_TMUX_SESSION_RE)?.[1];
    if (!session) {
      return {
        error: "replacement command succeeded without reporting a tmux session",
        ok: false,
      };
    }
    const sessionLiveness = tmuxSessionLiveness(session);
    if (sessionLiveness === "dead") {
      return {
        error: `replacement tmux session ${session} is not running`,
        ok: false,
      };
    }
    return { ok: true, session };
  },
  markRunStopped: (config, reason) => {
    if (config.manifestPath) {
      updateRunManifest(config.manifestPath, (manifest) =>
        manifest ? setRunManifestState(manifest, "stopped") : undefined
      );
    }
    config.transcriptPath &&
      appendFileSync(
        config.transcriptPath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          detail: reason,
          kind: "status",
          state: "stopped",
        })}\n`,
        "utf8"
      );
  },
  killSession: (session) => {
    runBoundedTmux(["kill-session", "-t", session]);
  },
  notify: (ntfyUrl, event) => sendNtfy(ntfyUrl, event),
  now: () => Date.now(),
  openKeyInput: () => openRawKeyInput(),
  paneCommand: (pane) => {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = runBoundedTmux(
        [
          "display-message",
          "-p",
          "-t",
          pane,
          "#{pane_dead}:#{pane_current_command}",
        ],
        { stdout: "pipe" }
      );
    } catch (error) {
      if (isTmuxControlUnavailableError(error)) {
        return undefined;
      }
      throw error;
    }
    return paneProbeFromTmuxResult(result.exitCode, decode(result.stdout));
  },
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
  readPaneCommands: (panes) => readPaneCommandsFromTmux(panes),
  readUsage: (agent, sessionRef, codexHome) =>
    readAgentUsage(agent, sessionRef, codexHome),
  readUsageLimits: (config) =>
    readUsageLimits({
      secret: config.usageTrackerSecret,
      timeoutMs: config.usageTrackerTimeoutMs,
      url: config.usageTrackerUrl,
    }),
  replacementSessionAlive: (session) => {
    const liveness = tmuxSessionLiveness(session);
    return liveness === "unknown" ? "unknown" : liveness === "live";
  },
  replacementSessionReady: (session) => {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = runBoundedTmux(
        [
          "list-panes",
          "-t",
          session,
          "-F",
          "#{pane_dead}:#{pane_current_command}",
        ],
        { stdout: "pipe" }
      );
    } catch (error) {
      if (isTmuxControlUnavailableError(error)) {
        return "unknown";
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      return false;
    }
    const livePanes = decode(result.stdout)
      .split("\n")
      .filter((line) => line.startsWith("0:")).length;
    return livePanes >= 3;
  },
  render: (text) => {
    renderDefaultGovernessFrame(text);
  },
  respawnPane: (pane) => {
    runTmuxEffect(["respawn-pane", "-k", "-t", pane]);
  },
  saveState: (stateFile, state) => saveGovernessState(stateFile, state),
  sendBridge: (runDir, source, target, message, options) =>
    sendGovernessBridgeMessage(runDir, source, target, message, options),
  setPaneLabel: (pane, label) => {
    bestEffortTmux(["set-option", "-p", "-t", pane, "@loop_label", label]);
  },
  setGovernessPaneIdentity: (pane, label) => {
    for (const args of governessPaneIdentityTmuxCommands(pane, label)) {
      bestEffortTmux(args);
    }
  },
  sendKeys: (pane, keys) => {
    runTmuxEffect(["send-keys", "-t", pane, ...keys]);
  },
  sendText: (pane, text) => {
    runTmuxEffect(["send-keys", "-t", pane, "-l", "--", text]);
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
  const parsed = Number.parseFloat(env.LOOP_GOVERNESS_CONFIDENCE ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_GOVERNESS_CONFIDENCE;
};

const envJudgeMode = (env: NodeJS.ProcessEnv): LocalLlmJudgeMode =>
  env.LOOP_GOVERNESS_JUDGE_MODE === "round-robin" ? "round-robin" : "consensus";

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

export const agentRenameEnabledFromEnv = (env: NodeJS.ProcessEnv): boolean =>
  envEnabled(env.LOOP_GOVERNESS_AGENT_RENAME);

const llmTraceFileFromEnv = (
  env: NodeJS.ProcessEnv,
  runDir: string
): string | undefined => {
  const raw = env.LOOP_GOVERNESS_LLM_TRACE?.trim();
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
  const raw = env.LOOP_GOVERNESS_JUDGES;
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

// Resolve the governess config from the run manifest (session + pane agents)
// and LOOP_GOVERNESS_* environment overrides set at pane launch.
export const resolveGovernessConfig = (
  runId: string,
  sourceEnv: NodeJS.ProcessEnv,
  cwd?: string,
  home?: string
): GovernessConfig => {
  const env = withLegacyGovernessEnv(sourceEnv);
  const { manifest, storage } = loadRunState(runId, cwd, home);
  const session = manifest?.tmuxSession;
  if (!session) {
    throw new Error(`[loop] governess: no tmux session for run ${runId}`);
  }
  if (
    (manifest.tmuxPaneLeft || manifest.tmuxPaneRight) &&
    (Boolean(manifest.tmuxPaneLeft) !== Boolean(manifest.tmuxPaneLeftAgent) ||
      Boolean(manifest.tmuxPaneRight) !== Boolean(manifest.tmuxPaneRightAgent))
  ) {
    throw new Error(
      `[loop] governess: incomplete tmux agent topology for run ${runId}`
    );
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
  const agents: GovernessAgentInfo[] = [];
  const addAgent = (
    agent: Agent | undefined,
    pane: string | undefined,
    fallbackPaneIndex: number
  ): void => {
    if (agent) {
      agents.push({
        agent,
        codexHome: agent === "codex" ? codexHome : undefined,
        hookFile: join(storage.runDir, "hooks", `${agent}.jsonl`),
        pane: pane ?? `${session}:0.${fallbackPaneIndex}`,
        sessionRef: sessionRefFor(agent),
      });
    }
  };
  addAgent(manifest?.tmuxPaneLeftAgent, manifest?.tmuxPaneLeft, 0);
  addAgent(manifest?.tmuxPaneRightAgent, manifest?.tmuxPaneRight, 1);
  const maxRaw = Number.parseInt(env.LOOP_GOVERNESS_MAX ?? "", 10);
  const model = env.LOOP_GOVERNESS_MODEL || DEFAULT_GOVERNESS_MODEL;
  const url = env.LOOP_GOVERNESS_URL || DEFAULT_GOVERNESS_URL;
  const llmLogFile =
    env.LOOP_GOVERNESS_LLM_LOG ||
    join(home ?? homedir(), "models", "mlx-lm.log");
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
  const budget = Number.parseFloat(env.LOOP_GOVERNESS_BUDGET ?? "");
  const stateFile = join(storage.runDir, "governess-state.json");
  migrateLegacyGovernessState(storage.runDir, stateFile);
  return {
    agentRenameEnabled: agentRenameEnabledFromEnv(env),
    agents,
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
    cavemanMode: manifest?.cavemanMode,
    confidence: envConfidence(env),
    cooldownMs: envSeconds(
      env,
      "LOOP_GOVERNESS_COOLDOWN",
      DEFAULT_GOVERNESS_COOLDOWN_SECONDS
    ),
    createdAt: manifest?.createdAt,
    cwd: manifest?.cwd,
    dryRun: env.LOOP_GOVERNESS_DRY_RUN === "1",
    escalateIdleMs: envSeconds(
      env,
      "LOOP_GOVERNESS_ESCALATE_IDLE",
      DEFAULT_GOVERNESS_ESCALATE_IDLE_SECONDS
    ),
    idleMs: envSeconds(
      env,
      "LOOP_GOVERNESS_IDLE",
      DEFAULT_GOVERNESS_IDLE_SECONDS
    ),
    initialDriver: manifest?.primaryAgent,
    helperCavemanMode: manifest?.helperCavemanMode,
    journalFile: join(storage.runDir, "governess-control.jsonl"),
    logFile: join(storage.runDir, "governess.jsonl"),
    llmDecodeConcurrency: envPositiveInt(
      env,
      "LOOP_GOVERNESS_LLM_DECODE_CONCURRENCY",
      DEFAULT_LOCAL_LLM_DECODE_CONCURRENCY
    ),
    llmLogFile,
    llmPrefillStepSize: envPositiveInt(
      env,
      "LOOP_GOVERNESS_LLM_PREFILL_STEP",
      DEFAULT_LOCAL_LLM_PREFILL_STEP_SIZE
    ),
    llmPromptCacheSlots: envPositiveInt(
      env,
      "LOOP_GOVERNESS_LLM_CACHE_SLOTS",
      DEFAULT_LOCAL_LLM_PROMPT_CACHE_SLOTS
    ),
    llmPromptConcurrency: envPositiveInt(
      env,
      "LOOP_GOVERNESS_LLM_PROMPT_CONCURRENCY",
      DEFAULT_LOCAL_LLM_PROMPT_CONCURRENCY
    ),
    llmTraceFile: llmTraceFileFromEnv(env, storage.runDir),
    limitHandoffEnabled: env.LOOP_GOVERNESS_LIMIT_HANDOFF === "1",
    judgeMode: envJudgeMode(env),
    judges: localJudgesFromEnv(env, primaryLocalJudge),
    maxRecoveries:
      Number.isInteger(maxRaw) && maxRaw > 0
        ? maxRaw
        : DEFAULT_GOVERNESS_MAX_RECOVERIES,
    model,
    modelSizeGb: primaryLocalJudge.modelSizeGb,
    nativeSubagentMode: resolveNativeSubagentMode(
      env.LOOP_NATIVE_SUBAGENT_MODE
    ),
    ntfyUrl: env.LOOP_GOVERNESS_NTFY || undefined,
    roleBalanceEnabled: envEnabled(env.LOOP_GOVERNESS_ROLE_BALANCE),
    sessionPressureMode: sessionPressureModeFromEnv(env),
    runId,
    runDir: storage.runDir,
    manifestPath: storage.manifestPath,
    session,
    stateFile,
    tickMs: envSeconds(
      env,
      "LOOP_GOVERNESS_TICK",
      DEFAULT_GOVERNESS_TICK_SECONDS
    ),
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

// Long-running loop; runs in the governess pane until the session ends.
// The board renders every tick; the (slow) local-LLM summary and the both-idle
// "does the pair need you?" judgment run in the background so they never block a
// tick, and are folded in when they complete.
export const runGoverness = async (
  config: GovernessConfig,
  deps: GovernessDeps = defaultGovernessDeps()
): Promise<void> => {
  const states = new Map<Agent, AgentLivenessState>();
  let runState = deps.loadState(config.stateFile) ?? freshRunState();
  if (config.journalFile) {
    ensureGovernessJournal(config.journalFile);
    // Parse before acquiring an epoch. A malformed journal is a hard stop: the
    // governess must not issue controls after losing idempotency evidence.
    readGovernessJournal(config.journalFile);
    maintainGovernessJournal(config.journalFile);
  }
  const acquiredEpoch = Math.max(
    runState.governessEpoch + 1,
    Date.now() * 1000 + (process.pid % 1000)
  );
  config.epoch = acquiredEpoch;
  runState.governessEpoch = acquiredEpoch;
  const initialLeaseHolder =
    runState.roles.currentDriver ??
    runState.roles.initialDriver ??
    config.initialDriver ??
    config.agents[0]?.agent;
  if (initialLeaseHolder) {
    runState.driverLease = {
      epoch: acquiredEpoch,
      expiresAt: new Date(
        deps.now() + Math.max(config.tickMs * 3, 60_000)
      ).toISOString(),
      holder: initialLeaseHolder,
    };
  }
  deps.saveState(config.stateFile, runState);
  if (deps.fenceCurrent && !deps.fenceCurrent(config)) {
    return;
  }
  if (config.runDir && !activateUtilityEpoch(config.runDir, acquiredEpoch)) {
    return;
  }
  // Light up the pane-border title strip and name the governess's own pane.
  // Done on every startup (including a replaced pane) so borders self-heal.
  deps.initPaneBorders(config.session);
  applyGovernessPaneIdentity(config, deps);
  const parentHandoffManifest = process.env.LOOP_GOVERNESS_HANDOFF_MANIFEST;
  if (parentHandoffManifest) {
    const acceptance = acceptGovernessHandoff(
      parentHandoffManifest,
      config.session,
      acquiredEpoch,
      new Date(deps.now()).toISOString()
    );
    deps.appendLog(config.logFile, {
      accepted: Boolean(acceptance),
      at: new Date(deps.now()).toISOString(),
      event: "handover-manifest-acceptance",
      manifest: parentHandoffManifest,
      replacementSession: config.session,
    });
  }
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
  const keyInput = deps.openKeyInput?.();
  let pendingKey = keyInput?.next();
  let exitMenuOpen = false;
  let currentTmuxControlAvailable = runState.tmuxControl === undefined;
  const paneCommand = (pane: string): string | undefined =>
    currentTmuxControlAvailable ? deps.paneCommand?.(pane) : undefined;
  const renderExit = (board: string): void => {
    deps.render(
      renderExitControl(
        board,
        runState.exitControl,
        exitMenuOpen,
        config.agents,
        paneCommand,
        runState.handoverBundles
      )
    );
  };
  const stopCurrentLoop = (reason: string): void =>
    stopGovernessLoop(config, deps, reason);
  const advanceHandover = async (
    agentStates: Partial<Record<Agent, string>>,
    board: string
  ): Promise<boolean> => {
    if (!currentTmuxControlAvailable) {
      renderExit(board);
      return false;
    }
    const stopped = await driveHandoverControl(
      config,
      deps,
      runState,
      agentStates
    );
    renderExit(board);
    return stopped;
  };
  try {
    if (
      runState.exitControl.mode === "launched" &&
      (await advanceHandover({}, ""))
    ) {
      return;
    }
    for (;;) {
      if (deps.fenceCurrent && !deps.fenceCurrent(config)) {
        deps.appendLog(config.logFile, {
          at: new Date(deps.now()).toISOString(),
          epoch: config.epoch,
          event: "stale-epoch-exit",
        });
        return;
      }
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

      const lifecycleActive = runState.exitControl.mode !== "idle";
      const tickConfig = lifecycleActive
        ? {
            ...config,
            agentRenameEnabled: false,
            dryRun: true,
            roleBalanceEnabled: false,
          }
        : config;
      for (const change of refreshGovernessAgentBindings(config)) {
        deps.appendLog(config.logFile, {
          agent: change.agent,
          at: new Date(deps.now()).toISOString(),
          event: "agent-session-binding-refreshed",
          from: change.previous ?? null,
          to: change.current,
        });
      }
      let result: Awaited<ReturnType<typeof governessTick>>;
      try {
        result = await governessTick(states, tickConfig, deps, runState);
      } catch (error) {
        if (!isTmuxControlUnavailableError(error)) {
          throw error;
        }
        deps.appendLog(config.logFile, {
          at: new Date(deps.now()).toISOString(),
          error: error.message,
          event: "tmux-control-unavailable",
        });
        await deps.sleep(config.tickMs);
        continue;
      }
      runState = result.runState;
      currentTmuxControlAvailable = result.tmuxControlAvailable;
      maybeBeginSessionPressureHandover(
        config,
        deps,
        runState,
        result.sessionPressure,
        result.tmuxControlAvailable
      );
      const lifecycleAt = new Date(deps.now()).toISOString();
      const holder =
        runState.roles.currentDriver ??
        runState.roles.initialDriver ??
        config.initialDriver ??
        config.agents[0]?.agent;
      if (result.tmuxControlAvailable) {
        const hooksByAgent: Partial<Record<Agent, HookEvent[]>> = {};
        for (const info of config.agents) {
          const hooks = deps.readHooks(info.hookFile);
          hooksByAgent[info.agent] = hooks;
          const observation = await createGovernessRuntimeAdapter(
            config,
            deps,
            info,
            result.agentStates[info.agent],
            result.paneCommands[info.agent]
          ).observe();
          const previous = runState.lifecycleEvents[info.agent];
          const event = lifecycleEventFromEvidence(previous, {
            agent: info.agent,
            at: lifecycleAt,
            epoch: acquiredEpoch,
            fallback: observation,
            hooks,
          });
          if (event) {
            runState.lifecycleEvents[info.agent] = event;
          }
          const runtimeProbe = {
            lifecycle: runState.lifecycleEvents[info.agent],
            observation,
          };
          recordGovernessObservation(config, deps, {
            agent: info.agent,
            idempotencyKey: `${acquiredEpoch}:runtime-probe:${info.agent}:${runState.tick}`,
            payload: JSON.stringify({ ...runtimeProbe, tick: runState.tick }),
            semanticPayload: JSON.stringify(runtimeProbe),
            stream: `runtime-probe:${info.agent}`,
          });
        }
        const fullSnapshot: GovernessObservationSnapshot = {
          agents: { ...runState.lifecycleEvents },
          at: lifecycleAt,
          controls: config.journalFile
            ? readPendingGovernessControlHistory(config.journalFile)
            : [],
          epoch: acquiredEpoch,
          ...(holder ? { holder } : {}),
          hooks: hooksByAgent,
          tick: runState.tick,
        };
        const cycleDecisions = decideGovernessCycle(fullSnapshot);
        const snapshot = compactGovernessCycleSnapshot(
          fullSnapshot,
          cycleDecisions
        );
        executeGovernessCycle(cycleDecisions, {
          renewDriverLease: (leaseHolder) => {
            runState.driverLease = {
              epoch: acquiredEpoch,
              expiresAt: new Date(
                deps.now() + Math.max(config.tickMs * 3, 60_000)
              ).toISOString(),
              holder: leaseHolder,
            };
          },
          transitionControl: (decision) => {
            if (!config.journalFile) {
              return;
            }
            transitionGovernessControl(
              config.journalFile,
              decision.controlId,
              decision.phase,
              decision.at,
              undefined,
              { evidence: decision.evidence }
            );
          },
        });
        const cycleRecord = {
          decisions: cycleDecisions,
          kind: "governess-cycle" as const,
          snapshot,
        };
        recordGovernessObservation(config, deps, {
          idempotencyKey: `${acquiredEpoch}:cycle:${runState.tick}`,
          payload: JSON.stringify(cycleRecord),
          semanticPayload: JSON.stringify({
            decisions: cycleDecisions,
            kind: cycleRecord.kind,
            snapshot: {
              agents: snapshot.agents,
              controls: snapshot.controls,
              epoch: snapshot.epoch,
              holder: snapshot.holder,
              hooks: snapshot.hooks,
            },
          }),
          stream: "governess-cycle",
        });
      }
      const utilityPeer = config.agents.find(
        (info) => info.agent !== holder
      )?.agent;
      if (config.runDir && config.cwd && holder && utilityPeer) {
        try {
          const routed = await processPendingUtilityRoutes({
            currentDriver: holder,
            epoch: acquiredEpoch,
            peer: utilityPeer,
            repoRoot: config.cwd,
            runDir: config.runDir,
          });
          if (routed > 0) {
            deps.appendLog(config.logFile, {
              at: lifecycleAt,
              epoch: acquiredEpoch,
              event: "utility-routes-processed",
              routed,
            });
          }
        } catch (error) {
          deps.appendLog(config.logFile, {
            at: lifecycleAt,
            epoch: acquiredEpoch,
            error: error instanceof Error ? error.message : String(error),
            event: "utility-routing-failed-closed",
          });
        }
      }
      if (config.runDir) {
        try {
          const processed = processPendingNativeFallbackRequests({
            epoch: acquiredEpoch,
            mode:
              config.nativeSubagentMode ??
              resolveNativeSubagentMode(process.env.LOOP_NATIVE_SUBAGENT_MODE),
            runDir: config.runDir,
          });
          if (processed > 0) {
            deps.appendLog(config.logFile, {
              at: lifecycleAt,
              epoch: acquiredEpoch,
              event: "native-fallback-requests-processed",
              processed,
            });
          }
        } catch (error) {
          deps.appendLog(config.logFile, {
            at: lifecycleAt,
            epoch: acquiredEpoch,
            error: error instanceof Error ? error.message : String(error),
            event: "native-fallback-routing-failed-closed",
          });
        }
      }
      // updateBothIdle may have cleared the waiting read (agents went active).
      waitingConfirmed = runState.waitingConfirmed;
      waitingAsk = runState.waitingAsk;

      if (
        result.tmuxControlAvailable &&
        runState.exitControl.mode === "idle" &&
        !summaryInFlight &&
        (summaryDue(summaryText, summaryTick, runState.tick) ||
          missingJudgeUsage(config, runState.llmUsageByJudge))
      ) {
        summaryInFlight = true;
        const firedAtTick = runState.tick;
        summarizeWithLocalJudges(
          config,
          deps,
          result.summaryCtxs,
          runState.tick
        )
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
      // is applied every tick inside governessTick; only the label lags.
      if (
        result.tmuxControlAvailable &&
        runState.exitControl.mode === "idle" &&
        !paneLabelInFlight &&
        paneLabelsDue(paneLabelTick, runState.tick)
      ) {
        paneLabelInFlight = true;
        const firedAtTick = runState.tick;
        labelPanesWithLocalJudges(
          config,
          deps,
          result.summaryCtxs,
          runState.tick
        )
          .then((res) => {
            if (
              runState.exitControl.mode === "idle" &&
              Object.keys(res.labels).length > 0
            ) {
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
      if (runState.exitControl.mode !== "idle") {
        assessedForIdleSince = 0;
      } else if (idleSince === 0) {
        assessedForIdleSince = 0;
      } else if (
        result.tmuxControlAvailable &&
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

      if (
        result.tmuxControlAvailable &&
        (await advanceHandover(result.agentStates, result.board))
      ) {
        return;
      }

      deps.saveState(config.stateFile, runState);
      renderExit(result.board);
      if (!pendingKey) {
        await deps.sleep(config.tickMs);
        continue;
      }
      const wake = await Promise.race([
        deps.sleep(config.tickMs).then(() => ({ kind: "tick" as const })),
        pendingKey.then((key) => ({ key, kind: "key" as const })),
      ]);
      if (wake.kind === "tick") {
        continue;
      }
      pendingKey = keyInput?.next();
      const action = exitKeyAction(
        exitMenuOpen,
        runState.exitControl.mode,
        wake.key
      );
      if (action === "menu") {
        exitMenuOpen = true;
      } else if (action === "cancel") {
        exitMenuOpen = false;
      } else if (action === "teardown") {
        stopCurrentLoop("user requested teardown");
        return;
      } else if (action === "handover") {
        exitMenuOpen = false;
        if (runState.exitControl.mode === "launch-error") {
          runState.exitControl = {
            ...runState.exitControl,
            launchError: undefined,
            mode: "handover",
          };
        } else {
          beginHandover(runState, deps.now());
        }
        if (
          result.tmuxControlAvailable &&
          (await advanceHandover(result.agentStates, result.board))
        ) {
          return;
        }
      }
      deps.saveState(config.stateFile, runState);
      renderExit(result.board);
    }
  } finally {
    keyInput?.close();
  }
};
