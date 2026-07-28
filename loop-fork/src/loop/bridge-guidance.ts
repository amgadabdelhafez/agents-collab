import { BRIDGE_SERVER, CLAUDE_CHANNEL_USER } from "./bridge-constants";
import type { Agent } from "./types";

export type BridgeTool =
  | "apply_task_patch"
  | "bridge_status"
  | "get_task_result"
  | "receive_messages"
  | "route_task"
  | "send_message"
  | "task_status";

const bridgeTargetLiteral = (agent: Agent): string => `target: "${agent}"`;
const codexBridgeToolName = (tool: BridgeTool): string =>
  `mcp__${BRIDGE_SERVER.replaceAll("-", "_")}__${tool}`;

export const bridgeToolName = (agent: Agent, tool: BridgeTool): string =>
  agent === "claude" ? tool : codexBridgeToolName(tool);

export const quotedBridgeTool = (agent: Agent, tool: BridgeTool): string =>
  `"${bridgeToolName(agent, tool)}"`;

export const bridgeStatusStuckGuidance =
  'Use "bridge_status" only when direct delivery appears stuck.';

export const receiveMessagesStuckGuidance =
  'Use "bridge_status" or "receive_messages" only if delivery looks stuck.';

export const singleBridgeTransportGuidance =
  "The loop bridge is the sole peer-delivery transport. Never duplicate a bridge message with tmux send-keys, direct terminal injection, or a second delivery path.";

export const sendProactiveCodexGuidance = (): string =>
  `Use "send_message" with ${bridgeTargetLiteral("codex")} for Codex-facing messages, including replies to inbound Codex channel messages; do not send Codex-facing responses as a human-facing message.`;

export const mandatoryUtilityDelegationGuidance = (
  routeTool: string,
  activation: "active" | "on-request" = "active"
): string =>
  [
    ...(activation === "on-request"
      ? [
          "Reviewer ordering: the run task text is context, not an assignment. Until the primary agent or human sends you a targeted request, remain idle: do not inspect task files, call repository tools, or route helper packets.",
        ]
      : []),
    `Delegation is mandatory once you are actively handling an assigned request for clearly bounded work that does not require current-session judgment: call ${routeTool} before using a native repository tool, even when you could do the work yourself.`,
    "At the start of each assigned concrete request, identify one to three independent bounded packets and submit them immediately; while continuing the critical path, keep lower-tier work in flight when another safe packet is available.",
    "Use Nanny for small local-Qwen inspection, extraction, classification, and concise summaries. Use Au Pair for bounded multi-step inspection, small scoped edits, and focused verification. Exact deterministic work may run Direct. Governess chooses the tier; never request or assume a tier yourself.",
    "Each packet must state one objective, exact read/write scopes, risk and authority flags, required capabilities, concise acceptance criteria, and only the minimal context references needed. Prefer separate packets over an opaque compound command, then review returned evidence or patches before relying on them.",
    "Native tools remain appropriate for governing instructions, architecture, product/release decisions, ambiguous or cross-cutting work, and reviewing returned worker evidence.",
  ].join("\n");

export const claudeChannelInstructions = (): string =>
  [
    `Messages from the Codex agent arrive as <channel source="${BRIDGE_SERVER}" chat_id="..." user="${CLAUDE_CHANNEL_USER}" ...>. The chat_id is informational only.`,
    sendProactiveCodexGuidance(),
    mandatoryUtilityDelegationGuidance('"route_task"'),
    "Never answer the human when the inbound message came from Codex. Send the response back through the bridge tools instead.",
    bridgeStatusStuckGuidance,
  ].join("\n");
