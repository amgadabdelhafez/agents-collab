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
  states: Map<Agent, AgentLivenessState>;
}

const hashPane = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, PANE_HASH_LENGTH);

const lastEventTs = (events: HookEvent[]): string | undefined =>
  events.length > 0 ? events.at(-1)?.ts : undefined;

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

const fmtContext = (usage: AgentUsage): string => {
  if (usage.contextTokens <= 0) {
    return "ctx=—";
  }
  const pct = Math.round((usage.contextTokens / usage.contextWindow) * 100);
  return `ctx=${fmtTokens(usage.contextTokens)}/${fmtTokens(usage.contextWindow)}(${pct}%)`;
};

const activeMs = (usage: AgentUsage): number => {
  if (!(usage.firstTs && usage.lastTs)) {
    return Number.NaN;
  }
  return Date.parse(usage.lastTs) - Date.parse(usage.firstTs);
};

const renderAgentLine = (
  liveness: AgentLiveness,
  verdict: BabysitterVerdict | undefined,
  action: RecoveryHistoryEntry | null,
  usage: AgentUsage,
  tickMs: number
): string => {
  // The TUI repaints (spinner/token counter) every second while an agent is
  // working, so a pane that changed within the last tick means it's actively
  // thinking; a pane frozen past a tick means it's genuinely idle.
  const thinking = liveness.paneIdleMs < tickMs && !liveness.suspect;
  const status = verdict?.state ?? (thinking ? "thinking" : "idle");
  // While thinking, show time since the last concrete action; while idle, show
  // how long the pane has been frozen.
  const stateField = thinking
    ? `think=${fmtDuration(liveness.lastEventAgeMs)}`
    : `idle=${fmtDuration(liveness.paneIdleMs)}`;
  const active = fmtDuration(activeMs(usage));
  const tok = usage.totalTokens > 0 ? fmtTokens(usage.totalTokens) : "—";
  const cost = usage.costUsd > 0 ? `$${usage.costUsd.toFixed(2)}` : "—";
  const summary = verdict?.summary ? ` · ${verdict.summary}` : "";
  const act = action ? ` · action=${action.level}` : "";
  return `  ${liveness.agent.padEnd(7)} [${status}] ${stateField} active=${active} ${fmtContext(usage)} tok=${tok} cost=${cost}${summary}${act}`;
};

const renderBoard = (
  lines: string[],
  llmOffline: boolean,
  nowIso: string
): string => {
  const header = `── babysitter ${nowIso}${llmOffline ? "  ⚠ LLM offline (recovery suppressed)" : ""}`;
  return [header, ...lines].join("\n");
};

// One control-loop tick: detect → (judge suspects) → recover → render + log.
export const babysitTick = async (
  states: Map<Agent, AgentLivenessState>,
  historyIn: RecoveryHistoryEntry[],
  config: BabysitConfig,
  deps: BabysitDeps
): Promise<BabysitTickResult> => {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  let history = historyIn;
  const lines: string[] = [];
  let llmOffline = false;

  for (const info of config.agents) {
    const paneText = deps.capturePane(info.pane);
    const events = deps.readHooks(info.hookFile);
    const usage = deps.readUsage(info.agent, info.sessionRef, info.codexHome);
    const prev =
      states.get(info.agent) ??
      initLivenessState(info.agent, nowMs, hashPane(paneText));
    const { state, liveness } = updateLiveness(
      prev,
      { agent: info.agent, lastEventTs: lastEventTs(events), paneHash: hashPane(paneText) },
      nowMs,
      config.idleMs
    );
    states.set(info.agent, state);

    if (!liveness.suspect) {
      // Progress observed — reset this agent's recovery ladder.
      history = history.filter((entry) => entry.agent !== info.agent);
      lines.push(renderAgentLine(liveness, undefined, null, usage, config.tickMs));
      continue;
    }

    const outcome = await deps.judge({
      agent: info.agent,
      hookTail: events.slice(-HOOK_TAIL_LIMIT),
      model: config.model,
      paneText,
      url: config.url,
    });
    const verdict = outcome.ok ? outcome.verdict : outcome.fallback;
    if (!outcome.ok && outcome.reason === "unreachable") {
      llmOffline = true;
      lines.push(renderAgentLine(liveness, verdict, null, usage, config.tickMs));
      continue;
    }

    const decision: RecoveryDecision = decideRecovery(verdict, history, info.agent, {
      confidence: config.confidence,
      cooldownMs: config.cooldownMs,
      maxRecoveries: config.maxRecoveries,
      nowMs,
    });
    const action = executeRecovery(
      decision,
      buildRecoveryDeps(info, deps, config.logFile),
      { dryRun: config.dryRun, nowIso }
    );
    if (action && !config.dryRun) {
      history = [...history, action];
    }
    deps.appendLog(config.logFile, {
      agent: info.agent,
      decision,
      dryRun: config.dryRun,
      kind: "decision",
      ts: nowIso,
      verdict,
    });
    lines.push(renderAgentLine(liveness, verdict, action, usage, config.tickMs));
  }

  const board = renderBoard(lines, llmOffline, nowIso);
  deps.render(board);
  return { board, history, llmOffline, states };
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
  for (;;) {
    const result = await babysitTick(states, history, config, deps);
    history = result.history;
    await deps.sleep(config.tickMs);
  }
};
