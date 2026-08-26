import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  lstatSync,
  readdirSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { Plugin } from "vite";

import type {
  AgentLifecycle,
  AgentSeatDTO,
  DataSourceDTO,
  EvidenceItemDTO,
  FleetRunDTO,
  GovernessDTO,
  IsoTimestamp,
  OpaqueEvidenceId,
  ProvenanceDTO,
  RunDetailDTO,
  RunLifecycle,
  RunReasonDTO,
  SourceState,
  TimelineEventDTO,
  WebUiSnapshotDTO,
  WorkerActivityDTO,
  WorkerState,
  WorkerTier,
  WorkerTierDTO,
} from "../types.ts";
import { WEBUI_DTO_VERSION } from "../types.ts";

export const HARVTO_REPO_ID = "harvto-b1e274e66299";
export const LIVE_SNAPSHOT_PATH = "/api/v1/live-snapshot";

const ACTIVE_LIFECYCLES = new Set<RunLifecycle>([
  "submitted",
  "working",
  "reviewing",
  "input-required",
  "blocked",
]);
const LIFECYCLES = new Set<RunLifecycle>([
  ...ACTIVE_LIFECYCLES,
  "blocked",
  "completed",
  "failed",
  "stopped",
]);
const AGENT_EVENTS = new Set([
  "Notification",
  "PostToolUse",
  "PreToolUse",
  "SessionEnd",
  "SessionStart",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
]);
const JOB_STATES = new Set([
  "canceled",
  "claimed",
  "completed",
  "escalated",
  "failed",
  "pending-route",
  "routed-driver",
  "routed-peer",
  "routed-requester",
  "routed-utility",
  "running",
]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const PRESSURE_MODELS = new Set([
  "claude-default",
  "claude-opus-4.8",
  "claude-opus-5",
  "codex-default",
  "codex-spark",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-sol",
]);
const PRESSURE_PHASES = new Set([
  "handoff",
  "hard-ceiling",
  "healthy",
  "prepare",
]);
const UTILITY_KINDS = new Set([
  "inspect",
  "edit",
  "command",
  "review",
  "design",
  "authority",
]);
const BRIDGE_KINDS = new Set([
  "blocked",
  "dead-letter",
  "delivered",
  "delivery-failed",
  "expired",
  "message",
  "notified",
  "superseded",
]);
const BRIDGE_SOURCES = new Set(["claude", "codex", "supervisor", "utility"]);
const BRIDGE_TARGETS = new Set(["claude", "codex", "supervisor"]);
const RUN_ID_PATTERN = /^[1-9][0-9]{0,11}$/;
const REPO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,114}-[0-9a-f]{12}$/;
const REPO_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,114}$/;
const LINE_SPLIT_PATTERN = /\r?\n/u;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_JSONL_BYTES = 4 * 1024 * 1024;
const MAX_JSONL_LINES = 10_000;
const MAX_REPOSITORY_DIRECTORIES = 256;
const MAX_RUN_DIRECTORIES = 1024;
const MAX_TOTAL_RUN_DIRECTORIES = 4096;
const MAX_ACTIVE_RUNS = 64;
const MAX_WORKER_ACTIVITY = 8;

type JsonRecord = Record<string, unknown>;

interface FileSnapshot {
  readonly bytes: number;
  readonly modifiedAt: IsoTimestamp;
  readonly revision: string;
  readonly text: string;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ManifestView {
  readonly createdAt: IsoTimestamp;
  readonly driverEffort: string;
  readonly primaryAgent: "claude" | "codex";
  readonly repoId: string;
  readonly reviewerEffort: string;
  readonly runId: string;
  readonly runtime: RuntimeIdentity;
  readonly state: RunLifecycle;
  readonly status: "running";
  readonly updatedAt: IsoTimestamp;
}

interface ManifestHeader {
  readonly createdAt: IsoTimestamp;
  readonly repoId: string;
  readonly runId: string;
  readonly state: RunLifecycle;
  readonly status: string;
  readonly updatedAt: IsoTimestamp;
}

interface RunCandidate {
  readonly manifest: ManifestView;
  readonly manifestFile: FileSnapshot;
  readonly repoDir: string;
  readonly repoDirectoryIdentity: DirectoryIdentity;
  readonly repoId: string;
  readonly repository: string;
  readonly routeId: string;
  readonly runDir: string;
  readonly runDirectoryIdentity: DirectoryIdentity;
  readonly runId: string;
  readonly storageDirectoryIdentity: DirectoryIdentity;
  readonly storageRoot: string;
}

interface ProjectedRun {
  readonly detail: RunDetailDTO;
  readonly summary: FleetRunDTO;
}

interface RegistryDiscovery {
  readonly candidates: readonly RunCandidate[];
  readonly rejectedEntries: number;
}

type CandidateDiscoveryResult = RunCandidate | "ignored" | "rejected";

export interface RuntimeIdentity {
  readonly session: string;
  readonly socketPath: string;
}

export interface RuntimeProbeResult {
  readonly label: string;
  readonly state: "healthy" | "unknown" | "mismatch" | "surviving" | "ended";
}

export interface RuntimeProbeDependencies {
  readonly lstat: (path: string) => {
    isSocket(): boolean;
    isSymbolicLink(): boolean;
  };
  readonly spawn: (
    command: string,
    args: readonly string[]
  ) => { readonly status: number | null; readonly stderr: string };
}

interface HookView {
  readonly agent: "claude" | "codex";
  readonly event: string;
  readonly lifecycleAt: IsoTimestamp;
  readonly sequence: number;
  readonly state: RunLifecycle;
  readonly ts: IsoTimestamp;
}

interface AgentStateView {
  readonly at: IsoTimestamp;
  readonly state: RunLifecycle;
}

interface CurrentAgentState extends AgentStateView {
  readonly source: "governess" | "hook";
}

interface PressureView {
  readonly compactions: number;
  readonly model: string;
  readonly phase: string;
}

interface GovernessView {
  readonly bothIdleSince?: IsoTimestamp;
  readonly epoch: string;
  readonly leaseExpiresAt?: IsoTimestamp;
  readonly leaseHolder: "claude" | "codex";
  readonly lifecycle: Readonly<
    Partial<Record<"claude" | "codex", AgentStateView>>
  >;
  readonly pressure: Readonly<
    Partial<Record<"claude" | "codex", PressureView>>
  >;
  readonly recoveries: number;
  readonly waitingConfirmed: boolean;
}

interface JournalView {
  readonly count: number;
  readonly lastAt?: IsoTimestamp;
  readonly records: readonly JsonRecord[];
}

interface UtilityJobView {
  readonly at: IsoTimestamp;
  readonly id: string;
  readonly kind: string;
  readonly startedAt: IsoTimestamp;
  readonly state: string;
  readonly tier?: WorkerTier;
}

export interface LoopRegistryLiveDataOptions {
  readonly now?: () => Date;
  readonly registryFs?: RegistryDiscoveryDependencies;
  readonly runtimeProbe?: (identity: RuntimeIdentity) => RuntimeProbeResult;
  readonly storageRoot?: string;
}

export interface RegistryDiscoveryDependencies {
  readonly lstat: (path: string) => Stats;
  readonly readDirectory: (path: string) => readonly Dirent[];
}

export type HarvtoLiveDataOptions = LoopRegistryLiveDataOptions;

export class LiveDataUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "LiveDataUnavailableError";
    this.reason = reason;
  }
}

class RegistryDirectoryIdentityError extends LiveDataUnavailableError {
  constructor(reason: string) {
    super(reason);
    this.name = "RegistryDirectoryIdentityError";
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordAt = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

const stringAt = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const numberAt = (record: JsonRecord, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const nonnegativeSafeIntegerAt = (
  record: JsonRecord,
  key: string
): number | undefined => {
  const value = numberAt(record, key);
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
};

const saturatingCounterSum = (values: readonly number[]): number =>
  values.reduce(
    (sum, value) =>
      sum > Number.MAX_SAFE_INTEGER - value
        ? Number.MAX_SAFE_INTEGER
        : sum + value,
    0
  );

const booleanAt = (record: JsonRecord, key: string): boolean | undefined => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

const asIso = (value: unknown): IsoTimestamp | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

const requireIso = (value: unknown, label: string): IsoTimestamp => {
  const parsed = asIso(value);
  if (!parsed) {
    throw new LiveDataUnavailableError(`${label} is invalid`);
  }
  return parsed;
};

const asLifecycle = (value: unknown): RunLifecycle | undefined =>
  typeof value === "string" && LIFECYCLES.has(value as RunLifecycle)
    ? (value as RunLifecycle)
    : undefined;

const allowlistedLabel = (
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: string
): string =>
  typeof value === "string" && allowed.has(value) ? value : fallback;

const opaque = (scope: string, value: string): string =>
  createHash("sha256").update(`${scope}\0${value}`).digest("hex").slice(0, 16);

const evidenceId = (scope: string, kind: string): OpaqueEvidenceId =>
  `ev_${opaque(scope, kind)}`;

const safeStat = (path: string): Stats => {
  try {
    return lstatSync(path);
  } catch {
    throw new LiveDataUnavailableError("required live evidence is missing");
  }
};

const DEFAULT_REGISTRY_FS: RegistryDiscoveryDependencies = {
  lstat: (path) => lstatSync(path),
  readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
};

const readDirectoryIdentity = (
  path: string,
  dependencies: RegistryDiscoveryDependencies
): DirectoryIdentity => {
  let stat: Stats;
  try {
    stat = dependencies.lstat(path);
  } catch {
    throw new RegistryDirectoryIdentityError(
      "loop registry directory identity is unavailable"
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new RegistryDirectoryIdentityError(
      "loop registry directory identity is invalid"
    );
  }
  return { dev: stat.dev, ino: stat.ino };
};

const assertDirectoryIdentity = (
  path: string,
  expected: DirectoryIdentity,
  dependencies: RegistryDiscoveryDependencies
): void => {
  const current = readDirectoryIdentity(path, dependencies);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new RegistryDirectoryIdentityError(
      "loop registry directory changed during projection"
    );
  }
};

const assertCandidateDirectoryIdentity = (
  candidate: RunCandidate,
  dependencies: RegistryDiscoveryDependencies
): void => {
  assertDirectoryIdentity(
    candidate.storageRoot,
    candidate.storageDirectoryIdentity,
    dependencies
  );
  assertDirectoryIdentity(
    candidate.repoDir,
    candidate.repoDirectoryIdentity,
    dependencies
  );
  assertDirectoryIdentity(
    candidate.runDir,
    candidate.runDirectoryIdentity,
    dependencies
  );
};

const readStableUtf8 = (path: string, maxBytes: number): FileSnapshot => {
  const before = safeStat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new LiveDataUnavailableError(
      "live evidence has an invalid file type"
    );
  }
  if (before.size > maxBytes) {
    throw new LiveDataUnavailableError("live evidence exceeds its read bound");
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new LiveDataUnavailableError("live evidence could not be read");
  }

  const after = safeStat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.byteLength !== after.size
  ) {
    throw new LiveDataUnavailableError("live evidence changed during its read");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LiveDataUnavailableError("live evidence is not valid UTF-8");
  }

  return {
    bytes: bytes.byteLength,
    modifiedAt: new Date(after.mtimeMs).toISOString(),
    revision: `r${Math.floor(after.mtimeMs)}-${after.size}`,
    text,
  };
};

const readOptionalStableUtf8 = (
  path: string,
  maxBytes: number
): FileSnapshot | undefined => {
  try {
    lstatSync(path);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw new LiveDataUnavailableError("optional live evidence is unreadable");
  }
  return readStableUtf8(path, maxBytes);
};

const parseJson = (snapshot: FileSnapshot): JsonRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.text);
  } catch {
    throw new LiveDataUnavailableError("live JSON evidence is malformed");
  }
  if (!isRecord(parsed)) {
    throw new LiveDataUnavailableError(
      "live JSON evidence has an invalid schema"
    );
  }
  return parsed;
};

const parseJsonl = (snapshot: FileSnapshot): readonly JsonRecord[] => {
  const lines = snapshot.text
    .split(LINE_SPLIT_PATTERN)
    .filter((line) => line.trim());
  if (lines.length > MAX_JSONL_LINES) {
    throw new LiveDataUnavailableError("live journal exceeds its line bound");
  }
  return lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LiveDataUnavailableError("live journal evidence is malformed");
    }
    if (!isRecord(parsed)) {
      throw new LiveDataUnavailableError(
        "live journal evidence has an invalid schema"
      );
    }
    return parsed;
  });
};

const within = (root: string, path: string): boolean => {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return (
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  );
};

const repositorySlug = (repoId: string): string => {
  const slug = repoId.slice(0, -13);
  if (!(REPO_ID_PATTERN.test(repoId) && REPO_SLUG_PATTERN.test(slug))) {
    throw new LiveDataUnavailableError("repository identity is invalid");
  }
  return slug;
};

const repositoryLabel = (repoId: string): string =>
  repositorySlug(repoId)
    .split("-")
    .map((part) => {
      if (part === "ai") {
        return "AI";
      }
      if (part === "ui") {
        return "UI";
      }
      return `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
    })
    .join(" ");

const routeIdFor = (repoId: string, runId: string): string =>
  `${repoId}:${runId}`;

const parseManifestHeader = (
  record: JsonRecord,
  expectedRepoId: string,
  expectedRunId: string
): ManifestHeader => {
  const repoId = stringAt(record, "repoId");
  const runId = stringAt(record, "runId");
  const state = asLifecycle(record.state);
  const status = stringAt(record, "status");
  if (
    repoId !== expectedRepoId ||
    runId !== expectedRunId ||
    !state ||
    !status ||
    (ACTIVE_LIFECYCLES.has(state) && status !== "running")
  ) {
    throw new LiveDataUnavailableError(
      "run manifest identity or lifecycle conflicts"
    );
  }
  return {
    createdAt: requireIso(record.createdAt, "manifest created time"),
    repoId,
    runId,
    state,
    status,
    updatedAt: requireIso(record.updatedAt, "manifest update time"),
  };
};

const parseManifest = (
  record: JsonRecord,
  expectedRepoId: string,
  expectedRunId: string
): ManifestView => {
  const header = parseManifestHeader(record, expectedRepoId, expectedRunId);
  const primaryAgent = stringAt(record, "primaryAgent");
  const socketPath = stringAt(record, "tmuxSocket");
  const session = stringAt(record, "tmuxSession");
  const expectedSession = `${repositorySlug(expectedRepoId)}-loop-${expectedRunId}`;
  const workspaceBinding = recordAt(record, "workspaceBinding");
  const workspaceRepoId = workspaceBinding
    ? stringAt(workspaceBinding, "repoId")
    : undefined;
  if (
    !ACTIVE_LIFECYCLES.has(header.state) ||
    (primaryAgent !== "claude" && primaryAgent !== "codex") ||
    !socketPath ||
    !isAbsolute(socketPath) ||
    socketPath.length > 4096 ||
    session !== expectedSession ||
    (workspaceRepoId !== undefined && workspaceRepoId !== expectedRepoId)
  ) {
    throw new LiveDataUnavailableError(
      "run manifest identity or lifecycle conflicts"
    );
  }
  return {
    createdAt: header.createdAt,
    driverEffort: allowlistedLabel(
      record.driverEffort,
      EFFORT_LEVELS,
      "unspecified"
    ),
    primaryAgent,
    repoId: header.repoId,
    reviewerEffort: allowlistedLabel(
      record.reviewerEffort,
      EFFORT_LEVELS,
      "unspecified"
    ),
    runtime: { session, socketPath },
    runId: header.runId,
    state: header.state,
    status: "running",
    updatedAt: header.updatedAt,
  };
};

const listRepositoryEntries = (
  storageRoot: string,
  storageIdentity: DirectoryIdentity,
  dependencies: RegistryDiscoveryDependencies
): readonly Dirent[] => {
  let repositoryEntries: readonly Dirent[];
  try {
    repositoryEntries = dependencies.readDirectory(storageRoot);
  } catch {
    throw new LiveDataUnavailableError("loop registry could not be listed");
  }
  assertDirectoryIdentity(storageRoot, storageIdentity, dependencies);
  if (repositoryEntries.length > MAX_REPOSITORY_DIRECTORIES) {
    throw new LiveDataUnavailableError(
      "loop registry exceeds its repository bound"
    );
  }

  return repositoryEntries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        REPO_ID_PATTERN.test(entry.name)
    )
    .sort((left, right) => left.name.localeCompare(right.name));
};

const listNumericRunEntries = (
  storageRoot: string,
  storageIdentity: DirectoryIdentity,
  repoDir: string,
  dependencies: RegistryDiscoveryDependencies
): readonly Dirent[] | undefined => {
  assertDirectoryIdentity(storageRoot, storageIdentity, dependencies);
  let repoIdentity: DirectoryIdentity;
  let runEntries: readonly Dirent[];
  try {
    repoIdentity = readDirectoryIdentity(repoDir, dependencies);
    runEntries = dependencies.readDirectory(repoDir);
    assertDirectoryIdentity(repoDir, repoIdentity, dependencies);
  } catch {
    return undefined;
  }
  assertDirectoryIdentity(storageRoot, storageIdentity, dependencies);
  if (runEntries.length > MAX_RUN_DIRECTORIES) {
    return undefined;
  }
  return runEntries
    .filter((entry) => RUN_ID_PATTERN.test(entry.name))
    .sort((left, right) => Number(left.name) - Number(right.name));
};

const readRunCandidate = (
  storageRoot: string,
  storageIdentity: DirectoryIdentity,
  repositoryEntry: Dirent,
  runEntry: Dirent,
  dependencies: RegistryDiscoveryDependencies
): CandidateDiscoveryResult => {
  if (!(runEntry.isDirectory() && !runEntry.isSymbolicLink())) {
    return "rejected";
  }
  const repoId = repositoryEntry.name;
  const repoDir = join(storageRoot, repoId);
  const runId = runEntry.name;
  const runDir = join(repoDir, runId);
  if (!(within(storageRoot, repoDir) && within(repoDir, runDir))) {
    return "rejected";
  }
  assertDirectoryIdentity(storageRoot, storageIdentity, dependencies);

  let repoDirectoryIdentity: DirectoryIdentity;
  let runDirectoryIdentity: DirectoryIdentity;
  try {
    repoDirectoryIdentity = readDirectoryIdentity(repoDir, dependencies);
    runDirectoryIdentity = readDirectoryIdentity(runDir, dependencies);
  } catch {
    return "rejected";
  }

  const manifestPath = join(runDir, "manifest.json");
  let manifestStat: Stats;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "ignored" : "rejected";
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    return "rejected";
  }

  let result: CandidateDiscoveryResult;
  try {
    const manifestFile = readStableUtf8(manifestPath, MAX_JSON_BYTES);
    const record = parseJson(manifestFile);
    const header = parseManifestHeader(record, repoId, runId);
    assertDirectoryIdentity(repoDir, repoDirectoryIdentity, dependencies);
    assertDirectoryIdentity(runDir, runDirectoryIdentity, dependencies);
    if (ACTIVE_LIFECYCLES.has(header.state)) {
      result = {
        manifest: parseManifest(record, repoId, runId),
        manifestFile,
        repoDir,
        repoDirectoryIdentity,
        repoId,
        repository: repositoryLabel(repoId),
        routeId: routeIdFor(repoId, runId),
        runDir,
        runDirectoryIdentity,
        runId,
        storageDirectoryIdentity: storageIdentity,
        storageRoot,
      };
    } else {
      result = "ignored";
    }
  } catch {
    return "rejected";
  }
  assertDirectoryIdentity(storageRoot, storageIdentity, dependencies);
  return result;
};

const discoverActiveRuns = (
  storageRoot: string,
  dependencies: RegistryDiscoveryDependencies
): RegistryDiscovery => {
  const storageIdentity = readDirectoryIdentity(storageRoot, dependencies);
  const repositoryEntries = listRepositoryEntries(
    storageRoot,
    storageIdentity,
    dependencies
  );

  const candidates: RunCandidate[] = [];
  let rejectedEntries = 0;
  let totalRunDirectories = 0;

  for (const repositoryEntry of repositoryEntries) {
    const repoId = repositoryEntry.name;
    const repoDir = join(storageRoot, repoId);
    const numericEntries = listNumericRunEntries(
      storageRoot,
      storageIdentity,
      repoDir,
      dependencies
    );
    if (!numericEntries) {
      rejectedEntries += 1;
      continue;
    }
    totalRunDirectories += numericEntries.length;
    if (totalRunDirectories > MAX_TOTAL_RUN_DIRECTORIES) {
      throw new LiveDataUnavailableError(
        "loop registry exceeds its run-directory bound"
      );
    }

    for (const runEntry of numericEntries) {
      const result = readRunCandidate(
        storageRoot,
        storageIdentity,
        repositoryEntry,
        runEntry,
        dependencies
      );
      if (result === "rejected") {
        rejectedEntries += 1;
      } else if (result !== "ignored") {
        candidates.push(result);
      }
    }
  }

  if (candidates.length > MAX_ACTIVE_RUNS) {
    throw new LiveDataUnavailableError(
      "loop registry exceeds its active-run bound"
    );
  }
  return { candidates, rejectedEntries };
};

const parseHook = (
  records: readonly JsonRecord[],
  expectedAgent: "claude" | "codex"
): HookView => {
  let activity:
    | Pick<HookView, "agent" | "event" | "sequence" | "ts">
    | undefined;
  let lifecycle: Pick<HookView, "lifecycleAt" | "state"> | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const agent = stringAt(record, "agent");
    const sequence = nonnegativeSafeIntegerAt(record, "sequence");
    const ts = asIso(record.ts);
    if (agent !== expectedAgent || sequence === undefined || !ts) {
      continue;
    }
    if (!activity) {
      const rawEvent = stringAt(record, "event");
      activity = {
        agent: expectedAgent,
        event: rawEvent && AGENT_EVENTS.has(rawEvent) ? rawEvent : "Activity",
        sequence,
        ts,
      };
    }
    const state = asLifecycle(record.state);
    if (!lifecycle && state) {
      lifecycle = { lifecycleAt: ts, state };
    }
    if (activity && lifecycle) {
      return { ...activity, ...lifecycle };
    }
  }
  throw new LiveDataUnavailableError(
    "normalized hook lifecycle evidence is unavailable"
  );
};

const parseAgentState = (value: unknown): AgentStateView | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const state = asLifecycle(value.state);
  const at = asIso(value.at);
  return state && at ? { at, state } : undefined;
};

const parsePressure = (value: unknown): PressureView | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    compactions: nonnegativeSafeIntegerAt(value, "compactions") ?? 0,
    model: allowlistedLabel(value.model, PRESSURE_MODELS, "Unavailable"),
    phase: allowlistedLabel(value.phase, PRESSURE_PHASES, "unknown"),
  };
};

const parseGoverness = (record: JsonRecord): GovernessView => {
  const epoch = numberAt(record, "governessEpoch");
  const driverLease = recordAt(record, "driverLease");
  const holder = driverLease ? stringAt(driverLease, "holder") : undefined;
  if (epoch === undefined || (holder !== "claude" && holder !== "codex")) {
    throw new LiveDataUnavailableError(
      "Governess authority evidence is invalid"
    );
  }
  const lifecycle = recordAt(record, "lifecycleEvents") ?? {};
  const pressure = recordAt(record, "sessionPressure") ?? {};
  return {
    ...(asIso(record.bothIdleSince)
      ? { bothIdleSince: asIso(record.bothIdleSince) }
      : {}),
    epoch: String(Math.floor(epoch)),
    ...(driverLease && asIso(driverLease.expiresAt)
      ? { leaseExpiresAt: asIso(driverLease.expiresAt) }
      : {}),
    leaseHolder: holder,
    lifecycle: {
      ...(parseAgentState(lifecycle.claude)
        ? { claude: parseAgentState(lifecycle.claude) }
        : {}),
      ...(parseAgentState(lifecycle.codex)
        ? { codex: parseAgentState(lifecycle.codex) }
        : {}),
    },
    pressure: {
      ...(parsePressure(pressure.claude)
        ? { claude: parsePressure(pressure.claude) }
        : {}),
      ...(parsePressure(pressure.codex)
        ? { codex: parsePressure(pressure.codex) }
        : {}),
    },
    recoveries: Math.max(0, Math.floor(numberAt(record, "recoveries") ?? 0)),
    waitingConfirmed: booleanAt(record, "waitingConfirmed") ?? false,
  };
};

const journalView = (records: readonly JsonRecord[]): JournalView => ({
  count: records.length,
  lastAt: records
    .map((record) => asIso(record.at ?? record.ts ?? record.timestamp))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1),
  records,
});

const bridgeJournalView = (records: readonly JsonRecord[]): JournalView => {
  const normalized = records.filter((record) => {
    const kind = stringAt(record, "kind");
    const sourceName = stringAt(record, "source");
    const targetName = stringAt(record, "target");
    return Boolean(
      stringAt(record, "id") &&
        asIso(record.at) &&
        kind &&
        BRIDGE_KINDS.has(kind) &&
        sourceName &&
        BRIDGE_SOURCES.has(sourceName) &&
        targetName &&
        BRIDGE_TARGETS.has(targetName)
    );
  });
  return journalView(normalized);
};

const DEFAULT_RUNTIME_PROBE_DEPENDENCIES: RuntimeProbeDependencies = {
  lstat: lstatSync,
  spawn: (command, args) => {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      maxBuffer: 8192,
      timeout: 1500,
    });
    return {
      status: result.status,
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  },
};

export const probeLoopRuntime = (
  identity: RuntimeIdentity,
  dependencies: RuntimeProbeDependencies = DEFAULT_RUNTIME_PROBE_DEPENDENCIES
): RuntimeProbeResult => {
  let socketStat: ReturnType<RuntimeProbeDependencies["lstat"]>;
  try {
    socketStat = dependencies.lstat(identity.socketPath);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { label: "Exact terminal session unavailable", state: "ended" }
      : { label: "Terminal session status unverified", state: "unknown" };
  }
  if (socketStat.isSymbolicLink() || !socketStat.isSocket()) {
    return { label: "Terminal socket identity invalid", state: "mismatch" };
  }

  const result = dependencies.spawn("tmux", [
    "-S",
    identity.socketPath,
    "has-session",
    "-t",
    `=${identity.session}`,
  ]);
  if (result.status === 0) {
    return {
      label: "Terminal session present; server birth unverified",
      state: "unknown",
    };
  }
  const stderr = result.stderr;
  if (
    result.status === 1 &&
    (stderr.includes(`can't find session: ${identity.session}`) ||
      stderr.includes("no server running on"))
  ) {
    return { label: "Exact terminal session unavailable", state: "ended" };
  }
  return { label: "Terminal session status unverified", state: "unknown" };
};

export const probeHarvtoRuntime = probeLoopRuntime;

const maxIso = (...values: readonly (string | undefined)[]): IsoTimestamp => {
  const sorted = values
    .filter((value): value is string => Boolean(value))
    .sort();
  return sorted.at(-1) ?? new Date(0).toISOString();
};

const source = (
  runId: string,
  sourceId: string,
  sourceKind: ProvenanceDTO["sourceKind"],
  observedAt: IsoTimestamp,
  state: SourceState = "current",
  note?: string
): ProvenanceDTO => ({
  ...(note ? { note } : {}),
  observedAt,
  revision: `rev-${opaque(runId, `${sourceId}-${observedAt}`)}`,
  sourceId,
  sourceKind,
  state,
});

const currentAgentState = (
  governessState: AgentStateView | undefined,
  hook: HookView
): CurrentAgentState => {
  if (governessState && governessState.at > hook.lifecycleAt) {
    return { ...governessState, source: "governess" };
  }
  return { at: hook.lifecycleAt, source: "hook", state: hook.state };
};

const currentAgentStates = (
  governess: GovernessView,
  hooks: Readonly<Record<"claude" | "codex", HookView>>
): Readonly<Record<"claude" | "codex", CurrentAgentState>> => ({
  claude: currentAgentState(governess.lifecycle.claude, hooks.claude),
  codex: currentAgentState(governess.lifecycle.codex, hooks.codex),
});

const deriveLifecycle = (
  manifest: ManifestView,
  current: Readonly<Record<"claude" | "codex", CurrentAgentState>>
): RunLifecycle => {
  if (!ACTIVE_LIFECYCLES.has(manifest.state)) {
    return manifest.state;
  }
  const states = [current.claude.state, current.codex.state] as const;
  if (states.includes("blocked")) {
    return "blocked";
  }
  if (states.every((state) => state === "input-required")) {
    return "input-required";
  }
  if (states.includes("reviewing")) {
    return "reviewing";
  }
  if (states.includes("working")) {
    return "working";
  }
  if (states.includes("input-required")) {
    return "input-required";
  }
  return manifest.state;
};

const agentLifecycle = (
  current: CurrentAgentState,
  hook: HookView,
  runtimeState: RuntimeProbeResult["state"]
): AgentLifecycle => {
  if (runtimeState === "ended" || runtimeState === "mismatch") {
    return "stuck";
  }
  if (current.state === "input-required") {
    return "waiting-human";
  }
  if (current.state === "blocked") {
    return "stuck";
  }
  if (current.state === "reviewing") {
    return "reviewing";
  }
  if (current.state === "failed") {
    return "crashed";
  }
  if (current.state === "completed" || current.state === "stopped") {
    return "finished";
  }
  if (current.state === "submitted") {
    return "starting";
  }
  return hook.ts >= current.at && hook.event === "Stop"
    ? "waiting-peer"
    : "working";
};

const dataSource = (now: IsoTimestamp): DataSourceDTO => ({
  generatedAt: now,
  kind: "live-redacted",
  notice:
    "Prompts, transcripts, paths, credentials, raw identifiers, and terminal content are excluded.",
  scenario: "Active loop registry",
});

const bridgeDeliveryStatus = (
  kind: string | undefined
): "delivered" | "failed" | "pending" | "superseded" | "expired" => {
  if (kind === "delivered") {
    return "delivered";
  }
  if (kind === "blocked" || kind === "dead-letter") {
    return "failed";
  }
  if (kind === "delivery-failed") {
    return "failed";
  }
  if (kind === "expired") {
    return "expired";
  }
  if (kind === "superseded") {
    return "superseded";
  }
  return "pending";
};

const derivedTaskLabel = (
  lifecycle: AgentLifecycle,
  runtimeState: RuntimeProbeResult["state"],
  repository: string
): string => {
  if (runtimeState === "ended" || runtimeState === "mismatch") {
    return "Last durable state required operator input; runtime unavailable";
  }
  if (lifecycle === "waiting-human") {
    return `Waiting for operator input in the ${repository} loop`;
  }
  if (lifecycle === "reviewing") {
    return `Reviewing durable ${repository} loop work`;
  }
  return `Working in the ${repository} loop`;
};

const latestBridgeStatus = (
  bridge: JournalView,
  agent: "claude" | "codex"
): AgentSeatDTO["latestBridgeMessage"] => {
  const messages = new Map<
    string,
    {
      at: IsoTimestamp;
      direction: "sent" | "received";
      source: string;
      status: "delivered" | "failed" | "pending" | "superseded" | "expired";
      target: string;
    }
  >();
  for (const record of bridge.records) {
    const id = stringAt(record, "id");
    const at = asIso(record.at);
    const kind = stringAt(record, "kind");
    const sourceName = stringAt(record, "source");
    const targetName = stringAt(record, "target");
    if (!(id && at && kind && sourceName && targetName)) {
      continue;
    }
    if (kind === "message" && (sourceName === agent || targetName === agent)) {
      messages.set(id, {
        at,
        direction: sourceName === agent ? "sent" : "received",
        source: sourceName,
        status: "pending",
        target: targetName,
      });
      continue;
    }
    const previous = messages.get(id);
    if (
      previous &&
      previous.source === sourceName &&
      previous.target === targetName &&
      kind !== "notified"
    ) {
      messages.set(id, {
        ...previous,
        at,
        status: bridgeDeliveryStatus(kind),
      });
    }
  }
  const latest = [...messages.values()].sort((left, right) =>
    right.at.localeCompare(left.at)
  )[0];
  if (!latest) {
    return undefined;
  }
  return {
    at: latest.at,
    direction: latest.direction,
    status: latest.status,
    summary: "Durable bridge metadata recorded; message content is redacted.",
  };
};

const buildAgent = (input: {
  readonly agent: "claude" | "codex";
  readonly bridge: JournalView;
  readonly governess: GovernessView;
  readonly governessObservedAt: IsoTimestamp;
  readonly hook: HookView;
  readonly manifest: ManifestView;
  readonly repository: string;
  readonly runtime: RuntimeProbeResult;
  readonly scope: string;
}): AgentSeatDTO => {
  const {
    agent,
    bridge,
    governess,
    governessObservedAt,
    hook,
    manifest,
    repository,
    runtime,
    scope,
  } = input;
  const isDriver = governess.leaseHolder === agent;
  const pressure = governess.pressure[agent];
  const displayName = agent === "codex" ? "Codex" : "Claude";
  const effort =
    manifest.primaryAgent === agent
      ? manifest.driverEffort
      : manifest.reviewerEffort;
  const current = currentAgentState(governess.lifecycle[agent], hook);
  const lifecycle = agentLifecycle(current, hook, runtime.state);
  let governessLifecycleSourceState: SourceState = "missing";
  if (governess.lifecycle[agent]) {
    governessLifecycleSourceState =
      current.source === "governess" ? "current" : "stale";
  }
  return {
    currentTask: derivedTaskLabel(lifecycle, runtime.state, repository),
    displayName,
    id: `agent_${opaque(scope, agent)}`,
    lastHookAt: hook.ts,
    lastHookEvent: hook.event,
    ...(latestBridgeStatus(bridge, agent)
      ? { latestBridgeMessage: latestBridgeStatus(bridge, agent) }
      : {}),
    lifecycle,
    model: pressure?.model ?? "Unavailable",
    provenance: [
      source(
        scope,
        `${agent}-hooks`,
        "hook-journal",
        hook.lifecycleAt,
        current.source === "hook" ? "current" : "stale",
        "Normalized lifecycle metadata only"
      ),
      source(
        scope,
        `${agent}-governess`,
        "governess-journal",
        governess.lifecycle[agent]?.at ?? governessObservedAt,
        governessLifecycleSourceState,
        "Persisted lifecycle and pressure metadata"
      ),
    ],
    provider: "Frontier runtime",
    reasoningEffort: effort,
    role: isDriver ? "driver" : "reviewer",
    taskObservedAt: current.at,
    taskSource:
      current.source === "governess"
        ? "latest persisted Governess lifecycle"
        : "latest normalized hook lifecycle",
    toolsInFlight: hook.ts >= current.at && hook.event === "PreToolUse" ? 1 : 0,
    usage: {
      compactions: pressure?.compactions ?? 0,
      windows: [],
    },
  };
};

const workerTier = (value: unknown): WorkerTier | undefined => {
  if (value === "utility-nanny") {
    return "nanny";
  }
  if (value === "utility-au-pair") {
    return "au-pair";
  }
  if (value === "utility-direct") {
    return "direct";
  }
  return undefined;
};

const workerState = (value: string): WorkerState => {
  if (value === "completed") {
    return "completed";
  }
  if (["claimed", "running"].includes(value)) {
    return "active";
  }
  if (value === "escalated") {
    return "escalated";
  }
  if (value === "canceled") {
    return "canceled";
  }
  if (value === "failed") {
    return "failed";
  }
  return "queued";
};

const utilityJobs = (
  records: readonly JsonRecord[]
): readonly UtilityJobView[] => {
  const jobs = new Map<string, UtilityJobView>();
  for (const record of records) {
    const rawId = stringAt(record, "jobId");
    const at = asIso(record.at);
    const state = stringAt(record, "state");
    if (!(rawId && at && state && JOB_STATES.has(state))) {
      continue;
    }
    const previous = jobs.get(rawId);
    const request = recordAt(record, "request");
    const decision = recordAt(record, "decision");
    jobs.set(rawId, {
      at,
      id: rawId,
      kind: allowlistedLabel(
        request?.kind,
        UTILITY_KINDS,
        previous?.kind ?? "task"
      ),
      startedAt: previous?.startedAt ?? at,
      state,
      tier: decision ? workerTier(decision.tierId) : previous?.tier,
    });
  }
  return [...jobs.values()].sort((left, right) =>
    right.at.localeCompare(left.at)
  );
};

const buildWorkers = (
  scope: string,
  jobs: readonly UtilityJobView[]
): readonly WorkerTierDTO[] => {
  const definitions: ReadonlyArray<{
    tier: WorkerTier;
    label: string;
    description: string;
  }> = [
    {
      tier: "direct",
      label: "Direct",
      description:
        "Bounded utility work routed directly by the durable policy.",
    },
    {
      tier: "nanny",
      label: "Nanny",
      description: "Local supervisory utility work with bounded metadata.",
    },
    {
      tier: "au-pair",
      label: "Au Pair",
      description:
        "Optional paid helper tier; content and spend details stay redacted.",
    },
  ];
  return definitions.map((definition) => {
    const tierJobs = jobs.filter((job) => job.tier === definition.tier);
    const activity: readonly WorkerActivityDTO[] = tierJobs
      .slice(0, MAX_WORKER_ACTIVITY)
      .map((job) => {
        const state = workerState(job.state);
        return {
          artifactEvidenceIds: [],
          contextCapsule:
            "Context, request, result, and tool content are redacted at the server boundary.",
          ...(["active", "queued"].includes(state)
            ? {}
            : { finishedAt: job.at }),
          id: `worker_${opaque(scope, job.id)}`,
          requestSummary: `${job.kind[0]?.toUpperCase() ?? "T"}${job.kind.slice(1)} task; content redacted`,
          resultSummary: `Durable worker state: ${state}`,
          routingReason: "Selected by durable utility routing metadata",
          startedAt: job.startedAt,
          state,
          tier: definition.tier,
          toolSummary: "Tool names and arguments are not exposed",
        };
      });
    return {
      activity,
      counts: {
        active: tierJobs.filter((job) => workerState(job.state) === "active")
          .length,
        canceled: tierJobs.filter(
          (job) => workerState(job.state) === "canceled"
        ).length,
        completed: tierJobs.filter(
          (job) => workerState(job.state) === "completed"
        ).length,
        escalated: tierJobs.filter(
          (job) => workerState(job.state) === "escalated"
        ).length,
        failed: tierJobs.filter((job) => workerState(job.state) === "failed")
          .length,
        queued: tierJobs.filter((job) => workerState(job.state) === "queued")
          .length,
      },
      description: definition.description,
      label: definition.label,
      tier: definition.tier,
    };
  });
};

const buildEvidence = (
  scope: string,
  files: ReadonlyArray<{
    readonly id: string;
    readonly kind: EvidenceItemDTO["kind"];
    readonly sourceKind: ProvenanceDTO["sourceKind"];
    readonly snapshot: FileSnapshot;
    readonly title: string;
  }>
): readonly EvidenceItemDTO[] =>
  files.map((file) => ({
    byteCount: file.snapshot.bytes,
    capturedAt: file.snapshot.modifiedAt,
    id: evidenceId(scope, file.id),
    kind: file.kind,
    mimeType:
      file.id === "manifest" || file.id === "governess"
        ? "application/json"
        : "text/plain",
    provenance: source(
      scope,
      `run-${scope}-${file.id}`,
      file.sourceKind,
      file.snapshot.modifiedAt
    ),
    redactionsApplied: 1,
    summary: "Metadata is available; raw content is intentionally withheld.",
    title: file.title,
  }));

const buildLifecycleConflictEvents = (input: {
  readonly agentStates: Readonly<Record<"claude" | "codex", CurrentAgentState>>;
  readonly derivedLifecycle: RunLifecycle;
  readonly manifest: ManifestView;
  readonly scope: string;
}): readonly TimelineEventDTO[] => {
  if (input.derivedLifecycle === input.manifest.state) {
    return [];
  }
  return (["claude", "codex"] as const).flatMap((agent, index) => {
    const current = input.agentStates[agent];
    if (current.state === input.manifest.state) {
      return [];
    }
    const sourceKind =
      current.source === "governess" ? "governess-journal" : "hook-journal";
    const evidenceKind =
      current.source === "governess" ? "governess" : `${agent}-hooks`;
    const key = `lifecycle-conflict-${agent}`;
    return [
      {
        actor: agent === "claude" ? "Claude" : "Codex",
        at: current.at,
        category: "governess" as const,
        detail: `The live projection shows ${input.derivedLifecycle}; the manifest still records ${input.manifest.state}.`,
        evidenceIds: [evidenceId(input.scope, evidenceKind)],
        id: `timeline_${opaque(input.scope, key)}`,
        provenance: source(
          input.scope,
          `timeline-${key}`,
          sourceKind,
          current.at
        ),
        sequence: 20 + index,
        title: "Newer lifecycle evidence disagrees with manifest",
        tone: "warning" as const,
      },
    ];
  });
};

const buildTimeline = (input: {
  readonly agentStates: Readonly<Record<"claude" | "codex", CurrentAgentState>>;
  readonly bridge: JournalView;
  readonly derivedLifecycle: RunLifecycle;
  readonly hooks: Readonly<Record<"claude" | "codex", HookView>>;
  readonly jobs: readonly UtilityJobView[];
  readonly manifest: ManifestView;
  readonly now: IsoTimestamp;
  readonly repository: string;
  readonly runtime: RuntimeProbeResult;
  readonly scope: string;
}): readonly TimelineEventDTO[] => {
  const {
    agentStates,
    bridge,
    derivedLifecycle,
    hooks,
    jobs,
    manifest,
    now,
    repository,
    runtime,
    scope,
  } = input;
  const events: TimelineEventDTO[] = [];
  const add = (
    key: string,
    at: string,
    category: TimelineEventDTO["category"],
    actor: string,
    title: string,
    detail: string,
    tone: TimelineEventDTO["tone"],
    sourceKind: ProvenanceDTO["sourceKind"],
    sequence: number,
    evidenceIds: readonly OpaqueEvidenceId[] = []
  ) => {
    events.push({
      actor,
      at,
      category,
      detail,
      evidenceIds,
      id: `timeline_${opaque(scope, key)}`,
      provenance: source(scope, `timeline-${key}`, sourceKind, at),
      sequence,
      title,
      tone,
    });
  };

  add(
    "created",
    manifest.createdAt,
    "lifecycle",
    "Loop",
    `${repository} run created`,
    `Run ${manifest.runId} entered the durable registry.`,
    "info",
    "manifest",
    1,
    [evidenceId(scope, "manifest")]
  );
  for (const [index, agent] of (["claude", "codex"] as const).entries()) {
    const hook = hooks[agent];
    add(
      `${agent}-hook`,
      hook.ts,
      "agent",
      agent === "codex" ? "Codex" : "Claude",
      `${hook.event} recorded`,
      `Normalized lifecycle metadata reports ${hook.state}.`,
      hook.state === "input-required" ? "warning" : "info",
      "hook-journal",
      10 + index,
      [evidenceId(scope, `${agent}-hooks`)]
    );
  }
  events.push(
    ...buildLifecycleConflictEvents({
      agentStates,
      derivedLifecycle,
      manifest,
      scope,
    })
  );
  if (bridge.lastAt) {
    add(
      "bridge",
      bridge.lastAt,
      "bridge",
      "Bridge",
      "Durable bridge activity observed",
      `${bridge.count} journal records projected as metadata only.`,
      "neutral",
      "bridge-journal",
      30,
      [evidenceId(scope, "bridge")]
    );
  }
  if (jobs[0]) {
    add(
      "workers",
      jobs[0].at,
      "worker",
      "Utility router",
      "Bounded worker activity observed",
      `${jobs.length} durable worker jobs are represented without task content.`,
      "neutral",
      "worker-journal",
      40,
      [evidenceId(scope, "utility")]
    );
  }
  add(
    "adapter-boundary",
    now,
    "adapter",
    "Web UI",
    runtime.label,
    runtime.state === "ended"
      ? "The manifest's exact terminal session is unavailable."
      : "The exact terminal session was checked without exposing its identity.",
    runtime.state === "ended" || runtime.state === "mismatch"
      ? "warning"
      : "neutral",
    "adapter-probe",
    50
  );
  return events
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 100)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
};

const buildRunReasons = (
  lifecycle: RunLifecycle,
  manifestLifecycle: RunLifecycle,
  runtime: RuntimeProbeResult
): readonly RunReasonDTO[] => {
  const reasons: RunReasonDTO[] = [];
  if (lifecycle === "input-required") {
    reasons.push({
      code: "input-required",
      detail:
        "Both normalized frontier lifecycle records require operator input.",
      label: "Operator input required",
      severity: "high",
    });
  }
  if (lifecycle === "blocked") {
    reasons.push({
      code: "failed-control",
      detail:
        "Durable lifecycle evidence reports that frontier work is blocked.",
      label: "Run blocked",
      severity: "high",
    });
  }
  if (lifecycle !== manifestLifecycle) {
    reasons.push({
      code: "active-looking-manifest",
      detail: `Newer durable lifecycle metadata reports ${lifecycle}; the manifest remains ${manifestLifecycle}.`,
      label: "Manifest lifecycle behind",
      severity: "medium",
    });
  }
  if (runtime.state === "ended" || runtime.state === "mismatch") {
    reasons.push({
      code: "identity-conflict",
      detail:
        "The persisted lifecycle looks active, but the manifest's exact terminal runtime is unavailable.",
      label: "Runtime unavailable",
      severity: runtime.state === "mismatch" ? "critical" : "high",
    });
  } else if (runtime.state === "unknown") {
    reasons.push({
      code: "audit-partial",
      detail:
        "The exact terminal session was checked, but server birth identity is not persisted for full verification.",
      label: "Runtime identity partial",
      severity: "low",
    });
  }
  return reasons;
};

const qualitySummary = (
  lifecycle: RunLifecycle,
  manifestLifecycle: RunLifecycle,
  runtime: RuntimeProbeResult
): string => {
  if (runtime.state === "ended" || runtime.state === "mismatch") {
    return `Persisted lifecycle reports ${lifecycle}, but the exact terminal runtime is unavailable. The projection remains connected to durable records.`;
  }
  if (lifecycle !== manifestLifecycle) {
    return `Durable Governess and hook evidence reports ${lifecycle}; the manifest still reports ${manifestLifecycle}. ${runtime.label}.`;
  }
  return `Durable records agree on ${lifecycle}. ${runtime.label}.`;
};

const governessInterpretation = (
  lifecycle: RunLifecycle,
  runtimeConflict: boolean
): string => {
  if (runtimeConflict) {
    return "The last durable frontier states require operator input, but the exact terminal runtime is unavailable.";
  }
  if (lifecycle === "input-required") {
    return "Both frontier seats' last durable state requires operator input.";
  }
  if (lifecycle === "blocked") {
    return "Durable frontier lifecycle evidence reports blocked work.";
  }
  return `The loop currently reports ${lifecycle}.`;
};

const buildGovernessDto = (input: {
  readonly driver: string;
  readonly factProvenance: ProvenanceDTO;
  readonly governess: GovernessView;
  readonly hasLifecycleConflict: boolean;
  readonly leaseCurrent: boolean;
  readonly lifecycle: RunLifecycle;
  readonly manifestProvenance: ProvenanceDTO;
  readonly manifestState: RunLifecycle;
  readonly now: IsoTimestamp;
  readonly runId: string;
  readonly runtime: RuntimeProbeResult;
  readonly runtimeConflict: boolean;
  readonly scope: string;
}): GovernessDTO => ({
  audit: [],
  driverLease: input.leaseCurrent
    ? `${input.driver} holds the current persisted lease`
    : "Persisted driver lease is stale",
  epoch: input.governess.epoch,
  facts: [
    {
      label: "Derived lifecycle",
      provenance: input.factProvenance,
      status:
        input.lifecycle === "input-required" || input.lifecycle === "blocked"
          ? "warning"
          : "ok",
      value: input.lifecycle,
    },
    {
      label: "Manifest lifecycle",
      provenance: input.manifestProvenance,
      status: input.hasLifecycleConflict ? "warning" : "ok",
      value: input.manifestState,
    },
    {
      label: "Waiting confirmation",
      provenance: input.factProvenance,
      status: input.governess.waitingConfirmed ? "warning" : "neutral",
      value: input.governess.waitingConfirmed ? "Confirmed" : "Not confirmed",
    },
    {
      label: "Recoveries",
      provenance: input.factProvenance,
      status: input.governess.recoveries === 0 ? "ok" : "warning",
      value: String(input.governess.recoveries),
    },
    {
      label: "Terminal identity",
      provenance: source(
        input.scope,
        `run-${input.runId}-adapter-boundary`,
        "adapter-probe",
        input.now,
        "not-applicable"
      ),
      status: "neutral",
      value: input.runtime.label,
    },
  ],
  interpretations: [
    {
      confidence: 1,
      generatedAt: input.now,
      kind:
        input.runtimeConflict || input.lifecycle === "input-required"
          ? "waiting-human"
          : "progress",
      source: "derived from normalized lifecycle metadata",
      summary: governessInterpretation(input.lifecycle, input.runtimeConflict),
    },
    {
      confidence: 1,
      generatedAt: input.now,
      kind: "next",
      source: "read-only release policy",
      summary: input.runtimeConflict
        ? "Inspect the durable record before deciding whether to restart the terminal runtime."
        : "Continue or reconcile this lane from its validated terminal workflow.",
    },
  ],
  policies: [
    {
      disposition: "blocked",
      reason: "This release exposes no runtime mutation endpoint.",
      releaseLabel: "Read-only release",
      title: "Browser mutations",
    },
    {
      disposition: "confirmation-bound",
      reason: "Operator input remains in the validated terminal workflow.",
      releaseLabel: "Read-only release",
      title: "Continue run",
    },
  ],
});

const projectActiveRun = (
  candidate: RunCandidate,
  options: LoopRegistryLiveDataOptions,
  now: IsoTimestamp
): ProjectedRun => {
  const { manifest, manifestFile, repoId, repository, routeId, runDir, runId } =
    candidate;
  const registryFs = options.registryFs ?? DEFAULT_REGISTRY_FS;
  assertCandidateDirectoryIdentity(candidate, registryFs);
  const runtime = (options.runtimeProbe ?? probeLoopRuntime)(manifest.runtime);
  const governessFile = readStableUtf8(
    join(runDir, "governess-state.json"),
    MAX_JSON_BYTES
  );
  const governess = parseGoverness(parseJson(governessFile));
  const claudeHooksFile = readStableUtf8(
    join(runDir, "hooks", "claude.jsonl"),
    MAX_JSONL_BYTES
  );
  const codexHooksFile = readStableUtf8(
    join(runDir, "hooks", "codex.jsonl"),
    MAX_JSONL_BYTES
  );
  const hooks = {
    claude: parseHook(parseJsonl(claudeHooksFile), "claude"),
    codex: parseHook(parseJsonl(codexHooksFile), "codex"),
  } satisfies Readonly<Record<"claude" | "codex", HookView>>;
  const bridgeFile = readStableUtf8(
    join(runDir, "bridge.jsonl"),
    MAX_JSONL_BYTES
  );
  const bridge = bridgeJournalView(parseJsonl(bridgeFile));
  const reconciliationFile = readOptionalStableUtf8(
    join(runDir, "bridge-reconciliation.json"),
    MAX_JSON_BYTES
  );
  if (reconciliationFile) {
    parseJson(reconciliationFile);
  }
  const utilityFile = readStableUtf8(
    join(runDir, "utility", "jobs.jsonl"),
    MAX_JSONL_BYTES
  );
  const jobs = utilityJobs(parseJsonl(utilityFile));

  const agentStates = currentAgentStates(governess, hooks);
  const lifecycle = deriveLifecycle(manifest, agentStates);
  const hasLifecycleConflict = lifecycle !== manifest.state;
  const lifecycleObservedAt = maxIso(
    agentStates.claude.at,
    agentStates.codex.at
  );
  const lastEventAt = maxIso(
    manifest.updatedAt,
    lifecycleObservedAt,
    hooks.claude.ts,
    hooks.codex.ts,
    bridge.lastAt,
    jobs[0]?.at
  );
  const projectionSource = dataSource(now);
  const sourcePrefix = `run-${opaque(routeId, "source")}`;
  const governessLifecycleObservedAt = maxIso(
    governess.lifecycle.claude?.at,
    governess.lifecycle.codex?.at
  );
  let governessLifecycleState: SourceState = "missing";
  if (governess.lifecycle.claude || governess.lifecycle.codex) {
    governessLifecycleState =
      agentStates.claude.source === "governess" &&
      agentStates.codex.source === "governess"
        ? "current"
        : "stale";
  }
  const provenance = [
    source(routeId, `${sourcePrefix}-manifest`, "manifest", manifest.updatedAt),
    source(
      routeId,
      `${sourcePrefix}-hooks`,
      "hook-journal",
      maxIso(hooks.claude.ts, hooks.codex.ts)
    ),
    source(
      routeId,
      `${sourcePrefix}-governess`,
      "governess-journal",
      governessLifecycleObservedAt,
      governessLifecycleState,
      "Persisted Governess lifecycle events only"
    ),
    source(
      routeId,
      `${sourcePrefix}-bridge`,
      "bridge-journal",
      bridge.lastAt ?? bridgeFile.modifiedAt
    ),
  ] as const;
  const reasons = buildRunReasons(lifecycle, manifest.state, runtime);

  const connection = {
    label: "Projection connected",
    lastEventAt,
    lastObservedAt: now,
    queuedUpdates: 0,
    state: "live" as const,
    streamEpoch: `loop-${opaque(routeId, governess.epoch)}`,
    streamSequence: saturatingCounterSum([
      hooks.claude.sequence,
      hooks.codex.sequence,
      bridge.count,
    ]),
  };
  const runtimeConflict =
    runtime.state === "ended" || runtime.state === "mismatch";
  const quality = {
    label: runtimeConflict ? "Conflict" : "Partial",
    severity: runtimeConflict ? ("conflict" as const) : ("partial" as const),
    sources: provenance,
    summary: qualitySummary(lifecycle, manifest.state, runtime),
  };
  const driver = governess.leaseHolder === "codex" ? "Codex" : "Claude";
  const reviewer = governess.leaseHolder === "codex" ? "Claude" : "Codex";
  const agents = [
    buildAgent({
      agent: "claude",
      bridge,
      governess,
      governessObservedAt: governessFile.modifiedAt,
      hook: hooks.claude,
      manifest,
      repository,
      runtime,
      scope: routeId,
    }),
    buildAgent({
      agent: "codex",
      bridge,
      governess,
      governessObservedAt: governessFile.modifiedAt,
      hook: hooks.codex,
      manifest,
      repository,
      runtime,
      scope: routeId,
    }),
  ];
  const summary: FleetRunDTO = {
    adapters: [
      {
        kind: "tmux",
        label: runtime.label,
        lastProbedAt: now,
        state: runtime.state,
      },
    ],
    agents: agents.map((agent) => ({
      displayName: agent.displayName,
      id: agent.id,
      lifecycle: agent.lifecycle,
      role: agent.role,
    })),
    connection,
    dataSource: projectionSource,
    driver,
    lastDurableEventAt: lastEventAt,
    lifecycle,
    quality,
    reasons,
    repoId,
    repository,
    reviewer,
    routeId,
    runId,
    startedAt: manifest.createdAt,
    title: `${repository} · run ${runId}`,
    version: WEBUI_DTO_VERSION,
    worktree: `Run ${runId} workspace`,
  };
  const leaseCurrent =
    governess.leaseExpiresAt !== undefined &&
    Date.parse(governess.leaseExpiresAt) >= Date.parse(now);
  const factProvenance = source(
    routeId,
    `${sourcePrefix}-governess-facts`,
    "governess-journal",
    governessFile.modifiedAt
  );
  const governessDto = buildGovernessDto({
    driver,
    factProvenance,
    governess,
    hasLifecycleConflict,
    leaseCurrent,
    lifecycle,
    manifestProvenance: provenance[0],
    manifestState: manifest.state,
    now,
    runId,
    runtime,
    runtimeConflict,
    scope: routeId,
  });
  const evidence = buildEvidence(routeId, [
    {
      id: "manifest",
      kind: "artifact",
      sourceKind: "manifest",
      snapshot: manifestFile,
      title: "Run manifest metadata",
    },
    {
      id: "governess",
      kind: "control",
      sourceKind: "governess-journal",
      snapshot: governessFile,
      title: "Governess state metadata",
    },
    {
      id: "claude-hooks",
      kind: "log",
      sourceKind: "hook-journal",
      snapshot: claudeHooksFile,
      title: "Claude normalized hook metadata",
    },
    {
      id: "codex-hooks",
      kind: "log",
      sourceKind: "hook-journal",
      snapshot: codexHooksFile,
      title: "Codex normalized hook metadata",
    },
    {
      id: "bridge",
      kind: "log",
      sourceKind: "bridge-journal",
      snapshot: bridgeFile,
      title: "Bridge journal metadata",
    },
    {
      id: "utility",
      kind: "log",
      sourceKind: "worker-journal",
      snapshot: utilityFile,
      title: "Utility worker metadata",
    },
  ]);
  const detail: RunDetailDTO = {
    agents,
    authority: {
      currentDriver: driver,
      epoch: governess.epoch,
      leaseState: leaseCurrent ? "current" : "stale",
      repoId,
      runId,
    },
    connection,
    dataSource: projectionSource,
    evidence,
    governess: governessDto,
    quality,
    summary,
    timeline: buildTimeline({
      agentStates,
      bridge,
      derivedLifecycle: lifecycle,
      hooks,
      jobs,
      manifest,
      now,
      repository,
      runtime,
      scope: routeId,
    }),
    version: WEBUI_DTO_VERSION,
    workers: buildWorkers(routeId, jobs),
  };
  assertCandidateDirectoryIdentity(candidate, registryFs);
  return { detail, summary };
};

const projectDegradedRun = (
  candidate: RunCandidate,
  options: LoopRegistryLiveDataOptions,
  now: IsoTimestamp
): ProjectedRun => {
  const { manifest, manifestFile, repoId, repository, routeId, runId } =
    candidate;
  const registryFs = options.registryFs ?? DEFAULT_REGISTRY_FS;
  assertCandidateDirectoryIdentity(candidate, registryFs);
  let runtime: RuntimeProbeResult;
  try {
    runtime = (options.runtimeProbe ?? probeLoopRuntime)(manifest.runtime);
  } catch {
    runtime = {
      label: "Terminal session status unverified",
      state: "unknown",
    };
  }
  const projectionSource = dataSource(now);
  const manifestProvenance = source(
    routeId,
    `run-${opaque(routeId, "source")}-manifest`,
    "manifest",
    manifest.updatedAt
  );
  const connection = {
    label: "Projection partial",
    lastEventAt: manifest.updatedAt,
    lastObservedAt: now,
    queuedUpdates: 0,
    state: "behind" as const,
    streamEpoch: `loop-${opaque(routeId, "degraded")}`,
    streamSequence: 0,
  };
  const reasons: readonly RunReasonDTO[] = [
    {
      code: "corrupt-evidence",
      detail:
        "The manifest is valid, but one or more bounded durable evidence sources could not be projected.",
      label: "Detailed evidence unavailable",
      severity: "high",
    },
    ...buildRunReasons(manifest.state, manifest.state, runtime),
  ];
  const quality = {
    label: "Degraded",
    severity: "corrupt" as const,
    sources: [manifestProvenance],
    summary:
      "Manifest identity is valid; detailed durable evidence is unavailable. No fixture data was substituted.",
  };
  const fallbackGoverness: GovernessView = {
    epoch: "unavailable",
    leaseHolder: manifest.primaryAgent,
    lifecycle: {},
    pressure: {},
    recoveries: 0,
    waitingConfirmed: false,
  };
  const fallbackBridge: JournalView = { count: 0, records: [] };
  const fallbackHooks = {
    claude: {
      agent: "claude",
      event: "Activity",
      lifecycleAt: manifest.updatedAt,
      sequence: 0,
      state: manifest.state,
      ts: manifest.updatedAt,
    },
    codex: {
      agent: "codex",
      event: "Activity",
      lifecycleAt: manifest.updatedAt,
      sequence: 0,
      state: manifest.state,
      ts: manifest.updatedAt,
    },
  } satisfies Readonly<Record<"claude" | "codex", HookView>>;
  const agents = (["claude", "codex"] as const).map((agent) => ({
    ...buildAgent({
      agent,
      bridge: fallbackBridge,
      governess: fallbackGoverness,
      governessObservedAt: manifestFile.modifiedAt,
      hook: fallbackHooks[agent],
      manifest,
      repository,
      runtime,
      scope: routeId,
    }),
    currentTask: "Detailed lifecycle evidence unavailable",
    lifecycle: "limited" as const,
    provenance: [manifestProvenance],
    toolsInFlight: 0,
  }));
  const driver = manifest.primaryAgent === "codex" ? "Codex" : "Claude";
  const reviewer = manifest.primaryAgent === "codex" ? "Claude" : "Codex";
  const summary: FleetRunDTO = {
    adapters: [
      {
        kind: "tmux",
        label: runtime.label,
        lastProbedAt: now,
        state: runtime.state,
      },
    ],
    agents: agents.map((agent) => ({
      displayName: agent.displayName,
      id: agent.id,
      lifecycle: agent.lifecycle,
      role: agent.role,
    })),
    connection,
    dataSource: projectionSource,
    driver,
    lastDurableEventAt: manifest.updatedAt,
    lifecycle: manifest.state,
    quality,
    reasons,
    repoId,
    repository,
    reviewer,
    routeId,
    runId,
    startedAt: manifest.createdAt,
    title: `${repository} · run ${runId}`,
    version: WEBUI_DTO_VERSION,
    worktree: `Run ${runId} workspace`,
  };
  const evidence = buildEvidence(routeId, [
    {
      id: "manifest",
      kind: "artifact",
      sourceKind: "manifest",
      snapshot: manifestFile,
      title: "Run manifest metadata",
    },
  ]);
  const detail: RunDetailDTO = {
    agents,
    authority: {
      currentDriver: driver,
      epoch: "unavailable",
      leaseState: "stale",
      repoId,
      runId,
    },
    connection,
    dataSource: projectionSource,
    evidence,
    governess: buildGovernessDto({
      driver,
      factProvenance: manifestProvenance,
      governess: fallbackGoverness,
      hasLifecycleConflict: false,
      leaseCurrent: false,
      lifecycle: manifest.state,
      manifestProvenance,
      manifestState: manifest.state,
      now,
      runId,
      runtime,
      runtimeConflict:
        runtime.state === "ended" || runtime.state === "mismatch",
      scope: routeId,
    }),
    quality,
    summary,
    timeline: [
      {
        actor: "Web UI",
        at: manifest.updatedAt,
        category: "evidence",
        detail:
          "The valid manifest is shown while unavailable detailed evidence remains excluded.",
        evidenceIds: [evidenceId(routeId, "manifest")],
        id: `timeline_${opaque(routeId, "degraded")}`,
        provenance: manifestProvenance,
        sequence: 1,
        title: "Detailed projection unavailable",
        tone: "warning",
      },
    ],
    version: WEBUI_DTO_VERSION,
    workers: buildWorkers(routeId, []),
  };
  assertCandidateDirectoryIdentity(candidate, registryFs);
  return { detail, summary };
};

const compareProjectedRuns = (
  left: ProjectedRun,
  right: ProjectedRun
): number => {
  const eventOrder = right.summary.lastDurableEventAt.localeCompare(
    left.summary.lastDurableEventAt
  );
  if (eventOrder !== 0) {
    return eventOrder;
  }
  const repositoryOrder = left.summary.repoId.localeCompare(
    right.summary.repoId
  );
  if (repositoryOrder !== 0) {
    return repositoryOrder;
  }
  const runOrder = Number(left.summary.runId) - Number(right.summary.runId);
  return runOrder === 0
    ? left.summary.routeId.localeCompare(right.summary.routeId)
    : runOrder;
};

const aggregateQualitySeverity = (
  projected: readonly ProjectedRun[],
  rejectedEntries: number
): FleetRunDTO["quality"]["severity"] => {
  const severities = new Set(
    projected.map((run) => run.summary.quality.severity)
  );
  if (severities.has("corrupt")) {
    return "corrupt";
  }
  if (severities.has("conflict")) {
    return "conflict";
  }
  if (severities.has("stale")) {
    return "stale";
  }
  if (rejectedEntries > 0 || severities.has("partial")) {
    return "partial";
  }
  return "healthy";
};

const aggregateQualityLabel = (
  severity: FleetRunDTO["quality"]["severity"],
  rejectedEntries: number
): string => {
  if (rejectedEntries > 0) {
    return "Partial coverage";
  }
  if (severity === "corrupt") {
    return "Corrupt evidence";
  }
  if (severity === "conflict") {
    return "Identity conflict";
  }
  if (severity === "stale") {
    return "Stale evidence";
  }
  return severity === "partial" ? "Partial" : "Healthy";
};

const aggregateQualitySummary = (
  runCount: number,
  severity: FleetRunDTO["quality"]["severity"],
  rejectedEntries: number
): string => {
  if (rejectedEntries > 0) {
    return `Projected ${runCount} active loops; some registry evidence could not be validated.`;
  }
  if (severity === "corrupt") {
    return `Projected all ${runCount} validated active loops; detailed evidence is unavailable for at least one loop.`;
  }
  if (severity === "conflict") {
    return `Projected all ${runCount} validated active loops; at least one loop has a runtime identity conflict.`;
  }
  if (severity === "stale") {
    return `Projected all ${runCount} validated active loops; at least one loop has stale evidence.`;
  }
  if (runCount > 0) {
    return `Projected all ${runCount} validated active loops.`;
  }
  return "A clean bounded registry scan found no active loops.";
};

const projectCandidate = (
  candidate: RunCandidate,
  options: LoopRegistryLiveDataOptions,
  now: IsoTimestamp
): ProjectedRun | "rejected" => {
  try {
    return projectActiveRun(candidate, options, now);
  } catch (error) {
    if (error instanceof RegistryDirectoryIdentityError) {
      return "rejected";
    }
    const registryFs = options.registryFs ?? DEFAULT_REGISTRY_FS;
    try {
      assertCandidateDirectoryIdentity(candidate, registryFs);
      return projectDegradedRun(candidate, options, now);
    } catch (degradedError) {
      if (degradedError instanceof RegistryDirectoryIdentityError) {
        return "rejected";
      }
      throw degradedError;
    }
  }
};

const projectDiscoveredRuns = (
  discovery: RegistryDiscovery,
  options: LoopRegistryLiveDataOptions,
  now: IsoTimestamp
): { readonly projected: ProjectedRun[]; readonly rejectedEntries: number } => {
  const projected: ProjectedRun[] = [];
  let rejectedEntries = discovery.rejectedEntries;
  for (const candidate of discovery.candidates) {
    const result = projectCandidate(candidate, options, now);
    if (result === "rejected") {
      rejectedEntries += 1;
    } else {
      projected.push(result);
    }
  }
  projected.sort(compareProjectedRuns);
  return { projected, rejectedEntries };
};

export const readLoopRegistryLiveSnapshot = (
  options: LoopRegistryLiveDataOptions = {}
): WebUiSnapshotDTO => {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const storageRoot =
    options.storageRoot ??
    join(process.env.HOME ?? process.cwd(), ".loop", "runs");
  const discovery = discoverActiveRuns(
    storageRoot,
    options.registryFs ?? DEFAULT_REGISTRY_FS
  );
  if (discovery.candidates.length === 0 && discovery.rejectedEntries > 0) {
    throw new LiveDataUnavailableError(
      "active loop coverage could not be proven"
    );
  }
  const { projected, rejectedEntries } = projectDiscoveredRuns(
    discovery,
    options,
    now
  );
  if (projected.length === 0 && rejectedEntries > 0) {
    throw new LiveDataUnavailableError(
      "active loop coverage could not be proven"
    );
  }
  const hasDegradedRun = projected.some(
    (run) => run.summary.quality.severity === "corrupt"
  );
  const partialCoverage = rejectedEntries > 0 || hasDegradedRun;
  const qualitySeverity = aggregateQualitySeverity(projected, rejectedEntries);
  const projectionSource = dataSource(now);
  const runs = projected.map((run) => run.summary);
  const details: Record<string, RunDetailDTO> = {};
  for (const run of projected) {
    details[run.summary.routeId] = run.detail;
  }
  const lastEventAt =
    runs.length > 0
      ? maxIso(...runs.map((run) => run.lastDurableEventAt))
      : now;
  const connection = {
    label: partialCoverage ? "Projection partial" : "Projection connected",
    lastEventAt,
    lastObservedAt: now,
    queuedUpdates: 0,
    state: partialCoverage ? ("behind" as const) : ("live" as const),
    streamEpoch: `registry-${opaque(
      "registry",
      runs.map((run) => run.routeId).join("|")
    )}`,
    streamSequence: saturatingCounterSum(
      projected.map((run) => run.detail.connection.streamSequence)
    ),
  };
  const quality = {
    label: aggregateQualityLabel(qualitySeverity, rejectedEntries),
    severity: qualitySeverity,
    sources: projected.flatMap((run) => run.summary.quality.sources),
    summary: aggregateQualitySummary(
      runs.length,
      qualitySeverity,
      rejectedEntries
    ),
  };
  return {
    details,
    fleet: {
      connection,
      dataSource: projectionSource,
      observedAt: now,
      quality,
      runs,
      version: WEBUI_DTO_VERSION,
    },
    source: "loop-registry-live",
    version: WEBUI_DTO_VERSION,
  };
};

export const readHarvtoLiveSnapshot = readLoopRegistryLiveSnapshot;

export interface LiveDataRequest {
  readonly host?: string;
  readonly method?: string;
  readonly origin?: string;
  readonly url?: string;
}

export interface LiveDataResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

interface LiveDataHostOptions {
  readonly expectedHost?: string;
  readonly expectedHosts?: readonly string[];
}

export const handleLiveDataRequest = (
  request: LiveDataRequest,
  options: LoopRegistryLiveDataOptions & LiveDataHostOptions = {}
): LiveDataResponse | undefined => {
  const path = request.url?.split("?", 1)[0];
  if (path !== LIVE_SNAPSHOT_PATH) {
    return undefined;
  }
  const expectedHosts = options.expectedHosts ?? [
    options.expectedHost ?? "127.0.0.1:46327",
  ];
  const headers = {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  } as const;
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return {
      body: JSON.stringify({
        code: "METHOD_NOT_ALLOWED",
        error: "Read-only endpoint",
      }),
      headers: { ...headers, Allow: "GET, HEAD" },
      status: 405,
    };
  }
  if (!(request.host && expectedHosts.includes(request.host))) {
    return {
      body: JSON.stringify({ code: "HOST_REJECTED", error: "Host rejected" }),
      headers,
      status: 403,
    };
  }
  if (request.origin && request.origin !== `http://${request.host}`) {
    return {
      body: JSON.stringify({
        code: "ORIGIN_REJECTED",
        error: "Origin rejected",
      }),
      headers,
      status: 403,
    };
  }
  try {
    const body = JSON.stringify(readLoopRegistryLiveSnapshot(options));
    return { body: method === "HEAD" ? "" : body, headers, status: 200 };
  } catch (error) {
    const reason =
      error instanceof LiveDataUnavailableError
        ? error.reason
        : "unexpected projection failure";
    return {
      body: JSON.stringify({
        code: "LIVE_DATA_UNAVAILABLE",
        error: "Live loop data is unavailable",
        reason,
      }),
      headers,
      status: 503,
    };
  }
};

const installMiddleware = (
  middlewares: {
    use(
      handler: (
        request: {
          headers: Readonly<Record<string, string | string[] | undefined>>;
          method?: string;
          url?: string;
        },
        response: {
          end(body?: string): void;
          setHeader(name: string, value: string): void;
          statusCode: number;
        },
        next: () => void
      ) => void
    ): void;
  },
  options: LoopRegistryLiveDataOptions & LiveDataHostOptions
) => {
  middlewares.use((request, response, next) => {
    const result = handleLiveDataRequest(
      {
        host:
          typeof request.headers.host === "string"
            ? request.headers.host
            : undefined,
        method: request.method,
        origin:
          typeof request.headers.origin === "string"
            ? request.headers.origin
            : undefined,
        url: request.url,
      },
      options
    );
    if (!result) {
      next();
      return;
    }
    response.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }
    response.end(result.body);
  });
};

export const loopRegistryLiveDataPlugin = (
  options: LoopRegistryLiveDataOptions & LiveDataHostOptions = {}
): Plugin => ({
  configurePreviewServer(server) {
    installMiddleware(server.middlewares, options);
  },
  configureServer(server) {
    installMiddleware(server.middlewares, options);
  },
  name: "loop-registry-live-data",
});

export const harvtoLiveDataPlugin = loopRegistryLiveDataPlugin;
