import { SQL } from "bun";
import {
  decideSupervisorEndpointLeaseClaim,
  decideSupervisorEndpointLeaseFence,
  isSupervisorEndpointKind,
  parseSupervisorEndpointLocator,
  requireSupervisorEndpointHolderRef,
  requireSupervisorEndpointLeaseFence,
  requireSupervisorEndpointLeaseTtlMs,
  requireSupervisorEndpointRecipient,
  requireSupervisorEndpointSessionRef,
  resolveSupervisorEndpointLease,
  SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA,
  type SupervisorEndpointKind,
  type SupervisorEndpointLeaseClaimInput,
  type SupervisorEndpointLeaseClaimResult,
  SupervisorEndpointLeaseError,
  type SupervisorEndpointLeaseFence,
  type SupervisorEndpointLeaseFenceRefusal,
  type SupervisorEndpointLeaseReleaseInput,
  type SupervisorEndpointLeaseReleaseResult,
  type SupervisorEndpointLeaseRenewInput,
  type SupervisorEndpointLeaseRenewResult,
  type SupervisorEndpointLeaseResolution,
  type SupervisorEndpointLeaseStore,
  type SupervisorEndpointLeaseStoreDeps,
  type SupervisorEndpointLeaseV2,
  type SupervisorEndpointLocator,
  type SupervisorEndpointLocatorResolver,
  supervisorEndpointDescriptorIdentity,
  supervisorEndpointLeaseExpiresAt,
  supervisorEndpointLeaseHolderSummary,
  supervisorEndpointLocatorDigest,
  supervisorEndpointLocatorRefused,
} from "./supervisor-endpoint-lease";
import {
  parseTrustedSupervisorMessageV2Scope,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import { SupervisorMessageV2ReadinessUnavailableError } from "./supervisor-message-v2-runtime";
import { supervisorMessageV2ScopedDigest } from "./supervisor-message-v2-workflow-identity";

/**
 * Current provider-session state is control-plane data, not a Loop manifest
 * field.  It is deliberately body-free and route scoped so a recreated pod
 * can resume delivery without reading a workspace, a tmux target, or an agent
 * transcript.
 */
export const SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA =
  "supervisor-session-descriptor.v2" as const;
export const SUPERVISOR_SESSION_READINESS_RECEIPT_V2_SCHEMA =
  "supervisor-session-readiness-receipt.v2" as const;
export const SUPERVISOR_SESSION_REBIND_RECEIPT_V2_SCHEMA =
  "supervisor-session-rebind-receipt.v2" as const;
/**
 * Default freshness window for a readiness receipt. A passive status read
 * never re-probes the provider, so readiness is only as current as the last
 * successful `assertReady`; past this age a dependent gate reads not-ready.
 */
export const SUPERVISOR_SESSION_READINESS_MAX_AGE_MS = 60_000;
/**
 * How far in the future a readiness receipt's `checkedAt` may sit and still
 * count as fresh. Hosts sharing the store can disagree slightly about the
 * time; beyond this a future-dated receipt is not evidence of readiness.
 */
export const SUPERVISOR_SESSION_READINESS_CLOCK_SKEW_MS = 5000;

/**
 * Receipt retention for one seat (one descriptor). Every renewal writes a
 * rebind receipt, and readiness receipts are keyed by revision, so both tables
 * grow with each renewal for as long as a seat lives. A receipt is kept while
 * it is among the seat's latest `keepLatest` or younger than
 * `keepNewerThanMs`, both by its row's `created_at` (database clock); anything
 * else is pruned in the same transaction as the seat's next rebind. There is
 * no separate scheduler: rows are only ever added by a rebind, or by a probe
 * of the revision a rebind wrote, so pruning on rebind bounds both tables.
 *
 * Ranking reads only typed columns, never `receipt_json`, so a stored receipt
 * of any shape (one written out of band included) cannot fail a renewal; it
 * ages out like any other. Within one descriptor lifetime write order is
 * revision order. A rebind that rewrites a receipt id left by an earlier
 * lifetime of a re-registered descriptor resets that row's `created_at`, so
 * the earlier lifetime's leftovers rank below the receipts it just wrote.
 *
 * Existing rows are not migrated: a seat's backlog is pruned by that seat's
 * first rebind after upgrade. Receipts of a seat that is never rebound again
 * (a removed seat) are left as they are.
 */
export interface SupervisorSessionReceiptRetentionV2 {
  keepLatest: number;
  keepNewerThanMs: number;
}
export const SUPERVISOR_SESSION_RECEIPT_RETENTION_DEFAULT: SupervisorSessionReceiptRetentionV2 =
  Object.freeze({ keepLatest: 16, keepNewerThanMs: 7 * 24 * 60 * 60 * 1000 });
/**
 * The longest accepted `keepNewerThanMs`: 100 years of 365 days. A "keep
 * forever" value past this (such as Number.MAX_SAFE_INTEGER, ~285,000 years)
 * would put the window's start before the earliest timestamp the database can
 * hold, and every renewal would fail on it.
 */
export const SUPERVISOR_SESSION_RECEIPT_RETENTION_MAX_WINDOW_MS =
  100 * 365 * 24 * 60 * 60 * 1000;

export type SupervisorSessionProviderV2 =
  | "claude-code"
  | "codex-app-server"
  | "controlled-test";

export interface SupervisorSessionDescriptorV2 {
  descriptorId: string;
  endpointDigest: string;
  endpointRef: string;
  expiresAt: string;
  issuedAt: string;
  principal: string;
  provider: SupervisorSessionProviderV2;
  recipient: string;
  revision: number;
  schema: typeof SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA;
  sessionRef: string;
  tenantId: string;
}

/** A read-model-safe proof. It intentionally has no provider endpoint or body. */
export interface SupervisorSessionReadinessReceiptV2 {
  checkedAt: string;
  descriptorId: string;
  descriptorRevision: number;
  principal: string;
  provider: SupervisorSessionProviderV2;
  receiptId: string;
  recipient: string;
  schema: typeof SUPERVISOR_SESSION_READINESS_RECEIPT_V2_SCHEMA;
  status: "ready";
  tenantId: string;
}

export interface SupervisorSessionRebindReceiptV2 {
  authorityRef: string;
  descriptorId: string;
  fromRevision: number;
  principal: string;
  reasonCode: string;
  receiptId: string;
  recipient: string;
  schema: typeof SUPERVISOR_SESSION_REBIND_RECEIPT_V2_SCHEMA;
  tenantId: string;
  toRevision: number;
}

/** A body-free current-session status suitable for a dependent DAG gate. */
export interface SupervisorSessionDescriptorStatusV2 {
  descriptorId: string;
  principal: string;
  provider: SupervisorSessionProviderV2;
  readinessReceiptId: null | string;
  ready: boolean;
  recipient: string;
  revision: number;
  schema: "supervisor-session-status.v2";
  tenantId: string;
}

export interface SupervisorSessionProviderReadinessV2 {
  descriptorId: string;
  endpointDigest: string;
  provider: SupervisorSessionProviderV2;
  revision: number;
  sessionRef: string;
  status: "ready";
}

/**
 * This is a controlled provider probe seam. A real adapter must verify its
 * own current session before returning the echoed immutable identity. The
 * V2 store never wakes a provider and never receives provider credentials.
 */
export interface SupervisorSessionProviderReadinessPort {
  ready(
    descriptor: SupervisorSessionDescriptorV2
  ):
    | Promise<SupervisorSessionProviderReadinessV2>
    | SupervisorSessionProviderReadinessV2;
}

/** Reuses the already-authenticated tenant/principal boundary; no identity ledger is created. */
export interface SupervisorSessionRebindAuthorityPort {
  decide(input: {
    current: SupervisorSessionDescriptorV2;
    next: SupervisorSessionDescriptorV2;
    trustedScope: TrustedSupervisorMessageV2Scope;
  }):
    | Promise<{ allowed: boolean; authorityRef: string; reasonCode: string }>
    | { allowed: boolean; authorityRef: string; reasonCode: string };
}

export class SupervisorSessionV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorSessionV2Error";
  }
}

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ENDPOINT_DIGEST_RE = /^[a-f0-9]{64}$/;
const ENDPOINT_REF_RE = /^endpoint:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROVIDER_RE = /^(claude-code|codex-app-server|controlled-test)$/;
const RECEIPT_ID_RE =
  /^supervisor-session-(?:readiness|rebind):v2:[a-f0-9]{64}$/;
const RECIPIENT_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const SESSION_DESCRIPTOR_ID_RE =
  /^supervisor-session-descriptor:v2:[a-f0-9]{64}$/;
const SESSION_REF_RE = /^session:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : entry
  );

const requireCanonicalUtc = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !CANONICAL_UTC_RE.test(value)) {
    throw new SupervisorSessionV2Error(`${field} is invalid`);
  }
  if (new Date(value).toISOString() !== value) {
    throw new SupervisorSessionV2Error(`${field} is invalid`);
  }
  return value;
};

/**
 * Rejection handler for one readiness-path store operation. A refusal this
 * store decides (SupervisorSessionV2Error) passes through unchanged; any other
 * failure means the store could not answer, so the delivery boundary must not
 * count it as an unready seat. The original error is dropped: driver errors
 * can carry connection detail that must not reach workflow state or logs.
 */
const rethrowReadinessStoreFailure = (error: unknown): never => {
  if (error instanceof SupervisorSessionV2Error) {
    throw error;
  }
  throw new SupervisorMessageV2ReadinessUnavailableError();
};

const requireReadinessMaxAgeMs = (value: unknown): number => {
  if (value === undefined) {
    return SUPERVISOR_SESSION_READINESS_MAX_AGE_MS;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new SupervisorSessionV2Error("readinessMaxAgeMs is invalid");
  }
  return Number(value);
};

const requireReceiptRetention = (
  value: unknown
): SupervisorSessionReceiptRetentionV2 => {
  if (value === undefined) {
    return SUPERVISOR_SESSION_RECEIPT_RETENTION_DEFAULT;
  }
  const record = value as
    | Partial<SupervisorSessionReceiptRetentionV2>
    | null
    | undefined;
  const keepLatest = record?.keepLatest;
  const keepNewerThanMs = record?.keepNewerThanMs;
  if (
    !(
      Number.isSafeInteger(keepLatest) &&
      Number(keepLatest) >= 1 &&
      Number.isSafeInteger(keepNewerThanMs) &&
      Number(keepNewerThanMs) >= 0 &&
      Number(keepNewerThanMs) <=
        SUPERVISOR_SESSION_RECEIPT_RETENTION_MAX_WINDOW_MS
    )
  ) {
    throw new SupervisorSessionV2Error("receiptRetention is invalid");
  }
  return {
    keepLatest: Number(keepLatest),
    keepNewerThanMs: Number(keepNewerThanMs),
  };
};

/**
 * The provider-session identity a readiness probe vouches for. Two revisions
 * of one descriptor that agree on all of it differ only by a renewal
 * (revision, issuedAt, expiresAt), so a probe of one is evidence for the other.
 * Both callers compare two revisions of one descriptor (same scope, recipient
 * and descriptor id): rebind refuses another descriptor id first, and
 * assertReady re-reads by scope and recipient.
 */
const sameSeatIdentity = (
  left: SupervisorSessionDescriptorV2,
  right: SupervisorSessionDescriptorV2
): boolean =>
  left.endpointDigest === right.endpointDigest &&
  left.endpointRef === right.endpointRef &&
  left.provider === right.provider &&
  left.sessionRef === right.sessionRef;

const requireString = (
  value: unknown,
  field: string,
  pattern: RegExp
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new SupervisorSessionV2Error(`${field} is invalid`);
  }
  return value;
};

const requireExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new SupervisorSessionV2Error("descriptor fields are invalid");
  }
};

const descriptorSemantics = (
  descriptor: SupervisorSessionDescriptorV2
): string => canonical(descriptor);

export const deriveSupervisorSessionDescriptorV2Id = (
  scopeValue: TrustedSupervisorMessageV2Scope,
  recipient: string
): string => {
  const scope = parseTrustedSupervisorMessageV2Scope(scopeValue);
  const target = requireString(recipient, "recipient", RECIPIENT_RE);
  return `supervisor-session-descriptor:v2:${supervisorMessageV2ScopedDigest(
    scope.tenantId,
    scope.principal,
    "current-session",
    [target]
  )}`;
};

export const deriveSupervisorSessionReadinessReceiptV2Id = (
  scopeValue: TrustedSupervisorMessageV2Scope,
  descriptorId: string,
  revision: number
): string => {
  const scope = parseTrustedSupervisorMessageV2Scope(scopeValue);
  const id = requireString(
    descriptorId,
    "descriptorId",
    SESSION_DESCRIPTOR_ID_RE
  );
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new SupervisorSessionV2Error("descriptor revision is invalid");
  }
  return `supervisor-session-readiness:v2:${supervisorMessageV2ScopedDigest(
    scope.tenantId,
    scope.principal,
    "session-readiness",
    [id, String(revision)]
  )}`;
};

export const deriveSupervisorSessionRebindReceiptV2Id = (
  scopeValue: TrustedSupervisorMessageV2Scope,
  descriptorId: string,
  fromRevision: number,
  toRevision: number,
  authorityRef: string
): string => {
  const scope = parseTrustedSupervisorMessageV2Scope(scopeValue);
  const id = requireString(
    descriptorId,
    "descriptorId",
    SESSION_DESCRIPTOR_ID_RE
  );
  const authority = requireString(authorityRef, "authorityRef", REFERENCE_RE);
  if (
    !(Number.isSafeInteger(fromRevision) && Number.isSafeInteger(toRevision)) ||
    fromRevision < 1 ||
    toRevision !== fromRevision + 1
  ) {
    throw new SupervisorSessionV2Error("descriptor revisions are invalid");
  }
  return `supervisor-session-rebind:v2:${supervisorMessageV2ScopedDigest(
    scope.tenantId,
    scope.principal,
    "session-rebind",
    [id, String(fromRevision), String(toRevision), authority]
  )}`;
};

export const parseSupervisorSessionDescriptorV2 = (
  value: unknown,
  trustedScopeValue: TrustedSupervisorMessageV2Scope
): SupervisorSessionDescriptorV2 => {
  const scope = parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new SupervisorSessionV2Error("descriptor is invalid");
  }
  const record = value as Record<string, unknown>;
  requireExactKeys(record, [
    "descriptorId",
    "endpointDigest",
    "endpointRef",
    "expiresAt",
    "issuedAt",
    "principal",
    "provider",
    "recipient",
    "revision",
    "schema",
    "sessionRef",
    "tenantId",
  ]);
  if (record.schema !== SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA) {
    throw new SupervisorSessionV2Error("descriptor schema is invalid");
  }
  const tenantId = scope.tenantId;
  const principal = scope.principal;
  if (record.tenantId !== tenantId || record.principal !== principal) {
    throw new SupervisorSessionV2Error("descriptor scope is invalid");
  }
  const recipient = requireString(record.recipient, "recipient", RECIPIENT_RE);
  const descriptorId = requireString(
    record.descriptorId,
    "descriptorId",
    SESSION_DESCRIPTOR_ID_RE
  );
  if (
    descriptorId !== deriveSupervisorSessionDescriptorV2Id(scope, recipient)
  ) {
    throw new SupervisorSessionV2Error("descriptor identity is invalid");
  }
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    throw new SupervisorSessionV2Error("descriptor revision is invalid");
  }
  const issuedAt = requireCanonicalUtc(record.issuedAt, "issuedAt");
  const expiresAt = requireCanonicalUtc(record.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) {
    throw new SupervisorSessionV2Error("descriptor expiry is invalid");
  }
  return {
    descriptorId,
    endpointDigest: requireString(
      record.endpointDigest,
      "endpointDigest",
      ENDPOINT_DIGEST_RE
    ),
    endpointRef: requireString(
      record.endpointRef,
      "endpointRef",
      ENDPOINT_REF_RE
    ),
    expiresAt,
    issuedAt,
    principal,
    provider: requireString(
      record.provider,
      "provider",
      PROVIDER_RE
    ) as SupervisorSessionProviderV2,
    recipient,
    revision: Number(record.revision),
    schema: SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA,
    sessionRef: requireString(record.sessionRef, "sessionRef", SESSION_REF_RE),
    tenantId,
  };
};

const parseReadinessObservation = (
  value: unknown,
  descriptor: SupervisorSessionDescriptorV2
): SupervisorSessionProviderReadinessV2 => {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new SupervisorSessionV2Error("provider readiness is invalid");
  }
  const record = value as Record<string, unknown>;
  requireExactKeys(record, [
    "descriptorId",
    "endpointDigest",
    "provider",
    "revision",
    "sessionRef",
    "status",
  ]);
  const observed = {
    descriptorId: requireString(
      record.descriptorId,
      "provider descriptorId",
      SESSION_DESCRIPTOR_ID_RE
    ),
    endpointDigest: requireString(
      record.endpointDigest,
      "provider endpointDigest",
      ENDPOINT_DIGEST_RE
    ),
    provider: requireString(
      record.provider,
      "provider",
      PROVIDER_RE
    ) as SupervisorSessionProviderV2,
    revision: record.revision,
    sessionRef: requireString(
      record.sessionRef,
      "provider sessionRef",
      SESSION_REF_RE
    ),
    status: record.status,
  };
  if (
    observed.status !== "ready" ||
    !Number.isSafeInteger(observed.revision) ||
    observed.revision !== descriptor.revision ||
    observed.descriptorId !== descriptor.descriptorId ||
    observed.endpointDigest !== descriptor.endpointDigest ||
    observed.provider !== descriptor.provider ||
    observed.sessionRef !== descriptor.sessionRef
  ) {
    throw new SupervisorSessionV2Error(
      "provider readiness does not match the current descriptor"
    );
  }
  return observed as SupervisorSessionProviderReadinessV2;
};

interface DescriptorRow {
  descriptor_json: unknown;
  principal: string;
  tenant_id: string;
}

const descriptorFromRow = (
  row: DescriptorRow | undefined,
  scope: TrustedSupervisorMessageV2Scope
): SupervisorSessionDescriptorV2 | undefined => {
  if (
    !row ||
    row.tenant_id !== scope.tenantId ||
    row.principal !== scope.principal
  ) {
    return undefined;
  }
  let value: unknown = row.descriptor_json;
  if (typeof value === "string") {
    // A corrupt stored row is this store's own refusal, not an outage: it
    // must stay a bounded readiness failure rather than defer forever.
    try {
      value = JSON.parse(value);
    } catch {
      throw new SupervisorSessionV2Error("stored descriptor is invalid");
    }
  }
  return parseSupervisorSessionDescriptorV2(value, scope);
};

/* ---------------------------------------------------------------------------
 * r9 endpoint lease rows (loop_supervisor_endpoint_lease_v2).
 * ------------------------------------------------------------------------- */

const TENANT_ID_RE = /^tenant:[a-z0-9][a-z0-9._-]{0,127}$/;

interface LeaseRow {
  descriptor_id: unknown;
  descriptor_revision: unknown;
  epoch: unknown;
  expires_at: unknown;
  holder_ref: unknown;
  kind: unknown;
  locator_digest: unknown;
  locator_json: unknown;
  principal: unknown;
  recipient: unknown;
  released_at: unknown;
  session_ref: unknown;
  tenant_id: unknown;
}

interface StoredEndpointLease {
  lease: SupervisorEndpointLeaseV2;
  /** The descriptor sessionRef the claim bound; renewal keeps it. */
  sessionRef: string;
}

const storedLeaseInvalid = (): SupervisorEndpointLeaseError =>
  new SupervisorEndpointLeaseError("stored endpoint lease is invalid");

const storedInteger = (value: unknown): number => {
  const number = Number(value);
  if (
    !(
      (typeof value === "number" ||
        typeof value === "bigint" ||
        typeof value === "string") &&
      Number.isSafeInteger(number) &&
      number >= 1 &&
      String(value) === String(number)
    )
  ) {
    throw storedLeaseInvalid();
  }
  return number;
};

const storedTimestamp = (value: unknown): string => {
  let date: Date | undefined;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string") {
    date = new Date(value);
  }
  if (!date || Number.isNaN(date.getTime())) {
    throw storedLeaseInvalid();
  }
  return date.toISOString();
};

const storedJson = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    throw storedLeaseInvalid();
  }
};

/**
 * Decodes one stored lease strictly. The locator is re-parsed as untrusted
 * (ids only) and must still hash to the digest written with it, and the
 * descriptor id must be the seat scope's own; a row edited out of band is
 * this store's refusal, never a lease anyone may use.
 */
const storedLeaseFromRow = (row: LeaseRow): StoredEndpointLease => {
  try {
    const tenantId = requireLeaseTenant(row.tenant_id);
    const recipient = requireSupervisorEndpointRecipient(row.recipient);
    const scope = parseTrustedSupervisorMessageV2Scope({
      principal: row.principal,
      tenantId,
    });
    if (!isSupervisorEndpointKind(row.kind)) {
      throw storedLeaseInvalid();
    }
    const locator: SupervisorEndpointLocator = parseSupervisorEndpointLocator(
      storedJson(row.locator_json)
    );
    if (
      locator.kind !== row.kind ||
      supervisorEndpointLocatorDigest(locator) !== row.locator_digest
    ) {
      throw storedLeaseInvalid();
    }
    // The stored session ref must still be one, and must still derive the
    // descriptor identity with this locator (a Codex ref names its thread).
    const { sessionRef } = supervisorEndpointDescriptorIdentity(
      locator,
      row.session_ref as string
    );
    const descriptorId = requireString(
      row.descriptor_id,
      "descriptorId",
      SESSION_DESCRIPTOR_ID_RE
    );
    if (
      descriptorId !== deriveSupervisorSessionDescriptorV2Id(scope, recipient)
    ) {
      throw storedLeaseInvalid();
    }
    return {
      lease: {
        descriptorId,
        descriptorRevision: storedInteger(row.descriptor_revision),
        epoch: storedInteger(row.epoch),
        expiresAt: storedTimestamp(row.expires_at),
        holderRef: requireSupervisorEndpointHolderRef(row.holder_ref),
        kind: row.kind as SupervisorEndpointKind,
        locator,
        principal: scope.principal,
        recipient,
        releasedAt:
          row.released_at === null ? null : storedTimestamp(row.released_at),
        schema: SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA,
        tenantId,
      },
      sessionRef,
    };
  } catch {
    throw storedLeaseInvalid();
  }
};

const leaseFromRow = (row: LeaseRow): SupervisorEndpointLeaseV2 =>
  storedLeaseFromRow(row).lease;

const requireLeaseTenant = (value: unknown): string => {
  if (typeof value !== "string" || !TENANT_ID_RE.test(value)) {
    throw new SupervisorEndpointLeaseError("tenantId is invalid");
  }
  return value;
};

const requireLeaseScope = (value: unknown): TrustedSupervisorMessageV2Scope => {
  try {
    return parseTrustedSupervisorMessageV2Scope(value);
  } catch {
    throw new SupervisorEndpointLeaseError("scope is invalid");
  }
};

const requireLeaseInput = (value: unknown): Record<string, unknown> => {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new SupervisorEndpointLeaseError("lease input is invalid");
  }
  return value as Record<string, unknown>;
};

const parseLeaseClaimInput = (value: SupervisorEndpointLeaseClaimInput) => {
  const record = requireLeaseInput(value);
  if (record.takeover !== undefined && typeof record.takeover !== "boolean") {
    throw new SupervisorEndpointLeaseError("takeover is invalid");
  }
  const locator = parseSupervisorEndpointLocator(record.locator);
  const sessionRef = requireSupervisorEndpointSessionRef(record.sessionRef);
  return {
    holderRef: requireSupervisorEndpointHolderRef(record.holderRef),
    // Also refuses a Codex sessionRef that does not name the thread.
    identity: supervisorEndpointDescriptorIdentity(locator, sessionRef),
    locator,
    recipient: requireSupervisorEndpointRecipient(record.recipient),
    scope: requireLeaseScope(record.scope),
    sessionRef,
    takeover: record.takeover === true,
    ttlMs: requireSupervisorEndpointLeaseTtlMs(record.ttlMs),
  };
};

const parseLeaseFenceInput = (
  value: SupervisorEndpointLeaseReleaseInput | SupervisorEndpointLeaseRenewInput
) => {
  const record = requireLeaseInput(value);
  return {
    fence: requireSupervisorEndpointLeaseFence(record.fence),
    recipient: requireSupervisorEndpointRecipient(record.recipient),
    scope: requireLeaseScope(record.scope),
  };
};

/**
 * The fence decision, plus scope: a lease written in another principal's
 * scope (the recipient's principal changed in config) is not this caller's
 * lease, so it reads as absent.
 */
const fenceRefusal = (
  lease: SupervisorEndpointLeaseV2 | undefined,
  scope: TrustedSupervisorMessageV2Scope,
  fence: SupervisorEndpointLeaseFence
): "ok" | SupervisorEndpointLeaseFenceRefusal =>
  decideSupervisorEndpointLeaseFence(
    lease && lease.principal === scope.principal ? lease : undefined,
    fence
  );

/**
 * Rejection handler for every lease store operation: a refusal this store or
 * the session store decides passes through unchanged; anything else (a
 * driver or connection failure) means the store could not answer, and its
 * text is dropped.
 */
const rethrowLeaseStoreFailure = (error: unknown): never => {
  if (
    error instanceof SupervisorEndpointLeaseError ||
    error instanceof SupervisorSessionV2Error
  ) {
    throw error;
  }
  throw new SupervisorMessageV2ReadinessUnavailableError();
};

/**
 * Durable scoped current-session registry and body-free readiness receipts.
 * Its tables are private control-plane state, not a replacement for Temporal,
 * an A2A TaskStore, or provider session history.
 */
export class PostgresSupervisorSessionV2Store {
  readonly #authority: SupervisorSessionRebindAuthorityPort;
  readonly #now: () => string;
  readonly #provider: SupervisorSessionProviderReadinessPort;
  readonly #readinessMaxAgeMs: number;
  readonly #receiptRetention: SupervisorSessionReceiptRetentionV2;
  readonly #sql: SQL;

  private constructor(
    sql: SQL,
    provider: SupervisorSessionProviderReadinessPort,
    authority: SupervisorSessionRebindAuthorityPort,
    now: () => string,
    readinessMaxAgeMs?: number,
    receiptRetention?: SupervisorSessionReceiptRetentionV2
  ) {
    this.#authority = authority;
    this.#now = now;
    this.#provider = provider;
    this.#readinessMaxAgeMs = requireReadinessMaxAgeMs(readinessMaxAgeMs);
    this.#receiptRetention = requireReceiptRetention(receiptRetention);
    this.#sql = sql;
  }

  static async connect(input: {
    authority: SupervisorSessionRebindAuthorityPort;
    databaseUrl: string;
    now: () => string;
    provider: SupervisorSessionProviderReadinessPort;
    /** How long one successful provider probe keeps `status().ready` true. */
    readinessMaxAgeMs?: number;
    /** Per-seat receipt retention; see SupervisorSessionReceiptRetentionV2. */
    receiptRetention?: SupervisorSessionReceiptRetentionV2;
  }): Promise<PostgresSupervisorSessionV2Store> {
    if (!POSTGRES_URL.test(input.databaseUrl)) {
      throw new SupervisorSessionV2Error(
        "session store needs an explicit PostgreSQL URL"
      );
    }
    const readinessMaxAgeMs = requireReadinessMaxAgeMs(input.readinessMaxAgeMs);
    const receiptRetention = requireReceiptRetention(input.receiptRetention);
    const sql = new SQL(input.databaseUrl);
    try {
      await sql.connect();
      return new PostgresSupervisorSessionV2Store(
        sql,
        input.provider,
        input.authority,
        input.now,
        readinessMaxAgeMs,
        receiptRetention
      );
    } catch (error) {
      await sql.close({ timeout: 0 }).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#sql.close({ timeout: 0 });
  }

  async migrate(): Promise<void> {
    await this.#sql`
      CREATE TABLE IF NOT EXISTS loop_supervisor_session_v2_descriptor (
        descriptor_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        recipient TEXT NOT NULL,
        revision BIGINT NOT NULL,
        descriptor_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, principal, recipient)
      )
    `;
    await this.#sql`
      CREATE TABLE IF NOT EXISTS loop_supervisor_session_v2_readiness_receipt (
        receipt_id TEXT PRIMARY KEY,
        descriptor_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        receipt_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await this.#sql`
      CREATE TABLE IF NOT EXISTS loop_supervisor_session_v2_rebind_receipt (
        receipt_id TEXT PRIMARY KEY,
        descriptor_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        receipt_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    // Additive: lets a rebind prune its own seat's receipts without a scan.
    // The first migrate after upgrade builds each index with a plain CREATE
    // INDEX, which holds a SHARE lock on that receipt table until the build
    // ends: receipt writes (renewals, probes) from any process sharing the
    // database wait for it. Tables grown without a bound before this change
    // make that wait longest. CONCURRENTLY is not used: a failed concurrent
    // build leaves an INVALID index that IF NOT EXISTS would then keep.
    await this.#sql`
      CREATE INDEX IF NOT EXISTS loop_supervisor_session_v2_rebind_receipt_seat_idx
      ON loop_supervisor_session_v2_rebind_receipt (tenant_id, principal, descriptor_id)
    `;
    await this.#sql`
      CREATE INDEX IF NOT EXISTS loop_supervisor_session_v2_readiness_receipt_seat_idx
      ON loop_supervisor_session_v2_readiness_receipt (tenant_id, principal, descriptor_id)
    `;
    // r9: which live session holds a supervisor's endpoint. One row per
    // (tenant, recipient); see supervisor-endpoint-lease.ts. Additive, so an
    // r8 binary sharing the database ignores it. `locator_json` holds ids only
    // (never a path or URL); `locator_digest` is its sha256 as written, which
    // every read re-derives, and also the lease descriptor's endpointDigest.
    await this.#sql`
      CREATE TABLE IF NOT EXISTS loop_supervisor_endpoint_lease_v2 (
        tenant_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        principal TEXT NOT NULL,
        epoch BIGINT NOT NULL CHECK (epoch >= 1),
        holder_ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        locator_json JSONB NOT NULL,
        locator_digest TEXT NOT NULL,
        session_ref TEXT NOT NULL,
        descriptor_id TEXT NOT NULL,
        descriptor_revision BIGINT NOT NULL CHECK (descriptor_revision >= 1),
        expires_at TIMESTAMPTZ NOT NULL,
        released_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, recipient)
      )
    `;
  }

  /**
   * The r9 endpoint lease store over this store's connection and descriptor
   * table (its table is created by `migrate`). `deps.resolveLocator` is the
   * server's own resolver, bound to its own roots: claim resolves the input
   * locator and renew re-resolves the stored one before anything is written.
   */
  endpointLeases(
    deps: SupervisorEndpointLeaseStoreDeps
  ): SupervisorEndpointLeaseStore {
    const resolveLocator = deps?.resolveLocator;
    if (typeof resolveLocator !== "function") {
      throw new SupervisorEndpointLeaseError("resolveLocator is required");
    }
    return {
      claim: (input) =>
        this.#claimEndpointLease(resolveLocator, input).catch(
          rethrowLeaseStoreFailure
        ),
      list: (tenantId) =>
        this.#listEndpointLeases(tenantId).catch(rethrowLeaseStoreFailure),
      release: (input) =>
        this.#releaseEndpointLease(input).catch(rethrowLeaseStoreFailure),
      renew: (input) =>
        this.#renewEndpointLease(resolveLocator, input).catch(
          rethrowLeaseStoreFailure
        ),
      resolve: (tenantId, recipient) =>
        this.#resolveEndpointLease(tenantId, recipient).catch(
          rethrowLeaseStoreFailure
        ),
    };
  }

  async #claimEndpointLease(
    resolveLocator: SupervisorEndpointLocatorResolver,
    input: SupervisorEndpointLeaseClaimInput
  ): Promise<SupervisorEndpointLeaseClaimResult> {
    const claim = parseLeaseClaimInput(input);
    const { recipient, scope } = claim;
    // SECURITY: the locator is untrusted. It must resolve, under the server's
    // own roots and for this recipient, before anything is written.
    try {
      resolveLocator(claim.locator, recipient);
    } catch (error) {
      return supervisorEndpointLocatorRefused(error);
    }
    const now = this.#leaseNow();
    const expiresAt = supervisorEndpointLeaseExpiresAt(
      new Date(now),
      claim.ttlMs
    );
    const descriptorId = deriveSupervisorSessionDescriptorV2Id(
      scope,
      recipient
    );
    let result: SupervisorEndpointLeaseClaimResult | undefined;
    // Two claims of a never-claimed recipient both find no row to lock; the
    // loser's INSERT waits for the winner's commit, conflicts, and that claim
    // is decided again on the row it can now lock.
    for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
      await this.#sql.begin(async (sql) => {
        const rows = await sql<LeaseRow[]>`
          SELECT tenant_id, recipient, principal, epoch, holder_ref, kind, locator_json,
          locator_digest, session_ref, descriptor_id, descriptor_revision,
          expires_at, released_at
          FROM loop_supervisor_endpoint_lease_v2
          WHERE tenant_id = ${scope.tenantId} AND recipient = ${recipient}
          FOR UPDATE
        `;
        const current = rows[0] ? leaseFromRow(rows[0]) : undefined;
        const decision = decideSupervisorEndpointLeaseClaim(
          current,
          claim,
          new Date(now)
        );
        if (!decision.allowed) {
          result = { current: decision.current, status: "held" };
          return;
        }
        const written = current
          ? await sql`
              UPDATE loop_supervisor_endpoint_lease_v2
              SET principal = ${scope.principal},
                epoch = ${decision.nextEpoch},
                holder_ref = ${claim.holderRef},
                kind = ${claim.locator.kind},
                locator_json = ${canonical(claim.locator)}::text::jsonb,
                locator_digest = ${claim.identity.endpointDigest},
                session_ref = ${claim.sessionRef},
                descriptor_id = ${descriptorId},
                descriptor_revision = 1,
                expires_at = ${expiresAt}::timestamptz,
                released_at = NULL,
                updated_at = now()
              WHERE tenant_id = ${scope.tenantId}
                AND recipient = ${recipient}
                AND epoch = ${current.epoch}
            `
          : await sql`
              INSERT INTO loop_supervisor_endpoint_lease_v2 (
                tenant_id, recipient, principal, epoch, holder_ref, kind,
                locator_json, locator_digest, session_ref, descriptor_id,
                descriptor_revision, expires_at
              ) VALUES (
                ${scope.tenantId}, ${recipient}, ${scope.principal},
                ${decision.nextEpoch}, ${claim.holderRef}, ${claim.locator.kind},
                ${canonical(claim.locator)}::text::jsonb, ${claim.identity.endpointDigest},
                ${claim.sessionRef}, ${descriptorId}, 1, ${expiresAt}::timestamptz
              ) ON CONFLICT (tenant_id, recipient) DO NOTHING
            `;
        if (written.count !== 1) {
          if (current) {
            throw new SupervisorEndpointLeaseError(
              "endpoint lease claim lost the current epoch"
            );
          }
          return;
        }
        // The descriptor is registered or rebound in the same transaction:
        // lease and descriptor commit together or not at all.
        const descriptor = await this.#bindLeaseDescriptor(
          sql,
          scope,
          {
            ...claim.identity,
            descriptorId,
            expiresAt,
            issuedAt: now,
            principal: scope.principal,
            recipient,
            revision: 0,
            schema: SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA,
            tenantId: scope.tenantId,
          },
          "claim"
        );
        await sql`
          UPDATE loop_supervisor_endpoint_lease_v2
          SET descriptor_revision = ${descriptor.revision}
          WHERE tenant_id = ${scope.tenantId} AND recipient = ${recipient}
        `;
        result = {
          descriptor,
          lease: {
            descriptorId,
            descriptorRevision: descriptor.revision,
            epoch: decision.nextEpoch,
            expiresAt,
            holderRef: claim.holderRef,
            kind: claim.locator.kind,
            locator: claim.locator,
            principal: scope.principal,
            recipient,
            releasedAt: null,
            schema: SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA,
            tenantId: scope.tenantId,
          },
          previous: current
            ? supervisorEndpointLeaseHolderSummary(current, new Date(now))
            : null,
          status: "claimed",
          tookOver: decision.tookOver,
        };
      });
    }
    if (!result) {
      throw new SupervisorEndpointLeaseError("endpoint lease claim conflicted");
    }
    return result;
  }

  /**
   * Registers the lease's descriptor at revision 1, or rebinds the current
   * one to `revision + 1` through the rebind authority and CAS. Runs inside
   * the lease transaction, after the lease row is locked, so lease writers
   * for one recipient are serialized; any other writer that moved the
   * descriptor first fails the CAS and rolls the whole claim back.
   */
  async #bindLeaseDescriptor(
    sql: SQL,
    scope: TrustedSupervisorMessageV2Scope,
    template: SupervisorSessionDescriptorV2,
    mode: "claim" | "renew"
  ): Promise<SupervisorSessionDescriptorV2> {
    const rows = await sql<DescriptorRow[]>`
      SELECT descriptor_json, principal, tenant_id
      FROM loop_supervisor_session_v2_descriptor
      WHERE tenant_id = ${scope.tenantId}
        AND principal = ${scope.principal}
        AND recipient = ${template.recipient}
      FOR UPDATE
    `;
    const current = descriptorFromRow(rows[0], scope);
    if (mode === "renew" && !(current && sameSeatIdentity(current, template))) {
      // Renewal extends only what the claim bound; a descriptor another
      // writer moved or removed is not silently re-pointed.
      throw new SupervisorEndpointLeaseError(
        "endpoint lease descriptor no longer matches the lease"
      );
    }
    if (!current) {
      const next = parseSupervisorSessionDescriptorV2(
        { ...template, revision: 1 },
        scope
      );
      const inserted = await sql`
        INSERT INTO loop_supervisor_session_v2_descriptor (
          descriptor_id, tenant_id, principal, recipient, revision, descriptor_json
        ) VALUES (
          ${next.descriptorId}, ${scope.tenantId}, ${scope.principal},
          ${next.recipient}, ${next.revision}, ${descriptorSemantics(next)}::jsonb
        ) ON CONFLICT (descriptor_id) DO NOTHING
      `;
      if (inserted.count !== 1) {
        throw new SupervisorSessionV2Error(
          "session descriptor conflicts with the current registration"
        );
      }
      return next;
    }
    const next = parseSupervisorSessionDescriptorV2(
      { ...template, revision: current.revision + 1 },
      scope
    );
    const decision = await this.#decideRebind(scope, current, next);
    await this.#commitRebind(sql, scope, current, next, decision);
    return next;
  }

  async #renewEndpointLease(
    resolveLocator: SupervisorEndpointLocatorResolver,
    input: SupervisorEndpointLeaseRenewInput
  ): Promise<SupervisorEndpointLeaseRenewResult> {
    const { fence, recipient, scope } = parseLeaseFenceInput(input);
    const ttlMs = requireSupervisorEndpointLeaseTtlMs(input.ttlMs);
    // The fence is checked first, then the STORED locator is re-resolved
    // (outside any row lock: it touches the filesystem), then the fence is
    // checked again under the lock before anything is extended.
    const seen = await this.#readLease(this.#sql, scope.tenantId, recipient);
    const before = fenceRefusal(seen, scope, fence);
    if (before !== "ok") {
      return { reason: before, status: "fenced" };
    }
    const stored = seen as SupervisorEndpointLeaseV2;
    try {
      resolveLocator(stored.locator, recipient);
    } catch (error) {
      return supervisorEndpointLocatorRefused(error);
    }
    const now = this.#leaseNow();
    const expiresAt = supervisorEndpointLeaseExpiresAt(new Date(now), ttlMs);
    let result: SupervisorEndpointLeaseRenewResult | undefined;
    await this.#sql.begin(async (sql) => {
      const rows = await sql<LeaseRow[]>`
        SELECT tenant_id, recipient, principal, epoch, holder_ref, kind, locator_json,
          locator_digest, session_ref, descriptor_id, descriptor_revision,
          expires_at, released_at
        FROM loop_supervisor_endpoint_lease_v2
        WHERE tenant_id = ${scope.tenantId} AND recipient = ${recipient}
        FOR UPDATE
      `;
      const locked = rows[0] ? storedLeaseFromRow(rows[0]) : undefined;
      const refusal = fenceRefusal(locked?.lease, scope, fence);
      if (refusal !== "ok") {
        result = { reason: refusal, status: "fenced" };
        return;
      }
      const { lease, sessionRef } = locked as StoredEndpointLease;
      // Only a claim changes the locator, and a claim bumps the epoch; the
      // locator resolved above must still be the stored one.
      if (canonical(lease.locator) !== canonical(stored.locator)) {
        result = supervisorEndpointLocatorRefused(undefined);
        return;
      }
      const descriptor = await this.#bindLeaseDescriptor(
        sql,
        scope,
        {
          ...supervisorEndpointDescriptorIdentity(lease.locator, sessionRef),
          descriptorId: deriveSupervisorSessionDescriptorV2Id(scope, recipient),
          expiresAt,
          issuedAt: now,
          principal: scope.principal,
          recipient,
          revision: 0,
          schema: SUPERVISOR_SESSION_DESCRIPTOR_V2_SCHEMA,
          tenantId: scope.tenantId,
        },
        "renew"
      );
      const updated = await sql`
        UPDATE loop_supervisor_endpoint_lease_v2
        SET expires_at = ${expiresAt}::timestamptz,
          descriptor_revision = ${descriptor.revision},
          updated_at = now()
        WHERE tenant_id = ${scope.tenantId}
          AND recipient = ${recipient}
          AND epoch = ${fence.epoch}
          AND holder_ref = ${fence.holderRef}
          AND released_at IS NULL
      `;
      if (updated.count !== 1) {
        throw new SupervisorEndpointLeaseError(
          "endpoint lease renewal lost the fence"
        );
      }
      result = {
        descriptor,
        lease: {
          ...lease,
          descriptorRevision: descriptor.revision,
          expiresAt,
        },
        status: "renewed",
      };
    });
    if (!result) {
      throw new SupervisorEndpointLeaseError(
        "endpoint lease renewal is absent"
      );
    }
    return result;
  }

  async #releaseEndpointLease(
    input: SupervisorEndpointLeaseReleaseInput
  ): Promise<SupervisorEndpointLeaseReleaseResult> {
    const { fence, recipient, scope } = parseLeaseFenceInput(input);
    // Release never resolves the locator: a holder can always let go.
    const now = this.#leaseNow();
    let result: SupervisorEndpointLeaseReleaseResult | undefined;
    await this.#sql.begin(async (sql) => {
      const rows = await sql<LeaseRow[]>`
        SELECT tenant_id, recipient, principal, epoch, holder_ref, kind, locator_json,
          locator_digest, session_ref, descriptor_id, descriptor_revision,
          expires_at, released_at
        FROM loop_supervisor_endpoint_lease_v2
        WHERE tenant_id = ${scope.tenantId} AND recipient = ${recipient}
        FOR UPDATE
      `;
      const lease = rows[0] ? leaseFromRow(rows[0]) : undefined;
      const refusal = fenceRefusal(lease, scope, fence);
      if (refusal === "released") {
        result = {
          changed: false,
          lease: lease as SupervisorEndpointLeaseV2,
          status: "released",
        };
        return;
      }
      if (refusal !== "ok") {
        result = { reason: refusal, status: "fenced" };
        return;
      }
      const updated = await sql`
        UPDATE loop_supervisor_endpoint_lease_v2
        SET released_at = ${now}::timestamptz, updated_at = now()
        WHERE tenant_id = ${scope.tenantId}
          AND recipient = ${recipient}
          AND epoch = ${fence.epoch}
          AND holder_ref = ${fence.holderRef}
          AND released_at IS NULL
      `;
      if (updated.count !== 1) {
        throw new SupervisorEndpointLeaseError(
          "endpoint lease release lost the fence"
        );
      }
      result = {
        changed: true,
        lease: { ...(lease as SupervisorEndpointLeaseV2), releasedAt: now },
        status: "released",
      };
    });
    if (!result) {
      throw new SupervisorEndpointLeaseError(
        "endpoint lease release is absent"
      );
    }
    return result;
  }

  async #resolveEndpointLease(
    tenantValue: string,
    recipientValue: string
  ): Promise<SupervisorEndpointLeaseResolution> {
    const tenantId = requireLeaseTenant(tenantValue);
    const recipient = requireSupervisorEndpointRecipient(recipientValue);
    const lease = await this.#readLease(this.#sql, tenantId, recipient);
    return resolveSupervisorEndpointLease(lease, new Date(this.#leaseNow()));
  }

  async #listEndpointLeases(
    tenantValue: string
  ): Promise<readonly SupervisorEndpointLeaseV2[]> {
    const tenantId = requireLeaseTenant(tenantValue);
    const rows = await this.#sql<LeaseRow[]>`
      SELECT tenant_id, recipient, principal, epoch, holder_ref, kind, locator_json,
          locator_digest, session_ref, descriptor_id, descriptor_revision,
          expires_at, released_at
      FROM loop_supervisor_endpoint_lease_v2
      WHERE tenant_id = ${tenantId} AND released_at IS NULL
      ORDER BY recipient COLLATE "C"
    `;
    return rows.map(leaseFromRow);
  }

  async #readLease(
    sql: SQL,
    tenantId: string,
    recipient: string
  ): Promise<SupervisorEndpointLeaseV2 | undefined> {
    const rows = await sql<LeaseRow[]>`
      SELECT tenant_id, recipient, principal, epoch, holder_ref, kind, locator_json,
          locator_digest, session_ref, descriptor_id, descriptor_revision,
          expires_at, released_at
      FROM loop_supervisor_endpoint_lease_v2
      WHERE tenant_id = ${tenantId} AND recipient = ${recipient}
    `;
    return rows[0] ? leaseFromRow(rows[0]) : undefined;
  }

  #leaseNow(): string {
    return requireCanonicalUtc(this.#now(), "lease now");
  }

  async register(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    descriptorValue: SupervisorSessionDescriptorV2
  ): Promise<SupervisorSessionDescriptorV2> {
    const scope = parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const descriptor = parseSupervisorSessionDescriptorV2(
      descriptorValue,
      scope
    );
    const encoded = descriptorSemantics(descriptor);
    await this.#sql`
      INSERT INTO loop_supervisor_session_v2_descriptor (
        descriptor_id, tenant_id, principal, recipient, revision, descriptor_json
      ) VALUES (
        ${descriptor.descriptorId}, ${scope.tenantId}, ${scope.principal},
        ${descriptor.recipient}, ${descriptor.revision}, ${encoded}::jsonb
      ) ON CONFLICT (descriptor_id) DO NOTHING
    `;
    const current = await this.current(scope, descriptor.recipient);
    if (!current || descriptorSemantics(current) !== encoded) {
      throw new SupervisorSessionV2Error(
        "session descriptor conflicts with the current registration"
      );
    }
    return current;
  }

  async current(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    recipientValue: string
  ): Promise<SupervisorSessionDescriptorV2 | undefined> {
    const scope = parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const recipient = requireString(recipientValue, "recipient", RECIPIENT_RE);
    const rows = await this.#sql<DescriptorRow[]>`
      SELECT descriptor_json, principal, tenant_id
      FROM loop_supervisor_session_v2_descriptor
      WHERE tenant_id = ${scope.tenantId}
        AND principal = ${scope.principal}
        AND recipient = ${recipient}
    `;
    return descriptorFromRow(rows[0], scope);
  }

  async rebind(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    nextValue: SupervisorSessionDescriptorV2
  ): Promise<{
    descriptor: SupervisorSessionDescriptorV2;
    receipt: SupervisorSessionRebindReceiptV2;
  }> {
    const scope = parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const next = parseSupervisorSessionDescriptorV2(nextValue, scope);
    const current = await this.current(scope, next.recipient);
    if (!current || next.descriptorId !== current.descriptorId) {
      throw new SupervisorSessionV2Error(
        "session descriptor is not registered"
      );
    }
    if (next.revision !== current.revision + 1) {
      throw new SupervisorSessionV2Error("session rebind revision is stale");
    }
    const decision = await this.#decideRebind(scope, current, next);
    let receipt: SupervisorSessionRebindReceiptV2 | undefined;
    await this.#sql.begin(async (sql) => {
      receipt = await this.#commitRebind(sql, scope, current, next, decision);
    });
    if (!receipt) {
      throw new SupervisorSessionV2Error("session rebind receipt is absent");
    }
    return { descriptor: next, receipt };
  }

  /** The rebind authority's decision, validated; a denial throws. */
  async #decideRebind(
    scope: TrustedSupervisorMessageV2Scope,
    current: SupervisorSessionDescriptorV2,
    next: SupervisorSessionDescriptorV2
  ): Promise<{ authorityRef: string; reasonCode: string }> {
    const decision = await this.#authority.decide({
      current,
      next,
      trustedScope: scope,
    });
    const authorityRef = requireString(
      decision.authorityRef,
      "authorityRef",
      REFERENCE_RE
    );
    const reasonCode = requireString(
      decision.reasonCode,
      "reasonCode",
      REFERENCE_RE
    );
    if (decision.allowed !== true) {
      throw new SupervisorSessionV2Error(
        `session rebind denied: ${reasonCode}`
      );
    }
    return { authorityRef, reasonCode };
  }

  /**
   * The rebind CAS and its receipts, inside the caller's transaction: moves
   * the descriptor from `current.revision` to `next`, or throws when another
   * writer moved it first. Shared by `rebind` and the endpoint lease store.
   */
  async #commitRebind(
    sql: SQL,
    scope: TrustedSupervisorMessageV2Scope,
    current: SupervisorSessionDescriptorV2,
    next: SupervisorSessionDescriptorV2,
    decision: { authorityRef: string; reasonCode: string }
  ): Promise<SupervisorSessionRebindReceiptV2> {
    const { authorityRef, reasonCode } = decision;
    const encoded = descriptorSemantics(next);
    const receipt: SupervisorSessionRebindReceiptV2 = {
      authorityRef,
      descriptorId: next.descriptorId,
      fromRevision: current.revision,
      principal: scope.principal,
      reasonCode,
      receiptId: deriveSupervisorSessionRebindReceiptV2Id(
        scope,
        next.descriptorId,
        current.revision,
        next.revision,
        authorityRef
      ),
      recipient: next.recipient,
      schema: SUPERVISOR_SESSION_REBIND_RECEIPT_V2_SCHEMA,
      tenantId: scope.tenantId,
      toRevision: next.revision,
    };
    const updated = await sql`
      UPDATE loop_supervisor_session_v2_descriptor
      SET revision = ${next.revision}, descriptor_json = ${encoded}::jsonb, updated_at = now()
      WHERE descriptor_id = ${current.descriptorId}
        AND tenant_id = ${scope.tenantId}
        AND principal = ${scope.principal}
        AND revision = ${current.revision}
    `;
    if (updated.count !== 1) {
      throw new SupervisorSessionV2Error(
        "session rebind lost the current revision"
      );
    }
    // The id can only already exist when an earlier lifetime of a
    // re-registered descriptor made the same transition. That stored
    // receipt is kept as it was; only its write time moves to now, so
    // retention ranks it as this renewal's receipt (see the retention type).
    await sql`
      INSERT INTO loop_supervisor_session_v2_rebind_receipt (
        receipt_id, descriptor_id, tenant_id, principal, receipt_json
      ) VALUES (
        ${receipt.receiptId}, ${receipt.descriptorId}, ${scope.tenantId},
        ${scope.principal}, ${canonical(receipt)}::jsonb
      ) ON CONFLICT (receipt_id) DO UPDATE
        SET created_at = now()
    `;
    // A renewal of the same provider session must not drop a dependent
    // DAG gate to not-ready until the next delivery probes it.
    if (sameSeatIdentity(current, next)) {
      await this.#carryReadiness(sql, scope, current, next);
    }
    await this.#pruneReceipts(sql, scope, next.descriptorId);
    return receipt;
  }

  /**
   * Copies the current revision's readiness receipt to the renewed revision,
   * keeping its `checkedAt`: it is the same probe's evidence, so it lapses when
   * that probe would have and a renewal never extends readiness. Nothing is
   * carried when there is no receipt, or it cannot be read: the renewal still
   * succeeds and the seat reads not-ready until its next probe. A leftover
   * receipt already stored under the renewed revision's id (left by an
   * earlier lifetime of a re-registered descriptor) is replaced, as a probe
   * replaces it, and its `created_at` reset so retention ranks it as new.
   */
  async #carryReadiness(
    sql: SQL,
    scope: TrustedSupervisorMessageV2Scope,
    current: SupervisorSessionDescriptorV2,
    next: SupervisorSessionDescriptorV2
  ): Promise<void> {
    const rows = await sql<{ receipt_json: unknown }[]>`
      SELECT receipt_json
      FROM loop_supervisor_session_v2_readiness_receipt
      WHERE receipt_id = ${deriveSupervisorSessionReadinessReceiptV2Id(
        scope,
        current.descriptorId,
        current.revision
      )}
        AND tenant_id = ${scope.tenantId}
        AND principal = ${scope.principal}
    `;
    let prior: SupervisorSessionReadinessReceiptV2;
    try {
      const value = rows[0]?.receipt_json;
      prior = this.#parseReadinessReceipt(
        typeof value === "string" ? JSON.parse(value) : value,
        scope
      );
    } catch {
      return;
    }
    const carried: SupervisorSessionReadinessReceiptV2 = {
      ...prior,
      descriptorRevision: next.revision,
      receiptId: deriveSupervisorSessionReadinessReceiptV2Id(
        scope,
        next.descriptorId,
        next.revision
      ),
    };
    await sql`
      INSERT INTO loop_supervisor_session_v2_readiness_receipt (
        receipt_id, descriptor_id, tenant_id, principal, receipt_json
      ) VALUES (
        ${carried.receiptId}, ${carried.descriptorId}, ${scope.tenantId},
        ${scope.principal}, ${canonical(carried)}::jsonb
      ) ON CONFLICT (receipt_id) DO UPDATE
        SET receipt_json = EXCLUDED.receipt_json, created_at = now()
    `;
  }

  /** Applies the receipt retention policy to one seat; see its type. */
  async #pruneReceipts(
    sql: SQL,
    scope: TrustedSupervisorMessageV2Scope,
    descriptorId: string
  ): Promise<void> {
    const { keepLatest, keepNewerThanMs } = this.#receiptRetention;
    // Ranked by typed columns only: no cast of `receipt_json`, whose stored
    // shape a renewal must never depend on.
    await sql`
      DELETE FROM loop_supervisor_session_v2_rebind_receipt
      WHERE tenant_id = ${scope.tenantId}
        AND principal = ${scope.principal}
        AND descriptor_id = ${descriptorId}
        AND created_at < now() - (${keepNewerThanMs}::bigint * interval '1 millisecond')
        AND receipt_id NOT IN (
          SELECT receipt_id FROM loop_supervisor_session_v2_rebind_receipt
          WHERE tenant_id = ${scope.tenantId}
            AND principal = ${scope.principal}
            AND descriptor_id = ${descriptorId}
          ORDER BY created_at DESC
          LIMIT ${keepLatest}
        )
    `;
    await sql`
      DELETE FROM loop_supervisor_session_v2_readiness_receipt
      WHERE tenant_id = ${scope.tenantId}
        AND principal = ${scope.principal}
        AND descriptor_id = ${descriptorId}
        AND created_at < now() - (${keepNewerThanMs}::bigint * interval '1 millisecond')
        AND receipt_id NOT IN (
          SELECT receipt_id FROM loop_supervisor_session_v2_readiness_receipt
          WHERE tenant_id = ${scope.tenantId}
            AND principal = ${scope.principal}
            AND descriptor_id = ${descriptorId}
          ORDER BY created_at DESC
          LIMIT ${keepLatest}
        )
    `;
  }

  /** The delivery coordinator calls this immediately before the provider port. */
  async assertReady(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    recipientValue: string
  ): Promise<SupervisorSessionReadinessReceiptV2> {
    const scope = parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const recipient = requireString(recipientValue, "recipient", RECIPIENT_RE);
    const descriptor = await this.current(scope, recipient).catch(
      rethrowReadinessStoreFailure
    );
    if (!descriptor) {
      throw new SupervisorSessionV2Error(
        "current session descriptor is absent"
      );
    }
    const startedAt = requireCanonicalUtc(this.#now(), "readiness startedAt");
    if (descriptor.expiresAt <= startedAt) {
      throw new SupervisorSessionV2Error(
        "current session descriptor is expired"
      );
    }
    parseReadinessObservation(
      await this.#provider.ready(descriptor),
      descriptor
    );
    let receipt: SupervisorSessionReadinessReceiptV2 | undefined;
    const transaction = this.#sql.begin(async (sql) => {
      const rows = await sql<DescriptorRow[]>`
        SELECT descriptor_json, principal, tenant_id
        FROM loop_supervisor_session_v2_descriptor
        WHERE tenant_id = ${scope.tenantId}
          AND principal = ${scope.principal}
          AND recipient = ${recipient}
        FOR UPDATE
      `;
      const current = descriptorFromRow(rows[0], scope);
      // A renewal between the read and this lock (a new revision and expiry
      // for the same provider session) does not void the probe; the receipt
      // is written for the revision now current. Any change to the session
      // identity the probe vouched for still refuses.
      if (!(current && sameSeatIdentity(current, descriptor))) {
        throw new SupervisorSessionV2Error(
          "current session changed during readiness"
        );
      }
      const checkedAt = requireCanonicalUtc(this.#now(), "readiness checkedAt");
      if (current.expiresAt <= checkedAt) {
        throw new SupervisorSessionV2Error(
          "current session descriptor is expired"
        );
      }
      receipt = {
        checkedAt,
        descriptorId: current.descriptorId,
        descriptorRevision: current.revision,
        principal: scope.principal,
        provider: current.provider,
        receiptId: deriveSupervisorSessionReadinessReceiptV2Id(
          scope,
          current.descriptorId,
          current.revision
        ),
        recipient,
        schema: SUPERVISOR_SESSION_READINESS_RECEIPT_V2_SCHEMA,
        status: "ready",
        tenantId: scope.tenantId,
      };
      await sql`
        INSERT INTO loop_supervisor_session_v2_readiness_receipt (
          receipt_id, descriptor_id, tenant_id, principal, receipt_json
        ) VALUES (
          ${receipt.receiptId}, ${receipt.descriptorId}, ${scope.tenantId},
          ${scope.principal}, ${canonical(receipt)}::jsonb
        ) ON CONFLICT (receipt_id) DO UPDATE
          SET receipt_json = EXCLUDED.receipt_json
      `;
    });
    await transaction.catch(rethrowReadinessStoreFailure);
    if (!receipt) {
      throw new SupervisorSessionV2Error("session readiness receipt is absent");
    }
    return receipt;
  }

  async readinessReceipt(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    descriptorId: string,
    revision: number
  ): Promise<SupervisorSessionReadinessReceiptV2 | undefined> {
    const scope = parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const receiptId = deriveSupervisorSessionReadinessReceiptV2Id(
      scope,
      descriptorId,
      revision
    );
    const rows = await this.#sql<{ receipt_json: unknown }[]>`
      SELECT receipt_json
      FROM loop_supervisor_session_v2_readiness_receipt
      WHERE receipt_id = ${receiptId}
        AND tenant_id = ${scope.tenantId}
        AND principal = ${scope.principal}
    `;
    const value =
      typeof rows[0]?.receipt_json === "string"
        ? JSON.parse(rows[0].receipt_json)
        : rows[0]?.receipt_json;
    if (!value) {
      return undefined;
    }
    return this.#parseReadinessReceipt(value, scope);
  }

  /**
   * A passive read-model projection. It never performs a provider probe, so a
   * task graph can inspect a dependency without waking an agent or exposing a
   * session endpoint. A graph must treat `ready: false` as an unsatisfied gate.
   * `ready` needs a receipt from a successful probe within the freshness
   * window: a seat that died after its last probe reads not-ready once that
   * window lapses, however far away the descriptor's own expiry is.
   */
  async status(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    recipientValue: string
  ): Promise<SupervisorSessionDescriptorStatusV2 | undefined> {
    const scope = parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const descriptor = await this.current(scope, recipientValue);
    if (!descriptor) {
      return undefined;
    }
    const receipt = await this.readinessReceipt(
      scope,
      descriptor.descriptorId,
      descriptor.revision
    );
    const now = requireCanonicalUtc(this.#now(), "status now");
    // A receipt dated in the future (another host's fast clock, or this
    // clock stepping back) would otherwise read fresh until real time caught
    // up with it, so only a small skew tolerance is allowed.
    const ageMs =
      receipt === undefined
        ? undefined
        : Date.parse(now) - Date.parse(receipt.checkedAt);
    const fresh =
      ageMs !== undefined &&
      ageMs >= -SUPERVISOR_SESSION_READINESS_CLOCK_SKEW_MS &&
      ageMs <= this.#readinessMaxAgeMs;
    return {
      descriptorId: descriptor.descriptorId,
      principal: scope.principal,
      provider: descriptor.provider,
      readinessReceiptId: receipt?.receiptId ?? null,
      ready: fresh && descriptor.expiresAt > now,
      recipient: descriptor.recipient,
      revision: descriptor.revision,
      schema: "supervisor-session-status.v2",
      tenantId: scope.tenantId,
    };
  }

  #parseReadinessReceipt(
    value: unknown,
    scope: TrustedSupervisorMessageV2Scope
  ): SupervisorSessionReadinessReceiptV2 {
    if (!(value && typeof value === "object" && !Array.isArray(value))) {
      throw new SupervisorSessionV2Error("stored readiness receipt is invalid");
    }
    const record = value as Record<string, unknown>;
    requireExactKeys(record, [
      "checkedAt",
      "descriptorId",
      "descriptorRevision",
      "principal",
      "provider",
      "receiptId",
      "recipient",
      "schema",
      "status",
      "tenantId",
    ]);
    if (
      record.schema !== SUPERVISOR_SESSION_READINESS_RECEIPT_V2_SCHEMA ||
      record.tenantId !== scope.tenantId ||
      record.principal !== scope.principal ||
      record.status !== "ready"
    ) {
      throw new SupervisorSessionV2Error("stored readiness receipt is invalid");
    }
    const descriptorId = requireString(
      record.descriptorId,
      "receipt descriptorId",
      SESSION_DESCRIPTOR_ID_RE
    );
    if (
      !Number.isSafeInteger(record.descriptorRevision) ||
      Number(record.descriptorRevision) < 1
    ) {
      throw new SupervisorSessionV2Error("stored readiness receipt is invalid");
    }
    const descriptorRevision = Number(record.descriptorRevision);
    const receiptId = requireString(
      record.receiptId,
      "receiptId",
      RECEIPT_ID_RE
    );
    if (
      receiptId !==
      deriveSupervisorSessionReadinessReceiptV2Id(
        scope,
        descriptorId,
        descriptorRevision
      )
    ) {
      throw new SupervisorSessionV2Error("stored readiness receipt is invalid");
    }
    return {
      checkedAt: requireCanonicalUtc(record.checkedAt, "receipt checkedAt"),
      descriptorId,
      descriptorRevision,
      principal: scope.principal,
      provider: requireString(
        record.provider,
        "receipt provider",
        PROVIDER_RE
      ) as SupervisorSessionProviderV2,
      receiptId,
      recipient: requireString(
        record.recipient,
        "receipt recipient",
        RECIPIENT_RE
      ),
      schema: SUPERVISOR_SESSION_READINESS_RECEIPT_V2_SCHEMA,
      status: "ready",
      tenantId: scope.tenantId,
    };
  }
}
