import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/loop/args";
import { buildLoopCodexConfig } from "../../src/loop/codex-home";
import { DEFAULT_CODEX_MODEL } from "../../src/loop/constants";
import { restoreSavedLaunchDefaults } from "../../src/loop/launch-defaults";
import { reservePairedLaunch } from "../../src/loop/launch-reservation";
import { preparePairedRun } from "../../src/loop/paired-options";
import {
  createRunManifest,
  readRunManifest,
  resolveRepoId,
  writeRunManifest,
} from "../../src/loop/run-state";
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
  const opts = parseArgs(["--tmux", "--agent", "codex"]);
  const command = launchCommand("codex", opts);
  expect(command[command.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
  expect(command).toContain('model_reasoning_effort="low"');
  expect(buildLoopCodexConfig("/repo")).toContain('model = "gpt-6.1-sol"');
  expectModels(opts, "gpt-6.1-sol", "claude-sonnet-5-5");
});

test("paired Claude reviewer launch defaults to Sonnet 5.5 at medium effort", () => {
  const opts = parseArgs(["--tmux", "--agent", "codex"]);
  const command = launchCommand("claude", opts);
  expect(command[command.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
  expect(command[command.indexOf("--effort") + 1]).toBe("medium");
  expect(opts.reviewerEffortSource).toBe("default");
});

test("opposite seats retain Claude driver opus/low and Codex reviewer gpt-5.6-sol/high", () => {
  const opts = parseArgs(["--tmux"]);
  expectModels(opts, "gpt-5.6-sol", "opus");
  expect(opts.driverEffort).toBe("low");
  expect(opts.reviewerEffort).toBe("high");
});

test("explicit model and role effort flags override both new launch defaults", () => {
  const opts = parseArgs([
    "--tmux",
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
    "--tmux",
    "--claude-model",
    "claude-driver",
    "--codex-model",
    "gpt-6.1-sol",
    "--codex-reviewer-model",
    "codex-review",
  ]);
  expectModels(opposite, "codex-review", "claude-driver");
  expectModels(
    parseArgs(["--tmux", "--codex-model", "gpt-6.1-sol"]),
    "gpt-6.1-sol",
    "opus"
  );
});

test("environment model and efforts override launch defaults and CLI still wins", () => {
  process.env.LOOP_CODEX_MODEL = "env-codex";
  process.env.LOOP_EFFORT = "max";
  process.env.LOOP_DRIVER_EFFORT = "medium";
  process.env.LOOP_REVIEWER_EFFORT = "xhigh";
  const opts = parseArgs(["--tmux", "--agent", "codex"]);
  expectModels(opts, "env-codex", "claude-sonnet-5-5");
  expect(launchCommand("codex", opts)).toContain(
    'model_reasoning_effort="medium"'
  );
  const claude = launchCommand("claude", opts);
  expect(claude[claude.indexOf("--effort") + 1]).toBe("xhigh");
  const overridden = parseArgs([
    "--tmux",
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

const savedManifest = (seatModels?: { claude?: string; codex: string }) =>
  createRunManifest({
    cwd: "/repo",
    mode: "paired",
    pid: 1234,
    repoId: "repo",
    runId: "saved",
    seatModels,
    state: "running",
  });

test("saved launch defaults preserve legacy models and role efforts", () => {
  const opts = parseArgs(["--tmux", "--agent", "codex"]);
  restoreSavedLaunchDefaults(opts, savedManifest());
  expectModels(opts, "gpt-5.6-sol", "opus");
  expect(opts.driverEffort).toBe("low");
  expect(opts.reviewerEffort).toBe("high");
});

test("saved launch defaults preserve persisted models and efforts", () => {
  const opts = parseArgs(["--tmux", "--agent", "codex"]);
  const manifest = savedManifest({
    claude: "saved-claude",
    codex: "saved-codex",
  });
  manifest.driverEffort = "xhigh";
  manifest.reviewerEffort = "low";
  restoreSavedLaunchDefaults(opts, manifest);
  expectModels(opts, "saved-codex", "saved-claude");
  expect(opts.driverEffort).toBe("xhigh");
  expect(opts.reviewerEffort).toBe("low");
});

test("fresh persisted launch defaults retain the new seat defaults", () => {
  const opts = parseArgs(["--tmux", "--agent", "codex"]);
  const manifest = savedManifest({
    claude: "claude-sonnet-5-5",
    codex: "gpt-6.1-sol",
  });
  manifest.driverEffort = opts.driverEffort;
  manifest.reviewerEffort = opts.reviewerEffort;
  restoreSavedLaunchDefaults(opts, manifest);
  expectModels(opts, "gpt-6.1-sol", "claude-sonnet-5-5");
  expect(opts.reviewerEffort).toBe("medium");
});

test("explicit CLI and environment choices override saved launch defaults", () => {
  process.env.LOOP_CODEX_MODEL = "env-codex";
  process.env.LOOP_REVIEWER_EFFORT = "xhigh";
  const opts = parseArgs([
    "--tmux",
    "--agent",
    "codex",
    "--claude-reviewer-model",
    "cli-claude",
    "--effort-driver",
    "high",
  ]);
  restoreSavedLaunchDefaults(opts, savedManifest());
  expectModels(opts, "env-codex", "cli-claude");
  expect(opts.driverEffort).toBe("high");
  expect(opts.reviewerEffort).toBe("xhigh");
});

test("paired preparation persists fresh defaults and restores legacy or saved models", () => {
  const home = mkdtempSync(join(tmpdir(), "loop-launch-defaults-"));
  const environment = { ...process.env };
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = "fresh";
  try {
    const opts = parseArgs(["--tmux", "--agent", "codex"]);
    const prepared = preparePairedRun(opts);
    expectModels(opts, "gpt-6.1-sol", "claude-sonnet-5-5");
    expect(readRunManifest(prepared.storage.manifestPath)?.seatModels).toEqual({
      claude: "claude-sonnet-5-5",
      codex: "gpt-6.1-sol",
      oss: opts.ossModel,
    });
    const resumed = parseArgs([
      "--tmux",
      "--agent",
      "codex",
      "--run-id",
      "fresh",
    ]);
    preparePairedRun(resumed);
    expectModels(resumed, "gpt-6.1-sol", "claude-sonnet-5-5");
    expect(resumed.reviewerEffort).toBe("medium");
    const legacy = {
      ...prepared.manifest,
      seatModels: undefined,
      reviewerEffort: undefined,
    };
    writeRunManifest(prepared.storage.manifestPath, legacy);
    const old = parseArgs(["--tmux", "--agent", "codex", "--run-id", "fresh"]);
    preparePairedRun(old);
    expectModels(old, "gpt-5.6-sol", "opus");
    expect(old.reviewerEffort).toBe("high");
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in environment)) {
        Reflect.deleteProperty(process.env, name);
      }
    }
    Object.assign(process.env, environment);
    rmSync(home, { force: true, recursive: true });
  }
});

test("fresh launch reservation keeps selected defaults through real paired preparation", async () => {
  const home = mkdtempSync(join(tmpdir(), "loop-reserved-defaults-"));
  const environment = { ...process.env };
  process.env.HOME = home;
  Reflect.deleteProperty(process.env, "LOOP_RUN_ID");
  try {
    const opts = parseArgs(["--tmux", "--agent", "codex"]);
    const cwd = process.cwd();
    const claim = await reservePairedLaunch(
      opts,
      { root: cwd, repoId: resolveRepoId(cwd) },
      {
        home,
        pid: process.pid,
        isPidAlive: () => false,
        tmuxLiveness: () => "dead",
        resolveSocket: () => "/tmp/loop-defaults-test.sock",
      }
    );
    const reserved = readRunManifest(claim.storage.manifestPath);
    expect(reserved?.seatModels?.codex).toBe("gpt-6.1-sol");
    expect(reserved?.seatModels?.claude).toBe("claude-sonnet-5-5");
    expect(reserved?.seatModelsDriver).toBe("codex");
    expect(reserved?.driverEffort).toBe("low");
    expect(reserved?.reviewerEffort).toBe("medium");
    preparePairedRun(opts);
    expectModels(opts, "gpt-6.1-sol", "claude-sonnet-5-5");
    expect(opts.driverEffort).toBe("low");
    expect(opts.reviewerEffort).toBe("medium");
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in environment)) {
        Reflect.deleteProperty(process.env, name);
      }
    }
    Object.assign(process.env, environment);
    rmSync(home, { force: true, recursive: true });
  }
});

test("foreground default models and generic effort stay at legacy defaults", () => {
  const opts = parseArgs(["--agent", "codex"]);
  expect(resolveModel("codex", opts, "work")).toBe("gpt-5.6-sol");
  expect(resolveModel("claude", opts, "review")).toBe("opus");
  expect(opts.reviewerEffort).toBe("high");
  const explicit = parseArgs([
    "--agent",
    "codex",
    "--codex-model",
    "gpt-6.1-sol",
    "--claude-reviewer-model",
    "claude-sonnet-5-5",
  ]);
  expect(resolveModel("codex", explicit, "work")).toBe("gpt-6.1-sol");
  expect(resolveModel("claude", explicit, "review")).toBe("claude-sonnet-5-5");
});

test("resume after a role swap restores each saved model only to the role it held", () => {
  const home = mkdtempSync(join(tmpdir(), "loop-launch-swap-"));
  const environment = { ...process.env };
  process.env.HOME = home;
  process.env.LOOP_RUN_ID = "swap";
  try {
    const prepared = preparePairedRun(
      parseArgs(["--tmux", "--agent", "codex"])
    );
    const path = prepared.storage.manifestPath;
    expect(readRunManifest(path)?.seatModelsDriver).toBe("codex");
    const swapped = parseArgs([
      "--tmux",
      "--agent",
      "claude",
      "--run-id",
      "swap",
    ]);
    preparePairedRun(swapped);
    expectModels(swapped, "gpt-5.6-sol", "opus");
    // Every tmux launch rebinds primaryAgent to the current driver, so it
    // cannot say which role the saved models were launched for.
    const current = readRunManifest(path);
    if (!current) {
      throw new Error("missing manifest");
    }
    writeRunManifest(path, { ...current, primaryAgent: "claude" });
    const again = parseArgs([
      "--tmux",
      "--agent",
      "claude",
      "--run-id",
      "swap",
    ]);
    preparePairedRun(again);
    expectModels(again, "gpt-5.6-sol", "opus");
    const back = parseArgs(["--tmux", "--agent", "codex", "--run-id", "swap"]);
    preparePairedRun(back);
    expectModels(back, "gpt-6.1-sol", "claude-sonnet-5-5");
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in environment)) {
        Reflect.deleteProperty(process.env, name);
      }
    }
    Object.assign(process.env, environment);
    rmSync(home, { force: true, recursive: true });
  }
});

test("old-shape saved models restore by the recorded primary agent", () => {
  const manifest = savedManifest({
    claude: "claude-sonnet-5-5",
    codex: "gpt-6.1-sol",
  });
  manifest.primaryAgent = "codex";
  const swapped = parseArgs(["--tmux", "--agent", "claude"]);
  restoreSavedLaunchDefaults(swapped, manifest);
  expectModels(swapped, "gpt-5.6-sol", "opus");
  const same = parseArgs(["--tmux", "--agent", "codex"]);
  restoreSavedLaunchDefaults(same, manifest);
  expectModels(same, "gpt-6.1-sol", "claude-sonnet-5-5");
  const explicit = parseArgs([
    "--tmux",
    "--agent",
    "claude",
    "--codex-model",
    "cli-codex",
  ]);
  restoreSavedLaunchDefaults(explicit, manifest);
  expectModels(explicit, "cli-codex", "opus");
  // Before role-resolved seat models, one saved Codex model served both roles.
  const preRole = savedManifest({ codex: "codex-both" });
  preRole.primaryAgent = "codex";
  const legacy = parseArgs(["--tmux", "--agent", "claude"]);
  restoreSavedLaunchDefaults(legacy, preRole);
  expectModels(legacy, "codex-both", "opus");
});

test("programmatic options without a codex model source keep legacy foreground defaults", () => {
  const opts = {
    agent: "codex",
    codexModel: DEFAULT_CODEX_MODEL,
    doneSignal: "<done/>",
    format: "raw",
    maxIterations: 1,
    proof: "",
  } as Options;
  expect(opts.codexModelSource).toBeUndefined();
  expect(resolveModel("codex", opts, "work")).toBe("gpt-5.6-sol");
  expect(resolveModel("codex", { ...opts, agent: "claude" }, "review")).toBe(
    "gpt-5.6-sol"
  );
  expect(resolveTmuxModel("codex", opts)).toBe("gpt-6.1-sol");
  expect(resolveModel("codex", { ...opts, codexModel: "custom" }, "work")).toBe(
    "custom"
  );
});
