import {
  type A2AInboundMessage,
  type A2ASendResult,
  canonicalSupervisorA2AIdentity,
  contextIdOf,
  taskStateFor,
  validateSupervisorA2ARequest,
} from "./a2a-supervisor-adapter";
import {
  SUPERVISOR_MESSAGE_V2_SCHEMA,
  type TrustedSupervisorMessageV2Scope,
} from "./supervisor-message-v2-contract";
import type { SupervisorMessageV2Coordinator } from "./supervisor-message-v2-runtime";
import { supervisorMessageV2ScopedDigest } from "./supervisor-message-v2-workflow-identity";
import type { SupervisorMessagePolicy } from "./supervisor-message-workflow";

/**
 * The V2 A2A boundary deliberately keeps the upstream SDK's Message shape,
 * while making the host-authenticated route scope the only source of tenant
 * and principal identity. Message metadata supplies the governed `from`
 * claim, but cannot alter the durable V2 identity.
 */
export interface SupervisorA2AV2AdapterOptions {
  coordinator: SupervisorMessageV2Coordinator;
  now: () => string;
  /**
   * RA2: told of each message once its V2 receive returned (the start intent
   * is durable): the governed sender, the configured recipient and the raw
   * message id. A throw is swallowed; the message is accepted either way.
   */
  onAccepted?: (accepted: {
    from: string;
    messageId: string;
    to: string;
  }) => void;
  policy: SupervisorMessagePolicy;
  supervisorId: string;
}

/**
 * An SDK context id is allocated per protocol task. A client that loses an
 * initial response may therefore resend the same raw message under a new
 * context, which must not alter the durable V2 start intent. The V2 board
 * thread follows the same immutable identity boundary as its workflow:
 * route tenant, authenticated principal, configured recipient, and raw A2A
 * message id. The protocol context remains in the SDK TaskStore only.
 */
export const supervisorA2AV2ThreadId = (input: {
  messageId: string;
  principal: string;
  supervisorId: string;
  tenant: string;
}): string =>
  `a2a:thread:v2:${supervisorMessageV2ScopedDigest(
    input.tenant,
    input.principal,
    "a2a-thread",
    [input.supervisorId, input.messageId]
  )}`;

export class SupervisorA2AV2Adapter {
  readonly #coordinator: SupervisorMessageV2Coordinator;
  readonly #now: () => string;
  readonly #onAccepted: SupervisorA2AV2AdapterOptions["onAccepted"];
  readonly #policy: SupervisorMessagePolicy;
  readonly #supervisorId: string;

  constructor(options: SupervisorA2AV2AdapterOptions) {
    this.#coordinator = options.coordinator;
    this.#now = options.now;
    this.#onAccepted = options.onAccepted;
    this.#policy = options.policy;
    this.#supervisorId = options.supervisorId;
  }

  async sendMessage(input: {
    message: A2AInboundMessage;
    principal: string;
    tenant: string;
  }): Promise<A2ASendResult> {
    const validated = validateSupervisorA2ARequest(input.message);
    const contextId = contextIdOf(input.message);
    const identity = canonicalSupervisorA2AIdentity({
      contextId,
      messageId: validated.messageId,
      principal: input.principal,
      supervisorId: this.#supervisorId,
      tenant: input.tenant,
    });
    const trustedScope: TrustedSupervisorMessageV2Scope = {
      principal: input.principal,
      tenantId: input.tenant,
    };
    const received = await this.#coordinator.receive(
      trustedScope,
      {
        artifactRefs: [],
        body: validated.body,
        dedupeKey: identity.dedupeKey,
        from: validated.from,
        messageId: validated.messageId,
        policy: this.#policy,
        principal: trustedScope.principal,
        receivedAt: this.#now(),
        schema: SUPERVISOR_MESSAGE_V2_SCHEMA,
        tenantId: trustedScope.tenantId,
        threadId: supervisorA2AV2ThreadId({
          messageId: validated.messageId,
          principal: trustedScope.principal,
          supervisorId: this.#supervisorId,
          tenant: trustedScope.tenantId,
        }),
        to: this.#supervisorId,
      },
      identity.requestId
    );
    try {
      this.#onAccepted?.({
        from: received.projection.from,
        messageId: received.projection.messageId,
        to: received.projection.to,
      });
    } catch {
      // Accepted either way; the hook owns its own failure.
    }
    return {
      contextId,
      scopeId: identity.scopeId,
      state: taskStateFor(received.projection.phase),
      taskId: received.workflowId,
    };
  }
}
