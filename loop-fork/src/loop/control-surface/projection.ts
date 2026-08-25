import { selectPublicAdapter, selectPublicConfig } from "./redaction";
import {
  type Observation,
  type ReadModelCapabilities,
  type Requirement,
  type RunLocator,
  type RunProjection,
  type RunProjectionResult,
  type RunSourceSnapshots,
  SOURCE_KINDS,
  type SourceFreshness,
  type SourceKind,
  type SourceSnapshot,
} from "./types";

export const FRESHNESS_THRESHOLDS_MS: Record<SourceKind, number> = {
  adapter: 30_000,
  bridge: 60_000,
  "governess-control": 60_000,
  "governess-state": 30_000,
  hooks: 60_000,
  manifest: 60_000,
  transcript: 60_000,
  usage: 5 * 60_000,
  utility: 60_000,
};

export const classifyFreshness = (
  kind: SourceKind,
  recordedAt: number | undefined,
  now: number
): SourceFreshness => {
  if (recordedAt === undefined || !Number.isFinite(recordedAt)) {
    return "unknown";
  }
  if (recordedAt > now) {
    return "unknown";
  }
  return now - recordedAt <= FRESHNESS_THRESHOLDS_MS[kind] ? "fresh" : "stale";
};

const revisionVector = (sources: RunSourceSnapshots): string =>
  SOURCE_KINDS.map(
    (kind) => `${kind}:${sources[kind].status}:${sources[kind].revision ?? "-"}`
  ).join("|");

const manifestRecord = (
  snapshot: SourceSnapshot
): Record<string, unknown> | undefined =>
  snapshot.status === "available" &&
  snapshot.value &&
  typeof snapshot.value === "object"
    ? (snapshot.value as Record<string, unknown>)
    : undefined;

const LIFECYCLE_STATES = new Set([
  "submitted",
  "working",
  "reviewing",
  "input-required",
  "completed",
  "failed",
  "stopped",
]);
const RUN_STATUSES = new Set(["running", "done", "failed", "stopped"]);
const CONFIG_KEYS = new Set([
  "governess",
  "pairedMode",
  "proofConfigured",
  "review",
  "reviewPlan",
  "tmux",
  "version",
  "worktree",
]);
const ADAPTER_KEYS = new Set([
  "processBirthId",
  "serverPid",
  "socketPath",
  "version",
]);
const isCanonicalTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: Set<string>
): boolean => Object.keys(value).every((key) => allowed.has(key));

const isValidProducerConfig = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  hasOnlyKeys(value as Record<string, unknown>, CONFIG_KEYS) &&
  selectPublicConfig(value) !== undefined;

const isValidProducerAdapter = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, ADAPTER_KEYS) &&
    typeof record.socketPath === "string" &&
    record.socketPath.startsWith("/") &&
    selectPublicAdapter(value) !== undefined
  );
};

const lifecyclePairIsValid = (state: unknown, status: unknown): boolean => {
  if (typeof state !== "string" || typeof status !== "string") {
    return false;
  }
  if (["submitted", "working", "reviewing", "input-required"].includes(state)) {
    return status === "running";
  }
  if (state === "completed") {
    return status === "done";
  }
  return state === status;
};

const isValidManifest = (manifest: Record<string, unknown>): boolean =>
  typeof manifest.repoId === "string" &&
  typeof manifest.runId === "string" &&
  typeof manifest.state === "string" &&
  LIFECYCLE_STATES.has(manifest.state) &&
  typeof manifest.status === "string" &&
  RUN_STATUSES.has(manifest.status) &&
  lifecyclePairIsValid(manifest.state, manifest.status) &&
  isCanonicalTimestamp(manifest.createdAt) &&
  isCanonicalTimestamp(manifest.updatedAt) &&
  (manifest.resolvedConfig === undefined ||
    isValidProducerConfig(manifest.resolvedConfig)) &&
  (manifest.tmuxAdapterIdentity === undefined ||
    isValidProducerAdapter(manifest.tmuxAdapterIdentity));

const requirement = (configured: unknown): Requirement => {
  if (configured === true) {
    return "required";
  }
  if (configured === false) {
    return "not-required";
  }
  return "unknown";
};

const observe = (
  snapshot: SourceSnapshot,
  now: number,
  valid = true
): Observation => {
  if (snapshot.status === "missing") {
    return "missing";
  }
  if (snapshot.status === "malformed" || snapshot.status === "oversize") {
    return "malformed";
  }
  if (snapshot.status !== "available" || !valid) {
    return "unknown";
  }
  const freshness = classifyFreshness(snapshot.kind, snapshot.recordedAt, now);
  if (freshness === "unknown") {
    return "unknown";
  }
  return freshness === "stale" ? "stale" : "present";
};

const aggregateStatus = (
  requirements: RunProjection["requirements"],
  observations: RunProjection["observations"]
): RunProjection["aggregate"]["status"] => {
  const pairs = (
    Object.keys(requirements) as (keyof typeof requirements)[]
  ).map((key) => [requirements[key], observations[key]] as const);
  if (pairs.some(([required]) => required === "unknown")) {
    return "unknown";
  }
  const required = pairs.filter(([state]) => state === "required");
  if (required.some(([, observed]) => observed === "stale")) {
    return "stale";
  }
  if (
    required.some(
      ([, observed]) => observed === "missing" || observed === "malformed"
    )
  ) {
    return "partial";
  }
  if (required.some(([, observed]) => observed === "unknown")) {
    return "unknown";
  }
  return "healthy";
};

const buildProjection = (
  locator: RunLocator,
  sources: RunSourceSnapshots,
  now: number
): RunProjectionResult => {
  const manifest = manifestRecord(sources.manifest);
  if (
    !(manifest && isValidManifest(manifest)) ||
    manifest.repoId !== locator.repoId ||
    manifest.runId !== locator.runId
  ) {
    return {
      kind: "rejected",
      reason: "identity-mismatch",
      repoId: locator.repoId,
      runId: locator.runId,
    };
  }
  const config = selectPublicConfig(manifest.resolvedConfig);
  const adapterSource = manifest.tmuxAdapterIdentity ?? sources.adapter.value;
  const adapter = selectPublicAdapter(adapterSource);
  const requirements = {
    adapterIdentity: config ? requirement(config.tmux) : "unknown",
    bridge: config ? requirement(config.pairedMode) : "unknown",
    governess: config ? requirement(config.governess) : "unknown",
    transcript: "required",
  } satisfies RunProjection["requirements"];
  const observations = {
    adapterIdentity: observe(sources.adapter, now, adapter !== undefined),
    bridge: observe(sources.bridge, now),
    governess: observe(sources["governess-state"], now),
    transcript: observe(sources.transcript, now),
  } satisfies RunProjection["observations"];
  const governessValue = sources["governess-state"].value;
  const governessState =
    governessValue && typeof governessValue === "object"
      ? (governessValue as Record<string, unknown>).state
      : undefined;
  const conflicts =
    typeof governessState === "string" &&
    LIFECYCLE_STATES.has(governessState) &&
    governessState !== manifest.state
      ? ["lifecycle-state-mismatch"]
      : [];
  const publicSources = Object.fromEntries(
    SOURCE_KINDS.map((kind) => {
      const source = sources[kind];
      return [
        kind,
        {
          freshness: classifyFreshness(kind, source.recordedAt, now),
          quality: source.status,
          ...(source.revision ? { revision: source.revision } : {}),
        },
      ];
    })
  ) as RunProjection["sources"];
  return {
    kind: "run",
    run: {
      repoId: locator.repoId,
      runId: locator.runId,
      ...(adapter ? { adapter } : {}),
      aggregate: {
        matrixVersion: 1,
        status:
          conflicts.length > 0
            ? "conflict"
            : aggregateStatus(requirements, observations),
      },
      ...(config ? { config } : {}),
      conflicts,
      lifecycle: {
        ...(typeof manifest.state === "string"
          ? { state: manifest.state }
          : {}),
        ...(typeof manifest.status === "string"
          ? { status: manifest.status }
          : {}),
        ...(typeof manifest.updatedAt === "string"
          ? { updatedAt: manifest.updatedAt }
          : {}),
      },
      observations,
      requirements,
      sources: publicSources,
    },
  };
};

export const projectRun = (
  locator: RunLocator,
  capabilities: ReadModelCapabilities
): RunProjectionResult => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = capabilities.readSources(locator);
    const after = capabilities.readSources(locator);
    if (revisionVector(before) === revisionVector(after)) {
      return buildProjection(locator, after, capabilities.now());
    }
  }
  return {
    conflicts: ["source-revisions-changed"],
    kind: "unstable",
    repoId: locator.repoId,
    runId: locator.runId,
  };
};

export const projectFleet = (
  capabilities: ReadModelCapabilities
): { runs: RunProjection[] } => ({
  runs: capabilities
    .listRuns()
    .slice()
    .sort(
      (left, right) =>
        left.repoId.localeCompare(right.repoId) ||
        left.runId.localeCompare(right.runId)
    )
    .map((locator) => projectRun(locator, capabilities))
    .filter(
      (result): result is Extract<RunProjectionResult, { kind: "run" }> =>
        result.kind === "run"
    )
    .map((result) => result.run),
});
