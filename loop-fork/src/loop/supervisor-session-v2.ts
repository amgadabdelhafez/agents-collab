import { SQL } from "bun";
import {
  parseTrustedSupervisorMessageV2Scope,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
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
  const value =
    typeof row.descriptor_json === "string"
      ? JSON.parse(row.descriptor_json)
      : row.descriptor_json;
  return parseSupervisorSessionDescriptorV2(value, scope);
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
  readonly #sql: SQL;

  private constructor(
    sql: SQL,
    provider: SupervisorSessionProviderReadinessPort,
    authority: SupervisorSessionRebindAuthorityPort,
    now: () => string
  ) {
    this.#authority = authority;
    this.#now = now;
    this.#provider = provider;
    this.#sql = sql;
  }

  static async connect(input: {
    authority: SupervisorSessionRebindAuthorityPort;
    databaseUrl: string;
    now: () => string;
    provider: SupervisorSessionProviderReadinessPort;
  }): Promise<PostgresSupervisorSessionV2Store> {
    if (!POSTGRES_URL.test(input.databaseUrl)) {
      throw new SupervisorSessionV2Error(
        "session store needs an explicit PostgreSQL URL"
      );
    }
    const sql = new SQL(input.databaseUrl);
    try {
      await sql.connect();
      return new PostgresSupervisorSessionV2Store(
        sql,
        input.provider,
        input.authority,
        input.now
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
    await this.#sql.begin(async (sql) => {
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
      await sql`
      INSERT INTO loop_supervisor_session_v2_rebind_receipt (
        receipt_id, descriptor_id, tenant_id, principal, receipt_json
      ) VALUES (
        ${receipt.receiptId}, ${receipt.descriptorId}, ${scope.tenantId},
        ${scope.principal}, ${canonical(receipt)}::jsonb
      ) ON CONFLICT (receipt_id) DO NOTHING
    `;
    });
    return { descriptor: next, receipt };
  }

  /** The delivery coordinator calls this immediately before the provider port. */
  async assertReady(
    trustedScopeValue: TrustedSupervisorMessageV2Scope,
    recipientValue: string
  ): Promise<SupervisorSessionReadinessReceiptV2> {
    const scope = parseTrustedSupervisorMessageV2Scope(trustedScopeValue);
    const recipient = requireString(recipientValue, "recipient", RECIPIENT_RE);
    const descriptor = await this.current(scope, recipient);
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
    await this.#sql.begin(async (sql) => {
      const rows = await sql<DescriptorRow[]>`
        SELECT descriptor_json, principal, tenant_id
        FROM loop_supervisor_session_v2_descriptor
        WHERE tenant_id = ${scope.tenantId}
          AND principal = ${scope.principal}
          AND recipient = ${recipient}
        FOR UPDATE
      `;
      const current = descriptorFromRow(rows[0], scope);
      if (
        !current ||
        descriptorSemantics(current) !== descriptorSemantics(descriptor)
      ) {
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
        ) ON CONFLICT (receipt_id) DO NOTHING
      `;
    });
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
    return {
      descriptorId: descriptor.descriptorId,
      principal: scope.principal,
      provider: descriptor.provider,
      readinessReceiptId: receipt?.receiptId ?? null,
      ready:
        receipt !== undefined &&
        descriptor.expiresAt > requireCanonicalUtc(this.#now(), "status now"),
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
