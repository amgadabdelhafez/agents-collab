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
]);
const LIFECYCLES = new Set<RunLifecycle>([
  ...ACTIVE_LIFECYCLES,
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
const LINE_SPLIT_PATTERN = /\r?\n/u;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_JSONL_BYTES = 4 * 1024 * 1024;
const MAX_JSONL_LINES = 10_000;
const MAX_RUN_DIRECTORIES = 1024;
const MAX_WORKER_ACTIVITY = 8;

type JsonRecord = Record<string, unknown>;

interface FileSnapshot {
  readonly bytes: number;
  readonly modifiedAt: IsoTimestamp;
  readonly revision: string;
  readonly text: string;
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
  readonly updatedAt: IsoTimestamp;
}

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
  readonly sequence: number;
  readonly state: RunLifecycle;
  readonly ts: IsoTimestamp;
}

interface AgentStateView {
  readonly at: IsoTimestamp;
  readonly state: RunLifecycle;
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

export interface HarvtoLiveDataOptions {
  readonly now?: () => Date;
  readonly repoId?: string;
  readonly runtimeProbe?: (identity: RuntimeIdentity) => RuntimeProbeResult;
  readonly storageRoot?: string;
}

export class LiveDataUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "LiveDataUnavailableError";
    this.reason = reason;
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

const evidenceId = (runId: string, kind: string): OpaqueEvidenceId =>
  `ev_${opaque(`harvto-${runId}`, kind)}`;

const safeStat = (path: string): Stats => {
  try {
    return lstatSync(path);
  } catch {
    throw new LiveDataUnavailableError("required live evidence is missing");
  }
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

const selectLatestRun = (storageRoot: string, repoId: string): string => {
  const repoDir = join(storageRoot, repoId);
  if (!within(storageRoot, repoDir)) {
    throw new LiveDataUnavailableError(
      "lane identity is outside the storage root"
    );
  }
  const rootStat = safeStat(repoDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new LiveDataUnavailableError("lane storage has an invalid file type");
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(repoDir, { withFileTypes: true });
  } catch {
    throw new LiveDataUnavailableError("lane storage could not be listed");
  }
  if (entries.length > MAX_RUN_DIRECTORIES) {
    throw new LiveDataUnavailableError("lane exceeds its run-directory bound");
  }

  const runIds = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        RUN_ID_PATTERN.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((left, right) => Number(right) - Number(left));
  const latest = runIds[0];
  if (!latest) {
    throw new LiveDataUnavailableError("the Harvto lane has no canonical runs");
  }
  return latest;
};

const parseManifest = (
  record: JsonRecord,
  expectedRepoId: string,
  expectedRunId: string
): ManifestView => {
  const repoId = stringAt(record, "repoId");
  const runId = stringAt(record, "runId");
  const state = asLifecycle(record.state);
  const primaryAgent = stringAt(record, "primaryAgent");
  const socketPath = stringAt(record, "tmuxSocket");
  const session = stringAt(record, "tmuxSession");
  if (
    repoId !== expectedRepoId ||
    runId !== expectedRunId ||
    !state ||
    (primaryAgent !== "claude" && primaryAgent !== "codex") ||
    !socketPath ||
    !isAbsolute(socketPath) ||
    socketPath.length > 4096 ||
    session !== `harvto-loop-${expectedRunId}`
  ) {
    throw new LiveDataUnavailableError(
      "run manifest identity or lifecycle conflicts"
    );
  }
  return {
    createdAt: requireIso(record.createdAt, "manifest created time"),
    driverEffort: allowlistedLabel(
      record.driverEffort,
      EFFORT_LEVELS,
      "unspecified"
    ),
    primaryAgent,
    repoId,
    reviewerEffort: allowlistedLabel(
      record.reviewerEffort,
      EFFORT_LEVELS,
      "unspecified"
    ),
    runtime: { session, socketPath },
    runId,
    state,
    updatedAt: requireIso(record.updatedAt, "manifest update time"),
  };
};

const parseHook = (
  records: readonly JsonRecord[],
  expectedAgent: "claude" | "codex"
): HookView => {
  const record = records.at(-1);
  if (!record) {
    throw new LiveDataUnavailableError("normalized hook evidence is empty");
  }
  const agent = stringAt(record, "agent");
  const state = asLifecycle(record.state);
  const sequence = numberAt(record, "sequence");
  if (agent !== expectedAgent || !state || sequence === undefined) {
    throw new LiveDataUnavailableError("normalized hook identity is invalid");
  }
  const rawEvent = stringAt(record, "event");
  return {
    agent: expectedAgent,
    event: rawEvent && AGENT_EVENTS.has(rawEvent) ? rawEvent : "Activity",
    sequence: Math.max(0, Math.floor(sequence)),
    state,
    ts: requireIso(record.ts, "normalized hook time"),
  };
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
    compactions: Math.max(0, Math.floor(numberAt(value, "compactions") ?? 0)),
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

export const probeHarvtoRuntime = (
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

const deriveLifecycle = (
  manifest: ManifestView,
  governess: GovernessView,
  hooks: Readonly<Record<"claude" | "codex", HookView>>
): RunLifecycle => {
  if (!ACTIVE_LIFECYCLES.has(manifest.state)) {
    return manifest.state;
  }
  const durableStates = [
    governess.lifecycle.claude?.state,
    governess.lifecycle.codex?.state,
    hooks.claude.state,
    hooks.codex.state,
  ];
  if (
    governess.waitingConfirmed &&
    durableStates.filter((state) => state === "input-required").length >= 2
  ) {
    return "input-required";
  }
  return manifest.state;
};

const agentLifecycle = (
  hook: HookView,
  derivedLifecycle: RunLifecycle,
  runtimeState: RuntimeProbeResult["state"]
): AgentLifecycle => {
  if (runtimeState === "ended" || runtimeState === "mismatch") {
    return "stuck";
  }
  if (
    derivedLifecycle === "input-required" ||
    hook.state === "input-required"
  ) {
    return "waiting-human";
  }
  if (derivedLifecycle === "reviewing" || hook.state === "reviewing") {
    return "reviewing";
  }
  if (derivedLifecycle === "failed") {
    return "crashed";
  }
  if (derivedLifecycle === "completed" || derivedLifecycle === "stopped") {
    return "finished";
  }
  return hook.event === "Stop" ? "waiting-peer" : "working";
};

const dataSource = (now: IsoTimestamp): DataSourceDTO => ({
  generatedAt: now,
  kind: "live-redacted",
  notice:
    "Prompts, transcripts, paths, credentials, raw identifiers, and terminal content are excluded.",
  scenario: "Harvto lane",
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
  runtimeState: RuntimeProbeResult["state"]
): string => {
  if (runtimeState === "ended" || runtimeState === "mismatch") {
    return "Last durable state required operator input; runtime unavailable";
  }
  if (lifecycle === "waiting-human") {
    return "Waiting for operator input in the Harvto lane";
  }
  if (lifecycle === "reviewing") {
    return "Reviewing durable Harvto lane work";
  }
  return "Working in the Harvto lane";
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
  readonly derivedLifecycle: RunLifecycle;
  readonly governess: GovernessView;
  readonly hook: HookView;
  readonly manifest: ManifestView;
  readonly runtime: RuntimeProbeResult;
}): AgentSeatDTO => {
  const {
    agent,
    bridge,
    derivedLifecycle,
    governess,
    hook,
    manifest,
    runtime,
  } = input;
  const isDriver = governess.leaseHolder === agent;
  const pressure = governess.pressure[agent];
  const displayName = agent === "codex" ? "Codex" : "Claude";
  const effort =
    manifest.primaryAgent === agent
      ? manifest.driverEffort
      : manifest.reviewerEffort;
  const lifecycle = agentLifecycle(hook, derivedLifecycle, runtime.state);
  return {
    currentTask: derivedTaskLabel(lifecycle, runtime.state),
    displayName,
    id: `harvto-${agent}`,
    lastHookAt: hook.ts,
    lastHookEvent: hook.event,
    ...(latestBridgeStatus(bridge, agent)
      ? { latestBridgeMessage: latestBridgeStatus(bridge, agent) }
      : {}),
    lifecycle,
    model: pressure?.model ?? "Unavailable",
    provenance: [
      source(
        manifest.runId,
        `${agent}-hooks`,
        "hook-journal",
        hook.ts,
        "current",
        "Normalized lifecycle metadata only"
      ),
      source(
        manifest.runId,
        `${agent}-governess`,
        "governess-journal",
        governess.lifecycle[agent]?.at ?? hook.ts,
        "current",
        "Persisted lifecycle and pressure metadata"
      ),
    ],
    provider: "Frontier runtime",
    reasoningEffort: effort,
    role: isDriver ? "driver" : "reviewer",
    taskObservedAt: hook.ts,
    taskSource: "derived lifecycle summary",
    toolsInFlight: hook.event === "PreToolUse" ? 1 : 0,
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
  runId: string,
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
          id: `worker_${opaque(runId, job.id)}`,
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
  runId: string,
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
    id: evidenceId(runId, file.id),
    kind: file.kind,
    mimeType:
      file.id === "manifest" || file.id === "governess"
        ? "application/json"
        : "text/plain",
    provenance: source(
      runId,
      `run-${runId}-${file.id}`,
      file.sourceKind,
      file.snapshot.modifiedAt
    ),
    redactionsApplied: 1,
    summary: "Metadata is available; raw content is intentionally withheld.",
    title: file.title,
  }));

const buildTimeline = (input: {
  readonly bridge: JournalView;
  readonly derivedLifecycle: RunLifecycle;
  readonly hooks: Readonly<Record<"claude" | "codex", HookView>>;
  readonly jobs: readonly UtilityJobView[];
  readonly manifest: ManifestView;
  readonly now: IsoTimestamp;
  readonly runtime: RuntimeProbeResult;
}): readonly TimelineEventDTO[] => {
  const { bridge, derivedLifecycle, hooks, jobs, manifest, now, runtime } =
    input;
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
      id: `timeline_${opaque(manifest.runId, key)}`,
      provenance: source(manifest.runId, `timeline-${key}`, sourceKind, at),
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
    "Harvto run created",
    `Run ${manifest.runId} entered the durable lane.`,
    "info",
    "manifest",
    1,
    [evidenceId(manifest.runId, "manifest")]
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
      [evidenceId(manifest.runId, `${agent}-hooks`)]
    );
  }
  if (derivedLifecycle !== manifest.state) {
    add(
      "lifecycle-conflict",
      maxIso(hooks.claude.ts, hooks.codex.ts),
      "governess",
      "Governess",
      "Newer lifecycle evidence disagrees with manifest",
      `The live projection shows ${derivedLifecycle}; the manifest still records ${manifest.state}.`,
      "warning",
      "governess-journal",
      20,
      [evidenceId(manifest.runId, "governess")]
    );
  }
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
      [evidenceId(manifest.runId, "bridge")]
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
      [evidenceId(manifest.runId, "utility")]
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
  return `The Harvto lane currently reports ${lifecycle}.`;
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
      status: input.lifecycle === "input-required" ? "warning" : "ok",
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
        input.runId,
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

export const readHarvtoLiveSnapshot = (
  options: HarvtoLiveDataOptions = {}
): WebUiSnapshotDTO => {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const repoId = options.repoId ?? HARVTO_REPO_ID;
  if (repoId !== HARVTO_REPO_ID) {
    throw new LiveDataUnavailableError("the requested lane is not allowed");
  }
  const storageRoot =
    options.storageRoot ??
    join(process.env.HOME ?? process.cwd(), ".loop", "runs");
  const runId = selectLatestRun(storageRoot, repoId);
  const runDir = join(storageRoot, repoId, runId);
  if (!within(join(storageRoot, repoId), runDir)) {
    throw new LiveDataUnavailableError(
      "run identity is outside the Harvto lane"
    );
  }

  const manifestFile = readStableUtf8(
    join(runDir, "manifest.json"),
    MAX_JSON_BYTES
  );
  const manifest = parseManifest(parseJson(manifestFile), repoId, runId);
  const runtime = (options.runtimeProbe ?? probeHarvtoRuntime)(
    manifest.runtime
  );
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
  const reconciliationFile = readStableUtf8(
    join(runDir, "bridge-reconciliation.json"),
    MAX_JSON_BYTES
  );
  parseJson(reconciliationFile);
  const utilityFile = readStableUtf8(
    join(runDir, "utility", "jobs.jsonl"),
    MAX_JSONL_BYTES
  );
  const jobs = utilityJobs(parseJsonl(utilityFile));

  const lifecycle = deriveLifecycle(manifest, governess, hooks);
  const hasLifecycleConflict = lifecycle !== manifest.state;
  const lastEventAt = maxIso(
    manifest.updatedAt,
    hooks.claude.ts,
    hooks.codex.ts,
    bridge.lastAt,
    jobs[0]?.at
  );
  const projectionSource = dataSource(now);
  const provenance = [
    source(runId, `run-${runId}-manifest`, "manifest", manifest.updatedAt),
    source(
      runId,
      `run-${runId}-hooks`,
      "hook-journal",
      maxIso(hooks.claude.ts, hooks.codex.ts)
    ),
    source(
      runId,
      `run-${runId}-governess`,
      "governess-journal",
      maxIso(
        governess.lifecycle.claude?.at,
        governess.lifecycle.codex?.at,
        hooks.claude.ts,
        hooks.codex.ts
      )
    ),
    source(
      runId,
      `run-${runId}-bridge`,
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
    streamEpoch: `harvto-${governess.epoch}`,
    streamSequence: hooks.claude.sequence + hooks.codex.sequence + bridge.count,
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
      derivedLifecycle: lifecycle,
      governess,
      hook: hooks.claude,
      manifest,
      runtime,
    }),
    buildAgent({
      agent: "codex",
      bridge,
      derivedLifecycle: lifecycle,
      governess,
      hook: hooks.codex,
      manifest,
      runtime,
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
    repository: "Harvto",
    reviewer,
    runId,
    startedAt: manifest.createdAt,
    title: `Harvto lane · run ${runId}`,
    version: WEBUI_DTO_VERSION,
    worktree: `Run ${runId} workspace`,
  };
  const leaseCurrent =
    governess.leaseExpiresAt !== undefined &&
    Date.parse(governess.leaseExpiresAt) >= Date.parse(now);
  const factProvenance = source(
    runId,
    `run-${runId}-governess-facts`,
    "governess-journal",
    maxIso(
      governess.lifecycle.claude?.at,
      governess.lifecycle.codex?.at,
      hooks.claude.ts,
      hooks.codex.ts
    )
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
  });
  const evidence = buildEvidence(runId, [
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
      bridge,
      derivedLifecycle: lifecycle,
      hooks,
      jobs,
      manifest,
      now,
      runtime,
    }),
    version: WEBUI_DTO_VERSION,
    workers: buildWorkers(runId, jobs),
  };
  return {
    details: { [runId]: detail },
    fleet: {
      connection,
      dataSource: projectionSource,
      observedAt: now,
      quality,
      runs: [summary],
      version: WEBUI_DTO_VERSION,
    },
    source: "harvto-live",
    version: WEBUI_DTO_VERSION,
  };
};

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

export const handleLiveDataRequest = (
  request: LiveDataRequest,
  options: HarvtoLiveDataOptions & { readonly expectedHost?: string } = {}
): LiveDataResponse | undefined => {
  const path = request.url?.split("?", 1)[0];
  if (path !== LIVE_SNAPSHOT_PATH) {
    return undefined;
  }
  const expectedHost = options.expectedHost ?? "127.0.0.1:46327";
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
  if (request.host !== expectedHost) {
    return {
      body: JSON.stringify({ code: "HOST_REJECTED", error: "Host rejected" }),
      headers,
      status: 403,
    };
  }
  if (request.origin && request.origin !== `http://${expectedHost}`) {
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
    const body = JSON.stringify(readHarvtoLiveSnapshot(options));
    return { body: method === "HEAD" ? "" : body, headers, status: 200 };
  } catch (error) {
    const reason =
      error instanceof LiveDataUnavailableError
        ? error.reason
        : "unexpected projection failure";
    return {
      body: JSON.stringify({
        code: "LIVE_DATA_UNAVAILABLE",
        error: "Harvto live data is unavailable",
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
  options: HarvtoLiveDataOptions & { readonly expectedHost?: string }
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

export const harvtoLiveDataPlugin = (
  options: HarvtoLiveDataOptions & { readonly expectedHost?: string } = {}
): Plugin => ({
  configurePreviewServer(server) {
    installMiddleware(server.middlewares, options);
  },
  configureServer(server) {
    installMiddleware(server.middlewares, options);
  },
  name: "harvto-live-data",
});
