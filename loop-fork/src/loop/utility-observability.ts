import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPendingBridgeMessages } from "./bridge-store";
import {
  delegationSkipCategory,
  readDelegationEvents,
} from "./delegation-policy";
import {
  UTILITY_AU_PAIR_TIER,
  UTILITY_DIRECT_TIER,
  UTILITY_NANNY_TIER,
  type UtilityExecutionTierId,
  utilityRoleName,
} from "./utility-execution-tier";
import {
  readUtilityJobsForObservability,
  type UtilityJobSnapshot,
} from "./utility-store";

const ANSI_SEQUENCE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const BEARER_SECRET_RE = /\bBearer\s+[^\s,;"']+/gi;
const LABELED_SECRET_RE =
  /\b(api[-_ ]?key|token|secret|password)\s*[:=]\s*["']?[^\s,;"']+/gi;
const PROVIDER_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMON_CREDENTIAL_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g;
const REDACTED = "[REDACTED]";
const TOOL_ERROR_CODE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const LEGACY_COMPLETED_PANE_RE =
  /^Completed with \d+ tool calls?, \d+ artifacts?, and \d+ checks?\.$/;
const LEGACY_FAILED_PANE_RE =
  /^(?:Nanny|Au Pair) failed closed; requester notified\.$/;
const MAX_OBSERVABILITY_NUMBER = Number.MAX_SAFE_INTEGER;

export type UtilityTranscriptKind = "request" | "response" | "tool";

export interface UtilityTranscriptEntry {
  at: string;
  jobId: string;
  kind: UtilityTranscriptKind;
  label: string;
  model?: string;
  text: string;
  usage?: UtilityTranscriptUsage;
}

// Where a helper job's cost figure comes from. A worker row's `usage.cost`
// is only money when its source says so: Pi registers loopback helpers at
// zero rates, so a bare 0 from them is not a measured price. Unknown cost is
// never summed as $0; it is counted separately so panes can say "unknown".
export type UtilityCostSource =
  | "local-zero-rate"
  | "not-applicable"
  | "pi-catalog-rates"
  | "provider-reported"
  | "recorded-unlabeled"
  | "unknown";

const UTILITY_COST_SOURCES: readonly UtilityCostSource[] = [
  "local-zero-rate",
  "not-applicable",
  "pi-catalog-rates",
  "provider-reported",
  "recorded-unlabeled",
  "unknown",
];

export interface UtilityCostSourceInput {
  cost?: unknown;
  harness?: string;
  provider?: string;
  tierId?: string;
}

// Writer-side classification for a usage row. `provider` is the helper's
// actual provider id (Pi: loop-nanny | loop-au-pair | openrouter; legacy:
// local | openrouter; Direct: broker).
export const utilityCostSource = (
  input: UtilityCostSourceInput
): UtilityCostSource => {
  if (input.tierId === UTILITY_DIRECT_TIER || input.provider === "broker") {
    return "not-applicable";
  }
  if (
    input.provider === "loop-nanny" ||
    (input.provider === "local" && input.tierId === UTILITY_NANNY_TIER)
  ) {
    return "local-zero-rate";
  }
  const hasCost = typeof input.cost === "number" && Number.isFinite(input.cost);
  if (input.provider === "openrouter") {
    if (input.harness === "pi-sdk") {
      return hasCost ? "pi-catalog-rates" : "unknown";
    }
    return hasCost ? "provider-reported" : "unknown";
  }
  return "unknown";
};

// Reader-side provenance: trust a recorded label, otherwise classify rows
// written before labels existed. An unlabeled numeric cost with no provider
// keeps its historical meaning ("recorded-unlabeled"); a zero-rate loopback
// Au Pair row stays unknown even though it carries cost 0.
const rowCostSource = (event: Record<string, unknown>): UtilityCostSource => {
  const recorded = event.costSource;
  if (
    typeof recorded === "string" &&
    UTILITY_COST_SOURCES.includes(recorded as UtilityCostSource)
  ) {
    return recorded as UtilityCostSource;
  }
  const usage = recordAt(event, "usage") ?? {};
  const provider = stringAt(event, "provider");
  const tierId = stringAt(event, "tierId");
  const harness = stringAt(event, "harness");
  if (provider === undefined && tierId === undefined) {
    return typeof usage.cost === "number" && Number.isFinite(usage.cost)
      ? "recorded-unlabeled"
      : "unknown";
  }
  return utilityCostSource({
    cost: usage.cost,
    ...(harness ? { harness } : {}),
    ...(provider ? { provider } : {}),
    ...(tierId ? { tierId } : {}),
  });
};

const costIsKnown = (source: UtilityCostSource): boolean =>
  source !== "unknown";

const usd = (cost: number): string =>
  `$${cost.toFixed(cost > 0 && cost < 1 ? 4 : 2)}`;

// One job's cost, labelled with where it came from.
export const utilityJobCostText = (
  source: UtilityCostSource,
  costUsd: number | undefined
): string => {
  if (source === "unknown" || costUsd === undefined) {
    return source === "not-applicable" ? "no model" : "cost unknown";
  }
  switch (source) {
    case "local-zero-rate":
      return "local zero-rate";
    case "not-applicable":
      return "no model";
    case "pi-catalog-rates":
      return `${usd(costUsd)} est (Pi catalog rates)`;
    case "provider-reported":
      return `${usd(costUsd)} provider-reported`;
    default:
      return usd(costUsd);
  }
};

// A tier's cost: known money plus an explicit count of unknown-price jobs.
export const utilityUsageCostText = (
  usage: UtilityObservabilityUsage
): string => {
  const unknown =
    usage.costUnknownJobs > 0 ? `${usage.costUnknownJobs} unknown` : "";
  const local = usage.costSources["local-zero-rate"] ?? 0;
  const priced =
    usage.costKnownJobs - local - (usage.costSources["not-applicable"] ?? 0);
  // Any Pi-catalog component makes the total an estimate, not a bill.
  const estimate =
    (usage.costSources["pi-catalog-rates"] ?? 0) > 0 ? " est" : "";
  const parts = [
    priced > 0 || usage.costUsd > 0 ? `${usd(usage.costUsd)}${estimate}` : "",
    local > 0 ? `${local} local zero-rate` : "",
    unknown,
  ].filter(Boolean);
  return parts.length ? `cost ${parts.join(" + ")}` : "cost —";
};

export type UtilityHelperState =
  | "completed"
  | "failed"
  | "idle"
  | "queued"
  | "running";

export interface UtilityTranscriptUsage {
  admissionRetries?: number;
  cachedInputTokens: number;
  costSource: UtilityCostSource;
  // Absent when costSource is "unknown": unknown cost is not $0.
  costUsd?: number;
  durationMs: number;
  inputTokens: number;
  modelCalls: number;
  outputTokens: number;
  servedModel?: string;
  toolCalls: number;
  totalTokens: number;
}

export interface UtilityObservabilityUsage {
  cachedInputTokens: number;
  costKnownJobs: number;
  costSources: Partial<Record<UtilityCostSource, number>>;
  costUnknownJobs: number;
  // Sum over jobs whose cost source is known; see costUnknownJobs.
  costUsd: number;
  inputTokens: number;
  modelCalls: number;
  outputTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  totalTokens: number;
}

export interface UtilityPerformanceObservability {
  averageCostUsd: number;
  averageDurationMs: number;
  averageTokens: number;
  averageToolCalls: number;
  cacheHitRate: number;
  finishedJobs: number;
  measuredJobs: number;
  successfulJobs: number;
  successRate: number;
}

export interface UtilityContextObservability {
  capsules: number;
  coverage: number;
  latestHash?: string;
  latestVersion?: number;
  references: number;
}

export interface UtilityFailureObservability {
  toolFailures: number;
  topToolError?: string;
  topToolErrorCount: number;
}

export interface UtilityObservabilitySnapshot {
  active: number;
  available: boolean;
  completed: number;
  contextInsufficient: number;
  contexts: UtilityContextObservability;
  failed: number;
  failures: UtilityFailureObservability;
  helperState: UtilityHelperState;
  jobsTotal: number;
  latestAt?: string;
  latestDetail: string;
  latestJobId?: string;
  latestRoute?: string;
  latestRouteDetail?: string;
  latestState?: string;
  messages: UtilityMessageObservability;
  model?: string;
  performance: UtilityPerformanceObservability;
  queued: number;
  routing: UtilityRoutingObservability;
  servedModel?: string;
  transcript: UtilityTranscriptEntry[];
  usage: UtilityObservabilityUsage;
}

export interface UtilityMessageObservability {
  inbound: number;
  latestInboundAt?: string;
  latestOutboundAt?: string;
  outbound: number;
  pending: number;
}

export interface UtilityRoutingObservability {
  actionable: number;
  autoRouted: number;
  considered: number;
  explicitRouted: number;
  pending: number;
  promptPackets: number;
  reasons: Record<string, number>;
  retained: number;
  routed: number;
  skipped: number;
  structuredPlans: number;
  unsafe: number;
}

const emptyUsage = (): UtilityObservabilityUsage => ({
  cachedInputTokens: 0,
  costKnownJobs: 0,
  costSources: {},
  costUnknownJobs: 0,
  costUsd: 0,
  inputTokens: 0,
  modelCalls: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: 0,
  totalTokens: 0,
});

const emptyPerformance = (): UtilityPerformanceObservability => ({
  averageCostUsd: 0,
  averageDurationMs: 0,
  averageTokens: 0,
  averageToolCalls: 0,
  cacheHitRate: 0,
  finishedJobs: 0,
  measuredJobs: 0,
  successfulJobs: 0,
  successRate: 0,
});

const emptyContexts = (): UtilityContextObservability => ({
  capsules: 0,
  coverage: 0,
  references: 0,
});

const emptyFailures = (): UtilityFailureObservability => ({
  toolFailures: 0,
  topToolErrorCount: 0,
});

const routingSnapshot = (
  runDir: string,
  jobs: UtilityJobSnapshot[]
): UtilityRoutingObservability => {
  const events = readDelegationEvents(runDir);
  const autoRouted = events.filter(
    (event) => event.disposition === "auto-routed"
  ).length;
  const explicitRouted = events.filter(
    (event) => event.disposition === "explicit-routed"
  ).length;
  const promptPackets = events.filter(
    (event) =>
      event.disposition === "explicit-routed" && event.source === "bridge"
  ).length;
  const structuredPlans = events.filter(
    (event) =>
      event.operation === "read-plan" &&
      (event.disposition === "auto-routed" ||
        event.disposition === "explicit-routed")
  ).length;
  const unroutedCandidates = events.filter((event) =>
    [
      "missed-candidate",
      "observed-candidate",
      "route-failed",
      "skipped-candidate",
    ].includes(event.disposition)
  );
  const routedJobs = jobs.filter((job) => job.decision?.target === "utility");
  const skippedJobs = jobs.filter(
    (job) => job.decision && job.decision.target !== "utility"
  );
  const reasons = skippedJobs.reduce<Record<string, number>>((counts, job) => {
    const reason = job.decision?.reason;
    if (reason) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return counts;
  }, {});
  for (const event of unroutedCandidates) {
    reasons[event.reason] = (reasons[event.reason] ?? 0) + 1;
  }
  const categories = [
    ...skippedJobs.map((job) =>
      delegationSkipCategory(
        "skipped-candidate",
        job.decision?.reason ?? "route-target-not-utility"
      )
    ),
    ...unroutedCandidates.map(
      (event) =>
        event.category ??
        delegationSkipCategory(event.disposition, event.reason)
    ),
  ];
  const actionable = categories.filter(
    (category) => category === "actionable-miss"
  ).length;
  const retained = categories.filter(
    (category) => category === "intentional-retain"
  ).length;
  const unsafe = categories.filter(
    (category) => category === "unsafe-reject"
  ).length;
  return {
    actionable,
    autoRouted,
    considered: jobs.length + unroutedCandidates.length,
    explicitRouted,
    pending: jobs.filter((job) => !job.decision).length,
    promptPackets,
    reasons,
    retained,
    routed: routedJobs.length,
    skipped: actionable + unsafe,
    structuredPlans,
    unsafe,
  };
};

const messageSnapshot = (
  runDir: string,
  jobs: UtilityJobSnapshot[]
): UtilityMessageObservability => {
  const inbound = jobs
    .filter(
      (job) =>
        job.decision?.target === "utility" ||
        job.events.some((event) => event.state === "routed-utility")
    )
    .sort((left, right) =>
      left.request.createdAt.localeCompare(right.request.createdAt)
    );
  const outbound = inbound
    .filter((job) => Boolean(job.result))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const latestInboundAt = inbound.at(-1)?.request.createdAt;
  const latestOutboundAt = outbound.at(-1)?.updatedAt;
  const jobIds = new Set(jobs.map((job) => job.jobId));
  const pendingResults = readPendingBridgeMessages(runDir).filter(
    (message) =>
      message.source === "utility" &&
      message.taskId !== undefined &&
      jobIds.has(message.taskId)
  );
  return {
    inbound: inbound.length,
    ...(latestInboundAt ? { latestInboundAt } : {}),
    ...(latestOutboundAt ? { latestOutboundAt } : {}),
    outbound: outbound.length,
    pending: pendingResults.length,
  };
};

export const sanitizeUtilityPaneText = (value: string): string =>
  value
    .replace(ANSI_SEQUENCE_RE, "")
    .replace(CONTROL_CHARACTER_RE, " ")
    .replace(BEARER_SECRET_RE, `Bearer ${REDACTED}`)
    .replace(
      LABELED_SECRET_RE,
      (_match, label: string) => `${label}=${REDACTED}`
    )
    .replace(PROVIDER_KEY_RE, REDACTED)
    .replace(COMMON_CREDENTIAL_RE, REDACTED)
    .replaceAll(/\s+/g, " ")
    .trim();

const readJsonlRecords = (path: string): Record<string, unknown>[] => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return value && typeof value === "object"
            ? [value as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

const finiteNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_OBSERVABILITY_NUMBER)
    : 0;

const saturatingAdd = (left: number, right: number): number =>
  Math.min(MAX_OBSERVABILITY_NUMBER, left + right);

const boundedRatio = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.min(1, numerator / denominator) : 0;

const recordAt = (
  value: unknown,
  key: string
): Record<string, unknown> | undefined => {
  if (!(value && typeof value === "object")) {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : undefined;
};

const stringAt = (
  value: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof value[key] === "string" ? (value[key] as string) : undefined;

const safeToolErrorCode = (
  error: Record<string, unknown> | undefined
): string | undefined => {
  const code = error ? stringAt(error, "code") : undefined;
  return code && TOOL_ERROR_CODE_RE.test(code) ? code : undefined;
};

const safeJobs = (runDir: string): UtilityJobSnapshot[] => {
  try {
    return readUtilityJobsForObservability(runDir);
  } catch {
    return [];
  }
};

const workerJobs = (jobs: UtilityJobSnapshot[]): UtilityJobSnapshot[] =>
  jobs.filter(
    (job) =>
      job.decision?.target === "utility" ||
      job.claim !== undefined ||
      ["pending-route", "routed-utility", "claimed", "running"].includes(
        job.state
      )
  );

const latestUsageByJob = (
  runDir: string
): Map<string, Record<string, unknown>> => {
  const latest = new Map<string, Record<string, unknown>>();
  for (const event of readJsonlRecords(
    join(runDir, "utility", "usage.jsonl")
  )) {
    const jobId = stringAt(event, "jobId");
    if (jobId) {
      latest.set(jobId, event);
    }
  }
  return latest;
};

const usageSnapshot = (
  events: Map<string, Record<string, unknown>>
): {
  model?: string;
  servedModel?: string;
  usage: UtilityObservabilityUsage;
} => {
  const usage = emptyUsage();
  let model: string | undefined;
  let servedModel: string | undefined;
  for (const event of events.values()) {
    model = stringAt(event, "model") ?? model;
    servedModel = stringAt(event, "servedModel") ?? servedModel;
    const current = recordAt(event, "usage") ?? {};
    usage.cachedInputTokens = saturatingAdd(
      usage.cachedInputTokens,
      finiteNumber(current.cachedInputTokens)
    );
    const costSource = rowCostSource(event);
    usage.costSources[costSource] = (usage.costSources[costSource] ?? 0) + 1;
    if (costIsKnown(costSource)) {
      usage.costKnownJobs += 1;
      usage.costUsd = saturatingAdd(usage.costUsd, finiteNumber(current.cost));
    } else {
      usage.costUnknownJobs += 1;
    }
    usage.inputTokens = saturatingAdd(
      usage.inputTokens,
      finiteNumber(current.inputTokens)
    );
    usage.modelCalls = saturatingAdd(
      usage.modelCalls,
      finiteNumber(event.modelCalls)
    );
    usage.outputTokens = saturatingAdd(
      usage.outputTokens,
      finiteNumber(current.outputTokens)
    );
    usage.reasoningTokens = saturatingAdd(
      usage.reasoningTokens,
      finiteNumber(current.reasoningTokens)
    );
    usage.toolCalls = saturatingAdd(
      usage.toolCalls,
      finiteNumber(event.toolCalls)
    );
    usage.totalTokens = saturatingAdd(
      usage.totalTokens,
      finiteNumber(current.totalTokens)
    );
  }
  return {
    ...(model ? { model } : {}),
    ...(servedModel ? { servedModel } : {}),
    usage,
  };
};

const terminalWorkerJobs = (jobs: UtilityJobSnapshot[]): UtilityJobSnapshot[] =>
  jobs.filter((job) =>
    ["completed", "failed", "escalated", "canceled"].includes(job.state)
  );

interface UtilityPerformanceTotals {
  cachedInputTokens: number;
  costKnownJobs: number;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  tokens: number;
  toolCalls: number;
}

const performanceSnapshot = (
  jobs: UtilityJobSnapshot[],
  events: Map<string, Record<string, unknown>>
): UtilityPerformanceObservability => {
  const finished = terminalWorkerJobs(jobs);
  const successfulJobs = finished.filter(
    (job) => job.state === "completed"
  ).length;
  const measured = finished.flatMap((job) => {
    const event = events.get(job.jobId);
    return event ? [event] : [];
  });
  if (finished.length === 0) {
    return emptyPerformance();
  }
  const totals = measured.reduce<UtilityPerformanceTotals>(
    (sum, event) => {
      const usage = recordAt(event, "usage") ?? {};
      sum.cachedInputTokens = saturatingAdd(
        sum.cachedInputTokens,
        finiteNumber(usage.cachedInputTokens)
      );
      if (costIsKnown(rowCostSource(event))) {
        sum.costKnownJobs += 1;
        sum.costUsd = saturatingAdd(sum.costUsd, finiteNumber(usage.cost));
      }
      sum.durationMs = saturatingAdd(
        sum.durationMs,
        finiteNumber(event.durationMs)
      );
      sum.inputTokens = saturatingAdd(
        sum.inputTokens,
        finiteNumber(usage.inputTokens)
      );
      sum.tokens = saturatingAdd(sum.tokens, finiteNumber(usage.totalTokens));
      sum.toolCalls = saturatingAdd(
        sum.toolCalls,
        finiteNumber(event.toolCalls)
      );
      return sum;
    },
    {
      cachedInputTokens: 0,
      costKnownJobs: 0,
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      tokens: 0,
      toolCalls: 0,
    }
  );
  const divisor = measured.length || 1;
  return {
    averageCostUsd: totals.costKnownJobs
      ? totals.costUsd / totals.costKnownJobs
      : 0,
    averageDurationMs: totals.durationMs / divisor,
    averageTokens: totals.tokens / divisor,
    averageToolCalls: totals.toolCalls / divisor,
    cacheHitRate: boundedRatio(totals.cachedInputTokens, totals.inputTokens),
    finishedJobs: finished.length,
    measuredJobs: measured.length,
    successfulJobs,
    successRate: successfulJobs / finished.length,
  };
};

const SHA256_RE = /^[a-f0-9]{64}$/i;

const contextSnapshot = (
  jobs: UtilityJobSnapshot[],
  events: Map<string, Record<string, unknown>>
): UtilityContextObservability => {
  const withContext = jobs.flatMap((job) => {
    const event = events.get(job.jobId);
    const eventHash = event ? stringAt(event, "contextSha256") : undefined;
    const resultContext = job.result?.context;
    let hash: string | undefined;
    if (SHA256_RE.test(eventHash ?? "")) {
      hash = eventHash;
    } else if (SHA256_RE.test(resultContext?.sha256 ?? "")) {
      hash = resultContext?.sha256;
    }
    if (!hash) {
      return [];
    }
    const eventVersion = finiteNumber(event?.contextVersion);
    const version = eventVersion || finiteNumber(resultContext?.version);
    return [
      {
        at: job.updatedAt,
        hash,
        references: job.request.contextRefs?.length ?? 0,
        version,
      },
    ];
  });
  const latest = [...withContext].sort((left, right) =>
    right.at.localeCompare(left.at)
  )[0];
  return {
    capsules: withContext.length,
    coverage: jobs.length > 0 ? withContext.length / jobs.length : 0,
    ...(latest
      ? {
          latestHash: latest.hash.slice(0, 8),
          ...(latest.version > 0 ? { latestVersion: latest.version } : {}),
        }
      : {}),
    references: withContext.reduce(
      (total, context) => total + context.references,
      0
    ),
  };
};

const failureSnapshot = (
  events: Record<string, unknown>[]
): UtilityFailureObservability => {
  const failed = events.filter((event) => event.ok === false);
  const counts = failed.reduce<Record<string, number>>((result, event) => {
    const error = recordAt(event, "error");
    const key = safeToolErrorCode(error) ?? "unknown";
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
  const top = Object.entries(counts).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  )[0];
  if (!top) {
    return { toolFailures: failed.length, topToolErrorCount: 0 };
  }
  return {
    toolFailures: failed.length,
    topToolError: top[0],
    topToolErrorCount: top[1],
  };
};

const transcriptUsage = (
  event: Record<string, unknown> | undefined
): UtilityTranscriptUsage | undefined => {
  if (!event) {
    return undefined;
  }
  const usage = recordAt(event, "usage") ?? {};
  const costSource = rowCostSource(event);
  const servedModel = stringAt(event, "servedModel");
  const admissionRetries = finiteNumber(event.admissionRetries);
  return {
    ...(admissionRetries > 0 ? { admissionRetries } : {}),
    cachedInputTokens: finiteNumber(usage.cachedInputTokens),
    costSource,
    ...(costIsKnown(costSource) ? { costUsd: finiteNumber(usage.cost) } : {}),
    durationMs: finiteNumber(event.durationMs),
    inputTokens: finiteNumber(usage.inputTokens),
    modelCalls: finiteNumber(event.modelCalls),
    outputTokens: finiteNumber(usage.outputTokens),
    ...(servedModel
      ? { servedModel: sanitizeUtilityPaneText(servedModel) }
      : {}),
    toolCalls: finiteNumber(event.toolCalls),
    totalTokens: finiteNumber(usage.totalTokens),
  };
};

const KNOWN_UTILITY_TIERS: readonly UtilityExecutionTierId[] = [
  UTILITY_DIRECT_TIER,
  UTILITY_NANNY_TIER,
  UTILITY_AU_PAIR_TIER,
];

// Attribution is fail-closed: a job whose decision does not carry a known
// tier id belongs to no helper row and is labelled "Unattributed" instead of
// silently defaulting into a tier. Defaulting hid executed work from the
// per-helper board rows (loop 108; spec lower-agent-observability T-07).
const jobTier = (
  job: UtilityJobSnapshot
): UtilityExecutionTierId | undefined => {
  const tierId = job.decision?.tierId as UtilityExecutionTierId | undefined;
  return tierId !== undefined && KNOWN_UTILITY_TIERS.includes(tierId)
    ? tierId
    : undefined;
};

const attributionName = (tier: UtilityExecutionTierId | undefined): string =>
  tier === undefined ? "Unattributed" : utilityRoleName(tier);

const jobRequestEntry = (job: UtilityJobSnapshot): UtilityTranscriptEntry => ({
  at: job.request.createdAt,
  jobId: job.jobId,
  kind: "request",
  label: `${job.request.requester.toUpperCase()}→${attributionName(jobTier(job)).toUpperCase()}`,
  text: sanitizeUtilityPaneText(job.request.objective),
});

const jobResultLabel = (job: UtilityJobSnapshot): string => {
  const role = attributionName(jobTier(job)).toUpperCase();
  if (job.result?.reasonCode === "context-insufficient") {
    return `${role} CONTEXT`;
  }
  return job.result?.status === "completed" ? `${role} OK` : `${role} FAIL`;
};

const isLegacyPanePlaceholder = (value: string | undefined): boolean => {
  const text = value?.trim();
  if (!text) {
    return false;
  }
  return (
    LEGACY_COMPLETED_PANE_RE.test(text) || LEGACY_FAILED_PANE_RE.test(text)
  );
};

const utilityResultDetail = (job: UtilityJobSnapshot): string => {
  const result = job.result;
  if (!result) {
    return job.request.objective;
  }
  if (result.paneSummary && !isLegacyPanePlaceholder(result.paneSummary)) {
    return result.paneSummary;
  }
  if (result.status !== "completed" && result.blocker) {
    return result.blocker;
  }
  return result.summary || result.paneSummary || job.request.objective;
};

const jobResultEntry = (
  job: UtilityJobSnapshot,
  usageEvent: Record<string, unknown> | undefined
): UtilityTranscriptEntry | undefined => {
  if (!job.result) {
    return undefined;
  }
  const usage = transcriptUsage(usageEvent);
  return {
    at: job.updatedAt,
    jobId: job.jobId,
    kind: "response",
    label: jobResultLabel(job),
    text: sanitizeUtilityPaneText(utilityResultDetail(job)),
    ...(usage ? { usage } : {}),
  };
};

const toolEntries = (
  events: Record<string, unknown>[],
  jobs: UtilityJobSnapshot[]
): UtilityTranscriptEntry[] => {
  const roleByJobId = new Map(
    jobs.map((job) => [job.jobId, attributionName(jobTier(job))] as const)
  );
  return events.flatMap((event) => {
    const at = stringAt(event, "at");
    const jobId = stringAt(event, "jobId");
    const tool = stringAt(event, "tool");
    if (!(at && jobId && tool)) {
      return [];
    }
    const ok = event.ok === true;
    const durationMs = finiteNumber(event.durationMs);
    const error = recordAt(event, "error");
    const errorCode = safeToolErrorCode(error);
    const outcome = `${ok ? "ok" : "failed"} ${Math.round(durationMs)}ms${
      errorCode ? ` ${sanitizeUtilityPaneText(errorCode)}` : ""
    }`;
    return [
      {
        at,
        jobId,
        kind: "tool" as const,
        label: `${(roleByJobId.get(jobId) ?? "Unattributed").toUpperCase()} TOOL`,
        text: `${sanitizeUtilityPaneText(tool)} ${outcome}`,
      },
    ];
  });
};

const transcriptFor = (
  jobs: UtilityJobSnapshot[],
  usageEvents: Map<string, Record<string, unknown>>,
  toolEvents: Record<string, unknown>[]
): UtilityTranscriptEntry[] => {
  const modelByJobId = new Map(
    [...usageEvents].flatMap(([jobId, event]) => {
      const model = stringAt(event, "model");
      return model ? [[jobId, model] as const] : [];
    })
  );
  const entries = jobs.flatMap((job) => {
    const result = jobResultEntry(job, usageEvents.get(job.jobId));
    return result ? [jobRequestEntry(job), result] : [jobRequestEntry(job)];
  });
  entries.push(...toolEntries(toolEvents, jobs));
  return entries
    .filter((entry) => entry.text)
    .map((entry) => {
      const model = modelByJobId.get(entry.jobId);
      return model ? { ...entry, model } : entry;
    })
    .sort((left, right) => left.at.localeCompare(right.at));
};

// One pane-level state for a helper tier: work in flight wins, then work
// waiting for a worker, then the outcome of the most recent finished job.
export const utilityHelperState = (
  jobs: UtilityJobSnapshot[]
): UtilityHelperState => {
  if (jobs.some((job) => ["claimed", "running"].includes(job.state))) {
    return "running";
  }
  if (
    jobs.some((job) => ["pending-route", "routed-utility"].includes(job.state))
  ) {
    return "queued";
  }
  const finished = terminalWorkerJobs(jobs).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  )[0];
  if (!finished) {
    return "idle";
  }
  return finished.state === "completed" ? "completed" : "failed";
};

const latestJob = (
  jobs: UtilityJobSnapshot[]
): UtilityJobSnapshot | undefined =>
  [...jobs].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  )[0];

export const readUtilityObservability = (
  runDir?: string,
  tierId?: UtilityExecutionTierId
): UtilityObservabilitySnapshot => {
  if (!runDir) {
    return {
      active: 0,
      available: false,
      helperState: "idle",
      completed: 0,
      contexts: emptyContexts(),
      contextInsufficient: 0,
      failed: 0,
      failures: emptyFailures(),
      jobsTotal: 0,
      latestDetail: "no utility run directory",
      messages: { inbound: 0, outbound: 0, pending: 0 },
      performance: emptyPerformance(),
      queued: 0,
      routing: {
        actionable: 0,
        autoRouted: 0,
        considered: 0,
        explicitRouted: 0,
        pending: 0,
        promptPackets: 0,
        reasons: {},
        retained: 0,
        routed: 0,
        skipped: 0,
        structuredPlans: 0,
        unsafe: 0,
      },
      transcript: [],
      usage: emptyUsage(),
    };
  }
  const allJobs = safeJobs(runDir);
  const jobs = workerJobs(allJobs).filter(
    (job) => tierId === undefined || jobTier(job) === tierId
  );
  const jobIds = new Set(jobs.map((job) => job.jobId));
  const usageEvents = new Map(
    [...latestUsageByJob(runDir)].filter(([jobId]) => jobIds.has(jobId))
  );
  const toolEvents = readJsonlRecords(
    join(runDir, "utility", "tool-events.jsonl")
  ).filter((event) => {
    const jobId = stringAt(event, "jobId");
    return jobId !== undefined && jobIds.has(jobId);
  });
  const totals = usageSnapshot(usageEvents);
  const transcript = transcriptFor(jobs, usageEvents, toolEvents);
  const latest = latestJob(jobs);
  const latestDecision = latestJob(allJobs.filter((job) => job.decision));
  const latestDetail = latest
    ? sanitizeUtilityPaneText(utilityResultDetail(latest))
    : "waiting for first routed job";
  return {
    active: jobs.filter((job) => ["claimed", "running"].includes(job.state))
      .length,
    available: jobs.length > 0 || usageEvents.size > 0,
    completed: jobs.filter((job) => job.state === "completed").length,
    contexts: contextSnapshot(jobs, usageEvents),
    contextInsufficient: jobs.filter(
      (job) => job.result?.reasonCode === "context-insufficient"
    ).length,
    failed: jobs.filter(
      (job) =>
        ["failed", "escalated", "canceled"].includes(job.state) &&
        job.result?.reasonCode !== "context-insufficient"
    ).length,
    failures: failureSnapshot(toolEvents),
    helperState: utilityHelperState(jobs),
    jobsTotal: jobs.length,
    latestDetail,
    messages: messageSnapshot(runDir, jobs),
    ...(latest
      ? {
          latestAt: latest.updatedAt,
          latestJobId: latest.jobId,
          latestState: latest.state,
        }
      : {}),
    ...(latestDecision?.decision
      ? {
          latestRoute: `${latestDecision.decision.target}/${latestDecision.decision.reason}`,
          ...(latestDecision.decision.detail
            ? {
                latestRouteDetail: sanitizeUtilityPaneText(
                  latestDecision.decision.detail
                ),
              }
            : {}),
        }
      : {}),
    ...(totals.model ? { model: totals.model } : {}),
    performance: performanceSnapshot(jobs, usageEvents),
    queued: jobs.filter((job) =>
      ["pending-route", "routed-utility"].includes(job.state)
    ).length,
    routing: routingSnapshot(runDir, allJobs),
    ...(totals.servedModel
      ? { servedModel: sanitizeUtilityPaneText(totals.servedModel) }
      : {}),
    transcript,
    usage: totals.usage,
  };
};
