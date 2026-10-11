import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";
import type {
  SupervisorSessionDescriptorV2,
  SupervisorSessionProviderV2,
} from "./supervisor-session-v2";

/**
 * r9 shared contract: which live session currently holds a supervisor's
 * endpoint. Types, the store interface and pure helpers only. The PostgreSQL
 * store (T1) implements `SupervisorEndpointLeaseStore`; the endpoint delivery
 * ports (T2), server routes (T3) and clients (T4) consume it. Nothing here
 * opens a connection, reads a file, or probes a provider.
 *
 * One row per (tenant, recipient) in `loop_supervisor_endpoint_lease_v2`.
 * `epoch` only grows (a successful claim bumps it; renew and release never
 * do), and (epoch, holderRef) is the fence every renew and release must
 * present. A lease is evidence of WHERE to deliver. It is never delivery,
 * acknowledgement, or completion.
 */
export const SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA =
  "supervisor-endpoint-lease.v2" as const;
export const SUPERVISOR_ENDPOINT_LEASE_V2_TABLE =
  "loop_supervisor_endpoint_lease_v2" as const;

/** Same bounds as `a2aV2.sessionTtlMs`; the server defaults to that value. */
export const SUPERVISOR_ENDPOINT_LEASE_MIN_TTL_MS = 1000;
export const SUPERVISOR_ENDPOINT_LEASE_MAX_TTL_MS = 86_400_000;

export const SUPERVISOR_ENDPOINT_KINDS = [
  "loop-run",
  "claude-channel",
  "codex-thread",
] as const;
export type SupervisorEndpointKind = (typeof SUPERVISOR_ENDPOINT_KINDS)[number];

/** A Loop run seat. The bridge directory resolves {runDir, seat} from it. */
export interface SupervisorEndpointLoopRunLocator {
  kind: "loop-run";
  /** Absolute, normalized run directory (the one holding manifest.json). */
  runDir: string;
  seat: "claude" | "codex";
}

/** A standalone Claude Code session served by `__bridge-mcp <sessionDir> claude`. */
export interface SupervisorEndpointClaudeChannelLocator {
  kind: "claude-channel";
  /** Absolute, normalized bridge session directory. */
  sessionDir: string;
}

/** A Codex app-server thread, probed with read/resume and never a turn. */
export interface SupervisorEndpointCodexThreadLocator {
  kind: "codex-thread";
  /** Loopback ws:// or wss:// URL with no credentials, query or fragment. */
  remoteUrl: string;
  threadId: string;
}

export type SupervisorEndpointLocator =
  | SupervisorEndpointClaudeChannelLocator
  | SupervisorEndpointCodexThreadLocator
  | SupervisorEndpointLoopRunLocator;

/** The pair every renew and release must present. */
export interface SupervisorEndpointLeaseFence {
  epoch: number;
  holderRef: string;
}

/** One row, decoded. Timestamps are canonical UTC (`toISOString`). */
export interface SupervisorEndpointLeaseV2
  extends SupervisorEndpointLeaseFence {
  /** The descriptor this lease registered or rebound, in the seat's scope. */
  descriptorId: string;
  descriptorRevision: number;
  expiresAt: string;
  kind: SupervisorEndpointKind;
  locator: SupervisorEndpointLocator;
  /** principalFor(recipient): the seat's own scope, never the sender's. */
  principal: string;
  recipient: string;
  /** Null while unreleased. A released row keeps its epoch for the next claim. */
  releasedAt: null | string;
  schema: typeof SUPERVISOR_ENDPOINT_LEASE_V2_SCHEMA;
  tenantId: string;
}

/**
 * live: unreleased and expiresAt > now. expired: unreleased and expiresAt <=
 * now (delivery defers within the not-enrolled bound). released: released.
 * none: no row (never claimed).
 */
export type SupervisorEndpointLeaseState = "expired" | "live" | "released";

export type SupervisorEndpointLeaseResolution =
  | { lease: SupervisorEndpointLeaseV2; state: SupervisorEndpointLeaseState }
  | { state: "none" };

export interface SupervisorEndpointLeaseClaimInput {
  holderRef: string;
  locator: SupervisorEndpointLocator;
  recipient: string;
  /** {tenant, principalFor(recipient)}: the authenticated seat's own scope. */
  scope: TrustedSupervisorMessageV2Scope;
  /** session:<claude session id | codex thread id>; becomes the descriptor's sessionRef. */
  sessionRef: string;
  /** Evict a live lease held by another holder (operator `--takeover`). */
  takeover?: boolean;
  ttlMs: number;
}

export interface SupervisorEndpointLeaseRenewInput {
  fence: SupervisorEndpointLeaseFence;
  recipient: string;
  scope: TrustedSupervisorMessageV2Scope;
  ttlMs: number;
}

export interface SupervisorEndpointLeaseReleaseInput {
  fence: SupervisorEndpointLeaseFence;
  recipient: string;
  scope: TrustedSupervisorMessageV2Scope;
}

/** What a refused caller may learn about the row that refused it. */
export interface SupervisorEndpointLeaseHolderSummary
  extends SupervisorEndpointLeaseFence {
  expiresAt: string;
  state: SupervisorEndpointLeaseState;
}

export type SupervisorEndpointLeaseClaimResult =
  | {
      descriptor: SupervisorSessionDescriptorV2;
      lease: SupervisorEndpointLeaseV2;
      /** The row this claim replaced, or null for a first claim. */
      previous: null | SupervisorEndpointLeaseHolderSummary;
      status: "claimed";
      /** True only when a live lease of another holder was evicted. */
      tookOver: boolean;
    }
  | { current: SupervisorEndpointLeaseHolderSummary; status: "held" };

/**
 * Why a fence was refused. Expiry alone never fences: an expired, unreleased
 * lease whose epoch nobody bumped is still its holder's to renew or release.
 */
export type SupervisorEndpointLeaseFenceRefusal =
  | "absent"
  | "epoch-mismatch"
  | "holder-mismatch"
  | "released";

export type SupervisorEndpointLeaseRenewResult =
  | {
      descriptor: SupervisorSessionDescriptorV2;
      lease: SupervisorEndpointLeaseV2;
      status: "renewed";
    }
  | { reason: SupervisorEndpointLeaseFenceRefusal; status: "fenced" };

export type SupervisorEndpointLeaseReleaseResult =
  | {
      /** True when this call released it; false for an idempotent repeat. */
      changed: boolean;
      lease: SupervisorEndpointLeaseV2;
      status: "released";
    }
  | {
      reason: Exclude<SupervisorEndpointLeaseFenceRefusal, "released">;
      status: "fenced";
    };

/**
 * Implemented by T1 next to `PostgresSupervisorSessionV2Store` (its table is
 * created by that store's `migrate`). Contract:
 *
 * - claim: one transaction, `SELECT ... FOR UPDATE` on the row. Decided by
 *   `decideSupervisorEndpointLeaseClaim`. On success it bumps the epoch and
 *   registers, or rebinds through the existing rebind CAS, the descriptor
 *   `deriveSupervisorSessionDescriptorV2Id(scope, recipient)` with the fields
 *   of `supervisorEndpointDescriptorIdentity(locator, sessionRef)` and
 *   `expiresAt` equal to the lease's. Lease and descriptor commit together.
 * - renew/release: decided by `decideSupervisorEndpointLeaseFence`. Renew
 *   extends expiresAt (and renews the descriptor); release sets releasedAt.
 *   Neither changes epoch, holderRef, kind or locator.
 * - resolve/list: classify with the store's clock via
 *   `supervisorEndpointLeaseState`. list returns unreleased rows only (the
 *   enrollment sweep's work set), ordered by recipient.
 * - A store that cannot answer rejects with
 *   SupervisorMessageV2ReadinessUnavailableError (never a driver message);
 *   invalid input rejects with SupervisorEndpointLeaseError.
 */
export interface SupervisorEndpointLeaseStore {
  claim(
    input: SupervisorEndpointLeaseClaimInput
  ): Promise<SupervisorEndpointLeaseClaimResult>;
  list(tenantId: string): Promise<readonly SupervisorEndpointLeaseV2[]>;
  release(
    input: SupervisorEndpointLeaseReleaseInput
  ): Promise<SupervisorEndpointLeaseReleaseResult>;
  renew(
    input: SupervisorEndpointLeaseRenewInput
  ): Promise<SupervisorEndpointLeaseRenewResult>;
  resolve(
    tenantId: string,
    recipient: string
  ): Promise<SupervisorEndpointLeaseResolution>;
}

/** The read side every delivery and assignment path needs; no writes. */
export type SupervisorEndpointLeaseReader = Pick<
  SupervisorEndpointLeaseStore,
  "list" | "resolve"
>;

export class SupervisorEndpointLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorEndpointLeaseError";
  }
}

const RECIPIENT_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/;
const HOLDER_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,247}$/;
const SESSION_REF_RE = /^session:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
};

const canonicalDirectory = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    (value.length > 1 && value.endsWith("/"))
  ) {
    throw new SupervisorEndpointLeaseError(`${field} is invalid`);
  }
  return value;
};

const loopbackWebSocketUrl = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 2048) {
    throw new SupervisorEndpointLeaseError("remoteUrl is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SupervisorEndpointLeaseError("remoteUrl is invalid");
  }
  if (
    !(
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      LOOPBACK_HOSTS.has(url.hostname)
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    // Only the exact spelling the probe will use: no implicit normalization.
    (url.toString() !== value && url.toString() !== `${value}/`)
  ) {
    throw new SupervisorEndpointLeaseError("remoteUrl is invalid");
  }
  return value;
};

export const isSupervisorEndpointKind = (
  value: unknown
): value is SupervisorEndpointKind =>
  typeof value === "string" &&
  (SUPERVISOR_ENDPOINT_KINDS as readonly string[]).includes(value);

/** Strict decode: exact keys per kind, canonical paths, loopback Codex URL. */
export const parseSupervisorEndpointLocator = (
  value: unknown
): SupervisorEndpointLocator => {
  if (!(isRecord(value) && isSupervisorEndpointKind(value.kind))) {
    throw new SupervisorEndpointLeaseError("locator kind is invalid");
  }
  if (value.kind === "loop-run") {
    if (
      !(
        exactKeys(value, ["kind", "runDir", "seat"]) &&
        (value.seat === "claude" || value.seat === "codex")
      )
    ) {
      throw new SupervisorEndpointLeaseError("loop-run locator is invalid");
    }
    return {
      kind: "loop-run",
      runDir: canonicalDirectory(value.runDir, "runDir"),
      seat: value.seat,
    };
  }
  if (value.kind === "claude-channel") {
    if (!exactKeys(value, ["kind", "sessionDir"])) {
      throw new SupervisorEndpointLeaseError(
        "claude-channel locator is invalid"
      );
    }
    return {
      kind: "claude-channel",
      sessionDir: canonicalDirectory(value.sessionDir, "sessionDir"),
    };
  }
  if (
    !exactKeys(value, ["kind", "remoteUrl", "threadId"]) ||
    typeof value.threadId !== "string" ||
    !THREAD_ID_RE.test(value.threadId)
  ) {
    throw new SupervisorEndpointLeaseError("codex-thread locator is invalid");
  }
  return {
    kind: "codex-thread",
    remoteUrl: loopbackWebSocketUrl(value.remoteUrl),
    threadId: value.threadId,
  };
};

/** The descriptor endpointRef for a kind: `endpoint:<kind>`. */
export const supervisorEndpointRef = (kind: SupervisorEndpointKind): string =>
  `endpoint:${kind}`;

/**
 * sha256 hex of the locator's canonical JSON (sorted keys). A lease-backed
 * descriptor's endpointDigest must equal this; readiness re-derives it from
 * the lease and refuses on any mismatch.
 */
export const supervisorEndpointLocatorDigest = (
  locator: SupervisorEndpointLocator
): string => {
  const parsed = parseSupervisorEndpointLocator(locator);
  const sorted = Object.fromEntries(
    Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right))
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
};

export const supervisorEndpointProvider = (
  locator: SupervisorEndpointLocator
): SupervisorSessionProviderV2 => {
  if (locator.kind === "loop-run") {
    return locator.seat === "claude" ? "claude-code" : "codex-app-server";
  }
  return locator.kind === "claude-channel" ? "claude-code" : "codex-app-server";
};

/**
 * The descriptor fields a claim registers or rebinds. A Codex thread's
 * sessionRef must name that thread; other kinds carry the provider session id
 * the claimant observed (checked later by the kind's readiness probe).
 */
export const supervisorEndpointDescriptorIdentity = (
  locatorValue: SupervisorEndpointLocator,
  sessionRef: string
): Pick<
  SupervisorSessionDescriptorV2,
  "endpointDigest" | "endpointRef" | "provider" | "sessionRef"
> => {
  const locator = parseSupervisorEndpointLocator(locatorValue);
  requireSupervisorEndpointSessionRef(sessionRef);
  if (
    locator.kind === "codex-thread" &&
    sessionRef !== `session:${locator.threadId}`
  ) {
    throw new SupervisorEndpointLeaseError(
      "sessionRef does not name the Codex thread"
    );
  }
  return {
    endpointDigest: supervisorEndpointLocatorDigest(locator),
    endpointRef: supervisorEndpointRef(locator.kind),
    provider: supervisorEndpointProvider(locator),
    sessionRef,
  };
};

export const requireSupervisorEndpointSessionRef = (value: unknown): string => {
  if (typeof value !== "string" || !SESSION_REF_RE.test(value)) {
    throw new SupervisorEndpointLeaseError("sessionRef is invalid");
  }
  return value;
};

export const requireSupervisorEndpointRecipient = (value: unknown): string => {
  if (typeof value !== "string" || !RECIPIENT_RE.test(value)) {
    throw new SupervisorEndpointLeaseError("recipient is invalid");
  }
  return value;
};

export const requireSupervisorEndpointHolderRef = (value: unknown): string => {
  if (typeof value !== "string" || !HOLDER_REF_RE.test(value)) {
    throw new SupervisorEndpointLeaseError("holderRef is invalid");
  }
  return value;
};

export const requireSupervisorEndpointLeaseTtlMs = (value: unknown): number => {
  if (
    !(
      Number.isSafeInteger(value) &&
      Number(value) >= SUPERVISOR_ENDPOINT_LEASE_MIN_TTL_MS &&
      Number(value) <= SUPERVISOR_ENDPOINT_LEASE_MAX_TTL_MS
    )
  ) {
    throw new SupervisorEndpointLeaseError("ttlMs is invalid");
  }
  return Number(value);
};

export const requireSupervisorEndpointLeaseFence = (
  value: unknown
): SupervisorEndpointLeaseFence => {
  if (
    !(
      isRecord(value) &&
      Number.isSafeInteger(value.epoch) &&
      Number(value.epoch) >= 1
    )
  ) {
    throw new SupervisorEndpointLeaseError("fence is invalid");
  }
  return {
    epoch: Number(value.epoch),
    holderRef: requireSupervisorEndpointHolderRef(value.holderRef),
  };
};

export const supervisorEndpointLeaseState = (
  lease: Pick<SupervisorEndpointLeaseV2, "expiresAt" | "releasedAt">,
  now: Date
): SupervisorEndpointLeaseState => {
  if (lease.releasedAt !== null) {
    return "released";
  }
  return Date.parse(lease.expiresAt) > now.getTime() ? "live" : "expired";
};

export const resolveSupervisorEndpointLease = (
  lease: SupervisorEndpointLeaseV2 | undefined,
  now: Date
): SupervisorEndpointLeaseResolution =>
  lease
    ? { lease, state: supervisorEndpointLeaseState(lease, now) }
    : { state: "none" };

export const supervisorEndpointLeaseHolderSummary = (
  lease: SupervisorEndpointLeaseV2,
  now: Date
): SupervisorEndpointLeaseHolderSummary => ({
  epoch: lease.epoch,
  expiresAt: lease.expiresAt,
  holderRef: lease.holderRef,
  state: supervisorEndpointLeaseState(lease, now),
});

export type SupervisorEndpointLeaseClaimDecision =
  | { allowed: false; current: SupervisorEndpointLeaseHolderSummary }
  | { allowed: true; nextEpoch: number; tookOver: boolean };

/**
 * The claim rule, decided on the row read under `FOR UPDATE`. A live lease of
 * another holder refuses unless `takeover`; a live lease of the same holder,
 * an expired or released one, or no row, is claimable. Every allowed claim
 * bumps the epoch, which fences the previous holder's renew and release.
 */
export const decideSupervisorEndpointLeaseClaim = (
  current: SupervisorEndpointLeaseV2 | undefined,
  input: Pick<SupervisorEndpointLeaseClaimInput, "holderRef" | "takeover">,
  now: Date
): SupervisorEndpointLeaseClaimDecision => {
  const holderRef = requireSupervisorEndpointHolderRef(input.holderRef);
  if (!current) {
    return { allowed: true, nextEpoch: 1, tookOver: false };
  }
  if (!Number.isSafeInteger(current.epoch + 1)) {
    throw new SupervisorEndpointLeaseError("lease epoch is exhausted");
  }
  const contested =
    supervisorEndpointLeaseState(current, now) === "live" &&
    current.holderRef !== holderRef;
  if (contested && input.takeover !== true) {
    return {
      allowed: false,
      current: supervisorEndpointLeaseHolderSummary(current, now),
    };
  }
  return { allowed: true, nextEpoch: current.epoch + 1, tookOver: contested };
};

/**
 * The renew/release fence. Release of an already-released row with the same
 * fence is an idempotent success (`released`), so callers that must
 * distinguish check `lease.releasedAt` first; renew refuses it.
 */
export const decideSupervisorEndpointLeaseFence = (
  current: SupervisorEndpointLeaseV2 | undefined,
  fenceValue: SupervisorEndpointLeaseFence
): "ok" | SupervisorEndpointLeaseFenceRefusal => {
  const fence = requireSupervisorEndpointLeaseFence(fenceValue);
  if (!current) {
    return "absent";
  }
  if (current.epoch !== fence.epoch) {
    return "epoch-mismatch";
  }
  if (current.holderRef !== fence.holderRef) {
    return "holder-mismatch";
  }
  return current.releasedAt === null ? "ok" : "released";
};

/** The lease's expiry for a claim or renew at `now`. */
export const supervisorEndpointLeaseExpiresAt = (
  now: Date,
  ttlMs: number
): string =>
  new Date(
    now.getTime() + requireSupervisorEndpointLeaseTtlMs(ttlMs)
  ).toISOString();
