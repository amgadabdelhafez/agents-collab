import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "bun";
import type { RunTmuxAdapterIdentity } from "./run-state";

export const TMUX_CONTROL_TIMEOUT_MS = 2000;
export const TMUX_CONTROL_KILL_SIGNAL = "SIGKILL" as const;
const WHITESPACE_RE = /\s+/u;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/u;
const PROCESS_BIRTH_ID_RE = /^(?:darwin|linux):[1-9][0-9]*$/u;

export type TmuxLiveness = "dead" | "live" | "unknown";

export class TmuxControlUnavailableError extends Error {
  readonly args: string[];

  constructor(args: string[], cause?: unknown) {
    super(`tmux control unavailable: tmux ${args.join(" ")}`, { cause });
    this.name = "TmuxControlUnavailableError";
    this.args = [...args];
  }
}

export const isTmuxControlUnavailableError = (
  error: unknown
): error is TmuxControlUnavailableError =>
  error instanceof TmuxControlUnavailableError;

interface TmuxCommandResult {
  exitCode: number;
  signalCode?: string | null;
  stderr?: Uint8Array | string;
  stdout?: Uint8Array | string;
}

interface TmuxAdapterDeps {
  canonicalizeParent: (path: string) => string;
  readProcessBirthId: (pid: number) => string | undefined;
  run: typeof spawnSync;
  socketPath?: string;
}

export interface TmuxAdapterContext {
  readonly identity: Readonly<RunTmuxAdapterIdentity>;
}

const decodeCommandOutput = (value: Uint8Array | string | undefined): string =>
  typeof value === "string" ? value : new TextDecoder().decode(value);

export const parseDarwinProcessBirthId = (raw: string): string | undefined => {
  const timestamp = Date.parse(raw.trim());
  return Number.isFinite(timestamp) && timestamp > 0
    ? `darwin:${timestamp}`
    : undefined;
};

export const parseLinuxProcessBirthId = (raw: string): string | undefined => {
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) {
    return undefined;
  }
  const fields = raw
    .slice(commandEnd + 1)
    .trim()
    .split(WHITESPACE_RE);
  const startTicks = fields[19];
  return startTicks && POSITIVE_INTEGER_RE.test(startTicks)
    ? `linux:${startTicks}`
    : undefined;
};

const readProcessBirthId = (pid: number): string | undefined => {
  if (process.platform === "darwin") {
    const result = spawnSync(
      ["ps", "-p", String(pid), "-o", "lstart="],
      boundedTmuxOptions({ stderr: "ignore", stdout: "pipe" })
    );
    return result.exitCode === 0 && !tmuxCommandTimedOut(result)
      ? parseDarwinProcessBirthId(decodeCommandOutput(result.stdout))
      : undefined;
  }
  if (process.platform === "linux") {
    try {
      return parseLinuxProcessBirthId(
        readFileSync(`/proc/${pid}/stat`, "utf8")
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const defaultTmuxAdapterDeps = (): TmuxAdapterDeps => ({
  canonicalizeParent: realpathSync,
  readProcessBirthId,
  run: spawnSync,
});

const normalizeTmuxIdentity = (
  raw: string,
  deps: Pick<TmuxAdapterDeps, "canonicalizeParent" | "readProcessBirthId">
): Readonly<RunTmuxAdapterIdentity> | undefined => {
  const parts = raw.trim().split("\t");
  if (parts.length !== 2) {
    return undefined;
  }
  const [reportedSocket, rawPid] = parts;
  if (!(reportedSocket && isAbsolute(reportedSocket) && rawPid)) {
    return undefined;
  }
  const serverPid = Number(rawPid);
  if (!(Number.isInteger(serverPid) && serverPid > 0)) {
    return undefined;
  }
  const socketName = basename(reportedSocket);
  if (!(socketName && socketName !== "." && socketName !== "..")) {
    return undefined;
  }
  let socketPath: string;
  try {
    socketPath = join(
      deps.canonicalizeParent(dirname(reportedSocket)),
      socketName
    );
  } catch {
    return undefined;
  }
  const processBirthId = deps.readProcessBirthId(serverPid);
  if (!PROCESS_BIRTH_ID_RE.test(processBirthId ?? "")) {
    return undefined;
  }
  return Object.freeze({
    processBirthId: processBirthId as string,
    serverPid,
    socketPath,
    version: 1,
  });
};

export const createTmuxAdapterContext = (
  identity: RunTmuxAdapterIdentity
): TmuxAdapterContext => {
  const normalized = normalizeTmuxIdentity(
    `${identity.socketPath}\t${identity.serverPid}`,
    {
      canonicalizeParent: (parent) => parent,
      readProcessBirthId: () => identity.processBirthId,
    }
  );
  if (!normalized || normalized.socketPath !== identity.socketPath) {
    throw new Error("Invalid tmux adapter identity");
  }
  return Object.freeze({ identity: normalized });
};

export const captureTmuxAdapterIdentity = (
  session: string,
  overrides: Partial<TmuxAdapterDeps> = {}
): Readonly<RunTmuxAdapterIdentity> => {
  const deps = { ...defaultTmuxAdapterDeps(), ...overrides };
  const args = [
    "tmux",
    ...(deps.socketPath ? ["-S", deps.socketPath] : []),
    "display-message",
    "-p",
    "-t",
    session,
    "#{socket_path}\t#{pid}",
  ];
  const result = deps.run(
    args,
    boundedTmuxOptions({ stderr: "pipe", stdout: "pipe" })
  );
  const identity =
    result.exitCode === 0 && !tmuxCommandTimedOut(result)
      ? normalizeTmuxIdentity(decodeCommandOutput(result.stdout), deps)
      : undefined;
  if (!identity) {
    throw new TmuxControlUnavailableError(args);
  }
  return identity;
};

export const tmuxAdapterSessionLiveness = (
  context: TmuxAdapterContext,
  session: string,
  overrides: Partial<TmuxAdapterDeps> = {}
): TmuxLiveness => {
  if (!session) {
    return "dead";
  }
  const deps = { ...defaultTmuxAdapterDeps(), ...overrides };
  const prefix = ["tmux", "-S", context.identity.socketPath];
  try {
    const identityResult = deps.run(
      [...prefix, "display-message", "-p", "#{socket_path}\t#{pid}"],
      boundedTmuxOptions({ stderr: "ignore", stdout: "pipe" })
    );
    if (identityResult.exitCode !== 0 || tmuxCommandTimedOut(identityResult)) {
      return "unknown";
    }
    const liveIdentity = normalizeTmuxIdentity(
      decodeCommandOutput(identityResult.stdout),
      deps
    );
    if (
      !liveIdentity ||
      liveIdentity.socketPath !== context.identity.socketPath ||
      liveIdentity.serverPid !== context.identity.serverPid ||
      liveIdentity.processBirthId !== context.identity.processBirthId
    ) {
      return "unknown";
    }
    const sessionResult = deps.run(
      [...prefix, "has-session", "-t", session],
      boundedTmuxOptions({ stderr: "ignore", stdout: "ignore" })
    );
    if (tmuxCommandTimedOut(sessionResult)) {
      return "unknown";
    }
    return sessionResult.exitCode === 0 ? "live" : "dead";
  } catch {
    return "unknown";
  }
};

export const boundedTmuxOptions = <const T extends object>(
  options: T
): T & {
  killSignal: typeof TMUX_CONTROL_KILL_SIGNAL;
  timeout: typeof TMUX_CONTROL_TIMEOUT_MS;
} => ({
  ...options,
  killSignal: TMUX_CONTROL_KILL_SIGNAL,
  timeout: TMUX_CONTROL_TIMEOUT_MS,
});

export const tmuxCommandTimedOut = (result: TmuxCommandResult): boolean =>
  Boolean(result.signalCode);

export const tmuxSessionLiveness = (
  session: string,
  run: typeof spawnSync = spawnSync
): TmuxLiveness => {
  if (!session) {
    return "dead";
  }
  try {
    const result = run(
      ["tmux", "has-session", "-t", session],
      boundedTmuxOptions({ stderr: "ignore", stdout: "ignore" })
    );
    if (tmuxCommandTimedOut(result)) {
      return "unknown";
    }
    return result.exitCode === 0 ? "live" : "dead";
  } catch {
    return "unknown";
  }
};

export const tmuxSessionLivenessAsync = (
  session: string,
  run: typeof spawn = spawn
): Promise<TmuxLiveness> => {
  if (!session) {
    return Promise.resolve("dead");
  }
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let child: ChildProcess | undefined;
    const finish = (liveness: TmuxLiveness) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(liveness);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child?.kill(TMUX_CONTROL_KILL_SIGNAL);
      finish("unknown");
    }, TMUX_CONTROL_TIMEOUT_MS);
    try {
      child = run("tmux", ["has-session", "-t", session], {
        stdio: "ignore",
      });
      child.once("error", () => finish("unknown"));
      child.once("exit", (code, signal) => {
        if (timedOut || signal) {
          finish("unknown");
          return;
        }
        finish(code === 0 ? "live" : "dead");
      });
    } catch {
      finish("unknown");
    }
  });
};
