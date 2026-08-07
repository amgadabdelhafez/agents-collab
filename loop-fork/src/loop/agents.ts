import type { Agent, HistoricalAgent, RetiredAgent } from "./types";

// Launchable full-agent seats. Anything outside this list cannot start or
// resume an agent, even when a historical manifest still names it.
export const AGENTS = ["claude", "codex", "oss"] as const;

// Retired seats. They stay parseable so historical manifests remain readable
// for diagnosis and reaping, but they are never launchable.
export const RETIRED_AGENTS = ["gemini", "cursor", "copilot"] as const;

export const isAgent = (value: string | undefined): value is Agent =>
  value !== undefined && AGENTS.includes(value as (typeof AGENTS)[number]);

export const isRetiredAgent = (
  value: string | undefined
): value is RetiredAgent =>
  value !== undefined &&
  RETIRED_AGENTS.includes(value as (typeof RETIRED_AGENTS)[number]);

export const isHistoricalAgent = (
  value: string | undefined
): value is HistoricalAgent => isAgent(value) || isRetiredAgent(value);

export const retiredAgentMigrationMessage = (value: string): string =>
  `Agent "${value}" is retired and can no longer launch, pair, review, or resume. Use "oss" (OpenCode-backed, any provider/model identifier) instead.`;

export const retiredBridgeTargetMessage = (target: string): string =>
  isRetiredAgent(target)
    ? `Bridge target "${target}" is retired and can no longer receive messages. Use "oss" instead.`
    : `Unknown target "${target}" - expected one of "claude", "codex", "oss", or "supervisor"`;

export const retiredFlagMigrationMessage = (flag: string): string =>
  `${flag} is retired and can no longer launch, pair, review, or resume. Use the "oss" equivalent (--oss-only, --oss-model, --oss-reviewer-model) instead.`;

export const defaultPeerAgent = (agent: Agent): Agent => {
  const peers: Record<Agent, Agent> = {
    claude: "codex",
    codex: "claude",
    oss: "claude",
  };
  return peers[agent];
};

export const isPersistentAgent = (agent: Agent): agent is "claude" | "codex" =>
  agent === "claude" || agent === "codex";
