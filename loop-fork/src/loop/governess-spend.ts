import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EscalationEvent } from "./governess-notify";

// Run-level spend watch.
//
// Deliberately NOT a per-job gate. The 2026-07-26 removals (144c831, 4c5bc4b,
// 894773e, c23d831) deleted per-job cost/token/step ceilings because they
// failed work in flight — job 4fd7f78a died at 16,970 tokens mid-extraction,
// and four loop-48 jobs died on the step budget, each escalating to a driver
// pane. This module never rejects a route and never aborts a conversation. It
// observes cumulative run spend, escalates, and — only for a confirmed runaway,
// and only when explicitly armed — asks the caller to stop admitting NEW jobs.

const MS_PER_HOUR = 3_600_000;
const MAX_SAMPLES = 120;

// Defaults are intentionally generous. The point of observe mode is that the
// operator replaces these with numbers measured from a real week, not that
// these numbers are right.
const DEFAULT_NOTICE_USD = 2;
const DEFAULT_ALERT_USD = 5;
const DEFAULT_KILL_USD = 25;
const DEFAULT_RUNAWAY_USD_PER_HOUR = 20;
const DEFAULT_RUNAWAY_WINDOW_MS = 10 * 60_000;
// A burn rate measured over less than this is noise, not a trend.
const MIN_BURN_SPAN_MS = 60_000;

/**
 * observe  — evaluate and journal only; cannot enforce. The default.
 * alert    — deliver escalations; still cannot enforce.
 * enforce  — a confirmed runaway may stop new job admission.
 */
export type SpendMode = "observe" | "alert" | "enforce";

export type SpendLevel = "ok" | "notice" | "alert" | "runaway";

export interface SpendConfig {
  alertUsd: number;
  killUsd: number;
  mode: SpendMode;
  noticeUsd: number;
  runawayUsdPerHour: number;
  runawayWindowMs: number;
}

export interface SpendSample {
  atMs: number;
  billableUsd: number;
}

/** Real cash: OpenRouter utility-worker spend recorded for this run. */
export interface BillableSpend {
  billableUsd: number;
  jobs: number;
}

export interface SpendSnapshot {
  /** Subscription API-equivalent (Claude/Codex). Reported, never enforced on. */
  attributedUsd: number;
  billableUsd: number;
  jobs: number;
}

export interface SpendDecision {
  burnUsdPerHour: number;
  /** True only when killRequested AND mode is `enforce`. */
  enforced: boolean;
  /** True when the runaway test passed, regardless of mode. */
  killRequested: boolean;
  level: SpendLevel;
  mode: SpendMode;
  reason: string;
  snapshot: SpendSnapshot;
  /** killRequested while the mode forbids acting on it. */
  wouldKill: boolean;
}

/** Caller-owned dedupe record so each level escalates once per run. */
export type SpendNotified = Partial<Record<SpendLevel, boolean>>;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const positiveNumber = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const spendMode = (value: string | undefined): SpendMode => {
  const mode = value?.trim().toLowerCase();
  if (mode === "enforce" || mode === "alert") {
    return mode;
  }
  return "observe";
};

export const resolveSpendConfig = (
  env: Record<string, string | undefined>
): SpendConfig => ({
  alertUsd: positiveNumber(env.LOOP_SPEND_ALERT_USD, DEFAULT_ALERT_USD),
  killUsd: positiveNumber(env.LOOP_SPEND_KILL_USD, DEFAULT_KILL_USD),
  mode: spendMode(env.LOOP_SPEND_MODE),
  noticeUsd: positiveNumber(env.LOOP_SPEND_NOTICE_USD, DEFAULT_NOTICE_USD),
  runawayUsdPerHour: positiveNumber(
    env.LOOP_SPEND_RUNAWAY_USD_PER_HOUR,
    DEFAULT_RUNAWAY_USD_PER_HOUR
  ),
  runawayWindowMs: positiveNumber(
    env.LOOP_SPEND_RUNAWAY_WINDOW_MS,
    DEFAULT_RUNAWAY_WINDOW_MS
  ),
});

const eachJsonLine = (
  text: string,
  fn: (record: Record<string, unknown>) => void
): void => {
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      fn(asRecord(JSON.parse(line)));
    } catch {
      // A truncated or half-flushed line must not blind the watch.
    }
  }
};

/**
 * Sum the latest recorded cost per job from `<runDir>/utility/usage.jsonl`.
 *
 * Latest-per-job matters: workers append a usage event as a conversation
 * progresses, so summing every line would multiply a single job's cost by its
 * number of progress reports.
 */
export const readBillableSpendUsd = (runDir: string): BillableSpend => {
  const latestByJob = new Map<string, number>();
  let text: string;
  try {
    text = readFileSync(join(runDir, "utility", "usage.jsonl"), "utf8");
  } catch {
    return { billableUsd: 0, jobs: 0 };
  }
  eachJsonLine(text, (event) => {
    const jobId = event.jobId;
    const cost = asRecord(event.usage).cost;
    if (
      typeof jobId === "string" &&
      jobId.trim() &&
      typeof cost === "number" &&
      Number.isFinite(cost) &&
      cost >= 0
    ) {
      latestByJob.set(jobId, cost);
    }
  });
  const billableUsd = [...latestByJob.values()].reduce(
    (total, cost) => total + cost,
    0
  );
  return { billableUsd, jobs: latestByJob.size };
};

export const recordSpendSample = (
  history: SpendSample[],
  atMs: number,
  billableUsd: number
): SpendSample[] => [...history, { atMs, billableUsd }].slice(-MAX_SAMPLES);

/**
 * Slope of cumulative billable spend across the trailing window, in USD/hour.
 * Returns 0 unless two samples span at least MIN_BURN_SPAN_MS, so a pair of
 * near-simultaneous ticks cannot manufacture an enormous rate.
 */
export const burnUsdPerHour = (
  history: SpendSample[],
  windowMs: number
): number => {
  const last = history.at(-1);
  if (!last || history.length < 2) {
    return 0;
  }
  const cutoff = last.atMs - windowMs;
  const windowed = history.filter((sample) => sample.atMs >= cutoff);
  const first = windowed[0];
  if (!first || windowed.length < 2) {
    return 0;
  }
  const spanMs = last.atMs - first.atMs;
  const spentUsd = last.billableUsd - first.billableUsd;
  if (spanMs < MIN_BURN_SPAN_MS || spentUsd <= 0) {
    return 0;
  }
  return spentUsd / (spanMs / MS_PER_HOUR);
};

const levelFor = (billableUsd: number, config: SpendConfig): SpendLevel => {
  if (billableUsd >= config.alertUsd) {
    return "alert";
  }
  if (billableUsd >= config.noticeUsd) {
    return "notice";
  }
  return "ok";
};

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

/**
 * Classify current run spend.
 *
 * A kill requires BOTH cumulative billable spend at/over killUsd AND a burn
 * rate at/over runawayUsdPerHour. One condition alone is a legitimate large
 * job or a brief spike; the pair is a loop that is not going to stop.
 * Subscription (attributed) dollars are reported but never enter this test —
 * they are quota-limited, not cash, and July's ceiling was quota, not money.
 */
export const evaluateSpend = (
  snapshot: SpendSnapshot,
  config: SpendConfig,
  history: SpendSample[]
): SpendDecision => {
  const burn = burnUsdPerHour(history, config.runawayWindowMs);
  const overKill = snapshot.billableUsd >= config.killUsd;
  const overBurn = burn >= config.runawayUsdPerHour;
  const killRequested = overKill && overBurn;
  const level: SpendLevel = killRequested
    ? "runaway"
    : levelFor(snapshot.billableUsd, config);
  const enforced = killRequested && config.mode === "enforce";
  const spend = `${usd(snapshot.billableUsd)} billable (+${usd(snapshot.attributedUsd)} subscription-equivalent)`;
  let reason: string;
  if (killRequested) {
    reason = `runaway: ${spend} at ${usd(burn)}/hr, over ${usd(config.killUsd)} and ${usd(config.runawayUsdPerHour)}/hr`;
  } else if (overKill) {
    reason = `${spend} is over ${usd(config.killUsd)} but burning only ${usd(burn)}/hr — large job, not a runaway`;
  } else {
    reason = `${spend} at ${usd(burn)}/hr`;
  }
  return {
    burnUsdPerHour: burn,
    enforced,
    killRequested,
    level,
    mode: config.mode,
    reason,
    snapshot,
    wouldKill: killRequested && !enforced,
  };
};

const escalationTitle: Record<Exclude<SpendLevel, "ok">, string> = {
  alert: "Run spend alert",
  notice: "Run spend notice",
  runaway: "Runaway spend",
};

const escalationPriority: Record<
  Exclude<SpendLevel, "ok">,
  EscalationEvent["priority"]
> = {
  alert: "high",
  notice: "default",
  runaway: "urgent",
};

/**
 * Turn a decision into at most one escalation, deduped per level via a
 * caller-owned record so a sustained condition alerts once, not every tick.
 */
export const spendEscalations = (
  decision: SpendDecision,
  notified: SpendNotified,
  runId: string
): EscalationEvent[] => {
  const { level } = decision;
  if (level === "ok" || notified[level]) {
    return [];
  }
  notified[level] = true;
  let action = "";
  if (decision.enforced) {
    action = " Stopping admission of new utility jobs.";
  } else if (decision.wouldKill) {
    action = ` Dry-run: mode is ${decision.mode}, so this would stop new utility jobs but takes no action.`;
  }
  return [
    {
      kind: "budget",
      message: `Run ${runId}: ${decision.reason}.${action}`,
      priority: escalationPriority[level],
      title: escalationTitle[level],
    },
  ];
};

/**
 * Append one evaluation to `<runDir>/spend-watch.jsonl`.
 *
 * Amounts, levels and counts only — never credentials. Best-effort: a failed
 * write must not disturb the control loop. The run directory is never created
 * here — the journal belongs beside a run's other journals, and if the run
 * directory does not exist there is no run to record.
 */
export const appendSpendJournal = (
  runDir: string,
  decision: SpendDecision,
  nowMs: number
): void => {
  const line = {
    attributedUsd: decision.snapshot.attributedUsd,
    billableUsd: decision.snapshot.billableUsd,
    burnUsdPerHour: decision.burnUsdPerHour,
    enforced: decision.enforced,
    jobs: decision.snapshot.jobs,
    killRequested: decision.killRequested,
    level: decision.level,
    mode: decision.mode,
    reason: decision.reason,
    ts: new Date(nowMs).toISOString(),
    wouldKill: decision.wouldKill,
  };
  try {
    if (!existsSync(runDir)) {
      return;
    }
    appendFileSync(
      join(runDir, "spend-watch.jsonl"),
      `${JSON.stringify(line)}\n`
    );
  } catch {
    // Observability must never break the loop it observes.
  }
};
