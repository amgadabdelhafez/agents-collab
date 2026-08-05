import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceHandoverControl,
  defaultGovernessDeps,
  driveHandoverControl,
  freshRunState,
  type GovernessConfig,
  renderExitControl,
  stopGovernessLoop,
} from "../../src/loop/governess";
import {
  agentCommandIsRunning,
  agentHasExited,
  exitKeyAction,
  HANDOVER_CONTINUATION_PROMPT,
  handoverContinuationFile,
  handoverContinuationText,
  openRawKeyInput,
  paneProbeFromTmuxResult,
  readExitControl,
  replacementLoopArgs,
} from "../../src/loop/governess-exit";
import {
  acceptGovernessHandoff,
  readGovernessHandoffManifest,
} from "../../src/loop/governess-handoff";
import { TmuxControlUnavailableError } from "../../src/loop/tmux-control";

test("x opens a reversible menu and only explicit e or h selects an exit", () => {
  expect(exitKeyAction(false, "idle", "x")).toBe("menu");
  expect(exitKeyAction(false, "idle", "e")).toBeUndefined();
  expect(exitKeyAction(true, "idle", "e")).toBe("teardown");
  expect(exitKeyAction(true, "idle", "h")).toBe("handover");
  expect(exitKeyAction(true, "idle", "x")).toBe("cancel");
  expect(exitKeyAction(true, "idle", "c")).toBe("cancel");
  expect(exitKeyAction(true, "idle", "\u001b")).toBe("cancel");
});

test("handover accepts only force teardown and launch retry keys", () => {
  expect(exitKeyAction(false, "handover", "e")).toBe("teardown");
  expect(exitKeyAction(false, "handover", "h")).toBeUndefined();
  expect(exitKeyAction(false, "launch-error", "h")).toBe("handover");
  expect(exitKeyAction(false, "launch-error", "e")).toBe("teardown");
});

test("persisted exit state is validated", () => {
  expect(
    readExitControl({
      exitRequested: {},
      handoverEpoch: 41,
      mode: "handover",
      notified: {},
      requestedAt: "2026-08-05T02:38:25.017Z",
    })
  ).toEqual({
    handoverEpoch: 41,
    mode: "handover",
    notified: {},
    requestedAt: "2026-08-05T02:38:25.017Z",
  });
  expect(
    readExitControl({
      exitRequested: { codex: true, unknown: true },
      launchError: "boom",
      mode: "launch-error",
      notified: { claude: true, codex: false, unknown: true },
      requestedAt: "2026-07-25T00:00:00.000Z",
    })
  ).toEqual({
    exitRequested: { codex: true },
    launchError: "boom",
    mode: "launch-error",
    notified: { claude: true },
    requestedAt: "2026-07-25T00:00:00.000Z",
  });
  expect(readExitControl({ mode: "invalid", notified: [] })).toEqual({
    mode: "idle",
    notified: {},
  });
  expect(
    readExitControl({ handoverEpoch: -1, mode: "handover", notified: {} })
  ).toEqual({ mode: "handover", notified: {} });
  expect(readExitControl({ mode: "launched", notified: {} })).toEqual({
    launchError: "replacement session was not persisted",
    mode: "launch-error",
    notified: {},
  });
});

test("agent exit detection distinguishes the TUI from a dead pane or shell", () => {
  expect(agentCommandIsRunning("claude", "0:claude")).toBe(true);
  expect(agentCommandIsRunning("codex", "0:codex")).toBe(true);
  expect(agentCommandIsRunning("codex", "1:codex")).toBe(false);
  expect(agentCommandIsRunning("codex", "0:zsh")).toBe(false);
  expect(agentHasExited("codex", "1:codex")).toBe(true);
  expect(agentHasExited("codex", "0:zsh")).toBe(true);
  expect(agentHasExited("codex", "0:codex-aarch64-a")).toBe(false);
  expect(agentHasExited("codex", "0:node")).toBe(false);
  expect(agentHasExited("codex", "")).toBe(false);
  expect(agentHasExited("codex", undefined)).toBe(false);
  expect(agentHasExited("codex", "malformed")).toBe(false);
});

test("tmux pane probes preserve confirmed missing targets but not empty successful output", () => {
  expect(paneProbeFromTmuxResult(0, "0:codex-aarch64-a\n")).toBe(
    "0:codex-aarch64-a"
  );
  expect(paneProbeFromTmuxResult(0, "0:zsh\n")).toBe("0:zsh");
  expect(paneProbeFromTmuxResult(1, "")).toBe("1:missing");
  expect(paneProbeFromTmuxResult(1, "unexpected output")).toBe("1:missing");
  expect(paneProbeFromTmuxResult(0, "\n")).toBeUndefined();
  expect(agentHasExited("codex", paneProbeFromTmuxResult(1, ""))).toBe(true);
});

test("replacement args preserve pairing and supply a continuation prompt", () => {
  const args = replacementLoopArgs("claude", "codex");
  expect(args).toEqual([
    "--tmux",
    "--governess",
    "--agent",
    "claude",
    "--pair-with",
    "codex",
    "--prompt",
    HANDOVER_CONTINUATION_PROMPT,
  ]);
});

test("replacement handover uses a markdown continuation file to skip replanning", () => {
  const dir = "/tmp/handoff/42";
  expect(handoverContinuationFile(dir)).toBe("/tmp/handoff/42/continuation.md");
  expect(handoverContinuationText(dir)).toContain(
    "Read every validated handover bundle in /tmp/handoff/42 before acting."
  );
  expect(replacementLoopArgs("claude", "codex", dir)).toEqual([
    "--tmux",
    "--governess",
    "--agent",
    "claude",
    "--pair-with",
    "codex",
    "--prompt",
    "/tmp/handoff/42/continuation.md",
  ]);
});

test("replacement handover carries exact frozen role efforts", () => {
  expect(
    replacementLoopArgs("claude", "codex", "/tmp/handoff/42", {
      driverEffort: "medium",
      reviewerEffort: "high",
    })
  ).toEqual([
    "--tmux",
    "--governess",
    "--agent",
    "claude",
    "--pair-with",
    "codex",
    "--effort-driver",
    "medium",
    "--effort-reviewer",
    "high",
    "--prompt",
    "/tmp/handoff/42/continuation.md",
  ]);
});

test("exit controls replace the status row without growing the board", () => {
  const board = "status\nrow 2\nrow 3";
  const agents = [
    { agent: "claude" as const, hookFile: "", pane: "session:0.0" },
    { agent: "codex" as const, hookFile: "", pane: "session:0.1" },
  ];
  const menu = renderExitControl(
    board,
    readExitControl(undefined),
    true,
    agents,
    () => ""
  );
  expect(menu.split("\n")).toHaveLength(3);
  expect(menu.split("\n")[0]).toContain("[e] tear down loop");
  expect(menu.split("\n")[0]).toContain("[h] hand over to new loop");

  const progress = renderExitControl(
    board,
    readExitControl({ mode: "handover", notified: { claude: true } }),
    false,
    agents,
    (pane) => (pane.endsWith(".0") ? "0:claude" : "0:codex"),
    { claude: "/handoff/claude.json" }
  );
  expect(progress.split("\n")[0]).toContain("claude:exiting");
  expect(progress.split("\n")[0]).toContain("codex:finishing");
});

const handoverConfig = (): GovernessConfig =>
  ({
    agents: [
      { agent: "claude", hookFile: "claude", pane: "session:0.0" },
      { agent: "codex", hookFile: "codex", pane: "session:0.1" },
    ],
    driverEffort: "medium",
    initialDriver: "claude",
    epoch: 1,
    logFile: "/tmp/governess-test.jsonl",
    runDir: mkdtempSync(join(tmpdir(), "governess-exit-test-")),
    reviewerEffort: "high",
    session: "session",
  }) as GovernessConfig;

const writeHandoverBundles = (
  config: GovernessConfig,
  state: ReturnType<typeof freshRunState>,
  agents: Array<"claude" | "codex"> = ["claude", "codex"]
): void => {
  const dir = join(
    config.runDir as string,
    "handoff",
    String(state.governessEpoch)
  );
  mkdirSync(dir, { recursive: true });
  for (const agent of agents) {
    writeFileSync(
      join(dir, `${agent}.json`),
      JSON.stringify({
        agent,
        blockers: [],
        checks: ["focused tests"],
        dirtyFiles: [],
        epoch: state.governessEpoch,
        gitHead: "abc123",
        next: "continue",
        status: "ready",
        summary: "atomic step complete",
      })
    );
  }
};

const acceptReplacement = (
  state: ReturnType<typeof freshRunState>,
  session = "replacement"
): void => {
  const manifest = state.exitControl.handoverManifest;
  if (!manifest) {
    throw new Error("handover manifest was not persisted");
  }
  const accepted = acceptGovernessHandoff(
    manifest,
    session,
    state.governessEpoch + 1,
    "2026-07-25T00:00:01.000Z"
  );
  if (!accepted) {
    throw new Error("handover manifest was not accepted");
  }
};

test("handover waits for a busy agent, notifies each once, and launches after both exit", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: {},
    requestedAt: "2026-07-25T00:00:00.000Z",
  };
  const direct: string[] = [];
  const directOrder: string[] = [];
  const bridged: string[] = [];
  let launched = 0;
  let claudeTurnEnded = false;
  let saved = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: () => {
      launched += 1;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: (pane: string) =>
      pane.endsWith(".0") ? "0:claude" : "0:codex",
    readHooks: (file: string) =>
      file === "codex" || claudeTurnEnded
        ? [{ agent: "claude" as const, event: "Stop", ts: "now" }]
        : [],
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => {
      saved += 1;
    },
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
    sendKeys: (_pane: string, keys: string[]) =>
      directOrder.push(`keys:${keys.join(",")}`),
    sendText: (_pane: string, text: string) => {
      direct.push(text);
      directOrder.push("text");
    },
    sleep: (ms: number) => {
      directOrder.push(`sleep:${ms}`);
      return Promise.resolve();
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "working",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ codex: true });
  expect(saved).toBe(1);
  expect(bridged).toEqual(["codex"]);
  expect(direct).toHaveLength(0);
  expect(directOrder).toEqual([]);
  expect(launched).toBe(0);

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ codex: true });
  expect(direct).toHaveLength(0);

  claudeTurnEnded = true;
  deps.paneCommand = () => "0:zsh";
  writeHandoverBundles(config, state);
  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ claude: true, codex: true });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.replacementSession).toBe("replacement");
  expect(direct).toHaveLength(0);
  expect(directOrder).toEqual([]);
  expect(bridged).toEqual(["codex", "claude"]);
  expect(launched).toBe(1);
  expect(saved).toBe(3);

  acceptReplacement(state);
  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    session: "replacement",
    status: "launched",
  });
  expect(launched).toBe(1);
});

test("handover never injects over a notification or permission prompt", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: {},
  };
  const direct: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: (pane: string) =>
      pane.endsWith(".0") ? "0:claude" : "0:codex",
    readHooks: () => [
      { agent: "claude" as const, event: "Stop", ts: "before-notification" },
      {
        agent: "claude" as const,
        detail: "Claude needs your permission",
        event: "Notification",
        ts: "now",
      },
    ],
    saveState: () => undefined,
    sendText: (_pane: string, text: string) => direct.push(text),
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({});
  expect(direct).toEqual([]);
});

test("handover treats a dim idle suggestion as an empty composer", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = { mode: "handover", notified: {} };
  const bridged: string[] = [];
  const styledCaptures: boolean[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: (_pane: string, styled = false) => {
      styledCaptures.push(styled);
      return styled
        ? "\u001b[39m› \u001b[2mWrite tests for @filename\u001b[0m\nfooter"
        : "› Write tests for @filename\nfooter";
    },
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: () => "0:codex-aarch64-a",
    readHooks: () => [{ agent: "codex" as const, event: "Stop", ts: "now" }],
    saveState: () => undefined,
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "working",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(styledCaptures).toEqual([true]);
  expect(state.exitControl.notified).toEqual({ codex: true });
  expect(bridged).toEqual(["codex"]);
});

test("handover accepts Claude Stop followed by trailing SubagentStop", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    exitRequested: { codex: true },
    mode: "handover",
    notified: { codex: true },
  };
  const bridged: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () =>
      "\u001b[39m❯ \u001b[2mstart T2 now: run C5 then C2\u001b[0m\nfooter",
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: () => "0:claude",
    readHooks: () => [
      { agent: "claude" as const, event: "Stop", ts: "now" },
      { agent: "claude" as const, event: "SubagentStop", ts: "now" },
    ],
    saveState: () => undefined,
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "exited",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ claude: true, codex: true });
  expect(bridged).toEqual(["claude"]);
});

test("handover exits Claude after its exact generic idle notification", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    exitRequested: { codex: true },
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const exitKeys: [string, string[]][] = [];
  const exitText: [string, string][] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () =>
      "\u001b[39m❯ \u001b[2mstop here, waiting for the supervisor to launch loop-132\u001b[0m\nfooter",
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: (pane: string) => (pane.endsWith(".0") ? "0:claude" : "0:zsh"),
    readHooks: () => [
      { agent: "claude" as const, event: "Stop", ts: "parent-stopped" },
      {
        agent: "claude" as const,
        event: "SubagentStop",
        ts: "subagent-stopped",
      },
      {
        agent: "claude" as const,
        detail: "Claude is waiting for your input",
        event: "Notification",
        ts: "idle-notification",
      },
    ],
    saveState: () => undefined,
    sendKeys: (pane: string, keys: string[]) => exitKeys.push([pane, keys]),
    sendText: (pane: string, text: string) => exitText.push([pane, text]),
    sleep: async () => undefined,
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "exited",
    })
  ).toEqual({ status: "waiting" });
  expect(exitText).toEqual([["session:0.0", "/exit"]]);
  expect(exitKeys).toEqual([["session:0.0", ["Enter"]]]);
  expect(state.exitControl.exitRequested).toEqual({
    claude: true,
    codex: true,
  });
});

test("handover still blocks a non-dim composer draft", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = { mode: "handover", notified: {} };
  const bridged: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () =>
      "\u001b[39m› start T2 now: run C5 then C2\u001b[0m\nfooter",
    fenceCurrent: () => true,
    now: () => 0,
    paneCommand: () => "0:codex-aarch64-a",
    readHooks: () => [{ agent: "codex" as const, event: "Stop", ts: "now" }],
    saveState: () => undefined,
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "working",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({});
  expect(bridged).toEqual([]);
});

test("valid ready bundles close each drained TUI exactly once before launch", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const exitKeys: [string, string[]][] = [];
  const exitText: [string, string][] = [];
  let agentsExited = false;
  let launched = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: () => {
      launched += 1;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: (pane: string) => {
      if (agentsExited) {
        return "0:zsh";
      }
      return pane.endsWith(".0") ? "0:claude" : "0:codex";
    },
    readHooks: () => [{ agent: "claude" as const, event: "Stop", ts: "now" }],
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => undefined,
    sendKeys: (pane: string, keys: string[]) => exitKeys.push([pane, keys]),
    sendText: (pane: string, text: string) => exitText.push([pane, text]),
    sleep: async () => undefined,
  };

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(exitKeys).toEqual([
    ["session:0.0", ["Enter"]],
    ["session:0.1", ["Enter"]],
  ]);
  expect(exitText).toEqual([
    ["session:0.0", "/exit"],
    ["session:0.1", "/exit"],
  ]);
  expect(state.exitControl.exitRequested).toEqual({
    claude: true,
    codex: true,
  });
  expect(launched).toBe(0);

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(exitKeys).toHaveLength(2);
  expect(exitText).toHaveLength(2);

  agentsExited = true;
  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    status: "waiting",
  });
  expect(launched).toBe(1);
  acceptReplacement(state);
  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    session: "replacement",
    status: "launched",
  });
});

test("headless handover skips the missing pane and reaches owned teardown after acceptance", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const order: string[] = [];
  let claudeExited = false;
  let launches = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: (_file: string, record: unknown) =>
      order.push(`log:${(record as { event: string }).event}`),
    capturePane: () => "",
    cleanupRunProcesses: () => {
      order.push("cleanup");
      return { killed: [321], skipped: [] };
    },
    fenceCurrent: () => true,
    killSession: () => order.push("kill"),
    launchReplacementLoop: () => {
      launches += 1;
      order.push("launch");
      return { ok: true, session: "replacement" };
    },
    markRunStopped: () => order.push("mark"),
    now: () => 0,
    paneCommand: (pane: string) => {
      if (pane.endsWith(".1")) {
        return "1:missing";
      }
      return claudeExited ? "0:zsh" : "0:claude";
    },
    readHooks: () => [{ agent: "claude" as const, event: "Stop", ts: "now" }],
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => order.push(`save:${state.exitControl.mode}`),
    sendKeys: (pane: string, keys: string[]) =>
      order.push(`keys:${pane}:${keys.join(",")}`),
    sendText: (pane: string, text: string) =>
      order.push(`text:${pane}:${text}`),
    sleep: async () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(order.filter((item) => item.startsWith("text:"))).toEqual([
    "text:session:0.0:/exit",
  ]);
  expect(order.some((item) => item.includes("session:0.1"))).toBe(false);
  expect(launches).toBe(0);

  claudeExited = true;
  order.length = 0;
  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(launches).toBe(1);
  expect(state.exitControl.mode).toBe("launched");
  expect(order).not.toContain("mark");
  expect(order).not.toContain("cleanup");
  expect(order).not.toContain("kill");

  acceptReplacement(state);
  order.length = 0;
  expect(await driveHandoverControl(config, deps, state, {})).toBe(true);
  expect(launches).toBe(1);
  expect(order).toEqual([
    "save:launched",
    "log:exit",
    "mark",
    "cleanup",
    "log:run-process-cleanup",
    "kill",
  ]);
});

test("unknown pane evidence keeps headless handover non-destructive", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const terminal: string[] = [];
  let launches = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: (pane: string) => {
      if (pane.endsWith(".1")) {
        throw new TmuxControlUnavailableError(["capture-pane", "-t", pane]);
      }
      return "";
    },
    fenceCurrent: () => true,
    launchReplacementLoop: () => {
      launches += 1;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: (pane: string) => (pane.endsWith(".1") ? undefined : "0:zsh"),
    readHooks: () => [{ agent: "claude" as const, event: "Stop", ts: "now" }],
    saveState: () => undefined,
    sendKeys: (pane: string) => terminal.push(`keys:${pane}`),
    sendText: (pane: string) => terminal.push(`text:${pane}`),
    sleep: async () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(launches).toBe(0);
  expect(terminal).toEqual([]);
  expect(state.exitControl.mode).toBe("handover");
});

test("replacement launch failure preserves the old loop for explicit retry or teardown", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: () => ({ error: "could not launch", ok: false }),
    now: () => 0,
    paneCommand: () => "0:zsh",
  };

  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    error: "could not launch",
    status: "launch-error",
  });
  expect(state.exitControl.mode).toBe("launch-error");
  expect(state.exitControl.launchError).toBe("could not launch");
});

test("handover persists launch success before marking and killing the old loop", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const order: string[] = [];
  let launches = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: (_file: string, record: unknown) =>
      order.push(`log:${(record as { event: string }).event}`),
    capturePane: () => "",
    fenceCurrent: () => true,
    killSession: () => order.push("kill"),
    launchReplacementLoop: () => {
      launches += 1;
      order.push("launch");
      return { ok: true, session: "replacement" };
    },
    markRunStopped: () => order.push("mark"),
    now: () => 0,
    paneCommand: () => "0:zsh",
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => order.push(`save:${state.exitControl.mode}`),
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(order).toEqual([
    "launch",
    "log:handover-launched",
    "save:launched",
    "save:launched",
  ]);
  expect(launches).toBe(1);

  acceptReplacement(state);
  order.length = 0;
  expect(await driveHandoverControl(config, deps, state, {})).toBe(true);
  expect(launches).toBe(1);
  expect(order).toEqual(["save:launched", "log:exit", "mark", "kill"]);
});

test("handover launch failure never marks or kills the old loop", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  const destructive: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    killSession: () => destructive.push("kill"),
    launchReplacementLoop: () => ({ error: "failed", ok: false }),
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    paneCommand: () => "0:zsh",
    saveState: () => undefined,
  };
  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(destructive).toEqual([]);
  expect(state.exitControl.mode).toBe("launch-error");
});

test("handover restart keeps the persisted transaction epoch for replacement launch", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.governessEpoch = 41;
  writeHandoverBundles(config, state);
  const handoffDir = join(config.runDir as string, "handoff", "41");
  state.handoverBundles = {
    claude: join(handoffDir, "claude.json"),
    codex: join(handoffDir, "codex.json"),
  };
  state.exitControl = {
    exitRequested: { claude: true, codex: true },
    mode: "handover",
    notified: { claude: true, codex: true },
  };

  // A restarted Governess must acquire a fresh fencing epoch without
  // rebinding the already-complete handoff transaction to that epoch.
  state.governessEpoch = 99;
  config.epoch = 99;
  let launchedManifest: string | undefined;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: (_config: GovernessConfig, manifest: string) => {
      launchedManifest = manifest;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: () => "0:zsh",
    replacementSessionAlive: () => true,
    replacementSessionReady: () => true,
    saveState: () => undefined,
  };

  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    status: "waiting",
  });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.handoverEpoch).toBe(41);
  expect(launchedManifest).toBe(join(handoffDir, "manifest.json"));
  expect(readGovernessHandoffManifest(launchedManifest as string)?.epoch).toBe(
    41
  );
  expect(
    readGovernessHandoffManifest(launchedManifest as string)
  ).toMatchObject({
    driverEffort: "medium",
    reviewerEffort: "high",
  });
});

test("restart preserves the old loop when the recorded replacement is dead", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "launched",
    notified: { claude: true, codex: true },
    replacementSession: "dead-replacement",
  };
  const destructive: string[] = [];
  let launched = 0;
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    killSession: () => destructive.push("kill"),
    launchReplacementLoop: () => {
      launched += 1;
      return { ok: true, session: "another-replacement" };
    },
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    replacementSessionAlive: () => false,
    replacementSessionReady: () => false,
    saveState: () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(state.exitControl.mode).toBe("launch-error");
  expect(state.exitControl.launchError).toContain("is not running");
  expect(launched).toBe(0);
  expect(destructive).toEqual([]);
});

test("restart preserves a recorded replacement while tmux liveness is unknown", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    handoverManifest: "pending-acceptance.json",
    mode: "launched",
    notified: { claude: true, codex: true },
    replacementSession: "possibly-live-replacement",
  };
  const destructive: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    killSession: () => destructive.push("kill"),
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    replacementSessionAlive: () => "unknown" as const,
    replacementSessionReady: () => "unknown" as const,
    saveState: () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.replacementSession).toBe(
    "possibly-live-replacement"
  );
  expect(state.exitControl.launchError).toBeUndefined();
  expect(destructive).toEqual([]);
});

test("an unconfirmed replacement probe is persisted without duplicate launch", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  writeHandoverBundles(config, state);
  let launches = 0;
  let replacementAlive: boolean | "unknown" = "unknown";
  let replacementReady: boolean | "unknown" = "unknown";
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => undefined,
    capturePane: () => "",
    fenceCurrent: () => true,
    launchReplacementLoop: () => {
      launches += 1;
      return { ok: true, session: "possibly-live-replacement" };
    },
    now: () => 0,
    paneCommand: () => "0:zsh",
    replacementSessionAlive: () => replacementAlive,
    replacementSessionReady: () => replacementReady,
    saveState: () => undefined,
  };

  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    status: "waiting",
  });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.replacementSession).toBe(
    "possibly-live-replacement"
  );
  expect(launches).toBe(1);

  replacementAlive = true;
  replacementReady = false;
  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    status: "waiting",
  });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.launchError).toBeUndefined();
  expect(launches).toBe(1);
});

test("explicit stop marks the run before killing its tmux session", () => {
  const config = handoverConfig();
  const order: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => order.push("log"),
    capturePane: () => "",
    cleanupRunProcesses: () => {
      order.push("cleanup");
      return { killed: [], skipped: [] };
    },
    fenceCurrent: () => true,
    killSession: () => order.push("kill"),
    markRunStopped: () => order.push("mark"),
    now: () => 0,
  };
  stopGovernessLoop(config, deps, "user requested teardown");
  expect(order).toEqual(["log", "mark", "cleanup", "kill"]);
});

test("cleanup failure cannot prevent explicit tmux teardown", () => {
  const config = handoverConfig();
  const order: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: () => order.push("log"),
    capturePane: () => "",
    cleanupRunProcesses: () => {
      order.push("cleanup");
      throw new Error("cleanup unavailable");
    },
    fenceCurrent: () => true,
    killSession: () => order.push("kill"),
    markRunStopped: () => order.push("mark"),
    now: () => 0,
  };

  stopGovernessLoop(config, deps, "user requested teardown");

  expect(order).toEqual(["log", "mark", "cleanup", "log", "kill"]);
});

test("explicit teardown returns and records an unconfirmed tmux kill", () => {
  const config = handoverConfig();
  const events: string[] = [];
  const deps = {
    ...defaultGovernessDeps(),
    appendLog: (_file: string, record: unknown) =>
      events.push((record as { event: string }).event),
    cleanupRunProcesses: () => ({ killed: [], skipped: [] }),
    fenceCurrent: () => true,
    killSession: () => {
      throw new TmuxControlUnavailableError([
        "kill-session",
        "-t",
        config.session,
      ]);
    },
    markRunStopped: () => events.push("mark"),
    now: () => 0,
  };

  expect(() =>
    stopGovernessLoop(config, deps, "user requested teardown")
  ).not.toThrow();
  expect(events).toEqual(["exit", "mark", "tmux-session-kill-unconfirmed"]);
});

class FakeTty extends EventEmitter {
  isRaw = false;
  isTTY = true;
  paused = false;

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setEncoding(): this {
    return this;
  }

  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    return this;
  }
}

test("raw key input emits individual keys and restores the terminal", async () => {
  const input = new FakeTty();
  const keys = openRawKeyInput(input as never);
  expect(keys).toBeDefined();
  expect(input.isRaw).toBe(true);
  input.emit("data", "xh");
  expect(await keys?.next()).toBe("x");
  expect(await keys?.next()).toBe("h");
  keys?.close();
  expect(input.isRaw).toBe(false);
  expect(input.paused).toBe(true);
  expect(input.listenerCount("data")).toBe(0);
});
