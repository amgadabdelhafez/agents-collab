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
