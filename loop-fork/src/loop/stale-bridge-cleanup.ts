import { lstatSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "bun";
import { isAgent } from "./agents";
import type { BridgeMcpSource } from "./bridge";
import { BRIDGE_SUBCOMMAND } from "./bridge-constants";
import { buildManifestPath, resolveStorageRoot } from "./run-state";

const LOOP_EXECUTABLE_NAME = "loop";
const PROCESS_INSPECTION_TIMEOUT_MS = 750;
const PROCESS_LIST_LINE_RE = /^\s*(\d+)\s+(.+?)\s*$/u;
const WHITESPACE_RE = /\s+/;
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "stopped"]);
const TERMINAL_RUN_STATUSES = new Set(["done", "failed", "stopped"]);
const ACTIVE_MANIFEST_VALUES = new Set([
  "active",
  "input-required",
  "reviewing",
  "running",
  "submitted",
  "working",
]);

interface LoopProcessReference {
  executable: string;
  pid: number;
}

interface ProcessIdentity extends LoopProcessReference {
  command: string;
}

interface StaleBridgeProcess {
  identity: ProcessIdentity;
  repoId: string;
  runDir: string;
  runId: string;
}

type RunDirectoryKind = "directory" | "missing" | "other" | "unknown";

interface StaleBridgeCleanupDeps {
  commandForPid: (pid: number) => string | undefined;
  executableForPid: (pid: number) => string | undefined;
  listLoopProcesses: () => LoopProcessReference[] | undefined;
  manifestIsTerminal: (
    manifestPath: string,
    repoId: string,
    runId: string
  ) => boolean;
  runDirectoryKind: (runDir: string) => RunDirectoryKind;
  signal: (pid: number, signal: NodeJS.Signals) => void;
}

export interface StaleBridgeCleanupResult {
  candidates: number;
  killed: number[];
  scanned: number;
  skipped: Array<{ pid: number; reason: string }>;
}

const decode = (value: string | Uint8Array | undefined): string => {
  if (!value) {
    return "";
  }
  return typeof value === "string" ? value : new TextDecoder().decode(value);
};

const processField = (pid: number, field: "comm" | "command") => {
  const result = spawnSync(
    ["ps", "-ww", "-p", String(pid), "-o", `${field}=`],
    {
      killSignal: "SIGKILL",
      stderr: "ignore",
      stdout: "pipe",
      timeout: PROCESS_INSPECTION_TIMEOUT_MS,
    }
  );
  const value = decode(result.stdout).trim();
  return !result.signalCode && result.exitCode === 0 && value
    ? value
    : undefined;
};

const defaultListLoopProcesses = (): LoopProcessReference[] | undefined => {
  try {
    const result = spawnSync(["ps", "-ww", "-axo", "pid=,comm="], {
      killSignal: "SIGKILL",
      stderr: "ignore",
      stdout: "pipe",
      timeout: PROCESS_INSPECTION_TIMEOUT_MS,
    });
    if (result.signalCode || result.exitCode !== 0) {
      return undefined;
    }
    const processes: LoopProcessReference[] = [];
    for (const line of decode(result.stdout).split("\n")) {
      const match = line.match(PROCESS_LIST_LINE_RE);
      const pid = Number.parseInt(match?.[1] ?? "", 10);
      const executable = match?.[2];
      if (
        executable &&
        Number.isInteger(pid) &&
        pid > 0 &&
        basename(executable) === LOOP_EXECUTABLE_NAME
      ) {
        processes.push({ executable, pid });
      }
    }
    return processes;
  } catch {
    return undefined;
  }
};

const defaultRunDirectoryKind = (runDir: string): RunDirectoryKind => {
  try {
    return lstatSync(runDir).isDirectory() ? "directory" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unknown";
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const defaultManifestIsTerminal = (
  manifestPath: string,
  repoId: string,
  runId: string
): boolean => {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest)) {
      return false;
    }
    if (
      [manifest.state, manifest.status].some(
        (value) =>
          typeof value === "string" && ACTIVE_MANIFEST_VALUES.has(value)
      )
    ) {
      return false;
    }
    return Boolean(
      manifest.repoId === repoId &&
        manifest.runId === runId &&
        typeof manifest.state === "string" &&
        TERMINAL_RUN_STATES.has(manifest.state) &&
        typeof manifest.status === "string" &&
        TERMINAL_RUN_STATUSES.has(manifest.status) &&
        nonEmptyString(manifest.cwd) &&
        nonEmptyString(manifest.mode) &&
        nonEmptyString(manifest.createdAt) &&
        nonEmptyString(manifest.updatedAt) &&
        typeof manifest.pid === "number" &&
        Number.isInteger(manifest.pid) &&
        manifest.pid > 0
    );
  } catch {
    return false;
  }
};

const defaultDeps: StaleBridgeCleanupDeps = {
  commandForPid: (pid) => processField(pid, "command"),
  executableForPid: (pid) => processField(pid, "comm"),
  listLoopProcesses: defaultListLoopProcesses,
  manifestIsTerminal: defaultManifestIsTerminal,
  runDirectoryKind: defaultRunDirectoryKind,
  signal: (pid, signal) => process.kill(pid, signal),
};

const readProcessIdentity = (
  processRef: LoopProcessReference,
  deps: StaleBridgeCleanupDeps
): ProcessIdentity | undefined => {
  const executable = deps.executableForPid(processRef.pid);
  const command = deps.commandForPid(processRef.pid);
  if (!(executable && command && executable === processRef.executable)) {
    return undefined;
  }
  return { command, executable, pid: processRef.pid };
};

const bridgeProcessFromIdentity = (
  identity: ProcessIdentity,
  storageRoot: string
): StaleBridgeProcess | undefined => {
  if (basename(identity.executable) !== LOOP_EXECUTABLE_NAME) {
    return undefined;
  }
  const prefix = `${identity.executable} `;
  if (!identity.command.startsWith(prefix)) {
    return undefined;
  }
  const args = identity.command.slice(prefix.length).split(WHITESPACE_RE);
  if (!(args.length === 3 && args[0] === BRIDGE_SUBCOMMAND)) {
    return undefined;
  }
  const [_, runDir, rawSource] = args;
  const source: BridgeMcpSource | undefined =
    rawSource && (isAgent(rawSource) || rawSource === "supervisor")
      ? rawSource
      : undefined;
  if (!(runDir && source && isAbsolute(runDir) && runDir === resolve(runDir))) {
    return undefined;
  }
  const runRelative = relative(resolve(storageRoot), runDir);
  const parts = runRelative.split(sep);
  if (
    isAbsolute(runRelative) ||
    runRelative.startsWith(`..${sep}`) ||
    parts.length !== 2 ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    return undefined;
  }
  return {
    identity,
    repoId: parts[0] ?? "",
    runDir,
    runId: parts[1] ?? "",
  };
};

const bridgeIsStale = (
  bridge: StaleBridgeProcess,
  deps: StaleBridgeCleanupDeps
): boolean => {
  const kind = deps.runDirectoryKind(bridge.runDir);
  if (kind === "missing") {
    return true;
  }
  return Boolean(
    kind === "directory" &&
      deps.manifestIsTerminal(
        buildManifestPath(bridge.runDir),
        bridge.repoId,
        bridge.runId
      )
  );
};

const sameIdentity = (
  expected: ProcessIdentity,
  actual: ProcessIdentity | undefined
): boolean =>
  Boolean(
    actual &&
      expected.pid === actual.pid &&
      expected.executable === actual.executable &&
      expected.command === actual.command
  );

const preserve = (
  result: StaleBridgeCleanupResult,
  pid: number,
  reason: string
): void => {
  result.skipped.push({ pid, reason });
};

const signalBridge = (
  bridge: StaleBridgeProcess,
  deps: StaleBridgeCleanupDeps,
  result: StaleBridgeCleanupResult
): void => {
  try {
    deps.signal(bridge.identity.pid, "SIGTERM");
    result.killed.push(bridge.identity.pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      preserve(
        result,
        bridge.identity.pid,
        `signal-failed:${code ?? "unknown"}`
      );
    }
  }
};

const inspectProcess = (input: {
  deps: StaleBridgeCleanupDeps;
  processRef: LoopProcessReference;
  result: StaleBridgeCleanupResult;
  storageRoot: string;
}): void => {
  const identity = readProcessIdentity(input.processRef, input.deps);
  const bridge = identity
    ? bridgeProcessFromIdentity(identity, input.storageRoot)
    : undefined;
  if (!bridge) {
    return;
  }
  input.result.candidates += 1;
  if (!bridgeIsStale(bridge, input.deps)) {
    preserve(input.result, bridge.identity.pid, "run-state-unknown-or-active");
    return;
  }
  if (!bridgeIsStale(bridge, input.deps)) {
    preserve(input.result, bridge.identity.pid, "run-state-changed");
    return;
  }
  const currentIdentity = readProcessIdentity(input.processRef, input.deps);
  if (!sameIdentity(bridge.identity, currentIdentity)) {
    preserve(input.result, bridge.identity.pid, "bridge-identity-changed");
    return;
  }
  signalBridge(bridge, input.deps, input.result);
};

export const gcStaleBridgeProcesses = (
  options: {
    deps?: Partial<StaleBridgeCleanupDeps>;
    home?: string;
    log?: (line: string) => void;
    storageRoot?: string;
  } = {}
): StaleBridgeCleanupResult => {
  const deps = { ...defaultDeps, ...options.deps };
  const storageRoot =
    options.storageRoot ?? resolveStorageRoot(options.home ?? process.env.HOME);
  const log = options.log ?? console.error;
  const result: StaleBridgeCleanupResult = {
    candidates: 0,
    killed: [],
    scanned: 0,
    skipped: [],
  };
  const processes = deps.listLoopProcesses();
  if (!processes) {
    log(
      "[loop] stale bridge sweep could not inspect processes; preserving all"
    );
    return result;
  }
  for (const processRef of processes) {
    result.scanned += 1;
    try {
      inspectProcess({ deps, processRef, result, storageRoot });
    } catch (error) {
      preserve(
        result,
        processRef.pid,
        `inspection-failed:${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (result.killed.length > 0 || result.skipped.length > 0) {
    log(
      `[loop] stale bridge sweep checked ${result.candidates} candidate${result.candidates === 1 ? "" : "s"}: ${result.killed.length} signaled, ${result.skipped.length} preserved`
    );
  }
  return result;
};

export const staleBridgeCleanupInternals = { deps: defaultDeps };
