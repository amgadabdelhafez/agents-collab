import type { SupervisorA2AAuthenticatedIdentity } from "./a2a-supervisor-http";
import type {
  SupervisorEndpointLeaseReader,
  SupervisorEndpointLocatorResolver,
} from "./supervisor-endpoint-lease";
import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";
import {
  decideSupervisorEndpointRoute,
  supervisorEndpointSeatScope,
} from "./supervisor-message-v2-endpoint-contract";
import type { SupervisorSessionDescriptorV2 } from "./supervisor-session-v2";

interface RecipientSessions {
  assertReady(
    scope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<unknown>;
  current(
    scope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorSessionDescriptorV2 | undefined>;
}

/**
 * r9: which session, if any, a recipient is reachable through. Absent, every
 * recipient is r8's: a descriptor in the original sender scope.
 */
export interface SupervisorMessageV2RecipientEndpoints {
  /** Whether the supervisor has a configured mailbox (mailbox-held mode). */
  hasMailbox(recipient: string): boolean;
  leases: SupervisorEndpointLeaseReader;
  /**
   * r8's manifest-bound seats (the configured recipient and its peers). While
   * such a seat holds no lease row at all it keeps r8's rule: a descriptor in
   * the sender scope. Any lease row moves it to the r9 rule.
   */
  legacySeats: ReadonlySet<string>;
  /** The server's own resolver; a live lease's locator is re-resolved here. */
  resolveLocator: SupervisorEndpointLocatorResolver;
}

export interface SupervisorMessageV2RecipientReachabilityOptions {
  endpoints?: SupervisorMessageV2RecipientEndpoints;
  principalForRecipient(recipient: string): string | undefined;
  sessions: RecipientSessions;
  tenantId: string;
}

const describesSeat = (
  session: SupervisorSessionDescriptorV2 | undefined,
  scope: TrustedSupervisorMessageV2Scope,
  recipient: string
): session is SupervisorSessionDescriptorV2 =>
  session !== undefined &&
  session.tenantId === scope.tenantId &&
  session.principal === scope.principal &&
  session.recipient === recipient;

/**
 * Whether a recipient may act on (or publish a result for) a message of
 * `senderScope` now. One rule for the recipient route and result publication,
 * and the same routing table delivery uses (`decideSupervisorEndpointRoute`):
 *
 * - live lease: the descriptor the lease registered, in the SEAT's scope
 *   {tenant, principalFor(recipient)}, must be current and ready, and the
 *   lease's locator must still resolve under the server's own roots;
 * - released or no lease, with a mailbox: reachable (mailbox-held mode);
 * - expired lease, or neither lease nor mailbox: not reachable;
 * - an r8 seat with no lease row: r8's descriptor in the sender scope.
 *
 * On the r9 path any failure (a lease or session store outage, a refused
 * locator) is "not reachable": the route then answers as for an unassigned
 * message and discloses nothing more. The r8 path is unchanged.
 */
export const createSupervisorMessageV2RecipientReachability =
  (options: SupervisorMessageV2RecipientReachabilityOptions) =>
  async (
    senderScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<boolean> => {
    const endpoints = options.endpoints;
    if (endpoints) {
      let leased: boolean | undefined;
      try {
        leased = await reachableThroughLease(
          options,
          endpoints,
          senderScope,
          recipient
        );
      } catch {
        return false;
      }
      if (leased !== undefined) {
        return leased;
      }
    }
    // r8: a descriptor in the sender scope. A store error propagates, as it
    // always has; only an unready session is "not reachable".
    const session = await options.sessions.current(senderScope, recipient);
    if (!describesSeat(session, senderScope, recipient)) {
      return false;
    }
    try {
      await options.sessions.assertReady(senderScope, recipient);
    } catch {
      return false;
    }
    return true;
  };

/** The r9 rule, or undefined for an r8 seat that holds no lease row. */
const reachableThroughLease = async (
  options: SupervisorMessageV2RecipientReachabilityOptions,
  endpoints: SupervisorMessageV2RecipientEndpoints,
  senderScope: TrustedSupervisorMessageV2Scope,
  recipient: string
): Promise<boolean | undefined> => {
  const resolution = await endpoints.leases.resolve(
    options.tenantId,
    recipient
  );
  if (endpoints.legacySeats.has(recipient) && resolution.state === "none") {
    return undefined;
  }
  const route = decideSupervisorEndpointRoute(
    resolution,
    endpoints.hasMailbox(recipient)
  );
  if (route === "mailbox") {
    return true;
  }
  if (route !== "endpoint" || resolution.state === "none") {
    return false;
  }
  const seatScope = supervisorEndpointSeatScope(
    senderScope,
    recipient,
    options.principalForRecipient
  );
  if (!seatScope || resolution.lease.recipient !== recipient) {
    return false;
  }
  // SECURITY: the stored locator is untrusted ids; it must still resolve for
  // this recipient under the server's own roots now (throws when refused).
  endpoints.resolveLocator(resolution.lease.locator, recipient);
  const session = await options.sessions.current(seatScope, recipient);
  if (
    !describesSeat(session, seatScope, recipient) ||
    session.descriptorId !== resolution.lease.descriptorId
  ) {
    return false;
  }
  await options.sessions.assertReady(seatScope, recipient);
  return true;
};

/** Host-configured principal binding plus durable assignment and a reachable
 * recipient (see `createSupervisorMessageV2RecipientReachability`).
 */
export const createSupervisorMessageV2RecipientAssignmentResolver = (options: {
  endpoints?: SupervisorMessageV2RecipientEndpoints;
  tenantId: string;
  principalForRecipient(recipient: string): string | undefined;
  ledger: {
    recipientAssignment(input: {
      tenantId: string;
      recipient: string;
      workflowId: string;
    }): Promise<TrustedSupervisorMessageV2Scope | undefined>;
  };
  sessions: RecipientSessions;
}) => {
  const reachable = createSupervisorMessageV2RecipientReachability(options);
  return async (input: {
    identity: SupervisorA2AAuthenticatedIdentity;
    workflowId: string;
  }): Promise<TrustedSupervisorMessageV2Scope | undefined> => {
    if (
      options.principalForRecipient(input.identity.supervisorId) !==
      input.identity.principal
    ) {
      return undefined;
    }
    const scope = await options.ledger.recipientAssignment({
      tenantId: options.tenantId,
      recipient: input.identity.supervisorId,
      workflowId: input.workflowId,
    });
    if (!scope || scope.tenantId !== options.tenantId) {
      return undefined;
    }
    return (await reachable(scope, input.identity.supervisorId))
      ? scope
      : undefined;
  };
};
