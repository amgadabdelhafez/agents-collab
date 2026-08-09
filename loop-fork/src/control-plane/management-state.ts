import type { ShiftId, WorkItemId } from "./contracts";

export const DEFAULT_PORTFOLIO_TIMEZONE = "America/Los_Angeles" as const;
export const SHIFT_BOUNDARY_HOURS = [0, 8, 16] as const;

export type WorkItemState =
  | "draft"
  | "ready"
  | "admitted"
  | "in-progress"
  | "blocked"
  | "review"
  | "completed"
  | "cancelled";
export type AssignmentState =
  | "proposed"
  | "accepted"
  | "active"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";
export type IncidentState =
  | "detected"
  | "triaged"
  | "mitigating"
  | "monitoring"
  | "resolved";
export type ReviewState =
  | "requested"
  | "in-review"
  | "passed"
  | "changes-requested"
  | "rejected"
  | "cancelled";
export type ReleaseState =
  | "candidate"
  | "approved"
  | "released"
  | "withdrawn"
  | "rolled-back";

export type ManagementAggregateKind =
  | "work-item"
  | "assignment"
  | "incident"
  | "review"
  | "release";

export type Priority = "P0" | "P1" | "P2" | "P3" | "P4";
export type IncidentSeverity = "SEV0" | "SEV1" | "SEV2" | "SEV3";

export const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

export const SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = {
  SEV0: 0,
  SEV1: 1,
  SEV2: 2,
  SEV3: 3,
};

export type ManagementStateRejectionCode =
  | "ACKNOWLEDGER_NOT_REQUIRED"
  | "ALREADY_ACKNOWLEDGED"
  | "APPROVAL_REQUIRED"
  | "DEPENDENCY_BLOCKED"
  | "ILLEGAL_TRANSITION"
  | "INVALID_HANDOFF"
  | "INVALID_POLICY"
  | "INVALID_TIMESTAMP"
  | "INVALID_TIMEZONE"
  | "POLICY_REQUIRED"
  | "WIP_LIMIT_REACHED";

export interface ManagementStateRejection {
  readonly actual?: string;
  readonly code: ManagementStateRejectionCode;
  readonly expected?: string;
  readonly message: string;
  readonly path: string;
}

export type ManagementStateResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly rejections: readonly ManagementStateRejection[];
    };

export interface DependencySnapshot {
  readonly state: WorkItemState;
  readonly workItemId: WorkItemId;
}

export interface WipSnapshot {
  readonly activeWorkItemIds: readonly WorkItemId[];
  readonly limit: number;
}

export interface TransitionRequest {
  readonly aggregate: ManagementAggregateKind;
  readonly approvalDecisionId?: string;
  readonly dependencies?: readonly DependencySnapshot[];
  readonly from: string;
  readonly to: string;
  readonly wip?: WipSnapshot;
  readonly workItemId?: WorkItemId;
}

export interface TransitionEvaluationContext {
  readonly approvalResolver?: ApprovalResolver;
}

export interface ApprovalDecision {
  readonly actorId: string;
  readonly authority: "approve-release";
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly evidenceSha256: string;
  readonly outcome: "approved";
}

export interface ApprovalResolver {
  readonly resolveApprovalDecision: (decisionId: string) => unknown;
}

export interface AcceptedTransition {
  readonly aggregate: ManagementAggregateKind;
  readonly from: string;
  readonly to: string;
}

const TRANSITIONS: Readonly<
  Record<ManagementAggregateKind, Readonly<Record<string, readonly string[]>>>
> = {
  "work-item": {
    admitted: ["in-progress", "cancelled"],
    blocked: ["in-progress", "cancelled"],
    cancelled: [],
    completed: [],
    draft: ["ready", "cancelled"],
    "in-progress": ["blocked", "review", "cancelled"],
    ready: ["admitted", "cancelled"],
    review: ["completed", "in-progress", "cancelled"],
  },
  assignment: {
    accepted: ["active", "cancelled"],
    active: ["completed", "failed", "cancelled"],
    cancelled: [],
    completed: [],
    failed: [],
    proposed: ["accepted", "rejected", "cancelled"],
    rejected: [],
  },
  incident: {
    detected: ["triaged"],
    mitigating: ["monitoring", "resolved"],
    monitoring: ["mitigating", "resolved"],
    resolved: ["triaged"],
    triaged: ["mitigating", "resolved"],
  },
  review: {
    cancelled: [],
    "changes-requested": ["in-review", "cancelled"],
    "in-review": ["passed", "changes-requested", "rejected", "cancelled"],
    passed: [],
    rejected: [],
    requested: ["in-review", "cancelled"],
  },
  release: {
    approved: ["released", "withdrawn"],
    candidate: ["approved", "withdrawn"],
    released: ["rolled-back"],
    "rolled-back": [],
    withdrawn: [],
  },
};

const WORK_ITEM_STATES = new Set<unknown>(
  Object.keys(TRANSITIONS["work-item"])
);
const AGGREGATE_KINDS = new Set<unknown>(Object.keys(TRANSITIONS));
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$/;
const SHA256_RE = /^[a-fA-F0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rejection = (
  code: ManagementStateRejectionCode,
  path: string,
  message: string,
  details: { actual?: string; expected?: string } = {}
): ManagementStateRejection => ({ code, path, message, ...details });

const checkApproval = (
  request: TransitionRequest,
  context: TransitionEvaluationContext
): readonly ManagementStateRejection[] => {
  const required =
    request.aggregate === "release" &&
    request.from === "candidate" &&
    request.to === "approved";
  if (!required) {
    return [];
  }
  if (
    typeof request.approvalDecisionId !== "string" ||
    !STABLE_ID_RE.test(request.approvalDecisionId) ||
    context.approvalResolver === undefined
  ) {
    return [
      rejection(
        "APPROVAL_REQUIRED",
        "approvalDecisionId",
        "release approval requires a trusted policy approval resolver",
        { actual: request.approvalDecisionId }
      ),
    ];
  }
  let resolved: unknown;
  try {
    resolved = context.approvalResolver.resolveApprovalDecision(
      request.approvalDecisionId
    );
  } catch {
    return [
      rejection(
        "APPROVAL_REQUIRED",
        "approvalDecisionId",
        "trusted policy approval resolution failed"
      ),
    ];
  }
  if (
    !isRecord(resolved) ||
    resolved.decisionId !== request.approvalDecisionId ||
    typeof resolved.actorId !== "string" ||
    !STABLE_ID_RE.test(resolved.actorId) ||
    resolved.authority !== "approve-release" ||
    resolved.outcome !== "approved" ||
    typeof resolved.decidedAt !== "string" ||
    instantMillis(resolved.decidedAt) === undefined ||
    typeof resolved.evidenceSha256 !== "string" ||
    !SHA256_RE.test(resolved.evidenceSha256)
  ) {
    return [
      rejection(
        "APPROVAL_REQUIRED",
        "approvalDecisionId",
        "resolved approval decision is invalid or lacks release authority",
        { actual: request.approvalDecisionId }
      ),
    ];
  }
  return [];
};

const checkDependencies = (
  request: TransitionRequest
): readonly ManagementStateRejection[] => {
  const required =
    request.aggregate === "work-item" &&
    (request.to === "ready" || request.to === "admitted");
  if (!required) {
    return [];
  }
  if (!Array.isArray(request.dependencies)) {
    return [
      rejection(
        "POLICY_REQUIRED",
        "dependencies",
        "dependency state is required before readiness or admission"
      ),
    ];
  }
  return request.dependencies.flatMap((dependency, index) => {
    if (
      typeof dependency !== "object" ||
      dependency === null ||
      typeof dependency.workItemId !== "string" ||
      !STABLE_ID_RE.test(dependency.workItemId) ||
      !WORK_ITEM_STATES.has(dependency.state)
    ) {
      return [
        rejection(
          "INVALID_POLICY",
          `dependencies[${index}]`,
          "dependency must contain a stable workItemId and known state"
        ),
      ];
    }
    return dependency.state === "completed"
      ? []
      : [
          rejection(
            "DEPENDENCY_BLOCKED",
            `dependencies[${index}].state`,
            `dependency ${dependency.workItemId} is not completed`,
            { actual: dependency.state, expected: "completed" }
          ),
        ];
  });
};

const checkWip = (
  request: TransitionRequest
): readonly ManagementStateRejection[] => {
  const required =
    request.aggregate === "work-item" &&
    request.from === "ready" &&
    request.to === "admitted";
  if (!required) {
    return [];
  }
  if (
    typeof request.wip !== "object" ||
    request.wip === null ||
    request.workItemId === undefined
  ) {
    return [
      rejection(
        "POLICY_REQUIRED",
        request.wip === undefined ? "wip" : "workItemId",
        "WIP state and work-item identity are required for admission"
      ),
    ];
  }
  if (
    !Number.isInteger(request.wip.limit) ||
    request.wip.limit < 1 ||
    !STABLE_ID_RE.test(request.workItemId) ||
    !Array.isArray(request.wip.activeWorkItemIds) ||
    request.wip.activeWorkItemIds.some(
      (id) => typeof id !== "string" || !STABLE_ID_RE.test(id)
    ) ||
    new Set(request.wip.activeWorkItemIds).size !==
      request.wip.activeWorkItemIds.length
  ) {
    return [
      rejection(
        "INVALID_POLICY",
        "wip.limit",
        "WIP policy requires a positive integer limit and unique work-item IDs",
        { actual: String(request.wip.limit) }
      ),
    ];
  }
  const alreadyActive = request.wip.activeWorkItemIds.includes(
    request.workItemId
  );
  if (
    !alreadyActive &&
    request.wip.activeWorkItemIds.length >= request.wip.limit
  ) {
    return [
      rejection(
        "WIP_LIMIT_REACHED",
        "wip.activeWorkItemIds",
        "work item cannot be admitted while the WIP limit is full",
        {
          actual: String(request.wip.activeWorkItemIds.length),
          expected: `< ${request.wip.limit}`,
        }
      ),
    ];
  }
  return [];
};

export const evaluateTransition = (
  input: unknown,
  context: TransitionEvaluationContext = {}
): ManagementStateResult<AcceptedTransition> => {
  if (
    !(isRecord(input) && AGGREGATE_KINDS.has(input.aggregate)) ||
    typeof input.from !== "string" ||
    typeof input.to !== "string"
  ) {
    return {
      ok: false,
      rejections: [
        rejection(
          "ILLEGAL_TRANSITION",
          "$",
          "transition requires a known aggregate and string from/to states"
        ),
      ],
    };
  }
  const request = input as unknown as TransitionRequest;
  const allowed = TRANSITIONS[request.aggregate][request.from];
  if (allowed === undefined || !allowed.includes(request.to)) {
    return {
      ok: false,
      rejections: [
        rejection(
          "ILLEGAL_TRANSITION",
          "to",
          `${request.aggregate} cannot transition from ${request.from} to ${request.to}`,
          { actual: request.to, expected: allowed?.join("|") ?? "known state" }
        ),
      ],
    };
  }

  const policyRejections = [
    ...checkApproval(request, context),
    ...checkDependencies(request),
    ...checkWip(request),
  ];
  if (policyRejections.length > 0) {
    return { ok: false, rejections: policyRejections };
  }

  return {
    ok: true,
    value: {
      aggregate: request.aggregate,
      from: request.from,
      to: request.to,
    },
  };
};

export interface DeadlinePolicy {
  readonly dueAt: string;
  readonly escalateAt: string;
  readonly warnAt: string;
}

export type DeadlineState =
  | "scheduled"
  | "warning"
  | "escalated"
  | "due"
  | "overdue";

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CALENDAR_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

const isRealCalendarInstant = (value: string): boolean => {
  const match = CALENDAR_RE.exec(value);
  if (match === null) {
    return false;
  }
  const [, year, month, day, hour, minute, second] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const leapYear =
    yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const lastDay = daysInMonth[monthNumber - 1] ?? 0;
  return (
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= lastDay &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59
  );
};

const instantMillis = (value: string): number | undefined => {
  if (!(ISO_INSTANT_RE.test(value) && isRealCalendarInstant(value))) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

export const evaluateDeadline = (
  now: string,
  policy: DeadlinePolicy
): ManagementStateResult<DeadlineState> => {
  const values = {
    now: instantMillis(now),
    warnAt: instantMillis(policy.warnAt),
    escalateAt: instantMillis(policy.escalateAt),
    dueAt: instantMillis(policy.dueAt),
  };
  const invalid = Object.entries(values).find(
    ([, value]) => value === undefined
  );
  if (invalid !== undefined) {
    return {
      ok: false,
      rejections: [
        rejection(
          "INVALID_TIMESTAMP",
          invalid[0],
          `${invalid[0]} must be an ISO 8601 timestamp with a timezone`
        ),
      ],
    };
  }
  const {
    now: nowMs,
    warnAt,
    escalateAt,
    dueAt,
  } = values as Record<keyof typeof values, number>;
  if (!(warnAt <= escalateAt && escalateAt <= dueAt)) {
    return {
      ok: false,
      rejections: [
        rejection(
          "INVALID_POLICY",
          "deadline",
          "deadline timestamps must satisfy warnAt <= escalateAt <= dueAt"
        ),
      ],
    };
  }
  if (nowMs > dueAt) {
    return { ok: true, value: "overdue" };
  }
  if (nowMs === dueAt) {
    return { ok: true, value: "due" };
  }
  if (nowMs >= escalateAt) {
    return { ok: true, value: "escalated" };
  }
  if (nowMs >= warnAt) {
    return { ok: true, value: "warning" };
  }
  return { ok: true, value: "scheduled" };
};

interface LocalParts {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly second: number;
  readonly year: number;
}

const formatterFor = (timezone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-GB", {
    calendar: "iso8601",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    numberingSystem: "latn",
    second: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });

const localPartsAt = (
  epochMillis: number,
  formatter: Intl.DateTimeFormat
): LocalParts => {
  const fields = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochMillis))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    day: fields.day ?? 0,
    hour: fields.hour ?? 0,
    minute: fields.minute ?? 0,
    month: fields.month ?? 0,
    second: fields.second ?? 0,
    year: fields.year ?? 0,
  };
};

const localKey = (parts: LocalParts): number =>
  ((((parts.year * 13 + parts.month) * 32 + parts.day) * 24 + parts.hour) * 60 +
    parts.minute) *
    60 +
  parts.second;

const resolveLocalBoundary = (
  target: LocalParts,
  formatter: Intl.DateTimeFormat
): {
  readonly disambiguation: "exact" | "earlier-fold" | "shifted-forward";
  readonly epoch: number;
} => {
  const naive = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second
  );
  const exact: number[] = [];
  let firstAfter: { epoch: number; key: number } | undefined;
  const targetKey = localKey(target);
  for (
    let epoch = naive - 18 * 60 * 60_000;
    epoch <= naive + 18 * 60 * 60_000;
    epoch += 60_000
  ) {
    const parts = localPartsAt(epoch, formatter);
    const key = localKey(parts);
    if (key === targetKey) {
      exact.push(epoch);
    } else if (
      parts.year === target.year &&
      parts.month === target.month &&
      parts.day === target.day &&
      key > targetKey &&
      (firstAfter === undefined ||
        key < firstAfter.key ||
        (key === firstAfter.key && epoch < firstAfter.epoch))
    ) {
      firstAfter = { epoch, key };
    }
  }
  if (exact.length > 0) {
    return {
      disambiguation: exact.length > 1 ? "earlier-fold" : "exact",
      epoch: Math.min(...exact),
    };
  }
  if (firstAfter !== undefined) {
    return { disambiguation: "shifted-forward", epoch: firstAfter.epoch };
  }
  throw new Error("local boundary could not be resolved");
};

const addLocalHours = (parts: LocalParts, hours: number): LocalParts => {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour + hours)
  );
  return {
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: 0,
    month: date.getUTCMonth() + 1,
    second: 0,
    year: date.getUTCFullYear(),
  };
};

const pad = (value: number): string => String(value).padStart(2, "0");
const localLabel = (parts: LocalParts, timezone: string): string =>
  `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}[${timezone}]`;

export interface ShiftWindow {
  readonly boundaryHour: (typeof SHIFT_BOUNDARY_HOURS)[number];
  readonly endDisambiguation: "exact" | "earlier-fold" | "shifted-forward";
  readonly endsAt: string;
  readonly endsAtLocal: string;
  readonly requestedEndsAtLocal: string;
  readonly requestedStartsAtLocal: string;
  readonly startDisambiguation: "exact" | "earlier-fold" | "shifted-forward";
  readonly startsAt: string;
  readonly startsAtLocal: string;
  readonly timezone: string;
}

export const resolveShiftWindow = (
  instant: string,
  timezone: string = DEFAULT_PORTFOLIO_TIMEZONE
): ManagementStateResult<ShiftWindow> => {
  const epoch = instantMillis(instant);
  if (epoch === undefined) {
    return {
      ok: false,
      rejections: [
        rejection(
          "INVALID_TIMESTAMP",
          "instant",
          "instant must be an ISO 8601 timestamp with a timezone",
          { actual: instant }
        ),
      ],
    };
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = formatterFor(timezone);
    formatter.format(new Date(epoch));
  } catch {
    return {
      ok: false,
      rejections: [
        rejection(
          "INVALID_TIMEZONE",
          "timezone",
          "timezone must be a supported IANA timezone",
          { actual: timezone }
        ),
      ],
    };
  }
  const current = localPartsAt(epoch, formatter);
  let boundaryHour: (typeof SHIFT_BOUNDARY_HOURS)[number] = 0;
  if (current.hour >= 16) {
    boundaryHour = 16;
  } else if (current.hour >= 8) {
    boundaryHour = 8;
  }
  const startLocal: LocalParts = {
    ...current,
    hour: boundaryHour,
    minute: 0,
    second: 0,
  };
  const endLocal = addLocalHours(startLocal, 8);
  try {
    const start = resolveLocalBoundary(startLocal, formatter);
    const end = resolveLocalBoundary(endLocal, formatter);
    const resolvedStartLocal = localPartsAt(start.epoch, formatter);
    const resolvedEndLocal = localPartsAt(end.epoch, formatter);
    return {
      ok: true,
      value: {
        boundaryHour,
        endDisambiguation: end.disambiguation,
        endsAt: new Date(end.epoch).toISOString(),
        endsAtLocal: localLabel(resolvedEndLocal, timezone),
        requestedEndsAtLocal: localLabel(endLocal, timezone),
        requestedStartsAtLocal: localLabel(startLocal, timezone),
        startDisambiguation: start.disambiguation,
        startsAt: new Date(start.epoch).toISOString(),
        startsAtLocal: localLabel(resolvedStartLocal, timezone),
        timezone,
      },
    };
  } catch {
    return {
      ok: false,
      rejections: [
        rejection(
          "INVALID_TIMEZONE",
          "timezone",
          "timezone could not resolve the configured local shift boundary",
          { actual: timezone }
        ),
      ],
    };
  }
};

export interface ShiftRetrospective {
  readonly failures: readonly string[];
  readonly improvements: readonly string[];
  readonly outcomes: readonly string[];
}

export interface HandoffAcknowledgement {
  readonly acknowledgedAt: string;
  readonly actorId: string;
}

export interface ShiftHandoffRecord {
  readonly acknowledgements: readonly HandoffAcknowledgement[];
  readonly fromShiftId: ShiftId;
  readonly openWorkItemIds: readonly WorkItemId[];
  readonly preparedAt: string;
  readonly requiredAcknowledgers: readonly string[];
  readonly retrospective: ShiftRetrospective;
  readonly risks: readonly string[];
  readonly status: "draft" | "ready" | "acknowledged";
  readonly summary: string;
  readonly toShiftId: ShiftId;
  readonly workerContinuity: "preserve";
}

const STABLE_ACTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$/;
const HANDOFF_STATUSES = new Set(["draft", "ready", "acknowledged"]);
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const hasHandoffShape = (input: unknown): input is ShiftHandoffRecord => {
  if (!(isRecord(input) && isRecord(input.retrospective))) {
    return false;
  }
  return (
    typeof input.fromShiftId === "string" &&
    typeof input.toShiftId === "string" &&
    typeof input.preparedAt === "string" &&
    typeof input.summary === "string" &&
    typeof input.status === "string" &&
    typeof input.workerContinuity === "string" &&
    isStringArray(input.openWorkItemIds) &&
    isStringArray(input.requiredAcknowledgers) &&
    isStringArray(input.risks) &&
    isStringArray(input.retrospective.failures) &&
    isStringArray(input.retrospective.improvements) &&
    isStringArray(input.retrospective.outcomes) &&
    Array.isArray(input.acknowledgements) &&
    input.acknowledgements.every(
      (item) =>
        isRecord(item) &&
        typeof item.actorId === "string" &&
        typeof item.acknowledgedAt === "string"
    )
  );
};

const validateHandoffHeader = (
  handoff: ShiftHandoffRecord
): readonly ManagementStateRejection[] => {
  const rejections: ManagementStateRejection[] = [];
  for (const field of ["fromShiftId", "toShiftId"] as const) {
    if (!STABLE_ID_RE.test(handoff[field])) {
      rejections.push(
        rejection(
          "INVALID_HANDOFF",
          field,
          `${field} must be a stable shift ID`,
          { actual: handoff[field] }
        )
      );
    }
  }
  if (handoff.fromShiftId === handoff.toShiftId) {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "toShiftId",
        "handoff destination must differ from its source shift"
      )
    );
  }
  if (instantMillis(handoff.preparedAt) === undefined) {
    rejections.push(
      rejection(
        "INVALID_TIMESTAMP",
        "preparedAt",
        "preparedAt must be an ISO 8601 timestamp with a timezone"
      )
    );
  }
  if (!HANDOFF_STATUSES.has(handoff.status)) {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "status",
        "handoff status must be draft, ready, or acknowledged",
        { actual: handoff.status }
      )
    );
  }
  if (handoff.summary.trim().length === 0) {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "summary",
        "handoff summary must be non-empty"
      )
    );
  }
  for (const [index, workItemId] of handoff.openWorkItemIds.entries()) {
    if (!STABLE_ID_RE.test(workItemId)) {
      rejections.push(
        rejection(
          "INVALID_HANDOFF",
          `openWorkItemIds[${index}]`,
          "open work item must be a stable work-item ID",
          { actual: workItemId }
        )
      );
    }
  }
  if (
    new Set(handoff.openWorkItemIds).size !== handoff.openWorkItemIds.length
  ) {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "openWorkItemIds",
        "open work-item IDs must be unique"
      )
    );
  }
  if (handoff.requiredAcknowledgers.length === 0) {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "requiredAcknowledgers",
        "handoff requires at least one acknowledger"
      )
    );
  }
  if (handoff.workerContinuity !== "preserve") {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "workerContinuity",
        "shift handoff must preserve worker process continuity",
        { actual: handoff.workerContinuity, expected: "preserve" }
      )
    );
  }
  return rejections;
};

const validateRequiredAcknowledgers = (
  handoff: ShiftHandoffRecord
): readonly ManagementStateRejection[] => {
  const rejections: ManagementStateRejection[] = [];
  const required = new Set(handoff.requiredAcknowledgers);
  if (required.size !== handoff.requiredAcknowledgers.length) {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "requiredAcknowledgers",
        "required acknowledgers must be unique"
      )
    );
  }
  for (const [index, actorId] of handoff.requiredAcknowledgers.entries()) {
    if (!STABLE_ACTOR_ID_RE.test(actorId)) {
      rejections.push(
        rejection(
          "INVALID_HANDOFF",
          `requiredAcknowledgers[${index}]`,
          "required acknowledger must be a stable actor ID",
          { actual: actorId }
        )
      );
    }
  }
  return rejections;
};

const validateAcknowledgements = (
  handoff: ShiftHandoffRecord
): readonly ManagementStateRejection[] => {
  const rejections: ManagementStateRejection[] = [];
  const required = new Set(handoff.requiredAcknowledgers);
  const acknowledged = new Set<string>();
  const preparedAt = instantMillis(handoff.preparedAt);
  for (const [index, acknowledgement] of handoff.acknowledgements.entries()) {
    if (!STABLE_ACTOR_ID_RE.test(acknowledgement.actorId)) {
      rejections.push(
        rejection(
          "INVALID_HANDOFF",
          `acknowledgements[${index}].actorId`,
          "acknowledger must be a stable actor ID",
          { actual: acknowledgement.actorId }
        )
      );
    }
    if (!required.has(acknowledgement.actorId)) {
      rejections.push(
        rejection(
          "ACKNOWLEDGER_NOT_REQUIRED",
          `acknowledgements[${index}].actorId`,
          "acknowledger is not required for this handoff",
          { actual: acknowledgement.actorId }
        )
      );
    }
    if (acknowledged.has(acknowledgement.actorId)) {
      rejections.push(
        rejection(
          "ALREADY_ACKNOWLEDGED",
          `acknowledgements[${index}].actorId`,
          "acknowledger may acknowledge only once",
          { actual: acknowledgement.actorId }
        )
      );
    }
    acknowledged.add(acknowledgement.actorId);
    const acknowledgedAt = instantMillis(acknowledgement.acknowledgedAt);
    if (acknowledgedAt === undefined) {
      rejections.push(
        rejection(
          "INVALID_TIMESTAMP",
          `acknowledgements[${index}].acknowledgedAt`,
          "acknowledgedAt must be an ISO 8601 timestamp with a timezone"
        )
      );
    } else if (preparedAt !== undefined && acknowledgedAt < preparedAt) {
      rejections.push(
        rejection(
          "INVALID_HANDOFF",
          `acknowledgements[${index}].acknowledgedAt`,
          "acknowledgement cannot precede handoff preparation"
        )
      );
    }
  }
  return rejections;
};

const validateHandoffStatus = (
  handoff: ShiftHandoffRecord
): readonly ManagementStateRejection[] => {
  const required = new Set(handoff.requiredAcknowledgers);
  const acknowledged = new Set(
    handoff.acknowledgements.map((item) => item.actorId)
  );
  const rejections: ManagementStateRejection[] = [];
  const allAcknowledged = [...required].every((actor) =>
    acknowledged.has(actor)
  );
  if (handoff.status === "acknowledged" && !allAcknowledged) {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "status",
        "handoff cannot be acknowledged before every required acknowledgement"
      )
    );
  }
  if (handoff.status !== "acknowledged" && allAcknowledged) {
    rejections.push(
      rejection(
        "INVALID_HANDOFF",
        "status",
        "handoff with every required acknowledgement must be acknowledged"
      )
    );
  }
  return rejections;
};

export const validateShiftHandoff = (
  input: unknown
): ManagementStateResult<ShiftHandoffRecord> => {
  if (!hasHandoffShape(input)) {
    return {
      ok: false,
      rejections: [
        rejection(
          "INVALID_HANDOFF",
          "$",
          "handoff must contain the complete typed handoff structure"
        ),
      ],
    };
  }
  const rejections = [
    ...validateHandoffHeader(input),
    ...validateRequiredAcknowledgers(input),
    ...validateAcknowledgements(input),
    ...validateHandoffStatus(input),
  ];
  return rejections.length > 0
    ? { ok: false, rejections }
    : { ok: true, value: input };
};

export const acknowledgeShiftHandoff = (
  handoff: unknown,
  actorId: string,
  acknowledgedAt: string
): ManagementStateResult<ShiftHandoffRecord> => {
  const current = validateShiftHandoff(handoff);
  if (!current.ok) {
    return current;
  }
  const validated = current.value;
  if (!validated.requiredAcknowledgers.includes(actorId)) {
    return {
      ok: false,
      rejections: [
        rejection(
          "ACKNOWLEDGER_NOT_REQUIRED",
          "actorId",
          "actor is not required for this handoff",
          { actual: actorId }
        ),
      ],
    };
  }
  if (validated.acknowledgements.some((item) => item.actorId === actorId)) {
    return {
      ok: false,
      rejections: [
        rejection(
          "ALREADY_ACKNOWLEDGED",
          "actorId",
          "actor has already acknowledged this handoff",
          { actual: actorId }
        ),
      ],
    };
  }
  if (instantMillis(acknowledgedAt) === undefined) {
    return {
      ok: false,
      rejections: [
        rejection(
          "INVALID_TIMESTAMP",
          "acknowledgedAt",
          "acknowledgedAt must be an ISO 8601 timestamp with a timezone"
        ),
      ],
    };
  }
  const acknowledgements = [
    ...validated.acknowledgements,
    { acknowledgedAt, actorId },
  ];
  const acknowledgedActors = new Set(
    acknowledgements.map((item) => item.actorId)
  );
  const status = validated.requiredAcknowledgers.every((actor) =>
    acknowledgedActors.has(actor)
  )
    ? "acknowledged"
    : "ready";
  const updated: ShiftHandoffRecord = {
    ...validated,
    acknowledgements,
    status,
  };
  return validateShiftHandoff(updated);
};
