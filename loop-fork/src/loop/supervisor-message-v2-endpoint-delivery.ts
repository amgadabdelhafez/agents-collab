import { deliverCodexBridgeMessage } from "./bridge-runtime";
import { type BridgeMessage, readBridgeStatus } from "./bridge-store";
import {
  BridgeSupervisorMessageDeliveryPort,
  type SupervisorBridgeProviderDelivery,
  type SupervisorBridgeProviderProbe,
  type SupervisorBridgeRoute,
  type SupervisorBridgeRouteReadiness,
} from "./bridge-supervisor-message-delivery";
import { probeClaudeChannelReadiness } from "./claude-channel-readiness";
import { probeCodexThread } from "./codex-app-server";
import { loopRunEndpointRoute } from "./loop-supervisor-directory";
import type { MailboxFileAccess } from "./mailbox-file-access";
import {
  type ResolvedSupervisorEndpoint,
  type ResolvedSupervisorEndpointOf,
  requireLoopbackCodexRemoteUrl,
  SUPERVISOR_ENDPOINT_KINDS,
  type SupervisorEndpointKind,
  type SupervisorEndpointLeaseReader,
  type SupervisorEndpointLeaseResolution,
  type SupervisorEndpointLeaseV2,
  type SupervisorEndpointLocatorResolver,
  supervisorEndpointDescriptorIdentity,
  supervisorEndpointRef,
} from "./supervisor-endpoint-lease";
import {
  SUPERVISOR_INBOX_FULL_REASON,
  type SupervisorInboxStreamHub,
} from "./supervisor-inbox-stream";
import {
  MailboxSupervisorMessageDeliveryPort,
  type SupervisorMailboxDirectory,
} from "./supervisor-mailbox-delivery";
import { SupervisorMessageV2BridgeDeliveryPort } from "./supervisor-message-v2-bridge-delivery";
import type {
  SupervisorMessageV2DeliveryEnvelope,
  TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import {
  decideSupervisorEndpointRoute,
  SUPERVISOR_ENDPOINT_REASONS,
  type SupervisorEndpointDeliveryOptions,
  type SupervisorEndpointDeliveryPort,
  type SupervisorEndpointDeliveryReadiness,
  type SupervisorEndpointKindAdapter,
  type SupervisorEndpointKindAdapters,
  type SupervisorEndpointLeaseOf,
  type SupervisorEndpointReadiness,
  type SupervisorEndpointReason,
  supervisorEndpointLocatorRefusedOutcome,
  supervisorEndpointSeatScope,
  supervisorEndpointUndeliverable,
} from "./supervisor-message-v2-endpoint-contract";
import {
  type SupervisorMessageV2DeliveryOutcome,
  type SupervisorMessageV2DeliveryPort,
  SupervisorMessageV2ReadinessUnavailableError,
} from "./supervisor-message-v2-runtime";
import type { SupervisorSessionDescriptorV2 } from "./supervisor-session-v2";

/**
 * r9 (T2): endpoint readiness and delivery for every supervisor, implementing
 * supervisor-message-v2-endpoint-contract.ts. Which session holds a
 * supervisor's endpoint is the lease; `decideSupervisorEndpointRoute` is the
 * only routing rule:
 *
 * - live lease: re-resolve the stored locator (server roots, realpath
 *   containment, manifest binding, loopback-only Codex URL), check the seat
 *   descriptor still names that lease, and probe the kind without a turn.
 *   Delivery goes through the kind's adapter only; a failure there is a
 *   transient failure and never falls through to the mailbox.
 * - expired, unreleased lease: defer through the runtime's existing
 *   not-enrolled deferral, its spell measured from the lease's expiresAt, so
 *   the existing notEnrolledBoundMs bounds it. No new scheduler.
 * - released or no lease: the supervisor's mailbox when it has one
 *   (ready-for-mailbox), then a wake; otherwise nothing is deliverable.
 *
 * Delivery acceptance is not the recipient's read ACK, and the ACK is not
 * completion (a published result). A wake is a trigger only.
 *
 * SECURITY: a stored locator is untrusted ids. It becomes a path or URL only
 * through `options.resolveLocator`, on every readiness check, probe and
 * delivery; nothing here caches a path or URL across calls. Reasons are the
 * fixed SUPERVISOR_ENDPOINT_REASONS: no path, URL, session id or provider
 * detail reaches workflow state.
 */

const READINESS_UNAVAILABLE_REASON =
  new SupervisorMessageV2ReadinessUnavailableError().message;

/** Bridge outcomes whose reasons are already fixed and detail-free. */
const OPAQUE_BRIDGE_REASONS = new Set<string>([
  "bridge logical delivery is in progress",
  "bridge queued without provider acceptance",
  SUPERVISOR_INBOX_FULL_REASON,
]);

const ENDPOINT_REFUSED_REASON = "recipient endpoint refused the message";

/**
 * Adapter outcomes keep their status; a reason that could carry a path,
 * session id or provider text (a thrown error's message) is replaced by a
 * fixed one.
 */
const opaqueOutcome = (
  outcome: SupervisorMessageV2DeliveryOutcome
): SupervisorMessageV2DeliveryOutcome => {
  if (outcome.status === "accepted") {
    return outcome;
  }
  if (OPAQUE_BRIDGE_REASONS.has(outcome.reason)) {
    return outcome;
  }
  return {
    reason:
      outcome.status === "permanent-failure"
        ? ENDPOINT_REFUSED_REASON
        : SUPERVISOR_ENDPOINT_REASONS.probeFailed,
    status: outcome.status,
  };
};

const ENDPOINT_REFS: ReadonlySet<string> = new Set(
  SUPERVISOR_ENDPOINT_KINDS.map(supervisorEndpointRef)
);

/**
 * True for an r9 lease-backed descriptor (`endpoint:<kind>`), whose readiness
 * goes through its lease; r8's manifest-bound descriptors
 * (`endpoint:claude-code`, `endpoint:codex-app-server`) keep their own path.
 */
export const isSupervisorEndpointDescriptorRef = (endpointRef: string) =>
  ENDPOINT_REFS.has(endpointRef);

/**
 * The seat descriptor still names this lease: same descriptor, same seat
 * scope, not older than the lease's revision, and the identity the lease's
 * locator and sessionRef derive (endpointDigest over the locator's ids,
 * endpointRef, provider).
 */
export const supervisorEndpointDescriptorMatchesLease = (
  descriptor: SupervisorSessionDescriptorV2,
  lease: SupervisorEndpointLeaseV2
): boolean => {
  if (
    !(
      descriptor.descriptorId === lease.descriptorId &&
      descriptor.revision >= lease.descriptorRevision &&
      descriptor.recipient === lease.recipient &&
      descriptor.tenantId === lease.tenantId &&
      descriptor.principal === lease.principal &&
      lease.locator.kind === lease.kind
    )
  ) {
    return false;
  }
  try {
    const identity = supervisorEndpointDescriptorIdentity(
      lease.locator,
      descriptor.sessionRef
    );
    return (
      identity.endpointDigest === descriptor.endpointDigest &&
      identity.endpointRef === descriptor.endpointRef &&
      identity.provider === descriptor.provider
    );
  } catch {
    return false;
  }
};

type EndpointCheck =
  | "ready"
  | Exclude<
      SupervisorEndpointReason,
      | typeof SUPERVISOR_ENDPOINT_REASONS.leaseExpired
      | typeof SUPERVISOR_ENDPOINT_REASONS.noEndpoint
    >;

/** Re-resolve a lease's stored locator for this call only. */
const resolveLeaseEndpoint = (
  resolveLocator: SupervisorEndpointLocatorResolver,
  lease: SupervisorEndpointLeaseV2
): ResolvedSupervisorEndpoint | undefined => {
  try {
    const endpoint = resolveLocator(lease.locator, lease.recipient);
    return endpoint.kind === lease.kind ? endpoint : undefined;
  } catch {
    return undefined;
  }
};

const adapterOf = (
  adapters: SupervisorEndpointKindAdapters,
  kind: SupervisorEndpointKind
): SupervisorEndpointKindAdapter<SupervisorEndpointKind> =>
  adapters[
    kind
  ] as unknown as SupervisorEndpointKindAdapter<SupervisorEndpointKind>;

/**
 * A live lease's endpoint check: descriptor identity, a fresh locator
 * resolution, then the kind's no-turn probe. A probe that throws is not ready.
 */
export const checkSupervisorEndpointLease = async (input: {
  adapters: SupervisorEndpointKindAdapters;
  descriptor: SupervisorSessionDescriptorV2 | undefined;
  lease: SupervisorEndpointLeaseV2;
  resolveLocator: SupervisorEndpointLocatorResolver;
}): Promise<EndpointCheck> => {
  if (
    !(
      input.descriptor &&
      supervisorEndpointDescriptorMatchesLease(input.descriptor, input.lease)
    )
  ) {
    return SUPERVISOR_ENDPOINT_REASONS.identityChanged;
  }
  const endpoint = resolveLeaseEndpoint(input.resolveLocator, input.lease);
  if (!endpoint) {
    return SUPERVISOR_ENDPOINT_REASONS.locatorRefused;
  }
  let ready = false;
  try {
    ready = await adapterOf(input.adapters, input.lease.kind).probe({
      descriptor: input.descriptor,
      endpoint:
        endpoint as ResolvedSupervisorEndpointOf<SupervisorEndpointKind>,
      lease: input.lease as SupervisorEndpointLeaseOf<SupervisorEndpointKind>,
    });
  } catch {
    ready = false;
  }
  return ready === true ? "ready" : SUPERVISOR_ENDPOINT_REASONS.probeFailed;
};

/** A store failure of any kind is an outage, never driver text. */
const rethrowAsUnavailable = (error: unknown): never => {
  if (error instanceof SupervisorMessageV2ReadinessUnavailableError) {
    throw error;
  }
  throw new SupervisorMessageV2ReadinessUnavailableError();
};

/**
 * Provider readiness of an r9 lease-backed descriptor, for the session
 * store's assertReady (`LoopCodexSessionV2ProviderReadiness`). Resolves when
 * the descriptor's lease is live and its endpoint checks ready; otherwise
 * rejects with a fixed reason, or with the outage error when the lease store
 * cannot answer.
 */
export class SupervisorEndpointDescriptorReadiness {
  readonly #adapters: SupervisorEndpointKindAdapters;
  readonly #leases: SupervisorEndpointLeaseReader;
  readonly #resolveLocator: SupervisorEndpointLocatorResolver;

  constructor(options: {
    adapters: SupervisorEndpointKindAdapters;
    leases: SupervisorEndpointLeaseReader;
    resolveLocator: SupervisorEndpointLocatorResolver;
  }) {
    this.#adapters = options.adapters;
    this.#leases = options.leases;
    this.#resolveLocator = options.resolveLocator;
  }

  async ready(descriptor: SupervisorSessionDescriptorV2): Promise<void> {
    const resolution = await this.#leases
      .resolve(descriptor.tenantId, descriptor.recipient)
      .catch(rethrowAsUnavailable);
    if (resolution.state !== "live") {
      throw new Error(
        resolution.state === "expired"
          ? SUPERVISOR_ENDPOINT_REASONS.leaseExpired
          : SUPERVISOR_ENDPOINT_REASONS.probeFailed
      );
    }
    const check = await checkSupervisorEndpointLease({
      adapters: this.#adapters,
      descriptor,
      lease: resolution.lease,
      resolveLocator: this.#resolveLocator,
    });
    if (check !== "ready") {
      throw new Error(check);
    }
  }
}

/**
 * The composite V2 delivery port and its readiness. `deliver` and
 * `readiness` each resolve the lease and route by the one rule; neither
 * trusts the other's earlier answer.
 */
export class SupervisorEndpointMessageV2Delivery
  implements SupervisorEndpointDeliveryPort
{
  readonly readiness: SupervisorEndpointDeliveryReadiness;
  readonly #options: SupervisorEndpointDeliveryOptions;

  constructor(options: SupervisorEndpointDeliveryOptions) {
    this.#options = options;
    this.readiness = new EndpointReadiness(options);
  }

  async deliver(
    envelope: SupervisorMessageV2DeliveryEnvelope
  ): Promise<SupervisorMessageV2DeliveryOutcome> {
    const recipient = envelope.target;
    const seatScope = supervisorEndpointSeatScope(
      { principal: envelope.principal, tenantId: envelope.tenantId },
      recipient,
      (id) => this.#options.principalForRecipient(id)
    );
    if (!seatScope) {
      return supervisorEndpointUndeliverable("none");
    }
    let resolution: SupervisorEndpointLeaseResolution;
    try {
      resolution = await resolveSeatLease(
        this.#options.leases,
        seatScope,
        recipient
      );
    } catch {
      return {
        reason: READINESS_UNAVAILABLE_REASON,
        status: "transient-failure",
      };
    }
    const route = decideSupervisorEndpointRoute(
      resolution,
      hasMailbox(this.#options.mailboxes, recipient)
    );
    if (route === "defer" || route === "none") {
      return supervisorEndpointUndeliverable(route);
    }
    if (route === "mailbox") {
      return this.#deliverToMailbox(envelope);
    }
    // route "endpoint": resolution is a live lease.
    const lease = (resolution as { lease: SupervisorEndpointLeaseV2 }).lease;
    if (!leaseInSeatScope(lease, seatScope, recipient)) {
      return {
        reason: SUPERVISOR_ENDPOINT_REASONS.identityChanged,
        status: "transient-failure",
      };
    }
    const endpoint = resolveLeaseEndpoint(this.#options.resolveLocator, lease);
    if (!endpoint) {
      return supervisorEndpointLocatorRefusedOutcome;
    }
    try {
      return opaqueOutcome(
        await adapterOf(this.#options.adapters, lease.kind).deliver({
          endpoint:
            endpoint as ResolvedSupervisorEndpointOf<SupervisorEndpointKind>,
          envelope,
          lease: lease as SupervisorEndpointLeaseOf<SupervisorEndpointKind>,
        })
      );
    } catch {
      return {
        reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
        status: "transient-failure",
      };
    }
  }

  async #deliverToMailbox(
    envelope: SupervisorMessageV2DeliveryEnvelope
  ): Promise<SupervisorMessageV2DeliveryOutcome> {
    let outcome: SupervisorMessageV2DeliveryOutcome;
    try {
      outcome = await this.#options.mailbox.deliver(envelope);
    } catch {
      return {
        reason: "recipient mailbox write failed",
        status: "transient-failure",
      };
    }
    if (outcome.status === "accepted") {
      triggerWake(this.#options.wake, envelope.target);
    }
    return outcome;
  }
}

/**
 * A wake is a trigger: it is not awaited, and neither a throw nor a rejection
 * can change the delivery outcome. It never acknowledges.
 */
const triggerWake = (
  wake: SupervisorEndpointDeliveryOptions["wake"],
  recipient: string
): void => {
  if (!wake) {
    return;
  }
  try {
    const pending = wake(recipient);
    if (pending && typeof (pending as Promise<void>).catch === "function") {
      (pending as Promise<void>).catch(() => undefined);
    }
  } catch {
    // A failed wake leaves durable mail for the recipient's own read.
  }
};

const hasMailbox = (
  mailboxes: SupervisorMailboxDirectory,
  recipient: string
): boolean => {
  try {
    return Boolean(mailboxes.resolveMailbox(recipient));
  } catch {
    return false;
  }
};

const resolveSeatLease = (
  leases: SupervisorEndpointLeaseReader,
  seatScope: TrustedSupervisorMessageV2Scope,
  recipient: string
): Promise<SupervisorEndpointLeaseResolution> =>
  leases.resolve(seatScope.tenantId, recipient).catch(rethrowAsUnavailable);

/** A lease row must belong to the seat it was looked up for. */
const leaseInSeatScope = (
  lease: SupervisorEndpointLeaseV2,
  seatScope: TrustedSupervisorMessageV2Scope,
  recipient: string
): boolean =>
  lease.recipient === recipient &&
  lease.tenantId === seatScope.tenantId &&
  lease.principal === seatScope.principal;

class EndpointReadiness implements SupervisorEndpointDeliveryReadiness {
  readonly #options: SupervisorEndpointDeliveryOptions;
  /**
   * recipient -> Date.parse(expiresAt) of the expired, unreleased lease the
   * last readiness check found. Read synchronously by the runtime deferral
   * right after assertReady refused. Holds instants only, never a locator.
   */
  readonly #expired = new Map<string, number>();

  constructor(options: SupervisorEndpointDeliveryOptions) {
    this.#options = options;
  }

  async readiness(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorEndpointReadiness> {
    const seatScope = supervisorEndpointSeatScope(
      trustedScope,
      recipient,
      (id) => this.#options.principalForRecipient(id)
    );
    if (!seatScope) {
      this.#expired.delete(recipient);
      return {
        reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
        state: "unready",
      };
    }
    const resolution = await resolveSeatLease(
      this.#options.leases,
      seatScope,
      recipient
    );
    const route = decideSupervisorEndpointRoute(
      resolution,
      hasMailbox(this.#options.mailboxes, recipient)
    );
    if (route === "defer") {
      const lease = (resolution as { lease: SupervisorEndpointLeaseV2 }).lease;
      const since = Date.parse(lease.expiresAt);
      if (Number.isFinite(since)) {
        this.#expired.set(recipient, since);
        return {
          reason: SUPERVISOR_ENDPOINT_REASONS.leaseExpired,
          since,
          state: "deferred",
        };
      }
      this.#expired.delete(recipient);
      return {
        reason: SUPERVISOR_ENDPOINT_REASONS.identityChanged,
        state: "unready",
      };
    }
    this.#expired.delete(recipient);
    if (route === "mailbox") {
      return { state: "mailbox-ready" };
    }
    if (route === "none") {
      return {
        reason: SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
        state: "unready",
      };
    }
    const lease = (resolution as { lease: SupervisorEndpointLeaseV2 }).lease;
    if (!leaseInSeatScope(lease, seatScope, recipient)) {
      return {
        reason: SUPERVISOR_ENDPOINT_REASONS.identityChanged,
        state: "unready",
      };
    }
    const descriptor = await this.#options.sessions
      .current(seatScope, recipient)
      .catch(rethrowAsUnavailable);
    const check = await checkSupervisorEndpointLease({
      adapters: this.#options.adapters,
      descriptor,
      lease,
      resolveLocator: this.#options.resolveLocator,
    });
    if (check !== "ready") {
      return { reason: check, state: "unready" };
    }
    return {
      fence: { epoch: lease.epoch, holderRef: lease.holderRef },
      kind: lease.kind,
      state: "endpoint-ready",
    };
  }

  async assertReady(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorEndpointReadiness> {
    const readiness = await this.readiness(trustedScope, recipient);
    if (readiness.state === "deferred" || readiness.state === "unready") {
      throw new Error(readiness.reason);
    }
    return readiness;
  }

  notEnrolledSince(recipient: string): number | undefined {
    return (
      this.#expired.get(recipient) ??
      this.#options.enrollment?.notEnrolledSince(recipient)
    );
  }

  notEnrolled(): readonly string[] {
    return [
      ...new Set([
        ...(this.#options.enrollment?.notEnrolled() ?? []),
        ...this.#expired.keys(),
      ]),
    ].sort();
  }
}

/* ---------------------------------------------------------------------------
 * Kind adapters. Each receives only the endpoint its caller resolved for this
 * call; none derives a path or URL from `lease.locator`.
 * ------------------------------------------------------------------------- */

/** Injectable effects; production uses the bridge's own. */
export interface SupervisorEndpointAdapterDeps {
  /** probeClaudeChannelReadiness: fresh readiness file + exact bridge process. */
  claudeProbe?: (dir: string) => boolean;
  /** deliverCodexBridgeMessage: inject a queued entry into the run's thread. */
  codexDeliver?: (runDir: string, entry: BridgeMessage) => Promise<boolean>;
  /** probeCodexThread: read or resume, never a turn; no redirect is followed. */
  codexProbe?: (remoteUrl: string, threadId: string) => Promise<boolean>;
  /**
   * ra1: the server's inbox hub (durable inbox, presence, wakeups). Absent,
   * an inbox-stream lease is never ready and nothing is appended.
   */
  inboxStream?: SupervisorInboxStreamHub;
  /**
   * Route readiness for a Loop run seat. Defaults to the bridge port's own
   * (a live pane or Codex remote, the provider probe, a bridge worker).
   */
  loopRunRouteReady?: SupervisorBridgeRouteReadiness;
  now?: () => string;
  /** readBridgeStatus (with the session.json fallback for a session dir). */
  status?: typeof readBridgeStatus;
}

const isLoopbackRemote = (remoteUrl: string): boolean => {
  try {
    requireLoopbackCodexRemoteUrl(remoteUrl);
    return true;
  } catch {
    return false;
  }
};

const bridgeDelivery = (
  route: SupervisorBridgeRoute,
  envelope: SupervisorMessageV2DeliveryEnvelope,
  options: {
    now?: () => string;
    providerDelivery?: SupervisorBridgeProviderDelivery;
    providerProbe?: SupervisorBridgeProviderProbe;
    routeReady?: SupervisorBridgeRouteReadiness;
  }
): Promise<SupervisorMessageV2DeliveryOutcome> =>
  new SupervisorMessageV2BridgeDeliveryPort(
    new BridgeSupervisorMessageDeliveryPort({
      // This call's route only: the endpoint resolved from the lease.
      directory: { resolve: () => route },
      ...options,
    })
  )
    .deliver(envelope)
    .then(opaqueOutcome);

const notReady: SupervisorMessageV2DeliveryOutcome = {
  reason: SUPERVISOR_ENDPOINT_REASONS.probeFailed,
  status: "transient-failure",
};

/**
 * A Loop run seat over the run's bridge. The seat's live session must be the
 * descriptor's sessionRef; a Codex seat's manifest URL must be loopback before
 * it is probed or dialled.
 */
export const createLoopRunEndpointAdapter = (
  deps: SupervisorEndpointAdapterDeps = {}
): SupervisorEndpointKindAdapter<"loop-run"> => {
  const status = deps.status ?? readBridgeStatus;
  const claudeProbe = deps.claudeProbe ?? probeClaudeChannelReadiness;
  const codexProbe = deps.codexProbe ?? probeCodexThread;
  const codexDeliver = deps.codexDeliver ?? deliverCodexBridgeMessage;
  const codexRemote = (runDir: string) => {
    const current = status(runDir);
    return current.codexThreadId && isLoopbackRemote(current.codexRemoteUrl)
      ? { remoteUrl: current.codexRemoteUrl, threadId: current.codexThreadId }
      : undefined;
  };
  return {
    deliver({ endpoint, envelope }) {
      const route = loopRunEndpointRoute(endpoint);
      if (!route) {
        return Promise.resolve(notReady);
      }
      if (route.target !== "codex") {
        return bridgeDelivery(route, envelope, {
          now: deps.now,
          routeReady: deps.loopRunRouteReady,
        });
      }
      // Nothing is queued for a Codex seat whose manifest URL is not loopback.
      if (codexRemote(route.runDir) === undefined) {
        return Promise.resolve(notReady);
      }
      return bridgeDelivery(route, envelope, {
        now: deps.now,
        // Checked again at injection: the manifest may change after routing.
        providerDelivery: (current, entry) =>
          codexRemote(current.runDir) !== undefined &&
          codexDeliver(current.runDir, entry),
        providerProbe: (current) => {
          const remote = codexRemote(current.runDir);
          return remote === undefined
            ? false
            : codexProbe(remote.remoteUrl, remote.threadId);
        },
        routeReady: deps.loopRunRouteReady,
      });
    },
    kind: "loop-run",
    async probe({ descriptor, endpoint }) {
      const route = loopRunEndpointRoute(endpoint);
      if (!route) {
        return false;
      }
      if (route.target === "claude") {
        const current = status(route.runDir);
        return (
          Boolean(current.claudeSessionId) &&
          descriptor.sessionRef === `session:${current.claudeSessionId}` &&
          claudeProbe(route.runDir)
        );
      }
      const remote = codexRemote(route.runDir);
      return (
        remote !== undefined &&
        descriptor.sessionRef === `session:${remote.threadId}` &&
        (await codexProbe(remote.remoteUrl, remote.threadId))
      );
    },
  };
};

/**
 * A standalone Claude Code session: the `__bridge-mcp <sessionDir> claude`
 * channel server reads the session directory's bridge queue and pushes
 * notifications/claude/channel. Its identity is the directory's session.json;
 * its readiness is the bridge's own channel-readiness file plus the exact
 * bridge process. A queued message is accepted once the recipient has read
 * it, as for a run's Claude seat.
 */
export const createClaudeChannelEndpointAdapter = (
  deps: SupervisorEndpointAdapterDeps = {}
): SupervisorEndpointKindAdapter<"claude-channel"> => {
  const status = deps.status ?? readBridgeStatus;
  const claudeProbe = deps.claudeProbe ?? probeClaudeChannelReadiness;
  return {
    deliver({ endpoint, envelope }) {
      return bridgeDelivery(
        { runDir: endpoint.sessionDir, target: "claude" },
        envelope,
        { now: deps.now, routeReady: () => claudeProbe(endpoint.sessionDir) }
      );
    },
    kind: "claude-channel",
    probe({ descriptor, endpoint }) {
      const current = status(endpoint.sessionDir);
      return Promise.resolve(
        Boolean(current.claudeSessionId) &&
          descriptor.sessionRef === `session:${current.claudeSessionId}` &&
          claudeProbe(endpoint.sessionDir)
      );
    },
  };
};

/**
 * A Codex app-server thread of a run: probed with read/resume (no turn) and
 * delivered by injection, both only at the endpoint's manifest-derived,
 * loopback-only URL. Delivery goes through the run's bridge queue so the
 * per-workflow dedupe holds across retries, and injects only while the
 * manifest still names that same URL and thread.
 */
export const createCodexThreadEndpointAdapter = (
  deps: SupervisorEndpointAdapterDeps = {}
): SupervisorEndpointKindAdapter<"codex-thread"> => {
  const status = deps.status ?? readBridgeStatus;
  const codexProbe = deps.codexProbe ?? probeCodexThread;
  const codexDeliver = deps.codexDeliver ?? deliverCodexBridgeMessage;
  const probeEndpoint = (
    endpoint: ResolvedSupervisorEndpointOf<"codex-thread">
  ): Promise<boolean> | boolean =>
    isLoopbackRemote(endpoint.remoteUrl) &&
    codexProbe(endpoint.remoteUrl, endpoint.threadId);
  return {
    deliver({ endpoint, envelope }) {
      if (!isLoopbackRemote(endpoint.remoteUrl)) {
        return Promise.resolve(supervisorEndpointLocatorRefusedOutcome);
      }
      return bridgeDelivery(
        { runDir: endpoint.runDir, target: "codex" },
        envelope,
        {
          now: deps.now,
          providerDelivery: (route, entry) => {
            const current = status(route.runDir);
            return (
              current.codexRemoteUrl === endpoint.remoteUrl &&
              current.codexThreadId === endpoint.threadId &&
              codexDeliver(route.runDir, entry)
            );
          },
          routeReady: () => probeEndpoint(endpoint),
        }
      );
    },
    kind: "codex-thread",
    async probe({ descriptor, endpoint }) {
      return (
        descriptor.sessionRef === `session:${endpoint.threadId}` &&
        (await probeEndpoint(endpoint))
      );
    },
  };
};

/**
 * ra1: a session that holds its own outbound stream (`loop connect`). Delivery
 * is durable acceptance into the recipient's inbox, which wakes its stream;
 * the session reads it there, and acknowledges on the recipient route.
 * Acceptance is not the ACK. The probe (no turn) is the holder's presence:
 * a stream open for this lease's fence now, or within the presence grace, so
 * the lease sweep renews a connected holder and lets an absent one lapse.
 */
export const createInboxStreamEndpointAdapter = (
  deps: Pick<SupervisorEndpointAdapterDeps, "inboxStream"> = {}
): SupervisorEndpointKindAdapter<"inbox-stream"> => {
  const hub = deps.inboxStream;
  return {
    async deliver({ envelope, lease }) {
      if (!hub || envelope.target !== lease.recipient) {
        return notReady;
      }
      const result = await hub.append(envelope);
      if (!result) {
        return notReady;
      }
      if (result.status === "full") {
        return {
          reason: SUPERVISOR_INBOX_FULL_REASON,
          status: "transient-failure",
        };
      }
      return { status: "accepted" };
    },
    kind: "inbox-stream",
    probe({ descriptor, endpoint, lease }) {
      return Promise.resolve(
        hub?.store() !== undefined &&
          descriptor.sessionRef === `session:${endpoint.sessionId}` &&
          hub.presence.isPresent(lease.tenantId, lease.recipient, {
            epoch: lease.epoch,
            holderRef: lease.holderRef,
          })
      );
    },
  };
};

export const createSupervisorEndpointKindAdapters = (
  deps: SupervisorEndpointAdapterDeps = {}
): SupervisorEndpointKindAdapters => ({
  "claude-channel": createClaudeChannelEndpointAdapter(deps),
  "codex-thread": createCodexThreadEndpointAdapter(deps),
  "inbox-stream": createInboxStreamEndpointAdapter(deps),
  "loop-run": createLoopRunEndpointAdapter(deps),
});

/** The V2 mailbox port: the V1 mailbox writer behind the V2 envelope. */
export const createSupervisorEndpointMailboxPort = (
  mailboxes: SupervisorMailboxDirectory,
  now?: () => string,
  /** The server's bounded, async mailbox access; default a private one. */
  access?: MailboxFileAccess
): SupervisorMessageV2DeliveryPort =>
  new SupervisorMessageV2BridgeDeliveryPort(
    new MailboxSupervisorMessageDeliveryPort({
      ...(access ? { access } : {}),
      directory: mailboxes,
      now,
    })
  );
