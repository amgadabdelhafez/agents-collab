export const SOURCE_KINDS = [
  "manifest",
  "transcript",
  "hooks",
  "governess-state",
  "governess-control",
  "bridge",
  "utility",
  "usage",
  "adapter",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceStatus =
  | "available"
  | "missing"
  | "malformed"
  | "oversize"
  | "unavailable";
export type SourceFreshness = "fresh" | "stale" | "unknown";

export interface RunKey {
  repoId: string;
  runId: string;
}

export interface RunLocator extends RunKey {
  runDir: string;
  storageRoot: string;
}

export interface SourceSnapshot<T = unknown> {
  detail?: string;
  kind: SourceKind;
  observedAt: number;
  recordedAt?: number;
  revision?: string;
  status: SourceStatus;
  value?: T;
}

export type RunSourceSnapshots = Record<SourceKind, SourceSnapshot>;

export interface ReadModelCapabilities {
  listRuns: () => RunLocator[];
  now: () => number;
  readSources: (locator: RunLocator) => RunSourceSnapshots;
}

export interface PublicResolvedConfig {
  governess: boolean;
  pairedMode: boolean;
  proofConfigured: boolean;
  review?: "independent" | "none";
  reviewPlan?: "independent" | "none";
  tmux: boolean;
  version: 1;
  worktree: boolean;
}

export interface PublicAdapterIdentity {
  processBirthId: string;
  serverPid: number;
  version: 1;
}

export type Requirement = "required" | "not-required" | "unknown";
export type Observation =
  | "present"
  | "missing"
  | "malformed"
  | "stale"
  | "unknown";

export interface RunRequirements {
  adapterIdentity: Requirement;
  bridge: Requirement;
  governess: Requirement;
  transcript: Requirement;
}

export interface RunObservations {
  adapterIdentity: Observation;
  bridge: Observation;
  governess: Observation;
  transcript: Observation;
}

export type AggregateStatus =
  | "healthy"
  | "stale"
  | "partial"
  | "unknown"
  | "conflict";

export interface PublicSourceState {
  freshness: SourceFreshness;
  quality: SourceStatus;
  revision?: string;
}

export interface RunProjection extends RunKey {
  adapter?: PublicAdapterIdentity;
  aggregate: { matrixVersion: 1; status: AggregateStatus };
  config?: PublicResolvedConfig;
  conflicts: string[];
  lifecycle: { state?: string; status?: string; updatedAt?: string };
  observations: RunObservations;
  requirements: RunRequirements;
  sources: Record<SourceKind, PublicSourceState>;
}

export type RunProjectionResult =
  | { kind: "run"; run: RunProjection }
  | ({ kind: "rejected"; reason: "identity-mismatch" } & RunKey)
  | ({ kind: "unstable"; conflicts: ["source-revisions-changed"] } & RunKey);

export interface TimelineInput {
  at: string;
  locator?: string;
  message: string;
  source: SourceKind;
}

export interface TimelineItem {
  at: string;
  evidenceRef: string;
  message: string;
  source: SourceKind;
}
