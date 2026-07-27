import { expect, test } from "bun:test";
import {
  formatBridgeDeliveryMessage,
  formatCodexBridgeMessage,
  normalizeBridgeMessage,
} from "../../src/loop/bridge-message-format";

test("internal utility sources are presented as worker", () => {
  expect(formatCodexBridgeMessage("utility", "Task completed.")).toBe(
    "Worker: Task completed."
  );
  expect(
    formatBridgeDeliveryMessage({
      at: "2026-07-26T00:00:00.000Z",
      id: "worker-message",
      kind: "message",
      message: "Task completed.",
      source: "utility",
      target: "codex",
    })
  ).toBe("Worker: Task completed.");
  expect(normalizeBridgeMessage("Utility: Task completed.")).toBe(
    "Task completed."
  );
  expect(normalizeBridgeMessage("Worker: Task completed.")).toBe(
    "Task completed."
  );
});
