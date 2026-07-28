import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPendingBridgeMessages } from "./bridge-store";
import {
  delegationSkipCategory,
  readDelegationEvents,
} from "./delegation-policy";
import {
  UTILITY_AU_PAIR_TIER,
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

export interface UtilityTranscriptUsage {
  costUsd: number;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  totalTokens: number;
}

export interface UtilityObservabilityUsage {
  cachedInputTokens: number;
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
): { model?: string; usage: UtilityObservabilityUsage } => {
  const usage = emptyUsage();
  let model: string | undefined;
  for (const event of events.values()) {
    model = stringAt(event, "model") ?? model;
    const current = recordAt(event, "usage") ?? {};
    usage.cachedInputTokens = saturatingAdd(
      usage.cachedInputTokens,
      finiteNumber(current.cachedInputTokens)
    );
    usage.costUsd = saturatingAdd(usage.costUsd, finiteNumber(current.cost));
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
  return { ...(model ? { model } : {}), usage };
};

const terminalWorkerJobs = (jobs: UtilityJobSnapshot[]): UtilityJobSnapshot[] =>
  jobs.filter((job) =>
    ["completed", "failed", "escalated", "canceled"].includes(job.state)
  );

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
  const totals = measured.reduce(
    (sum, event) => {
      const usage = recordAt(event, "usage") ?? {};
      sum.cachedInputTokens = saturatingAdd(
        sum.cachedInputTokens,
        finiteNumber(usage.cachedInputTokens)
      );
      sum.costUsd = saturatingAdd(sum.costUsd, finiteNumber(usage.cost));
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
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      tokens: 0,
      toolCalls: 0,
    }
  );
  const divisor = measured.length || 1;
  return {
    averageCostUsd: totals.costUsd / divisor,
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
  return {
    costUsd: finiteNumber(usage.cost),
    durationMs: finiteNumber(event.durationMs),
    modelCalls: finiteNumber(event.modelCalls),
    toolCalls: finiteNumber(event.toolCalls),
    totalTokens: finiteNumber(usage.totalTokens),
  };
};

const jobTier = (job: UtilityJobSnapshot): UtilityExecutionTierId =>
  (job.decision?.tierId as UtilityExecutionTierId | undefined) ??
  UTILITY_AU_PAIR_TIER;

const jobRequestEntry = (job: UtilityJobSnapshot): UtilityTranscriptEntry => ({
  at: job.request.createdAt,
  jobId: job.jobId,
  kind: "request",
  label: `${job.request.requester.toUpperCase()}→${utilityRoleName(jobTier(job)).toUpperCase()}`,
  text: sanitizeUtilityPaneText(job.request.objective),
});

const jobResultLabel = (job: UtilityJobSnapshot): string => {
  const role = utilityRoleName(jobTier(job)).toUpperCase();
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
    jobs.map((job) => [job.jobId, utilityRoleName(jobTier(job))] as const)
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
        label: `${(roleByJobId.get(jobId) ?? "Au Pair").toUpperCase()} TOOL`,
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
    transcript,
    usage: totals.usage,
  };
};
