import type {
  SupervisorMessageAction,
  SupervisorMessageBoardItem,
  SupervisorMessageBoardProjection,
} from "./supervisor-message-read-model";
import type { SupervisorMessagePhase } from "./supervisor-message-workflow";
import { readSupervisorThreadArtifacts } from "./supervisor-thread-artifact-read-model";
import type {
  JsonlSupervisorThreadStore,
  SupervisorThreadMessageKind,
} from "./supervisor-thread-store";

export interface SupervisorKnowledgeArtifactBacklink {
  actionRequired: SupervisorMessageAction;
  from: string;
  messageId: string;
  phase: SupervisorMessagePhase;
  receivedAt: string;
  threadId: string;
  to: string;
  workflowId: string;
}

export interface SupervisorKnowledgeArtifactEntry {
  artifactRef: string;
  backlinks: SupervisorKnowledgeArtifactBacklink[];
  referenceCount: number;
  schema: "supervisor-knowledge-artifact.v1";
}

export interface SupervisorKnowledgeArtifactProjection {
  artifacts: SupervisorKnowledgeArtifactEntry[];
  schema: "supervisor-knowledge-artifacts.v1";
  sourceRevision: number;
}

export interface DurableSupervisorKnowledgeArtifactBacklink
  extends SupervisorKnowledgeArtifactBacklink {
  messageKind: SupervisorThreadMessageKind;
}

export interface DurableSupervisorKnowledgeArtifactEntry {
  artifactRef: string;
  backlinks: DurableSupervisorKnowledgeArtifactBacklink[];
  referenceCount: number;
  schema: "supervisor-knowledge-artifact.v2";
}

export interface DurableSupervisorKnowledgeArtifactProjection {
  artifacts: DurableSupervisorKnowledgeArtifactEntry[];
  schema: "supervisor-knowledge-artifacts.v2";
  sourceRevision: number;
}

export class SupervisorKnowledgeArtifactReadModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorKnowledgeArtifactReadModelError";
  }
}

const BOARD_KEYS = ["items", "revision", "schema"] as const;
const ITEM_KEYS = [
  "acknowledgedAt",
  "actionRequired",
  "artifactRefs",
  "claimedAt",
  "claimedBy",
  "deadLetteredAt",
  "deliveredAt",
  "deliveryAttempts",
  "escalatedAt",
  "from",
  "messageId",
  "nextRetryAt",
  "phase",
  "receivedAt",
  "schema",
  "threadId",
  "to",
  "workflowId",
] as const;

const ACTION_FOR_PHASE: Readonly<
  Record<SupervisorMessagePhase, SupervisorMessageAction>
> = {
  acknowledged: "none",
  canceled: "none",
  claimed: "acknowledge",
  "dead-lettered": "dead-letter",
  escalated: "claim",
  "retry-scheduled": "retry",
  routed: "claim",
};

const ACTION_RE = /^(acknowledge|claim|dead-letter|none|retry)$/;
const ARTIFACT_REF_RE = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PHASE_RE =
  /^(acknowledged|canceled|claimed|dead-lettered|escalated|retry-scheduled|routed)$/;
const STABLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const SUPERVISOR_ID_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;
const WORKFLOW_ID_RE = /^supervisor-message:[a-f0-9]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedValue: readonly string[]
): boolean => {
  const keys = Object.keys(value).sort();
  const expected = [...expectedValue].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

const requireString = (
  value: unknown,
  field: string,
  pattern: RegExp
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new SupervisorKnowledgeArtifactReadModelError(`${field} is invalid`);
  }
  return value;
};

const requireInstant = (value: unknown, field: string): string => {
  const instant = requireString(value, field, CANONICAL_UTC_RE);
  const timestamp = Date.parse(instant);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== instant
  ) {
    throw new SupervisorKnowledgeArtifactReadModelError(`${field} is invalid`);
  }
  return instant;
};

const requireOptionalInstant = (value: unknown, field: string): void => {
  if (value !== null) {
    requireInstant(value, field);
  }
};

const requireBoardItem = (value: unknown): SupervisorMessageBoardItem => {
  if (!(isRecord(value) && hasExactKeys(value, ITEM_KEYS))) {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "board item fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-board-item.v1") {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "board item schema is invalid"
    );
  }
  const phase = requireString(
    value.phase,
    "phase",
    PHASE_RE
  ) as SupervisorMessagePhase;
  const actionRequired = requireString(
    value.actionRequired,
    "actionRequired",
    ACTION_RE
  ) as SupervisorMessageAction;
  if (ACTION_FOR_PHASE[phase] !== actionRequired) {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "actionRequired conflicts with phase"
    );
  }
  if (
    !Array.isArray(value.artifactRefs) ||
    value.artifactRefs.length > 32 ||
    value.artifactRefs.some(
      (reference) =>
        typeof reference !== "string" || !ARTIFACT_REF_RE.test(reference)
    ) ||
    new Set(value.artifactRefs).size !== value.artifactRefs.length
  ) {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "artifactRefs are invalid"
    );
  }
  if (
    !Number.isSafeInteger(value.deliveryAttempts) ||
    Number(value.deliveryAttempts) < 0
  ) {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "deliveryAttempts is invalid"
    );
  }
  requireOptionalInstant(value.acknowledgedAt, "acknowledgedAt");
  requireOptionalInstant(value.claimedAt, "claimedAt");
  requireOptionalInstant(value.deadLetteredAt, "deadLetteredAt");
  requireOptionalInstant(value.deliveredAt, "deliveredAt");
  requireOptionalInstant(value.escalatedAt, "escalatedAt");
  requireOptionalInstant(value.nextRetryAt, "nextRetryAt");
  if (value.claimedBy !== null) {
    requireString(value.claimedBy, "claimedBy", SUPERVISOR_ID_RE);
  }
  requireString(value.from, "from", SUPERVISOR_ID_RE);
  requireString(value.messageId, "messageId", STABLE_ID_RE);
  requireInstant(value.receivedAt, "receivedAt");
  requireString(value.threadId, "threadId", STABLE_ID_RE);
  requireString(value.to, "to", SUPERVISOR_ID_RE);
  requireString(value.workflowId, "workflowId", WORKFLOW_ID_RE);
  return value as unknown as SupervisorMessageBoardItem;
};

const requireBoard = (value: unknown): SupervisorMessageBoardProjection => {
  if (!(isRecord(value) && hasExactKeys(value, BOARD_KEYS))) {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "board fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-board.v1") {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "board schema is invalid"
    );
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "board revision is invalid"
    );
  }
  if (!Array.isArray(value.items)) {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "board items must be an array"
    );
  }
  const items = value.items.map(requireBoardItem);
  const workflowIds = items.map((item) => item.workflowId);
  if (new Set(workflowIds).size !== workflowIds.length) {
    throw new SupervisorKnowledgeArtifactReadModelError(
      "board workflow IDs must be unique"
    );
  }
  return {
    items,
    revision: Number(value.revision),
    schema: "supervisor-message-board.v1",
  };
};

const compareBacklinks = (
  left: SupervisorKnowledgeArtifactBacklink,
  right: SupervisorKnowledgeArtifactBacklink
): number =>
  right.receivedAt.localeCompare(left.receivedAt) ||
  left.workflowId.localeCompare(right.workflowId);

/** @deprecated Compatibility-only projection for pre-durable in-memory boards. */
export const projectSupervisorKnowledgeArtifacts = (
  boardValue: unknown
): SupervisorKnowledgeArtifactProjection => {
  const board = requireBoard(boardValue);
  const grouped = new Map<string, SupervisorKnowledgeArtifactBacklink[]>();
  for (const item of board.items) {
    const backlink: SupervisorKnowledgeArtifactBacklink = {
      actionRequired: item.actionRequired,
      from: item.from,
      messageId: item.messageId,
      phase: item.phase,
      receivedAt: item.receivedAt,
      threadId: item.threadId,
      to: item.to,
      workflowId: item.workflowId,
    };
    for (const artifactRef of item.artifactRefs) {
      const current = grouped.get(artifactRef) ?? [];
      current.push({ ...backlink });
      grouped.set(artifactRef, current);
    }
  }
  return {
    artifacts: [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([artifactRef, backlinks]) => ({
        artifactRef,
        backlinks: backlinks.sort(compareBacklinks),
        referenceCount: backlinks.length,
        schema: "supervisor-knowledge-artifact.v1",
      })),
    schema: "supervisor-knowledge-artifacts.v1",
    sourceRevision: board.revision,
  };
};

export const readSupervisorKnowledgeArtifacts = (
  store: JsonlSupervisorThreadStore
): DurableSupervisorKnowledgeArtifactProjection => {
  const durableArtifacts = readSupervisorThreadArtifacts(store);
  return {
    artifacts: durableArtifacts.artifacts.map((artifact) => ({
      artifactRef: artifact.artifactRef,
      backlinks: artifact.backlinks.map((backlink) => ({ ...backlink })),
      referenceCount: artifact.referenceCount,
      schema: "supervisor-knowledge-artifact.v2",
    })),
    schema: "supervisor-knowledge-artifacts.v2",
    sourceRevision: durableArtifacts.sourceRevision,
  };
};
