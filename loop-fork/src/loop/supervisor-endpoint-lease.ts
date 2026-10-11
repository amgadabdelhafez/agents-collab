import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
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
 * opens a connection or probes a provider; the locator resolver touches the
 * filesystem only through the `SupervisorEndpointFs` its caller injects.
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

/*
 * Locators are UNTRUSTED caller input. They carry ids only, never a path or a
 * URL. The server derives every path itself under its own roots
 * (`supervisorEndpointRoots(<server home>)`), realpath-checks containment, and
 * reads a Codex remote URL only from the server-derived run manifest
 * (`resolveSupervisorEndpointLocator`). Every consumer re-resolves the stored
 * locator on every claim, renew, readiness check, probe and delivery.
 */

/** A Loop run, by id: `<runsRoot>/<repoId>/<runId>`. */
export interface SupervisorEndpointRunRef {
  repoId: string;
  runId: string;
}

/** A Loop run seat. The server derives runDir from {repoId, runId}. */
export interface SupervisorEndpointLoopRunLocator
  extends SupervisorEndpointRunRef {
  kind: "loop-run";
  seat: "claude" | "codex";
}

/**
 * A standalone Claude Code session served by `__bridge-mcp <sessionDir> claude`.
 * The server derives `<sessionsRoot>/<supervisor slug>/<sessionId>` from the
 * lease's own recipient; a caller cannot name another supervisor's session.
 */
export interface SupervisorEndpointClaudeChannelLocator {
  kind: "claude-channel";
  sessionId: string;
}

/**
 * A Codex app-server thread of a Loop run, probed with read/resume and never a
 * turn. The remote URL is the run manifest's `codexRemoteUrl`, never the
 * caller's.
 */
export interface SupervisorEndpointCodexThreadLocator
  extends SupervisorEndpointRunRef {
  kind: "codex-thread";
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

/**
 * A locator the server refused to resolve. Callers learn only that it was
 * refused (the route body carries no reason); the reason is for logs.
 */
export interface SupervisorEndpointLocatorRefusedResult {
  reason: SupervisorEndpointLocatorRefusal;
  status: "locator-refused";
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
  | { current: SupervisorEndpointLeaseHolderSummary; status: "held" }
  | SupervisorEndpointLocatorRefusedResult;

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
  | { reason: SupervisorEndpointLeaseFenceRefusal; status: "fenced" }
  | SupervisorEndpointLocatorRefusedResult;

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
 * - Locators (SECURITY): the store is constructed with
 *   `SupervisorEndpointLeaseStoreDeps.resolveLocator` (the server's own
 *   `createSupervisorEndpointLocatorResolver`). claim resolves the input
 *   locator for the claimed recipient before it writes anything; renew
 *   re-resolves the STORED locator after the fence passes and, if it no
 *   longer resolves, extends nothing (the lease lapses by TTL). Either
 *   returns `locator-refused`. Release never resolves: a holder can always
 *   let go. resolve/list return rows as stored, so every reader re-resolves
 *   before it uses a locator (see the endpoint delivery contract).
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

/** Construction inputs T1's store takes beyond its database handle. */
export interface SupervisorEndpointLeaseStoreDeps {
  resolveLocator: SupervisorEndpointLocatorResolver;
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
/**
 * Path segments. None admits `/`, `\`, NUL, `.` or `..`: each starts with an
 * alphanumeric and the repo, run and session patterns carry no dot at all.
 * Repo ids are `sanitizeBase(label)-<hash>` (run-state.ts buildRepoId); run
 * ids are git.ts RUN_ID_RE, bounded.
 */
const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
/**
 * The only Codex remote URL shape delivery will dial: plain ws, literal
 * 127.0.0.1 or localhost, an explicit decimal port, nothing else (no
 * credentials, path, query or fragment). Matched on the raw string, so no URL
 * normalization (decimal or short IPv4, IPv6-mapped, case, percent-encoding,
 * userinfo) can turn another spelling into an accepted one.
 */
const CODEX_REMOTE_URL_RE =
  /^ws:\/\/(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})\/?$/;
const MAX_PORT = 65_535;
const SUPERVISOR_PREFIX = "supervisor:";

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

const requireId = (value: unknown, pattern: RegExp, field: string): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new SupervisorEndpointLeaseError(`${field} is invalid`);
  }
  return value;
};

export const requireSupervisorEndpointRepoId = (value: unknown): string =>
  requireId(value, REPO_ID_RE, "repoId");

export const requireSupervisorEndpointRunId = (value: unknown): string =>
  requireId(value, RUN_ID_RE, "runId");

export const requireSupervisorEndpointSessionId = (value: unknown): string =>
  requireId(value, SESSION_ID_RE, "sessionId");

export const requireSupervisorEndpointThreadId = (value: unknown): string =>
  requireId(value, THREAD_ID_RE, "threadId");

/**
 * The Codex remote URL delivery may dial, read from the server-derived run
 * manifest only. Accepts exactly `ws://127.0.0.1:<port>` or
 * `ws://localhost:<port>` (optional trailing `/`), port 1-65535. The adapter
 * must also refuse a redirect: a 3xx upgrade response is a failed probe.
 */
export const requireLoopbackCodexRemoteUrl = (value: unknown): string => {
  const match =
    typeof value === "string" ? CODEX_REMOTE_URL_RE.exec(value) : null;
  if (!match || Number(match[1]) > MAX_PORT) {
    throw new SupervisorEndpointLocatorError("remote-url-refused");
  }
  return value as string;
};

export const isSupervisorEndpointKind = (
  value: unknown
): value is SupervisorEndpointKind =>
  typeof value === "string" &&
  (SUPERVISOR_ENDPOINT_KINDS as readonly string[]).includes(value);

/**
 * Strict decode: exact keys per kind, every field an id matching its pattern.
 * A locator never carries a path or a URL, so a caller cannot point the
 * server at one.
 */
export const parseSupervisorEndpointLocator = (
  value: unknown
): SupervisorEndpointLocator => {
  if (!(isRecord(value) && isSupervisorEndpointKind(value.kind))) {
    throw new SupervisorEndpointLeaseError("locator kind is invalid");
  }
  if (value.kind === "loop-run") {
    if (
      !(
        exactKeys(value, ["kind", "repoId", "runId", "seat"]) &&
        (value.seat === "claude" || value.seat === "codex")
      )
    ) {
      throw new SupervisorEndpointLeaseError("loop-run locator is invalid");
    }
    return {
      kind: "loop-run",
      repoId: requireSupervisorEndpointRepoId(value.repoId),
      runId: requireSupervisorEndpointRunId(value.runId),
      seat: value.seat,
    };
  }
  if (value.kind === "claude-channel") {
    if (!exactKeys(value, ["kind", "sessionId"])) {
      throw new SupervisorEndpointLeaseError(
        "claude-channel locator is invalid"
      );
    }
    return {
      kind: "claude-channel",
      sessionId: requireSupervisorEndpointSessionId(value.sessionId),
    };
  }
  if (!exactKeys(value, ["kind", "repoId", "runId", "threadId"])) {
    throw new SupervisorEndpointLeaseError("codex-thread locator is invalid");
  }
  return {
    kind: "codex-thread",
    repoId: requireSupervisorEndpointRepoId(value.repoId),
    runId: requireSupervisorEndpointRunId(value.runId),
    threadId: requireSupervisorEndpointThreadId(value.threadId),
  };
};

/* ---------------------------------------------------------------------------
 * Server-side resolution (SECURITY). Every path is derived from the server's
 * own roots and the locator's ids, then realpath-checked; the Codex URL comes
 * from the derived manifest. The filesystem is injected, so this module still
 * reads nothing by itself: the server passes `{ realpath: realpathSync,
 * readJson }` and tests pass fixtures.
 * ------------------------------------------------------------------------- */

/** Why a locator did not resolve. For logs only; routes never echo it. */
export const SUPERVISOR_ENDPOINT_LOCATOR_REFUSALS = [
  "foreign-manifest",
  "invalid",
  "not-contained",
  "remote-url-refused",
  "thread-mismatch",
  "unresolved",
] as const;
export type SupervisorEndpointLocatorRefusal =
  (typeof SUPERVISOR_ENDPOINT_LOCATOR_REFUSALS)[number];

/** Fixed message: never a path, URL, id or errno. */
export class SupervisorEndpointLocatorError extends SupervisorEndpointLeaseError {
  readonly reason: SupervisorEndpointLocatorRefusal;
  constructor(reason: SupervisorEndpointLocatorRefusal) {
    super(`endpoint locator refused: ${reason}`);
    this.name = "SupervisorEndpointLocatorError";
    this.reason = reason;
  }
}

/** The server's own roots, from its own home. Never from a request. */
export interface SupervisorEndpointRoots {
  /** `<home>/.loop/runs`, the same root as run-state.ts resolveStorageRoot. */
  runsRoot: string;
  /** `<home>/.loop/sessions`, one directory per supervisor slug. */
  sessionsRoot: string;
}

const canonicalAbsolute = (value: unknown, field: string): string => {
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

export const supervisorEndpointRoots = (
  home: string
): SupervisorEndpointRoots => {
  const base = canonicalAbsolute(home, "home");
  return {
    runsRoot: join(base, ".loop", "runs"),
    sessionsRoot: join(base, ".loop", "sessions"),
  };
};

/** The recipient id without `supervisor:`; a single safe path segment. */
export const supervisorEndpointSlug = (supervisorId: string): string =>
  requireSupervisorEndpointRecipient(supervisorId).slice(
    SUPERVISOR_PREFIX.length
  );

/** `<runsRoot>/<repoId>/<runId>`, lexically. Containment is checked separately. */
export const supervisorEndpointRunDir = (
  roots: SupervisorEndpointRoots,
  ref: SupervisorEndpointRunRef
): string =>
  join(
    canonicalAbsolute(roots.runsRoot, "runsRoot"),
    requireSupervisorEndpointRepoId(ref.repoId),
    requireSupervisorEndpointRunId(ref.runId)
  );

/** `<sessionsRoot>/<supervisor slug>/<sessionId>`, lexically. */
export const supervisorEndpointSessionDir = (
  roots: SupervisorEndpointRoots,
  supervisorId: string,
  sessionId: string
): string =>
  join(
    canonicalAbsolute(roots.sessionsRoot, "sessionsRoot"),
    supervisorEndpointSlug(supervisorId),
    requireSupervisorEndpointSessionId(sessionId)
  );

/** The filesystem the resolver may touch. Both throw when the path is absent. */
export interface SupervisorEndpointFs {
  /** JSON.parse of a regular file's contents. */
  readJson(path: string): unknown;
  /** fs.realpathSync semantics. */
  realpath(path: string): string;
}

/**
 * Realpath containment: the real path of `root/segments...` must be EXACTLY
 * `realpath(root)/segments...`. That refuses a symlink escape and also any
 * symlink below the root (which could alias another repo's run or another
 * supervisor's session). The root itself may be a symlink. Returns the real
 * path.
 */
export const supervisorEndpointContainedRealpath = (
  fs: Pick<SupervisorEndpointFs, "realpath">,
  root: string,
  segments: readonly string[]
): string => {
  const lexicalRoot = canonicalAbsolute(root, "root");
  if (
    segments.length === 0 ||
    !segments.every((segment) => PATH_SEGMENT_RE.test(segment))
  ) {
    throw new SupervisorEndpointLocatorError("invalid");
  }
  let realRoot: string;
  let actual: string;
  try {
    realRoot = fs.realpath(lexicalRoot);
    actual = fs.realpath(join(lexicalRoot, ...segments));
  } catch {
    throw new SupervisorEndpointLocatorError("unresolved");
  }
  if (actual !== join(realRoot, ...segments)) {
    throw new SupervisorEndpointLocatorError("not-contained");
  }
  return actual;
};

/**
 * The run manifest field that names the supervisor a run serves. T4's
 * `--a2a-as supervisor:x` launch writes it; a run without it cannot be
 * claimed, renewed or delivered to as any supervisor.
 */
export const SUPERVISOR_ENDPOINT_MANIFEST_SUPERVISOR_FIELD =
  "a2aSupervisorId" as const;
export const SUPERVISOR_ENDPOINT_MANIFEST_FILE = "manifest.json" as const;

export interface SupervisorEndpointRunManifestFacts {
  codexRemoteUrl?: unknown;
  codexThreadId?: unknown;
  manifestPath: string;
  runDir: string;
}

/**
 * Derive and check a run: contained run directory and manifest, and a
 * manifest that names this repo, this run and the claiming supervisor. The
 * principal is never read from the manifest: it is principalFor(supervisorId)
 * from the server's own config.
 */
export const resolveSupervisorEndpointRun = (
  fs: SupervisorEndpointFs,
  roots: SupervisorEndpointRoots,
  ref: SupervisorEndpointRunRef,
  supervisorId: string
): SupervisorEndpointRunManifestFacts => {
  const repoId = requireSupervisorEndpointRepoId(ref.repoId);
  const runId = requireSupervisorEndpointRunId(ref.runId);
  requireSupervisorEndpointRecipient(supervisorId);
  const runDir = supervisorEndpointContainedRealpath(fs, roots.runsRoot, [
    repoId,
    runId,
  ]);
  const manifestPath = supervisorEndpointContainedRealpath(fs, roots.runsRoot, [
    repoId,
    runId,
    SUPERVISOR_ENDPOINT_MANIFEST_FILE,
  ]);
  let manifest: unknown;
  try {
    manifest = fs.readJson(manifestPath);
  } catch {
    throw new SupervisorEndpointLocatorError("unresolved");
  }
  if (
    !(
      isRecord(manifest) &&
      manifest.repoId === repoId &&
      manifest.runId === runId &&
      manifest[SUPERVISOR_ENDPOINT_MANIFEST_SUPERVISOR_FIELD] === supervisorId
    )
  ) {
    throw new SupervisorEndpointLocatorError("foreign-manifest");
  }
  return {
    codexRemoteUrl: manifest.codexRemoteUrl,
    codexThreadId: manifest.codexThreadId,
    manifestPath,
    runDir,
  };
};

/** What a stored locator resolves to, for the server's use only. */
export type ResolvedSupervisorEndpoint =
  | {
      kind: "loop-run";
      manifestPath: string;
      runDir: string;
      seat: "claude" | "codex";
    }
  | { kind: "claude-channel"; sessionDir: string }
  | {
      kind: "codex-thread";
      remoteUrl: string;
      runDir: string;
      threadId: string;
    };

export type ResolvedSupervisorEndpointOf<K extends SupervisorEndpointKind> =
  Extract<ResolvedSupervisorEndpoint, { kind: K }>;

export interface SupervisorEndpointResolveContext {
  fs: SupervisorEndpointFs;
  roots: SupervisorEndpointRoots;
  /** The lease's recipient (claim: the authenticated, body-matched id). */
  supervisorId: string;
}

/**
 * The one place a locator becomes a path or URL. Call it on every claim,
 * renew, readiness check, probe and delivery; never cache its result across
 * calls. Throws SupervisorEndpointLocatorError (fixed message) on refusal.
 */
export const resolveSupervisorEndpointLocator = (
  locatorValue: unknown,
  context: SupervisorEndpointResolveContext
): ResolvedSupervisorEndpoint => {
  let locator: SupervisorEndpointLocator;
  try {
    locator = parseSupervisorEndpointLocator(locatorValue);
    requireSupervisorEndpointRecipient(context.supervisorId);
  } catch {
    throw new SupervisorEndpointLocatorError("invalid");
  }
  if (locator.kind === "claude-channel") {
    const slug = supervisorEndpointSlug(context.supervisorId);
    return {
      kind: "claude-channel",
      sessionDir: supervisorEndpointContainedRealpath(
        context.fs,
        context.roots.sessionsRoot,
        [slug, locator.sessionId]
      ),
    };
  }
  const run = resolveSupervisorEndpointRun(
    context.fs,
    context.roots,
    locator,
    context.supervisorId
  );
  if (locator.kind === "loop-run") {
    return {
      kind: "loop-run",
      manifestPath: run.manifestPath,
      runDir: run.runDir,
      seat: locator.seat,
    };
  }
  if (run.codexThreadId !== locator.threadId) {
    throw new SupervisorEndpointLocatorError("thread-mismatch");
  }
  return {
    kind: "codex-thread",
    remoteUrl: requireLoopbackCodexRemoteUrl(run.codexRemoteUrl),
    runDir: run.runDir,
    threadId: locator.threadId,
  };
};

export type SupervisorEndpointLocatorResolver = (
  locator: SupervisorEndpointLocator,
  supervisorId: string
) => ResolvedSupervisorEndpoint;

/** Bind the server's own filesystem and roots once, at server construction. */
export const createSupervisorEndpointLocatorResolver = (deps: {
  fs: SupervisorEndpointFs;
  roots: SupervisorEndpointRoots;
}): SupervisorEndpointLocatorResolver => {
  const roots: SupervisorEndpointRoots = {
    runsRoot: canonicalAbsolute(deps.roots.runsRoot, "runsRoot"),
    sessionsRoot: canonicalAbsolute(deps.roots.sessionsRoot, "sessionsRoot"),
  };
  return (locator, supervisorId) =>
    resolveSupervisorEndpointLocator(locator, {
      fs: deps.fs,
      roots,
      supervisorId,
    });
};

/** `{ status: "locator-refused" }` for a store result, from a thrown refusal. */
export const supervisorEndpointLocatorRefused = (
  error: unknown
): SupervisorEndpointLocatorRefusedResult => ({
  reason:
    error instanceof SupervisorEndpointLocatorError ? error.reason : "invalid",
  status: "locator-refused",
});

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
