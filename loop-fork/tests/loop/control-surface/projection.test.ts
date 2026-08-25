import { expect, test } from "bun:test";
import {
  classifyFreshness,
  FRESHNESS_THRESHOLDS_MS,
  projectFleet,
  projectRun,
} from "../../../src/loop/control-surface/projection";
import type {
  ReadModelCapabilities,
  RunLocator,
  SourceKind,
  SourceSnapshot,
} from "../../../src/loop/control-surface/types";

const locator: RunLocator = {
  repoId: "repo-a",
  runId: "7",
  runDir: "/evidence/repo-a/7",
  storageRoot: "/evidence",
};

const snapshot = <T>(
  kind: SourceKind,
  value: T,
  revision = `${kind}-1`
): SourceSnapshot<T> => ({
  kind,
  observedAt: 1_000_000,
  recordedAt: 1_000_000,
  revision,
  status: "available",
  value,
});

const makeCapabilities = (): ReadModelCapabilities => ({
  listRuns: () => [locator],
  now: () => 1_000_000,
  readSources: () => ({
    adapter: snapshot("adapter", {
      processBirthId: "darwin:1",
      serverPid: 42,
      version: 1,
    }),
    bridge: snapshot("bridge", []),
    "governess-control": snapshot("governess-control", []),
    "governess-state": snapshot("governess-state", { state: "working" }),
    hooks: snapshot("hooks", []),
    manifest: snapshot("manifest", {
      createdAt: "2026-01-01T00:00:00.000Z",
      repoId: "repo-a",
      resolvedConfig: {
        governess: true,
        pairedMode: true,
        proofConfigured: false,
        tmux: true,
        version: 1,
        worktree: true,
      },
      runId: "7",
      state: "working",
      status: "running",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    transcript: snapshot("transcript", []),
    usage: snapshot("usage", { totalTokens: 17 }),
    utility: snapshot("utility", { activeJobs: 0 }),
  }),
});

test("freshness thresholds are inclusive and tested on both sides", () => {
  for (const [kind, threshold] of Object.entries(FRESHNESS_THRESHOLDS_MS) as [
    SourceKind,
    number,
  ][]) {
    expect(classifyFreshness(kind, 10_000, 10_000 + threshold - 1)).toBe(
      "fresh"
    );
    expect(classifyFreshness(kind, 10_000, 10_000 + threshold)).toBe("fresh");
    expect(classifyFreshness(kind, 10_000, 10_000 + threshold + 1)).toBe(
      "stale"
    );
  }
  expect(classifyFreshness("manifest", 10_001, 10_000)).toBe("unknown");
});

test("canonical identity rejects path and manifest disagreement", () => {
  const deps = makeCapabilities();
  const original = deps.readSources;
  deps.readSources = (selected) => {
    const sources = original(selected);
    return {
      ...sources,
      manifest: snapshot("manifest", { ...sources.manifest.value, runId: "8" }),
    };
  };
  expect(projectRun(locator, deps)).toEqual({
    kind: "rejected",
    reason: "identity-mismatch",
    repoId: "repo-a",
    runId: "7",
  });
  expect(projectFleet(deps).runs).toHaveLength(0);
});

test("requirements stay separate from observations and legacy absence stays unknown", () => {
  const deps = makeCapabilities();
  const sources = deps.readSources(locator);
  sources.manifest = snapshot("manifest", {
    createdAt: "2026-01-01T00:00:00.000Z",
    repoId: "repo-a",
    runId: "7",
    state: "working",
    status: "running",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  deps.readSources = () => sources;
  const result = projectRun(locator, deps);
  expect(result.kind).toBe("run");
  if (result.kind === "run") {
    expect(result.run.requirements.adapterIdentity).toBe("unknown");
    expect(result.run.observations.adapterIdentity).toBe("present");
    expect(result.run.aggregate.status).toBe("unknown");
  }
});

test("a changing source retries once and a second change fails closed", () => {
  const deps = makeCapabilities();
  let reads = 0;
  deps.readSources = () => {
    reads += 1;
    const sources = makeCapabilities().readSources(locator);
    sources.bridge = snapshot("bridge", [], `bridge-${reads}`);
    return sources;
  };
  const result = projectRun(locator, deps);
  expect(reads).toBe(4);
  expect(result.kind).toBe("unstable");
  if (result.kind === "unstable") {
    expect(result.conflicts).toEqual(["source-revisions-changed"]);
  }
});

test("public config and adapter DTOs expose only the strict allowlists", () => {
  const deps = makeCapabilities();
  const result = projectRun(locator, deps);
  expect(result.kind).toBe("run");
  if (result.kind === "run") {
    expect(Object.keys(result.run.config).sort()).toEqual([
      "governess",
      "pairedMode",
      "proofConfigured",
      "tmux",
      "version",
      "worktree",
    ]);
    expect(Object.keys(result.run.adapter).sort()).toEqual([
      "processBirthId",
      "serverPid",
      "version",
    ]);
    expect(JSON.stringify(result.run)).not.toContain("/evidence");
  }
});

test("malformed producer fields fail closed and lifecycle conflicts are explicit", () => {
  const deps = makeCapabilities();
  const sources = deps.readSources(locator);
  sources.manifest = snapshot("manifest", {
    repoId: "repo-a",
    runId: "7",
    state: "working",
    status: "running",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resolvedConfig: { version: 1, governess: "yes" },
  });
  deps.readSources = () => sources;
  const malformed = projectRun(locator, deps);
  expect(malformed.kind).toBe("rejected");

  const validDeps = makeCapabilities();
  const validSources = validDeps.readSources(locator);
  validSources["governess-state"] = snapshot("governess-state", {
    state: "reviewing",
  });
  validDeps.readSources = () => validSources;
  const conflict = projectRun(locator, validDeps);
  expect(conflict.kind).toBe("run");
  if (conflict.kind === "run") {
    expect(conflict.run.conflicts).toEqual(["lifecycle-state-mismatch"]);
    expect(conflict.run.aggregate.status).toBe("conflict");
  }
});

test("unknown freshness and invalid producer schemas never become healthy", () => {
  const deps = makeCapabilities();
  const sources = deps.readSources(locator);
  sources.transcript.recordedAt = undefined;
  deps.readSources = () => sources;
  const unknown = projectRun(locator, deps);
  expect(unknown.kind).toBe("run");
  if (unknown.kind === "run") {
    expect(unknown.run.observations.transcript).toBe("unknown");
    expect(unknown.run.aggregate.status).toBe("unknown");
  }

  for (const manifest of [
    { ...(sources.manifest.value as object), createdAt: undefined },
    {
      ...(sources.manifest.value as object),
      state: "completed",
      status: "running",
    },
    {
      ...(sources.manifest.value as object),
      resolvedConfig: {
        ...(sources.manifest.value as any).resolvedConfig,
        hidden: "payload",
      },
    },
    {
      ...(sources.manifest.value as object),
      tmuxAdapterIdentity: {
        processBirthId: "darwin:1",
        serverPid: 2,
        version: 1,
      },
    },
  ]) {
    const invalidDeps = makeCapabilities();
    const invalidSources = invalidDeps.readSources(locator);
    invalidSources.manifest = snapshot("manifest", manifest);
    invalidDeps.readSources = () => invalidSources;
    expect(projectRun(locator, invalidDeps).kind).toBe("rejected");
  }
});
