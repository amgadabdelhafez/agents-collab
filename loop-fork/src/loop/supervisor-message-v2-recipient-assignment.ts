import type { SupervisorA2AAuthenticatedIdentity } from "./a2a-supervisor-http";
import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";
import type { SupervisorSessionDescriptorV2 } from "./supervisor-session-v2";

/** Host-configured principal binding plus durable assignment and live session.
 * Session descriptors are stored in the original sender scope, not seat scope.
 */
export const createSupervisorMessageV2RecipientAssignmentResolver =
  (options: {
    tenantId: string;
    principalForRecipient(recipient: string): string | undefined;
    ledger: {
      recipientAssignment(input: {
        tenantId: string;
        recipient: string;
        workflowId: string;
      }): Promise<TrustedSupervisorMessageV2Scope | undefined>;
    };
    sessions: {
      current(
        scope: TrustedSupervisorMessageV2Scope,
        recipient: string
      ): Promise<SupervisorSessionDescriptorV2 | undefined>;
      assertReady(
        scope: TrustedSupervisorMessageV2Scope,
        recipient: string
      ): Promise<unknown>;
    };
  }) =>
  async (input: {
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
    const session = await options.sessions.current(
      scope,
      input.identity.supervisorId
    );
    if (
      !session ||
      session.tenantId !== scope.tenantId ||
      session.principal !== scope.principal ||
      session.recipient !== input.identity.supervisorId
    ) {
      return undefined;
    }
    try {
      await options.sessions.assertReady(scope, input.identity.supervisorId);
    } catch {
      return undefined;
    }
    return scope;
  };
