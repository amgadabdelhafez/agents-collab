import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { sleepSync, spawnSync } from "bun";
import type { BridgeMcpSource } from "./bridge";
import {
  buildManifestPath,
  isActiveRunState,
  type RunManifest,
  readRunManifest,
  resolveRepoId,
  resolveStorageRoot,
  setRunManifestState,
  updateRunManifest,
} from "./run-state";
import type { Agent } from "./types";

const PROCESS_REGISTRY_DIR = "run-processes";
const BRIDGE_PROCESS_PREFIX = "bridge-";
const OWNED_PROCESS_PREFIX = "owned-";
const REGISTRATION_FAILURE_PREFIX = "registration-failure-";
const DEFERRED_LAUNCHER_PREFIX = "deferred-launcher-";
const UNRESOLVED_CLEANUP_FILE = "unresolved-cleanup.json";
const PROCESS_SCHEMA_VERSION = 1;
const PROCESS_TERM_POLLS = 20;
const PROCESS_KILL_POLLS = 20;
const PROCESS_POLL_MS = 25;
const WHITESPACE_RE = /\s+/;
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;
const EXECUTABLE_EXTENSION_RE = /\.exe$/;

interface RegisteredBridgeProcess {
  kind: "bridge-mcp";
  pid: number;
  runDir: string;
  source: BridgeMcpSource;
}

export type RunOwnedProcessRole = "agent" | "launcher";

export interface RegisteredRunOwnedProcess {
  agent?: Agent;
  command: string;
  kind: "run-owned";
  pid: number;
  role: RunOwnedProcessRole;
  runDir: string;
  schemaVersion: 1;
  startedAt: string;
}

interface RunProcessRegistrationFailure {
  agent?: Agent;
  kind: "run-owned-registration-failure";
  pid: number;
  reason: string;
  recordedAt: string;
  role: RunOwnedProcessRole;
  runDir: string;
  schemaVersion: 1;
}

interface DeferredLauncherProcess
  extends Omit<RegisteredRunOwnedProcess, "kind" | "role"> {
  deferredAt: string;
  kind: "run-owned-deferred-launcher";
  role: "launcher";
}

export interface RunProcessCleanupIssue {
  pid: number;
  reason: string;
}

export interface RunProcessCleanupResult {
  deferred?: number[];
  killed: number[];
  skipped: RunProcessCleanupIssue[];
  unresolved?: RunProcessCleanupIssue[];
}

interface RunProcessCleanupDeps {
  commandForPid: (pid: number) => string | undefined;
  currentPid: () => number;
  listeningPids: (port: number) => number[];
  listTmuxSessions: () => ReadonlySet<string> | undefined;
  now: () => string;
  parentPidFor: (pid: number) => number | undefined;
  pidAlive: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => void;
  startForPid: (pid: number) => string | undefined;
  stateForPid: (pid: number) => string | undefined;
  updateManifest: typeof updateRunManifest;
}

export interface AbandonedRunCleanupResult extends RunProcessCleanupResult {
  cleaned: number;
  kept: number;
  scanned: number;
}

const decode = (value: string | Uint8Array | undefined): string => {
  if (!value) {
    return "";
  }
  return typeof value === "string" ? value : new TextDecoder().decode(value);
};

const defaultCommandForPid = (pid: number): string | undefined => {
  const result = spawnSync(["ps", "-p", String(pid), "-o", "command="], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const command = decode(result.stdout).trim();
  return result.exitCode === 0 && command ? command : undefined;
};

const defaultPsValue = (pid: number, field: string): string | undefined => {
  const result = spawnSync(["ps", "-p", String(pid), "-o", `${field}=`], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const value = decode(result.stdout).trim();
  return result.exitCode === 0 && value ? value : undefined;
};

const defaultParentPidFor = (pid: number): number | undefined => {
  const value = defaultPsValue(pid, "ppid");
  if (!value) {
    return undefined;
  }
  const parent = Number.parseInt(value, 10);
  return Number.isInteger(parent) && parent >= 0 ? parent : undefined;
};

const defaultListeningPids = (port: number): number[] => {
  const result = spawnSync(
    ["lsof", "-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { stderr: "ignore", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return decode(result.stdout)
    .split(WHITESPACE_RE)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
};

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultListTmuxSessions = (): ReadonlySet<string> | undefined => {
  try {
    const result = spawnSync(
      ["tmux", "list-sessions", "-F", "#{session_name}"],
      {
        killSignal: "SIGKILL",
        stderr: "pipe",
        stdout: "pipe",
        timeout: 750,
      }
    );
    if (result.signalCode) {
      return undefined;
    }
    if (result.exitCode === 0) {
      return new Set(
        decode(result.stdout).split(WHITESPACE_RE).filter(Boolean)
      );
    }
    return decode(result.stderr).includes("no server running")
      ? new Set()
      : undefined;
  } catch {
    return undefined;
  }
};

const cleanupDeps: RunProcessCleanupDeps = {
  commandForPid: defaultCommandForPid,
  currentPid: () => process.pid,
  listTmuxSessions: defaultListTmuxSessions,
  listeningPids: defaultListeningPids,
  now: () => new Date().toISOString(),
  parentPidFor: defaultParentPidFor,
  pidAlive: defaultPidAlive,
  sleep: sleepSync,
  startForPid: (pid) => defaultPsValue(pid, "lstart"),
  stateForPid: (pid) => defaultPsValue(pid, "stat"),
  signal: (pid, signal) => process.kill(pid, signal),
  updateManifest: updateRunManifest,
};

const registryDir = (runDir: string): string =>
  join(runDir, PROCESS_REGISTRY_DIR);

const bridgeRegistrationPath = (runDir: string, pid: number): string =>
  join(registryDir(runDir), `${BRIDGE_PROCESS_PREFIX}${pid}.json`);

const ownedProcessPath = (
  runDir: string,
  role: RunOwnedProcessRole,
  pid: number,
  agent?: Agent
): string =>
  join(
    registryDir(runDir),
    `${OWNED_PROCESS_PREFIX}${role}${agent ? `-${agent}` : ""}-${pid}.json`
  );

const registrationFailurePath = (
  runDir: string,
  role: RunOwnedProcessRole,
  pid: number,
  agent?: Agent
): string =>
  join(
    registryDir(runDir),
    `${REGISTRATION_FAILURE_PREFIX}${role}${agent ? `-${agent}` : ""}-${pid}.json`
  );

const deferredLauncherPath = (runDir: string, pid: number): string =>
  join(registryDir(runDir), `${DEFERRED_LAUNCHER_PREFIX}${pid}.json`);

const unresolvedCleanupPath = (runDir: string): string =>
  join(registryDir(runDir), UNRESOLVED_CLEANUP_FILE);

const commandMatchesAgent = (command: string, agent: Agent): boolean => {
  const firstToken = command.trim().split(WHITESPACE_RE)[0];
  if (!firstToken) {
    return false;
  }
  const executable = basename(firstToken.replace(/^['"]|['"]$/g, ""))
    .toLowerCase()
    .replace(EXECUTABLE_EXTENSION_RE, "");
  return executable === agent;
};

const writeRegistrationFailure = (
  path: string,
  runDir: string,
  input: {
    agent?: Agent;
    role: RunOwnedProcessRole;
  },
  pid: number,
  reason: string
): string => {
  const failure: RunProcessRegistrationFailure = {
    ...(input.agent ? { agent: input.agent } : {}),
    kind: "run-owned-registration-failure",
    pid,
    reason,
    recordedAt: cleanupDeps.now(),
    role: input.role,
    runDir,
    schemaVersion: PROCESS_SCHEMA_VERSION,
  };
  writeFileSync(path, `${JSON.stringify(failure)}\n`, "utf8");
  return path;
};

const writeDurableReceipt = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "w", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const directoryDescriptor = openSync(dirname(path), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
  }
};

export const registerRunOwnedProcess = (
  runDir: string,
  input: {
    agent?: Agent;
    pid?: number;
    role: RunOwnedProcessRole;
  }
): string => {
  const pid = input.pid ?? process.pid;
  const path = ownedProcessPath(runDir, input.role, pid, input.agent);
  const failurePath = registrationFailurePath(
    runDir,
    input.role,
    pid,
    input.agent
  );
  mkdirSync(registryDir(runDir), { recursive: true });
  const command = cleanupDeps.commandForPid(pid);
  const startedAt = cleanupDeps.startForPid(pid);
  if (!command) {
    return writeRegistrationFailure(
      failurePath,
      runDir,
      input,
      pid,
      "process-command-unavailable"
    );
  }
  if (!startedAt) {
    return writeRegistrationFailure(
      failurePath,
      runDir,
      input,
      pid,
      "process-start-unavailable"
    );
  }
  if (
    input.role === "agent" &&
    !(input.agent && commandMatchesAgent(command, input.agent))
  ) {
    return writeRegistrationFailure(
      failurePath,
      runDir,
      input,
      pid,
      "agent-command-unexpected"
    );
  }
  const record: RegisteredRunOwnedProcess = {
    ...(input.agent ? { agent: input.agent } : {}),
    command,
    kind: "run-owned",
    pid,
    role: input.role,
    runDir,
    schemaVersion: PROCESS_SCHEMA_VERSION,
    startedAt,
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  rmSync(failurePath, { force: true });
  return path;
};

export const registerRunBridgeProcess = (
  runDir: string,
  source: BridgeMcpSource,
  pid = process.pid
): string => {
  const path = bridgeRegistrationPath(runDir, pid);
  mkdirSync(registryDir(runDir), { recursive: true });
  const record: RegisteredBridgeProcess = {
    kind: "bridge-mcp",
    pid,
    runDir,
    source,
  };
  writeFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
};

export const unregisterRunBridgeProcess = (path: string): void => {
  rmSync(path, { force: true });
};

const readBridgeRegistrations = (
  runDir: string
): Array<{ path: string; record: RegisteredBridgeProcess }> => {
  let files: string[];
  try {
    files = readdirSync(registryDir(runDir));
  } catch {
    return [];
  }
  const registrations: Array<{
    path: string;
    record: RegisteredBridgeProcess;
  }> = [];
  for (const file of files) {
    if (!(file.startsWith(BRIDGE_PROCESS_PREFIX) && file.endsWith(".json"))) {
      continue;
    }
    const path = join(registryDir(runDir), file);
    try {
      const record = JSON.parse(
        readFileSync(path, "utf8")
      ) as RegisteredBridgeProcess;
      if (
        record.kind === "bridge-mcp" &&
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        record.runDir === runDir
      ) {
        registrations.push({ path, record });
      }
    } catch {
      // Malformed ownership records are never trusted as kill authority.
    }
  }
  return registrations;
};

const readOwnedRegistrations = (
  runDir: string
): Array<{ path: string; record: RegisteredRunOwnedProcess }> => {
  let files: string[];
  try {
    files = readdirSync(registryDir(runDir));
  } catch {
    return [];
  }
  const registrations: Array<{
    path: string;
    record: RegisteredRunOwnedProcess;
  }> = [];
  for (const file of files) {
    if (!(file.startsWith(OWNED_PROCESS_PREFIX) && file.endsWith(".json"))) {
      continue;
    }
    const path = join(registryDir(runDir), file);
    try {
      const record = JSON.parse(
        readFileSync(path, "utf8")
      ) as RegisteredRunOwnedProcess;
      if (
        record.schemaVersion === PROCESS_SCHEMA_VERSION &&
        record.kind === "run-owned" &&
        (record.role === "launcher" || record.role === "agent") &&
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        record.runDir === runDir &&
        typeof record.command === "string" &&
        record.command.length > 0 &&
        typeof record.startedAt === "string" &&
        record.startedAt.length > 0 &&
        (record.role !== "agent" || typeof record.agent === "string")
      ) {
        registrations.push({ path, record });
      }
    } catch {
      // Malformed ownership records are never trusted as kill authority.
    }
  }
  return registrations;
};

const readRegistrationFailures = (
  runDir: string
): Array<{ path: string; record: RunProcessRegistrationFailure }> => {
  let files: string[];
  try {
    files = readdirSync(registryDir(runDir));
  } catch {
    return [];
  }
  const failures: Array<{
    path: string;
    record: RunProcessRegistrationFailure;
  }> = [];
  for (const file of files) {
    if (
      !(file.startsWith(REGISTRATION_FAILURE_PREFIX) && file.endsWith(".json"))
    ) {
      continue;
    }
    const path = join(registryDir(runDir), file);
    try {
      const record = JSON.parse(
        readFileSync(path, "utf8")
      ) as RunProcessRegistrationFailure;
      if (
        record.schemaVersion === PROCESS_SCHEMA_VERSION &&
        record.kind === "run-owned-registration-failure" &&
        (record.role === "launcher" || record.role === "agent") &&
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        record.runDir === runDir &&
        typeof record.reason === "string"
      ) {
        failures.push({ path, record });
      }
    } catch {
      // Malformed failure records cannot grant cleanup authority.
    }
  }
  return failures;
};

const readDeferredLaunchers = (
  runDir: string
): Array<{ path: string; record: DeferredLauncherProcess }> => {
  let files: string[];
  try {
    files = readdirSync(registryDir(runDir));
  } catch {
    return [];
  }
  const deferred: Array<{
    path: string;
    record: DeferredLauncherProcess;
  }> = [];
  for (const file of files) {
    if (
      !(file.startsWith(DEFERRED_LAUNCHER_PREFIX) && file.endsWith(".json"))
    ) {
      continue;
    }
    const path = join(registryDir(runDir), file);
    try {
      const record = JSON.parse(
        readFileSync(path, "utf8")
      ) as DeferredLauncherProcess;
      if (
        record.schemaVersion === PROCESS_SCHEMA_VERSION &&
        record.kind === "run-owned-deferred-launcher" &&
        record.role === "launcher" &&
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        record.runDir === runDir &&
        typeof record.command === "string" &&
        typeof record.startedAt === "string" &&
        typeof record.deferredAt === "string"
      ) {
        deferred.push({ path, record });
      }
    } catch {
      // Malformed deferred records are preserved but never grant authority.
    }
  }
  return deferred;
};

const appServerPort = (remoteUrl: string | undefined): number | undefined => {
  if (!remoteUrl) {
    return undefined;
  }
  try {
    const port = Number.parseInt(new URL(remoteUrl).port, 10);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
};

const commandHasExactArg = (command: string, argument: string): boolean => {
  const escaped = argument.replace(REGEX_META_RE, "\\$&");
  return new RegExp(`(?:^|\\s|['"])${escaped}(?=$|\\s|['"])`).test(command);
};

type ProcessSettlement = "running" | "settled" | "unknown";
type ProcessIdentityMatch = "match" | "mismatch" | "unknown";
type ProcessRelation = "ancestor" | "self" | "unrelated" | "unknown";

const processSettlement = (
  pid: number,
  deps: RunProcessCleanupDeps
): ProcessSettlement => {
  const state = deps.stateForPid(pid);
  if (state) {
    return state.trim().toUpperCase().startsWith("Z") ? "settled" : "running";
  }
  return deps.pidAlive(pid) ? "unknown" : "settled";
};

const relationToCurrentProcess = (
  targetPid: number,
  deps: RunProcessCleanupDeps
): ProcessRelation => {
  const currentPid = deps.currentPid();
  if (targetPid === currentPid) {
    return "self";
  }
  const seen = new Set<number>([currentPid]);
  let cursor = currentPid;
  for (let depth = 0; depth < 128; depth += 1) {
    const parent = deps.parentPidFor(cursor);
    if (parent === undefined) {
      return "unknown";
    }
    if (parent === targetPid) {
      return "ancestor";
    }
    if (parent <= 1) {
      return "unrelated";
    }
    if (seen.has(parent)) {
      return "unknown";
    }
    seen.add(parent);
    cursor = parent;
  }
  return "unknown";
};

const addUnresolved = (
  cleanupResult: RunProcessCleanupResult,
  targetPid: number,
  reason: string
): void => {
  if (!cleanupResult.unresolved) {
    cleanupResult.unresolved = [];
  }
  cleanupResult.unresolved.push({ pid: targetPid, reason });
};

const addDeferred = (result: RunProcessCleanupResult, pid: number): void => {
  if (!result.deferred) {
    result.deferred = [];
  }
  result.deferred.push(pid);
};

const waitForSettlement = (
  pid: number,
  attempts: number,
  deps: RunProcessCleanupDeps
): ProcessSettlement => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const settlement = processSettlement(pid, deps);
    if (settlement !== "running") {
      return settlement;
    }
    deps.sleep(PROCESS_POLL_MS);
  }
  return processSettlement(pid, deps);
};

const signalAndObserve = (
  pid: number,
  signal: NodeJS.Signals,
  attempts: number,
  deps: RunProcessCleanupDeps
): { errorCode?: string; settlement: ProcessSettlement } => {
  try {
    deps.signal(pid, signal);
  } catch (error) {
    return {
      errorCode: (error as NodeJS.ErrnoException).code ?? "unknown",
      settlement: processSettlement(pid, deps),
    };
  }
  return { settlement: waitForSettlement(pid, attempts, deps) };
};

const retainSignalFailure = (
  cleanupResult: RunProcessCleanupResult,
  targetPid: number,
  prefix: "kill-failed" | "signal-failed",
  errorCode: string
): true => {
  const reason = `${prefix}:${errorCode}`;
  cleanupResult.skipped.push({ pid: targetPid, reason });
  addUnresolved(cleanupResult, targetPid, reason);
  return true;
};

const escalateOwnedProcess = (
  result: RunProcessCleanupResult,
  targetPid: number,
  identity: () => ProcessIdentityMatch,
  afterTerm: ProcessSettlement,
  deps: RunProcessCleanupDeps
): boolean => {
  const revalidated = identity();
  if (revalidated === "mismatch") {
    result.killed.push(targetPid);
    return false;
  }
  if (afterTerm === "unknown" || revalidated === "unknown") {
    const reason = "post-term-identity-unavailable";
    result.skipped.push({ pid: targetPid, reason });
    addUnresolved(result, targetPid, reason);
    return true;
  }
  const killed = signalAndObserve(
    targetPid,
    "SIGKILL",
    PROCESS_KILL_POLLS,
    deps
  );
  if (killed.errorCode) {
    if (killed.errorCode === "ESRCH" && killed.settlement === "settled") {
      result.killed.push(targetPid);
      return false;
    }
    return retainSignalFailure(
      result,
      targetPid,
      "kill-failed",
      killed.errorCode
    );
  }
  if (killed.settlement === "settled" || identity() === "mismatch") {
    result.killed.push(targetPid);
    return false;
  }
  const reason =
    killed.settlement === "unknown" ? "post-kill-unknown" : "survived-kill";
  result.skipped.push({ pid: targetPid, reason });
  addUnresolved(result, targetPid, reason);
  return true;
};

const terminateOwnedProcess = (
  result: RunProcessCleanupResult,
  pid: number,
  identity: () => ProcessIdentityMatch,
  mismatchReason: string,
  deps: RunProcessCleanupDeps
): boolean => {
  const initialIdentity = identity();
  if (initialIdentity !== "match") {
    const reason =
      initialIdentity === "mismatch" ? mismatchReason : "identity-unavailable";
    result.skipped.push({ pid, reason });
    if (initialIdentity === "unknown") {
      addUnresolved(result, pid, reason);
      return true;
    }
    return false;
  }
  const relation = relationToCurrentProcess(pid, deps);
  if (relation !== "unrelated") {
    const reason =
      relation === "self" || relation === "ancestor"
        ? "self-or-ancestor"
        : "parent-chain-unknown";
    result.skipped.push({ pid, reason });
    addUnresolved(result, pid, reason);
    return true;
  }
  const terminated = signalAndObserve(pid, "SIGTERM", PROCESS_TERM_POLLS, deps);
  if (terminated.errorCode) {
    if (
      terminated.errorCode === "ESRCH" &&
      terminated.settlement === "settled"
    ) {
      return false;
    }
    return retainSignalFailure(
      result,
      pid,
      "signal-failed",
      terminated.errorCode
    );
  }
  if (terminated.settlement === "settled") {
    result.killed.push(pid);
    return false;
  }
  return escalateOwnedProcess(
    result,
    pid,
    identity,
    terminated.settlement,
    deps
  );
};

const exactOwnedIdentity = (
  record: RegisteredRunOwnedProcess | DeferredLauncherProcess,
  deps: RunProcessCleanupDeps
): ProcessIdentityMatch => {
  const settlement = processSettlement(record.pid, deps);
  if (settlement === "settled") {
    return "mismatch";
  }
  const command = deps.commandForPid(record.pid);
  const startedAt = deps.startForPid(record.pid);
  if (!(command && startedAt)) {
    return "unknown";
  }
  return command === record.command && startedAt === record.startedAt
    ? "match"
    : "mismatch";
};

const transferSelfLauncher = (
  runDir: string,
  path: string,
  record: RegisteredRunOwnedProcess,
  result: RunProcessCleanupResult,
  deps: RunProcessCleanupDeps
): void => {
  const deferred: DeferredLauncherProcess = {
    ...record,
    deferredAt: deps.now(),
    kind: "run-owned-deferred-launcher",
    role: "launcher",
  };
  try {
    writeDurableReceipt(deferredLauncherPath(runDir, record.pid), deferred);
    rmSync(path, { force: true });
    addDeferred(result, record.pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = `deferred-receipt-failed:${code ?? "unknown"}`;
    result.skipped.push({ pid: record.pid, reason });
    addUnresolved(result, record.pid, reason);
  }
};

export const recordRunCleanupUnresolved = (
  runDir: string,
  unresolved: RunProcessCleanupIssue[],
  now = new Date().toISOString()
): void => {
  mkdirSync(registryDir(runDir), { recursive: true });
  writeFileSync(
    unresolvedCleanupPath(runDir),
    `${JSON.stringify({
      kind: "run-cleanup-unresolved",
      recordedAt: now,
      runDir,
      schemaVersion: PROCESS_SCHEMA_VERSION,
      unresolved,
    })}\n`,
    "utf8"
  );
};

const persistUnresolvedResult = (
  runDir: string,
  result: RunProcessCleanupResult,
  deps: RunProcessCleanupDeps
): void => {
  if (result.unresolved?.length) {
    recordRunCleanupUnresolved(runDir, result.unresolved, deps.now());
    return;
  }
  rmSync(unresolvedCleanupPath(runDir), { force: true });
};

const cleanupDeferredLaunchers = (
  exactRunDir: string,
  cleanupResult: RunProcessCleanupResult,
  dependencies: RunProcessCleanupDeps
): void => {
  for (const { path, record } of readDeferredLaunchers(exactRunDir)) {
    const settlement = processSettlement(record.pid, dependencies);
    const identity = exactOwnedIdentity(record, dependencies);
    if (settlement === "settled" || identity === "mismatch") {
      rmSync(path, { force: true });
      continue;
    }
    addDeferred(cleanupResult, record.pid);
  }
};

const cleanupRegistrationFailures = (
  exactRunDir: string,
  cleanupResult: RunProcessCleanupResult,
  dependencies: RunProcessCleanupDeps
): void => {
  for (const { path, record } of readRegistrationFailures(exactRunDir)) {
    if (processSettlement(record.pid, dependencies) === "settled") {
      rmSync(path, { force: true });
      continue;
    }
    const reason = `registration-failure:${record.reason}`;
    cleanupResult.skipped.push({ pid: record.pid, reason });
    addUnresolved(cleanupResult, record.pid, reason);
  }
};

const cleanupExactOwnedRegistrations = (
  exactRunDir: string,
  cleanupResult: RunProcessCleanupResult,
  dependencies: RunProcessCleanupDeps
): void => {
  for (const { path, record } of readOwnedRegistrations(exactRunDir)) {
    const settlement = processSettlement(record.pid, dependencies);
    const identity = exactOwnedIdentity(record, dependencies);
    if (settlement === "settled" || identity === "mismatch") {
      if (identity === "mismatch" && settlement !== "settled") {
        cleanupResult.skipped.push({
          pid: record.pid,
          reason: "owned-process-identity-mismatch",
        });
      }
      rmSync(path, { force: true });
      continue;
    }
    if (
      record.role === "launcher" &&
      record.pid === dependencies.currentPid() &&
      identity === "match"
    ) {
      transferSelfLauncher(
        exactRunDir,
        path,
        record,
        cleanupResult,
        dependencies
      );
      continue;
    }
    const retainRegistration = terminateOwnedProcess(
      cleanupResult,
      record.pid,
      () => exactOwnedIdentity(record, dependencies),
      "owned-process-identity-mismatch",
      dependencies
    );
    if (!retainRegistration) {
      rmSync(path, { force: true });
    }
  }
};

const cleanupBridgeRegistrations = (
  exactRunDir: string,
  cleanupResult: RunProcessCleanupResult,
  dependencies: RunProcessCleanupDeps
): void => {
  for (const { path, record } of readBridgeRegistrations(exactRunDir)) {
    const bridgeIdentity = (): ProcessIdentityMatch => {
      const observedCommand = dependencies.commandForPid(record.pid);
      if (!observedCommand) {
        return processSettlement(record.pid, dependencies) === "settled"
          ? "mismatch"
          : "unknown";
      }
      return observedCommand.includes("__bridge-mcp") &&
        commandHasExactArg(observedCommand, record.runDir)
        ? "match"
        : "mismatch";
    };
    const retainRegistration = terminateOwnedProcess(
      cleanupResult,
      record.pid,
      bridgeIdentity,
      "bridge-command-mismatch",
      dependencies
    );
    if (!retainRegistration) {
      rmSync(path, { force: true });
    }
  }
};

const cleanupAppServer = (
  manifest: RunManifest | undefined,
  cleanupResult: RunProcessCleanupResult,
  dependencies: RunProcessCleanupDeps
): void => {
  const ownedAppServerPid = manifest?.codexAppServerPid;
  const port = appServerPort(manifest?.codexRemoteUrl);
  if (!ownedAppServerPid) {
    return;
  }
  const appServerIdentity = (): ProcessIdentityMatch => {
    const observedCommand = dependencies.commandForPid(ownedAppServerPid);
    if (!observedCommand) {
      return processSettlement(ownedAppServerPid, dependencies) === "settled"
        ? "mismatch"
        : "unknown";
    }
    return observedCommand.includes("app-server") &&
      Boolean(
        port && dependencies.listeningPids(port).includes(ownedAppServerPid)
      )
      ? "match"
      : "mismatch";
  };
  terminateOwnedProcess(
    cleanupResult,
    ownedAppServerPid,
    appServerIdentity,
    "app-server-identity-mismatch",
    dependencies
  );
};

const cleanupRunOwnedProcessesWithDeps = (
  runDir: string,
  manifest: RunManifest | undefined,
  deps: RunProcessCleanupDeps
): RunProcessCleanupResult => {
  const result: RunProcessCleanupResult = { killed: [], skipped: [] };
  cleanupDeferredLaunchers(runDir, result, deps);
  cleanupRegistrationFailures(runDir, result, deps);
  cleanupExactOwnedRegistrations(runDir, result, deps);
  cleanupBridgeRegistrations(runDir, result, deps);
  cleanupAppServer(manifest, result, deps);
  persistUnresolvedResult(runDir, result, deps);
  return result;
};

export const cleanupRunOwnedProcesses = (
  runDir: string,
  manifest: RunManifest | undefined
): RunProcessCleanupResult =>
  cleanupRunOwnedProcessesWithDeps(runDir, manifest, cleanupDeps);

const runIsProvablyAbandoned = (
  manifest: RunManifest,
  liveTmuxSessions: ReadonlySet<string> | undefined,
  deps: RunProcessCleanupDeps
): boolean => {
  if (isActiveRunState(manifest.state) && !manifest.tmuxSession) {
    // Detached workspaces outlive their launcher PID. An active manifest with
    // missing topology is corrupt/unknown and must be preserved for repair.
    return false;
  }
  if (
    manifest.tmuxSession &&
    (!liveTmuxSessions || liveTmuxSessions.has(manifest.tmuxSession))
  ) {
    return false;
  }
  return processSettlement(manifest.pid, deps) === "settled";
};

const cleanupAbandonedRun = (input: {
  deps: RunProcessCleanupDeps;
  liveTmuxSessions: ReadonlySet<string> | undefined;
  manifest: RunManifest;
  manifestPath: string;
  runDir: string;
}): RunProcessCleanupResult | undefined => {
  const hasProcessEvidence = Boolean(
    input.manifest.codexAppServerPid ||
      readBridgeRegistrations(input.runDir).length > 0 ||
      readOwnedRegistrations(input.runDir).length > 0 ||
      readRegistrationFailures(input.runDir).length > 0 ||
      readDeferredLaunchers(input.runDir).length > 0
  );
  const needsStateRepair = isActiveRunState(input.manifest.state);
  if (
    !(
      (hasProcessEvidence || needsStateRepair) &&
      runIsProvablyAbandoned(input.manifest, input.liveTmuxSessions, input.deps)
    )
  ) {
    return undefined;
  }
  if (needsStateRepair) {
    input.deps.updateManifest(input.manifestPath, (current) =>
      current ? setRunManifestState(current, "failed") : undefined
    );
  }
  if (!hasProcessEvidence) {
    return { killed: [], skipped: [] };
  }
  const cleanup = cleanupRunOwnedProcessesWithDeps(
    input.runDir,
    input.manifest,
    input.deps
  );
  const retainAppServerOwnership = cleanup.skipped.some(
    (entry) =>
      entry.pid === input.manifest.codexAppServerPid &&
      Boolean(
        cleanup.unresolved?.some((unresolved) => unresolved.pid === entry.pid)
      )
  );
  input.deps.updateManifest(input.manifestPath, (current) => {
    if (!current) {
      return undefined;
    }
    const withoutSettledOwnership = retainAppServerOwnership
      ? current
      : {
          ...current,
          codexAppServerPid: undefined,
          codexRemoteUrl: undefined,
        };
    return withoutSettledOwnership;
  });
  return cleanup;
};

const inspectStoredRun = (input: {
  deps: RunProcessCleanupDeps;
  liveTmuxSessions: ReadonlySet<string> | undefined;
  repoId: string;
  runDir: string;
  runId: string;
}): { cleanup?: RunProcessCleanupResult; scanned: boolean } => {
  const manifestPath = buildManifestPath(input.runDir);
  const manifest = readRunManifest(manifestPath);
  if (
    !(
      manifest &&
      manifest.repoId === input.repoId &&
      manifest.runId === input.runId
    )
  ) {
    return { scanned: false };
  }
  return {
    cleanup: cleanupAbandonedRun({
      deps: input.deps,
      liveTmuxSessions: input.liveTmuxSessions,
      manifest,
      manifestPath,
      runDir: input.runDir,
    }),
    scanned: true,
  };
};

const collectStoredRunCleanup = (input: {
  deps: RunProcessCleanupDeps;
  entries: string[];
  liveTmuxSessions: ReadonlySet<string> | undefined;
  log: (line: string) => void;
  repoId: string;
  repoRuns: string;
}): AbandonedRunCleanupResult => {
  const result: AbandonedRunCleanupResult = {
    cleaned: 0,
    kept: 0,
    killed: [],
    scanned: 0,
    skipped: [],
  };
  for (const runId of input.entries) {
    const runDir = join(input.repoRuns, runId);
    try {
      const inspected = inspectStoredRun({
        deps: input.deps,
        liveTmuxSessions: input.liveTmuxSessions,
        repoId: input.repoId,
        runDir,
        runId,
      });
      if (inspected.scanned) {
        result.scanned += 1;
      }
      if (!inspected.cleanup) {
        result.kept += 1;
        continue;
      }
      result.killed.push(...inspected.cleanup.killed);
      result.skipped.push(...inspected.cleanup.skipped);
      if (inspected.cleanup.deferred?.length) {
        if (!result.deferred) {
          result.deferred = [];
        }
        result.deferred.push(...inspected.cleanup.deferred);
      }
      if (inspected.cleanup.unresolved?.length) {
        if (!result.unresolved) {
          result.unresolved = [];
        }
        result.unresolved.push(...inspected.cleanup.unresolved);
      }
      result.cleaned += 1;
    } catch (error) {
      result.kept += 1;
      input.log(
        `[loop] abandoned-run cleanup skipped run "${runId}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return result;
};

export const gcAbandonedRunProcesses = (
  options: {
    cwd?: string;
    deps?: Partial<RunProcessCleanupDeps>;
    home?: string;
    log?: (line: string) => void;
    repoId?: string;
    storageRoot?: string;
  } = {}
): AbandonedRunCleanupResult => {
  const deps = { ...cleanupDeps, ...options.deps };
  const cwd = options.cwd ?? process.cwd();
  const repoId = options.repoId ?? resolveRepoId(cwd);
  const storageRoot =
    options.storageRoot ?? resolveStorageRoot(options.home ?? process.env.HOME);
  const repoRuns = join(storageRoot, repoId);
  const log = options.log ?? console.error;
  let entries: string[];
  try {
    entries = readdirSync(repoRuns, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true })
      );
  } catch {
    return { cleaned: 0, kept: 0, killed: [], scanned: 0, skipped: [] };
  }
  let liveTmuxSessions: ReadonlySet<string> | undefined;
  try {
    liveTmuxSessions = deps.listTmuxSessions();
  } catch (error) {
    log(
      `[loop] abandoned-run cleanup could not inspect tmux; preserving tmux-owned runs: ${error instanceof Error ? error.message : String(error)}`
    );
    liveTmuxSessions = undefined;
  }
  const result = collectStoredRunCleanup({
    deps,
    entries,
    liveTmuxSessions,
    log,
    repoId,
    repoRuns,
  });
  if (result.cleaned > 0) {
    log(
      `[loop] cleaned ${result.cleaned} abandoned run${result.cleaned === 1 ? "" : "s"} for "${repoId}" (${result.killed.length} process${result.killed.length === 1 ? "" : "es"} signaled)`
    );
  }
  return result;
};

export const runProcessCleanupInternals = {
  deps: cleanupDeps,
};
