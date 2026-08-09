export const AGENT_OPERATIONS_SCHEMA_VERSION = "agentops/v1" as const;
export const CLOUD_EVENTS_SPEC_VERSION = "1.0" as const;

declare const identifierBrand: unique symbol;

type Identifier<Name extends string> = string & {
  readonly [identifierBrand]: Name;
};

export type PortfolioId = Identifier<"PortfolioId">;
export type ProjectId = Identifier<"ProjectId">;
export type LaneId = Identifier<"LaneId">;
export type ShiftId = Identifier<"ShiftId">;
export type WorkItemId = Identifier<"WorkItemId">;
export type WorkflowExecutionId = Identifier<"WorkflowExecutionId">;
export type AssignmentId = Identifier<"AssignmentId">;
export type IncidentId = Identifier<"IncidentId">;
export type ArtifactId = Identifier<"ArtifactId">;
export type CommandId = Identifier<"CommandId">;
export type EventId = Identifier<"EventId">;

export type ContractRejectionCode =
  | "INVALID_FIELD"
  | "LANE_MISMATCH"
  | "MALFORMED_ID"
  | "MALFORMED_TIMESTAMP"
  | "MISSING_IDENTITY"
  | "PROJECT_MISMATCH"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNSUPPORTED_SPEC_VERSION";

export interface ContractRejection {
  readonly actual?: string;
  readonly code: ContractRejectionCode;
  readonly expected?: string;
  readonly message: string;
  readonly path: string;
}

export type ValidationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly rejections: readonly ContractRejection[] };

export interface Provenance {
  readonly producer: string;
  readonly recordedAt: string;
  readonly sha256?: string;
  readonly source: string;
}

interface ManagementRecordBase<Kind extends string, Id extends string> {
  readonly createdAt: string;
  readonly id: Id;
  readonly kind: Kind;
  readonly provenance: Provenance;
  readonly schemaVersion: typeof AGENT_OPERATIONS_SCHEMA_VERSION;
}

export interface PortfolioRecord
  extends ManagementRecordBase<"portfolio", PortfolioId> {
  readonly name: string;
}

export interface ProjectRecord
  extends ManagementRecordBase<"project", ProjectId> {
  readonly laneId: LaneId;
  readonly name: string;
  readonly portfolioId: PortfolioId;
}

export interface ShiftRecord extends ManagementRecordBase<"shift", ShiftId> {
  readonly endsAt: string;
  readonly laneId: LaneId;
  readonly projectId: ProjectId;
  readonly startsAt: string;
}

export interface WorkItemRecord
  extends ManagementRecordBase<"work-item", WorkItemId> {
  readonly acceptanceOutcome: string;
  readonly laneId: LaneId;
  readonly objective: string;
  readonly projectId: ProjectId;
}

export interface WorkflowExecutionRecord
  extends ManagementRecordBase<"workflow-execution", WorkflowExecutionId> {
  readonly laneId: LaneId;
  readonly projectId: ProjectId;
  readonly workItemId: WorkItemId;
}

export interface IncidentRecord
  extends ManagementRecordBase<"incident", IncidentId> {
  readonly laneId: LaneId;
  readonly projectId: ProjectId;
  readonly summary: string;
}

export interface AssignmentRecord
  extends ManagementRecordBase<"assignment", AssignmentId> {
  readonly assigneeId: string;
  readonly laneId: LaneId;
  readonly projectId: ProjectId;
  readonly roleId: string;
  readonly workflowExecutionId: WorkflowExecutionId;
  readonly workItemId: WorkItemId;
}

export interface ArtifactRecord
  extends ManagementRecordBase<"artifact", ArtifactId> {
  readonly laneId: LaneId;
  readonly projectId: ProjectId;
  readonly sha256: string;
  readonly uri: string;
}

export type ManagementRecord =
  | ArtifactRecord
  | AssignmentRecord
  | IncidentRecord
  | PortfolioRecord
  | ProjectRecord
  | ShiftRecord
  | WorkflowExecutionRecord
  | WorkItemRecord;

interface EnvelopeBase<
  Kind extends "command" | "event",
  Id extends string,
  Data,
> {
  readonly actor_id: string;
  readonly authority: string;
  readonly causation_id: string;
  readonly correlation_id: string;
  readonly data: Data;
  readonly datacontenttype: "application/json";
  readonly id: Id;
  readonly idempotency_key: string;
  readonly kind: Kind;
  readonly lane_id: LaneId;
  readonly project_id: ProjectId;
  readonly provenance: Provenance;
  readonly role_id: string;
  readonly schema_version: typeof AGENT_OPERATIONS_SCHEMA_VERSION;
  readonly shift_id?: ShiftId;
  readonly source: string;
  readonly specversion: typeof CLOUD_EVENTS_SPEC_VERSION;
  readonly subject: string;
  readonly time: string;
  readonly type: string;
  readonly workflow_id?: WorkflowExecutionId;
}

export type CommandRecord<Data = unknown> = EnvelopeBase<
  "command",
  CommandId,
  Data
>;

export type EventRecord<Data = unknown> = EnvelopeBase<"event", EventId, Data>;

export type ControlPlaneEnvelope<Data = unknown> =
  | CommandRecord<Data>
  | EventRecord<Data>;

export interface ValidationContext {
  readonly laneId?: string;
  readonly projectId?: string;
}

const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CALENDAR_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;
const SHA256_RE = /^[a-fA-F0-9]{64}$/;
const EVENT_TYPE_RE = /^[a-z0-9]+(?:[.-][a-z0-9-]+)*\.v[1-9]\d*$/;

const MANAGEMENT_KINDS = new Set([
  "artifact",
  "assignment",
  "incident",
  "portfolio",
  "project",
  "shift",
  "work-item",
  "workflow-execution",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const reject = (
  rejections: ContractRejection[],
  code: ContractRejectionCode,
  path: string,
  message: string,
  details: { actual?: string; expected?: string } = {}
): void => {
  rejections.push({ code, message, path, ...details });
};

const requireString = (
  record: Record<string, unknown>,
  field: string,
  rejections: ContractRejection[],
  code: ContractRejectionCode = "INVALID_FIELD",
  path = field
): string | undefined => {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    reject(rejections, code, path, `${path} must be a non-empty string`);
    return undefined;
  }
  return value;
};

const requireIdentifier = (
  record: Record<string, unknown>,
  field: string,
  rejections: ContractRejection[],
  path = field
): string | undefined => {
  const value = requireString(
    record,
    field,
    rejections,
    "MISSING_IDENTITY",
    path
  );
  if (value === undefined) {
    return undefined;
  }
  if (!STABLE_ID_RE.test(value)) {
    reject(rejections, "MALFORMED_ID", path, `${path} is not a stable ID`, {
      actual: value,
    });
    return undefined;
  }
  return value;
};

const isRealCalendarInstant = (value: string): boolean => {
  const match = CALENDAR_RE.exec(value);
  if (match === null) {
    return false;
  }
  const [, year, month, day, hour, minute, second] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
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
  if (monthNumber < 1 || monthNumber > daysInMonth.length) {
    return false;
  }
  const lastDay = daysInMonth[monthNumber - 1] ?? 0;
  return (
    dayNumber >= 1 &&
    dayNumber <= lastDay &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59
  );
};

const requireTimestamp = (
  record: Record<string, unknown>,
  field: string,
  rejections: ContractRejection[],
  path = field
): string | undefined => {
  const value = requireString(record, field, rejections, "INVALID_FIELD", path);
  if (value === undefined) {
    return undefined;
  }
  if (
    !(ISO_TIMESTAMP_RE.test(value) && isRealCalendarInstant(value)) ||
    Number.isNaN(Date.parse(value))
  ) {
    reject(
      rejections,
      "MALFORMED_TIMESTAMP",
      path,
      `${path} must be an ISO 8601 timestamp with a timezone`,
      { actual: value }
    );
    return undefined;
  }
  return value;
};

const validateSchemaVersion = (
  record: Record<string, unknown>,
  field: "schemaVersion" | "schema_version",
  rejections: ContractRejection[]
): void => {
  if (record[field] !== AGENT_OPERATIONS_SCHEMA_VERSION) {
    reject(
      rejections,
      "UNSUPPORTED_SCHEMA_VERSION",
      field,
      `${field} is not supported`,
      {
        actual: typeof record[field] === "string" ? record[field] : undefined,
        expected: AGENT_OPERATIONS_SCHEMA_VERSION,
      }
    );
  }
};

const validateProvenance = (
  value: unknown,
  rejections: ContractRejection[],
  path = "provenance"
): void => {
  if (!isRecord(value)) {
    reject(rejections, "INVALID_FIELD", path, `${path} must be an object`);
    return;
  }
  requireString(
    value,
    "producer",
    rejections,
    "INVALID_FIELD",
    `${path}.producer`
  );
  requireString(value, "source", rejections, "INVALID_FIELD", `${path}.source`);
  requireTimestamp(value, "recordedAt", rejections, `${path}.recordedAt`);
  if (
    value.sha256 !== undefined &&
    (typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256))
  ) {
    reject(
      rejections,
      "INVALID_FIELD",
      `${path}.sha256`,
      `${path}.sha256 must be a 64-character hexadecimal SHA-256`
    );
  }
};

const validateUri = (
  value: string | undefined,
  path: string,
  rejections: ContractRejection[]
): void => {
  if (value === undefined) {
    return;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol) {
      throw new Error("missing protocol");
    }
  } catch {
    reject(
      rejections,
      "INVALID_FIELD",
      path,
      `${path} must be an absolute URI`,
      {
        actual: value,
      }
    );
  }
};

const finish = <Value>(
  value: unknown,
  rejections: ContractRejection[]
): ValidationResult<Value> =>
  rejections.length > 0
    ? { ok: false, rejections }
    : { ok: true, value: value as Value };

export const validateManagementRecord = (
  input: unknown
): ValidationResult<ManagementRecord> => {
  const rejections: ContractRejection[] = [];
  if (!isRecord(input)) {
    reject(rejections, "INVALID_FIELD", "$", "record must be an object");
    return { ok: false, rejections };
  }

  validateSchemaVersion(input, "schemaVersion", rejections);
  const kind = requireString(input, "kind", rejections, "MISSING_IDENTITY");
  if (kind !== undefined && !MANAGEMENT_KINDS.has(kind)) {
    reject(rejections, "INVALID_FIELD", "kind", "kind is not supported", {
      actual: kind,
    });
  }
  requireIdentifier(input, "id", rejections);
  requireTimestamp(input, "createdAt", rejections);
  validateProvenance(input.provenance, rejections);

  switch (kind) {
    case "portfolio":
      requireString(input, "name", rejections);
      break;
    case "project":
      requireIdentifier(input, "portfolioId", rejections);
      requireIdentifier(input, "laneId", rejections);
      requireString(input, "name", rejections);
      break;
    case "shift":
      requireIdentifier(input, "projectId", rejections);
      requireIdentifier(input, "laneId", rejections);
      requireTimestamp(input, "startsAt", rejections);
      requireTimestamp(input, "endsAt", rejections);
      break;
    case "work-item":
      requireIdentifier(input, "projectId", rejections);
      requireIdentifier(input, "laneId", rejections);
      requireString(input, "objective", rejections);
      requireString(input, "acceptanceOutcome", rejections);
      break;
    case "workflow-execution":
      requireIdentifier(input, "projectId", rejections);
      requireIdentifier(input, "laneId", rejections);
      requireIdentifier(input, "workItemId", rejections);
      break;
    case "incident":
      requireIdentifier(input, "projectId", rejections);
      requireIdentifier(input, "laneId", rejections);
      requireString(input, "summary", rejections);
      break;
    case "assignment":
      requireIdentifier(input, "projectId", rejections);
      requireIdentifier(input, "laneId", rejections);
      requireIdentifier(input, "workItemId", rejections);
      requireIdentifier(input, "workflowExecutionId", rejections);
      requireIdentifier(input, "roleId", rejections);
      requireIdentifier(input, "assigneeId", rejections);
      break;
    case "artifact": {
      requireIdentifier(input, "projectId", rejections);
      requireIdentifier(input, "laneId", rejections);
      const uri = requireString(input, "uri", rejections);
      validateUri(uri, "uri", rejections);
      const sha256 = requireString(input, "sha256", rejections);
      if (sha256 !== undefined && !SHA256_RE.test(sha256)) {
        reject(
          rejections,
          "INVALID_FIELD",
          "sha256",
          "sha256 must be a 64-character hexadecimal SHA-256"
        );
      }
      break;
    }
    default:
      break;
  }

  return finish<ManagementRecord>(input, rejections);
};

const validateDeclaredContext = (
  context: ValidationContext,
  rejections: ContractRejection[]
): { laneId?: string; projectId?: string } => {
  const validated: { laneId?: string; projectId?: string } = {};
  for (const field of ["laneId", "projectId"] as const) {
    const value = context[field];
    if (value === undefined) {
      continue;
    }
    if (!STABLE_ID_RE.test(value)) {
      reject(
        rejections,
        "MALFORMED_ID",
        `context.${field}`,
        `context.${field} is not a stable ID`,
        { actual: value }
      );
      continue;
    }
    validated[field] = value;
  }
  return validated;
};

export const validateEnvelope = (
  input: unknown,
  context: ValidationContext = {}
): ValidationResult<ControlPlaneEnvelope> => {
  const rejections: ContractRejection[] = [];
  if (!isRecord(input)) {
    reject(rejections, "INVALID_FIELD", "$", "envelope must be an object");
    return { ok: false, rejections };
  }

  validateSchemaVersion(input, "schema_version", rejections);
  const kind = requireString(input, "kind", rejections, "MISSING_IDENTITY");
  if (kind !== undefined && kind !== "command" && kind !== "event") {
    reject(rejections, "INVALID_FIELD", "kind", "kind is not supported", {
      actual: kind,
    });
  }
  if (input.specversion !== CLOUD_EVENTS_SPEC_VERSION) {
    reject(
      rejections,
      "UNSUPPORTED_SPEC_VERSION",
      "specversion",
      "specversion is not supported",
      {
        actual:
          typeof input.specversion === "string" ? input.specversion : undefined,
        expected: CLOUD_EVENTS_SPEC_VERSION,
      }
    );
  }

  requireIdentifier(input, "id", rejections);
  const source = requireString(input, "source", rejections);
  validateUri(source, "source", rejections);
  const eventType = requireString(input, "type", rejections);
  if (eventType !== undefined && !EVENT_TYPE_RE.test(eventType)) {
    reject(
      rejections,
      "INVALID_FIELD",
      "type",
      "type must be a versioned reverse-DNS event type",
      { actual: eventType }
    );
  }
  requireString(input, "subject", rejections);
  requireTimestamp(input, "time", rejections);
  if (input.datacontenttype !== "application/json") {
    reject(
      rejections,
      "INVALID_FIELD",
      "datacontenttype",
      "datacontenttype must be application/json",
      {
        actual:
          typeof input.datacontenttype === "string"
            ? input.datacontenttype
            : undefined,
        expected: "application/json",
      }
    );
  }

  const projectId = requireIdentifier(input, "project_id", rejections);
  const laneId = requireIdentifier(input, "lane_id", rejections);
  if (input.shift_id !== undefined) {
    requireIdentifier(input, "shift_id", rejections);
  }
  if (input.workflow_id !== undefined) {
    requireIdentifier(input, "workflow_id", rejections);
  }
  requireIdentifier(input, "actor_id", rejections);
  requireIdentifier(input, "role_id", rejections);
  requireString(input, "authority", rejections);
  requireIdentifier(input, "correlation_id", rejections);
  requireIdentifier(input, "causation_id", rejections);
  requireString(input, "idempotency_key", rejections);
  validateProvenance(input.provenance, rejections);
  if (!("data" in input)) {
    reject(rejections, "INVALID_FIELD", "data", "data field is required");
  }

  const declared = validateDeclaredContext(context, rejections);
  if (
    declared.projectId !== undefined &&
    projectId !== undefined &&
    declared.projectId !== projectId
  ) {
    reject(
      rejections,
      "PROJECT_MISMATCH",
      "project_id",
      "project_id does not match declared project",
      { actual: projectId, expected: declared.projectId }
    );
  }
  if (
    declared.laneId !== undefined &&
    laneId !== undefined &&
    declared.laneId !== laneId
  ) {
    reject(
      rejections,
      "LANE_MISMATCH",
      "lane_id",
      "lane_id does not match declared lane",
      { actual: laneId, expected: declared.laneId }
    );
  }

  return finish<ControlPlaneEnvelope>(input, rejections);
};
