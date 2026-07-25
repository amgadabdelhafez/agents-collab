import type { ReadStream } from "node:tty";
import type { Agent } from "./types";

export type ExitControlMode = "idle" | "handover" | "launched" | "launch-error";

export interface ExitControlState {
  launchError?: string;
  mode: ExitControlMode;
  notified: Partial<Record<Agent, boolean>>;
  replacementSession?: string;
  requestedAt?: string;
}

export type ExitKeyAction = "cancel" | "handover" | "menu" | "teardown";

export interface KeyInput {
  close: () => void;
  next: () => Promise<string>;
}

export interface ReplacementLaunchResult {
  error?: string;
  ok: boolean;
  session?: string;
}

export const freshExitControl = (): ExitControlState => ({
  mode: "idle",
  notified: {},
});

export const readExitControl = (value: unknown): ExitControlState => {
  if (!value || typeof value !== "object") {
    return freshExitControl();
  }
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  const replacementSession =
    typeof record.replacementSession === "string" &&
    record.replacementSession.trim().length > 0
      ? record.replacementSession
      : undefined;
  const validMode =
    mode === "launched" && !replacementSession
      ? "launch-error"
      : mode === "handover" || mode === "launched" || mode === "launch-error"
        ? mode
        : "idle";
  const notifiedValue = record.notified;
  const notified: Partial<Record<Agent, boolean>> = {};
  if (notifiedValue && typeof notifiedValue === "object") {
    for (const agent of [
      "claude",
      "codex",
      "gemini",
      "cursor",
      "copilot",
    ] as const) {
      if ((notifiedValue as Record<string, unknown>)[agent] === true) {
        notified[agent] = true;
      }
    }
  }
  return {
    ...(typeof record.launchError === "string"
      ? { launchError: record.launchError }
      : mode === "launched" && !replacementSession
        ? { launchError: "replacement session was not persisted" }
        : {}),
    mode: validMode,
    notified,
    ...(replacementSession ? { replacementSession } : {}),
    ...(typeof record.requestedAt === "string"
      ? { requestedAt: record.requestedAt }
      : {}),
  };
};

export const exitKeyAction = (
  menuOpen: boolean,
  mode: ExitControlMode,
  key: string
): ExitKeyAction | undefined => {
  const normalized = key.toLowerCase();
  if (mode === "handover" || mode === "launched" || mode === "launch-error") {
    if (normalized === "e") {
      return "teardown";
    }
    if (mode === "launch-error" && normalized === "h") {
      return "handover";
    }
    return undefined;
  }
  if (!menuOpen) {
    return normalized === "x" ? "menu" : undefined;
  }
  if (normalized === "e") {
    return "teardown";
  }
  if (normalized === "h") {
    return "handover";
  }
  if (normalized === "x" || normalized === "c" || key === "\u001b") {
    return "cancel";
  }
  return undefined;
};

const AGENT_COMMAND_HINTS: Record<Agent, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  copilot: ["copilot"],
  cursor: ["cursor"],
  gemini: ["gemini"],
};

export const agentCommandIsRunning = (
  agent: Agent,
  paneCommand: string
): boolean => {
  const normalized = paneCommand.toLowerCase();
  if (normalized.startsWith("1:")) {
    return false;
  }
  return AGENT_COMMAND_HINTS[agent].some((hint) => normalized.includes(hint));
};

const SHELL_COMMANDS = new Set([
  "bash",
  "dash",
  "fish",
  "ksh",
  "nu",
  "pwsh",
  "sh",
  "tcsh",
  "zsh",
]);

export const agentHasExited = (
  agent: Agent,
  paneProbe: string | undefined
): boolean => {
  const match = paneProbe?.trim().match(/^([01]):([^:\s]+)$/);
  if (!match) {
    return false;
  }
  if (match[1] === "1") {
    return true;
  }
  const command = match[2].toLowerCase();
  if (AGENT_COMMAND_HINTS[agent].some((hint) => command.includes(hint))) {
    return false;
  }
  return SHELL_COMMANDS.has(command);
};

export const HANDOVER_REQUEST = [
  "babysitter: the human requested a graceful handover to a fresh loop.",
  "Finish only your current atomic step; do not start another slice.",
  "Update PLAN.md and status.md with what changed, proof run, open risks, and the exact next steps.",
  "Preserve all uncommitted work. Do not commit, push, merge, deploy, or discard changes unless the human already authorized it.",
  "Send the peer a concise final handover if useful, then exit your own agent TUI so the babysitter can start the replacement loop.",
].join(" ");

export const HANDOVER_CONTINUATION_PROMPT = [
  "Continue the current task from the completed loop handover.",
  "Read PLAN.md and status.md first, then inspect the current repo state and the prior run transcript before acting.",
  "Preserve uncommitted work and existing authority boundaries.",
  "Coordinate through the loop bridge and continue from the documented next step without repeating completed work.",
].join(" ");

export const replacementLoopArgs = (primary: Agent, peer: Agent): string[] => [
  "--tmux",
  "--babysit",
  "--agent",
  primary,
  "--pair-with",
  peer,
  "--prompt",
  HANDOVER_CONTINUATION_PROMPT,
];

interface TtyKeyStream
  extends Pick<
    ReadStream,
    "isRaw" | "isTTY" | "off" | "on" | "pause" | "resume" | "setRawMode"
  > {
  setEncoding: (encoding: BufferEncoding) => this;
}

export const openRawKeyInput = (
  input: TtyKeyStream = process.stdin,
  interrupt: () => void = () => process.kill(process.pid, "SIGINT")
): KeyInput | undefined => {
  if (!input.isTTY) {
    return undefined;
  }
  const queued: string[] = [];
  const waiting: Array<(key: string) => void> = [];
  const wasRaw = input.isRaw === true;
  let closed = false;
  const emit = (key: string): void => {
    const resolve = waiting.shift();
    if (resolve) {
      resolve(key);
    } else {
      queued.push(key);
    }
  };
  const onData = (chunk: Buffer | string): void => {
    for (const key of String(chunk)) {
      if (key === "\u0003") {
        close();
        interrupt();
        return;
      }
      emit(key);
    }
  };
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    input.off("data", onData);
    input.setRawMode(wasRaw);
    if (!wasRaw) {
      input.pause();
    }
  };
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.on("data", onData);
  input.resume();
  return {
    close,
    next: () => {
      const key = queued.shift();
      if (key !== undefined) {
        return Promise.resolve(key);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
};
