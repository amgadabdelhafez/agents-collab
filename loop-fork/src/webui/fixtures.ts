import type {
  AgentSeatDTO,
  ConnectionDTO,
  EvidenceItemDTO,
  FixtureSourceDTO,
  FleetRunDTO,
  FleetSnapshotDTO,
  GovernessDTO,
  ProvenanceDTO,
  QualityDTO,
  QualitySeverity,
  RunDetailDTO,
  RunReasonDTO,
  SourceState,
  TimelineEventDTO,
  WorkerTierDTO,
} from "./types";
import { WEBUI_DTO_VERSION } from "./types";

const GENERATED_AT = "2026-08-20T20:15:00.000Z";

const CONNECTION_LABELS: Readonly<Record<ConnectionDTO["state"], string>> = {
  behind: "Updates behind",
  live: "Live",
  offline: "Offline",
  paused: "Updates paused",
  reconnecting: "Reconnecting",
};

const fixtureSource = (scenario: string): FixtureSourceDTO => ({
  kind: "synthetic-redacted",
  generatedAt: GENERATED_AT,
  scenario,
  notice: "Synthetic fixture data. Identifiers and content are fully redacted.",
});

const provenance = (
  sourceId: string,
  sourceKind: ProvenanceDTO["sourceKind"],
  observedAt: string,
  state: SourceState = "current",
  note?: string
): ProvenanceDTO => ({
  sourceId,
  sourceKind,
  revision: `rev-${sourceId}-07`,
  observedAt,
  state,
  ...(note ? { note } : {}),
});

const quality = (
  runId: string,
  at: string,
  severity: QualitySeverity,
  summary: string
): QualityDTO => ({
  severity,
  label: severity[0].toUpperCase() + severity.slice(1),
  summary,
  sources: [
    provenance(`${runId}-manifest`, "manifest", at),
    provenance(
      `${runId}-hooks`,
      "hook-journal",
      at,
      severity === "stale" ? "stale" : "current"
    ),
    provenance(
      `${runId}-governess`,
      "governess-journal",
      at,
      severity === "conflict" ? "conflict" : "current"
    ),
  ],
});

const connection = (
  runId: string,
  at: string,
  state: ConnectionDTO["state"],
  sequence: number,
  queuedUpdates = 0
): ConnectionDTO => ({
  state,
  label: CONNECTION_LABELS[state],
  lastEventAt: at,
  lastObservedAt: at,
  queuedUpdates,
  streamEpoch: `fixture-${runId}-epoch`,
  streamSequence: sequence,
});

const reason = (
  code: RunReasonDTO["code"],
  label: string,
  detail: string,
  severity: RunReasonDTO["severity"]
): RunReasonDTO => ({ code, detail, label, severity });

export const fixtureRuns: readonly FleetRunDTO[] = [
  {
    version: WEBUI_DTO_VERSION,
    runId: "relay-214",
    repoId: "repo-relay",
    repository: "northstar/relay",
    worktree: "relay-routing-recovery",
    title: "Recover durable message routing",
    lifecycle: "input-required",
    driver: "Codex",
    reviewer: "Claude",
    startedAt: "2026-08-20T18:10:00.000Z",
    lastDurableEventAt: "2026-08-20T20:14:40.000Z",
    reasons: [
      reason(
        "input-required",
        "Operator input required",
        "A bounded scope choice must be confirmed before the next source write.",
        "high"
      ),
      reason(
        "surviving-adapter",
        "Adapter still attached",
        "One adapter remains visible while the run waits for input.",
        "medium"
      ),
    ],
    adapters: [
      {
        kind: "tmux",
        state: "surviving",
        label: "Primary terminal adapter",
        lastProbedAt: "2026-08-20T20:14:36.000Z",
      },
      {
        kind: "native",
        state: "healthy",
        label: "Native agent connection",
        lastProbedAt: "2026-08-20T20:14:38.000Z",
      },
    ],
    agents: [
      {
        id: "relay-driver",
        displayName: "Codex",
        role: "driver",
        lifecycle: "waiting-human",
      },
      {
        id: "relay-reviewer",
        displayName: "Claude",
        role: "reviewer",
        lifecycle: "waiting-peer",
      },
    ],
    quality: quality(
      "relay-214",
      "2026-08-20T20:14:40.000Z",
      "partial",
      "Core identity is current; one adapter reconciliation is pending."
    ),
    connection: connection(
      "relay-214",
      "2026-08-20T20:14:40.000Z",
      "live",
      147
    ),
    fixtureSource: fixtureSource("mixed-attention"),
  },
  {
    version: WEBUI_DTO_VERSION,
    runId: "sentinel-042",
    repoId: "repo-sentinel",
    repository: "lattice/sentinel",
    worktree: "sentinel-control-audit",
    title: "Audit lifecycle controls",
    lifecycle: "failed",
    driver: "Claude",
    reviewer: "Codex",
    startedAt: "2026-08-20T16:30:00.000Z",
    lastDurableEventAt: "2026-08-20T19:58:18.000Z",
    reasons: [
      reason(
        "failed-control",
        "Control acknowledgement failed",
        "A sealed control has no matching acknowledgement in the durable journal.",
        "critical"
      ),
    ],
    adapters: [
      {
        kind: "native",
        state: "ended",
        label: "Native agent connection",
        lastProbedAt: "2026-08-20T19:58:20.000Z",
      },
    ],
    agents: [
      {
        id: "sentinel-driver",
        displayName: "Claude",
        role: "driver",
        lifecycle: "crashed",
      },
      {
        id: "sentinel-reviewer",
        displayName: "Codex",
        role: "reviewer",
        lifecycle: "finished",
      },
    ],
    quality: quality(
      "sentinel-042",
      "2026-08-20T19:58:18.000Z",
      "conflict",
      "Lifecycle and control acknowledgement disagree."
    ),
    connection: connection(
      "sentinel-042",
      "2026-08-20T19:58:18.000Z",
      "offline",
      74
    ),
    fixtureSource: fixtureSource("failed-control"),
  },
  {
    version: WEBUI_DTO_VERSION,
    runId: "atlas-088",
    repoId: "repo-atlas",
    repository: "seabird/atlas",
    worktree: "atlas-index-refresh",
    title: "Refresh project index",
    lifecycle: "completed",
    driver: "Codex",
    reviewer: "Claude",
    startedAt: "2026-08-20T15:20:00.000Z",
    lastDurableEventAt: "2026-08-20T19:44:02.000Z",
    reasons: [
      reason(
        "surviving-adapter",
        "Cleanup verification needed",
        "The run completed, but a terminal adapter still answers its identity probe.",
        "medium"
      ),
    ],
    adapters: [
      {
        kind: "tmux",
        state: "surviving",
        label: "Primary terminal adapter",
        lastProbedAt: "2026-08-20T20:10:00.000Z",
      },
    ],
    agents: [
      {
        id: "atlas-driver",
        displayName: "Codex",
        role: "driver",
        lifecycle: "finished",
      },
      {
        id: "atlas-reviewer",
        displayName: "Claude",
        role: "reviewer",
        lifecycle: "finished",
      },
    ],
    quality: quality(
      "atlas-088",
      "2026-08-20T19:44:02.000Z",
      "healthy",
      "Durable run evidence is internally consistent."
    ),
    connection: connection("atlas-088", "2026-08-20T19:44:02.000Z", "live", 91),
    fixtureSource: fixtureSource("cleanup-debt"),
  },
  {
    version: WEBUI_DTO_VERSION,
    runId: "ridge-301",
    repoId: "repo-ridge",
    repository: "northstar/ridge",
    worktree: "ridge-observability",
    title: "Add bounded observability",
    lifecycle: "reviewing",
    driver: "Claude",
    reviewer: "Codex",
    startedAt: "2026-08-20T17:42:00.000Z",
    lastDurableEventAt: "2026-08-20T20:12:09.000Z",
    reasons: [],
    adapters: [
      {
        kind: "tmux",
        state: "healthy",
        label: "Primary terminal adapter",
        lastProbedAt: "2026-08-20T20:12:07.000Z",
      },
    ],
    agents: [
      {
        id: "ridge-driver",
        displayName: "Claude",
        role: "driver",
        lifecycle: "reviewing",
      },
      {
        id: "ridge-reviewer",
        displayName: "Codex",
        role: "reviewer",
        lifecycle: "working",
      },
    ],
    quality: quality(
      "ridge-301",
      "2026-08-20T20:12:09.000Z",
      "healthy",
      "All required durable sources are current."
    ),
    connection: connection(
      "ridge-301",
      "2026-08-20T20:12:09.000Z",
      "live",
      214
    ),
    fixtureSource: fixtureSource("active-review"),
  },
  {
    version: WEBUI_DTO_VERSION,
    runId: "ridge-298",
    repoId: "repo-ridge",
    repository: "northstar/ridge",
    worktree: "ridge-cache-boundary",
    title: "Verify cache boundary",
    lifecycle: "working",
    driver: "Codex",
    reviewer: "Claude",
    startedAt: "2026-08-20T17:10:00.000Z",
    lastDurableEventAt: "2026-08-20T20:03:14.000Z",
    reasons: [
      reason(
        "stream-behind",
        "Stream is behind",
        "Three durable events are waiting to be projected.",
        "low"
      ),
    ],
    adapters: [
      {
        kind: "native",
        state: "healthy",
        label: "Native agent connection",
        lastProbedAt: "2026-08-20T20:03:12.000Z",
      },
    ],
    agents: [
      {
        id: "ridge-cache-driver",
        displayName: "Codex",
        role: "driver",
        lifecycle: "working",
      },
      {
        id: "ridge-cache-reviewer",
        displayName: "Claude",
        role: "reviewer",
        lifecycle: "waiting-peer",
      },
    ],
    quality: quality(
      "ridge-298",
      "2026-08-20T20:03:14.000Z",
      "partial",
      "Identity is current; the event projection is three records behind."
    ),
    connection: connection(
      "ridge-298",
      "2026-08-20T20:03:14.000Z",
      "behind",
      132,
      3
    ),
    fixtureSource: fixtureSource("stream-behind"),
  },
  {
    version: WEBUI_DTO_VERSION,
    runId: "orbit-120",
    repoId: "repo-orbit",
    repository: "paperkite/orbit",
    worktree: "orbit-release-notes",
    title: "Prepare release notes",
    lifecycle: "completed",
    driver: "Claude",
    reviewer: "Codex",
    startedAt: "2026-08-20T13:00:00.000Z",
    lastDurableEventAt: "2026-08-20T18:22:11.000Z",
    reasons: [],
    adapters: [
      {
        kind: "native",
        state: "ended",
        label: "Native agent connection",
        lastProbedAt: "2026-08-20T18:22:15.000Z",
      },
    ],
    agents: [
      {
        id: "orbit-driver",
        displayName: "Claude",
        role: "driver",
        lifecycle: "finished",
      },
      {
        id: "orbit-reviewer",
        displayName: "Codex",
        role: "reviewer",
        lifecycle: "finished",
      },
    ],
    quality: quality(
      "orbit-120",
      "2026-08-20T18:22:11.000Z",
      "healthy",
      "Completion and review evidence are current."
    ),
    connection: connection(
      "orbit-120",
      "2026-08-20T18:22:11.000Z",
      "offline",
      58
    ),
    fixtureSource: fixtureSource("finished"),
  },
];

const minutesBefore = (at: string, minutes: number): string =>
  new Date(Date.parse(at) - minutes * 60_000).toISOString();

const makeAgents = (run: FleetRunDTO): readonly AgentSeatDTO[] => {
  const source = provenance(
    `${run.runId}-agent-detail`,
    "hook-journal",
    run.lastDurableEventAt
  );
  return run.agents.map((agent, index) => ({
    id: agent.id,
    displayName: agent.displayName,
    provider: agent.displayName,
    role: agent.role,
    model: index === 0 ? "frontier-large" : "frontier-review",
    reasoningEffort: index === 0 ? "high" : "medium",
    lifecycle: agent.lifecycle,
    currentTask:
      index === 0
        ? run.title
        : `Review evidence for ${run.title.toLowerCase()}`,
    taskSource: "Run charter",
    taskObservedAt: minutesBefore(run.lastDurableEventAt, 8),
    lastHookEvent:
      index === 0 ? "Tool result recorded" : "Review state observed",
    lastHookAt: minutesBefore(run.lastDurableEventAt, index),
    toolsInFlight: agent.lifecycle === "working" ? 1 : 0,
    usage: {
      inputTokens: 18_400 + index * 2400,
      outputTokens: 5200 + index * 700,
      cachedTokens: 7800 + index * 1100,
      costUsd: Number((1.84 + index * 0.73).toFixed(2)),
      contextPercent: 42 + index * 9,
      compactions: index,
      windows: [
        {
          kind: "session",
          usedPercent: 38 + index * 14,
          resetAt: "2026-08-20T23:00:00.000Z",
          resetState: "known",
          provenance: source,
        },
        {
          kind: "weekly",
          usedPercent: 27 + index * 11,
          resetAt: "2026-08-25T00:00:00.000Z",
          resetState: "known",
          provenance: source,
        },
      ],
    },
    latestBridgeMessage: {
      direction: index === 0 ? "sent" : "received",
      at: minutesBefore(run.lastDurableEventAt, 3),
      status: "delivered",
      summary:
        index === 0
          ? "Focused evidence is ready for review."
          : "Evidence receipt confirmed.",
    },
    provenance: [source],
  }));
};

const makeGoverness = (run: FleetRunDTO): GovernessDTO => {
  const source = provenance(
    `${run.runId}-governess-detail`,
    "governess-journal",
    run.lastDurableEventAt
  );
  return {
    epoch: `epoch-${run.runId}-04`,
    driverLease: `${run.driver} owns the active lease`,
    facts: [
      {
        label: "Lifecycle",
        value: run.lifecycle,
        status: run.lifecycle === "failed" ? "error" : "ok",
        provenance: source,
      },
      {
        label: "Adapter health",
        value: run.adapters.map((adapter) => adapter.state).join(", "),
        status: run.reasons.some((item) => item.code === "surviving-adapter")
          ? "warning"
          : "ok",
        provenance: source,
      },
      {
        label: "Data quality",
        value: run.quality.label,
        status: run.quality.severity === "healthy" ? "ok" : "warning",
        provenance: source,
      },
    ],
    interpretations: [
      {
        kind: "progress",
        summary: `Durable work is recorded for ${run.title.toLowerCase()}.`,
        confidence: 0.91,
        generatedAt: run.lastDurableEventAt,
        source: "Local fixture judge",
      },
      {
        kind: "next",
        summary:
          run.lifecycle === "input-required"
            ? "Wait for the bounded operator choice."
            : "Continue with the next verified checkpoint.",
        confidence: 0.87,
        generatedAt: run.lastDurableEventAt,
        source: "Local fixture judge",
      },
    ],
    policies: [
      {
        title: "Repository writes",
        disposition: run.lifecycle === "input-required" ? "blocked" : "allowed",
        reason:
          run.lifecycle === "input-required"
            ? "Waiting for explicit scope selection."
            : "The current driver holds the bounded lease.",
        releaseLabel: "Read-only release",
      },
      {
        title: "Lifecycle controls",
        disposition: "confirmation-bound",
        reason: "Future controls require a separate confirmed release.",
        releaseLabel: "Read-only release",
      },
    ],
    audit: [
      {
        controlId: `ctl-${run.runId}-06`,
        phase: "observed",
        transport: "durable journal",
        acknowledgement: "recorded",
        evidenceId: `ev_${run.runId}_control`,
        at: minutesBefore(run.lastDurableEventAt, 11),
      },
    ],
  };
};

const makeWorkers = (run: FleetRunDTO): readonly WorkerTierDTO[] => [
  {
    tier: "direct",
    label: "Direct",
    description: "Bounded tool execution owned by the active frontier agent.",
    counts: { queued: 0, active: 1, completed: 4, failed: 0 },
    activity: [
      {
        id: `worker-${run.runId}-direct-1`,
        tier: "direct",
        state: "active",
        routingReason: "The task requires repository-local inspection.",
        requestSummary: "Verify the current focused test evidence.",
        toolSummary: "Read-only repository and test inspection",
        resultSummary: "Focused evidence is internally consistent.",
        modelCalls: 0,
        tokens: 0,
        costUsd: 0,
        contextCapsule: "fixture-capsule-direct-01",
        artifactEvidenceIds: [`ev_${run.runId}_test`],
        startedAt: minutesBefore(run.lastDurableEventAt, 6),
      },
    ],
  },
  {
    tier: "nanny",
    label: "Nanny",
    description: "Local bounded assistance routed by the frontier owner.",
    counts: { queued: 0, active: 0, completed: 1, failed: 0 },
    activity: [
      {
        id: `worker-${run.runId}-nanny-1`,
        tier: "nanny",
        state: "completed",
        routingReason: "A deterministic summary fit the local worker tier.",
        requestSummary: "Summarize the named test results.",
        toolSummary: "Bounded evidence summarization",
        resultSummary: "Named results summarized with no scope expansion.",
        modelCalls: 1,
        tokens: 680,
        costUsd: 0.01,
        contextCapsule: "fixture-capsule-nanny-01",
        artifactEvidenceIds: [`ev_${run.runId}_review`],
        startedAt: minutesBefore(run.lastDurableEventAt, 18),
        finishedAt: minutesBefore(run.lastDurableEventAt, 16),
      },
    ],
  },
  {
    tier: "au-pair",
    label: "Au Pair",
    description: "Optional paid utility tier. Disabled in this fixture.",
    counts: { queued: 0, active: 0, completed: 0, failed: 0 },
    activity: [],
  },
];

const lifecycleTone = (run: FleetRunDTO): TimelineEventDTO["tone"] => {
  if (run.lifecycle === "failed") {
    return "danger";
  }
  if (run.lifecycle === "input-required") {
    return "warning";
  }
  return "info";
};

const makeTimeline = (run: FleetRunDTO): readonly TimelineEventDTO[] => {
  const source = provenance(
    `${run.runId}-timeline`,
    "hook-journal",
    run.lastDurableEventAt
  );
  return [
    {
      id: `${run.runId}-event-104`,
      sequence: 104,
      at: run.lastDurableEventAt,
      category: "lifecycle",
      actor: "Loop runtime",
      title: `Run is ${run.lifecycle}`,
      detail: "The latest canonical lifecycle was read from durable evidence.",
      tone: lifecycleTone(run),
      evidenceIds: [`ev_${run.runId}_log`],
      provenance: source,
    },
    {
      id: `${run.runId}-event-103`,
      sequence: 103,
      at: minutesBefore(run.lastDurableEventAt, 3),
      category: "bridge",
      actor: run.reviewer,
      title: "Peer receipt confirmed",
      detail: "A durable bridge receipt matched the intended recipient.",
      tone: "success",
      evidenceIds: [`ev_${run.runId}_review`],
      provenance: source,
    },
    {
      id: `${run.runId}-event-102`,
      sequence: 102,
      at: minutesBefore(run.lastDurableEventAt, 8),
      category: "worker",
      actor: "Direct worker",
      title: "Focused verification completed",
      detail: "The bounded check produced named test evidence.",
      tone: "success",
      evidenceIds: [`ev_${run.runId}_test`],
      provenance: source,
    },
  ];
};

const leaseState = (
  run: FleetRunDTO
): RunDetailDTO["authority"]["leaseState"] => {
  if (run.reasons.some((item) => item.code === "identity-conflict")) {
    return "conflict";
  }
  if (run.reasons.some((item) => item.code === "stale-authority")) {
    return "stale";
  }
  return "current";
};

const makeEvidence = (run: FleetRunDTO): readonly EvidenceItemDTO[] => {
  const source = provenance(
    `${run.runId}-evidence-index`,
    "fixture",
    run.lastDurableEventAt
  );
  return [
    {
      id: `ev_${run.runId}_log`,
      kind: "log",
      title: "Bounded lifecycle excerpt",
      summary: "Redacted lifecycle records around the latest durable event.",
      mimeType: "text/plain",
      byteCount: 1840,
      capturedAt: run.lastDurableEventAt,
      redactionsApplied: 4,
      provenance: source,
    },
    {
      id: `ev_${run.runId}_test`,
      kind: "test",
      title: "Focused test result",
      summary: "Named fixture tests completed with deterministic output.",
      mimeType: "application/json",
      byteCount: 920,
      capturedAt: minutesBefore(run.lastDurableEventAt, 8),
      redactionsApplied: 2,
      provenance: source,
    },
    {
      id: `ev_${run.runId}_review`,
      kind: "review",
      title: "Independent review receipt",
      summary: "The peer receipt and reviewed revision are preserved.",
      mimeType: "application/json",
      byteCount: 1104,
      capturedAt: minutesBefore(run.lastDurableEventAt, 3),
      redactionsApplied: 3,
      provenance: source,
    },
    {
      id: `ev_${run.runId}_control`,
      kind: "control",
      title: "Control audit record",
      summary: "Read-only control metadata with identifiers redacted.",
      mimeType: "application/json",
      byteCount: 736,
      capturedAt: minutesBefore(run.lastDurableEventAt, 11),
      redactionsApplied: 2,
      provenance: source,
    },
  ];
};

const makeRunDetail = (run: FleetRunDTO): RunDetailDTO => ({
  version: WEBUI_DTO_VERSION,
  summary: run,
  authority: {
    repoId: run.repoId,
    runId: run.runId,
    epoch: `epoch-${run.runId}-04`,
    currentDriver: run.driver,
    leaseState: leaseState(run),
  },
  agents: makeAgents(run),
  governess: makeGoverness(run),
  workers: makeWorkers(run),
  timeline: makeTimeline(run),
  evidence: makeEvidence(run),
  quality: run.quality,
  connection: run.connection,
  fixtureSource: run.fixtureSource,
});

export const fixtureRunDetails: Readonly<Record<string, RunDetailDTO>> =
  Object.freeze(
    Object.fromEntries(
      fixtureRuns.map((run) => [run.runId, makeRunDetail(run)])
    )
  );

export const fixtureFleetSnapshot: FleetSnapshotDTO = {
  version: WEBUI_DTO_VERSION,
  observedAt: GENERATED_AT,
  runs: fixtureRuns,
  quality: {
    severity: "partial",
    label: "Partial",
    summary: "One synthetic run contains a deliberate control conflict.",
    sources: [provenance("fixture-fleet", "fixture", GENERATED_AT, "current")],
  },
  connection: connection("fleet", GENERATED_AT, "live", 408),
  fixtureSource: fixtureSource("mixed-fleet"),
};
