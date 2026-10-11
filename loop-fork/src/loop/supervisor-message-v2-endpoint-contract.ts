import type { SupervisorBridgeRoute } from "./bridge-supervisor-message-delivery";
import type {
  SupervisorEndpointKind,
  SupervisorEndpointLeaseFence,
  SupervisorEndpointLeaseReader,
  SupervisorEndpointLeaseResolution,
  SupervisorEndpointLeaseV2,
  SupervisorEndpointLocator,
  SupervisorEndpointLoopRunLocator,
} from "./supervisor-endpoint-lease";
import type { SupervisorMailboxDirectory } from "./supervisor-mailbox-delivery";
import type {
  SupervisorMessageV2DeliveryEnvelope,
  TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import type {
  SupervisorMessageV2DeliveryOutcome,
  SupervisorMessageV2DeliveryPort,
  SupervisorMessageV2DeliveryReadinessPort,
  SupervisorMessageV2RecipientEnrollmentPort,
} from "./supervisor-message-v2-runtime";
import type { SupervisorSessionDescriptorV2 } from "./supervisor-session-v2";

/**
 * r9 shared contract: the endpoint delivery and readiness ports. T2 implements
 * them in supervisor-message-v2-endpoint-delivery.ts; T3 wires them into the
 * server and the recipient assignment. Types and pure decisions only.
 *
 * One routing rule, used by readiness, delivery and recipient assignment so
 * the three never disagree (`decideSupervisorEndpointRoute`):
 *
 * | lease state           | mailbox | route    |
 * |-----------------------|---------|----------|
 * | live                  | any     | endpoint |
 * | expired, unreleased   | any     | defer    |
 * | released or none      | yes     | mailbox  |
 * | released or none      | no      | none     |
 *
 * - endpoint: deliver through the kind's adapter only. Its transient failure
 *   is a transient failure (the workflow retries); it does not fall through
 *   to the mailbox while a session holds the lease.
 * - defer: the existing not-enrolled deferral (runtime NotEnrolledDeferral,
 *   bounded by notEnrolledBoundMs) measured from the lease's expiresAt. No new
 *   scheduler.
 * - mailbox: MailboxSupervisorMessageDeliveryPort, then a wake. A wake is a
 *   trigger only; it never acknowledges.
 * - Delivery acceptance is not acknowledgement, and acknowledgement is not
 *   completion: completion is a published result.
 *
 * Every lookup uses the SEAT's scope {tenantId, principalFor(recipient)}, not
 * the sender scope the runtime passes; only tenantId is taken from it.
 */

export type SupervisorEndpointRoute = "defer" | "endpoint" | "mailbox" | "none";

export const decideSupervisorEndpointRoute = (
  resolution: SupervisorEndpointLeaseResolution,
  hasMailbox: boolean
): SupervisorEndpointRoute => {
  if (resolution.state === "live") {
    return "endpoint";
  }
  if (resolution.state === "expired") {
    return "defer";
  }
  return hasMailbox ? "mailbox" : "none";
};

/** Fixed, opaque reasons: no path, URL, session id or provider detail. */
export const SUPERVISOR_ENDPOINT_REASONS = {
  identityChanged: "recipient endpoint identity changed",
  leaseExpired: "recipient endpoint lease expired",
  noEndpoint: "recipient has no endpoint and no mailbox",
  probeFailed: "recipient endpoint is not ready",
} as const;
export type SupervisorEndpointReason =
  (typeof SUPERVISOR_ENDPOINT_REASONS)[keyof typeof SUPERVISOR_ENDPOINT_REASONS];

export type SupervisorEndpointReadiness =
  | {
      fence: SupervisorEndpointLeaseFence;
      kind: SupervisorEndpointKind;
      state: "endpoint-ready";
    }
  | { state: "mailbox-ready" }
  | {
      reason: typeof SUPERVISOR_ENDPOINT_REASONS.leaseExpired;
      /** Date.parse(lease.expiresAt): the start of the not-enrolled spell. */
      since: number;
      state: "deferred";
    }
  | {
      reason: Exclude<
        SupervisorEndpointReason,
        typeof SUPERVISOR_ENDPOINT_REASONS.leaseExpired
      >;
      state: "unready";
    };

/**
 * Detailed readiness. A store that cannot answer rejects with
 * SupervisorMessageV2ReadinessUnavailableError; it never resolves "unready"
 * for an outage.
 */
export interface SupervisorEndpointReadinessPort {
  readiness(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorEndpointReadiness>;
}

/**
 * What the coordinator consumes. assertReady resolves for endpoint-ready
 * (after a kind probe and descriptor identity check) and mailbox-ready;
 * rejects with a plain Error carrying the fixed reason for deferred and
 * unready; rejects with SupervisorMessageV2ReadinessUnavailableError for an
 * outage. `notEnrolledSince` reports an expired, unreleased lease (since its
 * expiresAt) in addition to what the enrollment sweep found, so the existing
 * deferral bounds it.
 */
export interface SupervisorEndpointDeliveryReadiness
  extends SupervisorEndpointReadinessPort,
    SupervisorMessageV2DeliveryReadinessPort,
    SupervisorMessageV2RecipientEnrollmentPort {
  notEnrolled(): readonly string[];
}

export type SupervisorEndpointLocatorOf<K extends SupervisorEndpointKind> =
  Extract<SupervisorEndpointLocator, { kind: K }>;

export type SupervisorEndpointLeaseOf<K extends SupervisorEndpointKind> = Omit<
  SupervisorEndpointLeaseV2,
  "kind" | "locator"
> & { kind: K; locator: SupervisorEndpointLocatorOf<K> };

/**
 * One adapter per kind. probe is no-turn (Codex read/resume, Claude channel
 * readiness file, Loop run bridge status) and true only when the live session
 * matches the descriptor's sessionRef and endpointDigest. deliver must honour
 * envelope.idempotencyKey: a repeat after a lease change cannot duplicate work.
 *
 * - loop-run: BridgeSupervisorMessageDeliveryPort via
 *   `supervisorEndpointBridgeRoute(locator)`.
 * - claude-channel: the `__bridge-mcp <sessionDir> claude` channel server.
 * - codex-thread: probeCodexThread / injectCodexMessage.
 */
export interface SupervisorEndpointKindAdapter<
  K extends SupervisorEndpointKind,
> {
  deliver(input: {
    envelope: SupervisorMessageV2DeliveryEnvelope;
    lease: SupervisorEndpointLeaseOf<K>;
  }): Promise<SupervisorMessageV2DeliveryOutcome>;
  readonly kind: K;
  probe(input: {
    descriptor: SupervisorSessionDescriptorV2;
    lease: SupervisorEndpointLeaseOf<K>;
  }): Promise<boolean>;
}

export type SupervisorEndpointKindAdapters = {
  readonly [K in SupervisorEndpointKind]: SupervisorEndpointKindAdapter<K>;
};

/** Construction inputs for T2's endpoint delivery and readiness. */
export interface SupervisorEndpointDeliveryOptions {
  adapters: SupervisorEndpointKindAdapters;
  /** Sweep-observed not-enrolled seats (ConfiguredA2AV2SessionEnrollment). */
  enrollment?: SupervisorMessageV2RecipientEnrollmentPort & {
    notEnrolled(): readonly string[];
  };
  leases: SupervisorEndpointLeaseReader;
  /** V2 mailbox port (wraps MailboxSupervisorMessageDeliveryPort). */
  mailbox: SupervisorMessageV2DeliveryPort;
  mailboxes: SupervisorMailboxDirectory;
  now: () => Date;
  principalForRecipient(recipient: string): string | undefined;
  /** Seat-scope descriptor lookup (PostgresSupervisorSessionV2Store.current). */
  sessions: {
    current(
      scope: TrustedSupervisorMessageV2Scope,
      recipient: string
    ): Promise<SupervisorSessionDescriptorV2 | undefined>;
  };
  /** Mailbox-mode wake trigger (wakeSession). Never acknowledges. */
  wake?(recipient: string): Promise<void> | void;
}

/** The composite port: route by `decideSupervisorEndpointRoute`, then deliver. */
export interface SupervisorEndpointDeliveryPort
  extends SupervisorMessageV2DeliveryPort {
  readonly readiness: SupervisorEndpointDeliveryReadiness;
}

/** A delivery-time route of defer or none is a transient failure with these reasons. */
export const supervisorEndpointUndeliverable = (
  route: Extract<SupervisorEndpointRoute, "defer" | "none">
): SupervisorMessageV2DeliveryOutcome => ({
  reason:
    route === "defer"
      ? SUPERVISOR_ENDPOINT_REASONS.leaseExpired
      : SUPERVISOR_ENDPOINT_REASONS.noEndpoint,
  status: "transient-failure",
});

/** The bridge route of a Loop run lease: the seat is the bridge target. */
export const supervisorEndpointBridgeRoute = (
  locator: SupervisorEndpointLoopRunLocator
): SupervisorBridgeRoute => ({ runDir: locator.runDir, target: locator.seat });

/** The scope descriptors and leases of a seat live in. */
export const supervisorEndpointSeatScope = (
  trustedScope: TrustedSupervisorMessageV2Scope,
  recipient: string,
  principalForRecipient: (recipient: string) => string | undefined
): TrustedSupervisorMessageV2Scope | undefined => {
  const principal = principalForRecipient(recipient);
  return principal === undefined
    ? undefined
    : { principal, tenantId: trustedScope.tenantId };
};
