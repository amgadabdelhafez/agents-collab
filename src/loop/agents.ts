import type { Agent } from "./types";

export const AGENTS = ["claude", "codex", "gemini", "cursor"] as const;

export const isAgent = (value: string | undefined): value is Agent =>
  value !== undefined &&
  AGENTS.includes(value as (typeof AGENTS)[number]);

export const defaultPeerAgent = (agent: Agent): Agent =>
  agent === "claude" ? "codex" : "claude";

export const isPersistentAgent = (
  agent: Agent
): agent is "claude" | "codex" =>
  agent === "claude" || agent === "codex";
