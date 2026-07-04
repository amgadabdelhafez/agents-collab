import type { Agent } from "./types";

export const AGENTS = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "copilot",
] as const;

export const isAgent = (value: string | undefined): value is Agent =>
  value !== undefined && AGENTS.includes(value as (typeof AGENTS)[number]);

export const defaultPeerAgent = (agent: Agent): Agent => {
  const peers: Record<Agent, Agent> = {
    claude: "codex",
    codex: "claude",
    copilot: "claude",
    cursor: "claude",
    gemini: "claude",
  };
  return peers[agent];
};

export const isPersistentAgent = (agent: Agent): agent is "claude" | "codex" =>
  agent === "claude" || agent === "codex";
