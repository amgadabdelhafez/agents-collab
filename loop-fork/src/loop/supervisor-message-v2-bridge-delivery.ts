import type { SupervisorMessageDeliveryPort } from "./supervisor-message-coordinator";
import type { SupervisorMessageV2DeliveryEnvelope } from "./supervisor-message-v2-contract";
import type {
  SupervisorMessageV2DeliveryOutcome,
  SupervisorMessageV2DeliveryPort,
} from "./supervisor-message-v2-runtime";

/**
 * Reuses the governed bridge transport rather than creating a second A2A
 * delivery channel. An `accepted` result means the provider accepted the
 * bridged turn. Recipient claim/acknowledgement remains a separate governed
 * fact and is deliberately not projected here.
 */
export class SupervisorMessageV2BridgeDeliveryPort
  implements SupervisorMessageV2DeliveryPort
{
  readonly #bridge: SupervisorMessageDeliveryPort;

  constructor(bridge: SupervisorMessageDeliveryPort) {
    this.#bridge = bridge;
  }

  deliver(
    envelope: SupervisorMessageV2DeliveryEnvelope
  ): Promise<SupervisorMessageV2DeliveryOutcome> {
    return this.#bridge.deliver({
      artifactRefs: envelope.artifactRefs,
      body: envelope.body,
      idempotencyKey: envelope.idempotencyKey,
      messageId: envelope.messageId,
      target: envelope.target,
      threadId: envelope.threadId,
      workflowId: envelope.workflowId,
    });
  }
}
