import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  advanceHandoverControl,
  type BabysitConfig,
  defaultBabysitDeps,
  driveHandoverControl,
  freshRunState,
  renderExitControl,
  stopBabysatLoop,
} from "../../src/loop/babysitter";
import {
  agentCommandIsRunning,
  agentHasExited,
  exitKeyAction,
  HANDOVER_CONTINUATION_PROMPT,
  openRawKeyInput,
  readExitControl,
  replacementLoopArgs,
} from "../../src/loop/babysitter-exit";

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
      launchError: "boom",
      mode: "launch-error",
      notified: { claude: true, codex: false, unknown: true },
      requestedAt: "2026-07-25T00:00:00.000Z",
    })
  ).toEqual({
    launchError: "boom",
    mode: "launch-error",
    notified: { claude: true },
    requestedAt: "2026-07-25T00:00:00.000Z",
  });
  expect(readExitControl({ mode: "invalid", notified: [] })).toEqual({
    mode: "idle",
    notified: {},
  });
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

test("replacement args preserve pairing and supply a continuation prompt", () => {
  const args = replacementLoopArgs("claude", "codex");
  expect(args).toEqual([
    "--tmux",
    "--babysit",
    "--agent",
    "claude",
    "--pair-with",
    "codex",
    "--prompt",
    HANDOVER_CONTINUATION_PROMPT,
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
    (pane) => (pane.endsWith(".0") ? "0:claude" : "0:codex")
  );
  expect(progress.split("\n")[0]).toContain("claude:exiting");
  expect(progress.split("\n")[0]).toContain("codex:finishing");
});

const handoverConfig = (): BabysitConfig =>
  ({
    agents: [
      { agent: "claude", hookFile: "", pane: "session:0.0" },
      { agent: "codex", hookFile: "", pane: "session:0.1" },
    ],
    initialDriver: "claude",
    logFile: "/tmp/babysitter-test.jsonl",
    runDir: "/tmp/babysitter-test",
    session: "session",
  }) as BabysitConfig;

test("handover waits for a busy agent, notifies each once, and launches after both exit", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: {},
    requestedAt: "2026-07-25T00:00:00.000Z",
  };
  const direct: string[] = [];
  const bridged: string[] = [];
  let launched = 0;
  let claudeTurnEnded = false;
  let saved = 0;
  const deps = {
    ...defaultBabysitDeps(),
    appendLog: () => undefined,
    launchReplacementLoop: () => {
      launched += 1;
      return { ok: true, session: "replacement" };
    },
    now: () => 0,
    paneCommand: (pane: string) =>
      pane.endsWith(".0") ? "0:claude" : "0:codex",
    readHooks: () =>
      claudeTurnEnded
        ? [{ agent: "claude" as const, event: "Stop", ts: "now" }]
        : [],
    replacementSessionAlive: () => true,
    saveState: () => {
      saved += 1;
    },
    sendBridge: (_runDir: string, _source: string, target: string) => {
      bridged.push(target);
      return Promise.resolve("accepted" as const);
    },
    sendKeys: () => undefined,
    sendText: (_pane: string, text: string) => direct.push(text),
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
  expect(direct).toEqual([]);
  expect(launched).toBe(0);

  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ status: "waiting" });
  expect(state.exitControl.notified).toEqual({ codex: true });
  expect(direct).toEqual([]);

  claudeTurnEnded = true;
  deps.paneCommand = () => "0:zsh";
  expect(
    await advanceHandoverControl(config, deps, state, {
      claude: "idle",
      codex: "idle",
    })
  ).toEqual({ session: "replacement", status: "launched" });
  expect(state.exitControl.notified).toEqual({ claude: true, codex: true });
  expect(state.exitControl.mode).toBe("launched");
  expect(state.exitControl.replacementSession).toBe("replacement");
  expect(direct).toHaveLength(1);
  expect(bridged).toEqual(["codex"]);
  expect(launched).toBe(1);
  expect(saved).toBe(3);

  expect(await advanceHandoverControl(config, deps, state, {})).toEqual({
    session: "replacement",
    status: "launched",
  });
  expect(launched).toBe(1);
});

test("replacement launch failure preserves the old loop for explicit retry or teardown", async () => {
  const config = handoverConfig();
  const state = freshRunState();
  state.exitControl = {
    mode: "handover",
    notified: { claude: true, codex: true },
  };
  const deps = {
    ...defaultBabysitDeps(),
    appendLog: () => undefined,
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
  const order: string[] = [];
  let launches = 0;
  const deps = {
    ...defaultBabysitDeps(),
    appendLog: (_file: string, record: unknown) =>
      order.push(`log:${(record as { event: string }).event}`),
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
    saveState: () => order.push(`save:${state.exitControl.mode}`),
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(true);
  expect(order).toEqual([
    "launch",
    "log:handover-launched",
    "save:launched",
    "save:launched",
    "log:exit",
    "mark",
    "kill",
  ]);
  expect(launches).toBe(1);

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
  const destructive: string[] = [];
  const deps = {
    ...defaultBabysitDeps(),
    appendLog: () => undefined,
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
    ...defaultBabysitDeps(),
    appendLog: () => undefined,
    killSession: () => destructive.push("kill"),
    launchReplacementLoop: () => {
      launched += 1;
      return { ok: true, session: "another-replacement" };
    },
    markRunStopped: () => destructive.push("mark"),
    now: () => 0,
    replacementSessionAlive: () => false,
    saveState: () => undefined,
  };

  expect(await driveHandoverControl(config, deps, state, {})).toBe(false);
  expect(state.exitControl.mode).toBe("launch-error");
  expect(state.exitControl.launchError).toContain("is not running");
  expect(launched).toBe(0);
  expect(destructive).toEqual([]);
});

test("explicit stop marks the run before killing its tmux session", () => {
  const config = handoverConfig();
  const order: string[] = [];
  const deps = {
    ...defaultBabysitDeps(),
    appendLog: () => order.push("log"),
    killSession: () => order.push("kill"),
    markRunStopped: () => order.push("mark"),
    now: () => 0,
  };
  stopBabysatLoop(config, deps, "user requested teardown");
  expect(order).toEqual(["log", "mark", "kill"]);
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
