import { describe, expect, test } from "bun:test";

import {
  fetchLiveSnapshot,
  isWebUiSnapshot,
  LiveSnapshotError,
} from "../../src/webui/api";
import type {
  ConnectionDTO,
  DataSourceDTO,
  FleetRunDTO,
  ProvenanceDTO,
  QualityDTO,
  RunDetailDTO,
  WebUiSnapshotDTO,
} from "../../src/webui/types";
import { WEBUI_DTO_VERSION } from "../../src/webui/types";

const NOW = "2026-08-21T20:00:00.000Z";
const REPO_ID = "alpha-repo-aaaaaaaaaaaa";
const ROUTE_ID = `${REPO_ID}:7`;
const EVIDENCE_ID = "ev_0123456789abcdef";

const PROVENANCE: ProvenanceDTO = {
  note: "Normalized metadata only.",
  observedAt: NOW,
  revision: "rev-7",
  sourceId: "manifest-7",
  sourceKind: "manifest",
  state: "current",
};
const CONNECTION: ConnectionDTO = {
  label: "Live",
  lastEventAt: NOW,
  lastObservedAt: NOW,
  queuedUpdates: 0,
  state: "live",
  streamEpoch: "epoch-7",
  streamSequence: 7,
};
const DATA_SOURCE: DataSourceDTO = {
  generatedAt: NOW,
  kind: "live-redacted",
  notice: "Live registry projection with sensitive fields removed.",
  scenario: "Loop registry",
};
const QUALITY: QualityDTO = {
  label: "Healthy",
  severity: "healthy",
  sources: [PROVENANCE],
  summary: "All required durable sources are current.",
};
const SUMMARY: FleetRunDTO = {
  adapters: [
    {
      kind: "tmux",
      label: "Primary terminal adapter",
      lastProbedAt: NOW,
      state: "healthy",
    },
  ],
  agents: [
    {
      displayName: "Codex",
      id: "codex-driver",
      lifecycle: "working",
      role: "driver",
    },
  ],
  connection: CONNECTION,
  dataSource: DATA_SOURCE,
  driver: "Codex",
  lastDurableEventAt: NOW,
  lifecycle: "working",
  quality: QUALITY,
  reasons: [],
  repoId: REPO_ID,
  repository: "Alpha repository",
  reviewer: "Claude",
  routeId: ROUTE_ID,
  runId: "7",
  startedAt: NOW,
  title: "Validate the live projection",
  version: WEBUI_DTO_VERSION,
  worktree: "webui-live-projection",
};
const DETAIL: RunDetailDTO = {
  agents: [
    {
      currentTask: "Validate the live projection",
      displayName: "Codex",
      id: "codex-driver",
      lastHookAt: NOW,
      lastHookEvent: "PostToolUse",
      latestBridgeMessage: {
        at: NOW,
        direction: "received",
        status: "delivered",
        summary: "Durable bridge metadata recorded; content redacted.",
      },
      lifecycle: "working",
      model: "gpt-5.6",
      provenance: [PROVENANCE],
      provider: "openai",
      reasoningEffort: "high",
      role: "driver",
      taskObservedAt: NOW,
      taskSource: "manifest",
      toolsInFlight: 0,
      usage: {
        cachedTokens: 64,
        compactions: 0,
        contextPercent: 25.5,
        costUsd: 0.01,
        inputTokens: 128,
        outputTokens: 64,
        windows: [
          {
            kind: "session",
            provenance: PROVENANCE,
            resetAt: NOW,
            resetState: "known",
            usedPercent: 25.5,
          },
        ],
      },
    },
  ],
  authority: {
    currentDriver: "Codex",
    epoch: "7",
    leaseState: "current",
    repoId: REPO_ID,
    runId: "7",
  },
  connection: CONNECTION,
  dataSource: DATA_SOURCE,
  evidence: [
    {
      byteCount: 128,
      capturedAt: NOW,
      id: EVIDENCE_ID,
      kind: "test",
      mimeType: "application/json",
      provenance: PROVENANCE,
      redactionsApplied: 2,
      summary: "The bounded projection contract passed.",
      title: "Projection contract",
    },
  ],
  governess: {
    audit: [
      {
        acknowledgement: "Recorded",
        at: NOW,
        controlId: "control-7",
        evidenceId: EVIDENCE_ID,
        phase: "review",
        transport: "durable",
      },
    ],
    driverLease: "Current",
    epoch: "7",
    facts: [
      {
        label: "Manifest",
        provenance: PROVENANCE,
        status: "ok",
        value: "Current",
      },
    ],
    interpretations: [
      {
        confidence: 0.75,
        generatedAt: NOW,
        kind: "progress",
        source: "normalized lifecycle metadata",
        summary: "The lane is working.",
      },
    ],
    policies: [
      {
        disposition: "blocked",
        reason: "No mutation endpoint is exposed.",
        releaseLabel: "Read-only release",
        title: "Browser mutations",
      },
    ],
  },
  quality: QUALITY,
  summary: { ...SUMMARY },
  timeline: [
    {
      actor: "Codex",
      at: NOW,
      category: "evidence",
      detail: "The live projection was validated.",
      evidenceIds: [EVIDENCE_ID],
      id: "event-7",
      provenance: PROVENANCE,
      sequence: 7,
      title: "Projection validated",
      tone: "success",
    },
  ],
  version: WEBUI_DTO_VERSION,
  workers: [
    {
      activity: [
        {
          artifactEvidenceIds: [EVIDENCE_ID],
          contextCapsule: "Bounded API contract context",
          costUsd: 0.02,
          finishedAt: NOW,
          id: "worker-7",
          modelCalls: 1,
          requestSummary: "Validate the API contract.",
          resultSummary: "The API contract passed.",
          routingReason: "Focused validation",
          startedAt: NOW,
          state: "completed",
          tier: "direct",
          tokens: 128,
          toolSummary: "Read-only validator",
        },
      ],
      counts: {
        active: 0,
        canceled: 0,
        completed: 1,
        escalated: 0,
        failed: 0,
        queued: 0,
      },
      description: "Direct bounded work",
      label: "Direct",
      tier: "direct",
    },
  ],
};
const VALID_SNAPSHOT: WebUiSnapshotDTO = {
  details: { [ROUTE_ID]: DETAIL },
  fleet: {
    connection: CONNECTION,
    dataSource: DATA_SOURCE,
    observedAt: NOW,
    quality: QUALITY,
    runs: [SUMMARY],
    version: WEBUI_DTO_VERSION,
  },
  source: "loop-registry-live",
  version: WEBUI_DTO_VERSION,
};

type PathSegment = number | string;

interface Mutation {
  readonly path: readonly PathSegment[];
  readonly value: unknown;
}

const isMutableRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const childAt = (container: unknown, segment: PathSegment): unknown => {
  if (typeof segment === "number") {
    if (!Array.isArray(container)) {
      throw new Error("Expected an array while mutating snapshot");
    }
    return container[segment];
  }
  if (!isMutableRecord(container)) {
    throw new Error("Expected an object while mutating snapshot");
  }
  return container[segment];
};

const assignAt = (
  container: unknown,
  segment: PathSegment,
  value: unknown
): void => {
  if (typeof segment === "number") {
    if (!Array.isArray(container)) {
      throw new Error("Expected an array while assigning snapshot mutation");
    }
    container[segment] = value;
    return;
  }
  if (!isMutableRecord(container)) {
    throw new Error("Expected an object while assigning snapshot mutation");
  }
  container[segment] = value;
};

const mutateSnapshot = (...mutations: readonly Mutation[]): unknown => {
  const snapshot: unknown = JSON.parse(JSON.stringify(VALID_SNAPSHOT));
  for (const mutation of mutations) {
    const lastSegment = mutation.path.at(-1);
    if (lastSegment === undefined) {
      throw new Error("Snapshot mutation path cannot be empty");
    }
    let parent: unknown = snapshot;
    for (const segment of mutation.path.slice(0, -1)) {
      parent = childAt(parent, segment);
    }
    assignAt(parent, lastSegment, mutation.value);
  }
  return snapshot;
};

const deleteAt = (container: unknown, path: readonly PathSegment[]): void => {
  const lastSegment = path.at(-1);
  if (typeof lastSegment !== "string") {
    throw new Error("Deleted snapshot field must be an object key");
  }
  let parent: unknown = container;
  for (const segment of path.slice(0, -1)) {
    parent = childAt(parent, segment);
  }
  if (!isMutableRecord(parent)) {
    throw new Error("Expected an object while deleting snapshot field");
  }
  delete parent[lastSegment];
};

interface RejectionCase {
  readonly label: string;
  readonly mutations: readonly Mutation[];
}

const pairedSummaryMutations = (
  path: readonly PathSegment[],
  value: unknown
): readonly Mutation[] => [
  { path: ["fleet", "runs", 0, ...path], value },
  { path: ["details", ROUTE_ID, "summary", ...path], value },
];

const UNKNOWN_FIELD_CASES: readonly RejectionCase[] = [
  {
    label: "snapshot",
    mutations: [{ path: ["prompt"], value: "must stay private" }],
  },
  {
    label: "fleet snapshot",
    mutations: [{ path: ["fleet", "prompt"], value: "must stay private" }],
  },
  {
    label: "connection",
    mutations: [
      { path: ["fleet", "connection", "prompt"], value: "must stay private" },
    ],
  },
  {
    label: "data source",
    mutations: [
      { path: ["fleet", "dataSource", "path"], value: "/private/run" },
    ],
  },
  {
    label: "quality",
    mutations: [
      { path: ["fleet", "quality", "prompt"], value: "must stay private" },
    ],
  },
  {
    label: "provenance",
    mutations: [
      {
        path: ["fleet", "quality", "sources", 0, "credential"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "fleet run",
    mutations: pairedSummaryMutations(["prompt"], "must stay private"),
  },
  {
    label: "adapter summary",
    mutations: pairedSummaryMutations(
      ["adapters", 0, "path"],
      "/private/socket"
    ),
  },
  {
    label: "fleet agent summary",
    mutations: pairedSummaryMutations(
      ["agents", 0, "credential"],
      "must stay private"
    ),
  },
  {
    label: "run reason",
    mutations: pairedSummaryMutations(
      ["reasons"],
      [
        {
          code: "input-required",
          detail: "Operator input is required.",
          label: "Input required",
          prompt: "must stay private",
          severity: "high",
        },
      ]
    ),
  },
  {
    label: "run detail",
    mutations: [
      {
        path: ["details", ROUTE_ID, "prompt"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "run authority",
    mutations: [
      {
        path: ["details", ROUTE_ID, "authority", "credential"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "agent seat",
    mutations: [
      {
        path: ["details", ROUTE_ID, "agents", 0, "prompt"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "agent usage",
    mutations: [
      {
        path: ["details", ROUTE_ID, "agents", 0, "usage", "credential"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "usage window",
    mutations: [
      {
        path: [
          "details",
          ROUTE_ID,
          "agents",
          0,
          "usage",
          "windows",
          0,
          "prompt",
        ],
        value: "must stay private",
      },
    ],
  },
  {
    label: "bridge message",
    mutations: [
      {
        path: [
          "details",
          ROUTE_ID,
          "agents",
          0,
          "latestBridgeMessage",
          "prompt",
        ],
        value: "must stay private",
      },
    ],
  },
  {
    label: "evidence item",
    mutations: [
      {
        path: ["details", ROUTE_ID, "evidence", 0, "path"],
        value: "/private/evidence",
      },
    ],
  },
  {
    label: "governess",
    mutations: [
      {
        path: ["details", ROUTE_ID, "governess", "prompt"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "governess audit",
    mutations: [
      {
        path: ["details", ROUTE_ID, "governess", "audit", 0, "prompt"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "governess fact",
    mutations: [
      {
        path: ["details", ROUTE_ID, "governess", "facts", 0, "credential"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "governess interpretation",
    mutations: [
      {
        path: [
          "details",
          ROUTE_ID,
          "governess",
          "interpretations",
          0,
          "prompt",
        ],
        value: "must stay private",
      },
    ],
  },
  {
    label: "governess policy",
    mutations: [
      {
        path: ["details", ROUTE_ID, "governess", "policies", 0, "prompt"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "worker tier",
    mutations: [
      {
        path: ["details", ROUTE_ID, "workers", 0, "prompt"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "worker counts",
    mutations: [
      {
        path: ["details", ROUTE_ID, "workers", 0, "counts", "prompt"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "worker activity",
    mutations: [
      {
        path: ["details", ROUTE_ID, "workers", 0, "activity", 0, "prompt"],
        value: "must stay private",
      },
    ],
  },
  {
    label: "timeline event",
    mutations: [
      {
        path: ["details", ROUTE_ID, "timeline", 0, "prompt"],
        value: "must stay private",
      },
    ],
  },
];

const NON_CANONICAL_TIMESTAMP_CASES: readonly RejectionCase[] = [
  {
    label: "fleet observedAt",
    mutations: [
      { path: ["fleet", "observedAt"], value: "2026-08-21 20:00:00Z" },
    ],
  },
  {
    label: "provenance observedAt",
    mutations: [
      {
        path: ["fleet", "quality", "sources", 0, "observedAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "connection lastEventAt",
    mutations: [
      {
        path: ["fleet", "connection", "lastEventAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "connection lastObservedAt",
    mutations: [
      {
        path: ["fleet", "connection", "lastObservedAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "data source generatedAt",
    mutations: [
      {
        path: ["fleet", "dataSource", "generatedAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "adapter lastProbedAt",
    mutations: pairedSummaryMutations(
      ["adapters", 0, "lastProbedAt"],
      "2026-08-21T20:00:00Z"
    ),
  },
  {
    label: "run lastDurableEventAt",
    mutations: pairedSummaryMutations(
      ["lastDurableEventAt"],
      "2026-08-21T20:00:00Z"
    ),
  },
  {
    label: "run startedAt",
    mutations: pairedSummaryMutations(["startedAt"], "2026-08-21T20:00:00Z"),
  },
  {
    label: "usage resetAt",
    mutations: [
      {
        path: [
          "details",
          ROUTE_ID,
          "agents",
          0,
          "usage",
          "windows",
          0,
          "resetAt",
        ],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "bridge at",
    mutations: [
      {
        path: ["details", ROUTE_ID, "agents", 0, "latestBridgeMessage", "at"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "agent lastHookAt",
    mutations: [
      {
        path: ["details", ROUTE_ID, "agents", 0, "lastHookAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "agent taskObservedAt",
    mutations: [
      {
        path: ["details", ROUTE_ID, "agents", 0, "taskObservedAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "worker startedAt",
    mutations: [
      {
        path: ["details", ROUTE_ID, "workers", 0, "activity", 0, "startedAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "worker finishedAt",
    mutations: [
      {
        path: ["details", ROUTE_ID, "workers", 0, "activity", 0, "finishedAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "evidence capturedAt",
    mutations: [
      {
        path: ["details", ROUTE_ID, "evidence", 0, "capturedAt"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "timeline at",
    mutations: [
      {
        path: ["details", ROUTE_ID, "timeline", 0, "at"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "governess audit at",
    mutations: [
      {
        path: ["details", ROUTE_ID, "governess", "audit", 0, "at"],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
  {
    label: "governess interpretation generatedAt",
    mutations: [
      {
        path: [
          "details",
          ROUTE_ID,
          "governess",
          "interpretations",
          0,
          "generatedAt",
        ],
        value: "2026-08-21T20:00:00Z",
      },
    ],
  },
];

const REQUIRED_COUNTER_PATHS: readonly (readonly PathSegment[])[] = [
  ["fleet", "connection", "queuedUpdates"],
  ["fleet", "connection", "streamSequence"],
  ["details", ROUTE_ID, "agents", 0, "toolsInFlight"],
  ["details", ROUTE_ID, "agents", 0, "usage", "compactions"],
  ["details", ROUTE_ID, "evidence", 0, "byteCount"],
  ["details", ROUTE_ID, "evidence", 0, "redactionsApplied"],
  ["details", ROUTE_ID, "timeline", 0, "sequence"],
  ["details", ROUTE_ID, "workers", 0, "counts", "active"],
  ["details", ROUTE_ID, "workers", 0, "counts", "canceled"],
  ["details", ROUTE_ID, "workers", 0, "counts", "completed"],
  ["details", ROUTE_ID, "workers", 0, "counts", "escalated"],
  ["details", ROUTE_ID, "workers", 0, "counts", "failed"],
  ["details", ROUTE_ID, "workers", 0, "counts", "queued"],
];

const OPTIONAL_COUNTER_PATHS: readonly (readonly PathSegment[])[] = [
  ["details", ROUTE_ID, "agents", 0, "usage", "cachedTokens"],
  ["details", ROUTE_ID, "agents", 0, "usage", "inputTokens"],
  ["details", ROUTE_ID, "agents", 0, "usage", "outputTokens"],
  ["details", ROUTE_ID, "workers", 0, "activity", 0, "modelCalls"],
  ["details", ROUTE_ID, "workers", 0, "activity", 0, "tokens"],
];

const COERCED_ENUM_CASES: readonly RejectionCase[] = [
  {
    label: "run-reason severity",
    mutations: pairedSummaryMutations(
      ["reasons"],
      [
        {
          code: "input-required",
          detail: "Operator input is required.",
          label: "Input required",
          severity: ["low"],
        },
      ]
    ),
  },
  {
    label: "usage reset state",
    mutations: [
      {
        path: [
          "details",
          ROUTE_ID,
          "agents",
          0,
          "usage",
          "windows",
          0,
          "resetState",
        ],
        value: ["known"],
      },
    ],
  },
  {
    label: "evidence kind",
    mutations: [
      {
        path: ["details", ROUTE_ID, "evidence", 0, "kind"],
        value: ["artifact"],
      },
    ],
  },
  {
    label: "timeline category",
    mutations: [
      {
        path: ["details", ROUTE_ID, "timeline", 0, "category"],
        value: ["evidence"],
      },
    ],
  },
  {
    label: "timeline tone",
    mutations: [
      {
        path: ["details", ROUTE_ID, "timeline", 0, "tone"],
        value: ["success"],
      },
    ],
  },
  {
    label: "Governess fact status",
    mutations: [
      {
        path: ["details", ROUTE_ID, "governess", "facts", 0, "status"],
        value: ["ok"],
      },
    ],
  },
  {
    label: "Governess interpretation kind",
    mutations: [
      {
        path: ["details", ROUTE_ID, "governess", "interpretations", 0, "kind"],
        value: ["progress"],
      },
    ],
  },
  {
    label: "Governess policy disposition",
    mutations: [
      {
        path: ["details", ROUTE_ID, "governess", "policies", 0, "disposition"],
        value: ["blocked"],
      },
    ],
  },
  {
    label: "authority lease state",
    mutations: [
      {
        path: ["details", ROUTE_ID, "authority", "leaseState"],
        value: ["current"],
      },
    ],
  },
];

describe("Web UI live DTO boundary", () => {
  test("accepts the complete live-only snapshot contract", () => {
    expect(isWebUiSnapshot(structuredClone(VALID_SNAPSHOT))).toBe(true);
  });

  test("accepts declared optional fields when omitted", () => {
    const candidate: unknown = structuredClone(VALID_SNAPSHOT);
    const optionalPaths: readonly (readonly PathSegment[])[] = [
      ["fleet", "quality", "sources", 0, "note"],
      ["details", ROUTE_ID, "agents", 0, "latestBridgeMessage"],
      ["details", ROUTE_ID, "agents", 0, "usage", "cachedTokens"],
      ["details", ROUTE_ID, "agents", 0, "usage", "contextPercent"],
      ["details", ROUTE_ID, "agents", 0, "usage", "costUsd"],
      ["details", ROUTE_ID, "agents", 0, "usage", "inputTokens"],
      ["details", ROUTE_ID, "agents", 0, "usage", "outputTokens"],
      ["details", ROUTE_ID, "agents", 0, "usage", "windows", 0, "resetAt"],
      ["details", ROUTE_ID, "workers", 0, "activity", 0, "costUsd"],
      ["details", ROUTE_ID, "workers", 0, "activity", 0, "finishedAt"],
      ["details", ROUTE_ID, "workers", 0, "activity", 0, "modelCalls"],
      ["details", ROUTE_ID, "workers", 0, "activity", 0, "tokens"],
    ];
    for (const path of optionalPaths) {
      deleteAt(candidate, path);
    }
    expect(isWebUiSnapshot(candidate)).toBe(true);
  });

  test("accepts canonical expanded-year timestamps emitted by Date.toISOString", () => {
    expect(
      isWebUiSnapshot(
        mutateSnapshot({
          path: ["fleet", "observedAt"],
          value: "+010000-01-01T00:00:00.000Z",
        })
      )
    ).toBe(true);
  });

  for (const scenario of UNKNOWN_FIELD_CASES) {
    test(`rejects unknown own keys on ${scenario.label}`, () => {
      expect(isWebUiSnapshot(mutateSnapshot(...scenario.mutations))).toBe(
        false
      );
    });
  }

  for (const scenario of NON_CANONICAL_TIMESTAMP_CASES) {
    test(`rejects non-canonical ISO timestamp for ${scenario.label}`, () => {
      expect(isWebUiSnapshot(mutateSnapshot(...scenario.mutations))).toBe(
        false
      );
    });
  }

  for (const scenario of COERCED_ENUM_CASES) {
    test(`rejects array coercion for ${scenario.label}`, () => {
      expect(isWebUiSnapshot(mutateSnapshot(...scenario.mutations))).toBe(
        false
      );
    });
  }

  test("rejects invalid top-level source literals", () => {
    expect(
      isWebUiSnapshot(
        mutateSnapshot({
          path: ["source"],
          value: "loop-registry-live-with-hidden-fallback",
        })
      )
    ).toBe(false);
  });

  test("rejects non-literal read-only policy labels", () => {
    for (const value of [
      "read-only release",
      "Read-only release ",
      "Mutable release",
    ]) {
      expect(
        isWebUiSnapshot(
          mutateSnapshot({
            path: [
              "details",
              ROUTE_ID,
              "governess",
              "policies",
              0,
              "releaseLabel",
            ],
            value,
          })
        )
      ).toBe(false);
    }
  });

  test("rejects malformed evidence identifiers at every reference site", () => {
    const locations: readonly (readonly PathSegment[])[] = [
      ["details", ROUTE_ID, "evidence", 0, "id"],
      ["details", ROUTE_ID, "governess", "audit", 0, "evidenceId"],
      ["details", ROUTE_ID, "timeline", 0, "evidenceIds"],
      ["details", ROUTE_ID, "workers", 0, "activity", 0, "artifactEvidenceIds"],
    ];

    for (const path of locations) {
      const lastSegment = path.at(-1);
      const value =
        typeof lastSegment === "string" && lastSegment.endsWith("Ids")
          ? ["ev_raw-prompt"]
          : "ev_raw-prompt";
      expect(isWebUiSnapshot(mutateSnapshot({ path, value }))).toBe(false);
    }
  });

  test("rejects every malformed opaque evidence-ID grammar branch", () => {
    const invalidIds = [
      "ev_",
      "ev_0123456789abcde",
      "ev_0123456789abcdef0",
      "ev_0123456789abcdeF",
      "ev_0123456789abcdeg",
      "ev_raw-prompt",
      "evidence_0123456789abcdef",
    ];
    for (const value of invalidIds) {
      expect(
        isWebUiSnapshot(
          mutateSnapshot({
            path: ["details", ROUTE_ID, "evidence", 0, "id"],
            value,
          })
        )
      ).toBe(false);
    }
  });

  test("rejects parseable but noncanonical and impossible timestamps", () => {
    const invalidTimestamps = [
      "2026-08-21T20:00:00Z",
      "2026-08-21T13:00:00.000-07:00",
      "2026-08-21",
      "2026-02-30T20:00:00.000Z",
    ];
    for (const value of invalidTimestamps) {
      expect(
        isWebUiSnapshot(
          mutateSnapshot({ path: ["fleet", "observedAt"], value })
        )
      ).toBe(false);
    }
  });

  test("rejects negative, fractional, and unsafe required counters", () => {
    for (const path of REQUIRED_COUNTER_PATHS) {
      for (const value of [
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(isWebUiSnapshot(mutateSnapshot({ path, value }))).toBe(false);
      }
    }
  });

  test("rejects negative, fractional, and unsafe optional counters", () => {
    for (const path of OPTIONAL_COUNTER_PATHS) {
      for (const value of [
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(isWebUiSnapshot(mutateSnapshot({ path, value }))).toBe(false);
      }
    }
  });

  test("rejects out-of-range percentages and confidence", () => {
    const percentagePaths: readonly (readonly PathSegment[])[] = [
      ["details", ROUTE_ID, "agents", 0, "usage", "contextPercent"],
      ["details", ROUTE_ID, "agents", 0, "usage", "windows", 0, "usedPercent"],
    ];
    for (const path of percentagePaths) {
      for (const value of [-0.1, 100.1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(isWebUiSnapshot(mutateSnapshot({ path, value }))).toBe(false);
      }
    }

    const confidencePath = [
      "details",
      ROUTE_ID,
      "governess",
      "interpretations",
      0,
      "confidence",
    ] as const;
    for (const value of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        isWebUiSnapshot(mutateSnapshot({ path: confidencePath, value }))
      ).toBe(false);
    }
  });

  test("rejects negative or non-finite costs", () => {
    const costPaths: readonly (readonly PathSegment[])[] = [
      ["details", ROUTE_ID, "agents", 0, "usage", "costUsd"],
      ["details", ROUTE_ID, "workers", 0, "activity", 0, "costUsd"],
    ];
    for (const path of costPaths) {
      for (const value of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(isWebUiSnapshot(mutateSnapshot({ path, value }))).toBe(false);
      }
    }
  });

  test("accepts zero at every optional cost consumer", () => {
    const costPaths: readonly (readonly PathSegment[])[] = [
      ["details", ROUTE_ID, "agents", 0, "usage", "costUsd"],
      ["details", ROUTE_ID, "workers", 0, "activity", 0, "costUsd"],
    ];
    for (const path of costPaths) {
      expect(isWebUiSnapshot(mutateSnapshot({ path, value: 0 }))).toBe(true);
    }
  });

  test("rejects synthetic data-source markers at every DTO level", () => {
    const locations: readonly (readonly Mutation[])[] = [
      [
        {
          path: ["fleet", "dataSource", "kind"],
          value: "synthetic-redacted",
        },
      ],
      [
        {
          path: ["fleet", "runs", 0, "dataSource", "kind"],
          value: "synthetic-redacted",
        },
        {
          path: ["details", ROUTE_ID, "summary", "dataSource", "kind"],
          value: "synthetic-redacted",
        },
      ],
      [
        {
          path: ["details", ROUTE_ID, "dataSource", "kind"],
          value: "synthetic-redacted",
        },
      ],
    ];

    for (const mutations of locations) {
      expect(isWebUiSnapshot(mutateSnapshot(...mutations))).toBe(false);
    }
  });

  test("rejects fixture provenance at every provenance-bearing DTO location", () => {
    const locations: readonly (readonly Mutation[])[] = [
      [
        {
          path: ["fleet", "quality", "sources", 0, "sourceKind"],
          value: "fixture",
        },
      ],
      [
        {
          path: ["fleet", "runs", 0, "quality", "sources", 0, "sourceKind"],
          value: "fixture",
        },
        {
          path: [
            "details",
            ROUTE_ID,
            "summary",
            "quality",
            "sources",
            0,
            "sourceKind",
          ],
          value: "fixture",
        },
      ],
      [
        {
          path: [
            "details",
            ROUTE_ID,
            "agents",
            0,
            "provenance",
            0,
            "sourceKind",
          ],
          value: "fixture",
        },
      ],
      [
        {
          path: [
            "details",
            ROUTE_ID,
            "agents",
            0,
            "usage",
            "windows",
            0,
            "provenance",
            "sourceKind",
          ],
          value: "fixture",
        },
      ],
      [
        {
          path: [
            "details",
            ROUTE_ID,
            "evidence",
            0,
            "provenance",
            "sourceKind",
          ],
          value: "fixture",
        },
      ],
      [
        {
          path: [
            "details",
            ROUTE_ID,
            "governess",
            "facts",
            0,
            "provenance",
            "sourceKind",
          ],
          value: "fixture",
        },
      ],
      [
        {
          path: ["details", ROUTE_ID, "quality", "sources", 0, "sourceKind"],
          value: "fixture",
        },
      ],
      [
        {
          path: [
            "details",
            ROUTE_ID,
            "timeline",
            0,
            "provenance",
            "sourceKind",
          ],
          value: "fixture",
        },
      ],
    ];

    for (const mutations of locations) {
      expect(isWebUiSnapshot(mutateSnapshot(...mutations))).toBe(false);
    }
  });

  test("rejects a structurally different detail summary even when identity matches", () => {
    expect(
      isWebUiSnapshot(
        mutateSnapshot({
          path: ["details", ROUTE_ID, "summary", "title"],
          value: "Different valid title",
        })
      )
    ).toBe(false);
  });

  test("rejects unknown reason codes even when fleet and detail summaries agree", () => {
    const validReason = {
      code: "input-required",
      detail: "Operator input is required.",
      label: "Input required",
      severity: "high",
    };
    const invalidReason = { ...validReason, code: "made-up" };

    expect(
      isWebUiSnapshot(
        mutateSnapshot(
          { path: ["fleet", "runs", 0, "reasons"], value: [validReason] },
          {
            path: ["details", ROUTE_ID, "summary", "reasons"],
            value: [validReason],
          }
        )
      )
    ).toBe(true);
    expect(
      isWebUiSnapshot(
        mutateSnapshot(
          { path: ["fleet", "runs", 0, "reasons"], value: [invalidReason] },
          {
            path: ["details", ROUTE_ID, "summary", "reasons"],
            value: [invalidReason],
          }
        )
      )
    ).toBe(false);
  });

  test("rejects malformed or negative optional worker completion metrics", () => {
    const activityPath = [
      "details",
      ROUTE_ID,
      "workers",
      0,
      "activity",
      0,
    ] as const;
    const mutations: readonly Mutation[] = [
      { path: [...activityPath, "finishedAt"], value: "not-an-iso-date" },
      { path: [...activityPath, "costUsd"], value: -0.01 },
      { path: [...activityPath, "costUsd"], value: Number.POSITIVE_INFINITY },
      { path: [...activityPath, "modelCalls"], value: -1 },
      { path: [...activityPath, "modelCalls"], value: Number.NaN },
      { path: [...activityPath, "tokens"], value: -1 },
      { path: [...activityPath, "tokens"], value: Number.POSITIVE_INFINITY },
    ];

    for (const mutation of mutations) {
      expect(isWebUiSnapshot(mutateSnapshot(mutation))).toBe(false);
    }
  });

  test("fetch rejects synthetic data and fixture provenance instead of accepting fallback DTOs", async () => {
    const originalFetch = globalThis.fetch;
    const candidates = [
      mutateSnapshot({
        path: ["fleet", "dataSource", "kind"],
        value: "synthetic-redacted",
      }),
      mutateSnapshot({
        path: ["details", ROUTE_ID, "timeline", 0, "provenance", "sourceKind"],
        value: "fixture",
      }),
    ];

    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(VALID_SNAPSHOT), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })) as unknown as typeof globalThis.fetch;
      await expect(fetchLiveSnapshot()).resolves.toMatchObject({
        source: "loop-registry-live",
        version: WEBUI_DTO_VERSION,
      });

      for (const candidate of candidates) {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(candidate), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          })) as unknown as typeof globalThis.fetch;
        await expect(fetchLiveSnapshot()).rejects.toBeInstanceOf(
          LiveSnapshotError
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
