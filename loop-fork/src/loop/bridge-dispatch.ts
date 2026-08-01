import {
  type BridgeDeadLetter,
  type BridgeEnqueueOptions,
  type BridgeMessage,
  type BridgeSource,
  enqueueBridgeMessage,
  markBridgeDeadLetterReported,
  markBridgeMessage,
  readBridgeInbox,
  readBridgeStatus,
  readPendingBridgeMessages,
  readUnreportedBridgeDeadLetters,
} from "./bridge-store";
import type { Agent } from "./types";

export interface DeliveryResult {
  entry: BridgeMessage;
  reason?: string;
  status:
    | "accepted"
    | "delivered"
    | "queued"
    | "duplicate"
    | "dead-letter"
    | "expired";
  target: Agent;
}

export type ImmediateBridgeDelivery = (
  entry: BridgeMessage
) => Promise<boolean>;
export type AcceptedBridgeDelivery = () => boolean;

export const bridgeChatId = (runDir: string): string => {
  const runId = readBridgeStatus(runDir).runId || "bridge";
  return `codex_${runId}`;
};

export const acknowledgeBridgeDelivery = (
  runDir: string,
  message: BridgeMessage,
  reason?: string
): void => {
  markBridgeMessage(runDir, message, "delivered", reason);
};

export const consumeBridgeInbox = (
  runDir: string,
  target: Agent,
  reason: string,
  canConsume: (message: BridgeMessage) => boolean = () => true
): BridgeMessage[] => {
  const messages = readBridgeInbox(runDir, target).filter(canConsume);
  for (const message of messages) {
    acknowledgeBridgeDelivery(runDir, message, reason);
  }
  return messages;
};

export const consumeBridgeDeadLetters = (
  runDir: string,
  target: Agent,
  reason: string,
  limit: number
): BridgeDeadLetter[] => {
  const deadLetters = readUnreportedBridgeDeadLetters(runDir, target, limit);
  for (const deadLetter of deadLetters) {
    markBridgeDeadLetterReported(runDir, deadLetter, reason);
  }
  return deadLetters;
};

export const readNextPendingBridgeMessage = (
  runDir: string
): BridgeMessage | undefined => readPendingBridgeMessages(runDir)[0];

export const readNextPendingBridgeMessageForTarget = (
  runDir: string,
  target: Agent
): BridgeMessage | undefined =>
  readPendingBridgeMessages(runDir).find((entry) => entry.target === target);

export const dispatchBridgeMessage = async (
  runDir: string,
  source: BridgeSource,
  target: Agent,
  message: string,
  deliver?: ImmediateBridgeDelivery,
  acceptsDelivery?: AcceptedBridgeDelivery,
  options: BridgeEnqueueOptions = {}
): Promise<DeliveryResult> => {
  const queued = enqueueBridgeMessage(runDir, source, target, message, options);
  const { entry } = queued;
  if (queued.status !== "queued") {
    return {
      entry,
      reason: queued.reason,
      status: queued.status,
      target,
    };
  }
  const delivered = deliver ? await deliver(entry) : false;
  let status: DeliveryResult["status"] = "queued";
  if (delivered) {
    status = "delivered";
  } else if (acceptsDelivery?.()) {
    status = "accepted";
  }
  return { entry, status, target };
};

export const formatDispatchResult = ({
  entry,
  reason,
  status,
  target,
}: DeliveryResult): string => {
  switch (status) {
    case "delivered":
      return `delivered ${entry.id} to ${target}`;
    case "accepted":
      return `accepted ${entry.id} for ${target} delivery`;
    case "duplicate":
      return `deduplicated ${entry.id} for ${target}`;
    case "dead-letter":
      return `dead-lettered ${entry.id} for ${target}: ${reason ?? "queue rejected"}`;
    case "expired":
      return `expired ${entry.id} for ${target}`;
    default:
      return `queued ${entry.id} for ${target}`;
  }
};
