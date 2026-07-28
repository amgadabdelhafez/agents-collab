import { expect, test } from "bun:test";
import {
  bridgeToolName,
  claudeChannelInstructions,
  mandatoryUtilityDelegationGuidance,
  quotedBridgeTool,
  singleBridgeTransportGuidance,
} from "../../src/loop/bridge-guidance";
import { UTILITY_BRIDGE_TOOLS } from "../../src/loop/bridge-utility";

test("bridgeToolName namespaces Codex bridge tools only", () => {
  expect(bridgeToolName("codex", "send_message")).toBe(
    "mcp__loop_bridge__send_message"
  );
  expect(bridgeToolName("codex", "bridge_status")).toBe(
    "mcp__loop_bridge__bridge_status"
  );
  expect(bridgeToolName("claude", "send_message")).toBe("send_message");
});

test("paired guidance requires one bridge transport", () => {
  expect(singleBridgeTransportGuidance).toContain(
    "sole peer-delivery transport"
  );
  expect(singleBridgeTransportGuidance).toContain("tmux send-keys");
});

test("delegation guidance states the exact context and decomposition contract", () => {
  const guidance = mandatoryUtilityDelegationGuidance('"route_task"');
  expect(guidance).toContain(
    "context_refs is optional and accepts only repo-relative README.md"
  );
  expect(guidance).toContain("put narrative facts, SHAs, source paths");
  expect(guidance).toContain("at most two read scopes");
  expect(guidance).toContain("keep cross-file judgment together for Au Pair");
  expect(guidance).toContain("structured execution fields");
  expect(guidance).toContain("truthful risk");
  expect(guidance).toContain(
    "Before authoring a meaningful self-contained code block"
  );
  expect(guidance).toContain("risk=low describes operational side effects");
  expect(guidance).toContain("name each target in both read_scope");
  expect(guidance).toContain("Reserve an active edit packet's write_scope");
  expect(guidance).toContain("full-agent-only guarded apply tool");
  expect(guidance).toContain("Do not split a cohesive small edit");
  expect(guidance).toContain('call "request_native_fallback"');
  expect(guidance).toContain('poll "native_fallback_status"');
  expect(guidance).toContain("Never spawn another profile or a descendant");
});

test("native fallback tools describe the governed evidence and status contract", () => {
  const request = UTILITY_BRIDGE_TOOLS.find(
    (tool) => tool.name === "request_native_fallback"
  );
  const status = UTILITY_BRIDGE_TOOLS.find(
    (tool) => tool.name === "native_fallback_status"
  );
  expect(JSON.stringify(request)).toContain("settled route_task IDs");
  expect(JSON.stringify(request)).toContain("one short-lived run-wide lease");
  expect(JSON.stringify(request)).toContain("human_authorized");
  expect(status?.annotations.readOnlyHint).toBe(true);
});

test("route_task describes the deterministic small-edit contract", () => {
  const routeTask = UTILITY_BRIDGE_TOOLS.find(
    (tool) => tool.name === "route_task"
  );
  const contract = JSON.stringify(routeTask);
  expect(contract).toContain("before doing it natively");
  expect(contract).toContain("one or two exact write files");
  expect(contract).toContain("low operational side-effect/authority risk");
  expect(contract).toContain("Use edit when asking the helper to author");
  expect(contract).toContain("repeats every write target here");
  expect(contract).toContain("directory-broad scopes are not valid");
});

test("Claude channel guidance preserves evidence-dense peer traffic", () => {
  const guidance = claudeChannelInstructions();
  expect(guidance).toContain("Internal agent communication:");
  expect(guidance).toContain("No arbitrary item cap applies");
  expect(guidance).toContain("commands/results");
  expect(guidance).toContain("Separate observed facts from inference");
});

test("quotedBridgeTool wraps the resolved bridge tool name", () => {
  expect(quotedBridgeTool("codex", "send_message")).toBe(
    '"mcp__loop_bridge__send_message"'
  );
  expect(quotedBridgeTool("claude", "receive_messages")).toBe(
    '"receive_messages"'
  );
});
