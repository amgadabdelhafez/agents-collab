/** Public, read-only DTO contract used by the fixture-backed Web UI. */
export const WEBUI_DTO_VERSION = "1" as const;

export type WebUiDtoVersion = typeof WEBUI_DTO_VERSION;
export type IsoTimestamp = string;
export type OpaqueEvidenceId = `ev_${string}`;

export type RunLifecycle =
  | "submitted"
  | "working"
  | "reviewing"
  | "input-required"
  | "completed"
  | "failed"
  | "stopped";

export type FleetGroupKey =
  | "needs-attention"
  | "cleanup-debt"
  | "active"
  | "finished";

export type QualitySeverity =
  | "healthy"
  | "partial"
  | "stale"
  | "conflict"
  | "corrupt";

export type SourceState =
  | "current"
  | "stale"
  | "missing"
  | "conflict"
  | "corrupt"
  | "disabled"
  | "not-applicable";

export type ConnectionState =
  | "live"
  | "behind"
  | "reconnecting"
  | "paused"
  | "offline";

export type AgentLifecycle =
  | "starting"
  | "working"
  | "waiting-human"
  | "waiting-peer"
  | "reviewing"
  | "limited"
  | "stuck"
  | "crashed"
  | "finished";

export type AgentRole = "driver" | "reviewer";
export type WorkerTier = "direct" | "nanny" | "au-pair";
export type WorkerState = "queued" | "active" | "completed" | "failed";
export type ReasonSeverity = "critical" | "high" | "medium" | "low";

export type RunReasonCode =
  | "input-required"
  | "failed-control"
  | "stale-authority"
  | "corrupt-evidence"
  | "identity-conflict"
  | "surviving-adapter"
  | "active-looking-manifest"
  | "stream-behind"
  | "audit-partial";

export interface ProvenanceDTO {
  readonly note?: string;
  readonly observedAt: IsoTimestamp;
  readonly revision: string;
  readonly sourceId: string;
  readonly sourceKind:
    | "manifest"
    | "hook-journal"
    | "governess-journal"
    | "bridge-journal"
    | "worker-journal"
    | "usage-snapshot"
    | "adapter-probe"
    | "fixture";
  readonly state: SourceState;
}

export interface QualityDTO {
  readonly label: string;
  readonly severity: QualitySeverity;
  readonly sources: readonly ProvenanceDTO[];
  readonly summary: string;
}

export interface ConnectionDTO {
  readonly label: string;
  readonly lastEventAt: IsoTimestamp;
  readonly lastObservedAt: IsoTimestamp;
  readonly queuedUpdates: number;
  readonly state: ConnectionState;
  readonly streamEpoch: string;
  readonly streamSequence: number;
}

export interface FixtureSourceDTO {
  readonly generatedAt: IsoTimestamp;
  readonly kind: "synthetic-redacted";
  readonly notice: string;
  readonly scenario: string;
}

export interface RunReasonDTO {
  readonly code: RunReasonCode;
  readonly detail: string;
  readonly label: string;
  readonly severity: ReasonSeverity;
}

export interface AdapterSummaryDTO {
  readonly kind: "tmux" | "native";
  readonly label: string;
  readonly lastProbedAt: IsoTimestamp;
  readonly state: "healthy" | "unknown" | "mismatch" | "surviving" | "ended";
}

export interface FleetAgentSummaryDTO {
  readonly displayName: string;
  readonly id: string;
  readonly lifecycle: AgentLifecycle;
  readonly role: AgentRole;
}

export interface FleetRunDTO {
  readonly adapters: readonly AdapterSummaryDTO[];
  readonly agents: readonly FleetAgentSummaryDTO[];
  readonly connection: ConnectionDTO;
  readonly driver: string;
  readonly fixtureSource: FixtureSourceDTO;
  readonly lastDurableEventAt: IsoTimestamp;
  readonly lifecycle: RunLifecycle;
  readonly quality: QualityDTO;
  readonly reasons: readonly RunReasonDTO[];
  readonly repoId: string;
  readonly repository: string;
  readonly reviewer: string;
  readonly runId: string;
  readonly startedAt: IsoTimestamp;
  readonly title: string;
  readonly version: WebUiDtoVersion;
  readonly worktree: string;
}

export interface UsageWindowDTO {
  readonly kind: "session" | "weekly";
  readonly provenance: ProvenanceDTO;
  readonly resetAt?: IsoTimestamp;
  readonly resetState: "known" | "unknown" | "stale";
  readonly usedPercent: number;
}

export interface AgentUsageDTO {
  readonly cachedTokens: number;
  readonly compactions: number;
  readonly contextPercent: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly windows: readonly UsageWindowDTO[];
}

export interface BridgeMessageSummaryDTO {
  readonly at: IsoTimestamp;
  readonly direction: "sent" | "received";
  readonly status: "delivered" | "pending" | "failed";
  readonly summary: string;
}

export interface AgentSeatDTO {
  readonly currentTask: string;
  readonly displayName: string;
  readonly id: string;
  readonly lastHookAt: IsoTimestamp;
  readonly lastHookEvent: string;
  readonly latestBridgeMessage?: BridgeMessageSummaryDTO;
  readonly lifecycle: AgentLifecycle;
  readonly model: string;
  readonly provenance: readonly ProvenanceDTO[];
  readonly provider: string;
  readonly reasoningEffort: string;
  readonly role: AgentRole;
  readonly taskObservedAt: IsoTimestamp;
  readonly taskSource: string;
  readonly toolsInFlight: number;
  readonly usage: AgentUsageDTO;
}

export interface GovernessFactDTO {
  readonly label: string;
  readonly provenance: ProvenanceDTO;
  readonly status: "ok" | "warning" | "error" | "neutral";
  readonly value: string;
}

export interface GovernessInterpretationDTO {
  readonly confidence: number;
  readonly generatedAt: IsoTimestamp;
  readonly kind: "progress" | "next" | "waiting-human" | "judge";
  readonly source: string;
  readonly summary: string;
}

export interface GovernessPolicyDTO {
  readonly disposition: "allowed" | "blocked" | "confirmation-bound";
  readonly reason: string;
  readonly releaseLabel: "Read-only release";
  readonly title: string;
}

export interface GovernessAuditDTO {
  readonly acknowledgement: string;
  readonly at: IsoTimestamp;
  readonly controlId: string;
  readonly evidenceId: OpaqueEvidenceId;
  readonly phase: string;
  readonly transport: string;
}

export interface GovernessDTO {
  readonly audit: readonly GovernessAuditDTO[];
  readonly driverLease: string;
  readonly epoch: string;
  readonly facts: readonly GovernessFactDTO[];
  readonly interpretations: readonly GovernessInterpretationDTO[];
  readonly policies: readonly GovernessPolicyDTO[];
}

export interface WorkerCountDTO {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly queued: number;
}

export interface WorkerActivityDTO {
  readonly artifactEvidenceIds: readonly OpaqueEvidenceId[];
  readonly contextCapsule: string;
  readonly costUsd: number;
  readonly finishedAt?: IsoTimestamp;
  readonly id: string;
  readonly modelCalls: number;
  readonly requestSummary: string;
  readonly resultSummary: string;
  readonly routingReason: string;
  readonly startedAt: IsoTimestamp;
  readonly state: WorkerState;
  readonly tier: WorkerTier;
  readonly tokens: number;
  readonly toolSummary: string;
}

export interface WorkerTierDTO {
  readonly activity: readonly WorkerActivityDTO[];
  readonly counts: WorkerCountDTO;
  readonly description: string;
  readonly label: string;
  readonly tier: WorkerTier;
}

export interface TimelineEventDTO {
  readonly actor: string;
  readonly at: IsoTimestamp;
  readonly category:
    | "lifecycle"
    | "agent"
    | "bridge"
    | "governess"
    | "worker"
    | "evidence"
    | "adapter";
  readonly detail: string;
  readonly evidenceIds: readonly OpaqueEvidenceId[];
  readonly id: string;
  readonly provenance: ProvenanceDTO;
  readonly sequence: number;
  readonly title: string;
  readonly tone: "neutral" | "info" | "success" | "warning" | "danger";
}

export interface EvidenceItemDTO {
  readonly byteCount: number;
  readonly capturedAt: IsoTimestamp;
  readonly id: OpaqueEvidenceId;
  readonly kind: "log" | "test" | "review" | "control" | "artifact";
  readonly mimeType: "text/plain" | "application/json";
  readonly provenance: ProvenanceDTO;
  readonly redactionsApplied: number;
  readonly summary: string;
  readonly title: string;
}

export interface RunAuthorityDTO {
  readonly currentDriver: string;
  readonly epoch: string;
  readonly leaseState: "current" | "stale" | "conflict";
  readonly repoId: string;
  readonly runId: string;
}

export interface RunDetailDTO {
  readonly agents: readonly AgentSeatDTO[];
  readonly authority: RunAuthorityDTO;
  readonly connection: ConnectionDTO;
  readonly evidence: readonly EvidenceItemDTO[];
  readonly fixtureSource: FixtureSourceDTO;
  readonly governess: GovernessDTO;
  readonly quality: QualityDTO;
  readonly summary: FleetRunDTO;
  readonly timeline: readonly TimelineEventDTO[];
  readonly version: WebUiDtoVersion;
  readonly workers: readonly WorkerTierDTO[];
}

export interface FleetSnapshotDTO {
  readonly connection: ConnectionDTO;
  readonly fixtureSource: FixtureSourceDTO;
  readonly observedAt: IsoTimestamp;
  readonly quality: QualityDTO;
  readonly runs: readonly FleetRunDTO[];
  readonly version: WebUiDtoVersion;
}

export interface FleetFilterOptions {
  readonly group?: FleetGroupKey | readonly FleetGroupKey[];
  readonly lifecycle?: RunLifecycle | readonly RunLifecycle[];
  readonly query?: string;
  readonly repository?: string | readonly string[];
}

export interface FleetRunGroupDTO {
  readonly key: FleetGroupKey;
  readonly label: string;
  readonly runs: readonly FleetRunDTO[];
}
