import { SQL } from "bun";
import type {
  SupervisorA2AAuthenticatedIdentity,
  SupervisorA2AAuthenticator,
} from "./a2a-supervisor-http";
import {
  A2A_V2_LEASE_EPOCH_HEADER,
  A2A_V2_LEASE_HOLDER_HEADER,
  A2A_V2_ROUTE_ERROR_STATUS,
  type A2AV2RouteErrorCode,
} from "./a2a-v2-routes-contract";
import {
  decideSupervisorEndpointLeaseFence,
  requireSupervisorEndpointLeaseFence,
  type SupervisorEndpointLeaseFence,
  type SupervisorEndpointLeaseFenceRefusal,
  type SupervisorEndpointLeaseReader,
} from "./supervisor-endpoint-lease";
import {
  parseSupervisorMessageV2DeliveryEnvelope,
  type SupervisorMessageV2DeliveryEnvelope,
} from "./supervisor-message-v2-contract";

/**
 * ra1: the outbound, resumable inbox stream. A session behind NAT, or on
 * another device, holds `GET {routePath}/sessions/<slug>/inbox` open (Server-
 * Sent Events) and receives without an inbound port.
 *
 * - Delivery to an `inbox-stream` lease appends the V2 delivery envelope to a
 *   durable, per-recipient inbox in the ledger database
 *   (`loop_supervisor_inbox_v1`). Its BIGSERIAL `seq` is the SSE event id, so
 *   `Last-Event-ID` resumes exactly after the last event the client
 *   processed. Appends for one recipient are serialized by a transaction
 *   advisory lock, so their sequence numbers commit in order and a reader
 *   that has seen `seq` N has seen every smaller one: a resume cannot skip.
 * - One row per (tenant, recipient, message workflow): a retried delivery
 *   attempt, or a repeat after a lease change, appends nothing new.
 * - The stream carries only messages whose workflow is not terminal: an
 *   acknowledged (or canceled, dead-lettered...) message is not replayed.
 *   Terminal rows are pruned on append; the unacknowledged rows of one
 *   recipient are capped (`maxPending`), beyond which delivery is a transient
 *   failure the workflow retries (bounded by its own attempts).
 * - Wakeups are server-side and in-process: the delivery activity that
 *   appended wakes that recipient's streams (the workflow delivery path), and
 *   a claim or release on the session routes wakes them to re-check the
 *   fence. Nothing re-reads the inbox on a timer. A heartbeat comment keeps
 *   the connection open through idle timeouts, NAT and proxies, and re-checks
 *   the lease fence; it reads no messages.
 * - The per-connection lease re-check (every `heartbeatMs`, 5 s) is NOT a
 *   polling transport under the no-polling rule: it reads one lease row and
 *   never a message, so no message is ever found by it; it exists only while
 *   a connection is open (O(open streams), independent of message volume);
 *   and it bounds how long a stream fenced by something that does not wake
 *   this process (lease expiry, a row changed by another server process or
 *   by hand) keeps serving: at most one heartbeat. Messages are only read
 *   after a wake. If open streams ever make it matter, the fence check moves
 *   onto the same LISTEN/NOTIFY seam multi-replica wakeups need (`wake`).
 * - A slow consumer is bounded: at most `maxBufferedBytes` (plus one event)
 *   are queued for a connection; a consumer that does not drain within
 *   `stallMs` is disconnected and resumes from its own Last-Event-ID.
 * - Reading the stream is not the ACK, and the ACK is not completion: the
 *   recipient acknowledges on the existing recipient route.
 *
 * SECURITY: the bearer identity must be the path's supervisor (bound to its
 * configured principal), and the request must present the fence of that
 * supervisor's unreleased inbox-stream lease: one holder at a time. A newer
 * claim (a takeover) fences an open stream at its next wake or heartbeat.
 * Nothing here takes a path or URL from the request, and no error carries a
 * token, path or driver detail.
 */

export const SUPERVISOR_INBOX_EVENT_SCHEMA =
  "supervisor-inbox-event.v1" as const;
export const SUPERVISOR_INBOX_TABLE = "loop_supervisor_inbox_v1" as const;
/** The fixed transient-failure reason of a full inbox. */
export const SUPERVISOR_INBOX_FULL_REASON = "recipient inbox is full" as const;

/** One SSE `message` event's data. */
export interface SupervisorInboxEvent {
  /** When the server accepted it into the inbox (provider acceptance). */
  appendedAt: string;
  envelope: SupervisorMessageV2DeliveryEnvelope;
  schema: typeof SUPERVISOR_INBOX_EVENT_SCHEMA;
  /** The ledger sequence: the SSE event id. */
  seq: number;
}

export interface SupervisorInboxEntry {
  appendedAt: string;
  envelope: SupervisorMessageV2DeliveryEnvelope;
  seq: number;
}

export type SupervisorInboxAppendResult =
  | { seq: number; status: "appended" | "duplicate" }
  | { status: "full" };

export interface SupervisorInboxStore {
  /** Durable acceptance of one envelope for `recipient` (its target). */
  append(
    envelope: SupervisorMessageV2DeliveryEnvelope
  ): Promise<SupervisorInboxAppendResult>;
  close(): Promise<void>;
  migrate?(): Promise<void>;
  /** Non-terminal entries after `after`, in sequence order, at most `limit`. */
  read(input: {
    after: number;
    limit: number;
    recipient: string;
    tenantId: string;
  }): Promise<readonly SupervisorInboxEntry[]>;
}

export interface SupervisorInboxStoreLimits {
  /** Unacknowledged entries one recipient may hold. */
  maxPending: number;
  /** How long a terminal (acknowledged...) entry stays before pruning. */
  terminalRetentionMs: number;
}

export const SUPERVISOR_INBOX_STORE_DEFAULTS: SupervisorInboxStoreLimits = {
  maxPending: 1000,
  terminalRetentionMs: 3_600_000,
};

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const START_INTENT_TABLE = "loop_supervisor_message_v2_start_intent";

const positiveSafe = (value: unknown, field: string): number => {
  if (!(Number.isSafeInteger(value) && Number(value) >= 1)) {
    throw new Error(`inbox ${field} is invalid`);
  }
  return Number(value);
};

const scopeOf = (envelope: SupervisorMessageV2DeliveryEnvelope) => ({
  principal: envelope.principal,
  tenantId: envelope.tenantId,
});

/**
 * The canonical envelope parser with the envelope's own scope: its delivery
 * id must be the one derived from that scope, workflow and attempt.
 */
export const parseSupervisorInboxEnvelope = (
  value: unknown
): SupervisorMessageV2DeliveryEnvelope => {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return parseSupervisorMessageV2DeliveryEnvelope(value, {
    principal: String(record.principal),
    tenantId: String(record.tenantId),
  });
};

/**
 * The PostgreSQL inbox. The envelope is stored as text (the canonical JSON),
 * not jsonb: this client binds `${text}::jsonb` as a JSON string scalar.
 * Terminal state is read from the V2 ledger's own start intents (the same
 * database), never duplicated here.
 */
export class PostgresSupervisorInboxStore implements SupervisorInboxStore {
  readonly #sql: SQL;
  readonly #limits: SupervisorInboxStoreLimits;

  private constructor(sql: SQL, limits: SupervisorInboxStoreLimits) {
    this.#sql = sql;
    this.#limits = limits;
  }

  static async connect(
    databaseUrl: string,
    limits: Partial<SupervisorInboxStoreLimits> = {}
  ): Promise<PostgresSupervisorInboxStore> {
    if (!POSTGRES_URL.test(databaseUrl)) {
      throw new Error("inbox store needs an explicit PostgreSQL URL");
    }
    const resolved = {
      maxPending: positiveSafe(
        limits.maxPending ?? SUPERVISOR_INBOX_STORE_DEFAULTS.maxPending,
        "maxPending"
      ),
      terminalRetentionMs: positiveSafe(
        limits.terminalRetentionMs ??
          SUPERVISOR_INBOX_STORE_DEFAULTS.terminalRetentionMs,
        "terminalRetentionMs"
      ),
    };
    const sql = new SQL(databaseUrl);
    await sql.connect();
    return new PostgresSupervisorInboxStore(sql, resolved);
  }

  async migrate(): Promise<void> {
    await this.#sql.unsafe(`CREATE TABLE IF NOT EXISTS ${SUPERVISOR_INBOX_TABLE} (
      seq BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      envelope_text TEXT NOT NULL,
      appended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, recipient, workflow_id)
    )`);
    await this.#sql.unsafe(
      `CREATE INDEX IF NOT EXISTS ${SUPERVISOR_INBOX_TABLE}_recipient_seq ON ${SUPERVISOR_INBOX_TABLE} (tenant_id, recipient, seq)`
    );
  }

  async append(
    envelopeValue: SupervisorMessageV2DeliveryEnvelope
  ): Promise<SupervisorInboxAppendResult> {
    const envelope = parseSupervisorMessageV2DeliveryEnvelope(
      envelopeValue,
      scopeOf(envelopeValue)
    );
    const tenantId = envelope.tenantId;
    const recipient = envelope.target;
    const text = JSON.stringify(envelope);
    const retentionSeconds = this.#limits.terminalRetentionMs / 1000;
    return await this.#sql.begin(async (sql) => {
      // One writer per recipient at a time: sequence numbers commit in order.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${SUPERVISOR_INBOX_TABLE}\n${tenantId}\n${recipient}`}, 0))`;
      const existing = await sql<
        { seq: string }[]
      >`SELECT seq::text AS seq FROM loop_supervisor_inbox_v1 WHERE tenant_id = ${tenantId} AND recipient = ${recipient} AND workflow_id = ${envelope.workflowId}`;
      if (existing[0]) {
        return { seq: Number(existing[0].seq), status: "duplicate" as const };
      }
      await sql.unsafe(
        `DELETE FROM ${SUPERVISOR_INBOX_TABLE} i WHERE i.tenant_id = $1 AND i.recipient = $2 AND i.appended_at < now() - make_interval(secs => $3::double precision) AND EXISTS (SELECT 1 FROM ${START_INTENT_TABLE} s WHERE s.workflow_id = i.workflow_id AND s.tenant_id = i.tenant_id AND s.terminal_outcome IS NOT NULL)`,
        [tenantId, recipient, retentionSeconds]
      );
      const pending = await sql.unsafe<{ pending: string }[]>(
        `SELECT count(*)::text AS pending FROM ${SUPERVISOR_INBOX_TABLE} i WHERE i.tenant_id = $1 AND i.recipient = $2 AND NOT EXISTS (SELECT 1 FROM ${START_INTENT_TABLE} s WHERE s.workflow_id = i.workflow_id AND s.tenant_id = i.tenant_id AND s.terminal_outcome IS NOT NULL)`,
        [tenantId, recipient]
      );
      if (Number(pending[0]?.pending ?? 0) >= this.#limits.maxPending) {
        return { status: "full" as const };
      }
      const inserted = await sql<
        { seq: string }[]
      >`INSERT INTO loop_supervisor_inbox_v1 (tenant_id, recipient, workflow_id, envelope_text) VALUES (${tenantId}, ${recipient}, ${envelope.workflowId}, ${text}) RETURNING seq::text AS seq`;
      return { seq: Number(inserted[0]?.seq), status: "appended" as const };
    });
  }

  async read(input: {
    after: number;
    limit: number;
    recipient: string;
    tenantId: string;
  }): Promise<readonly SupervisorInboxEntry[]> {
    if (!(Number.isSafeInteger(input.after) && input.after >= 0)) {
      throw new Error("inbox cursor is invalid");
    }
    const limit = positiveSafe(input.limit, "limit");
    const rows = await this.#sql.unsafe<
      { appended_at: Date; envelope_text: string; seq: string }[]
    >(
      `SELECT i.seq::text AS seq, i.envelope_text, i.appended_at FROM ${SUPERVISOR_INBOX_TABLE} i WHERE i.tenant_id = $1 AND i.recipient = $2 AND i.seq > $3::bigint AND NOT EXISTS (SELECT 1 FROM ${START_INTENT_TABLE} s WHERE s.workflow_id = i.workflow_id AND s.tenant_id = i.tenant_id AND s.terminal_outcome IS NOT NULL) ORDER BY i.seq LIMIT $4::integer`,
      [input.tenantId, input.recipient, String(input.after), limit]
    );
    return rows.map((row) => ({
      appendedAt: new Date(row.appended_at).toISOString(),
      envelope: parseSupervisorInboxEnvelope(JSON.parse(row.envelope_text)),
      seq: Number(row.seq),
    }));
  }

  async close(): Promise<void> {
    await this.#sql.close({ timeout: 0 });
  }
}

/* ---------------------------------------------------------------------------
 * Presence and wakeups (in-process).
 * ------------------------------------------------------------------------- */

const presenceKey = (
  tenantId: string,
  recipient: string,
  fence: SupervisorEndpointLeaseFence
): string => `${tenantId}\n${recipient}\n${fence.epoch}\n${fence.holderRef}`;

const recipientKey = (tenantId: string, recipient: string): string =>
  `${tenantId}\n${recipient}`;

/**
 * Whether the holder of a fence is connected: a stream is open now, or one
 * closed within `graceMs` (a phone that sleeps briefly, a reconnect). This
 * is the inbox-stream kind's no-turn probe: the lease sweep renews a lease
 * whose holder is present and lets an absent one's TTL lapse.
 */
export class SupervisorInboxPresence {
  readonly #graceMs: number;
  readonly #now: () => number;
  readonly #open = new Map<string, number>();
  readonly #lastSeen = new Map<string, number>();

  constructor(options: { graceMs?: number; now?: () => number } = {}) {
    this.#graceMs = options.graceMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  /** Marks a stream open; the returned function closes it (idempotent). */
  open(
    tenantId: string,
    recipient: string,
    fence: SupervisorEndpointLeaseFence
  ): () => void {
    const key = presenceKey(tenantId, recipient, fence);
    this.#open.set(key, (this.#open.get(key) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) {
        return;
      }
      closed = true;
      const remaining = (this.#open.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.#open.set(key, remaining);
      } else {
        this.#open.delete(key);
      }
      this.#lastSeen.set(key, this.#now());
      this.#prune();
    };
  }

  isPresent(
    tenantId: string,
    recipient: string,
    fence: SupervisorEndpointLeaseFence
  ): boolean {
    const key = presenceKey(tenantId, recipient, fence);
    if ((this.#open.get(key) ?? 0) > 0) {
      return true;
    }
    const seen = this.#lastSeen.get(key);
    return seen !== undefined && this.#now() - seen <= this.#graceMs;
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, seen] of this.#lastSeen) {
      if (now - seen > this.#graceMs) {
        this.#lastSeen.delete(key);
      }
    }
  }
}

export type SupervisorInboxWait = "aborted" | "timeout" | "wake";

/**
 * The store, the presence and the wakeups one server shares between the
 * inbox-stream delivery adapter and the stream route. The store is attached
 * once the V2 service has opened it and detached when the service closes,
 * which also ends every open stream.
 */
export class SupervisorInboxStreamHub {
  readonly presence: SupervisorInboxPresence;
  #store: SupervisorInboxStore | undefined;
  readonly #generation = new Map<string, number>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #streams = new Set<AbortController>();

  constructor(options: { presence?: SupervisorInboxPresence } = {}) {
    this.presence = options.presence ?? new SupervisorInboxPresence();
  }

  attach(store: SupervisorInboxStore): void {
    this.#store = store;
  }

  /** Ends every open stream; nothing is appended or read afterwards. */
  detach(): void {
    this.#store = undefined;
    for (const stream of this.#streams) {
      stream.abort();
    }
    this.#streams.clear();
  }

  store(): SupervisorInboxStore | undefined {
    return this.#store;
  }

  /** Accepts one envelope and wakes its recipient's streams. */
  async append(
    envelope: SupervisorMessageV2DeliveryEnvelope
  ): Promise<SupervisorInboxAppendResult | undefined> {
    const store = this.#store;
    if (!store) {
      return undefined;
    }
    const result = await store.append(envelope);
    if (result.status !== "full") {
      this.wake(envelope.tenantId, envelope.target);
    }
    return result;
  }

  generation(tenantId: string, recipient: string): number {
    return this.#generation.get(recipientKey(tenantId, recipient)) ?? 0;
  }

  /** New entries, or a lease change, for this recipient. */
  wake(tenantId: string, recipient: string): void {
    const key = recipientKey(tenantId, recipient);
    this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1);
    const waiters = this.#waiters.get(key);
    this.#waiters.delete(key);
    for (const waiter of waiters ?? []) {
      waiter();
    }
  }

  /**
   * Resolves at once when the recipient was woken since `seen` (a
   * generation read before the caller's last read), otherwise on the next
   * wake, after `timeoutMs`, or when `signal` aborts.
   */
  waitForWake(
    tenantId: string,
    recipient: string,
    seen: number,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<SupervisorInboxWait> {
    if (signal.aborted) {
      return Promise.resolve("aborted");
    }
    if (this.generation(tenantId, recipient) !== seen) {
      return Promise.resolve("wake");
    }
    const key = recipientKey(tenantId, recipient);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: SupervisorInboxWait) => {
        if (timer) {
          clearTimeout(timer);
        }
        signal.removeEventListener("abort", onAbort);
        this.#waiters.get(key)?.delete(onWake);
        resolve(outcome);
      };
      const onWake = () => settle("wake");
      const onAbort = () => settle("aborted");
      const waiters = this.#waiters.get(key) ?? new Set();
      waiters.add(onWake);
      this.#waiters.set(key, waiters);
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => settle("timeout"), timeoutMs);
    });
  }

  /** Registers an open stream so `detach` can end it. */
  track(stream: AbortController): () => void {
    this.#streams.add(stream);
    return () => {
      this.#streams.delete(stream);
    };
  }
}

/* ---------------------------------------------------------------------------
 * The route: GET {routePath}/sessions/<slug>/inbox.
 * ------------------------------------------------------------------------- */

export interface SupervisorInboxStreamLimits {
  /** Idle interval of the keepalive comment and the fence re-check (one
   * lease row, never a message; see the module comment on the no-polling
   * rule). Below Bun.serve's default 10 s idle timeout. */
  heartbeatMs: number;
  /** Bytes queued for one connection before the server waits for a drain. */
  maxBufferedBytes: number;
  /** Entries read per wake. */
  readBatch: number;
  /** The client's reconnect delay (the SSE `retry` field). */
  retryMs: number;
  /** How long a full connection may wait for its consumer to drain. */
  stallMs: number;
}

export const SUPERVISOR_INBOX_STREAM_DEFAULTS: SupervisorInboxStreamLimits = {
  heartbeatMs: 5000,
  maxBufferedBytes: 256 * 1024,
  readBatch: 100,
  retryMs: 2000,
  stallMs: 30_000,
};

export interface SupervisorInboxStreamHandlerOptions {
  /** Any configured supervisor identity (the control-surface tokens). */
  authenticator: SupervisorA2AAuthenticator;
  hub: SupervisorInboxStreamHub;
  /** Undefined when no lease store is available: 503. */
  leases(): Pick<SupervisorEndpointLeaseReader, "resolve"> | undefined;
  limits?: Partial<SupervisorInboxStreamLimits>;
  principalForRecipient(recipient: string): string | undefined;
  tenant: string;
}

const LAST_EVENT_ID_RE = /^(?:0|[1-9]\d{0,15})$/;
const EPOCH_RE = /^[1-9]\d{0,15}$/;

const routeError = (
  code: Exclude<A2AV2RouteErrorCode, "lease-fenced" | "lease-held">,
  headers?: HeadersInit
): Response =>
  Response.json(
    { error: { code } },
    {
      headers: { "cache-control": "no-store", ...headers },
      status: A2A_V2_ROUTE_ERROR_STATUS[code],
    }
  );

const fencedResponse = (reason: SupervisorEndpointLeaseFenceRefusal) =>
  Response.json(
    { error: { code: "lease-fenced", reason } },
    {
      headers: { "cache-control": "no-store" },
      status: A2A_V2_ROUTE_ERROR_STATUS["lease-fenced"],
    }
  );

const requestFence = (
  request: Request
): SupervisorEndpointLeaseFence | undefined => {
  const epoch = request.headers.get(A2A_V2_LEASE_EPOCH_HEADER) ?? "";
  const holderRef = request.headers.get(A2A_V2_LEASE_HOLDER_HEADER) ?? "";
  if (!EPOCH_RE.test(epoch)) {
    return undefined;
  }
  try {
    return requireSupervisorEndpointLeaseFence({
      epoch: Number(epoch),
      holderRef,
    });
  } catch {
    return undefined;
  }
};

/** Undefined without the header, null when it is not a sequence number. */
const lastEventId = (request: Request): number | null | undefined => {
  const value = request.headers.get("last-event-id");
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  return LAST_EVENT_ID_RE.test(trimmed) && Number.isSafeInteger(Number(trimmed))
    ? Number(trimmed)
    : null;
};

type FenceCheck = "ok" | "unavailable" | SupervisorEndpointLeaseFenceRefusal;

const checkInboxFence = async (input: {
  fence: SupervisorEndpointLeaseFence;
  leases: Pick<SupervisorEndpointLeaseReader, "resolve">;
  principal: string;
  recipient: string;
  tenant: string;
}): Promise<FenceCheck> => {
  let resolution: Awaited<ReturnType<SupervisorEndpointLeaseReader["resolve"]>>;
  try {
    resolution = await input.leases.resolve(input.tenant, input.recipient);
  } catch {
    return "unavailable";
  }
  if (resolution.state === "none") {
    return "absent";
  }
  const lease = resolution.lease;
  // Only this seat's own inbox-stream lease: any other kind is delivered
  // elsewhere, and its fence names no stream.
  if (
    lease.kind !== "inbox-stream" ||
    lease.recipient !== input.recipient ||
    lease.tenantId !== input.tenant ||
    lease.principal !== input.principal
  ) {
    return "absent";
  }
  // Expiry alone never fences: the holder may reconnect, and the lease sweep
  // renews a lease whose holder is present again.
  return decideSupervisorEndpointLeaseFence(lease, input.fence);
};

const encoder = new TextEncoder();

export const supervisorInboxEventFrame = (
  entry: SupervisorInboxEntry
): string => {
  const event: SupervisorInboxEvent = {
    appendedAt: entry.appendedAt,
    envelope: entry.envelope,
    schema: SUPERVISOR_INBOX_EVENT_SCHEMA,
    seq: entry.seq,
  };
  // JSON.stringify escapes every newline, so the data is one line.
  return `id: ${entry.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
};

interface InboxStreamSession {
  after: number;
  fence: SupervisorEndpointLeaseFence;
  identity: SupervisorA2AAuthenticatedIdentity;
  leases: Pick<SupervisorEndpointLeaseReader, "resolve">;
  principal: string;
  recipient: string;
}

/** Method, bearer, identity, fence headers and cursor; or the refusal. */
const acceptInboxRequest = async (
  options: SupervisorInboxStreamHandlerOptions,
  request: Request,
  supervisorId: string
): Promise<InboxStreamSession | Response> => {
  if (request.method !== "GET") {
    return routeError("method-not-allowed", { allow: "GET" });
  }
  let identity: SupervisorA2AAuthenticatedIdentity | undefined;
  try {
    identity = await options.authenticator.authenticate(request);
  } catch {
    return routeError("authentication-failed");
  }
  if (!identity) {
    return routeError("unauthenticated");
  }
  // A token streams only its own seat's inbox.
  const principal = options.principalForRecipient(identity.supervisorId);
  if (
    identity.supervisorId !== supervisorId ||
    principal === undefined ||
    principal !== identity.principal
  ) {
    return routeError("identity-mismatch");
  }
  const fence = requestFence(request);
  const after = lastEventId(request);
  if (!fence || after === null) {
    return routeError("request-invalid");
  }
  const leases = options.leases();
  if (!(leases && options.hub.store())) {
    return routeError("v2-unavailable");
  }
  const check = await checkInboxFence({
    fence,
    leases,
    principal,
    recipient: supervisorId,
    tenant: options.tenant,
  });
  if (check === "unavailable") {
    return routeError("v2-unavailable");
  }
  if (check !== "ok") {
    return fencedResponse(check);
  }
  return {
    after: after ?? 0,
    fence,
    identity,
    leases,
    principal,
    recipient: supervisorId,
  };
};

/**
 * One open stream: a byte queue bounded by `maxBufferedBytes`, and the pump
 * that fills it from the inbox on each wake.
 */
class InboxSseConnection {
  readonly stream: ReadableStream<Uint8Array>;
  readonly #abort = new AbortController();
  readonly #hub: SupervisorInboxStreamHub;
  readonly #limits: SupervisorInboxStreamLimits;
  readonly #session: InboxStreamSession;
  readonly #tenant: string;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #drained: (() => void) | undefined;
  #closed = false;
  #cursor: number;

  constructor(input: {
    hub: SupervisorInboxStreamHub;
    limits: SupervisorInboxStreamLimits;
    session: InboxStreamSession;
    signal?: AbortSignal;
    tenant: string;
  }) {
    this.#hub = input.hub;
    this.#limits = input.limits;
    this.#session = input.session;
    this.#tenant = input.tenant;
    this.#cursor = input.session.after;
    input.signal?.addEventListener("abort", () => this.#abort.abort(), {
      once: true,
    });
    this.stream = new ReadableStream<Uint8Array>(
      {
        cancel: () => {
          this.#closed = true;
          this.#abort.abort();
        },
        pull: () => {
          const resolve = this.#drained;
          this.#drained = undefined;
          resolve?.();
        },
        start: (controller) => {
          this.#controller = controller;
        },
      },
      {
        highWaterMark: input.limits.maxBufferedBytes,
        size: (chunk) => chunk?.byteLength ?? 0,
      }
    );
  }

  start(): void {
    const untrack = this.#hub.track(this.#abort);
    const { recipient, fence } = this.#session;
    const leave = this.#hub.presence.open(this.#tenant, recipient, fence);
    this.#pump()
      .catch(() => undefined)
      .finally(() => {
        leave();
        untrack();
        this.#close();
      });
  }

  #close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#controller.close();
    } catch {
      // Already cancelled by the consumer.
    }
  }

  #waitForDrain(): Promise<boolean> {
    return new Promise((resolve) => {
      if ((this.#controller.desiredSize ?? 1) > 0) {
        resolve(true);
        return;
      }
      const signal = this.#abort.signal;
      const settle = (outcome: boolean) => {
        clearTimeout(timer);
        this.#drained = undefined;
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => settle(false);
      const timer = setTimeout(() => settle(false), this.#limits.stallMs);
      this.#drained = () => settle(true);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #open(): boolean {
    return !(this.#abort.signal.aborted || this.#closed);
  }

  /**
   * Queues one frame, or reports why not. The queue never holds more than
   * `maxBufferedBytes` plus one frame: past that, a consumer that does not
   * drain within `stallMs` is disconnected.
   */
  async #write(frame: string): Promise<boolean> {
    if (!this.#open()) {
      return false;
    }
    if (
      (this.#controller.desiredSize ?? 1) <= 0 &&
      !(await this.#waitForDrain())
    ) {
      if (this.#open()) {
        // Queued behind what the consumer has not read; it reconnects from
        // its own Last-Event-ID either way.
        this.#controller.enqueue(
          encoder.encode("event: overflow\ndata: {}\n\n")
        );
      }
      return false;
    }
    if (!this.#open()) {
      return false;
    }
    this.#controller.enqueue(encoder.encode(frame));
    return true;
  }

  async #pump(): Promise<void> {
    if (!(await this.#write(`retry: ${this.#limits.retryMs}\n\n`))) {
      return;
    }
    let read = true;
    while (this.#open()) {
      const next = await this.#step(read);
      if (next === "stop") {
        return;
      }
      read = next === "read";
    }
  }

  /**
   * One pass: re-check the fence, send what is new when `read`, then wait
   * for a wake (read again) or the heartbeat (fence only, no read).
   */
  async #step(read: boolean): Promise<"read" | "stop" | "wait"> {
    const { recipient } = this.#session;
    const seen = this.#hub.generation(this.#tenant, recipient);
    const check = await checkInboxFence({
      fence: this.#session.fence,
      leases: this.#session.leases,
      principal: this.#session.principal,
      recipient,
      tenant: this.#tenant,
    });
    if (check !== "ok") {
      if (check !== "unavailable") {
        await this.#write(
          `event: fenced\ndata: ${JSON.stringify({ reason: check })}\n\n`
        );
      }
      return "stop";
    }
    if (read) {
      const sent = await this.#sendBatch();
      if (sent !== "drained") {
        return sent === "more" ? "read" : "stop";
      }
    }
    const outcome = await this.#hub.waitForWake(
      this.#tenant,
      recipient,
      seen,
      this.#limits.heartbeatMs,
      this.#abort.signal
    );
    if (outcome === "aborted") {
      return "stop";
    }
    if (outcome === "timeout") {
      return (await this.#write(": keepalive\n\n")) ? "wait" : "stop";
    }
    return "read";
  }

  /** Sends one batch after the cursor: more may follow, or not, or stop. */
  async #sendBatch(): Promise<"drained" | "more" | "stop"> {
    const store = this.#hub.store();
    if (!store) {
      return "stop";
    }
    const batch = await store.read({
      after: this.#cursor,
      limit: this.#limits.readBatch,
      recipient: this.#session.recipient,
      tenantId: this.#tenant,
    });
    for (const entry of batch) {
      if (!(await this.#write(supervisorInboxEventFrame(entry)))) {
        return "stop";
      }
      this.#cursor = entry.seq;
    }
    return batch.length >= this.#limits.readBatch ? "more" : "drained";
  }
}

export const createSupervisorInboxStreamHandler = (
  options: SupervisorInboxStreamHandlerOptions
): ((request: Request, supervisorId: string) => Promise<Response>) => {
  const limits: SupervisorInboxStreamLimits = {
    ...SUPERVISOR_INBOX_STREAM_DEFAULTS,
    ...options.limits,
  };
  return async (request, supervisorId) => {
    const session = await acceptInboxRequest(options, request, supervisorId);
    if (session instanceof Response) {
      return session;
    }
    const connection = new InboxSseConnection({
      hub: options.hub,
      limits,
      session,
      signal: request.signal,
      tenant: options.tenant,
    });
    connection.start();
    return new Response(connection.stream, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
      status: 200,
    });
  };
};
