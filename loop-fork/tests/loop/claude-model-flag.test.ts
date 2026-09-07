import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/loop/args";
import { DEFAULT_CLAUDE_MODEL } from "../../src/loop/constants";
import { resolveModel } from "../../src/loop/runner";
import { resolveTmuxModel } from "../../src/loop/tmux";

// Before this flag the driver seat was hardcoded to DEFAULT_CLAUDE_MODEL and
// only the reviewer seat could be overridden, so "launch on Fable" produced a
// manifest and a process that both said opus. Each seat is checked on its own.
describe("--claude-model reaches the driver seat and only the driver seat", () => {
  const opts = parseArgs([
    "--claude-model",
    "claude-fable-5-1",
    "--claude-reviewer-model",
    "claude-opus-5",
    "--pair-with",
    "codex",
    "--proof",
    "v",
  ]);

  test("the tmux paired driver is launched on the flag's model", () => {
    expect(resolveTmuxModel("claude", opts)).toBe("claude-fable-5-1");
  });

  test("the single-agent runner drives on it and reviews on the reviewer model", () => {
    expect(resolveModel("claude", opts, "work")).toBe("claude-fable-5-1");
    expect(resolveModel("claude", opts, "review")).toBe("claude-opus-5");
  });

  test("with the flag absent the driver still defaults, never inherits the reviewer model", () => {
    const bare = parseArgs([
      "--claude-reviewer-model",
      "claude-opus-5",
      "--proof",
      "v",
    ]);
    expect(resolveTmuxModel("claude", bare)).toBe(DEFAULT_CLAUDE_MODEL);
    expect(resolveModel("claude", bare, "work")).toBe(DEFAULT_CLAUDE_MODEL);
  });
});
