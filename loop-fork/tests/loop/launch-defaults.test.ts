import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseArgs } from "../../src/loop/args";
import { buildLoopCodexConfig } from "../../src/loop/codex-home";
import { resolveModel } from "../../src/loop/runner";
import { resolveTmuxModel, tmuxInternals } from "../../src/loop/tmux";
import type { Agent, Options } from "../../src/loop/types";

const launchEnvironment = [
  "LOOP_CODEX_MODEL",
  "LOOP_EFFORT",
  "LOOP_DRIVER_EFFORT",
  "LOOP_REVIEWER_EFFORT",
] as const;
const originalEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of launchEnvironment) {
    originalEnvironment.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }
});

afterEach(() => {
  for (const name of launchEnvironment) {
    const original = originalEnvironment.get(name);
    if (original === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = original;
    }
  }
});

const launchCommand = (agent: Agent, opts: Options): string[] =>
  tmuxInternals.buildPairedAgentCommand({
    agent,
    claudeChannelServer: "loop-bridge-repo-1",
    claudeSessionId: "claude-session",
    codexProxyUrl: "ws://127.0.0.1:4600/",
    hadSession: false,
    nativeSubagentMode: "off",
    opts: { ...opts, codexMcpConfigArgs: ["-c", 'bridge="test"'] },
  });

const expectModels = (opts: Options, codex: string, claude: string): void => {
  for (const [agent, expected] of [
    ["codex", codex],
    ["claude", claude],
  ] as const) {
    expect(resolveTmuxModel(agent, opts)).toBe(expected);
    expect(
      resolveModel(agent, opts, agent === opts.agent ? "work" : "review")
    ).toBe(expected);
  }
};

test("paired Codex driver launch defaults to gpt-6.1-sol at low effort", () => {
  const opts = parseArgs(["--agent", "codex"]);
  const command = launchCommand("codex", opts);
  expect(command[command.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
  expect(command).toContain('model_reasoning_effort="low"');
  expect(buildLoopCodexConfig("/repo")).toContain('model = "gpt-6.1-sol"');
  expectModels(opts, "gpt-6.1-sol", "claude-sonnet-5-5");
});

test("paired Claude reviewer launch defaults to Sonnet 5.5 at medium effort", () => {
  const opts = parseArgs(["--agent", "codex"]);
  const command = launchCommand("claude", opts);
  expect(command[command.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
  expect(command[command.indexOf("--effort") + 1]).toBe("medium");
  expect(opts.reviewerEffortSource).toBe("default");
});

test("opposite seats retain Claude driver opus/low and Codex reviewer gpt-5.6-sol/high", () => {
  const opts = parseArgs([]);
  expectModels(opts, "gpt-5.6-sol", "opus");
  expect(opts.driverEffort).toBe("low");
  expect(opts.reviewerEffort).toBe("high");
});

test("explicit model and role effort flags override both new launch defaults", () => {
  const opts = parseArgs([
    "--agent",
    "codex",
    "--codex-model",
    "gpt-5.6-sol",
    "--claude-reviewer-model",
    "opus",
    "--effort-driver",
    "xhigh",
    "--effort-reviewer",
    "high",
    "--effort",
    "max",
  ]);
  expectModels(opts, "gpt-5.6-sol", "opus");
  expect(launchCommand("codex", opts)).toContain(
    'model_reasoning_effort="xhigh"'
  );
  const claude = launchCommand("claude", opts);
  expect(claude[claude.indexOf("--effort") + 1]).toBe("high");
  const opposite = parseArgs([
    "--claude-model",
    "claude-driver",
    "--codex-model",
    "gpt-6.1-sol",
    "--codex-reviewer-model",
    "codex-review",
  ]);
  expectModels(opposite, "codex-review", "claude-driver");
  expectModels(
    parseArgs(["--codex-model", "gpt-6.1-sol"]),
    "gpt-6.1-sol",
    "opus"
  );
});

test("environment model and efforts override launch defaults and CLI still wins", () => {
  process.env.LOOP_CODEX_MODEL = "env-codex";
  process.env.LOOP_EFFORT = "max";
  process.env.LOOP_DRIVER_EFFORT = "medium";
  process.env.LOOP_REVIEWER_EFFORT = "xhigh";
  const opts = parseArgs(["--agent", "codex"]);
  expectModels(opts, "env-codex", "claude-sonnet-5-5");
  expect(launchCommand("codex", opts)).toContain(
    'model_reasoning_effort="medium"'
  );
  const claude = launchCommand("claude", opts);
  expect(claude[claude.indexOf("--effort") + 1]).toBe("xhigh");
  const overridden = parseArgs([
    "--agent",
    "codex",
    "--codex-model",
    "cli-codex",
    "--claude-reviewer-model",
    "cli-claude",
    "--effort",
    "low",
  ]);
  expectModels(overridden, "cli-codex", "cli-claude");
  expect(overridden.driverEffort).toBe("low");
  expect(overridden.reviewerEffort).toBe("low");
});
