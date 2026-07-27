import { expect, test } from "bun:test";
import {
  bridgeToolName,
  quotedBridgeTool,
  singleBridgeTransportGuidance,
} from "../../src/loop/bridge-guidance";

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

test("quotedBridgeTool wraps the resolved bridge tool name", () => {
  expect(quotedBridgeTool("codex", "send_message")).toBe(
    '"mcp__loop_bridge__send_message"'
  );
  expect(quotedBridgeTool("claude", "receive_messages")).toBe(
    '"receive_messages"'
  );
});
