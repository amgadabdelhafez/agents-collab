import { expect, test } from "bun:test";
import { recipientSeatEnvironment } from "../../src/loop/recipient-seat-environment";

test("startup selects one recipient token and strips the enrollment family from other seats/runs", () => {
  const runDir = "/private/tmp/owned-run";
  const input = {
    PATH: "/usr/bin",
    LOOP_RECIPIENT_ENROLLMENT_RUN_DIR: runDir,
    LOOP_CODEX_RECIPIENT_TOKEN: "fixture-codex",
    LOOP_CLAUDE_RECIPIENT_TOKEN: "fixture-claude",
    LOOP_RECIPIENT_API_URL: "http://127.0.0.1:7337/a2a/recipient",
    LOOP_RECIPIENT_API_TOKEN: "stale-ambient",
  };
  const codex = recipientSeatEnvironment(runDir, "codex", input);
  const claude = recipientSeatEnvironment(runDir, "claude", input);
  expect(codex.LOOP_RECIPIENT_API_TOKEN).toBe("fixture-codex");
  expect(claude.LOOP_RECIPIENT_API_TOKEN).toBe("fixture-claude");
  expect(codex.LOOP_CLAUDE_RECIPIENT_TOKEN).toBeUndefined();
  expect(claude.LOOP_CODEX_RECIPIENT_TOKEN).toBeUndefined();
  expect(codex.LOOP_RECIPIENT_ENROLLMENT_RUN_DIR).toBeUndefined();
  expect(
    recipientSeatEnvironment("/private/tmp/other-run", "codex", input)
  ).toEqual({ PATH: "/usr/bin" });
  expect(recipientSeatEnvironment(runDir, "supervisor", input)).toEqual({
    PATH: "/usr/bin",
  });
  expect(input.LOOP_RECIPIENT_API_TOKEN).toBe("stale-ambient");
  expect(() =>
    recipientSeatEnvironment(runDir, "codex", {
      ...input,
      LOOP_CODEX_RECIPIENT_TOKEN: undefined,
    })
  ).toThrow("protected token");
  expect(() =>
    recipientSeatEnvironment(runDir, "claude", {
      ...input,
      LOOP_CLAUDE_RECIPIENT_TOKEN: undefined,
    })
  ).toThrow("protected token");
  expect(codex.LOOP_RECIPIENT_SEAT).toBe("codex");
  expect(claude.LOOP_RECIPIENT_SEAT).toBe("claude");
  expect(codex.LOOP_RECIPIENT_RUN_DIR).toBe(runDir);
  expect(
    recipientSeatEnvironment(runDir, "codex", {
      PATH: "/usr/bin",
      LOOP_RECIPIENT_API_TOKEN: "stale-ambient",
      LOOP_RECIPIENT_RUN_DIR: runDir,
      LOOP_RECIPIENT_SEAT: "claude",
    })
  ).toEqual({ PATH: "/usr/bin" });
});
