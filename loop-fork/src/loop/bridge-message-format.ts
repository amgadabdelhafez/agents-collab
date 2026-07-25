import type { BridgeMessage } from "./bridge-store";
import type { Agent } from "./types";

const BRIDGE_PREFIX_RE =
  /^(?:Message from (?:Claude|Codex|Gemini|Cursor) via the loop bridge:|(?:Claude|Codex|Gemini|Cursor):)\s*/i;

const capitalize = (value: string): string =>
  value.slice(0, 1).toUpperCase() + value.slice(1);

export const formatCodexBridgeMessage = (
  source: Agent,
  message: string
): string => {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  return source === "codex" ? trimmed : `${capitalize(source)}: ${trimmed}`;
};

export const normalizeBridgeMessage = (message: string): string =>
  message.trim().replace(BRIDGE_PREFIX_RE, "").replace(/\s+/g, " ").trim();

export const formatBridgeDeliveryMessage = (message: BridgeMessage): string => {
  const body = formatCodexBridgeMessage(message.source, message.message);
  const metadata = [
    message.type && message.type !== "message" ? `type=${message.type}` : "",
    message.priority && message.priority !== "normal"
      ? `priority=${message.priority}`
      : "",
    message.subject ? `subject=${message.subject}` : "",
    message.taskId ? `task=${message.taskId}` : "",
    message.threadId ? `thread=${message.threadId}` : "",
    message.replyTo ? `reply_to=${message.replyTo}` : "",
  ].filter(Boolean);
  return metadata.length > 0 ? `[bridge ${metadata.join(" ")}]\n${body}` : body;
};
