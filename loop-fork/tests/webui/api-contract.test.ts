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

const PROVENANCE: ProvenanceDTO = {
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
        compactions: 0,
        windows: [
          {
            kind: "session",
            provenance: PROVENANCE,
            resetAt: NOW,
            resetState: "known",
            usedPercent: 25,
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
      id: "ev_projection",
      kind: "test",
      mimeType: "application/json",
      provenance: PROVENANCE,
      redactionsApplied: 2,
      summary: "The bounded projection contract passed.",
      title: "Projection contract",
    },
  ],
  governess: {
    audit: [],
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
    interpretations: [],
    policies: [],
  },
  quality: QUALITY,
  summary: { ...SUMMARY },
  timeline: [
    {
      actor: "Codex",
      at: NOW,
      category: "evidence",
      detail: "The live projection was validated.",
      evidenceIds: ["ev_projection"],
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
          artifactEvidenceIds: ["ev_projection"],
          contextCapsule: "Bounded API contract context",
          costUsd: 0,
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

describe("Web UI live DTO boundary", () => {
  test("accepts the complete live-only snapshot contract", () => {
    expect(isWebUiSnapshot(structuredClone(VALID_SNAPSHOT))).toBe(true);
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
