import { SUPERVISOR_ID_RE } from "./supervisor-id";
import type {
  SupervisorMessagePhase,
  SupervisorMessageProjection,
} from "./supervisor-message-workflow";

export type SupervisorMessageAction =
  SupervisorMessageProjection["actionRequired"];

export interface SupervisorMessageBoardItem {
  acknowledgedAt: null | string;
  actionRequired: SupervisorMessageAction;
  artifactRefs: string[];
  claimedAt: null | string;
  claimedBy: null | string;
  deadLetteredAt: null | string;
  deliveredAt: null | string;
  deliveryAttempts: number;
  escalatedAt: null | string;
  from: string;
  messageId: string;
  nextRetryAt: null | string;
  phase: SupervisorMessagePhase;
  receivedAt: string;
  schema: "supervisor-message-board-item.v1";
  threadId: string;
  to: string;
  workflowId: string;
}

export interface SupervisorMessageBoardProjection {
  items: SupervisorMessageBoardItem[];
  revision: number;
  schema: "supervisor-message-board.v1";
}

export interface SupervisorMessageAttentionProjection {
  items: SupervisorMessageBoardItem[];
  revision: number;
  schema: "supervisor-message-attention.v1";
}

export interface SupervisorMessageReadModelSnapshot {
  attention: SupervisorMessageAttentionProjection;
  board: SupervisorMessageBoardProjection;
}

export class SupervisorMessageReadModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorMessageReadModelError";
  }
}

const PROJECTION_KEYS = [
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
] as const;

const BOARD_ITEM_KEYS = [...PROJECTION_KEYS, "workflowId"] as const;

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

const ARTIFACT_REF_RE = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const ACTION_RE = /^(acknowledge|claim|dead-letter|none|retry)$/;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PHASE_RE =
  /^(acknowledged|canceled|claimed|dead-lettered|escalated|retry-scheduled|routed)$/;
const STABLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
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
    throw new SupervisorMessageReadModelError(`${field} is invalid`);
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
    throw new SupervisorMessageReadModelError(`${field} is invalid`);
  }
  return instant;
};

const requireOptionalInstant = (
  value: unknown,
  field: string
): null | string => (value === null ? null : requireInstant(value, field));

const requireProjection = (value: unknown): SupervisorMessageProjection => {
  if (!isRecord(value)) {
    throw new SupervisorMessageReadModelError("projection must be an object");
  }
  if (!hasExactKeys(value, PROJECTION_KEYS)) {
    throw new SupervisorMessageReadModelError(
      "projection fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-status.v1") {
    throw new SupervisorMessageReadModelError("projection schema is invalid");
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
  if (actionRequired !== ACTION_FOR_PHASE[phase]) {
    throw new SupervisorMessageReadModelError(
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
    throw new SupervisorMessageReadModelError("artifactRefs are invalid");
  }
  if (
    !Number.isSafeInteger(value.deliveryAttempts) ||
    Number(value.deliveryAttempts) < 0
  ) {
    throw new SupervisorMessageReadModelError("deliveryAttempts is invalid");
  }
  const claimedBy =
    value.claimedBy === null
      ? null
      : requireString(value.claimedBy, "claimedBy", SUPERVISOR_ID_RE);
  return {
    acknowledgedAt: requireOptionalInstant(
      value.acknowledgedAt,
      "acknowledgedAt"
    ),
    actionRequired,
    artifactRefs: [...value.artifactRefs],
    claimedAt: requireOptionalInstant(value.claimedAt, "claimedAt"),
    claimedBy,
    deadLetteredAt: requireOptionalInstant(
      value.deadLetteredAt,
      "deadLetteredAt"
    ),
    deliveredAt: requireOptionalInstant(value.deliveredAt, "deliveredAt"),
    deliveryAttempts: Number(value.deliveryAttempts),
    escalatedAt: requireOptionalInstant(value.escalatedAt, "escalatedAt"),
    from: requireString(value.from, "from", SUPERVISOR_ID_RE),
    messageId: requireString(value.messageId, "messageId", STABLE_ID_RE),
    nextRetryAt: requireOptionalInstant(value.nextRetryAt, "nextRetryAt"),
    phase,
    receivedAt: requireInstant(value.receivedAt, "receivedAt"),
    schema: "supervisor-message-status.v1",
    threadId: requireString(value.threadId, "threadId", STABLE_ID_RE),
    to: requireString(value.to, "to", SUPERVISOR_ID_RE),
  };
};

export const parseSupervisorMessageBoardItem = (
  value: unknown
): SupervisorMessageBoardItem => {
  if (!(isRecord(value) && hasExactKeys(value, BOARD_ITEM_KEYS))) {
    throw new SupervisorMessageReadModelError(
      "board item fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-message-board-item.v1") {
    throw new SupervisorMessageReadModelError("board item schema is invalid");
  }
  const workflowId = requireString(
    value.workflowId,
    "workflowId",
    WORKFLOW_ID_RE
  );
  const projection = requireProjection({
    acknowledgedAt: value.acknowledgedAt,
    actionRequired: value.actionRequired,
    artifactRefs: value.artifactRefs,
    claimedAt: value.claimedAt,
    claimedBy: value.claimedBy,
    deadLetteredAt: value.deadLetteredAt,
    deliveredAt: value.deliveredAt,
    deliveryAttempts: value.deliveryAttempts,
    escalatedAt: value.escalatedAt,
    from: value.from,
    messageId: value.messageId,
    nextRetryAt: value.nextRetryAt,
    phase: value.phase,
    receivedAt: value.receivedAt,
    schema: "supervisor-message-status.v1",
    threadId: value.threadId,
    to: value.to,
  });
  return {
    ...projection,
    schema: "supervisor-message-board-item.v1",
    workflowId,
  };
};

const cloneItem = (
  item: SupervisorMessageBoardItem
): SupervisorMessageBoardItem => ({
  ...item,
  artifactRefs: [...item.artifactRefs],
});

const compareItems = (
  left: SupervisorMessageBoardItem,
  right: SupervisorMessageBoardItem
): number =>
  right.receivedAt.localeCompare(left.receivedAt) ||
  left.workflowId.localeCompare(right.workflowId);

export class SupervisorMessageReadModel {
  readonly #items = new Map<string, SupervisorMessageBoardItem>();
  #revision = 0;

  attention(): SupervisorMessageAttentionProjection {
    return {
      items: this.#sortedItems()
        .filter((item) => item.actionRequired !== "none")
        .map(cloneItem),
      revision: this.#revision,
      schema: "supervisor-message-attention.v1",
    };
  }

  board(): SupervisorMessageBoardProjection {
    return {
      items: this.#sortedItems().map(cloneItem),
      revision: this.#revision,
      schema: "supervisor-message-board.v1",
    };
  }

  remove(workflowId: string): SupervisorMessageReadModelSnapshot {
    requireString(workflowId, "workflowId", WORKFLOW_ID_RE);
    if (this.#items.delete(workflowId)) {
      this.#revision += 1;
    }
    return this.snapshot();
  }

  snapshot(): SupervisorMessageReadModelSnapshot {
    return { attention: this.attention(), board: this.board() };
  }

  upsert(
    workflowIdValue: string,
    projectionValue: unknown
  ): SupervisorMessageReadModelSnapshot {
    const workflowId = requireString(
      workflowIdValue,
      "workflowId",
      WORKFLOW_ID_RE
    );
    const projection = requireProjection(projectionValue);
    const item: SupervisorMessageBoardItem = {
      ...projection,
      schema: "supervisor-message-board-item.v1",
      workflowId,
    };
    const previous = this.#items.get(workflowId);
    if (JSON.stringify(previous) !== JSON.stringify(item)) {
      this.#items.set(workflowId, item);
      this.#revision += 1;
    }
    return this.snapshot();
  }

  #sortedItems(): SupervisorMessageBoardItem[] {
    return [...this.#items.values()].sort(compareItems);
  }
}
