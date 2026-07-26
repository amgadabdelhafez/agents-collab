import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readDelegationEvents } from "./delegation-policy";
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

export type UtilityTranscriptKind = "request" | "response" | "tool";

export interface UtilityTranscriptEntry {
  at: string;
  jobId: string;
  kind: UtilityTranscriptKind;
  label: string;
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

export interface UtilityObservabilitySnapshot {
  active: number;
  available: boolean;
  completed: number;
  failed: number;
  jobsTotal: number;
  latestAt?: string;
  latestDetail: string;
  latestJobId?: string;
  latestRoute?: string;
  latestRouteDetail?: string;
  latestState?: string;
  messages: UtilityMessageObservability;
  model?: string;
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
  autoRouted: number;
  considered: number;
  explicitRouted: number;
  pending: number;
  reasons: Record<string, number>;
  routed: number;
  skipped: number;
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
  const unroutedCandidates = events.filter((event) =>
    [
      "missed-candidate",
      "observed-candidate",
      "route-failed",
      "skipped-candidate",
    ].includes(event.disposition)
  );
  const routedJobs = jobs.filter(
    (job) => job.decision?.target === "utility"
  );
  const skippedJobs = jobs.filter(
    (job) => job.decision && job.decision.target !== "utility"
  );
  const reasons = skippedJobs.reduce<Record<string, number>>(
    (counts, job) => {
      const reason = job.decision?.reason;
      if (reason) {
        counts[reason] = (counts[reason] ?? 0) + 1;
      }
      return counts;
    },
    {}
  );
  for (const event of unroutedCandidates) {
    reasons[event.reason] = (reasons[event.reason] ?? 0) + 1;
  }
  return {
    autoRouted,
    considered: jobs.length + unroutedCandidates.length,
    explicitRouted,
    pending: jobs.filter((job) => !job.decision).length,
    reasons,
    routed: routedJobs.length,
    skipped: skippedJobs.length + unroutedCandidates.length,
  };
};

const messageSnapshot = (
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
  return {
    inbound: inbound.length,
    ...(latestInboundAt ? { latestInboundAt } : {}),
    ...(latestOutboundAt ? { latestOutboundAt } : {}),
    outbound: outbound.length,
    pending: Math.max(0, inbound.length - outbound.length),
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
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

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
    usage.cachedInputTokens += finiteNumber(current.cachedInputTokens);
    usage.costUsd += finiteNumber(current.cost);
    usage.inputTokens += finiteNumber(current.inputTokens);
    usage.modelCalls += finiteNumber(event.modelCalls);
    usage.outputTokens += finiteNumber(current.outputTokens);
    usage.reasoningTokens += finiteNumber(current.reasoningTokens);
    usage.toolCalls += finiteNumber(event.toolCalls);
    usage.totalTokens += finiteNumber(current.totalTokens);
  }
  return { ...(model ? { model } : {}), usage };
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

const jobRequestEntry = (job: UtilityJobSnapshot): UtilityTranscriptEntry => ({
  at: job.request.createdAt,
  jobId: job.jobId,
  kind: "request",
  label: `${job.request.requester.toUpperCase()}→WORKER`,
  text: sanitizeUtilityPaneText(job.request.objective),
});

const jobResultEntry = (
  job: UtilityJobSnapshot,
  usageEvent: Record<string, unknown> | undefined
): UtilityTranscriptEntry | undefined => {
  if (!job.result) {
    return undefined;
  }
  const failed = job.result.status !== "completed";
  const detail = failed
    ? job.result.blocker || job.result.summary
    : job.result.summary;
  const usage = transcriptUsage(usageEvent);
  return {
    at: job.updatedAt,
    jobId: job.jobId,
    kind: "response",
    label: failed ? "WORKER FAIL" : "WORKER OK",
    text: sanitizeUtilityPaneText(detail),
    ...(usage ? { usage } : {}),
  };
};

const toolEntries = (runDir: string): UtilityTranscriptEntry[] =>
  readJsonlRecords(join(runDir, "utility", "tool-events.jsonl")).flatMap(
    (event) => {
      const at = stringAt(event, "at");
      const jobId = stringAt(event, "jobId");
      const tool = stringAt(event, "tool");
      if (!(at && jobId && tool)) {
        return [];
      }
      const ok = event.ok === true;
      const durationMs = finiteNumber(event.durationMs);
      const error = recordAt(event, "error");
      const errorCode = error ? stringAt(error, "code") : undefined;
      const outcome = `${ok ? "ok" : "failed"} ${Math.round(durationMs)}ms${
        errorCode ? ` ${sanitizeUtilityPaneText(errorCode)}` : ""
      }`;
      return [
        {
          at,
          jobId,
          kind: "tool" as const,
          label: "WORKER TOOL",
          text: `${sanitizeUtilityPaneText(tool)} ${outcome}`,
        },
      ];
    }
  );

const transcriptFor = (
  runDir: string,
  jobs: UtilityJobSnapshot[],
  usageEvents: Map<string, Record<string, unknown>>
): UtilityTranscriptEntry[] => {
  const entries = jobs.flatMap((job) => {
    const result = jobResultEntry(job, usageEvents.get(job.jobId));
    return result ? [jobRequestEntry(job), result] : [jobRequestEntry(job)];
  });
  entries.push(...toolEntries(runDir));
  return entries
    .filter((entry) => entry.text)
    .sort((left, right) => left.at.localeCompare(right.at));
};

const latestJob = (
  jobs: UtilityJobSnapshot[]
): UtilityJobSnapshot | undefined =>
  [...jobs].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  )[0];

export const readUtilityObservability = (
  runDir?: string
): UtilityObservabilitySnapshot => {
  if (!runDir) {
    return {
      active: 0,
      available: false,
      completed: 0,
      failed: 0,
      jobsTotal: 0,
      latestDetail: "no utility run directory",
      messages: { inbound: 0, outbound: 0, pending: 0 },
      queued: 0,
      routing: {
        autoRouted: 0,
        considered: 0,
        explicitRouted: 0,
        pending: 0,
        reasons: {},
        routed: 0,
        skipped: 0,
      },
      transcript: [],
      usage: emptyUsage(),
    };
  }
  const allJobs = safeJobs(runDir);
  const jobs = workerJobs(allJobs);
  const usageEvents = latestUsageByJob(runDir);
  const totals = usageSnapshot(usageEvents);
  const transcript = transcriptFor(runDir, jobs, usageEvents);
  const latest = latestJob(jobs);
  const latestDecision = latestJob(allJobs.filter((job) => job.decision));
  const latestDetail = latest
    ? sanitizeUtilityPaneText(
        latest.result?.blocker ||
          latest.result?.summary ||
          latest.request.objective
      )
    : "waiting for first routed job";
  return {
    active: jobs.filter((job) => ["claimed", "running"].includes(job.state))
      .length,
    available: jobs.length > 0 || usageEvents.size > 0,
    completed: jobs.filter((job) => job.state === "completed").length,
    failed: jobs.filter((job) =>
      ["failed", "escalated", "canceled"].includes(job.state)
    ).length,
    jobsTotal: jobs.length,
    latestDetail,
    messages: messageSnapshot(jobs),
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
    queued: jobs.filter((job) =>
      ["pending-route", "routed-utility"].includes(job.state)
    ).length,
    routing: routingSnapshot(runDir, allJobs),
    transcript,
    usage: totals.usage,
  };
};
