import { BRIDGE_SERVER, CLAUDE_CHANNEL_USER } from "./bridge-constants";
import { INTERNAL_AGENT_COMMUNICATION_GUIDANCE } from "./communication-guidance";
import type { Agent } from "./types";

export type BridgeTool =
  | "apply_task_patch"
  | "bridge_status"
  | "get_task_result"
  | "native_fallback_status"
  | "receive_messages"
  | "request_native_fallback"
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
  'When the terminal says bridge messages are waiting, call "receive_messages" immediately; use "bridge_status" only if that pull looks stuck.';

export const singleBridgeTransportGuidance =
  "The loop bridge is the sole peer-delivery transport. A terminal nudge carries no message body; pull the durable body with receive_messages. Never duplicate a bridge body with tmux send-keys, direct terminal injection, or a second delivery path.";

export const sendProactiveCodexGuidance = (): string =>
  `Use "send_message" with ${bridgeTargetLiteral("codex")} for Codex-facing messages, including replies to inbound Codex channel messages; do not send Codex-facing responses as a human-facing message.`;

export const mandatoryUtilityDelegationGuidance = (
  routeTool: string,
  activation: "active" | "on-request" = "active"
): string => {
  const nativeFallbackTool = routeTool.replace(
    "route_task",
    "request_native_fallback"
  );
  const nativeStatusTool = routeTool.replace(
    "route_task",
    "native_fallback_status"
  );
  return [
    ...(activation === "on-request"
      ? [
          "Reviewer ordering: the run task text is context, not an assignment. Until the primary agent or human sends you a targeted request, remain idle: do not inspect task files, call repository tools, or route helper packets.",
        ]
      : []),
    `Delegation is mandatory once you are actively handling an assigned request for clearly bounded work that does not require current-session judgment: call ${routeTool} before using a native repository tool, even when you could do the work yourself.`,
    "At the start of each assigned concrete request, identify one to three independent bounded packets and submit them immediately; while continuing the critical path, keep lower-tier work in flight when another safe packet is available.",
    "Use Nanny only for small one- or two-scope local-Qwen inspection, extraction, classification, and concise summaries. Use Au Pair for bounded multi-step inspection, utility audits, small scoped edits, and reasoning-backed focused verification. Exact deterministic work may run Direct. Governess chooses the tier; never request or assume a provider yourself.",
    "For a bounded low-risk evidence audit that does not grant approval, use kind=review with review_mode=utility-audit, exact read scopes, no writes, inspect capability, and every authority flag false. Use review_mode=peer-verdict or omit review_mode for exact-SHA gates, release decisions, and any review whose verdict must come from Claude or Codex.",
    "For a commit-bound utility audit, use execution_profile=git-diff without raw execution_argv or execution_cwd, put the literal base/head SHAs and required comparisons in the objective, and let Au Pair call the SHA-validating git_diff broker. Raw Git shell text is not helper authority.",
    "Before authoring any meaningful self-contained code block, route it as kind=edit when behavior is decided, one or two exact files may change, at most four exact files supply context, and no authority or cross-cutting judgment remains. Do this before drafting the code, not after a native Edit or Write call. Useful packets include a helper, parser/validator branch, bounded adapter, or focused regression fixture; keep only trivial token substitutions native.",
    "For an exact-scope patch proposal, risk=low describes operational side effects and authority, not reasoning difficulty. Never label ambiguous scope or unresolved design low. Use required_capabilities including scoped-edit, name each target in both read_scope and write_scope, and do not disguise code writing as inspection.",
    "Reserve an active edit packet's write_scope: continue non-overlapping work, but do not edit those files until the job is terminal. Review the returned patch artifact before using the full-agent-only guarded apply tool; never auto-apply helper output.",
    "Each packet must state one objective, exact read/write scopes, truthful risk and authority flags, required capabilities, and concise acceptance criteria. context_refs is optional and accepts only repo-relative README.md, docs/**/*.md, or specs/<feature>/{spec,plan,tasks,verify}.md paths; put narrative facts, SHAs, source paths, and absolute paths in the objective or acceptance criteria instead.",
    "Split independently answerable inspections into separate packets of at most two read scopes when practical so Nanny can take them; keep cross-file judgment together for Au Pair. Do not split a cohesive small edit into Nanny inspection plus main-agent code writing merely to stay inside the Nanny shape.",
    "Use the structured execution fields for exact reads, searches, Git inspection, and focused checks. Prefer separate bounded steps over an opaque compound command, then review returned evidence or patches before relying on them.",
    "Workers never widen declared scope. If a packet must locate a moved or differently nested path, set read_scope to the narrowest common ancestor that can contain every acceptable candidate, not only the path you expect.",
    "Native tools remain appropriate for governing instructions, architecture, product/release decisions, ambiguous or cross-cutting work, peer verdicts, and reviewing returned worker evidence. Being the assigned reviewer does not prevent you from sending separate non-authoritative utility audits to Au Pair.",
    `Provider-native subagents are not another worker pool. Use Direct, Nanny, and Au Pair first. Codex native spawn is disabled because Codex 0.145 inherits the full-access parent sandbox; Codex must keep using the utility tiers or targeted Claude peer review. Only Claude, after a settled helper route cannot finish a bounded read-only exploration or independent review, may call ${nativeFallbackTool}, cite the helper task IDs, poll ${nativeStatusTool} until Governess grants it, and spawn exactly the loop read-only fallback profile. Never spawn another profile or a descendant; strict mode has no native fallback.`,
  ].join("\n");
};

export const claudeChannelInstructions = (): string =>
  [
    `Messages from the Codex agent arrive as <channel source="${BRIDGE_SERVER}" chat_id="..." user="${CLAUDE_CHANNEL_USER}" ...>. The chat_id is informational only.`,
    sendProactiveCodexGuidance(),
    INTERNAL_AGENT_COMMUNICATION_GUIDANCE,
    mandatoryUtilityDelegationGuidance('"route_task"'),
    "Never answer the human when the inbound message came from Codex. Send the response back through the bridge tools instead.",
    bridgeStatusStuckGuidance,
  ].join("\n");
